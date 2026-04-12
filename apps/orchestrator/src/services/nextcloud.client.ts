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
 * Used when STORAGE_BACKEND=nextcloud to proxy file operations through Nextcloud.
 */

const WEBDAV_BASE = "/remote.php/dav/files";

function webdavUrl(user: string, path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `${config.NEXTCLOUD_URL}${WEBDAV_BASE}/${user}/${cleanPath}`;
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

export async function ncDeleteFile(
  token: string,
  user: string,
  path: string
): Promise<void> {
  const url = webdavUrl(user, path);
  const resp = await fetch(url, {
    method: "DELETE",
    headers: davHeaders(token),
  });

  if (!resp.ok && resp.status !== 204) {
    throw new Error(`WebDAV DELETE failed: ${resp.status}`);
  }
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

export async function ncListShares(
  token: string,
  path: string
): Promise<Array<{ id: number; url: string; shareType: number; permissions: number }>> {
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
  return (data.ocs.data || []).map((s: any) => ({
    id: s.id,
    url: s.url,
    shareType: s.share_type,
    permissions: s.permissions,
  }));
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
  displayName?: string
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
        ["groups[]", "admin"],
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

export async function ncCreateUser(
  adminToken: string,
  username: string,
  password: string,
  displayName?: string
): Promise<void> {
  const resp = await fetch(ocsUrl("/ocs/v1.php/cloud/users"), {
    method: "POST",
    headers: {
      ...ocsHeaders(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      userid: username,
      password,
      ...(displayName ? { displayName } : {}),
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create user: ${resp.status} — ${text}`);
  }

  const data = await resp.json();
  if (data?.ocs?.meta?.statuscode !== 100) {
    throw new Error(`OCS error creating user: ${data?.ocs?.meta?.message || "unknown"}`);
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
): Promise<{ id: string; displayName: string; email: string | null } | null> {
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
        <d:href>/files/${user}</d:href>
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
        <d:href>/files/${user}</d:href>
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
  return Array.isArray(records) ? records.map(mapShareRecord) : [];
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

    entries.push({
      name,
      path: relativePath,
      isDirectory: isCollection,
      size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
      mimeType: isCollection ? null : (typeMatch?.[1] ?? "application/octet-stream"),
      modifiedAt: mtimeMatch ? new Date(mtimeMatch[1]).toISOString() : new Date().toISOString(),
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
