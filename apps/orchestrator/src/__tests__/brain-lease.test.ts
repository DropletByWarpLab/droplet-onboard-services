/**
 * WARP-2837 (ADR-051) — the brain pass lease, DB-less half.
 *
 * These cases pin the SHAPE of the claim: what predicate it sends, that it
 * fences its beat and release on the claiming worker, and that `runWithLease`
 * does not await the pass. Whether two racers can both win is a property of
 * Postgres, not of this code, and is proved in `brain-lease.pg.test.ts` — a
 * mocked `updateMany` returns whatever count it was told and cannot answer it.
 *
 * WHY THE FENCE MATTERS. `beatPass` and `releasePass` both condition on
 * `claimedBy = workerId`. A process whose lease was reclaimed after a long
 * stall must learn that at its next beat rather than by releasing the
 * SUCCESSOR's claim on its way out — which is precisely what an unconditional
 * update would do, and it would hand the pass to a third process while the
 * second was still running it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  claimPass,
  beatPass,
  releasePass,
  runWithLease,
  BRAIN_LEASE_MS,
  BRAIN_HEARTBEAT_MS,
} from "../services/brain/brain-lease.service";

const NOW = new Date("2033-06-10T12:00:00.000Z");
const KEY = "corpus.documents";
const W = "worker-a";

/** The one argument shape these assertions read back. Typed EXPLICITLY: an
 *  untyped `vi.fn` infers a zero-length tuple, so `mock.calls[0][0]` is a tsc
 *  error under `typecheck:tests` while vitest itself runs it happily —
 *  vitest strips types without checking them (WARP-2606). */
type UpdateArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

function prismaWith(count: number, row: { enabled: boolean } | null = { enabled: true }) {
  const updateMany = vi.fn(async (_args: UpdateArgs) => ({ count }));
  const findUnique = vi.fn(async () => row);
  return {
    client: { brainPass: { updateMany, findUnique } } as unknown as PrismaClient,
    updateMany,
    findUnique,
  };
}

beforeEach(() => vi.useRealTimers());

describe("claimPass (WARP-2837)", () => {
  it("wins when the conditional update touches exactly one row", async () => {
    const { client } = prismaWith(1);
    await expect(claimPass(client, KEY, NOW, W)).resolves.toEqual({ won: true, workerId: W });
  });

  it("claims an IDLE pass or one whose lease has gone stale, and nothing else", async () => {
    const { client, updateMany } = prismaWith(1);
    await claimPass(client, KEY, NOW, W);
    const where = updateMany.mock.calls[0]![0].where as {
      enabled: boolean;
      OR: Array<Record<string, unknown>>;
    };
    // The per-pass switch is IN the predicate, so a disabled pass cannot be
    // started by a tick or by any future manual trigger without either of them
    // remembering to check.
    expect(where.enabled).toBe(true);
    expect(where.OR).toContainEqual({ runState: "idle" });
    expect(where.OR).toContainEqual({
      runState: "running",
      heartbeatAt: { lt: new Date(NOW.getTime() - BRAIN_LEASE_MS) },
    });
    // A `running` row with no heartbeat at all must read as reclaimable, not
    // as held forever by a process that no longer exists.
    expect(where.OR).toContainEqual({ runState: "running", heartbeatAt: null });
  });

  it("stamps the worker, the clock and lastRunAt in the same statement", async () => {
    const { client, updateMany } = prismaWith(1);
    await claimPass(client, KEY, NOW, W);
    expect(updateMany.mock.calls[0]![0].data).toEqual({
      runState: "running",
      claimedBy: W,
      claimedAt: NOW,
      heartbeatAt: NOW,
      lastRunAt: NOW,
    });
  });

  it("reports BUSY when it lost and the pass is enabled", async () => {
    const { client } = prismaWith(0, { enabled: true });
    await expect(claimPass(client, KEY, NOW, W)).resolves.toEqual({
      won: false,
      reason: "busy",
    });
  });

  it("distinguishes DISABLED from busy", async () => {
    // Different answers. A caller that conflates them reports a pass an
    // operator deliberately switched off as a concurrency problem.
    const { client } = prismaWith(0, { enabled: false });
    await expect(claimPass(client, KEY, NOW, W)).resolves.toEqual({
      won: false,
      reason: "disabled",
    });
  });

  it("reports MISSING when there is no such pass row", async () => {
    const { client } = prismaWith(0, null);
    await expect(claimPass(client, KEY, NOW, W)).resolves.toEqual({
      won: false,
      reason: "missing",
    });
  });
});

describe("beatPass / releasePass — the fence (WARP-2837)", () => {
  it("beats only while THIS worker still holds the claim", async () => {
    const { client, updateMany } = prismaWith(1);
    await expect(beatPass(client, KEY, NOW, W)).resolves.toBe(true);
    expect(updateMany.mock.calls[0]![0].where).toEqual({
      passKey: KEY,
      runState: "running",
      claimedBy: W,
    });
  });

  it("reports a LOST lease rather than re-taking it", async () => {
    const { client } = prismaWith(0);
    await expect(beatPass(client, KEY, NOW, W)).resolves.toBe(false);
  });

  it("releases only its own claim, never a successor's", async () => {
    // The case an unconditional update would get wrong: a stalled process
    // waking up and releasing the run that replaced it.
    const { client, updateMany } = prismaWith(0);
    await expect(releasePass(client, KEY, W)).resolves.toBe(false);
    expect(updateMany.mock.calls[0]![0].where).toEqual({
      passKey: KEY,
      runState: "running",
      claimedBy: W,
    });
  });

  it("clears the whole claim on a successful release", async () => {
    const { client, updateMany } = prismaWith(1);
    await releasePass(client, KEY, W);
    expect(updateMany.mock.calls[0]![0].data).toEqual({
      runState: "idle",
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
    });
  });
});

describe("runWithLease (WARP-2837)", () => {
  it("does NOT run the pass when the claim is lost", async () => {
    const { client } = prismaWith(0, { enabled: true });
    const run = vi.fn(async () => {});
    const out = await runWithLease(client, KEY, run, { now: NOW, workerId: W });
    expect(out.started).toBe(false);
    expect(out.reason).toBe("busy");
    expect(run).not.toHaveBeenCalled();
  });

  it("returns BEFORE the pass finishes — the tick must not await ten inferences", async () => {
    // The property the whole fix rests on. If this ever awaits, a corpus run
    // is back on the cron tick's shoulders and the transaction problem
    // returns in a new shape.
    const { client } = prismaWith(1);
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (release = r)));

    const out = await runWithLease(client, KEY, run, { now: NOW, workerId: W });
    expect(out.started).toBe(true);
    expect(run).toHaveBeenCalledOnce();

    let settled = false;
    void out.done!.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // still running, and we already returned

    release();
    await out.done;
    expect(settled).toBe(true);
  });

  it("releases the claim even when the pass THROWS", async () => {
    const { client, updateMany } = prismaWith(1);
    const out = await runWithLease(
      client,
      KEY,
      async () => {
        throw new Error("inference_failed");
      },
      { now: NOW, workerId: W },
    );
    // The rejection belongs to the caller of `done`, not to the tick.
    await expect(out.done).rejects.toThrow("inference_failed");
    const released = updateMany.mock.calls.some(
      (c) => (c[0] as { data?: Record<string, unknown> }).data?.runState === "idle",
    );
    expect(released).toBe(true);
  });

  it("beats on a timer, not per unit — a slow model call keeps its lease", async () => {
    // Iteration-driven beating would drop the claim on exactly the box this
    // fix exists for: one unit is one CPU inference.
    vi.useFakeTimers();
    const { client, updateMany } = prismaWith(1);
    let release!: () => void;
    const out = await runWithLease(client, KEY, () => new Promise<void>((r) => (release = r)), {
      now: NOW,
      workerId: W,
      heartbeatMs: 1000,
    });
    updateMany.mockClear();
    await vi.advanceTimersByTimeAsync(3500);
    expect(updateMany.mock.calls.length).toBeGreaterThanOrEqual(3);
    release();
    await out.done;
    vi.useRealTimers();
  });

  it("keeps the heartbeat well inside the lease", () => {
    // The ratio is what absorbs a slow unit or a paused container without
    // losing the claim.
    expect(BRAIN_HEARTBEAT_MS * 5).toBeLessThanOrEqual(BRAIN_LEASE_MS);
  });
});
