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

async function findExistingFolderId(
  adminToken: string,
  mountPoint: string,
): Promise<number | null> {
  const folders = await gfListFolders(adminToken);
  const match = folders.find((f) => f.mountPoint === mountPoint);
  return match ? match.id : null;
}

/**
 * Provision one department end to end: pending/failed → provisioning →
 * active. HOUSEHOLD rows skip every NC mutation and go straight to
 * active (the reconciler still attaches droplet-admins to them).
 *
 * Any NC failure flips the row to `failed` with a truncated
 * `provisionError` and returns — it never throws, so callers (the
 * reconciler's sweep loop) can process the rest of the batch.
 */
export async function provisionDepartment(
  prisma: PrismaClient,
  id: string,
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

  try {
    const parent = dept.parentId
      ? ((await prisma.department.findUnique({
          where: { id: dept.parentId },
        })) as DepartmentRow | null)
      : null;

    const { rw, ro } = computeGroupNames(dept, parent);
    const mountPoint = computeMountPoint(dept, parent);

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
      folderId = await gfCreateFolder(adminToken, mountPoint);
    }

    // 3. Groups + masks on the folder.
    await gfAddGroup(adminToken, folderId, rw);
    await gfSetGroupPermissions(adminToken, folderId, rw, MASK_RW);
    await gfAddGroup(adminToken, folderId, ro);
    await gfSetGroupPermissions(adminToken, folderId, ro, MASK_RO);
    await gfAddGroup(adminToken, folderId, DROPLET_ADMINS_GROUP);
    await gfSetGroupPermissions(
      adminToken,
      folderId,
      DROPLET_ADMINS_GROUP,
      MASK_ADMIN,
    );

    // 4. Quota, when set.
    if (dept.quotaBytes !== null && dept.quotaBytes !== undefined) {
      await gfSetQuota(adminToken, folderId, Number(dept.quotaBytes));
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
    logger.error({ err, id }, "provisionDepartment failed");
    await prisma.department.update({
      where: { id },
      data: { state: "failed", provisionError: message },
    });
    await recordActivity({
      kind: "system",
      severity: "err",
      sourceIcon: "folder-x",
      what: "Department provisioning failed",
      sub: dept.name,
      refs: { departmentId: dept.id, kind: dept.kind, error: message },
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

  try {
    if (dept.ncGroupfolderId !== null) {
      if (dept.ncGroupRw) {
        await gfRemoveGroup(adminToken, dept.ncGroupfolderId, dept.ncGroupRw);
      }
      if (dept.ncGroupRo) {
        await gfRemoveGroup(adminToken, dept.ncGroupfolderId, dept.ncGroupRo);
      }
      // droplet-admins is intentionally left attached — retrieval window.
      await gfDeleteFolder(adminToken, dept.ncGroupfolderId);
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
    logger.error({ err, id }, "archiveDepartment failed");
    await prisma.department.update({
      where: { id },
      data: { state: "failed", provisionError: message },
    });
    await recordActivity({
      kind: "system",
      severity: "err",
      sourceIcon: "archive",
      what: "Department archival failed",
      sub: dept.name,
      refs: { departmentId: dept.id, kind: dept.kind, error: message },
      actor: { type: "system" },
    });
  }
}

export const _internal = {
  computeGroupNames,
  computeMountPoint,
  findExistingFolderId,
  truncateError,
};
