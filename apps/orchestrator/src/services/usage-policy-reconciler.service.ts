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
          accessRole: { select: { storageQuotaBytes: true } },
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
        user?.accessRole ?? null,
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
  const roleUsers = await prisma.user.findMany({
    where: { accessRole: { storageQuotaBytes: { not: null } } },
    select: {
      id: true,
      nextcloudUsername: true,
      accessRole: { select: { storageQuotaBytes: true } },
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
    const roleQuota = user.accessRole?.storageQuotaBytes ?? null;
    if (roleQuota === null) continue; // defensive; the where-clause filters

    roleSwept += 1;
    if (!user.nextcloudUsername) {
      // Same posture as pass 1: provisioning is async; retry next tick.
      roleFailed += 1;
      continue;
    }
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
