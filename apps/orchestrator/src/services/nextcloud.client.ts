import pino from "pino";
import { config } from "../config.js";
import type {
  FileEntryInfo,
  FileVersionInfo,
  TrashItemInfo,
} from "../types/index.js";

const logger = pino({ name: "nextcloud-client" });

/**
 * Nextcloud WebDAV + OCS API client.
 * All file operations in the orchestrator flow through this module.
 */

const WEBDAV_BASE = "/remote.php/dav/files";

/**
 * Percent-encode each path segment, leaving the `/` separators intact.
 * `encodeURIComponent` on the whole string would escape the separators too.
 * Empty segments (leading/trailing/doubled slashes) are preserved verbatim so
 * callers that pass "/" keep addressing the WebDAV root.
 */
function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === "" ? "" : encodeURIComponent(segment)))
    .join("/");
}

/**
 * Build a WebDAV URL for `path` in `user`'s namespace.
 *
 * `user` and `path` are raw (already-decoded) values coming from route params,
 * query strings, and DB records — they MUST be percent-encoded here. Without
 * it a filename containing `#` truncates the URL at the fragment, `?` starts a
 * query string, a bare `%` is an invalid escape, and `+`/space are not
 * path-legal — so the request lands on a DIFFERENT resource than intended. For
 * DELETE and overwriting PUT/MOVE that means destroying the wrong file.
 */
function webdavUrl(user: string, path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `${config.NEXTCLOUD_URL}${WEBDAV_BASE}/${encodeURIComponent(user)}/${encodePathSegments(cleanPath)}`;
}

function ocsUrl(endpoint: string): string {
  return `${config.NEXTCLOUD_URL}${endpoint}`;
}

function ocsHeaders(token: string): Record<string, string> {
  return {
    Authorization: resolveAuthHeader(token),
    "OCS-APIRequest": "true",
    Accept: "application/json",
  };
}

function resolveAuthHeader(token: string): string {
  if (token.startsWith("basic:")) return `Basic ${token.slice(6)}`;
  return `Bearer ${token}`;
}

function davHeaders(token: string): Record<string, string> {
  return {
    Authorization: resolveAuthHeader(token),
  };
}

// ── Health ──

/**
 * WARP-43: lightweight health probe. Hits `/status.php` which is
 * unauthenticated and returns JSON with server metadata. 3s cap so the
 * health monitor's 5s ceiling has headroom.
 */
export async function ncPing(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${config.NEXTCLOUD_URL}/status.php`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const body = (await res.json()) as { installed?: boolean };
    return body.installed === true;
  } catch {
    return false;
  }
}

// ── WebDAV File Operations ──

export async function ncListFiles(
  token: string,
  user: string,
  path: string
): Promise<FileEntryInfo[]> {
  const url = webdavUrl(user, path);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:resourcetype/>
    <oc:fileid/>
  </d:prop>
</d:propfind>`;

  const resp = await fetch(url, {
    method: "PROPFIND",
    headers: { ...davHeaders(token), "Content-Type": "application/xml", Depth: "1" },
    body,
  });

  if (!resp.ok) {
    logger.error({ status: resp.status, url }, "WebDAV PROPFIND failed");
    throw new Error(`WebDAV PROPFIND failed: ${resp.status}`);
  }

  const xml = await resp.text();
  return parseMultiStatus(xml, path);
}

export async function ncUploadFile(
  token: string,
  user: string,
  path: string,
  filename: string,
  buffer: Buffer
): Promise<void> {
  const url = webdavUrl(user, `${path}/${filename}`);
  const resp = await fetch(url, {
    method: "PUT",
    headers: { ...davHeaders(token), "Content-Type": "application/octet-stream" },
    body: new Uint8Array(buffer),
  });

  if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
    throw new Error(`WebDAV PUT failed: ${resp.status}`);
  }
}

export async function ncDownloadFile(
  token: string,
  user: string,
  path: string
): Promise<ReadableStream<Uint8Array> | null> {
  const url = webdavUrl(user, path);
  const resp = await fetch(url, {
    headers: davHeaders(token),
  });

  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(`WebDAV GET failed: ${resp.status}`);
  }

  return resp.body;
}

/**
 * Fetch a file from WebDAV and return the raw upstream Response, so callers can
 * relay status + headers — needed for inline content serving with Range/206
 * support (the dashboard citation viewers). Forwards an optional `Range`
 * header. Returns null on 404.
 */
export async function ncFetchFileResponse(
  token: string,
  user: string,
  path: string,
  rangeHeader?: string | null
): Promise<Response | null> {
  const url = webdavUrl(user, path);
  const headers: Record<string, string> = { ...davHeaders(token) };
  if (rangeHeader) headers["Range"] = rangeHeader;

  const resp = await fetch(url, { headers });

  if (resp.status === 404) return null;
  // 416 is the upstream's verdict on the caller's Range header, not a fault —
  // relay it rather than turning a bad client request into a 5xx.
  if (!resp.ok && resp.status !== 416) {
    throw new Error(`WebDAV GET failed: ${resp.status}`);
  }
  return resp;
}

/**
 * WARP-1682 — what a DELETE actually accomplished. Both values are SUCCESS;
 * they differ only in whether this call is the one that removed the resource,
 * which callers may want for logging but never for error handling.
 */
export type NcDeleteOutcome = "deleted" | "already-absent";

/**
 * Delete a file or directory. Idempotent: the caller is asking for an END
 * STATE ("this path must not exist"), not for a state transition, so a 404 —
 * the state already holds — is a success (RFC 9110 §9.2.2).
 *
 * WARP-1682: this used to throw on 404, and `handleFileError` turned that into
 * a 404 response, so the dashboard told the user a delete had failed over a
 * file that really was gone. The resource legitimately can disappear before
 * our DELETE lands — a retry, a second tab, the file indexer, or the trashbin
 * race documented at routes/files.ts:2404 ("one of the requests can 500 while
 * the file ends up half-moved").
 *
 * The trade-off is deliberate: a DELETE aimed at the WRONG path also 404s and
 * now reports success. That is acceptable because the route re-lists
 * immediately afterwards, so a file that did not actually go away is visibly
 * still there — whereas the pre-fix behaviour failed the common case to guard
 * the rare one. Everything else (403 forbidden, 423 locked, 5xx) still throws:
 * those leave the end state either unchanged or unknown.
 */
export async function ncDeleteFile(
  token: string,
  user: string,
  path: string
): Promise<NcDeleteOutcome> {
  const url = webdavUrl(user, path);
  const resp = await fetch(url, {
    method: "DELETE",
    headers: davHeaders(token),
  });

  if (resp.status === 404) return "already-absent";

  if (!resp.ok) {
    throw new Error(`WebDAV DELETE failed: ${resp.status}`);
  }

  return "deleted";
}

export async function ncCreateDirectory(
  token: string,
  user: string,
  path: string
): Promise<void> {
  const url = webdavUrl(user, path);
  const resp = await fetch(url, {
    method: "MKCOL",
    headers: davHeaders(token),
  });

  if (!resp.ok && resp.status !== 201 && resp.status !== 405) {
    // 405 = directory already exists
    throw new Error(`WebDAV MKCOL failed: ${resp.status}`);
  }
}

// ── OCS Sharing API ──

export async function ncCreateShare(
  token: string,
  path: string,
  shareType: number = 3, // 3 = public link
  permissions: number = 1 // 1 = read
): Promise<{ url: string; token: string }> {
  const url = ocsUrl("/ocs/v2.php/apps/files_sharing/api/v1/shares");
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...ocsHeaders(token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      path,
      shareType: String(shareType),
      permissions: String(permissions),
    }),
  });

  if (!resp.ok) {
    throw new Error(`OCS share creation failed: ${resp.status}`);
  }

  const data = await resp.json();
  return {
    url: data.ocs.data.url,
    token: data.ocs.data.token,
  };
}

/**
 * List the shares that exist ON a given path.
 *
 * WARP-883 (WS-1 fast-follow): returns the FULL ShareDetail shape (via
 * mapShareRecord) — same record the create/shared-with-me paths return — so
 * the dashboard's ShareDialog can render existing shares with their expiry,
 * password flag, permissions, and note, not just a bare url. The OCS list
 * endpoint returns the same per-share record shape mapShareRecord parses.
 */
export async function ncListShares(
  token: string,
  path: string
): Promise<ShareDetail[]> {
  const url = ocsUrl(
    `/ocs/v2.php/apps/files_sharing/api/v1/shares?path=${encodeURIComponent(path)}`
  );
  const resp = await fetch(url, {
    headers: ocsHeaders(token),
  });

  if (!resp.ok) {
    throw new Error(`OCS list shares failed: ${resp.status}`);
  }

  const data = await resp.json();
  return ((data.ocs.data || []) as any[]).map((s) => mapShareRecord(s));
}

// ── OCS User Provisioning API ──

export async function ncCheckSetupRequired(): Promise<boolean> {
  // Check if Nextcloud is installed AND whether a non-default user exists.
  // Setup is required until the owner creates their personal admin account
  // via the setup wizard (POST /api/auth/setup).
  try {
    // 1. Is Nextcloud reachable and installed?
    const statusResp = await fetch(`${config.NEXTCLOUD_URL}/status.php`, {
      headers: { Accept: "application/json" },
    });
    if (!statusResp.ok) return true; // Nextcloud not ready
    const status = await statusResp.json();
    if (!status.installed) return true; // Not installed yet

    // 2. Are there any non-default users? (i.e., has setup been completed?)
    const adminUser = process.env.NEXTCLOUD_ADMIN_USER || "admin";
    const adminPassword = process.env.NEXTCLOUD_ADMIN_PASSWORD || "admin";
    const basicAuth = Buffer.from(`${adminUser}:${adminPassword}`).toString("base64");

    const usersResp = await fetch(
      `${config.NEXTCLOUD_URL}/ocs/v1.php/cloud/users?format=json`,
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "OCS-APIRequest": "true",
          Accept: "application/json",
        },
        redirect: "error", // Fail on redirects (uninstalled Nextcloud returns 302 → HTML)
      }
    );

    if (!usersResp.ok) {
      logger.warn({ status: usersResp.status }, "Cannot list Nextcloud users during setup check");
      return true;
    }

    const body = await usersResp.text();
    let data: any;
    try {
      data = JSON.parse(body);
    } catch {
      logger.warn("Nextcloud returned non-JSON response during setup check");
      return true;
    }

    const users: string[] = data?.ocs?.data?.users || [];

    // If only the default admin exists (or no users), setup is still required
    const nonDefaultUsers = users.filter((u: string) => u !== adminUser);
    return nonDefaultUsers.length === 0;
  } catch (err) {
    logger.debug({ err }, "Setup check failed — treating as setup required");
    return true; // Nextcloud unreachable — treat as needing setup
  }
}

export async function ncInstallAndCreateAdmin(
  username: string,
  password: string,
  displayName?: string,
  // WARP-883: the groups the owner joins at create time. Defaults to the
  // pre-WARP-883 behaviour (the Nextcloud "admin" group only). Callers now pass
  // the household group alongside "admin" so the shared "Household" groupfolder
  // mounts for the primary owner — without it the owner is in NEITHER the
  // literal "admin" nor the household group and the shared space never appears.
  groups: string[] = ["admin"]
): Promise<void> {
  // Nextcloud must be installed before we can use the OCS API.
  // The container creates a default admin account (NEXTCLOUD_ADMIN_USER / NEXTCLOUD_ADMIN_PASSWORD).
  // We use OCS to create the user's personal admin account.
  const adminUser = process.env.NEXTCLOUD_ADMIN_USER || "admin";
  const adminPassword = process.env.NEXTCLOUD_ADMIN_PASSWORD || "admin";
  const adminBasicAuth = Buffer.from(`${adminUser}:${adminPassword}`).toString("base64");

  // First verify Nextcloud is installed — OCS API returns HTML redirects when not installed
  const statusResp = await fetch(`${config.NEXTCLOUD_URL}/status.php`, {
    headers: { Accept: "application/json" },
  });
  if (!statusResp.ok) {
    throw new Error(`Nextcloud is not reachable: ${statusResp.status}`);
  }
  const status = await statusResp.json();
  if (!status.installed) {
    throw new Error(
      "Nextcloud is not installed yet. Please wait for the initial setup to complete and try again."
    );
  }

  // Verify OCS API is reachable with admin credentials
  // Note: OCS v1 returns XML by default — use ?format=json
  const resp = await fetch(
    ocsUrl("/ocs/v1.php/cloud/users?format=json"),
    {
      headers: {
        Authorization: `Basic ${adminBasicAuth}`,
        "OCS-APIRequest": "true",
        Accept: "application/json",
      },
      redirect: "error", // Fail on redirects instead of following to HTML page
    }
  );

  if (!resp.ok) {
    throw new Error(`Cannot reach Nextcloud OCS API: ${resp.status}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("json") && !contentType.includes("xml")) {
    // HTML response = Nextcloud not installed / redirect to setup
    throw new Error(
      "Nextcloud returned an unexpected response. It may still be initializing."
    );
  }

  // Create the actual user (skip if username matches the default admin)
  if (username !== adminUser) {
    const createResp = await fetch(ocsUrl("/ocs/v1.php/cloud/users?format=json"), {
      method: "POST",
      headers: {
        Authorization: `Basic ${adminBasicAuth}`,
        "OCS-APIRequest": "true",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      redirect: "error",
      body: new URLSearchParams([
        ["userid", username],
        ["password", password],
        ["displayName", displayName || username],
        // OCS accepts repeated `groups[]` form fields; emit one per group so the
        // owner joins both the "admin" role group AND the household group.
        ...groups.map((g): [string, string] => ["groups[]", g]),
      ]),
    });

    const createBody = await createResp.text();
    let createData: any;
    try {
      createData = JSON.parse(createBody);
    } catch {
      throw new Error(`Nextcloud returned invalid response: ${createBody.substring(0, 200)}`);
    }

    const ocsStatus = createData?.ocs?.meta?.statuscode;
    if (ocsStatus === 102) {
      // User already exists — not an error
      logger.info({ username }, "User already exists in Nextcloud");
    } else if (ocsStatus !== 100) {
      throw new Error(
        `OCS error creating user: ${createData?.ocs?.meta?.message || `status ${ocsStatus}`}`
      );
    }
  }

  // Update display name if provided
  if (displayName) {
    try {
      await fetch(
        ocsUrl(`/ocs/v1.php/cloud/users/${encodeURIComponent(username)}?format=json`),
        {
          method: "PUT",
          headers: {
            Authorization: `Basic ${adminBasicAuth}`,
            "OCS-APIRequest": "true",
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          redirect: "error",
          body: new URLSearchParams({ key: "displayname", value: displayName }),
        }
      );
    } catch (err) {
      // Non-fatal — display name update is optional
      logger.warn({ err, username }, "Failed to update display name");
    }
  }
}

/**
 * WARP-989 — idempotently ensure an OCS group exists before a user is
 * provisioned into it. OCS `POST /cloud/groups` answers statuscode 100 on
 * create and 102 when the group already exists; BOTH are success here (the
 * add is effectively idempotent). Any other status throws so the caller can
 * decide whether it's fatal.
 *
 * Uses the same env-based admin basic auth as `ncInstallAndCreateAdmin` — the
 * setup path that needs this runs before any user (and thus any admin token)
 * exists. This directly prevents the WARP-990 trigger where a missing
 * "household" group made `ncInstallAndCreateAdmin` fail with
 * "Group household does not exist" mid-setup.
 */
export async function ncEnsureGroup(groupName: string): Promise<void> {
  const adminUser = process.env.NEXTCLOUD_ADMIN_USER || "admin";
  const adminPassword = process.env.NEXTCLOUD_ADMIN_PASSWORD || "admin";
  const adminBasicAuth = Buffer.from(`${adminUser}:${adminPassword}`).toString("base64");

  const resp = await fetch(ocsUrl("/ocs/v1.php/cloud/groups?format=json"), {
    method: "POST",
    headers: {
      Authorization: `Basic ${adminBasicAuth}`,
      "OCS-APIRequest": "true",
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    redirect: "error",
    body: new URLSearchParams([["groupid", groupName]]),
  });

  const body = await resp.text();
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Nextcloud returned invalid response: ${body.substring(0, 200)}`);
  }

  const ocsStatus = data?.ocs?.meta?.statuscode;
  if (ocsStatus === 102) {
    // Group already exists — the state we wanted.
    return;
  }
  if (ocsStatus !== 100) {
    throw new NextcloudOcsError(
      `OCS error creating group: ${data?.ocs?.meta?.message || `status ${ocsStatus}`}`,
      ocsStatus ?? 0,
    );
  }
}

export async function ncCreateUser(
  adminToken: string,
  username: string,
  password: string,
  displayName?: string,
  groups?: string[],
): Promise<void> {
  // OCS accepts repeated `groups[]` form fields. URLSearchParams handles
  // repeats fine when we use the array-tuple constructor form.
  const params: Array<[string, string]> = [
    ["userid", username],
    ["password", password],
  ];
  if (displayName) params.push(["displayName", displayName]);
  if (groups) {
    for (const g of groups) {
      params.push(["groups[]", g]);
    }
  }

  const resp = await fetch(ocsUrl("/ocs/v1.php/cloud/users"), {
    method: "POST",
    headers: {
      ...ocsHeaders(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create user: ${resp.status} — ${text}`);
  }

  const data = await resp.json();
  const ocsStatus: number | undefined = data?.ocs?.meta?.statuscode;
  if (ocsStatus !== 100) {
    const message = data?.ocs?.meta?.message || "unknown";
    // 102 is the OCS "user already exists" status. Surface a typed error
    // so callers (e.g. invite-accept route) can map it to a 409 without
    // string-matching the message body. Other non-100 statuses fall
    // through to the generic NextcloudOcsError.
    if (ocsStatus === 102) {
      throw new NextcloudUserExistsError(message);
    }
    throw new NextcloudOcsError(`OCS error creating user: ${message}`, ocsStatus ?? 0);
  }
}

/**
 * Update a single field on a Nextcloud user via OCS `PUT /cloud/users/{id}`.
 *
 * Field names mirror Nextcloud's OCS contract: `displayname`, `email`,
 * `quota` (e.g. "5 GB" or `"none"` for unlimited), `password`. The OCS
 * endpoint only accepts one field per request, so callers that need to
 * update multiple fields should chain calls.
 */
export async function ncUpdateUser(
  adminToken: string,
  username: string,
  field: "displayname" | "email" | "quota" | "password",
  value: string
): Promise<void> {
  const resp = await fetch(
    ocsUrl(`/ocs/v1.php/cloud/users/${encodeURIComponent(username)}`),
    {
      method: "PUT",
      headers: {
        ...ocsHeaders(adminToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ key: field, value }),
    }
  );
  if (!resp.ok) {
    throw new Error(`Failed to update user ${username}: ${resp.status}`);
  }
  const data = await resp.json();
  if (data?.ocs?.meta?.status !== "ok") {
    throw new Error(
      `OCS update user: ${data?.ocs?.meta?.message ?? "unknown error"}`
    );
  }
}

/**
 * Enable or disable a user account. Disabled users can't log in but their
 * files are preserved — flip the flag back to re-enable.
 */
export async function ncSetUserEnabled(
  adminToken: string,
  username: string,
  enabled: boolean
): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const resp = await fetch(
    ocsUrl(`/ocs/v1.php/cloud/users/${encodeURIComponent(username)}/${action}`),
    {
      method: "PUT",
      headers: ocsHeaders(adminToken),
    }
  );
  if (!resp.ok) {
    throw new Error(`Failed to ${action} user ${username}: ${resp.status}`);
  }
  const data = await resp.json();
  if (data?.ocs?.meta?.status !== "ok") {
    throw new Error(
      `OCS ${action} user: ${data?.ocs?.meta?.message ?? "unknown error"}`
    );
  }
}

export async function ncDeleteUser(
  adminToken: string,
  username: string
): Promise<void> {
  const resp = await fetch(
    ocsUrl(`/ocs/v1.php/cloud/users/${encodeURIComponent(username)}`),
    {
      method: "DELETE",
      headers: ocsHeaders(adminToken),
    }
  );

  if (!resp.ok) {
    throw new Error(`Failed to delete user: ${resp.status}`);
  }
}

export async function ncListUsers(
  adminToken: string
): Promise<Array<{ id: string; displayName: string; email: string | null }>> {
  const resp = await fetch(ocsUrl("/ocs/v1.php/cloud/users/details"), {
    headers: ocsHeaders(adminToken),
  });

  if (!resp.ok) {
    throw new Error(`Failed to list users: ${resp.status}`);
  }

  const data = await resp.json();
  const users = data?.ocs?.data?.users || {};
  return Object.entries(users).map(([id, u]: [string, any]) => ({
    id,
    displayName: u.displayname || id,
    email: u.email || null,
  }));
}

export async function ncGetCurrentUser(
  token: string
): Promise<{ id: string; displayName: string; email: string | null; groups: string[] } | null> {
  try {
    const resp = await fetch(ocsUrl("/ocs/v1.php/cloud/user"), {
      headers: ocsHeaders(token),
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    if (data?.ocs?.meta?.status !== "ok") return null;

    return {
      id: data.ocs.data.id,
      displayName: data.ocs.data["display-name"] || data.ocs.data.id,
      email: data.ocs.data.email || null,
      groups: data.ocs.data.groups || [],
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the current user's storage quota from Nextcloud.
 * Returns { used, free, total, quota } in bytes. `quota` is -3 when unlimited.
 */
export async function ncGetUserQuota(token: string): Promise<{
  used: number;
  free: number | null;
  total: number | null;
  quota: number | null;
} | null> {
  try {
    const resp = await fetch(ocsUrl("/ocs/v1.php/cloud/user?format=json"), {
      headers: ocsHeaders(token),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.ocs?.meta?.status !== "ok") return null;
    const q = data?.ocs?.data?.quota ?? {};
    // Nextcloud returns -3 for unlimited quota; surface that as null.
    const parseNum = (v: unknown): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n < 0) return null;
      return n;
    };
    return {
      used: parseNum(q.used) ?? 0,
      free: parseNum(q.free),
      total: parseNum(q.total),
      quota: parseNum(q.quota),
    };
  } catch {
    return null;
  }
}

/**
 * WARP-1271 (T19a) — fetch an ARBITRARY user's storage quota via the admin
 * credential. `ncGetUserQuota` above only reads the CALLER's own quota
 * (`/cloud/user` resolves against the bearer's own session); the admin
 * usage roster and the per-user usage-settings GET need someone ELSE's
 * quota, which requires the admin-scoped single-user detail endpoint
 * (`GET /cloud/users/{userid}`) — same OCS `quota` object shape as
 * `/cloud/user`, just keyed by username instead of the token owner.
 * Returns null on any failure (unknown user, NC unreachable, malformed
 * response) — callers degrade to an honest "—" display, never a 500.
 */
export async function ncGetUserQuotaAdmin(
  adminToken: string,
  username: string
): Promise<{
  used: number;
  free: number | null;
  total: number | null;
  quota: number | null;
} | null> {
  try {
    const resp = await fetch(
      ocsUrl(`/ocs/v1.php/cloud/users/${encodeURIComponent(username)}?format=json`),
      { headers: ocsHeaders(adminToken) }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.ocs?.meta?.status !== "ok") return null;
    const q = data?.ocs?.data?.quota ?? {};
    // Nextcloud returns -3 for unlimited quota; surface that as null (same
    // convention as ncGetUserQuota).
    const parseNum = (v: unknown): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n < 0) return null;
      return n;
    };
    return {
      used: parseNum(q.used) ?? 0,
      free: parseNum(q.free),
      total: parseNum(q.total),
      quota: parseNum(q.quota),
    };
  } catch {
    return null;
  }
}

export async function ncLoginWithCredentials(
  username: string,
  password: string
): Promise<{ token: string; loginName: string } | null> {
  // Use Nextcloud's direct app password creation via OCS API.
  // This generates a persistent app-specific token.
  try {
    const basicAuth = Buffer.from(`${username}:${password}`).toString("base64");

    // First verify credentials by fetching user info
    const verifyResp = await fetch(ocsUrl("/ocs/v1.php/cloud/user"), {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "OCS-APIRequest": "true",
        Accept: "application/json",
      },
    });

    if (!verifyResp.ok) return null;

    const verifyData = await verifyResp.json();
    if (verifyData?.ocs?.meta?.status !== "ok") return null;

    // Generate an app password
    const appPwResp = await fetch(
      ocsUrl("/ocs/v2.php/core/getapppassword"),
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "OCS-APIRequest": "true",
          Accept: "application/json",
        },
      }
    );

    if (appPwResp.ok) {
      const appPwData = await appPwResp.json();
      if (appPwData?.ocs?.data?.apppassword) {
        return {
          token: appPwData.ocs.data.apppassword,
          loginName: username,
        };
      }
    }

    // Fallback: use basic auth token if app password creation fails.
    // This happens on some Nextcloud configs. We encode basic auth as the token.
    return {
      token: `basic:${basicAuth}`,
      loginName: username,
    };
  } catch (err) {
    logger.warn({ err }, "Login failed");
    return null;
  }
}

export async function ncDeleteAppPassword(token: string): Promise<void> {
  if (token.startsWith("basic:")) return; // Basic auth tokens can't be revoked

  try {
    await fetch(ocsUrl("/ocs/v2.php/core/apppassword"), {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "OCS-APIRequest": "true",
      },
    });
  } catch {
    // Non-fatal — token might already be expired
  }
}

/**
 * Mint a fresh Nextcloud app password for the authenticated user.
 *
 * The device pairing flow uses this to give each laptop/phone its own
 * revocable token, distinct from the user's dashboard session. Every call
 * returns a brand new token; the old one stays valid until explicitly
 * revoked via ncDeleteAppPassword.
 *
 * Returns `null` when Nextcloud refuses (most commonly: the caller is
 * already using a basic:-prefixed token, which some NC configs reject).
 */
export async function ncGenerateAppPassword(sourceToken: string): Promise<string | null> {
  try {
    const authHeader = resolveAuthHeader(sourceToken);
    const resp = await fetch(ocsUrl("/ocs/v2.php/core/getapppassword"), {
      headers: {
        Authorization: authHeader,
        "OCS-APIRequest": "true",
        Accept: "application/json",
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const appPassword = data?.ocs?.data?.apppassword;
    return typeof appPassword === "string" && appPassword.length > 0 ? appPassword : null;
  } catch (err) {
    logger.warn({ err }, "ncGenerateAppPassword failed");
    return null;
  }
}

// ── OAuth2 ──

/**
 * Register an OAuth2 client with Nextcloud (admin-only, one-time on first boot).
 * Returns { client_id, client_secret }.
 */
export async function ncRegisterOAuth2Client(
  name: string,
  redirectUri: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  const adminUser = process.env.NEXTCLOUD_ADMIN_USER || "admin";
  const adminPassword = process.env.NEXTCLOUD_ADMIN_PASSWORD || "admin";
  const basicAuth = Buffer.from(`${adminUser}:${adminPassword}`).toString("base64");

  try {
    const resp = await fetch(
      ocsUrl("/ocs/v2.php/core/oauth2/clients"),
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "OCS-APIRequest": "true",
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ name, redirectUri }),
      }
    );

    if (!resp.ok) {
      logger.error({ status: resp.status }, "Failed to register OAuth2 client");
      return null;
    }

    const data = await resp.json();
    const client = data?.ocs?.data;
    if (!client) return null;

    return {
      clientId: client.clientIdentifier || client.client_id,
      clientSecret: client.secret || client.client_secret,
    };
  } catch (err) {
    logger.error({ err }, "OAuth2 client registration failed");
    return null;
  }
}

/**
 * Build the Nextcloud OAuth2 authorization URL.
 */
export function ncOAuth2AuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${config.NEXTCLOUD_URL}/index.php/apps/oauth2/authorize?${params}`;
}

/**
 * Exchange an OAuth2 authorization code for tokens.
 */
export async function ncOAuth2ExchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
  try {
    const resp = await fetch(
      `${config.NEXTCLOUD_URL}/index.php/apps/oauth2/api/v1/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      }
    );

    if (!resp.ok) {
      logger.error({ status: resp.status }, "OAuth2 token exchange failed");
      return null;
    }

    const data = await resp.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 3600,
    };
  } catch (err) {
    logger.error({ err }, "OAuth2 token exchange error");
    return null;
  }
}

/**
 * Refresh an OAuth2 access token using a refresh token.
 */
export async function ncOAuth2RefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
  try {
    const resp = await fetch(
      `${config.NEXTCLOUD_URL}/index.php/apps/oauth2/api/v1/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      }
    );

    if (!resp.ok) return null;

    const data = await resp.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 3600,
    };
  } catch {
    return null;
  }
}

// ── Favorites / Search / Recents / Thumbnails (Phase 2) ──

/** Escape untrusted text for embedding in an XML body (search literals etc.) */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Encode a username for the `<d:href>` scope of a WebDAV SEARCH body.
 *
 * The href is a URL path that lives inside an XML document, so the value
 * crosses TWO encoding layers and the order is load-bearing:
 *
 *   1. percent-encode — the username is one path segment of a URI reference.
 *      Without this a space, `#`, `?`, or `%` addresses a DIFFERENT scope than
 *      intended (the same defect class as `webdavUrl`).
 *   2. XML-escape — the percent-encoded result is then serialized as element
 *      text, so any remaining XML metacharacter must become an entity.
 *
 * Do NOT swap these. Escaping first turns `&` into `&amp;`, which encoding then
 * mangles into `%26amp%3B`; the server percent-decodes that back to the literal
 * text `&amp;` and resolves the wrong scope. Percent-encoding happens to consume
 * every XML metacharacter, so step 2 is a no-op for today's encoder — keep it
 * anyway: it is what makes the layering hold if the encoder is ever loosened.
 */
function davScopeUser(user: string): string {
  return escapeXml(encodeURIComponent(user));
}

/**
 * Toggle the favorite flag on a file or directory.
 * Uses PROPPATCH to set oc:favorite to 1 or 0.
 */
export async function ncSetFavorite(
  token: string,
  user: string,
  path: string,
  favorite: boolean
): Promise<void> {
  const url = webdavUrl(user, path);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:set>
    <d:prop><oc:favorite>${favorite ? 1 : 0}</oc:favorite></d:prop>
  </d:set>
</d:propertyupdate>`;
  const resp = await fetch(url, {
    method: "PROPPATCH",
    headers: {
      ...davHeaders(token),
      "Content-Type": "application/xml",
    },
    body,
  });
  if (!resp.ok && resp.status !== 207) {
    throw new Error(`WebDAV PROPPATCH favorite failed: ${resp.status}`);
  }
}

/**
 * List files/directories the user has favorited anywhere in their namespace.
 * Uses a WebDAV REPORT with the oc:filter-files rule on favorites=1.
 */
export async function ncListFavorites(
  token: string,
  user: string
): Promise<FileEntryInfo[]> {
  const url = webdavUrl(user, "/");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<oc:filter-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <oc:filter-rules>
    <oc:favorite>1</oc:favorite>
  </oc:filter-rules>
  <d:prop>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:resourcetype/>
    <oc:fileid/>
    <oc:favorite/>
  </d:prop>
</oc:filter-files>`;
  const resp = await fetch(url, {
    method: "REPORT",
    headers: {
      ...davHeaders(token),
      "Content-Type": "application/xml",
    },
    body,
  });
  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw new Error(`WebDAV REPORT favorites failed: ${resp.status}`);
  }
  return parseMultiStatus(await resp.text(), "/");
}

export interface NcSearchOptions {
  query: string;
  mime?: string;
  limit?: number;
}

/**
 * Search file names within the user's namespace using WebDAV SEARCH + basicsearch.
 * Nextcloud's SEARCH supports d:like against displayname for a LIKE-%query%-match.
 */
export async function ncSearchFiles(
  token: string,
  user: string,
  opts: NcSearchOptions
): Promise<FileEntryInfo[]> {
  const url = `${config.NEXTCLOUD_URL}/remote.php/dav/`;
  const limit = opts.limit ?? 50;
  const pattern = `%${opts.query}%`;
  const mimeWhere = opts.mime
    ? `<d:and>
          <d:like>
            <d:prop><d:displayname/></d:prop>
            <d:literal>${escapeXml(pattern)}</d:literal>
          </d:like>
          <d:eq>
            <d:prop><d:getcontenttype/></d:prop>
            <d:literal>${escapeXml(opts.mime)}</d:literal>
          </d:eq>
        </d:and>`
    : `<d:like>
          <d:prop><d:displayname/></d:prop>
          <d:literal>${escapeXml(pattern)}</d:literal>
        </d:like>`;

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select>
      <d:prop>
        <d:getlastmodified/>
        <d:getcontentlength/>
        <d:getcontenttype/>
        <d:resourcetype/>
        <oc:fileid/>
      </d:prop>
    </d:select>
    <d:from>
      <d:scope>
        <d:href>/files/${davScopeUser(user)}</d:href>
        <d:depth>infinity</d:depth>
      </d:scope>
    </d:from>
    <d:where>${mimeWhere}</d:where>
    <d:orderby/>
    <d:limit><d:nresults>${limit}</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
  const resp = await fetch(url, {
    method: "SEARCH",
    headers: {
      ...davHeaders(token),
      "Content-Type": "application/xml",
    },
    body,
  });
  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw new Error(`WebDAV SEARCH failed: ${resp.status}`);
  }
  return parseMultiStatus(await resp.text(), "/");
}

/**
 * Return the user's most recently-modified files across their whole namespace.
 * Implemented as a SEARCH with an order-by on lastmodified DESC.
 */
export async function ncListRecents(
  token: string,
  user: string,
  limit: number = 50
): Promise<FileEntryInfo[]> {
  const url = `${config.NEXTCLOUD_URL}/remote.php/dav/`;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select>
      <d:prop>
        <d:getlastmodified/>
        <d:getcontentlength/>
        <d:getcontenttype/>
        <d:resourcetype/>
        <oc:fileid/>
      </d:prop>
    </d:select>
    <d:from>
      <d:scope>
        <d:href>/files/${davScopeUser(user)}</d:href>
        <d:depth>infinity</d:depth>
      </d:scope>
    </d:from>
    <d:where>
      <d:gt>
        <d:prop><d:getlastmodified/></d:prop>
        <d:literal>1970-01-01T00:00:00Z</d:literal>
      </d:gt>
    </d:where>
    <d:orderby>
      <d:order>
        <d:prop><d:getlastmodified/></d:prop>
        <d:descending/>
      </d:order>
    </d:orderby>
    <d:limit><d:nresults>${limit}</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
  const resp = await fetch(url, {
    method: "SEARCH",
    headers: {
      ...davHeaders(token),
      "Content-Type": "application/xml",
    },
    body,
  });
  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw new Error(`WebDAV SEARCH recents failed: ${resp.status}`);
  }
  // Preserve the order returned by Nextcloud (already sorted by lastmodified DESC).
  // parseMultiStatus re-sorts alphabetically, so call its parser then sort again.
  const entries = parseMultiStatus(await resp.text(), "/");
  entries.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return entries;
}

/**
 * Fetch a preview thumbnail for a file via Nextcloud's core/preview endpoint.
 * Returns raw bytes + content-type so the orchestrator can stream them through.
 */
export async function ncFetchThumbnail(
  token: string,
  fileId: number,
  x: number = 256,
  y: number = 256
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const url = `${config.NEXTCLOUD_URL}/index.php/core/preview?fileId=${fileId}&x=${x}&y=${y}&a=1&forceIcon=0`;
  const resp = await fetch(url, { headers: davHeaders(token) });
  if (!resp.ok) {
    if (resp.status === 404) return null;
    return null;
  }
  return {
    body: await resp.arrayBuffer(),
    contentType: resp.headers.get("content-type") || "image/png",
  };
}

// ── Share V2 (full options + update / delete / shared-with-me) ──

/**
 * OCS responses use HTTP status codes that mirror ocs.meta.statuscode. The
 * body always contains a JSON error message that's far more useful than the
 * raw status ("Password is present in compromised password list" vs "400").
 * Parse the body when the content-type is JSON; fall back to the status
 * otherwise.
 */
async function readOcsErrorMessage(resp: Response, fallback: string): Promise<string> {
  const ct = resp.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    return `${fallback}: ${resp.status}`;
  }
  try {
    const data = await resp.json();
    const msg = data?.ocs?.meta?.message as string | undefined;
    const code = data?.ocs?.meta?.statuscode as number | undefined;
    if (msg) return `${fallback}: ${msg}${code ? ` (${code})` : ""}`;
    return `${fallback}: ${resp.status}`;
  } catch {
    return `${fallback}: ${resp.status}`;
  }
}

/**
 * Error type preserved through the orchestrator error handler so routes can
 * map OCS failures (400 with useful body) to a 400 HTTP response rather than
 * a generic 500. Message is the OCS message verbatim.
 */
export class NextcloudOcsError extends Error {
  public readonly ocsStatus: number;
  constructor(message: string, ocsStatus: number) {
    super(message);
    this.name = "NextcloudOcsError";
    this.ocsStatus = ocsStatus;
  }
}

/**
 * Thrown by `ncCreateUser` when Nextcloud reports OCS statuscode 102
 * ("user already exists"). Callers can `instanceof`-check this without
 * string-matching the OCS message — see `auth.ts` invite-accept handler.
 */
export class NextcloudUserExistsError extends NextcloudOcsError {
  constructor(message = "User already exists") {
    super(message, 102);
    this.name = "NextcloudUserExistsError";
  }
}

/**
 * Thrown by the group-membership endpoints (`ncAddUserToGroup` /
 * `ncRemoveUserFromGroup`) when Nextcloud reports OCS statuscode 102 for
 * `POST`/`DELETE /cloud/users/{userid}/groups`. For those endpoints statuscode
 * 102 means "group does not exist" — a genuine failure that must not be
 * swallowed as an idempotent membership no-op. Note this is the *opposite* of
 * the `POST /cloud/groups` / `POST /cloud/users` create endpoints, where 102
 * means "already exists" (see `NextcloudUserExistsError`). Callers can
 * `instanceof`-check this without string-matching the OCS message.
 */
export class NextcloudGroupNotFoundError extends NextcloudOcsError {
  constructor(message = "Group does not exist") {
    super(message, 102);
    this.name = "NextcloudGroupNotFoundError";
  }
}


export interface ShareCreateOptions {
  /** 0 = user, 1 = group, 3 = public link */
  shareType: number;
  /**
   * Nextcloud permission bitmask: 1=read, 2=update, 4=create, 8=delete, 16=share.
   * Defaults to 1 (read) when omitted.
   */
  permissions?: number;
  /** ISO date string "YYYY-MM-DD" */
  expireDate?: string;
  /** Password for public links (stored hashed by Nextcloud) */
  password?: string;
  /** Note attached to the share (shown in the share dialog) */
  note?: string;
  /** Username (shareType=0) or group id (shareType=1). Ignored for public links. */
  shareWith?: string;
}

export interface ShareDetail {
  id: number;
  url: string | null;
  token: string | null;
  shareType: number;
  permissions: number;
  path: string;
  expireDate: string | null;
  hasPassword: boolean;
  note: string | null;
  shareWith: string | null;
  /** Who the item is shared with (display name, for shared-with-me views) */
  shareWithDisplayName: string | null;
  /** Owner of the underlying file */
  uidOwner: string | null;
  ownerDisplayName: string | null;
  stime: number | null;
}

function mapShareRecord(record: any): ShareDetail {
  return {
    id: Number(record.id),
    url: record.url ?? null,
    token: record.token ?? null,
    shareType: Number(record.share_type ?? record.shareType ?? 0),
    permissions: Number(record.permissions ?? 1),
    path: record.path ?? record.file_target ?? "",
    expireDate: record.expiration ?? record.expireDate ?? null,
    hasPassword: Boolean(
      record.share_with && record.share_type === 3 && record.password !== undefined
        ? record.password !== null
        : record.password !== undefined && record.password !== null
    ),
    note: record.note ?? null,
    shareWith: record.share_with ?? null,
    shareWithDisplayName: record.share_with_displayname ?? null,
    uidOwner: record.uid_owner ?? null,
    ownerDisplayName: record.displayname_owner ?? null,
    stime: record.stime ? Number(record.stime) : null,
  };
}

/**
 * Create a share with the full OCS option set (permissions, expiry, password, note, shareWith).
 * Supersedes the simple ncCreateShare from Phase 1.
 */
export async function ncCreateShareV2(
  token: string,
  path: string,
  opts: ShareCreateOptions
): Promise<ShareDetail> {
  const url = ocsUrl("/ocs/v2.php/apps/files_sharing/api/v1/shares");
  const params = new URLSearchParams({
    path,
    shareType: String(opts.shareType),
    permissions: String(opts.permissions ?? 1),
  });
  if (opts.expireDate) params.set("expireDate", opts.expireDate);
  if (opts.password) params.set("password", opts.password);
  if (opts.note) params.set("note", opts.note);
  if (opts.shareWith) params.set("shareWith", opts.shareWith);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...ocsHeaders(token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  if (!resp.ok) {
    // Nextcloud uses HTTP status == OCS statuscode for OCS v2, and the body
    // contains the real error message (e.g. password policy violation).
    const message = await readOcsErrorMessage(resp, "OCS share create");
    throw new NextcloudOcsError(message, resp.status);
  }
  const data = await resp.json();
  if (data?.ocs?.meta?.status !== "ok") {
    throw new NextcloudOcsError(
      `OCS share create: ${data?.ocs?.meta?.message ?? "unknown error"}`,
      data?.ocs?.meta?.statuscode ?? 500
    );
  }
  return mapShareRecord(data.ocs.data);
}

/**
 * Update a single field on an existing share (permissions, password, expiry, note).
 */
export async function ncUpdateShare(
  token: string,
  shareId: number,
  field: "permissions" | "password" | "expireDate" | "note",
  value: string
): Promise<void> {
  const url = ocsUrl(
    `/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}`
  );
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      ...ocsHeaders(token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ [field]: value }),
  });
  if (!resp.ok) {
    const message = await readOcsErrorMessage(resp, "OCS share update");
    throw new NextcloudOcsError(message, resp.status);
  }
  const data = await resp.json();
  if (data?.ocs?.meta?.status !== "ok") {
    throw new NextcloudOcsError(
      `OCS share update: ${data?.ocs?.meta?.message ?? "unknown error"}`,
      data?.ocs?.meta?.statuscode ?? 500
    );
  }
}

/** Revoke a share by id. */
export async function ncDeleteShare(token: string, shareId: number): Promise<void> {
  const url = ocsUrl(
    `/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}`
  );
  const resp = await fetch(url, {
    method: "DELETE",
    headers: ocsHeaders(token),
  });
  if (!resp.ok && resp.status !== 200) {
    throw new Error(`OCS share delete failed: ${resp.status}`);
  }
}

/**
 * List shares the current user has received from other users/groups.
 * Used by the "Shared with me" tab.
 */
export async function ncListSharedWithMe(
  token: string
): Promise<ShareDetail[]> {
  const url = ocsUrl(
    "/ocs/v2.php/apps/files_sharing/api/v1/shares?shared_with_me=true"
  );
  const resp = await fetch(url, { headers: ocsHeaders(token) });
  if (!resp.ok) {
    throw new Error(`OCS shared-with-me failed: ${resp.status}`);
  }
  const data = await resp.json();
  const records = data?.ocs?.data ?? [];
  // For shared-with-me, `file_target` is the recipient's path (e.g. /report.docx);
  // `path` in the OCS response is the owner's path (e.g. /Documents/report.docx).
  // Override `path` with `file_target` so permission lookups in the editor-session
  // route match what the recipient navigates to.
  return Array.isArray(records)
    ? records.map((r) => ({ ...mapShareRecord(r), path: r.file_target ?? r.path ?? "" }))
    : [];
}

/**
 * List the shares the current user has CREATED (outbound), across their whole
 * tree — the reverse of {@link ncListSharedWithMe}. Backs the dashboard's
 * "Shared by me" tab (WARP-941).
 *
 * Same OCS endpoint as {@link ncListShares} but WITHOUT a `path` filter, so
 * Nextcloud scopes the listing to the shares the authenticated user
 * INITIATED — getSharesBy defaults to `uid_initiator = me`, i.e. exactly the
 * shares this user created. We deliberately DON'T pass `reshares=true`: that
 * broadens getSharesBy to `uid_owner = me OR uid_initiator = me`, folding in
 * reshares of files the user merely OWNS but did not personally create, which
 * misrepresents a tab labeled "Shared by me". `subfiles=true` is likewise
 * omitted — it only enumerates children of a Folder node identified by `path`,
 * so with no `path` the node is null and the flag is a no-op.
 */
export async function ncListOutboundShares(token: string): Promise<ShareDetail[]> {
  const url = ocsUrl("/ocs/v2.php/apps/files_sharing/api/v1/shares");
  const resp = await fetch(url, { headers: ocsHeaders(token) });
  if (!resp.ok) {
    throw new Error(`OCS list outbound shares failed: ${resp.status}`);
  }
  const data = await resp.json();
  const records = data?.ocs?.data ?? [];
  return Array.isArray(records) ? records.map((r) => mapShareRecord(r)) : [];
}

/**
 * List shares the current caller OWNS (no `path` filter — the OCS
 * endpoint returns every share the acting credential minted when called
 * without one). WARP-1269 (T17): used for the "shared by me" aggregate —
 * called with the caller's own token for personal shares.
 */
export async function ncListMyShares(token: string): Promise<ShareDetail[]> {
  const url = ocsUrl("/ocs/v2.php/apps/files_sharing/api/v1/shares");
  const resp = await fetch(url, { headers: ocsHeaders(token) });
  if (!resp.ok) {
    throw new Error(`OCS list own shares failed: ${resp.status}`);
  }
  const data = await resp.json();
  const records = data?.ocs?.data ?? [];
  return Array.isArray(records) ? records.map((r) => mapShareRecord(r)) : [];
}

/**
 * Fetch a single share's live detail by id. Returns `null` on 404 (the
 * share was deleted directly in Nextcloud, out of band from our
 * `DepartmentShare` registry row) rather than throwing — callers
 * reconciling a registry listing against live OCS state treat a missing
 * share as "drop it from the list", not a hard failure. WARP-1269 (T17):
 * used to source live details for admin-minted department shares (called
 * with the admin credential, since the registry row's `createdById` may
 * not be the OCS share owner from Nextcloud's point of view).
 */
export async function ncGetShare(
  token: string,
  shareId: number
): Promise<ShareDetail | null> {
  const url = ocsUrl(`/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}`);
  const resp = await fetch(url, { headers: ocsHeaders(token) });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`OCS get share failed: ${resp.status}`);
  }
  const data = await resp.json();
  if (data?.ocs?.meta?.statuscode === 404) return null;
  const record = Array.isArray(data?.ocs?.data) ? data.ocs.data[0] : data?.ocs?.data;
  return record ? mapShareRecord(record) : null;
}

// ── WebDAV Move / Copy / Rename ──

/**
 * Move a file or directory within the user's namespace.
 * Uses WebDAV MOVE verb with Destination header.
 * Pass overwrite=true to replace an existing file at the destination.
 */
export async function ncMoveFile(
  token: string,
  user: string,
  fromPath: string,
  toPath: string,
  overwrite: boolean = false
): Promise<void> {
  const url = webdavUrl(user, fromPath);
  const destination = webdavUrl(user, toPath);
  const resp = await fetch(url, {
    method: "MOVE",
    headers: {
      ...davHeaders(token),
      Destination: destination,
      Overwrite: overwrite ? "T" : "F",
    },
  });
  if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
    throw new Error(`WebDAV MOVE failed: ${resp.status}`);
  }
}

/**
 * Copy a file or directory within the user's namespace.
 * Uses WebDAV COPY verb; recursive for collections.
 */
export async function ncCopyFile(
  token: string,
  user: string,
  fromPath: string,
  toPath: string,
  overwrite: boolean = false
): Promise<void> {
  const url = webdavUrl(user, fromPath);
  const destination = webdavUrl(user, toPath);
  const resp = await fetch(url, {
    method: "COPY",
    headers: {
      ...davHeaders(token),
      Destination: destination,
      Overwrite: overwrite ? "T" : "F",
    },
  });
  if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
    throw new Error(`WebDAV COPY failed: ${resp.status}`);
  }
}

// ── File ID resolution (needed for versions, favorites, etc.) ──

/**
 * Resolve a file path to its Nextcloud numeric fileId (oc:fileid).
 * Returns null if the file doesn't exist.
 */
export async function ncGetFileId(
  token: string,
  user: string,
  path: string
): Promise<number | null> {
  const url = webdavUrl(user, path);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop><oc:fileid/></d:prop>
</d:propfind>`;
  const resp = await fetch(url, {
    method: "PROPFIND",
    headers: { ...davHeaders(token), "Content-Type": "application/xml", Depth: "0" },
    body,
  });
  if (!resp.ok) {
    if (resp.status === 404) return null;
    logger.warn({ status: resp.status, path }, "ncGetFileId PROPFIND failed");
    return null;
  }
  const xml = await resp.text();
  const m = xml.match(/<oc:fileid>(\d+)<\/oc:fileid>/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Document editor: richdocuments direct-editing token (WARP-1688) ──

/**
 * WARP-1688 — mint a SESSION-FREE richdocuments editor URL for `fileId`.
 *
 * The dashboard embeds the editor in an iframe served from the DASHBOARD's
 * origin, where the browser holds no Nextcloud session cookie. The ordinary
 * connector page (`/index.php/apps/richdocuments/index?fileId=…`) therefore
 * bounces to Nextcloud's login instead of rendering — which is what made the
 * embed unusable even after WARP-1686 landed the engine itself.
 *
 * richdocuments ships the escape hatch: its OCS `createDirect` endpoint
 * (`POST /ocs/v2.php/apps/richdocuments/api/v1/document`, route table
 * `apps/richdocuments/appinfo/routes.php`) mints a short-lived direct-editing
 * token and returns `ocs.data.url` pointing at `directView#show`
 * (`GET /index.php/apps/richdocuments/direct/{token}`). That page renders the
 * real editor with NO cookies and NO Authorization header.
 *
 * The mint is performed AS THE CALLER (their per-user token — the same
 * credential `ncGetFileId` uses), never with the admin credential, so the
 * token inherits exactly that user's permissions on the file. Nextcloud, not
 * the orchestrator, remains the authority on what the token may do.
 *
 * Returns `null` — never throws — on ANY failure (non-2xx, non-JSON body,
 * missing `data.url`, transport error). The caller degrades to the ordinary
 * connector URL: a degraded editor beats a hard 500.
 *
 * NOTE: the returned URL is ABSOLUTE against Nextcloud's INTERNAL origin
 * (observed: `http://localhost/…`), which no browser can resolve. Callers MUST
 * re-base it onto the gateway's browser-facing Nextcloud path — see
 * `docserver.client.ts`.
 */
export async function ncCreateRichdocumentsDirectUrl(
  token: string,
  fileId: number
): Promise<string | null> {
  const url = ocsUrl("/ocs/v2.php/apps/richdocuments/api/v1/document");
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        ...ocsHeaders(token),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ fileId: String(fileId) }).toString(),
    });
    if (!resp.ok) {
      logger.warn(
        { status: resp.status, fileId },
        "richdocuments createDirect failed — falling back to the connector page"
      );
      return null;
    }
    const body = (await resp.json()) as {
      ocs?: { data?: { url?: unknown } };
    };
    const direct = body?.ocs?.data?.url;
    if (typeof direct !== "string" || direct.length === 0) {
      logger.warn(
        { fileId },
        "richdocuments createDirect returned no data.url — falling back to the connector page"
      );
      return null;
    }
    return direct;
  } catch (err) {
    logger.warn(
      { err, fileId },
      "richdocuments createDirect errored — falling back to the connector page"
    );
    return null;
  }
}

/**
 * WARP-883 (ADR-027 WS-5) — does a directory exist in this user's WebDAV home?
 *
 * Used by `GET /api/files/spaces` to detect whether the shared "Household"
 * group folder mounted into the caller's home (the `groupfolders` app mounts
 * the group folder as a top-level directory for every assigned member). A
 * Depth:0 PROPFIND returns 207/2xx when the path exists, 404 when it doesn't.
 * Any OTHER failure (connection refused, 5xx) THROWS so the route can decide
 * how to degrade — it must not be silently reported as "exists" or "absent".
 */
export async function ncDirExists(
  token: string,
  user: string,
  path: string
): Promise<boolean> {
  const url = webdavUrl(user, path);
  const resp = await fetch(url, {
    method: "PROPFIND",
    headers: { ...davHeaders(token), Depth: "0" },
  });
  if (resp.ok || resp.status === 207) return true;
  if (resp.status === 404) return false;
  throw new Error(`WebDAV PROPFIND failed for ${path}: ${resp.status}`);
}

// ── Trash ──

function trashUrl(user: string, sub: string): string {
  return `${config.NEXTCLOUD_URL}/remote.php/dav/trashbin/${user}/${sub}`;
}

/**
 * List items currently in the user's trashbin.
 * Returns the full list with original location and deletion time.
 */
export async function ncListTrash(
  token: string,
  user: string
): Promise<TrashItemInfo[]> {
  const url = trashUrl(user, "trash");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:resourcetype/>
    <nc:trashbin-filename/>
    <nc:trashbin-original-location/>
    <nc:trashbin-deletion-time/>
  </d:prop>
</d:propfind>`;
  const resp = await fetch(url, {
    method: "PROPFIND",
    headers: { ...davHeaders(token), "Content-Type": "application/xml", Depth: "1" },
    body,
  });
  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw new Error(`WebDAV PROPFIND trashbin failed: ${resp.status}`);
  }
  const xml = await resp.text();
  return parseTrashMultiStatus(xml);
}

/**
 * Restore a single trashed item to its original location.
 * `trashFilename` is the Nextcloud-assigned name (e.g. "photo.jpg.d1712860391").
 */
export async function ncRestoreTrashItem(
  token: string,
  user: string,
  trashFilename: string
): Promise<void> {
  const url = trashUrl(user, `trash/${encodeURIComponent(trashFilename)}`);
  const destination = trashUrl(user, `restore/${encodeURIComponent(trashFilename)}`);
  const resp = await fetch(url, {
    method: "MOVE",
    headers: { ...davHeaders(token), Destination: destination },
  });
  if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
    throw new Error(`Trash restore failed: ${resp.status}`);
  }
}

/**
 * Permanently delete a single trashed item (skip Restore, go straight to /dev/null).
 */
export async function ncDeleteTrashItem(
  token: string,
  user: string,
  trashFilename: string
): Promise<void> {
  const url = trashUrl(user, `trash/${encodeURIComponent(trashFilename)}`);
  const resp = await fetch(url, {
    method: "DELETE",
    headers: davHeaders(token),
  });
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`Trash delete failed: ${resp.status}`);
  }
}

/**
 * Empty the entire trashbin. Irreversible.
 */
export async function ncEmptyTrash(token: string, user: string): Promise<void> {
  const url = trashUrl(user, "trash");
  const resp = await fetch(url, { method: "DELETE", headers: davHeaders(token) });
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`Empty trash failed: ${resp.status}`);
  }
}

// ── Versions ──

/**
 * List version history for a file by its fileId.
 * Returns entries sorted with most recent first.
 */
export async function ncListVersions(
  token: string,
  user: string,
  fileId: number
): Promise<FileVersionInfo[]> {
  const url = `${config.NEXTCLOUD_URL}/remote.php/dav/versions/${user}/versions/${fileId}`;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getlastmodified/>
    <d:getcontentlength/>
  </d:prop>
</d:propfind>`;
  const resp = await fetch(url, {
    method: "PROPFIND",
    headers: { ...davHeaders(token), "Content-Type": "application/xml", Depth: "1" },
    body,
  });
  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw new Error(`Versions PROPFIND failed: ${resp.status}`);
  }
  const xml = await resp.text();
  return parseVersionsXml(xml, fileId);
}

/**
 * Restore a specific version of a file. The version becomes the new current content.
 * The pre-restore current content becomes the most-recent version automatically.
 */
export async function ncRestoreVersion(
  token: string,
  user: string,
  fileId: number,
  versionId: string
): Promise<void> {
  const url = `${config.NEXTCLOUD_URL}/remote.php/dav/versions/${user}/versions/${fileId}/${encodeURIComponent(versionId)}`;
  const destination = `${config.NEXTCLOUD_URL}/remote.php/dav/versions/${user}/restore/target`;
  const resp = await fetch(url, {
    method: "MOVE",
    headers: { ...davHeaders(token), Destination: destination },
  });
  if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
    throw new Error(`Version restore failed: ${resp.status}`);
  }
}

// ── XML Parsing (minimal PROPFIND response parser) ──

function parseMultiStatus(xml: string, basePath: string): FileEntryInfo[] {
  const entries: FileEntryInfo[] = [];
  // Simple regex-based parser for WebDAV PROPFIND responses
  const responseBlocks = xml.split(/<d:response>/i).slice(1);

  for (const block of responseBlocks) {
    const hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
    if (!hrefMatch) continue;

    const href = decodeURIComponent(hrefMatch[1]);
    // Skip the parent directory itself
    const isCollection = /<d:collection\s*\/?>/.test(block);

    // Extract path relative to user's DAV root
    const davPathMatch = href.match(/\/remote\.php\/dav\/files\/[^/]+\/(.*)/);
    const relativePath = davPathMatch ? "/" + davPathMatch[1].replace(/\/$/, "") : href;

    // Skip the base path itself (first entry in PROPFIND response)
    const normalizedBase = basePath.replace(/\/$/, "") || "/";
    if (relativePath === normalizedBase || relativePath + "/" === normalizedBase) continue;

    const name = relativePath.split("/").pop() || "";
    if (!name) continue;

    const sizeMatch = block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/i);
    const mtimeMatch = block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/i);
    const typeMatch = block.match(/<d:getcontenttype>([^<]+)<\/d:getcontenttype>/i);
    // WARP-1683: every PROPFIND body here already requests <oc:fileid/>;
    // surface it (previously parsed-and-dropped) so pickers can address a
    // file by the stable id the registry gate keys on.
    const fileIdMatch = block.match(/<oc:fileid>(\d+)<\/oc:fileid>/i);

    entries.push({
      name,
      path: relativePath,
      isDirectory: isCollection,
      size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
      mimeType: isCollection ? null : (typeMatch?.[1] ?? "application/octet-stream"),
      modifiedAt: mtimeMatch ? new Date(mtimeMatch[1]).toISOString() : new Date().toISOString(),
      ...(fileIdMatch ? { ncFileId: parseInt(fileIdMatch[1], 10) } : {}),
    });
  }

  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

/**
 * Parse a WebDAV PROPFIND response from the trashbin endpoint.
 * Each entry carries the Nextcloud trash filename, original location, and deletion time.
 */
function parseTrashMultiStatus(xml: string): TrashItemInfo[] {
  const items: TrashItemInfo[] = [];
  const responseBlocks = xml.split(/<d:response>/i).slice(1);

  for (const block of responseBlocks) {
    const hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
    if (!hrefMatch) continue;
    const href = decodeURIComponent(hrefMatch[1]);

    // Skip the base trashbin path itself (the first PROPFIND response)
    if (/\/remote\.php\/dav\/trashbin\/[^/]+\/trash\/?$/.test(href)) continue;

    // Trash entries live directly under /trash/, even when they were originally
    // nested inside subdirectories. Extract the trailing filename segment.
    const trashPathMatch = href.match(/\/trashbin\/[^/]+\/trash\/([^/]+)\/?$/);
    const name = trashPathMatch ? decodeURIComponent(trashPathMatch[1]) : "";
    if (!name) continue;

    const isCollection = /<d:collection\s*\/?>/.test(block);
    const sizeMatch = block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/i);
    const origLocMatch = block.match(
      /<nc:trashbin-original-location>([^<]*)<\/nc:trashbin-original-location>/i
    );
    const origNameMatch = block.match(
      /<nc:trashbin-filename>([^<]*)<\/nc:trashbin-filename>/i
    );
    const deletedAtMatch = block.match(
      /<nc:trashbin-deletion-time>(\d+)<\/nc:trashbin-deletion-time>/i
    );

    const rawOrigLoc = origLocMatch ? decodeURIComponent(origLocMatch[1]) : "";
    // Original location in Nextcloud is "folder/file.ext" — split off the filename
    // to leave just the parent directory.
    const origLocDir = rawOrigLoc ? "/" + rawOrigLoc.replace(/\/?[^/]+$/, "").replace(/^\/+/, "") : "/";
    const originalName = origNameMatch ? decodeURIComponent(origNameMatch[1]) : name;
    const deletedAt = deletedAtMatch
      ? new Date(parseInt(deletedAtMatch[1], 10) * 1000).toISOString()
      : new Date().toISOString();

    items.push({
      name,
      originalName,
      originalLocation: origLocDir || "/",
      size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
      deletedAt,
      isDirectory: isCollection,
    });
  }

  // Sort most-recently-deleted first
  items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
  return items;
}

/**
 * Parse a WebDAV PROPFIND response from the versions endpoint.
 * Returns a list of versions keyed by versionId (the trailing URL segment).
 */
function parseVersionsXml(xml: string, fileId: number): FileVersionInfo[] {
  const versions: FileVersionInfo[] = [];
  const responseBlocks = xml.split(/<d:response>/i).slice(1);

  for (const block of responseBlocks) {
    const hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
    if (!hrefMatch) continue;
    const href = decodeURIComponent(hrefMatch[1]);

    // Skip the parent /versions/{fileId}/ directory itself
    const parentRe = new RegExp(`/versions/${fileId}/?$`);
    if (parentRe.test(href)) continue;

    const versionIdMatch = href.match(/\/versions\/\d+\/([^/]+)\/?$/);
    if (!versionIdMatch) continue;
    const versionId = decodeURIComponent(versionIdMatch[1]);

    const sizeMatch = block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/i);
    const mtimeMatch = block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/i);

    versions.push({
      versionId,
      size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
      modifiedAt: mtimeMatch
        ? new Date(mtimeMatch[1]).toISOString()
        : new Date().toISOString(),
    });
  }

  // Sort most-recent first
  versions.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return versions;
}
