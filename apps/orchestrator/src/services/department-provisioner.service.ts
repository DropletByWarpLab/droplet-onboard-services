/**
 * WARP-1257 (T5) — department provisioner.
 *
 * Walks a single `Department` row through its NC-side lifecycle:
 *
 *   pending      → provisioning → active
 *   archiving    → archived
 *
 * Prisma is truth (ADR-013 write-only-projection framing from the
 * TEAMS-DEPARTMENTS-FILES-ARCHITECTURE-BRIEF.md): every write here is a
 * *push* toward the row's desired state. NC state is never read back as
 * authorization truth — `gfListFolders` is consulted only for id
 * discovery / mount-point dedupe.
 *
 * WARP-1557 adds ONE narrow extra use of that same `gfListFolders` read:
 * on the reconciler's failed-row retry sweep only (`{ verifyOnFailure }`),
 * the already-fetched folder record is compared against the Prisma-derived
 * intent, so a row whose Nextcloud state already matches can converge
 * instead of re-issuing a write that keeps failing. Intent still comes
 * exclusively from Prisma; NC is only ever asked "is what I decided already
 * here?". See the ADR-029 boundary note on `folderMatchesIntent` below.
 *
 * `kind` behavior:
 *   - DEPARTMENT — top-level: groups `dept-<slug>` / `dept-<slug>-ro`,
 *     mount point = `Department.name`.
 *   - TEAM — nested one level under a DEPARTMENT parent: groups
 *     `dept-<parentSlug>-<slug>` / `dept-<parentSlug>-<slug>-ro`, mount
 *     point **FLAT** `<Parent.name> — <Team.name>` (never nested — see
 *     WARP-1254/PR #977: nested mount_points silently leak writes to the
 *     acting user's personal storage for team-member-without-department-
 *     membership).
 *   - HOUSEHOLD — the legacy WS-5 adopted group. Zero NC mutation here,
 *     ever; the household's groupfolder/groups already exist from
 *     `docker/nextcloud-init.sh` and the (separate) T11 absorption seed.
 *     The reconciler still attaches `droplet-admins` to it.
 *
 * `droplet-admins` is box-wide and idempotently ensured once per call —
 * `ncEnsureGroup` is itself idempotent (OCS 100/102 both resolve OK), so
 * calling it on every provision is cheap and keeps the invariant true
 * even if the group was hand-deleted out of band.
 */
import type { PrismaClient } from "@prisma/client";
import { ncEnsureGroup } from "./nextcloud.client.js";
import {
  gfListFolders,
  gfCreateFolder,
  gfDeleteFolder,
  gfAddGroup,
  gfRemoveGroup,
  gfSetGroupPermissions,
  gfSetQuota,
  isAmbiguousWriteFailure,
  type GroupfolderInfo,
  type GfWriteOptions,
} from "./nextcloud-groups.client.js";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("department-provisioner");

/** Box-wide admin group attached at full mask on every active groupfolder. */
export const DROPLET_ADMINS_GROUP = "droplet-admins";

/** Permission bitmasks (groupfolders REST): 1=read,2=update,4=create,8=delete,16=share. */
export const MASK_RW = 15; // read+update+create+delete, share bit withheld
export const MASK_RO = 1; // read-only
export const MASK_ADMIN = 31; // full, incl. share

/** Max length of a persisted provisionError/syncError message. */
const ERROR_TRUNCATE_LEN = 1024;

function truncateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > ERROR_TRUNCATE_LEN
    ? `${msg.slice(0, ERROR_TRUNCATE_LEN)}…`
    : msg;
}

/** Basic-auth admin token in the `basic:<base64>` form the NC clients expect. */
export function adminBasicToken(): string {
  const adminUser = process.env.NEXTCLOUD_ADMIN_USER || "admin";
  const adminPassword = process.env.NEXTCLOUD_ADMIN_PASSWORD || "admin";
  return `basic:${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
}

interface DepartmentRow {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  quotaBytes: bigint | null;
  ncGroupRw: string | null;
  ncGroupRo: string | null;
  ncGroupfolderId: number | null;
}

/**
 * Compute the rw/ro NC group names for a DEPARTMENT or TEAM row.
 * TEAM groups are namespaced under the parent's slug: `dept-<parent>-<team>`.
 */
function computeGroupNames(
  dept: DepartmentRow,
  parent: DepartmentRow | null,
): { rw: string; ro: string } {
  if (dept.kind === "TEAM") {
    if (!parent) {
      throw new Error(
        `department ${dept.id} is kind=TEAM but has no parent row`,
      );
    }
    return {
      rw: `dept-${parent.slug}-${dept.slug}`,
      ro: `dept-${parent.slug}-${dept.slug}-ro`,
    };
  }
  return { rw: `dept-${dept.slug}`, ro: `dept-${dept.slug}-ro` };
}

/** FLAT mount point per the 2026-07-11 amendment — never nested. */
function computeMountPoint(dept: DepartmentRow, parent: DepartmentRow | null): string {
  if (dept.kind === "TEAM") {
    if (!parent) {
      throw new Error(
        `department ${dept.id} is kind=TEAM but has no parent row`,
      );
    }
    return `${parent.name} — ${dept.name}`;
  }
  return dept.name;
}

async function findExistingFolder(
  adminToken: string,
  mountPoint: string,
): Promise<GroupfolderInfo | null> {
  const folders = await gfListFolders(adminToken);
  return folders.find((f) => f.mountPoint === mountPoint) ?? null;
}

async function findExistingFolderId(
  adminToken: string,
  mountPoint: string,
): Promise<number | null> {
  const match = await findExistingFolder(adminToken, mountPoint);
  return match ? match.id : null;
}

/**
 * WARP-1557 — the desired NC shape of a DEPARTMENT/TEAM row, derived
 * ENTIRELY from Prisma. Nothing in here is read from Nextcloud; this is the
 * intent the writes below push, expressed as data so it can also be compared
 * against reality on the retry path.
 */
interface DepartmentIntent {
  rw: string;
  ro: string;
  mountPoint: string;
  /** null = unlimited / not managed by us; skipped in the comparison. */
  quotaBytes: number | null;
}

/**
 * WARP-1557 — does the folder ALREADY satisfy the Prisma-derived intent?
 *
 * ADR-029 BOUNDARY NOTE (read before widening this).
 *
 * ADR-029:47 and :181 make Nextcloud a write-only projection: "NC state is
 * never read back as truth (only `gfListFolders` for id discovery and
 * `oc:size`/quota-used for display)." This comparison sits right next to that
 * line, so the reasoning is spelled out rather than assumed:
 *
 *  1. Intent is NOT read from NC. Every field compared here — group names,
 *     masks, mount point, quota — is computed from the Prisma row by
 *     `computeGroupNames` / `computeMountPoint` / `Department.quotaBytes`.
 *     Nextcloud is never asked what the department should look like; it is
 *     only asked whether what Prisma already decided is present.
 *  2. The answer can only ever turn "not yet converged" into "converged". A
 *     mismatch falls straight through to the normal write path, so NC can
 *     never *prevent* a write, only make a redundant one unnecessary.
 *  3. It reuses `gfListFolders` — the exact call ADR-029 already carves out
 *     for id discovery, and one the provisioner makes on this code path
 *     anyway. The check therefore costs zero additional NC round-trips.
 *  4. It runs ONLY on the reconciler's failed-row retry sweep (see
 *     `provisionDepartment({ verifyOnFailure })`), never on first provision
 *     and never on the steady-state active-row drift pass. Those keep
 *     overwriting unconditionally, so the drift-overwrite guarantee in
 *     ADR-029 §3.6 is untouched.
 *
 * Without this, a row whose NC state already matches intent has no way to
 * observe that fact: the reconciler can only re-issue the write that is
 * failing, which is precisely why two departments on the .87 box logged
 * `departmentsSwept: 3, departmentsConverged: 0, departmentsStillFailed: 2`
 * every five minutes indefinitely while `occ groupfolders:list` showed both
 * folders fully and correctly provisioned.
 */
function folderMatchesIntent(
  folder: GroupfolderInfo,
  intent: DepartmentIntent,
): boolean {
  if (folder.groups[intent.rw] !== MASK_RW) return false;
  if (folder.groups[intent.ro] !== MASK_RO) return false;
  if (folder.groups[DROPLET_ADMINS_GROUP] !== MASK_ADMIN) return false;
  // Quota is only compared when the row actually declares one — an
  // unmanaged quota must not make an otherwise-converged folder look broken.
  if (intent.quotaBytes !== null && folder.quota !== intent.quotaBytes) {
    return false;
  }
  return true;
}

/** Options accepted by `provisionDepartment` / `archiveDepartment`. */
export interface ProvisionOptions {
  /**
   * WARP-1557 — retry-path-only convergence verification. Set by the
   * reconciler for rows that entered the sweep in a non-converged state
   * (`failed` / `provisioning`, and `archive_failed` / `archiving` on the
   * archive side). Two things switch on:
   *
   *   1. a pre-write check that skips the writes entirely when Nextcloud
   *      already matches the Prisma-derived intent (see
   *      `folderMatchesIntent` for the ADR-029 reasoning), and
   *   2. `confirmOnFailure` on every NC write, so a write that reports 5xx
   *      but actually landed is not treated as a failure.
   *
   * Deliberately OFF by default: first-provision and steady-state drift
   * passes keep the pre-WARP-1557 write-only behaviour.
   */
  verifyOnFailure?: boolean;
}

/**
 * Provision one department end to end: pending/failed → provisioning →
 * active. HOUSEHOLD rows skip every NC mutation and go straight to
 * active (the reconciler still attaches droplet-admins to them).
 *
 * Any NC failure parks the row in a failure state with a truncated
 * `provisionError` and returns — it never throws, so callers (the
 * reconciler's sweep loop) can process the rest of the batch.
 *
 * WARP-1557: WHICH failure state depends on whether the write outcome is
 * knowable. A 4xx rejection is unambiguous and lands in terminal `failed`. A
 * 5xx / timeout / transport error is ambiguous — the write may already have
 * taken effect — and lands in `provisioning`, which is the RE-VERIFY state:
 * non-terminal, swept down the same provision path next tick, and re-checked
 * against Nextcloud before anything is re-written. Parking an ambiguous
 * outcome in terminal `failed` is what made two departments on the .87 box
 * permanently invisible to their members.
 */
export async function provisionDepartment(
  prisma: PrismaClient,
  id: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const dept = (await prisma.department.findUnique({
    where: { id },
  })) as DepartmentRow | null;
  if (!dept) {
    logger.warn({ id }, "provisionDepartment: department not found");
    return;
  }

  await prisma.department.update({
    where: { id },
    data: { state: "provisioning" },
  });

  if (dept.kind === "HOUSEHOLD") {
    // WS-5 legacy group, adopted verbatim — zero NC mutation, ever.
    await prisma.department.update({
      where: { id },
      data: { state: "active", provisionError: null },
    });
    return;
  }

  const adminToken = adminBasicToken();
  // WARP-1557: retry path only — see ProvisionOptions.verifyOnFailure and
  // the ADR-029 boundary note on folderMatchesIntent.
  const writeOpts: GfWriteOptions = {
    confirmOnFailure: opts.verifyOnFailure === true,
  };

  try {
    const parent = dept.parentId
      ? ((await prisma.department.findUnique({
          where: { id: dept.parentId },
        })) as DepartmentRow | null)
      : null;

    const { rw, ro } = computeGroupNames(dept, parent);
    const mountPoint = computeMountPoint(dept, parent);
    const intent: DepartmentIntent = {
      rw,
      ro,
      mountPoint,
      quotaBytes:
        dept.quotaBytes !== null && dept.quotaBytes !== undefined
          ? Number(dept.quotaBytes)
          : null,
    };

    // 0. WARP-1557 — bounded convergence verification, RETRY PATH ONLY.
    //    Runs BEFORE any write (including ncEnsureGroup) on purpose: when
    //    Nextcloud is failing every write — the .87 box's WARP-1537 state —
    //    a check placed after the writes could never be reached, and the row
    //    could never converge no matter how correct Nextcloud actually was.
    //    Costs one gfListFolders, the same call step 2 makes anyway.
    if (opts.verifyOnFailure) {
      const existing = await findExistingFolder(adminToken, mountPoint);
      if (existing && folderMatchesIntent(existing, intent)) {
        await prisma.department.update({
          where: { id },
          data: {
            state: "active",
            provisionError: null,
            ncGroupRw: rw,
            ncGroupRo: ro,
            ncGroupfolderId: existing.id,
          },
        });
        logger.warn(
          { id, folderId: existing.id, mountPoint },
          "WARP-1557: department already matched intent in Nextcloud; converged without re-issuing writes",
        );
        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "folder-check",
          what: "Department converged (already provisioned)",
          sub: dept.name,
          refs: {
            departmentId: dept.id,
            kind: dept.kind,
            mountPoint,
            folderId: existing.id,
            verified: true,
          },
          actor: { type: "system" },
        });
        return;
      }
    }

    // 1. Ensure the three NC groups exist (idempotent).
    await ncEnsureGroup(rw);
    await ncEnsureGroup(ro);
    await ncEnsureGroup(DROPLET_ADMINS_GROUP);

    // 2. Groupfolder — deduped by existing mount point. Mutual idempotency
    //    with docker/nextcloud-init.sh, which may have already created the
    //    Household folder (kind=HOUSEHOLD never reaches this branch, but a
    //    hand-created folder with a colliding name is still possible).
    let folderId = await findExistingFolderId(adminToken, mountPoint);
    if (folderId === null) {
      folderId = await gfCreateFolder(adminToken, mountPoint, writeOpts);
    }

    // 3. Groups + masks on the folder.
    await gfAddGroup(adminToken, folderId, rw, writeOpts);
    await gfSetGroupPermissions(adminToken, folderId, rw, MASK_RW, writeOpts);
    await gfAddGroup(adminToken, folderId, ro, writeOpts);
    await gfSetGroupPermissions(adminToken, folderId, ro, MASK_RO, writeOpts);
    await gfAddGroup(adminToken, folderId, DROPLET_ADMINS_GROUP, writeOpts);
    await gfSetGroupPermissions(
      adminToken,
      folderId,
      DROPLET_ADMINS_GROUP,
      MASK_ADMIN,
      writeOpts,
    );

    // 4. Quota, when set.
    if (intent.quotaBytes !== null) {
      await gfSetQuota(adminToken, folderId, intent.quotaBytes, writeOpts);
    }

    await prisma.department.update({
      where: { id },
      data: {
        state: "active",
        provisionError: null,
        ncGroupRw: rw,
        ncGroupRo: ro,
        ncGroupfolderId: folderId,
      },
    });

    await recordActivity({
      kind: "system",
      severity: "ok",
      sourceIcon: "folder-check",
      what: "Department provisioned",
      sub: dept.name,
      refs: { departmentId: dept.id, kind: dept.kind, mountPoint, folderId },
      actor: { type: "system" },
    });
  } catch (err) {
    const message = truncateError(err);
    // WARP-1557: "write rejected" vs "write may have landed".
    const ambiguous = isAmbiguousWriteFailure(err);
    const nextState = ambiguous ? "provisioning" : "failed";
    logger.error(
      { err, id, ambiguous, nextState },
      "provisionDepartment failed",
    );
    await prisma.department.update({
      where: { id },
      data: { state: nextState, provisionError: message },
    });
    await recordActivity({
      kind: "system",
      severity: "err",
      sourceIcon: "folder-x",
      what: ambiguous
        ? "Department provisioning unconfirmed (will re-verify)"
        : "Department provisioning failed",
      sub: dept.name,
      refs: {
        departmentId: dept.id,
        kind: dept.kind,
        error: message,
        ambiguous,
      },
      actor: { type: "system" },
    });
  }
}

/**
 * Archive a department: detach the rw/ro member groups (droplet-admins
 * stays, per the brief's grace-window/retrieval contract), then delete
 * the groupfolder outright — this function IS the explicit "archiving"
 * caller the reconciler's never-delete-outside-archiving invariant
 * refers to.
 *
 * HOUSEHOLD rows are never archived via this path (no route/reconciler
 * sweep ever puts a HOUSEHOLD row into `archiving`); if one somehow
 * arrives here we still skip NC mutation for consistency with
 * `provisionDepartment` and just flip the state.
 */
export async function archiveDepartment(
  prisma: PrismaClient,
  id: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const dept = (await prisma.department.findUnique({
    where: { id },
  })) as DepartmentRow | null;
  if (!dept) {
    logger.warn({ id }, "archiveDepartment: department not found");
    return;
  }

  await prisma.department.update({
    where: { id },
    data: { state: "archiving" },
  });

  if (dept.kind === "HOUSEHOLD") {
    await prisma.department.update({
      where: { id },
      data: { state: "archived", archivedAt: new Date() },
    });
    return;
  }

  const adminToken = adminBasicToken();
  // WARP-1557: retry path only, same gating as provisionDepartment.
  const writeOpts: GfWriteOptions = {
    confirmOnFailure: opts.verifyOnFailure === true,
  };

  try {
    if (dept.ncGroupfolderId !== null) {
      if (dept.ncGroupRw) {
        await gfRemoveGroup(
          adminToken,
          dept.ncGroupfolderId,
          dept.ncGroupRw,
          writeOpts,
        );
      }
      if (dept.ncGroupRo) {
        await gfRemoveGroup(
          adminToken,
          dept.ncGroupfolderId,
          dept.ncGroupRo,
          writeOpts,
        );
      }
      // droplet-admins is intentionally left attached — retrieval window.
      await gfDeleteFolder(adminToken, dept.ncGroupfolderId, writeOpts);
    }

    await prisma.department.update({
      where: { id },
      data: {
        state: "archived",
        archivedAt: new Date(),
        provisionError: null,
      },
    });

    await recordActivity({
      kind: "system",
      severity: "ok",
      sourceIcon: "archive",
      what: "Department archived",
      sub: dept.name,
      refs: { departmentId: dept.id, kind: dept.kind },
      actor: { type: "system" },
    });
  } catch (err) {
    const message = truncateError(err);
    // WARP-1557: same "rejected vs may-have-landed" split as the provision
    // path. Both target states stay on the ARCHIVE side of the routing —
    // `archiving` is the archive path's re-verify state, `archive_failed` its
    // terminal one — so an ambiguous outcome can never leak into the
    // provision path and silently un-archive the department.
    const ambiguous = isAmbiguousWriteFailure(err);
    // WARP-1257: `archive_failed` (NOT the generic `failed`) so the reconciler
    // retries this row down the ARCHIVE path on its next sweep. A transient NC
    // error partway through an archive must never be re-provisioned back to
    // active — that would silently un-archive the department and restore its
    // rw/ro group access. Intent is carried in the state, never re-derived.
    const nextState = ambiguous ? "archiving" : "archive_failed";
    logger.error(
      { err, id, ambiguous, nextState },
      "archiveDepartment failed",
    );
    await prisma.department.update({
      where: { id },
      data: { state: nextState, provisionError: message },
    });
    await recordActivity({
      kind: "system",
      severity: "err",
      sourceIcon: "archive",
      what: ambiguous
        ? "Department archival unconfirmed (will re-verify)"
        : "Department archival failed",
      sub: dept.name,
      refs: {
        departmentId: dept.id,
        kind: dept.kind,
        error: message,
        ambiguous,
      },
      actor: { type: "system" },
    });
  }
}

export const _internal = {
  computeGroupNames,
  computeMountPoint,
  findExistingFolder,
  findExistingFolderId,
  folderMatchesIntent,
  truncateError,
};
