/**
 * Brain pass lease (WARP-2837, ADR-051 §5) — how a pass is held while it runs,
 * now that it cannot be held by a transaction.
 *
 * 🔴 THE BUG THIS REPLACES. The corpus pass was registered with cron-runtime's
 * `lockKey`, which runs the handler inside
 * `prisma.$transaction(fn, { timeout: 60_000 })`. That handler makes up to ten
 * sequential model calls, on a box with `max_concurrent=1`, `num_parallel=1`
 * and no turn-level timeout. Ten CPU inferences do not fit in sixty seconds.
 * When the transaction expired: the advisory lock was released MID-RUN while
 * the pass carried on, the pass's own writes had already committed out of band
 * (they use the outer client, not `tx`), and the eventual commit threw P2028
 * into `safeRun` — logged as an error, with `consecutiveFailures` climbing, on
 * a pass that was partly succeeding.
 *
 * `agent-run-worker.service.ts` reached this conclusion first and states the
 * rule this file follows: the transaction-scoped lock is "exactly right for a
 * tick and exactly wrong for a forty-minute run", so the tick CLAIMS and the
 * work executes outside it.
 *
 * WHY A CONDITIONAL UPDATE AND NOT A LOCK. `updateMany` with the claim
 * predicate in its WHERE is atomic in Postgres on its own — no surrounding
 * transaction, nothing held open, and `count` IS the answer. Two racers cannot
 * both see `count === 1`, and that holds across REPLICAS, which a
 * process-local boolean does not. The same property `agent-run-claim.pg.test.ts`
 * proves for the run queue.
 *
 * SKIP, NEVER QUEUE. A claim that loses returns `won: false` and the caller
 * does nothing. A pass is a cursor: the next tick picks up where this one would
 * have started, so a missed tick costs nothing and a queued one would just
 * stack model calls behind a slot that is already busy.
 */
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * How long a claim survives without a heartbeat before another process may
 * take it. Generous on purpose: a single corpus unit is one model call on a
 * CPU box, and reclaiming a pass that is merely slow would run it twice.
 */
export const BRAIN_LEASE_MS = 15 * 60_000;

/**
 * How often a running pass beats. Comfortably inside the lease — the ratio is
 * what absorbs a slow unit, an event-loop stall or a paused container without
 * losing the claim.
 */
export const BRAIN_HEARTBEAT_MS = 60_000;

/** This process. Stable for the lifetime of the orchestrator, and the value
 *  every fenced write is conditioned on. */
export const WORKER_ID = `orch-${randomUUID()}`;

export type ClaimResult =
  | { won: true; workerId: string }
  | { won: false; reason: "busy" | "disabled" | "missing" };

/**
 * Try to take the pass.
 *
 * The stale arm (`heartbeatAt < cutoff`) is folded into the SAME statement
 * rather than run as a separate reclaim sweep. One statement cannot race with
 * itself: a sweep that marked rows idle and then claimed them would leave a
 * window where two processes both see an idle row.
 *
 * `enabled: true` is in the predicate, so the per-pass switch an operator threw
 * is honoured by the claim itself — a disabled pass cannot be started by a tick
 * OR by any future manual trigger, without either of them having to remember.
 */
export async function claimPass(
  prisma: PrismaClient,
  passKey: string,
  now: Date = new Date(),
  workerId: string = WORKER_ID,
): Promise<ClaimResult> {
  const cutoff = new Date(now.getTime() - BRAIN_LEASE_MS);
  const res = await prisma.brainPass.updateMany({
    where: {
      passKey,
      enabled: true,
      OR: [
        { runState: "idle" },
        // A claim nobody has beaten inside the lease window. `heartbeatAt` is
        // null for a row that predates this migration and is still `running`
        // — impossible today, but a null here must read as RECLAIMABLE rather
        // than as "held forever by a process that no longer exists".
        { runState: "running", heartbeatAt: { lt: cutoff } },
        { runState: "running", heartbeatAt: null },
      ],
    },
    data: {
      runState: "running",
      claimedBy: workerId,
      claimedAt: now,
      heartbeatAt: now,
      lastRunAt: now,
    },
  });
  if (res.count === 1) return { won: true, workerId };

  // Lost. Say WHY, because "busy" and "an operator switched this pass off" are
  // different answers and a caller that conflates them reports a disabled pass
  // as a concurrency problem.
  const row = await prisma.brainPass.findUnique({
    where: { passKey },
    select: { enabled: true },
  });
  if (!row) return { won: false, reason: "missing" };
  return { won: false, reason: row.enabled ? "busy" : "disabled" };
}

/**
 * Beat the lease. FENCED: conditioned on this worker still holding the claim,
 * so a process whose lease was reclaimed learns it here rather than by
 * overwriting its successor.
 *
 * Returns false when the claim is gone. The caller must stop — see
 * `runWithLease`.
 */
export async function beatPass(
  prisma: PrismaClient,
  passKey: string,
  now: Date = new Date(),
  workerId: string = WORKER_ID,
): Promise<boolean> {
  const res = await prisma.brainPass.updateMany({
    where: { passKey, runState: "running", claimedBy: workerId },
    data: { heartbeatAt: now },
  });
  return res.count === 1;
}

/**
 * Hand the pass back. Also fenced: a process whose lease was reclaimed must not
 * release the SUCCESSOR's claim on its way out, which is exactly what an
 * unconditional update would do.
 */
export async function releasePass(
  prisma: PrismaClient,
  passKey: string,
  workerId: string = WORKER_ID,
): Promise<boolean> {
  const res = await prisma.brainPass.updateMany({
    where: { passKey, runState: "running", claimedBy: workerId },
    data: { runState: "idle", claimedBy: null, claimedAt: null, heartbeatAt: null },
  });
  return res.count === 1;
}

/** In-flight runs this process owns, so shutdown can hand them back rather
 *  than leaving the next boot to wait out a 15-minute lease. */
const inFlight = new Map<string, Promise<void>>();

export function inFlightPasses(): ReadonlySet<string> {
  return new Set(inFlight.keys());
}

/**
 * Claim, run OUTSIDE any transaction, beat while it runs, release at the end.
 *
 * Returns immediately with `started: false` when the claim is lost — the
 * caller does not wait to find out, and a tick that loses is a debug line, not
 * an error.
 *
 * `await`ing the returned `done` promise is optional and only shutdown does it.
 * The cron tick deliberately does not: the whole point is that the tick is
 * fast and DB-only while the pass takes as long as it takes.
 */
export async function runWithLease(
  prisma: PrismaClient,
  passKey: string,
  run: () => Promise<void>,
  opts: { now?: Date; workerId?: string; heartbeatMs?: number } = {},
): Promise<{ started: boolean; reason?: string; done?: Promise<void> }> {
  const workerId = opts.workerId ?? WORKER_ID;
  const claim = await claimPass(prisma, passKey, opts.now ?? new Date(), workerId);
  if (!claim.won) return { started: false, reason: claim.reason };

  // TIMER-driven, not iteration-driven. A pass sitting inside one slow model
  // call is still alive and must keep its lease; a heartbeat that only fired
  // between units would drop the claim on exactly the box this fix is for.
  const beat = setInterval(() => {
    void beatPass(prisma, passKey, new Date(), workerId);
  }, opts.heartbeatMs ?? BRAIN_HEARTBEAT_MS);
  beat.unref?.();

  const done = (async () => {
    try {
      await run();
    } finally {
      clearInterval(beat);
      await releasePass(prisma, passKey, workerId).catch(() => {
        // Best effort. A release that fails leaves the lease to expire, which
        // is the failure this design already tolerates by construction —
        // strictly better than throwing out of a `finally` and masking
        // whatever the pass itself was reporting.
      });
      inFlight.delete(passKey);
    }
  })();

  inFlight.set(passKey, done);
  return { started: true, done };
}

/**
 * Graceful shutdown: wait for what is in flight and let each release its own
 * claim. Without this a redeploy leaves the pass `running` until the lease
 * expires, and the box that just restarted skips its first tick for no reason.
 */
export async function releaseAllPasses(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}
