/**
 * WARP-1271 (T19a) — usage-policy reconciler hook.
 *
 * Small hook BESIDE department-reconciler.service.ts (per the ticket) —
 * re-pushes any `UserUsagePolicy` row left `pending`/`failed` toward
 * Nextcloud on the SAME 5-minute cadence the department reconciler
 * already runs on (called from `reconcileDepartments()`, no separate
 * cron wiring). Prisma's `storageQuotaBytes` is the desired state; NC is
 * never read back as truth here — only pushed to.
 *
 * `maxUploadSizeMb` needs no reconciler pass: it's orchestrator-local
 * (enforced in files.ts's multer path) and never touches Nextcloud.
 */
import type { PrismaClient } from "@prisma/client";
import { ncUpdateUser } from "./nextcloud.client.js";
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

  for (const row of rows) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: row.userId },
        select: { nextcloudUsername: true },
      });
      const ncUsername = user?.nextcloudUsername ?? null;
      if (!ncUsername) {
        // No NC account provisioned yet — retry next tick, not a failure
        // worth logging loudly (the household absorption / invite flows
        // provision this asynchronously).
        failed += 1;
        continue;
      }
      await ncUpdateUser(adminToken, ncUsername, "quota", quotaFieldValue(row.storageQuotaBytes));
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

  return {
    usagePoliciesSwept: rows.length,
    usagePoliciesSynced: synced,
    usagePoliciesFailed: failed,
  };
}
