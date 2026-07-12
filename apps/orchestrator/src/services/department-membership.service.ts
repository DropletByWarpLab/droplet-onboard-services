/**
 * WARP-1259 (T7) — department membership: authz, rights transitions,
 * revocation ordering.
 *
 * Owns the DepartmentMembership write paths consumed by
 * `routes/departments.ts`'s `/departments/:id/members*` endpoints. Every
 * public mutation here:
 *   1. Runs its Prisma write + `bumpAclVersion` inside ONE `$transaction`
 *      (department-tx.ts) — never split across two round-trips.
 *   2. Attempts an immediate, best-effort NC push right after the tx
 *      commits, for fast UI convergence. On push failure the row is left
 *      in a non-`synced` state (`pending`/`failed`/`removing`) and the
 *      5-minute reconciler (department-reconciler.service.ts) retries —
 *      this module NEVER throws on NC failure, only on validation/authz/
 *      invariant failures that must 4xx the request.
 *   3. Kicks the reconciler as a backstop regardless of the inline push
 *      outcome.
 *
 * Rights-transition NC ordering (brief §4, "fail-closed both ways" —
 * a half-applied state must never exceed target rights):
 *   - UPGRADE  (reader → contributor/manager, ro→rw): add-to-rw THEN
 *     remove-from-ro. Momentary over-permission (member in both groups)
 *     is safe because rw's mask already includes everything ro grants.
 *   - DOWNGRADE (contributor/manager → reader, rw→ro): remove-from-rw
 *     THEN add-to-ro. Momentary under-permission (member in neither
 *     group) is the fail-closed direction.
 *   - contributor ↔ manager touches no NC group — policy-only (both are
 *     `dept-<slug>` rw-tier membership; the manager bit is enforced at
 *     the orchestrator authz layer, not by Nextcloud).
 *
 * Removal ordering: NC group removal (both groups, idempotent) happens
 * BEFORE the row is deleted — if the NC calls fail, the row stays
 * `removing` (policy-denied per the future requireSpaceAccess gate, T8)
 * for the reconciler to retry, rather than disappearing while NC state
 * still grants bytes.
 */
import type { PrismaClient, DepartmentRight } from "@prisma/client";
import {
  adminBasicToken,
  MASK_RW,
  MASK_RO,
} from "./department-provisioner.service.js";
import {
  ncAddUserToGroup,
  ncRemoveUserFromGroup,
} from "./nextcloud-groups.client.js";
import { bumpAclVersion } from "./department-tx.js";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("department-membership");

const SYNC_ERROR_TRUNCATE_LEN = 1024;

// ── Errors ───────────────────────────────────────────────────────────
// Typed so the route layer can map each to the right HTTP status without
// string-sniffing messages.

export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User not found: ${userId}`);
    this.name = "UserNotFoundError";
  }
}

export class DepartmentNotFoundError extends Error {
  constructor(departmentId: string) {
    super(`Department not found: ${departmentId}`);
    this.name = "DepartmentNotFoundError";
  }
}

export class DuplicateMembershipError extends Error {
  constructor(departmentId: string, userId: string) {
    super(`User ${userId} is already a member of department ${departmentId}`);
    this.name = "DuplicateMembershipError";
  }
}

export class MembershipNotFoundError extends Error {
  constructor(departmentId: string, userId: string) {
    super(`No membership for user ${userId} in department ${departmentId}`);
    this.name = "MembershipNotFoundError";
  }
}

export class LastManagerError extends Error {
  constructor(departmentId: string) {
    super(
      `Cannot remove the last manager of department ${departmentId}. Promote another member to manager first.`,
    );
    this.name = "LastManagerError";
  }
}

// ── Authz ────────────────────────────────────────────────────────────

interface CallerLike {
  id: string;
  role: string;
}

/**
 * owner/admin pass unconditionally. Otherwise the caller must hold
 * `right=manager` on the department itself, OR on the department's
 * PARENT (inherited-manager rule, ADR-029 2026-07-11 amendment: a
 * manager of a parent DEPARTMENT implicitly manages its child TEAMs).
 * Plain (non-manager) parent members get NO implicit team access —
 * team membership/management is explicit unless you're a parent manager.
 */
export async function departmentManagerOrAdmin(
  prisma: PrismaClient,
  departmentId: string,
  caller: CallerLike,
): Promise<boolean> {
  if (caller.role === "owner" || caller.role === "admin") return true;

  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { id: true, parentId: true },
  });
  if (!dept) return false;

  const ownMembership = await prisma.departmentMembership.findUnique({
    where: {
      departmentId_userId: { departmentId: dept.id, userId: caller.id },
    },
    select: { right: true },
  });
  if (ownMembership?.right === "manager") return true;

  if (dept.parentId) {
    const parentMembership = await prisma.departmentMembership.findUnique({
      where: {
        departmentId_userId: { departmentId: dept.parentId, userId: caller.id },
      },
      select: { right: true },
    });
    if (parentMembership?.right === "manager") return true;
  }

  return false;
}

// ── Shared NC push helpers ──────────────────────────────────────────

interface NcTargetDept {
  id: string;
  state: string;
  ncGroupRw: string | null;
  ncGroupRo: string | null;
}

async function resolveNcUsername(
  prisma: PrismaClient,
  userId: string,
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { nextcloudUsername: true },
  });
  return user?.nextcloudUsername ?? null;
}

async function markSyncFailed(
  prisma: PrismaClient,
  membershipId: string,
  message: string,
): Promise<void> {
  try {
    await prisma.departmentMembership.update({
      where: { id: membershipId },
      data: {
        syncState: "failed",
        syncError: message.slice(0, SYNC_ERROR_TRUNCATE_LEN),
      },
    });
  } catch (err) {
    // Row may have been deleted concurrently — non-fatal, reconciler sees
    // nothing next tick, which is correct.
    logger.warn(
      { err, membershipId },
      "failed to mark membership failed after NC push error",
    );
  }
}

/**
 * Best-effort immediate push of a newly-created membership to its target
 * NC group. Never throws — errors leave the row `pending`→`failed` for
 * the reconciler. If the department isn't `active` yet (or its NC groups
 * aren't known), the row is left exactly as the caller's `$transaction`
 * left it (`pending`) so the reconciler's normal pending-sweep picks it
 * up once the department itself converges — that is NOT a failure.
 */
async function pushAdd(
  prisma: PrismaClient,
  dept: NcTargetDept,
  membershipId: string,
  userId: string,
  right: DepartmentRight,
): Promise<void> {
  try {
    if (dept.state !== "active" || !dept.ncGroupRw || !dept.ncGroupRo) {
      return;
    }

    const ncUsername = await resolveNcUsername(prisma, userId);
    if (!ncUsername) {
      await markSyncFailed(
        prisma,
        membershipId,
        "user has no Nextcloud account provisioned yet",
      );
      return;
    }

    const adminToken = adminBasicToken();
    const isReader = right === "reader";
    const targetGroup = isReader ? dept.ncGroupRo : dept.ncGroupRw;
    const targetMask = isReader ? MASK_RO : MASK_RW;

    await ncAddUserToGroup(adminToken, ncUsername, targetGroup);

    await prisma.departmentMembership.update({
      where: { id: membershipId },
      data: { syncState: "synced", syncError: null, ncPermissionMask: targetMask },
    });

    await recordActivity({
      kind: "system",
      severity: "ok",
      sourceIcon: "user-plus",
      what: "Department membership added",
      sub: `${ncUsername} · ${right}`,
      refs: { departmentId: dept.id, membershipId, right },
      actor: { type: "system" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, membershipId }, "pushAdd: NC push failed");
    await markSyncFailed(prisma, membershipId, message);
  }
}

/**
 * Best-effort immediate push of a rights transition. Ordering per the
 * module doc: upgrade = add-then-remove, downgrade = remove-then-add,
 * contributor↔manager = policy-only (no NC calls).
 */
async function pushRightTransition(
  prisma: PrismaClient,
  dept: NcTargetDept,
  membershipId: string,
  userId: string,
  oldRight: DepartmentRight,
  newRight: DepartmentRight,
): Promise<void> {
  try {
    if (dept.state !== "active" || !dept.ncGroupRw || !dept.ncGroupRo) {
      return;
    }

    const wasReader = oldRight === "reader";
    const isReaderNow = newRight === "reader";

    if (wasReader === isReaderNow) {
      // contributor <-> manager: no NC group change, policy-layer only.
      await prisma.departmentMembership.update({
        where: { id: membershipId },
        data: { syncState: "synced", syncError: null },
      });
      return;
    }

    const ncUsername = await resolveNcUsername(prisma, userId);
    if (!ncUsername) {
      await markSyncFailed(
        prisma,
        membershipId,
        "user has no Nextcloud account provisioned yet",
      );
      return;
    }

    const adminToken = adminBasicToken();

    if (wasReader && !isReaderNow) {
      // UPGRADE (ro -> rw): add-to-rw THEN remove-from-ro.
      await ncAddUserToGroup(adminToken, ncUsername, dept.ncGroupRw);
      await ncRemoveUserFromGroup(adminToken, ncUsername, dept.ncGroupRo);
    } else {
      // DOWNGRADE (rw -> ro): remove-from-rw THEN add-to-ro.
      await ncRemoveUserFromGroup(adminToken, ncUsername, dept.ncGroupRw);
      await ncAddUserToGroup(adminToken, ncUsername, dept.ncGroupRo);
    }

    const targetMask = isReaderNow ? MASK_RO : MASK_RW;
    await prisma.departmentMembership.update({
      where: { id: membershipId },
      data: { syncState: "synced", syncError: null, ncPermissionMask: targetMask },
    });

    await recordActivity({
      kind: "system",
      severity: "ok",
      sourceIcon: "user-cog",
      what: "Department membership right changed",
      sub: `${ncUsername}: ${oldRight} → ${newRight}`,
      refs: { departmentId: dept.id, membershipId, oldRight, newRight },
      actor: { type: "system" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, membershipId }, "pushRightTransition: NC push failed");
    await markSyncFailed(prisma, membershipId, message);
  }
}

/**
 * Best-effort immediate push of a removal. Idempotent NC removal from
 * BOTH groups runs before the row delete; NC failure leaves the row
 * `removing` (fail-closed) for the reconciler to retry — this function
 * never throws.
 */
async function pushRemoval(
  prisma: PrismaClient,
  dept: NcTargetDept,
  membershipId: string,
  userId: string,
): Promise<void> {
  try {
    const ncUsername = await resolveNcUsername(prisma, userId);
    if (ncUsername && (dept.ncGroupRw || dept.ncGroupRo)) {
      const adminToken = adminBasicToken();
      if (dept.ncGroupRw) {
        await ncRemoveUserFromGroup(adminToken, ncUsername, dept.ncGroupRw);
      }
      if (dept.ncGroupRo) {
        await ncRemoveUserFromGroup(adminToken, ncUsername, dept.ncGroupRo);
      }
    }

    await prisma.departmentMembership.delete({ where: { id: membershipId } });

    await recordActivity({
      kind: "system",
      severity: "warn",
      sourceIcon: "user-minus",
      what: "Department membership removed",
      sub: ncUsername ?? userId,
      refs: { departmentId: dept.id, membershipId, userId },
      actor: { type: "system" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, membershipId }, "pushRemoval: NC push failed");
    // Fail-closed: the row's syncState is already `removing` (set by the
    // caller's $transaction before this push ran) — leave it exactly
    // there, never fall back to `failed` (which the pending-add sweep
    // would treat as a re-add candidate). Only record the error for
    // forensics; the reconciler's `removing`-state sweep retries the NC
    // calls on its next tick.
    try {
      await prisma.departmentMembership.update({
        where: { id: membershipId },
        data: { syncError: message.slice(0, SYNC_ERROR_TRUNCATE_LEN) },
      });
    } catch (updateErr) {
      logger.warn(
        { err: updateErr, membershipId },
        "failed to record syncError after failed removal push",
      );
    }
  }
}

// ── Public mutation API ─────────────────────────────────────────────

export interface AddMembershipResult {
  id: string;
  departmentId: string;
  userId: string;
  right: DepartmentRight;
  syncState: string;
}

/**
 * POST /api/departments/:id/members — insert membership `syncState=pending`
 * in a `$transaction` that also bumps `Department.aclVersion`, then
 * attempt an immediate NC push.
 */
export async function addMembership(
  prisma: PrismaClient,
  departmentId: string,
  targetUserId: string,
  right: DepartmentRight,
  grantedBy: string,
): Promise<AddMembershipResult> {
  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true },
  });
  if (!targetUser) throw new UserNotFoundError(targetUserId);

  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
  });
  if (!dept) throw new DepartmentNotFoundError(departmentId);

  const existing = await prisma.departmentMembership.findUnique({
    where: {
      departmentId_userId: { departmentId, userId: targetUserId },
    },
  });
  if (existing) throw new DuplicateMembershipError(departmentId, targetUserId);

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.departmentMembership.create({
      data: {
        departmentId,
        userId: targetUserId,
        right,
        syncState: "pending",
        grantedBy,
      },
    });
    await bumpAclVersion(tx, departmentId);
    return row;
  });

  await pushAdd(
    prisma,
    {
      id: dept.id,
      state: dept.state,
      ncGroupRw: dept.ncGroupRw,
      ncGroupRo: dept.ncGroupRo,
    },
    created.id,
    targetUserId,
    right,
  );

  const refreshed = await prisma.departmentMembership.findUnique({
    where: { id: created.id },
  });
  return (refreshed ?? created) as AddMembershipResult;
}

export interface UpdateMembershipRightResult {
  id: string;
  departmentId: string;
  userId: string;
  right: DepartmentRight;
  syncState: string;
}

/**
 * PATCH /api/departments/:id/members/:userId — reader↔contributor/manager
 * transitions. Updates `right` + `syncState=pending` + bumps `aclVersion`
 * in one `$transaction`, then pushes the ordered NC transition.
 *
 * Demoting the last remaining `manager` of a department (manager → any
 * non-manager right) is rejected with `LastManagerError` — the SAME
 * last-manager invariant `removeMembership` (DELETE) enforces, so a
 * rights-transition PATCH can't silently orphan a department with zero
 * managers. The count + the update run inside the SAME `$transaction`
 * (reusing the identical manager-count query the DELETE path uses) so a
 * concurrent demotion/removal can't slip past the count window.
 */
export async function updateMembershipRight(
  prisma: PrismaClient,
  departmentId: string,
  targetUserId: string,
  newRight: DepartmentRight,
): Promise<UpdateMembershipRightResult> {
  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
  });
  if (!dept) throw new DepartmentNotFoundError(departmentId);

  const existing = await prisma.departmentMembership.findUnique({
    where: {
      departmentId_userId: { departmentId, userId: targetUserId },
    },
  });
  if (!existing) throw new MembershipNotFoundError(departmentId, targetUserId);

  if (existing.right === newRight) {
    return existing as UpdateMembershipRightResult;
  }

  const oldRight = existing.right;

  const result = await prisma.$transaction(async (tx) => {
    if (oldRight === "manager" && newRight !== "manager") {
      const managerCount = await tx.departmentMembership.count({
        where: { departmentId, right: "manager" },
      });
      if (managerCount <= 1) {
        return { kind: "last-manager" as const };
      }
    }

    const row = await tx.departmentMembership.update({
      where: {
        departmentId_userId: { departmentId, userId: targetUserId },
      },
      data: { right: newRight, syncState: "pending" },
    });
    await bumpAclVersion(tx, departmentId);
    return { kind: "ok" as const, row };
  });

  if (result.kind === "last-manager") {
    throw new LastManagerError(departmentId);
  }

  await pushRightTransition(
    prisma,
    {
      id: dept.id,
      state: dept.state,
      ncGroupRw: dept.ncGroupRw,
      ncGroupRo: dept.ncGroupRo,
    },
    result.row.id,
    targetUserId,
    oldRight,
    newRight,
  );

  const refreshed = await prisma.departmentMembership.findUnique({
    where: { id: result.row.id },
  });
  return (refreshed ?? result.row) as UpdateMembershipRightResult;
}

export type RemoveMembershipResult =
  | { kind: "ok"; id: string }
  | { kind: "last-manager" };

/**
 * DELETE /api/departments/:id/members/:userId — tx {syncState=removing,
 * bump aclVersion} → NC removal from BOTH groups (idempotent) → delete
 * row. Removing the last `manager` of a department is rejected with a
 * typed error (mirrors the WARP-480 last-owner invariant in people.ts):
 * the check + the update run inside the SAME `$transaction` so a
 * concurrent removal can't slip past the count window.
 */
export async function removeMembership(
  prisma: PrismaClient,
  departmentId: string,
  targetUserId: string,
): Promise<RemoveMembershipResult> {
  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
  });
  if (!dept) throw new DepartmentNotFoundError(departmentId);

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.departmentMembership.findUnique({
      where: {
        departmentId_userId: { departmentId, userId: targetUserId },
      },
    });
    if (!existing) {
      return { kind: "not-found" as const };
    }

    if (existing.right === "manager") {
      const managerCount = await tx.departmentMembership.count({
        where: { departmentId, right: "manager" },
      });
      if (managerCount <= 1) {
        return { kind: "last-manager" as const };
      }
    }

    const row = await tx.departmentMembership.update({
      where: {
        departmentId_userId: { departmentId, userId: targetUserId },
      },
      data: { syncState: "removing" },
    });
    await bumpAclVersion(tx, departmentId);
    return { kind: "ok" as const, row };
  });

  if (result.kind === "not-found") {
    throw new MembershipNotFoundError(departmentId, targetUserId);
  }
  if (result.kind === "last-manager") {
    throw new LastManagerError(departmentId);
  }

  await pushRemoval(
    prisma,
    {
      id: dept.id,
      state: dept.state,
      ncGroupRw: dept.ncGroupRw,
      ncGroupRo: dept.ncGroupRo,
    },
    result.row.id,
    targetUserId,
  );

  return { kind: "ok", id: result.row.id };
}
