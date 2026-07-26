/**
 * WARP-1271 (T19a) — usage-policy reconciler hook.
 * WARP-1531 / ADR-032 (RBAC v2 T7) — role-default quota convergence.
 *
 * Small hook BESIDE department-reconciler.service.ts (per the ticket) —
 * runs on the SAME 5-minute cadence the department reconciler already
 * runs on (called from `reconcileDepartments()`, no separate cron
 * wiring). Two passes, both pushing the EFFECTIVE storage quota
 * (person field ?? AccessRole default ?? "none"/unmanaged — the §3
 * resolver's usage line, see effective-usage.service.ts):
 *
 *   1. Row sweep (unchanged shape): `UserUsagePolicy` rows left
 *      `pending`/`failed` re-push toward Nextcloud and flip
 *      `quotaSyncState`. A row whose own storage field is unset now
 *      pushes its role's default instead of "none"; with zero AccessRole
 *      rows this pass is byte-identical to pre-1531 behavior.
 *
 *   2. Role pass (WARP-1531, STATELESS): every user whose AccessRole
 *      carries a storage default and whose own field is unset gets the
 *      role default pushed EVERY sweep — deliberately no new columns and
 *      no new sync states. Convergence after a role-default change falls
 *      out of the recompute-each-tick design rather than a dirty flag;
 *      the box-scale roster (tens of users) keeps this cheap. Users whose
 *      row is mid-lifecycle (`pending`/`failed`) this tick are skipped —
 *      pass 1 owns them, so a user is pushed at most once per tick. A
 *      role default REMOVED (set back to null) simply stops being pushed:
 *      null means "box default = unmanaged", the same as today's
 *      no-policy-row world — never an implicit push of "none".
 *
 * WARP-1569 — ONLY AN ACTIVE ROLE MANAGES QUOTA. Both passes read
 * `AccessRole.state` and treat an archived role as no role at all. An
 * archived role is inert everywhere else (unassignable; filed away in the
 * admin surface), so it must not keep pushing a storage default to
 * everyone still holding it on every 5-minute tick. Those people fall
 * through to the box default — "stop managing", not "push none", the same
 * reading T7 gave a cleared default. Archiving is therefore what stops the
 * pushes, and restoring (WARP-1560) is what resumes them, both on the next
 * tick, with no dirty flag on either side.
 *
 * Prisma (and now AccessRole) is the desired state; NC is never read
 * back as truth here — only pushed to.
 *
 * `maxUploadSizeMb` needs no reconciler pass: it's orchestrator-local
 * (enforced in files.ts's multer path) and never touches Nextcloud.
 * `llmDailyMessageCap` enforcement stays deferred (D-7, llm.ts:401).
 */
import type { PrismaClient } from "@prisma/client";
import { ncUpdateUser } from "./nextcloud.client.js";
import { resolveEffectiveUsage } from "./effective-usage.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("usage-policy-reconciler");

const SWEEP_STATES = ["pending", "failed"] as const;

/** `AccessRole.state` — the only value that keeps a role's defaults live. */
const ROLE_STATE_ACTIVE = "active";

interface UsagePolicySweepRow {
  userId: string;
  storageQuotaBytes: bigint | null;
}

export interface UsagePolicySweepResult {
  usagePoliciesSwept: number;
  usagePoliciesSynced: number;
  usagePoliciesFailed: number;
  // WARP-1531: stateless role-default pass — counted separately because
  // these pushes have no backing row/state to converge (recomputed every
  // tick), so "failed" here only means "retry next tick", never a stuck row.
  roleDefaultQuotasSwept: number;
  roleDefaultQuotasSynced: number;
  roleDefaultQuotasFailed: number;
}

/** OCS quota field value; `null` desired quota → "none" (unlimited). */
function quotaFieldValue(storageQuotaBytes: bigint | null): string {
  return storageQuotaBytes === null ? "none" : `${storageQuotaBytes.toString()} B`;
}

/**
 * WARP-1569 — only an ACTIVE role manages anybody's usage. An archived role
 * is inert by design (it can't be assigned and the admin surface files it
 * away), so its defaults stop contributing to the effective value; the
 * people still holding it fall through to the box default exactly like a
 * role-less user. Deliberately "stop managing", not "push none" — same
 * reading as T7's cleared-default rule.
 */
function managingRole<T extends { state: string }>(role: T | null | undefined): T | null {
  return role && role.state === ROLE_STATE_ACTIVE ? role : null;
}

export async function sweepUsagePolicies(
  prisma: PrismaClient,
  adminToken: string,
): Promise<UsagePolicySweepResult> {
  const rows = (await prisma.userUsagePolicy.findMany({
    where: { quotaSyncState: { in: [...SWEEP_STATES] } },
    select: { userId: true, storageQuotaBytes: true },
  })) as UsagePolicySweepRow[];

  let synced = 0;
  let failed = 0;

  // Pass 1 owns every user it swept this tick — the stateless role pass
  // below must not double-push them (their row may already read `synced`
  // by the time pass 2 queries).
  const rowSweptUserIds = new Set(rows.map((r) => r.userId));

  for (const row of rows) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: row.userId },
        select: {
          nextcloudUsername: true,
          accessRole: { select: { storageQuotaBytes: true, state: true } },
        },
      });
      const ncUsername = user?.nextcloudUsername ?? null;
      if (!ncUsername) {
        // No NC account provisioned yet — retry next tick, not a failure
        // worth logging loudly (the household absorption / invite flows
        // provision this asynchronously).
        failed += 1;
        continue;
      }
      // WARP-1531: the pushed quota is the EFFECTIVE value — an unset
      // person field falls through to the role default; only when neither
      // is set does the legacy "none" (explicit unlimited) push remain.
      const effectiveQuota = resolveEffectiveUsage(
        { storageQuotaBytes: row.storageQuotaBytes },
        managingRole(user?.accessRole),
      ).storageQuotaBytes.value;
      await ncUpdateUser(adminToken, ncUsername, "quota", quotaFieldValue(effectiveQuota));
      await prisma.userUsagePolicy.update({
        where: { userId: row.userId },
        data: { quotaSyncState: "synced" },
      });
      synced += 1;
    } catch (err) {
      logger.error({ err, userId: row.userId }, "usage-policy reconcile: quota pushdown failed");
      try {
        await prisma.userUsagePolicy.update({
          where: { userId: row.userId },
          data: { quotaSyncState: "failed" },
        });
      } catch (updateErr) {
        logger.warn(
          { err: updateErr, userId: row.userId },
          "usage-policy reconcile: failed to mark quotaSyncState=failed after error",
        );
      }
      failed += 1;
    }
  }

  // ── Pass 2 (WARP-1531): stateless role-default convergence ──
  // WARP-1569: `state` is part of the candidate predicate, not an
  // afterthought — an archived role never enters the pass at all, so
  // archiving a role is what STOPS its pushes on the very next tick.
  const roleUsers = await prisma.user.findMany({
    where: {
      accessRole: { state: ROLE_STATE_ACTIVE, storageQuotaBytes: { not: null } },
    },
    select: {
      id: true,
      nextcloudUsername: true,
      accessRole: { select: { storageQuotaBytes: true, state: true } },
      usagePolicy: { select: { storageQuotaBytes: true } },
    },
  });

  let roleSwept = 0;
  let roleSynced = 0;
  let roleFailed = 0;

  for (const user of roleUsers) {
    // Person value set → their row lifecycle owns pushes; the role default
    // is shadowed field-by-field (effective-usage.service.ts).
    if (user.usagePolicy?.storageQuotaBytes != null) continue;
    // Row mid-lifecycle this tick → pass 1 already pushed the effective
    // (role) value; skip so each user is pushed at most once per sweep.
    if (rowSweptUserIds.has(user.id)) continue;
    const roleQuota = managingRole(user.accessRole)?.storageQuotaBytes ?? null;
    if (roleQuota === null) continue; // defensive; the where-clause filters

    if (!user.nextcloudUsername) {
      // Same posture as pass 1: provisioning is async; retry next tick.
      roleSwept += 1;
      roleFailed += 1;
      continue;
    }

    // C1 (PR #1223 review): RE-READ the person row immediately before the
    // push. The roster snapshot above and this iteration can be minutes
    // apart on a slow NC; a concurrent admin PUT in that window sets a
    // person quota (inline push lands, row commits `synced`) — pushing the
    // snapshot's STALE role default afterwards would make NC enforce the
    // role value while Prisma says the person value is `synced`, and
    // nothing would ever heal it (pass 1 skips synced rows, the next pass 2
    // skips person-set users). Also stand down on `pending`/`failed` — the
    // row lifecycle owns the next push, same rule as the rowSweptUserIds
    // dedupe. This shrinks the TOCTOU window to the single NC call below,
    // matching the residual pass 1 carries.
    let fresh: { storageQuotaBytes: bigint | null; quotaSyncState: string } | null;
    try {
      fresh = await prisma.userUsagePolicy.findUnique({
        where: { userId: user.id },
        select: { storageQuotaBytes: true, quotaSyncState: true },
      });
    } catch (err) {
      logger.error(
        { err, userId: user.id },
        "usage-policy reconcile: pre-push person-row re-read failed; skipping role push this tick",
      );
      roleSwept += 1;
      roleFailed += 1;
      continue;
    }
    if (
      fresh !== null &&
      (fresh.storageQuotaBytes !== null ||
        (SWEEP_STATES as readonly string[]).includes(fresh.quotaSyncState))
    ) {
      // No longer a role-managed candidate — claimed mid-sweep.
      continue;
    }

    roleSwept += 1;
    try {
      await ncUpdateUser(adminToken, user.nextcloudUsername, "quota", quotaFieldValue(roleQuota));
      roleSynced += 1;
    } catch (err) {
      logger.error(
        { err, userId: user.id },
        "usage-policy reconcile: role-default quota pushdown failed",
      );
      roleFailed += 1;
    }
  }

  return {
    usagePoliciesSwept: rows.length,
    usagePoliciesSynced: synced,
    usagePoliciesFailed: failed,
    roleDefaultQuotasSwept: roleSwept,
    roleDefaultQuotasSynced: roleSynced,
    roleDefaultQuotasFailed: roleFailed,
  };
}
