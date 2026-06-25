/**
 * WARP-890 — stale-sending reconcile, shared by the route and the cron.
 *
 * A draft claimed (queued→sending) whose terminal status callback never landed
 * (email-indexer crash / lost PATCH) would otherwise strand in `sending`
 * forever. The original recovery lived ONLY in the email-indexer's outbound
 * tick, so if the indexer was down longer than the stale window the stranded
 * drafts never recovered. We additionally run this sweep as an orchestrator
 * cron (see index.ts) so recovery is INDEPENDENT of the email-indexer.
 *
 * Recovery posture: rows stuck in `sending` past the grace window flip to
 * `failed` — we do NOT re-queue them, because the SMTP send may already have
 * completed and re-queuing would risk the duplicate this whole change exists to
 * prevent.
 *
 * Idempotent + safe to run from BOTH the route and the cron concurrently: it is
 * a single conditional `updateMany WHERE status='sending' AND claimedAt < cutoff`.
 * Whichever caller wins flips the rows to `failed`; the loser's WHERE no longer
 * matches (status is now `failed`), so it touches zero rows. No double-process.
 *
 * Tamper-proof clock: the cutoff keys off the explicit `claimedAt` column, NOT
 * `updatedAt`. Prisma `@updatedAt` resets on ANY row write, so a concurrent edit
 * to an unrelated field would silently reset the grace window.
 */
import type { PrismaClient } from "@prisma/client";

export const EMAIL_SENDING_STALE_DEFAULT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Resolve the stale-sending grace window from `EMAIL_SENDING_STALE_MS`.
 *
 * Parses via `Number` and honors an explicit `0` (immediate reconcile, useful in
 * tests): we fall back to the default ONLY when the var is unset or non-finite
 * (NaN). The previous `Number(...) || default` swallowed a deliberate `0`.
 */
export function resolveStaleMs(
  raw: string | undefined = process.env.EMAIL_SENDING_STALE_MS,
): number {
  if (raw === undefined || raw === "") return EMAIL_SENDING_STALE_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : EMAIL_SENDING_STALE_DEFAULT_MS;
}

/**
 * Sweep drafts stuck in `sending` past the grace window to `failed`. Returns the
 * number of rows reconciled. `now` is injectable for deterministic tests.
 */
export async function reconcileStaleSending(
  prisma: Pick<PrismaClient, "emailDraft">,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - resolveStaleMs());
  const result = await prisma.emailDraft.updateMany({
    where: { status: "sending", claimedAt: { lt: cutoff } },
    data: {
      status: "failed",
      error:
        "reconciled: stuck in sending past the grace window (terminal status callback never landed)",
    },
  });
  return result.count;
}
