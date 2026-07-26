import pino from "pino";
import { config } from "../config.js";
import {
  NextcloudOcsError,
  NextcloudGroupNotFoundError,
} from "./nextcloud.client.js";

const logger = pino({ name: "nextcloud-groups-client" });

/**
 * Nextcloud Groups (OCS API) + Groupfolders (REST API) client.
 *
 * Complements nextcloud.client.ts with:
 * - OCS group provisioning (add/remove users to groups, list members)
 * - Groupfolders REST API (create/delete folders, add/remove groups, set permissions/quota)
 *
 * Membership mutations are idempotent: adding an existing member or removing a
 * non-member of an *existing* group resolves OK (Nextcloud reports statuscode 100).
 * Operating against a group that does not exist surfaces NextcloudGroupNotFoundError
 * (OCS statuscode 102 on the user-groups endpoints). Real failures are surfaced as
 * typed errors.
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

/**
 * Headers for the Groupfolders REST API (`/index.php/apps/groupfolders/*`).
 *
 * WARP-1507: Nextcloud requires the `OCS-APIRequest: true` header on the
 * groupfolders routes too — without it every call is rejected with HTTP 412
 * `{"message":"CSRF check failed"}`, which stalls the department reconciler
 * (members stuck "Retrying", storage "—", card "Needs attention"). The eight
 * gf* functions previously built inline headers WITHOUT this header, so this
 * shared builder is the single source of truth. Callers that send a body merge
 * `Content-Type` on top of this.
 */
function gfHeaders(token: string): Record<string, string> {
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
 * Add a user to an OCS group (idempotent for existing groups).
 * OCS v2 `POST /cloud/users/{uid}/groups?groupid=<gid>`.
 *
 * Returns normally on success. Re-adding a user who is already a member of an
 * existing group also resolves OK — Nextcloud reports statuscode 100 for that
 * case (there is no "already a member" code for this endpoint).
 *
 * For this endpoint the OCS statuscodes are: 100 = success, 101 = no group
 * specified, 102 = group does not exist, 103 = user does not exist,
 * 104 = insufficient privileges, 105 = failed to add user to group.
 * Statuscode 102 therefore means the target group is missing (a real failure)
 * and is surfaced as NextcloudGroupNotFoundError — it must NOT be swallowed as
 * an idempotent no-op. Any other non-success statuscode throws NextcloudOcsError.
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

  // The OCS body statuscode is authoritative for this endpoint — a 2xx HTTP
  // status does not by itself mean the membership op succeeded. Success is
  // statuscode 100 (v1) or a 2xx statuscode (v2).
  if (ocsStatus === 100 || (ocsStatus >= 200 && ocsStatus < 300)) return;

  // statuscode 102 = "group does not exist" for POST /cloud/users/{uid}/groups
  // (NOT "already a member"). Surface it as a typed not-found error so a failed
  // membership op is never reported as success.
  if (ocsStatus === 102) {
    throw new NextcloudGroupNotFoundError(
      `OCS add user to group: group "${groupId}" does not exist${
        data?.ocs?.meta?.message ? ` (${data.ocs.meta.message})` : ""
      }`
    );
  }

  throw new NextcloudOcsError(
    `OCS add user to group: ${data?.ocs?.meta?.message ?? "unknown error"}`,
    ocsStatus ?? resp.status
  );
}

/**
 * Remove a user from an OCS group (idempotent for existing groups).
 * OCS v2 `DELETE /cloud/users/{uid}/groups?groupid=<gid>`.
 *
 * Returns normally on success. Removing a user who is not a member of an
 * existing group also resolves OK — Nextcloud reports statuscode 100 for that
 * case.
 *
 * For this endpoint the OCS statuscodes are: 100 = success, 101 = no group
 * specified, 102 = group does not exist, 103 = user does not exist,
 * 104 = insufficient privileges, 105 = failed to remove user from group.
 * Statuscode 102 therefore means the target group is missing (a real failure)
 * and is surfaced as NextcloudGroupNotFoundError — it must NOT be swallowed as
 * an idempotent no-op. Any other non-success statuscode throws NextcloudOcsError.
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

  // The OCS body statuscode is authoritative for this endpoint. Success is
  // statuscode 100 (v1) or a 2xx statuscode (v2).
  if (ocsStatus === 100 || (ocsStatus >= 200 && ocsStatus < 300)) return;

  // statuscode 102 = "group does not exist" for DELETE /cloud/users/{uid}/groups
  // (NOT "user not in group"). Surface it as a typed not-found error.
  if (ocsStatus === 102) {
    throw new NextcloudGroupNotFoundError(
      `OCS remove user from group: group "${groupId}" does not exist${
        data?.ocs?.meta?.message ? ` (${data.ocs.meta.message})` : ""
      }`
    );
  }

  throw new NextcloudOcsError(
    `OCS remove user from group: ${data?.ocs?.meta?.message ?? "unknown error"}`,
    ocsStatus ?? resp.status
  );
}

export interface GroupMember {
  id: string;
  displayName: string;
}

/** Parse the members out of a successful OCS group response. */
function membersFromOcs(data: unknown): GroupMember[] | null {
  const users = (data as { ocs?: { data?: { users?: unknown } } })?.ocs?.data?.users;
  if (!Array.isArray(users)) return null;
  return users.map((id: string) => ({
    id,
    displayName: id, // OCS v2 list endpoint doesn't include displayName; only id
  }));
}

/**
 * List members of an OCS group.
 * OCS v2 `GET /cloud/groups/{gid}`.
 *
 * Returns an array of group members with id and displayName. Empty array if the group
 * doesn't exist (rather than throwing, to match Nextcloud's behavior on 404).
 *
 * LENIENT — every failure collapses to `[]`, so a caller cannot tell "no
 * members" from "could not find out". That is fine for a display read and
 * WRONG for a convergence sweep; see `ncListGroupMembersStrict` below
 * (WARP-1565).
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
    return membersFromOcs(data) ?? [];
  } catch (err) {
    logger.warn({ err, groupId }, "Failed to list group members");
    return [];
  }
}

/**
 * STRICT membership listing — the variant convergence sweeps must use
 * (WARP-1565 residual 3).
 *
 * A sweep compares an EXPECTED set against the ACTUAL one and corrects the
 * difference. Handed a lenient `[]`, it cannot tell an empty group from a
 * Nextcloud that is refusing to answer — so in a list-broken /
 * writes-working outage (an OCS 500, a proxy hiccup, a wedged PHP session
 * store) the admin-group sweep reads "nobody is in droplet-admins", decides
 * every operator is missing, and re-adds all of them on every tick. The
 * writes are idempotent so nothing breaks, but the Activity log fills with
 * fictional drift and the reconciler burns a full pass each time. The
 * removal direction fails the safe way for the same reason — an empty
 * "actual" removes nobody — which is precisely why the bug is quiet.
 *
 * ONE distinction, and it is the whole design:
 *
 *   404      → `[]`. A group that does not exist genuinely has no members;
 *              the reconciler's group-creation pass owns fixing that, and a
 *              sweep that skipped the tick here would never converge a box
 *              whose group is simply missing.
 *   anything → THROW. A non-404 error status, a transport failure, or a 200
 *   else       whose payload has no `users` array are all the same answer:
 *              UNKNOWN. Acting on it means acting on a fiction.
 *
 * Deliberately a SIBLING rather than a change to `ncListGroupMembers`. The
 * lenient contract is depended on by callers whose worst case is an empty
 * render; re-pointing a shared client's error posture to satisfy two sweeps
 * is a blast radius nobody needs. Two names put the choice at the call site,
 * where the consequence actually lives.
 */
export async function ncListGroupMembersStrict(
  adminToken: string,
  groupId: string
): Promise<GroupMember[]> {
  const url = ocsUrl(`/ocs/v2.php/cloud/groups/${encodeURIComponent(groupId)}`);
  const resp = await fetch(url, { headers: ocsHeaders(adminToken) });

  if (resp.status === 404) return [];
  if (!resp.ok) {
    throw new NextcloudOcsError(
      `OCS list group members '${groupId}': HTTP ${resp.status}`,
      resp.status
    );
  }

  const members = membersFromOcs(await resp.json().catch(() => null));
  if (members === null) {
    // A malformed success is NOT an empty group. Returning `[]` here would
    // hand a sweep an authoritative-looking answer it never received.
    throw new NextcloudOcsError(
      `OCS list group members '${groupId}': response carried no users array`,
      resp.status
    );
  }
  return members;
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
      headers: gfHeaders(adminToken),
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
      headers: gfHeaders(adminToken),
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
      ...gfHeaders(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
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
      headers: gfHeaders(adminToken),
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
      ...gfHeaders(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
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
    headers: gfHeaders(adminToken),
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
      ...gfHeaders(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
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
      ...gfHeaders(adminToken),
      "Content-Type": "application/x-www-form-urlencoded",
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
