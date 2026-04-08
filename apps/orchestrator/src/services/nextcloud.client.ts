import pino from "pino";
import { config } from "../config.js";
import type { FileEntryInfo } from "../types/index.js";

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
