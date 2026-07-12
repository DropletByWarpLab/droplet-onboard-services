/**
 * WARP-1257 (T5) — department reconciler.
 *
 * Bounded, idempotent convergence sweep (no `while True` — this module
 * exports a single `reconcileDepartments()` tick; scheduling lives in
 * `cron-runtime.service.ts` per `index.ts`, boot run + every 5 minutes).
 *
 * Prisma is truth. NC state is never read back as authorization truth —
 * `gfListFolders` is consulted only for groupfolder-id discovery (the id
 * gets reassigned on NC reinstall; UUID-keyed Department rows survive
 * that, the cached `ncGroupfolderId` doesn't).
 *
 * Two independent sweeps per tick:
 *   1. Department state machine — pending/provisioning/failed rows are
 *      (re)provisioned; archiving rows are (re)archived; every ACTIVE
 *      DEPARTMENT/TEAM row is re-converged (drift overwrite + the
 *      droplet-admins-on-every-active-folder invariant). `archived`,
 *      and HOUSEHOLD rows outside `archiving`, are left alone.
 *   2. Membership state machine — pending/failed memberships are pushed
 *      to their target NC group; `removing` memberships are pulled from
 *      both groups and then their row is deleted.
 *
 * `gfDeleteFolder` is called from exactly one place in this whole
 * service: the `archiving` branch of `reconcileDepartmentRow`. No other
 * code path in this module (or in `department-provisioner.service.ts`'s
 * `provisionDepartment`) ever calls it — that is the never-delete-
 * outside-archiving invariant the brief requires.
 */
import type { PrismaClient } from "@prisma/client";
import {
  provisionDepartment,
  archiveDepartment,
  adminBasicToken,
  DROPLET_ADMINS_GROUP,
  MASK_RW,
  MASK_RO,
  MASK_ADMIN,
} from "./department-provisioner.service.js";
import {
  gfListFolders,
  gfAddGroup,
  gfSetGroupPermissions,
  ncAddUserToGroup,
  ncRemoveUserFromGroup,
} from "./nextcloud-groups.client.js";
import { recordActivity } from "./activity.singleton.js";
import { sweepUsagePolicies } from "./usage-policy-reconciler.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("department-reconciler");

// WARP-1257: `failed` and `archive_failed` are BOTH swept, but they carry
// different original intent — `failed` retries down the provision path,
// `archive_failed` down the archive path (see reconcileDepartmentRow routing).
const DEPARTMENT_SWEEP_STATES = [
  "pending",
  "provisioning",
  "failed",
  "archiving",
  "archive_failed",
] as const;

// WARP-1257: `failed` and `remove_failed` are BOTH swept — `failed` retries
// down the sync path, `remove_failed` down the removal path.
const MEMBERSHIP_SWEEP_STATES = [
  "pending",
  "failed",
  "removing",
  "remove_failed",
] as const;

export interface ReconcileResult {
  departmentsSwept: number;
  departmentsConverged: number;
  departmentsStillFailed: number;
  membershipsSwept: number;
  membershipsSynced: number;
  membershipsFailed: number;
  membershipsRemoved: number;
  // WARP-1271 (T19a): per-user usage-policy quota pushdown, swept on the
  // same tick — see usage-policy-reconciler.service.ts.
  usagePoliciesSwept: number;
  usagePoliciesSynced: number;
  usagePoliciesFailed: number;
}

/**
 * Re-attach `droplet-admins` at MASK_ADMIN on a folder — the invariant
 * every active groupfolder (department, team, and household alike) must
 * hold. Idempotent: `gfAddGroup` + `gfSetGroupPermissions` both no-op
 * cleanly when the group is already assigned at the target mask.
 */
async function ensureAdminsAttached(
  adminToken: string,
  folderId: number,
): Promise<void> {
  await gfAddGroup(adminToken, folderId, DROPLET_ADMINS_GROUP);
  await gfSetGroupPermissions(
    adminToken,
    folderId,
    DROPLET_ADMINS_GROUP,
    MASK_ADMIN,
  );
}

/**
 * Re-converge one ACTIVE DEPARTMENT/TEAM row: re-run provisionDepartment
 * (which is idempotent end to end — ensure-group, find-or-create-folder,
 * set masks, set quota) so out-of-band NC edits get overwritten back to
 * the Prisma-desired state, and so a stale `ncGroupfolderId` left over
 * from an NC reinstall gets re-discovered by mount point.
 */
async function reconcileActiveDepartment(
  prisma: PrismaClient,
  id: string,
): Promise<boolean> {
  await provisionDepartment(prisma, id);
  const row = await prisma.department.findUnique({ where: { id } });
  return row?.state === "active";
}

/**
 * Re-attach droplet-admins to an ACTIVE HOUSEHOLD row's folder, when one
 * is known. Household groupfolder creation is out of this ticket's scope
 * (T11 absorption seed) — if `ncGroupfolderId` hasn't been populated yet
 * this is a clean no-op, not a failure.
 */
async function reconcileActiveHousehold(
  adminToken: string,
  folderId: number | null,
): Promise<void> {
  if (folderId === null) return;
  await ensureAdminsAttached(adminToken, folderId);
}

interface DepartmentSweepRow {
  id: string;
  name: string;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  state: string;
  ncGroupfolderId: number | null;
}

async function sweepDepartments(
  prisma: PrismaClient,
  adminToken: string,
): Promise<{ swept: number; converged: number; stillFailed: number }> {
  const rows = (await prisma.department.findMany({
    where: { state: { in: [...DEPARTMENT_SWEEP_STATES] } },
    select: { id: true, name: true, kind: true, state: true, ncGroupfolderId: true },
  })) as DepartmentSweepRow[];

  // Every currently-active DEPARTMENT/TEAM/HOUSEHOLD row also gets a
  // convergence pass — this is where drift overwrite + the
  // droplet-admins invariant get maintained on the steady-state happy
  // path, not just on error retry.
  const activeRows = (await prisma.department.findMany({
    where: { state: "active" },
    select: { id: true, name: true, kind: true, state: true, ncGroupfolderId: true },
  })) as DepartmentSweepRow[];

  let converged = 0;
  let stillFailed = 0;

  for (const row of rows) {
    // WARP-1257: route on ORIGINAL intent. `archiving` and its failure state
    // `archive_failed` retry down the archive path; `pending`/`provisioning`/
    // `failed` funnel through the idempotent provision path. Never re-provision
    // a row whose operator intent was archival just because a transient NC error
    // parked it in a failure state — that silently un-archives the department.
    if (row.state === "archiving" || row.state === "archive_failed") {
      await archiveDepartment(prisma, row.id);
    } else {
      await provisionDepartment(prisma, row.id);
    }

    const after = await prisma.department.findUnique({
      where: { id: row.id },
      select: { state: true },
    });

    if (after?.state === "active" || after?.state === "archived") {
      converged += 1;
      await recordActivity({
        kind: "system",
        severity: "ok",
        sourceIcon: "refresh-cw",
        what: "Department reconciled",
        sub: row.name,
        refs: { departmentId: row.id, fromState: row.state, toState: after.state },
        actor: { type: "system" },
      });
    } else if (after?.state === "failed" || after?.state === "archive_failed") {
      stillFailed += 1;
      // A row that entered this sweep already in a failure state (provision
      // `failed` or archive `archive_failed`) and is STILL failed after a retry
      // attempt is "stuck" — surface an alert ActivityRow distinct from the
      // per-attempt failure row provisionDepartment/archiveDepartment emitted.
      if (row.state === "failed" || row.state === "archive_failed") {
        await recordActivity({
          kind: "system",
          severity: "err",
          sourceIcon: "alert-triangle",
          what: "Department stuck in failed state",
          sub: row.name,
          refs: { departmentId: row.id },
          actor: { type: "system" },
        });
      }
    }
  }

  for (const row of activeRows) {
    try {
      if (row.kind === "HOUSEHOLD") {
        await reconcileActiveHousehold(adminToken, row.ncGroupfolderId);
      } else {
        const ok = await reconcileActiveDepartment(prisma, row.id);
        if (!ok) stillFailed += 1;
      }
    } catch (err) {
      logger.error({ err, id: row.id }, "active-department reconcile pass failed");
    }
  }

  return {
    swept: rows.length + activeRows.length,
    converged,
    stillFailed,
  };
}

interface MembershipSweepRow {
  id: string;
  departmentId: string;
  userId: string;
  right: "reader" | "contributor" | "manager";
  syncState: string;
}

interface DepartmentMembershipTargetRow {
  id: string;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  state: string;
  ncGroupRw: string | null;
  ncGroupRo: string | null;
}

async function sweepMemberships(
  prisma: PrismaClient,
  adminToken: string,
): Promise<{ swept: number; synced: number; failed: number; removed: number }> {
  const rows = (await prisma.departmentMembership.findMany({
    where: { syncState: { in: [...MEMBERSHIP_SWEEP_STATES] } },
    select: { id: true, departmentId: true, userId: true, right: true, syncState: true },
  })) as MembershipSweepRow[];

  let synced = 0;
  let failed = 0;
  let removed = 0;

  for (const row of rows) {
    // WARP-1257: capture the ORIGINAL intent from the row's syncState BEFORE
    // any NC call, so the per-row catch below can re-mark a failure down the
    // path it actually came from. `removing` and its failure state
    // `remove_failed` are BOTH removal intent; `pending`/`failed` are sync
    // intent. A partial removal failure must never be re-synced (which would
    // silently re-grant the revoked access) — intent lives in the state.
    const isRemoval =
      row.syncState === "removing" || row.syncState === "remove_failed";
    try {
      const dept = (await prisma.department.findUnique({
        where: { id: row.departmentId },
        select: { id: true, kind: true, state: true, ncGroupRw: true, ncGroupRo: true },
      })) as DepartmentMembershipTargetRow | null;

      if (!dept) {
        // Parent department vanished — the FK's onDelete: Cascade should
        // have already removed this row, but guard defensively.
        continue;
      }

      // D-5 (brief §7.3): household rights convergence is explicit
      // post-GA — leave household memberships exactly as they are.
      if (dept.kind === "HOUSEHOLD") continue;

      if (isRemoval) {
        if (dept.ncGroupRw || dept.ncGroupRo) {
          const user = await prisma.user.findUnique({
            where: { id: row.userId },
            select: { nextcloudUsername: true },
          });
          const ncUsername = user?.nextcloudUsername ?? null;
          if (ncUsername) {
            if (dept.ncGroupRw) {
              await ncRemoveUserFromGroup(adminToken, ncUsername, dept.ncGroupRw);
            }
            if (dept.ncGroupRo) {
              await ncRemoveUserFromGroup(adminToken, ncUsername, dept.ncGroupRo);
            }
          }
        }
        await prisma.departmentMembership.delete({ where: { id: row.id } });
        removed += 1;
        continue;
      }

      // Sync intent (pending / failed) → push toward the target group for
      // `right`. (Removal intent already returned above.)
      if (dept.state !== "active" || !dept.ncGroupRw || !dept.ncGroupRo) {
        // Department itself isn't converged yet — retry next tick, once
        // the department sweep above (or a future tick) lands it active.
        await prisma.departmentMembership.update({
          where: { id: row.id },
          data: {
            syncState: "failed",
            syncError: "department not active yet",
          },
        });
        failed += 1;
        continue;
      }

      const user = await prisma.user.findUnique({
        where: { id: row.userId },
        select: { nextcloudUsername: true },
      });
      const ncUsername = user?.nextcloudUsername ?? null;
      if (!ncUsername) {
        await prisma.departmentMembership.update({
          where: { id: row.id },
          data: {
            syncState: "failed",
            syncError: "user has no Nextcloud account provisioned yet",
          },
        });
        failed += 1;
        continue;
      }

      const isReader = row.right === "reader";
      const targetGroup = isReader ? dept.ncGroupRo : dept.ncGroupRw;
      const otherGroup = isReader ? dept.ncGroupRw : dept.ncGroupRo;
      const targetMask = isReader ? MASK_RO : MASK_RW;

      // Add-then-remove: momentarily over-permissive rather than
      // under-permissive during a rights transition, matching the
      // "upgrade" ordering in the brief §4 (the background reconciler
      // is a backstop for drift, not the hot revocation path — that
      // ordering lives in the membership routes themselves).
      await ncAddUserToGroup(adminToken, ncUsername, targetGroup);
      await ncRemoveUserFromGroup(adminToken, ncUsername, otherGroup);

      await prisma.departmentMembership.update({
        where: { id: row.id },
        data: {
          syncState: "synced",
          syncError: null,
          ncPermissionMask: targetMask,
        },
      });
      synced += 1;

      await recordActivity({
        kind: "system",
        severity: "ok",
        sourceIcon: "user-check",
        what: "Department membership synced",
        sub: `${ncUsername} · ${row.right}`,
        refs: { departmentId: dept.id, membershipId: row.id, right: row.right },
        actor: { type: "system" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, id: row.id }, "membership reconcile failed");
      try {
        await prisma.departmentMembership.update({
          where: { id: row.id },
          // WARP-1257: preserve intent across the failure. A removal that
          // failed partway is parked in `remove_failed` (retried down the
          // removal path next tick), NOT the generic `failed` the sync path
          // would pick up and re-add the user with.
          data: {
            syncState: isRemoval ? "remove_failed" : "failed",
            syncError: message.slice(0, 1024),
          },
        });
      } catch (updateErr) {
        // Row may have been deleted concurrently (e.g. cascaded delete
        // from a department archive) — non-fatal, next tick sees nothing.
        logger.warn(
          { err: updateErr, id: row.id },
          "failed to mark membership failed after reconcile error",
        );
      }
      failed += 1;
    }
  }

  return { swept: rows.length, synced, failed, removed };
}

/**
 * Run one convergence tick. Never throws — every per-row failure is
 * caught, logged, and reflected in the row's own state/syncState so the
 * next tick retries; a Prisma-connectivity-level failure at the
 * `findMany` level is the one case that propagates (there is nothing
 * useful to converge without a DB), matching cron-runtime's `safeRun`
 * canary contract (guest-expiry-sweep, camera-retention-purge follow the
 * same posture).
 */
export async function reconcileDepartments(
  prisma: PrismaClient,
): Promise<ReconcileResult> {
  const adminToken = adminBasicToken();

  const deptResult = await sweepDepartments(prisma, adminToken);
  const memberResult = await sweepMemberships(prisma, adminToken);
  const usageResult = await sweepUsagePolicies(prisma, adminToken);

  const result: ReconcileResult = {
    departmentsSwept: deptResult.swept,
    departmentsConverged: deptResult.converged,
    departmentsStillFailed: deptResult.stillFailed,
    membershipsSwept: memberResult.swept,
    membershipsSynced: memberResult.synced,
    membershipsFailed: memberResult.failed,
    membershipsRemoved: memberResult.removed,
    usagePoliciesSwept: usageResult.usagePoliciesSwept,
    usagePoliciesSynced: usageResult.usagePoliciesSynced,
    usagePoliciesFailed: usageResult.usagePoliciesFailed,
  };

  logger.debug(result, "department-reconciler tick complete");
  return result;
}

// ── Post-mutation trigger ──

let debounceTimer: NodeJS.Timeout | null = null;
let boundPrisma: PrismaClient | null = null;
const KICK_DEBOUNCE_MS = 2_000;

/**
 * Bind the Prisma client `kickReconcile()` uses. Called once at boot
 * alongside the cron wiring; safe to call again in tests.
 */
export function initReconcileKick(prisma: PrismaClient): void {
  boundPrisma = prisma;
}

/**
 * Debounced post-mutation trigger. Route handlers that create/update a
 * department or membership call this after their write commits so the
 * user doesn't wait a full 5-minute cron cycle for convergence to start.
 * Multiple calls within `KICK_DEBOUNCE_MS` collapse into a single tick.
 * A no-op before `initReconcileKick` has run (e.g. import order in
 * tests) or once the bound client is torn down.
 */
export function kickReconcile(): void {
  if (!boundPrisma) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  const prisma = boundPrisma;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    reconcileDepartments(prisma).catch((err) => {
      logger.error({ err }, "kickReconcile: reconcile tick failed");
    });
  }, KICK_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

/** Exposed only for tests — clears any pending debounced kick. */
export function _resetReconcileKickForTests(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  boundPrisma = null;
}
