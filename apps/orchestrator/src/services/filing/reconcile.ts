/**
 * WARP-2730 (ADR-048) — the stale-claim sweep.
 *
 * The counterpart to `worker.ts`'s claim, and the reason that claim can be a
 * durable column rather than an advisory lock: a process killed mid-extraction
 * leaves a row `running` with an `extractClaimedAt`, and something has to
 * notice. An advisory lock would have vanished with the process and the row
 * would sit `running` forever, invisible, with the owner's file never filed and
 * nothing anywhere saying so.
 *
 * Modelled on the shipped `droplet:email-stale-sending-reconcile`: pure DB
 * work, no model call, safe to run under a `lockKey` (which this one DOES
 * carry — it finishes in milliseconds).
 */
import type { PrismaClient } from "@prisma/client";

import { MAX_ATTEMPTS } from "./worker.js";

/**
 * How long a claim may be held before it is presumed dead.
 *
 * `completeOnce` allows 120 s per call and the worker makes up to four (two
 * passes, each with one repair retry), so a live extraction can legitimately
 * run for eight minutes on a cold CPU-inference box. Fifteen gives that room
 * and still bounds a wedged row to one sweep interval past it. Reclaiming a
 * LIVE extraction would be harmless anyway — the loser's terminal write is
 * guarded on `extractStatus = 'running'` and the winner's claim already moved
 * it — but it would waste a model run, which on this hardware is the scarce
 * thing.
 */
export const STALE_CLAIM_MS = 15 * 60_000;

/** How long a failed row waits before its next attempt. */
export const RETRY_BACKOFF_MS = 30 * 60_000;

export interface ReconcileResult {
  /** Claims presumed dead and returned to the queue. */
  reArmed: number;
  /** Claims that had used their whole attempt budget. */
  givenUp: number;
  /** Failed rows whose backoff expired. */
  retried: number;
}

export async function runFilingReconcile(prisma: PrismaClient): Promise<ReconcileResult> {
  const now = Date.now();
  const staleBefore = new Date(now - STALE_CLAIM_MS);
  const retryBefore = new Date(now - RETRY_BACKOFF_MS);

  // Out of budget first, so a row is not re-armed and then immediately given
  // up on by the same sweep — the two updates are ordered, not exclusive, and
  // running them the other way round would burn an attempt per sweep.
  const givenUp = await prisma.fileIndexStatus.updateMany({
    where: {
      extractStatus: "running",
      extractClaimedAt: { lt: staleBefore },
      extractAttempts: { gte: MAX_ATTEMPTS },
    },
    data: {
      extractStatus: "failed",
      extractReason: "stale_claim",
      extractedAt: new Date(),
      extractClaimedAt: null,
    },
  });

  const reArmed = await prisma.fileIndexStatus.updateMany({
    where: {
      extractStatus: "running",
      extractClaimedAt: { lt: staleBefore },
      extractAttempts: { lt: MAX_ATTEMPTS },
    },
    data: { extractStatus: "pending", extractClaimedAt: null },
  });

  // A `failed` row is re-armed only for the reasons that can come out
  // differently next time. `phi_record`, `not_business` and
  // `cloud_model_refused` are absent on purpose: the first two will not change
  // by asking again, and the third changes when the OWNER changes the model —
  // at which point the row re-arms through the ordinary touch path, not
  // through a timer that would otherwise re-ask a cloud model every half hour.
  const retried = await prisma.fileIndexStatus.updateMany({
    where: {
      extractStatus: "failed",
      extractReason: { in: ["bad_json", "stale_claim"] },
      extractAttempts: { lt: MAX_ATTEMPTS },
      extractedAt: { lt: retryBefore },
    },
    data: {
      extractStatus: "pending",
      extractReason: null,
      extractedAt: null,
      extractClaimedAt: null,
    },
  });

  return { reArmed: reArmed.count, givenUp: givenUp.count, retried: retried.count };
}
