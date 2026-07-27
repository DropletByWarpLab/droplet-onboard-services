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
 * Four independent sweeps per tick:
 *   1. Department state machine — pending/provisioning/failed rows are
 *      (re)provisioned; archiving rows are (re)archived; every ACTIVE
 *      DEPARTMENT/TEAM row is re-converged (drift overwrite + the
 *      droplet-admins-on-every-active-folder invariant). `archived`,
 *      and HOUSEHOLD rows outside `archiving`, are left alone.
 *   2. Membership state machine — pending/failed memberships are pushed
 *      to their target NC group; `removing` memberships are pulled from
 *      both groups and then their row is deleted.
 *   3. WARP-1526 (rail 6): droplet-admins USER membership — stateless
 *      tier-vs-group drift correction. Expectation derived from
 *      `User.role` alone (owner∪admin with an NC mapping — no sync
 *      columns); ncListGroupMembersStrict is compared and corrected both
 *      ways,
 *      revocations first, each member contained on its own. Converges the
 *      best-effort cascade the role-change post-effects push
 *      (role-mutation-guard.service.ts) after an NC outage.
 *   4. WARP-1526 (pr-reviewer #1229 N1): directoryStatus → NC enable
 *      mirror — re-asserts `enabled=false` for locally DEACTIVATED rows,
 *      so a failed disable-mirror cannot leave a revoked person with live
 *      Nextcloud web/WebDAV access (that surface is proxied without
 *      orchestrator auth in front of it).
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
import { ncSetUserEnabled } from "./nextcloud.client.js";
import {
  gfListFolders,
  gfAddGroup,
  gfSetGroupPermissions,
  ncAddUserToGroup,
  ncRemoveUserFromGroup,
  ncListGroupMembersStrict,
} from "./nextcloud-groups.client.js";
import { recordActivity } from "./activity.singleton.js";
import { sweepUsagePolicies } from "./usage-policy-reconciler.service.js";
// WARP-1526: the operator tier the droplet-admins group tracks — single
// source in the role-mutation guard (no inlined {owner, admin} copies).
import { ADMIN_TIER_ROLES } from "./role-mutation-guard.service.js";
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
  // WARP-1531 (RBAC v2 T7): stateless AccessRole storage-default pushdown
  // for users without a person-level quota, same tick, no sync state —
  // see usage-policy-reconciler.service.ts pass 2.
  roleDefaultQuotasSwept: number;
  roleDefaultQuotasSynced: number;
  roleDefaultQuotasFailed: number;
  // WARP-1526 (rail 6): droplet-admins tier-vs-group drift corrections.
  adminGroupAdded: number;
  adminGroupRemoved: number;
  // pr-reviewer #1229 B4: per-member NC failures are counted, not swallowed
  // — a sweep that silently fails every tick must be visible in the log.
  adminGroupFailed: number;
  // pr-reviewer #1229 N1: DEACTIVATED rows re-asserted against Nextcloud.
  ncDisableMirrored: number;
  ncDisableMirrorFailed: number;
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
 * from an NC reinstall gets re-discovered by mount point. Returns the
 * refreshed rw/ro group names too, so the caller can run the group-
 * membership drift pass without a second round-trip.
 */
async function reconcileActiveDepartment(
  prisma: PrismaClient,
  id: string,
): Promise<{ active: boolean; ncGroupRw: string | null; ncGroupRo: string | null }> {
  await provisionDepartment(prisma, id);
  const row = await prisma.department.findUnique({
    where: { id },
    select: { state: true, ncGroupRw: true, ncGroupRo: true },
  });
  return {
    active: row?.state === "active",
    ncGroupRw: row?.ncGroupRw ?? null,
    ncGroupRo: row?.ncGroupRo ?? null,
  };
}

/**
 * Drift-overwrite for department/team NC group MEMBERSHIP (ADR-029 §3.6
 * bypass-path row "NC admin-UI out-of-band edits | Declared unsupported;
 * reconciler overwrites within ≤5 min"). `reconcileActiveDepartment`
 * above already re-converges the *group/folder/mask* shape; this closes
 * the matching gap for *who is IN* the rw/ro groups: a user hand-added to
 * `dept-<slug>` (or left behind by a bug) via the NC admin UI never gets
 * orchestrator policy access — `checkSpaceAccess` only ever reads Prisma
 * — but WOULD still get raw WebDAV/byte access through the groupfolder
 * mount until something removes them NC-side. Prisma (`synced`
 * memberships) is truth; anything `ncListGroupMembersStrict` reports that
 * isn't in the expected set gets removed.
 *
 * WARP-1565: the STRICT listing, so a Nextcloud that cannot answer is not
 * read as "this group is empty". Here the lenient `[]` was fail-SAFE — an
 * empty actual set removes nobody — but it also meant a real outage looked
 * identical to a converged group, so drift silently stopped being corrected
 * for as long as listing was broken. A throw propagates to the per-row
 * try/catch in the sweep loop above, which logs it and moves to the next
 * department; the tick retries in ≤5 min.
 *
 * Only `syncState=synced` rows count as "should be a member": `pending`/
 * `failed` rows haven't necessarily landed their NC add yet, so excluding
 * them from "expected" is correct, not a bug — worst case this pass
 * removes a straggling add and `sweepMemberships` re-adds it on the very
 * next tick (a one-tick bounce, never a security hole). `removing` rows
 * are mid-revocation and must never be treated as expected.
 *
 * HOUSEHOLD is never called with this (D-5: household rights convergence
 * is explicit post-GA, per the sibling exclusion in `sweepMemberships`).
 */
async function removeDriftedGroupMembers(
  prisma: PrismaClient,
  adminToken: string,
  departmentId: string,
  ncGroupRw: string | null,
  ncGroupRo: string | null,
): Promise<number> {
  if (!ncGroupRw && !ncGroupRo) return 0;

  const synced = (await prisma.departmentMembership.findMany({
    where: { departmentId, syncState: "synced" },
    select: { userId: true, right: true },
  })) as { userId: string; right: "reader" | "contributor" | "manager" }[];

  const ncUsernameByUserId = new Map<string, string | null>();
  for (const m of synced) {
    if (ncUsernameByUserId.has(m.userId)) continue;
    const user = await prisma.user.findUnique({
      where: { id: m.userId },
      select: { nextcloudUsername: true },
    });
    ncUsernameByUserId.set(m.userId, user?.nextcloudUsername ?? null);
  }

  const rwExpected = new Set<string>();
  const roExpected = new Set<string>();
  for (const m of synced) {
    const ncUsername = ncUsernameByUserId.get(m.userId);
    if (!ncUsername) continue;
    (m.right === "reader" ? roExpected : rwExpected).add(ncUsername);
  }

  let removed = 0;
  for (const [group, expected] of [
    [ncGroupRw, rwExpected],
    [ncGroupRo, roExpected],
  ] as const) {
    if (!group) continue;
    const actual = await ncListGroupMembersStrict(adminToken, group);
    for (const member of actual) {
      if (expected.has(member.id)) continue;
      await ncRemoveUserFromGroup(adminToken, member.id, group);
      removed += 1;
      await recordActivity({
        kind: "system",
        severity: "warn",
        sourceIcon: "shield-alert",
        what: "Removed drifted NC group member (Prisma is truth)",
        sub: `${member.id} · ${group}`,
        refs: { departmentId, ncUsername: member.id, group },
        actor: { type: "system" },
      });
    }
  }
  return removed;
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
        const result = await reconcileActiveDepartment(prisma, row.id);
        if (!result.active) {
          stillFailed += 1;
        } else {
          await removeDriftedGroupMembers(
            prisma,
            adminToken,
            row.id,
            result.ncGroupRw,
            result.ncGroupRo,
          );
        }
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
 * WARP-1526 (rail 6) — droplet-admins user-membership drift sweep.
 *
 * The role-change post-effects (role-mutation-guard.service.ts) push the
 * box-wide `droplet-admins` NC group best-effort; an NC outage used to
 * leave user↔group drift with no convergence pass at all. This sweep is
 * STATELESS on purpose: the expectation is recomputed from `User.role`
 * every tick (owner∪admin rows that have a Nextcloud mapping — Prisma is
 * truth, no sync-state columns), the actual set comes from
 * `ncListGroupMembersStrict`, and both directions are corrected:
 *   - missing operator → re-added (heals a failed promotion cascade);
 *   - non-operator member → removed (heals a failed demotion cascade, or
 *     an out-of-band NC admin-UI edit — declared unsupported, ADR-029
 *     §3.6 posture, same as removeDriftedGroupMembers above).
 * The NC system admin account is never removed — it owns the
 * provisioning credential and lives outside the local directory.
 * Failure containment matches the sibling sweeps: any NC error is
 * logged and the tick reports zeros; the next tick retries.
 */
async function sweepAdminGroupMembership(
  prisma: PrismaClient,
  adminToken: string,
): Promise<{ added: number; removed: number; failed: number }> {
  let added = 0;
  let removed = 0;
  let failed = 0;

  // The Prisma read sits OUTSIDE the containment — a DB-connectivity
  // failure propagates, matching the tick's documented posture (nothing
  // useful to converge without a DB). Only the NC half is contained.
  const operators = (await prisma.user.findMany({
    where: {
      role: { in: [...ADMIN_TIER_ROLES] },
      nextcloudUsername: { not: null },
    },
    select: { nextcloudUsername: true },
  })) as { nextcloudUsername: string | null }[];

  // ONE casing convention for the whole comparison (pr-reviewer #1229 N6).
  // Prisma's `nextcloudUsername` and the OCS member ids can differ in case
  // for the same account; exact-match set math would then see the member as
  // BOTH missing (add) and unexpected (remove) on every tick — an infinite
  // add/remove flap against a live account. Keys are lowercased on both
  // sides; the original spelling is kept as the value for the NC calls.
  const expectedByKey = new Map<string, string>();
  for (const row of operators) {
    if (row.nextcloudUsername) {
      expectedByKey.set(row.nextcloudUsername.toLowerCase(), row.nextcloudUsername);
    }
  }

  // Only the LISTING is wrapped here: without the actual membership there
  // is nothing to compare against, so the whole sweep is skipped this tick
  // and retried on the next one. Per-member failures are contained inside
  // their own loops below, never at this level (pr-reviewer #1229 B4).
  //
  // WARP-1565: this catch was UNREACHABLE until now. `ncListGroupMembers`
  // collapsed every failure to `[]`, so a list-broken/writes-working
  // Nextcloud did not skip the tick — it reported an empty droplet-admins,
  // concluded every operator was missing, and re-added all of them. On every
  // tick. The writes are idempotent so nothing broke; the cost was an
  // Activity log full of drift that never happened and a sweep that never
  // converged. `ncListGroupMembersStrict` throws on everything except a 404
  // (an absent group genuinely has no members), which is what makes the
  // skip below real.
  let actual: { id: string }[];
  try {
    actual = await ncListGroupMembersStrict(adminToken, DROPLET_ADMINS_GROUP);
  } catch (err) {
    logger.error(
      { err },
      "admin-group sweep: listing droplet-admins failed (non-fatal; next tick retries)",
    );
    return { added, removed, failed };
  }

  const actualKeys = new Set(actual.map((m) => m.id.toLowerCase()));
  const systemAdmin = (process.env.NEXTCLOUD_ADMIN_USER || "admin").toLowerCase();

  // REMOVALS FIRST (pr-reviewer #1229 B4). This is the security-relevant
  // direction — pulling a demoted ex-admin out of the box-wide admin group
  // — so it must never sit behind the add loop, where one un-addable
  // expected member (an operator whose NC account was deleted, say) would
  // otherwise starve revocation on every tick, forever.
  for (const member of actual) {
    const key = member.id.toLowerCase();
    if (expectedByKey.has(key)) continue;
    if (key === systemAdmin) continue; // owns the provisioning credential
    try {
      await ncRemoveUserFromGroup(adminToken, member.id, DROPLET_ADMINS_GROUP);
      removed += 1;
      await recordActivity({
        kind: "system",
        severity: "warn",
        sourceIcon: "shield-alert",
        what: "Removed drifted admin-group member (role tier is truth)",
        sub: `${member.id} · ${DROPLET_ADMINS_GROUP}`,
        refs: { ncUsername: member.id, group: DROPLET_ADMINS_GROUP },
        actor: { type: "system" },
      });
    } catch (err) {
      failed += 1;
      logger.error(
        { err, ncUsername: member.id },
        "admin-group sweep: revoking a drifted member failed (next tick retries)",
      );
    }
  }

  // Then the restorations: an operator NC lost (or never received) is
  // re-added. Per-item containment mirrors sweepMemberships' per-row
  // try/catch — one bad member must not abort the rest of the loop.
  for (const [key, ncUsername] of expectedByKey) {
    if (actualKeys.has(key)) continue;
    try {
      await ncAddUserToGroup(adminToken, ncUsername, DROPLET_ADMINS_GROUP);
      added += 1;
      await recordActivity({
        kind: "system",
        severity: "warn",
        sourceIcon: "shield-alert",
        what: "Restored drifted admin-group member (role tier is truth)",
        sub: `${ncUsername} · ${DROPLET_ADMINS_GROUP}`,
        refs: { ncUsername, group: DROPLET_ADMINS_GROUP },
        actor: { type: "system" },
      });
    } catch (err) {
      failed += 1;
      logger.error(
        { err, ncUsername },
        "admin-group sweep: restoring an operator failed (next tick retries)",
      );
    }
  }

  return { added, removed, failed };
}

/**
 * WARP-1526 (pr-reviewer #1229 N1) — directoryStatus → Nextcloud enable
 * mirror.
 *
 * The disable path writes `directoryStatus=DEACTIVATED` locally (the
 * ADR-013 truth every login gate honours) and then mirrors to Nextcloud
 * best-effort. When that mirror fails the local side is safe but the NC
 * account stays ENABLED — and Nextcloud is proxied directly at
 * `/nextcloud/` with no orchestrator auth in front, so the "disabled"
 * person keeps web, WebDAV and desktop-sync access indefinitely. Nothing
 * healed that until this pass.
 *
 * Stateless, same shape as the admin-group sweep: the expectation comes
 * from `User.directoryStatus` alone, no sync columns. Only the DEACTIVATED
 * direction is pushed — it is the security-relevant one, and re-asserting
 * `enabled=false` is idempotent. The ACTIVE direction is deliberately NOT
 * force-pushed every tick: it would mean an OCS write per active user per
 * five minutes to correct a state no security property depends on (the
 * enable route already writes both sides).
 */
async function sweepDirectoryStatusMirror(
  prisma: PrismaClient,
  adminToken: string,
): Promise<{ disabledMirrored: number; failed: number }> {
  let disabledMirrored = 0;
  let failed = 0;

  const deactivated = (await prisma.user.findMany({
    where: {
      directoryStatus: "DEACTIVATED",
      nextcloudUsername: { not: null },
    },
    select: { nextcloudUsername: true },
  })) as { nextcloudUsername: string | null }[];

  for (const row of deactivated) {
    if (!row.nextcloudUsername) continue;
    try {
      await ncSetUserEnabled(adminToken, row.nextcloudUsername, false);
      disabledMirrored += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { err, ncUsername: row.nextcloudUsername },
        "directoryStatus mirror: re-asserting NC disable failed (next tick retries)",
      );
    }
  }

  return { disabledMirrored, failed };
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
  const adminGroupResult = await sweepAdminGroupMembership(prisma, adminToken);
  const statusMirrorResult = await sweepDirectoryStatusMirror(prisma, adminToken);

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
    roleDefaultQuotasSwept: usageResult.roleDefaultQuotasSwept,
    roleDefaultQuotasSynced: usageResult.roleDefaultQuotasSynced,
    roleDefaultQuotasFailed: usageResult.roleDefaultQuotasFailed,
    adminGroupAdded: adminGroupResult.added,
    adminGroupRemoved: adminGroupResult.removed,
    adminGroupFailed: adminGroupResult.failed,
    ncDisableMirrored: statusMirrorResult.disabledMirrored,
    ncDisableMirrorFailed: statusMirrorResult.failed,
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
