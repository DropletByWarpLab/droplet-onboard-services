/**
 * WARP-1122 (Phase 4, §8.2) — the business-knowledge refresh nudge.
 *
 * A scheduled check (cron-runtime, never `while True`) that marks the
 * business profile review-due when it has gone stale: `updatedAt` older
 * than BUSINESS_PROFILE_REVIEW_DAYS. Explicit-state rule throughout
 * (§5-2): due-ness is `reviewNudgeState='due'` + `reviewDueAt`; dismissal
 * is `'dismissed'` + `reviewDismissedAt` (set by the review-dismiss route,
 * Phase 3) — nothing is ever derived from a nulled timestamp.
 *
 * "Never resurrects within the same review period" (design §7.12): a
 * dismissed nudge only re-arms once the DISMISSAL itself is older than a
 * full review period (and the profile is still stale).
 *
 * Gating: registration is behind the EXPLICIT `BUSINESS_PROFILE_REVIEW_ENABLED`
 * boolean (§5-11) — enabled-ness is never inferred from the days var.
 */
import type { PrismaClient } from "@prisma/client";
import { BUSINESS_PROFILE_SINGLETON_ID } from "./business-profile.service.js";

export interface ReviewNudgeCheckResult {
  /** true when this tick transitioned the profile to review-due. */
  markedDue: boolean;
  /** Which arm fired: fresh (none→due) or re-arm (dismissed→due). */
  via: "none" | "dismissed" | null;
}

/**
 * One scheduled tick. Both arms are atomic conditional updates — a racing
 * dismissal between read and write simply wins (zero rows matched).
 * Only a COMPLETED profile ever nudges: there is nothing to "refresh"
 * before the interview has run or the profile was hand-filled.
 */
export async function runBusinessReviewCheck(
  prisma: PrismaClient,
  reviewDays: number,
  now: Date = new Date(),
): Promise<ReviewNudgeCheckResult> {
  const cutoff = new Date(now.getTime() - reviewDays * 24 * 60 * 60 * 1000);

  // Arm 1 — fresh nudge: stale profile that has never been nudged (or was
  // reset to none by a later profile write).
  const fresh = await prisma.businessProfile.updateMany({
    where: {
      id: BUSINESS_PROFILE_SINGLETON_ID,
      onboardingState: "completed",
      reviewNudgeState: "none",
      updatedAt: { lt: cutoff },
    },
    data: { reviewNudgeState: "due", reviewDueAt: now },
  });
  if (fresh.count > 0) return { markedDue: true, via: "none" };

  // Arm 2 — re-arm after a FULL period since dismissal (never within the
  // same review period, §7.12).
  const rearmed = await prisma.businessProfile.updateMany({
    where: {
      id: BUSINESS_PROFILE_SINGLETON_ID,
      onboardingState: "completed",
      reviewNudgeState: "dismissed",
      reviewDismissedAt: { lt: cutoff },
      updatedAt: { lt: cutoff },
    },
    data: { reviewNudgeState: "due", reviewDueAt: now },
  });
  if (rearmed.count > 0) return { markedDue: true, via: "dismissed" };

  return { markedDue: false, via: null };
}
