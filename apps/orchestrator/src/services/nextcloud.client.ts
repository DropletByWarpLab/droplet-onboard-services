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
    Authorization: `Bearer ${token}`,
    "OCS-APIRequest": "true",
    Accept: "application/json",
  };
}

function davHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
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
    body: buffer,
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
