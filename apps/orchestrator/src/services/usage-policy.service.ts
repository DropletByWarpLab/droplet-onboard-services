/**
 * WARP-1271 (T19a) — per-user usage settings: `UserUsagePolicy` writers.
 *
 * Owns the upsert + NC quota pushdown for `PUT /api/people/:id/usage` and
 * the read (policy + display-only used-bytes) for `GET /api/people/:id/usage`
 * (both in routes/people.ts). Follows the same shape as
 * department-membership.service.ts: one Prisma write, a best-effort
 * immediate NC push right after it commits, `quotaSyncState` tracks the
 * pushdown outcome, and the 5-minute reconciler
 * (usage-policy-reconciler.service.ts, hooked into
 * department-reconciler.service.ts's tick) retries anything left
 * `pending`/`failed`.
 *
 * `storageQuotaBytes: null` means "no limit" — pushed to Nextcloud as the
 * literal string `"none"` (OCS quota-field contract, matches
 * ncUpdateUser's own doc comment).
 *
 * D-7 (ADR-029 §10): `llmDailyMessageCap` is NOT written or read by this
 * module — it ships persisted-but-unenforced; see the comment beside
 * narrowAllowedToolsForRole in routes/llm.ts.
 */
import type { PrismaClient, UserUsagePolicy } from "@prisma/client";
import { ncUpdateUser, ncGetUserQuotaAdmin } from "./nextcloud.client.js";
import { adminBasicToken } from "./department-provisioner.service.js";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("usage-policy");

export class TargetUserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User not found: ${userId}`);
    this.name = "TargetUserNotFoundError";
  }
}

export interface UsagePolicyInput {
  /** `undefined` = leave unchanged; `null` = clear (no limit). */
  storageQuotaBytes?: bigint | null;
  /** `undefined` = leave unchanged; `null` = clear (use config default). */
  maxUploadSizeMb?: number | null;
}

/** OCS quota field value for a desired byte quota; `null` → "none" (unlimited). */
function quotaFieldValue(storageQuotaBytes: bigint | null): string {
  return storageQuotaBytes === null ? "none" : `${storageQuotaBytes.toString()} B`;
}

/**
 * Push the target's CURRENT desired quota to Nextcloud and flip
 * `quotaSyncState` accordingly. Never throws — pushdown failure is
 * recorded on the row for the reconciler to retry; the caller (the route)
 * must not fail the request just because NC is unreachable (D-3-style
 * degrade, same posture as department-membership.service's inline push).
 */
async function pushQuota(
  prisma: PrismaClient,
  userId: string,
  ncUsername: string,
  storageQuotaBytes: bigint | null,
): Promise<boolean> {
  try {
    await ncUpdateUser(adminBasicToken(), ncUsername, "quota", quotaFieldValue(storageQuotaBytes));
    await prisma.userUsagePolicy.update({
      where: { userId },
      data: { quotaSyncState: "synced" },
    });
    return true;
  } catch (err) {
    logger.error(
      { err, userId, ncUsername },
      "usage-policy: quota pushdown failed (reconciler will retry)",
    );
    try {
      await prisma.userUsagePolicy.update({
        where: { userId },
        data: { quotaSyncState: "failed" },
      });
    } catch (updateErr) {
      logger.warn(
        { err: updateErr, userId },
        "usage-policy: failed to mark quotaSyncState=failed after pushdown error",
      );
    }
    return false;
  }
}

/**
 * Upsert a user's usage policy and (best-effort) push the storage quota to
 * Nextcloud. `updatedBy` is the acting owner/admin's local User.id.
 */
export async function upsertUsagePolicy(
  prisma: PrismaClient,
  targetUserId: string,
  updatedBy: string,
  input: UsagePolicyInput,
): Promise<{ policy: UserUsagePolicy; pushed: boolean }> {
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true, nextcloudUsername: true },
  });
  if (!user) throw new TargetUserNotFoundError(targetUserId);

  const quotaChanged = input.storageQuotaBytes !== undefined;

  const policy = await prisma.userUsagePolicy.upsert({
    where: { userId: targetUserId },
    create: {
      userId: targetUserId,
      storageQuotaBytes: input.storageQuotaBytes ?? null,
      maxUploadSizeMb: input.maxUploadSizeMb ?? null,
      quotaSyncState: "pending",
      updatedBy,
    },
    update: {
      ...(quotaChanged
        ? { storageQuotaBytes: input.storageQuotaBytes, quotaSyncState: "pending" as const }
        : {}),
      ...(input.maxUploadSizeMb !== undefined
        ? { maxUploadSizeMb: input.maxUploadSizeMb }
        : {}),
      updatedBy,
    },
  });

  await recordActivity({
    kind: "system",
    severity: "ok",
    sourceIcon: "gauge",
    what: "Usage settings updated",
    sub: user.username,
    refs: {
      actor: updatedBy,
      targetUserId: user.id,
      storageQuotaBytes: policy.storageQuotaBytes?.toString() ?? null,
      maxUploadSizeMb: policy.maxUploadSizeMb ?? null,
    },
    actor: { type: "user", id: updatedBy },
  });

  // Only the quota field needs an NC pushdown — maxUploadSizeMb is
  // orchestrator-local (enforced in the multer path, files.ts) and never
  // touches Nextcloud.
  if (!quotaChanged) {
    return { policy, pushed: policy.quotaSyncState === "synced" };
  }
  if (!user.nextcloudUsername) {
    // No NC account yet (mid-provisioning) — leave `pending`; the
    // reconciler retries once nextcloudUsername is populated.
    return { policy, pushed: false };
  }

  const pushed = await pushQuota(prisma, targetUserId, user.nextcloudUsername, policy.storageQuotaBytes);
  // pushQuota (success OR failure) always updates quotaSyncState on the row
  // — re-fetch either way so the response reflects the ACTUAL persisted
  // state, not the pre-pushdown snapshot captured by the upsert above.
  const after = await prisma.userUsagePolicy.findUnique({ where: { userId: targetUserId } });
  return { policy: after ?? policy, pushed };
}

export interface UsagePolicyWithUsage {
  policy: UserUsagePolicy | null;
  /** Display-only, read back from Nextcloud each call — never policy truth. */
  usedBytes: bigint | null;
}

/**
 * Read a user's usage policy plus a live (display-only) used-bytes figure
 * from Nextcloud. `usedBytes` is `null` when the user has no NC account yet
 * or the quota read fails — the caller renders an honest em-dash, never a
 * fabricated 0.
 */
export async function getUsagePolicyWithUsage(
  prisma: PrismaClient,
  targetUserId: string,
): Promise<UsagePolicyWithUsage> {
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { nextcloudUsername: true },
  });
  if (!user) throw new TargetUserNotFoundError(targetUserId);

  const policy = await prisma.userUsagePolicy.findUnique({ where: { userId: targetUserId } });

  let usedBytes: bigint | null = null;
  if (user.nextcloudUsername) {
    try {
      const quota = await ncGetUserQuotaAdmin(adminBasicToken(), user.nextcloudUsername);
      if (quota) usedBytes = BigInt(Math.trunc(quota.used));
    } catch (err) {
      logger.warn({ err, targetUserId }, "usage-policy: used-bytes read failed (non-fatal)");
    }
  }

  return { policy, usedBytes };
}
