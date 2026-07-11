import pino from "pino";
import { config } from "../config.js";
import { NextcloudOcsError } from "./nextcloud.client.js";

const logger = pino({ name: "nextcloud-groups-client" });

/**
 * Nextcloud Groups (OCS API) + Groupfolders (REST API) client.
 *
 * Complements nextcloud.client.ts with:
 * - OCS group provisioning (add/remove users to groups, list members)
 * - Groupfolders REST API (create/delete folders, add/remove groups, set permissions/quota)
 *
 * All mutating calls are idempotent: adding an existing membership or group resolves OK,
 * removing a non-member/non-group resolves OK. Real failures are surfaced as typed errors.
 */

function ocsUrl(endpoint: string): string {
  return `${config.NEXTCLOUD_URL}${endpoint}`;
}

function restUrl(endpoint: string): string {
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

/**
 * Parse OCS error message from response body. Handles both v1 (statuscode as int)
 * and v2 (HTTP status) conventions.
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

// ── OCS Groups API ──

/**
 * Add a user to an OCS group (idempotent).
 * OCS v2 `POST /cloud/users/{uid}/groups?groupid=<gid>`.
 *
 * Returns normally on success. If the user is already in the group (OCS statuscode 102),
 * this still resolves OK — the operation is idempotent.
 * Throws NextcloudOcsError on real failures (group doesn't exist, etc.).
 */
export async function ncAddUserToGroup(
  adminToken: string,
  uid: string,
  groupId: string
): Promise<void> {
  const url = ocsUrl(
    `/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}/groups?groupid=${encodeURIComponent(groupId)}`
  );

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...ocsHeaders(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ groupid: groupId }),
  });

  if (!resp.ok) {
    const message = await readOcsErrorMessage(resp, "OCS add user to group");
    throw new NextcloudOcsError(message, resp.status);
  }

  const data = await resp.json();
  const ocsStatus = data?.ocs?.meta?.statuscode;

  // statuscode 102 = user already in group (idempotent success)
  // statuscode 100 = success in v1; statuscode 200 in v2
  if (ocsStatus === 102) return;

  // v2 uses HTTP status; check that first
  if (resp.status >= 200 && resp.status < 300) return;

  // v1 uses ocs.meta.statuscode
  if (ocsStatus === 100) return;

  throw new NextcloudOcsError(
    `OCS add user to group: ${data?.ocs?.meta?.message ?? "unknown error"}`,
    ocsStatus ?? resp.status
  );
}

/**
 * Remove a user from an OCS group (idempotent).
 * OCS v2 `DELETE /cloud/users/{uid}/groups?groupid=<gid>`.
 *
 * Returns normally on success. If the user is not in the group (OCS statuscode 102),
 * this still resolves OK — the operation is idempotent.
 * Throws NextcloudOcsError on real failures.
 */
export async function ncRemoveUserFromGroup(
  adminToken: string,
  uid: string,
  groupId: string
): Promise<void> {
  const url = ocsUrl(
    `/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}/groups?groupid=${encodeURIComponent(groupId)}`
  );

  const resp = await fetch(url, {
    method: "DELETE",
    headers: ocsHeaders(adminToken),
  });

  if (!resp.ok) {
    const message = await readOcsErrorMessage(resp, "OCS remove user from group");
    throw new NextcloudOcsError(message, resp.status);
  }

  const data = await resp.json();
  const ocsStatus = data?.ocs?.meta?.statuscode;

  // statuscode 102 = user not in group (idempotent success)
  if (ocsStatus === 102) return;

  // v2 HTTP status success
  if (resp.status >= 200 && resp.status < 300) return;

  // v1 statuscode
  if (ocsStatus === 100) return;

  throw new NextcloudOcsError(
    `OCS remove user from group: ${data?.ocs?.meta?.message ?? "unknown error"}`,
    ocsStatus ?? resp.status
  );
}

export interface GroupMember {
  id: string;
  displayName: string;
}

/**
 * List members of an OCS group.
 * OCS v2 `GET /cloud/groups/{gid}`.
 *
 * Returns an array of group members with id and displayName. Empty array if the group
 * doesn't exist (rather than throwing, to match Nextcloud's behavior on 404).
 */
export async function ncListGroupMembers(
  adminToken: string,
  groupId: string
): Promise<GroupMember[]> {
  const url = ocsUrl(`/ocs/v2.php/cloud/groups/${encodeURIComponent(groupId)}`);

  try {
    const resp = await fetch(url, {
      headers: ocsHeaders(adminToken),
    });

    if (!resp.ok) {
      if (resp.status === 404) return [];
      logger.warn({ status: resp.status, groupId }, "Failed to list group members");
      return [];
    }

    const data = await resp.json();
    const members = data?.ocs?.data?.users || [];

    return members.map((id: string) => ({
      id,
      displayName: id, // OCS v2 list endpoint doesn't include displayName; only id
    }));
  } catch (err) {
    logger.warn({ err, groupId }, "Failed to list group members");
    return [];
  }
}

// ── Groupfolders REST API ──

export interface GroupfolderInfo {
  id: number;
  mountPoint: string;
  groups: Record<string, number>; // groupId -> permissionBitmask
  quota: number; // bytes; -3 = unlimited
  size: number; // bytes
  acl: boolean;
  manage: string[]; // user ids with folder management rights
}

/**
 * List all groupfolders (REST API).
 * `GET /index.php/apps/groupfolders/folders`.
 *
 * Returns an array of folder info objects. Empty array on failure to match
 * Nextcloud's behavior gracefully.
 */
export async function gfListFolders(
  adminToken: string
): Promise<GroupfolderInfo[]> {
  const url = restUrl("/index.php/apps/groupfolders/folders");

  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: resolveAuthHeader(adminToken),
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status }, "Failed to list groupfolders");
      return [];
    }

    const data = await resp.json();
    // Response shape: data is id-keyed object: { "1": {...}, "2": {...} }
    const folders = data?.ocs?.data || {};
    if (typeof folders !== "object") return [];

    return Object.entries(folders).map(([, folderData]: [string, any]) =>
      parseGroupfolderRecord(folderData)
    );
  } catch (err) {
    logger.warn({ err }, "Failed to parse groupfolders list");
    return [];
  }
}

/**
 * Get a single groupfolder by id (REST API).
 * `GET /index.php/apps/groupfolders/folders/{id}`.
 *
 * Returns the folder info or throws on real failure (not 404; 404 returns null).
 */
export async function gfGetFolder(
  adminToken: string,
  folderId: number
): Promise<GroupfolderInfo | null> {
  const url = restUrl(`/index.php/apps/groupfolders/folders/${folderId}`);

  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: resolveAuthHeader(adminToken),
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      if (resp.status === 404) return null;
      throw new Error(`Groupfolder GET ${folderId} failed: ${resp.status}`);
    }

    const data = await resp.json();
    const folder = data?.ocs?.data;
    if (!folder) return null;

    return parseGroupfolderRecord(folder);
  } catch (err) {
    logger.warn({ err, folderId }, "Failed to get groupfolder");
    throw err;
  }
}

/**
 * Create a new groupfolder (REST API).
 * `POST /index.php/apps/groupfolders/folders` with form `mountpoint=<name>`.
 *
 * Returns the id of the newly created folder. Throws if the folder already exists
 * (mount point collision).
 */
export async function gfCreateFolder(
  adminToken: string,
  mountpoint: string
): Promise<number> {
  const url = restUrl("/index.php/apps/groupfolders/folders");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: resolveAuthHeader(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ mountpoint }),
  });

  if (!resp.ok) {
    const message = await readRestErrorMessage(resp, "Groupfolder create");
    throw new Error(message);
  }

  const data = await resp.json();
  const id = data?.ocs?.data?.id;
  if (typeof id !== "number") {
    throw new Error("Groupfolder create response missing folder id");
  }

  return id;
}

/**
 * Delete a groupfolder by id (REST API).
 * `DELETE /index.php/apps/groupfolders/folders/{id}`.
 *
 * Idempotent: deleting a non-existent folder returns OK (404 → no-op).
 */
export async function gfDeleteFolder(
  adminToken: string,
  folderId: number
): Promise<void> {
  const url = restUrl(`/index.php/apps/groupfolders/folders/${folderId}`);

  try {
    const resp = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: resolveAuthHeader(adminToken),
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      if (resp.status === 404) return; // already gone
      throw new Error(`Groupfolder delete ${folderId} failed: ${resp.status}`);
    }

    const data = await resp.json();
    if (data?.ocs?.data?.success !== true) {
      throw new Error(`Groupfolder delete ${folderId}: operation reported failure`);
    }
  } catch (err) {
    logger.warn({ err, folderId }, "Failed to delete groupfolder");
    throw err;
  }
}

/**
 * Add a group to a groupfolder (REST API, idempotent).
 * `POST /index.php/apps/groupfolders/folders/{id}/groups` with form `group=<groupId>`.
 *
 * Returns normally whether the group was added or already existed. Assigns default
 * permissions (31 = read+update+create+delete+share). Call gfSetGroupPermissions
 * immediately after if you need more restricted access.
 *
 * Throws if the folder or group doesn't exist.
 */
export async function gfAddGroup(
  adminToken: string,
  folderId: number,
  groupId: string
): Promise<void> {
  const url = restUrl(
    `/index.php/apps/groupfolders/folders/${folderId}/groups`
  );

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: resolveAuthHeader(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ group: groupId }),
  });

  if (!resp.ok) {
    const message = await readRestErrorMessage(resp, "Groupfolder add group");
    throw new Error(message);
  }

  const data = await resp.json();
  if (data?.ocs?.data?.success !== true) {
    throw new Error(`Groupfolder add group: operation reported failure`);
  }
}

/**
 * Remove a group from a groupfolder (REST API, idempotent).
 * `DELETE /index.php/apps/groupfolders/folders/{id}/groups/{groupId}`.
 *
 * Returns normally whether the group was removed or wasn't assigned. Throws on
 * real failures (folder or group doesn't exist — actual HTTP errors, not logical absence).
 */
export async function gfRemoveGroup(
  adminToken: string,
  folderId: number,
  groupId: string
): Promise<void> {
  const url = restUrl(
    `/index.php/apps/groupfolders/folders/${folderId}/groups/${encodeURIComponent(groupId)}`
  );

  const resp = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: resolveAuthHeader(adminToken),
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    if (resp.status === 404) return; // already gone or never assigned
    const message = await readRestErrorMessage(resp, "Groupfolder remove group");
    throw new Error(message);
  }

  const data = await resp.json();
  if (data?.ocs?.data?.success !== true) {
    throw new Error(`Groupfolder remove group: operation reported failure`);
  }
}

/**
 * Set permissions for a group on a groupfolder (REST API).
 * `POST /index.php/apps/groupfolders/folders/{id}/groups/{groupId}` with form `permissions=<bitmask>`.
 *
 * Permission bitmask: 1=read, 2=update, 4=create, 8=delete, 16=share.
 * Common values: 1 (read-only), 7 (read+update+create), 15 (read+update+create+delete, no share), 31 (full).
 *
 * Throws if the folder or group doesn't exist.
 */
export async function gfSetGroupPermissions(
  adminToken: string,
  folderId: number,
  groupId: string,
  permissions: number
): Promise<void> {
  const url = restUrl(
    `/index.php/apps/groupfolders/folders/${folderId}/groups/${encodeURIComponent(groupId)}`
  );

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: resolveAuthHeader(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ permissions: String(permissions) }),
  });

  if (!resp.ok) {
    const message = await readRestErrorMessage(resp, "Groupfolder set permissions");
    throw new Error(message);
  }

  const data = await resp.json();
  if (data?.ocs?.data?.success !== true) {
    throw new Error(`Groupfolder set permissions: operation reported failure`);
  }
}

/**
 * Set quota for a groupfolder (REST API).
 * `POST /index.php/apps/groupfolders/folders/{id}/quota` with form `quota=<bytes>`.
 *
 * Pass quota in bytes. Special value -3 means unlimited (though the spike doc
 * recommends handling unlimited as null/0 in the app layer, not propagating -3).
 *
 * Throws if the folder doesn't exist.
 */
export async function gfSetQuota(
  adminToken: string,
  folderId: number,
  quota: number
): Promise<void> {
  const url = restUrl(
    `/index.php/apps/groupfolders/folders/${folderId}/quota`
  );

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: resolveAuthHeader(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ quota: String(quota) }),
  });

  if (!resp.ok) {
    const message = await readRestErrorMessage(resp, "Groupfolder set quota");
    throw new Error(message);
  }

  const data = await resp.json();
  if (data?.ocs?.data?.success !== true) {
    throw new Error(`Groupfolder set quota: operation reported failure`);
  }
}

// ── Helpers ──

/**
 * Parse a groupfolder record from OCS response. Normalizes the response shape
 * to a consistent interface regardless of whether it came from list or single-GET.
 */
function parseGroupfolderRecord(record: any): GroupfolderInfo {
  return {
    id: Number(record.id),
    mountPoint: record.mount_point || record.mountPoint || "",
    groups: record.groups || {}, // id -> permissionBitmask map
    quota: Number(record.quota ?? -3),
    size: Number(record.size ?? 0),
    acl: Boolean(record.acl),
    manage: Array.isArray(record.manage) ? record.manage : [],
  };
}

/**
 * Parse REST API error message from response body.
 */
async function readRestErrorMessage(resp: Response, fallback: string): Promise<string> {
  const ct = resp.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    return `${fallback}: ${resp.status}`;
  }
  try {
    const data = await resp.json();
    const msg = data?.ocs?.meta?.message as string | undefined;
    if (msg) return `${fallback}: ${msg}`;
    return `${fallback}: ${resp.status}`;
  } catch {
    return `${fallback}: ${resp.status}`;
  }
}
