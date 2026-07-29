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
 *
 * WARP-1557: the groupfolder writes now throw `NextcloudGroupfolderError`,
 * which records whether the failure was UNAMBIGUOUS (4xx — the write was
 * rejected and definitely did not land) or AMBIGUOUS (5xx / timeout /
 * transport — the write may well have landed and only the response was lost).
 * They also accept an opt-in `{ confirmOnFailure: true }` that re-checks the
 * write's postcondition once before reporting failure, so a 5xx fired *after*
 * an effective write can no longer poison a Department row permanently. Both
 * default to the pre-existing behaviour; see `GfWriteOptions` for the ADR-029
 * write-only-projection reasoning.
 */

// ── WARP-1557: write-outcome ambiguity ──

/**
 * WARP-1557: a groupfolder write that did not report success.
 *
 * Carries the HTTP status AND — the point of the class — whether the
 * outcome is *ambiguous*: did the write land or not?
 *
 *   - 4xx  → the server understood the request and REJECTED it. The write
 *            definitively did not take effect. Unambiguous.
 *   - 5xx  → the server accepted the request and then blew up while (or
 *            after) processing it. The write MAY WELL HAVE LANDED. This is
 *            exactly the .87 box's failure: `gfAddGroup` returned 500 from a
 *            dead Redis session (WARP-1537) *after* Nextcloud had already
 *            attached the group, and the caller recorded a terminal failure
 *            for a write that had in fact succeeded.
 *   - 408/429 → the request may or may not have been processed before the
 *            timeout/rate limit tripped. Ambiguous, same as 5xx.
 *
 * Callers use `isAmbiguousWriteFailure()` rather than reading these fields
 * directly, so transport-level rejections classify the same way.
 */
export class NextcloudGroupfolderError extends Error {
  /** HTTP status of the failing response; null for transport-level failures. */
  public readonly httpStatus: number | null;
  /** True when the write MAY have taken effect despite reporting failure. */
  public readonly ambiguous: boolean;

  constructor(message: string, httpStatus: number | null, ambiguous: boolean) {
    super(message);
    this.name = "NextcloudGroupfolderError";
    this.httpStatus = httpStatus;
    this.ambiguous = ambiguous;
  }
}

/** HTTP statuses whose write outcome cannot be determined from the response. */
function ambiguousForHttpStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * OCS *body* statuscodes that look like HTTP 5xx but are not: 997
 * (unauthorised) and 998 (not found) are definite rejections. 999 ("unknown
 * error") genuinely is ambiguous and is deliberately NOT listed here.
 *
 * Needed because the OCS helpers in this module and in nextcloud.client.ts
 * both construct `NextcloudOcsError` with an HTTP status in some branches and
 * an OCS statuscode in others (pre-existing), so the classifier has to cope
 * with both numbering schemes.
 */
const OCS_UNAMBIGUOUS_SENTINELS = new Set([997, 998]);

/** Node's fetch() rejects with these when the request never got a response. */
const TRANSPORT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * WARP-1557 — "did this write land?" classifier.
 *
 * Returns true when the outcome is UNKNOWN and the caller must therefore
 * NOT record a terminal failure. Returns false for definite rejections.
 *
 * The default is deliberately `false` (unambiguous). Anything this function
 * does not positively recognise as ambiguous keeps the pre-WARP-1557
 * behaviour of latching a failure state — an unrecognised error is far more
 * likely to be a genuine config/logic bug (e.g. "kind=TEAM but no parent
 * row") that SHOULD surface as failed than a lost 5xx. Widening this set is
 * a deliberate act, never an accident of a fall-through.
 */
export function isAmbiguousWriteFailure(err: unknown): boolean {
  if (err instanceof NextcloudGroupfolderError) return err.ambiguous;
  // A missing group is a definite rejection, never a maybe.
  if (err instanceof NextcloudGroupNotFoundError) return false;
  if (err instanceof NextcloudOcsError) {
    if (OCS_UNAMBIGUOUS_SENTINELS.has(err.ocsStatus)) return false;
    return ambiguousForHttpStatus(err.ocsStatus);
  }
  // Transport-level: the request may have been delivered and only the
  // RESPONSE lost, so the write may still have taken effect. fetch() surfaces
  // these as `TypeError: fetch failed` with the syscall code on `cause`.
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === "string" ? cause.code : null;
    if (code && TRANSPORT_ERROR_CODES.has(code)) return true;
    if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) {
      return true;
    }
  }
  return false;
}

/**
 * WARP-1557 — opt-in postcondition confirmation for the groupfolder writes.
 *
 * ADR-029:47/:181 make Nextcloud a write-only projection: "NC state is never
 * read back as truth". `confirmOnFailure` does NOT breach that rule, and the
 * distinction is worth stating precisely because the two look similar:
 *
 *   - Reading NC as TRUTH would mean deriving *intent* from it — letting a
 *     group that exists in NC decide who has access. Nothing here does that;
 *     intent is computed entirely from Prisma by the caller and passed in.
 *   - This is a POSTCONDITION CHECK on a write we already decided to make:
 *     "the server said my write failed — did it, though?" The answer only
 *     ever converts a failure into a success for the *exact* state the
 *     caller already intended. It can never introduce state Prisma didn't
 *     ask for.
 *
 * It is off by default, so the happy path issues zero extra reads and keeps
 * the projection strictly write-only. It is switched on only by the
 * reconciler's failed-row retry sweep (see department-provisioner.service.ts
 * `provisionDepartment({ verifyOnFailure })`), where the row is already known
 * not to have converged.
 */
export interface GfWriteOptions {
  /**
   * When the write reports failure, read the folder back ONCE and resolve
   * successfully if the postcondition already holds. Bounded: at most one
   * extra GET per failed write, never a retry loop.
   */
  confirmOnFailure?: boolean;
}

/**
 * Read the folder back once and test a postcondition. Never throws — a
 * confirmation read that itself fails simply means "could not confirm", and
 * the caller falls through to its normal error path.
 */
async function confirmFolderPostcondition(
  adminToken: string,
  folderId: number,
  predicate: (folder: GroupfolderInfo) => boolean,
): Promise<boolean> {
  try {
    const folder = await gfGetFolder(adminToken, folderId);
    return folder !== null && predicate(folder);
  } catch (err) {
    logger.warn(
      { err, folderId },
      "WARP-1557: postcondition confirmation read failed; treating write as failed",
    );
    return false;
  }
}

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
 *
 * WARP-1557: with `confirmOnFailure`, a failed create re-lists once and
 * returns the existing folder's id if the mount point is now present — a 5xx
 * that fired *after* the folder was created no longer looks like a failure.
 */
export async function gfCreateFolder(
  adminToken: string,
  mountpoint: string,
  opts?: GfWriteOptions
): Promise<number> {
  const url = restUrl("/index.php/apps/groupfolders/folders");

  /** One bounded re-list: did the folder get created despite the error? */
  const confirmCreated = async (): Promise<number | null> => {
    if (!opts?.confirmOnFailure) return null;
    try {
      const existing = (await gfListFolders(adminToken)).find(
        (f) => f.mountPoint === mountpoint
      );
      return existing ? existing.id : null;
    } catch {
      return null;
    }
  };

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
    const confirmedId = await confirmCreated();
    if (confirmedId !== null) {
      logger.warn(
        { mountpoint, status: resp.status, folderId: confirmedId },
        "WARP-1557: groupfolder create reported failure but the folder exists; treating as success",
      );
      return confirmedId;
    }
    throw new NextcloudGroupfolderError(
      message,
      resp.status,
      ambiguousForHttpStatus(resp.status)
    );
  }

  const data = await resp.json();
  const id = data?.ocs?.data?.id;
  if (typeof id !== "number") {
    const confirmedId = await confirmCreated();
    if (confirmedId !== null) return confirmedId;
    // A 2xx with no id is a malformed response, not a rejection — the folder
    // may exist. Ambiguous.
    throw new NextcloudGroupfolderError(
      "Groupfolder create response missing folder id",
      resp.status,
      true
    );
  }

  return id;
}

/**
 * Delete a groupfolder by id (REST API).
 * `DELETE /index.php/apps/groupfolders/folders/{id}`.
 *
 * Idempotent: deleting a non-existent folder returns OK (404 → no-op).
 *
 * WARP-1557: with `confirmOnFailure`, a reported failure resolves as success
 * when the folder is in fact already gone — the archive-path twin of the
 * `gfAddGroup` fix (a 5xx fired after the delete landed used to park the row
 * in `archive_failed` forever).
 */
export async function gfDeleteFolder(
  adminToken: string,
  folderId: number,
  opts?: GfWriteOptions
): Promise<void> {
  const url = restUrl(`/index.php/apps/groupfolders/folders/${folderId}`);

  /** The postcondition gfDeleteFolder exists to establish: folder is gone. */
  const confirmGone = async (status: number | null): Promise<boolean> => {
    if (!opts?.confirmOnFailure) return false;
    let gone: boolean;
    try {
      gone = (await gfGetFolder(adminToken, folderId)) === null;
    } catch {
      return false;
    }
    if (gone) {
      logger.warn(
        { folderId, status },
        "WARP-1557: groupfolder delete reported failure but the folder is gone; treating as success",
      );
    }
    return gone;
  };

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "DELETE",
      headers: gfHeaders(adminToken),
    });
  } catch (err) {
    logger.warn({ err, folderId }, "Failed to delete groupfolder");
    if (await confirmGone(null)) return;
    throw err;
  }

  if (!resp.ok) {
    if (resp.status === 404) return; // already gone
    if (await confirmGone(resp.status)) return;
    const err = new NextcloudGroupfolderError(
      `Groupfolder delete ${folderId} failed: ${resp.status}`,
      resp.status,
      ambiguousForHttpStatus(resp.status)
    );
    logger.warn({ err, folderId }, "Failed to delete groupfolder");
    throw err;
  }

  const data = await resp.json();
  if (data?.ocs?.data?.success !== true) {
    if (await confirmGone(resp.status)) return;
    const err = new NextcloudGroupfolderError(
      `Groupfolder delete ${folderId}: operation reported failure`,
      resp.status,
      false
    );
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
 *
 * WARP-1557 — THE primary fix. This is the exact call that latched two
 * departments into a permanent `failed` state on the .87 box: it returned
 * `Groupfolder add group: 500` while `occ groupfolders:list` showed the group
 * already attached with the right mask. With `confirmOnFailure` the reported
 * failure is checked against the folder's actual group list, and "the group I
 * was asked to attach is already attached" resolves as success — which is
 * what the caller wanted in the first place. Without this, those rows stay
 * `failed` even after the underlying Redis bug (WARP-1537) is fixed.
 */
export async function gfAddGroup(
  adminToken: string,
  folderId: number,
  groupId: string,
  opts?: GfWriteOptions
): Promise<void> {
  const url = restUrl(
    `/index.php/apps/groupfolders/folders/${folderId}/groups`
  );

  /** The postcondition gfAddGroup exists to establish: group is attached. */
  const attached = (folder: GroupfolderInfo): boolean =>
    Object.prototype.hasOwnProperty.call(folder.groups, groupId);

  const confirmAttached = async (status: number | null): Promise<boolean> => {
    if (!opts?.confirmOnFailure) return false;
    const ok = await confirmFolderPostcondition(adminToken, folderId, attached);
    if (ok) {
      logger.warn(
        { folderId, groupId, status },
        "WARP-1557: groupfolder add-group reported failure but the group is attached; treating as success",
      );
    }
    return ok;
  };

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
    if (await confirmAttached(resp.status)) return;
    throw new NextcloudGroupfolderError(
      message,
      resp.status,
      ambiguousForHttpStatus(resp.status)
    );
  }

  const data = await resp.json();
  if (data?.ocs?.data?.success !== true) {
    if (await confirmAttached(resp.status)) return;
    // 2xx + success:false is the server explicitly declining — unambiguous.
    throw new NextcloudGroupfolderError(
      `Groupfolder add group: operation reported failure`,
      resp.status,
      false
    );
  }
}

/**
 * Remove a group from a groupfolder (REST API, idempotent).
 * `DELETE /index.php/apps/groupfolders/folders/{id}/groups/{groupId}`.
 *
 * Returns normally whether the group was removed or wasn't assigned. Throws on
 * real failures (folder or group doesn't exist — actual HTTP errors, not logical absence).
 *
 * WARP-1557: with `confirmOnFailure`, a reported failure resolves as success
 * when the group is in fact no longer attached.
 */
export async function gfRemoveGroup(
  adminToken: string,
  folderId: number,
  groupId: string,
  opts?: GfWriteOptions
): Promise<void> {
  const url = restUrl(
    `/index.php/apps/groupfolders/folders/${folderId}/groups/${encodeURIComponent(groupId)}`
  );

  const confirmDetached = async (status: number | null): Promise<boolean> => {
    if (!opts?.confirmOnFailure) return false;
    const ok = await confirmFolderPostcondition(
      adminToken,
      folderId,
      (folder) =>
        !Object.prototype.hasOwnProperty.call(folder.groups, groupId),
    );
    if (ok) {
      logger.warn(
        { folderId, groupId, status },
        "WARP-1557: groupfolder remove-group reported failure but the group is detached; treating as success",
      );
    }
    return ok;
  };

  const resp = await fetch(url, {
    method: "DELETE",
    headers: gfHeaders(adminToken),
  });

  if (!resp.ok) {
    if (resp.status === 404) return; // already gone or never assigned
    const message = await readRestErrorMessage(resp, "Groupfolder remove group");
    if (await confirmDetached(resp.status)) return;
    throw new NextcloudGroupfolderError(
      message,
      resp.status,
      ambiguousForHttpStatus(resp.status)
    );
  }

  const data = await resp.json();
  if (data?.ocs?.data?.success !== true) {
    if (await confirmDetached(resp.status)) return;
    throw new NextcloudGroupfolderError(
      `Groupfolder remove group: operation reported failure`,
      resp.status,
      false
    );
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
 *
 * WARP-1557: with `confirmOnFailure`, a reported failure resolves as success
 * when the group is already attached AT EXACTLY THE EXPECTED MASK. The mask
 * equality is the whole point — confirming mere attachment here would let a
 * folder sitting at the wrong permissions be declared converged.
 */
export async function gfSetGroupPermissions(
  adminToken: string,
  folderId: number,
  groupId: string,
  permissions: number,
  opts?: GfWriteOptions
): Promise<void> {
  const url = restUrl(
    `/index.php/apps/groupfolders/folders/${folderId}/groups/${encodeURIComponent(groupId)}`
  );

  const confirmMask = async (status: number | null): Promise<boolean> => {
    if (!opts?.confirmOnFailure) return false;
    const ok = await confirmFolderPostcondition(
      adminToken,
      folderId,
      (folder) => folder.groups[groupId] === permissions,
    );
    if (ok) {
      logger.warn(
        { folderId, groupId, permissions, status },
        "WARP-1557: groupfolder set-permissions reported failure but the mask already matches; treating as success",
      );
    }
    return ok;
  };

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
    if (await confirmMask(resp.status)) return;
    throw new NextcloudGroupfolderError(
      message,
      resp.status,
      ambiguousForHttpStatus(resp.status)
    );
  }

  const data = await resp.json();
  if (data?.ocs?.data?.success !== true) {
    if (await confirmMask(resp.status)) return;
    throw new NextcloudGroupfolderError(
      `Groupfolder set permissions: operation reported failure`,
      resp.status,
      false
    );
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
 *
 * WARP-1557: with `confirmOnFailure`, a reported failure resolves as success
 * when the folder's quota already equals the requested value.
 */
export async function gfSetQuota(
  adminToken: string,
  folderId: number,
  quota: number,
  opts?: GfWriteOptions
): Promise<void> {
  const url = restUrl(
    `/index.php/apps/groupfolders/folders/${folderId}/quota`
  );

  const confirmQuota = async (status: number | null): Promise<boolean> => {
    if (!opts?.confirmOnFailure) return false;
    const ok = await confirmFolderPostcondition(
      adminToken,
      folderId,
      (folder) => folder.quota === quota,
    );
    if (ok) {
      logger.warn(
        { folderId, quota, status },
        "WARP-1557: groupfolder set-quota reported failure but the quota already matches; treating as success",
      );
    }
    return ok;
  };

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
    if (await confirmQuota(resp.status)) return;
    throw new NextcloudGroupfolderError(
      message,
      resp.status,
      ambiguousForHttpStatus(resp.status)
    );
  }

  const data = await resp.json();
  if (data?.ocs?.data?.success !== true) {
    if (await confirmQuota(resp.status)) return;
    throw new NextcloudGroupfolderError(
      `Groupfolder set quota: operation reported failure`,
      resp.status,
      false
    );
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
