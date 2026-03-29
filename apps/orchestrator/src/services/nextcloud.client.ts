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
  // During initial Nextcloud install, the OCS API isn't available yet.
  // We check if Nextcloud is installed by hitting the status endpoint,
  // then try to list users with the default admin creds.
  try {
    const statusResp = await fetch(`${config.NEXTCLOUD_URL}/status.php`, {
      headers: { Accept: "application/json" },
    });
    if (!statusResp.ok) return true; // Nextcloud not ready
    const status = await statusResp.json();
    if (!status.installed) return true; // Not installed yet
    return false; // Nextcloud is installed — setup was already done
  } catch {
    return true; // Nextcloud unreachable — treat as needing setup
  }
}

export async function ncInstallAndCreateAdmin(
  username: string,
  password: string,
  displayName?: string
): Promise<void> {
  // Nextcloud auto-installs when first accessed with admin credentials set via env vars.
  // However, since we removed the env vars, we use the Nextcloud CLI via the status check
  // and the initial POST to create the admin.
  // For our architecture, the Nextcloud container sets up with a default admin.
  // We use OCS to create additional users or update the admin display name.

  // First, check if Nextcloud is installed by using the default admin creds
  const resp = await fetch(
    ocsUrl("/ocs/v1.php/cloud/users"),
    {
      headers: {
        ...ocsHeaders(""),
        Authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}`,
      },
    }
  );

  if (!resp.ok) {
    throw new Error(`Cannot reach Nextcloud OCS API: ${resp.status}`);
  }

  // Create the actual user
  if (username !== "admin") {
    const createResp = await fetch(ocsUrl("/ocs/v1.php/cloud/users"), {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}`,
        "OCS-APIRequest": "true",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        userid: username,
        password,
        displayName: displayName || username,
        groups: JSON.stringify(["admin"]),
      }),
    });

    if (!createResp.ok) {
      const body = await createResp.text();
      // Check if user already exists (status 102)
      if (!body.includes("102")) {
        throw new Error(`Failed to create user: ${createResp.status} ${body}`);
      }
    }
  }

  // Update display name if provided
  if (displayName) {
    await fetch(
      ocsUrl(`/ocs/v1.php/cloud/users/${encodeURIComponent(username)}`),
      {
        method: "PUT",
        headers: {
          Authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}`,
          "OCS-APIRequest": "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ key: "displayname", value: displayName }),
      }
    );
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
