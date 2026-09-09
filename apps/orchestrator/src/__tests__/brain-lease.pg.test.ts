/**
 * WARP-2837 (ADR-051) — the claim, against real Postgres.
 *
 * 🔴 THIS FILE IS THE PROOF, and only this file can be. The fix replaces a
 * transaction-scoped advisory lock with a conditional `updateMany`, and the
 * entire claim is that **two racers cannot both see `count === 1`**. A mocked
 * `updateMany` returns the count it was told; it cannot answer whether
 * Postgres serialises two concurrent UPDATEs against the same row. The DB-less
 * suite deliberately covers only the predicate's shape.
 *
 * `agent-run-claim.pg.test.ts` proves the same property for the run queue, for
 * the same reason. This is that test, for the pass row.
 *
 * What these cases pin:
 *
 *   exclusion    — concurrent claims: exactly ONE wins, always.
 *   skip         — the loser gets `busy`. It does not queue, block or retry;
 *                  a pass is a cursor and the next tick starts where this one
 *                  would have.
 *   the lease    — a claim older than the window IS reclaimable, and one
 *                  inside it is not. This is what stops a SIGKILLed process
 *                  wedging the pass forever, and what stops a merely-slow one
 *                  being run twice.
 *   the fence    — a reclaimed worker cannot beat or release the successor's
 *                  claim. Without it, a stalled process waking up hands the
 *                  pass to a third while the second is still running it.
 *   disabled     — `enabled: false` is in the predicate, so the per-pass
 *                  switch is honoured by the claim itself.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL like every other `*.pg.test.ts`.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 *
 * FIXTURE SCOPING — this DB is shared and the lane runs --no-file-parallelism.
 * Every row this suite touches has a `passKey` prefixed `warp2837-`, and
 * cleanup is scoped to that prefix. It must never touch the real
 * `detectors` / `corpus.documents` rows, which other suites seed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  claimPass,
  beatPass,
  releasePass,
  BRAIN_LEASE_MS,
} from "../services/brain/brain-lease.service";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const P = "warp2837-";
const KEY = `${P}corpus`;
const NOW = new Date("2033-06-10T12:00:00.000Z");

describe.skipIf(!RUN)("brain pass claim — real Postgres (WARP-2837)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // `setup.ts` mocks `@prisma/client` GLOBALLY for the DB-less lane, so a
    // plain `new PrismaClient()` would return the mock and every assertion
    // here would be vacuous.
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.brainPass.deleteMany({ where: { passKey: { startsWith: P } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.brainPass.deleteMany({ where: { passKey: { startsWith: P } } });
    await prisma.brainPass.create({ data: { passKey: KEY } });
  });

  it("EXACTLY ONE of two concurrent claims wins", async () => {
    // The property the whole fix rests on. Fired together, resolved together —
    // no ordering imposed by the test.
    const [a, b] = await Promise.all([
      claimPass(prisma, KEY, NOW, "worker-a"),
      claimPass(prisma, KEY, NOW, "worker-b"),
    ]);
    const winners = [a, b].filter((r) => r.won);
    expect(winners).toHaveLength(1);
    const losers = [a, b].filter((r) => !r.won);
    expect(losers[0]).toMatchObject({ won: false, reason: "busy" });
  });

  it("holds against a wider stampede", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimPass(prisma, KEY, NOW, `worker-${i}`)),
    );
    expect(results.filter((r) => r.won)).toHaveLength(1);
  });

  it("the loser SKIPS — the row still belongs to the winner", async () => {
    const first = await claimPass(prisma, KEY, NOW, "worker-a");
    expect(first.won).toBe(true);
    const second = await claimPass(prisma, KEY, NOW, "worker-b");
    expect(second).toEqual({ won: false, reason: "busy" });

    const row = await prisma.brainPass.findUnique({
      where: { passKey: KEY },
      select: { runState: true, claimedBy: true },
    });
    expect(row).toMatchObject({ runState: "running", claimedBy: "worker-a" });
  });

  it("does NOT reclaim a claim that is still inside its lease", async () => {
    await claimPass(prisma, KEY, NOW, "worker-a");
    // One second short of the window.
    const justInside = new Date(NOW.getTime() + BRAIN_LEASE_MS - 1000);
    await expect(claimPass(prisma, KEY, justInside, "worker-b")).resolves.toEqual({
      won: false,
      reason: "busy",
    });
  });

  it("DOES reclaim a claim whose lease has expired", async () => {
    // The SIGKILL case: the holder is gone and will never beat again. Without
    // this the pass is wedged forever and /coverage, which reports lastRunAt,
    // cannot tell you.
    await claimPass(prisma, KEY, NOW, "worker-a");
    const past = new Date(NOW.getTime() + BRAIN_LEASE_MS + 1000);
    const b = await claimPass(prisma, KEY, past, "worker-b");
    expect(b).toEqual({ won: true, workerId: "worker-b" });

    const row = await prisma.brainPass.findUnique({
      where: { passKey: KEY },
      select: { claimedBy: true },
    });
    expect(row?.claimedBy).toBe("worker-b");
  });

  it("a heartbeat KEEPS the claim past what would otherwise be its lease", async () => {
    await claimPass(prisma, KEY, NOW, "worker-a");
    const later = new Date(NOW.getTime() + BRAIN_LEASE_MS - 1000);
    expect(await beatPass(prisma, KEY, later, "worker-a")).toBe(true);

    // Now past the ORIGINAL lease, but inside the beaten one.
    const afterOriginal = new Date(NOW.getTime() + BRAIN_LEASE_MS + 1000);
    await expect(claimPass(prisma, KEY, afterOriginal, "worker-b")).resolves.toEqual({
      won: false,
      reason: "busy",
    });
  });

  it("a RECLAIMED worker cannot beat, and learns it", async () => {
    await claimPass(prisma, KEY, NOW, "worker-a");
    const past = new Date(NOW.getTime() + BRAIN_LEASE_MS + 1000);
    await claimPass(prisma, KEY, past, "worker-b");

    // worker-a wakes up. The fence is what tells it to stop.
    expect(await beatPass(prisma, KEY, past, "worker-a")).toBe(false);
  });

  it("a RECLAIMED worker cannot release the successor's claim", async () => {
    // The case an unconditional update gets wrong, and it is not benign: it
    // would hand the pass to a third process while the second still runs it.
    await claimPass(prisma, KEY, NOW, "worker-a");
    const past = new Date(NOW.getTime() + BRAIN_LEASE_MS + 1000);
    await claimPass(prisma, KEY, past, "worker-b");

    expect(await releasePass(prisma, KEY, "worker-a")).toBe(false);
    const row = await prisma.brainPass.findUnique({
      where: { passKey: KEY },
      select: { runState: true, claimedBy: true },
    });
    expect(row).toMatchObject({ runState: "running", claimedBy: "worker-b" });
  });

  it("release hands the pass back, and the next claim wins", async () => {
    await claimPass(prisma, KEY, NOW, "worker-a");
    expect(await releasePass(prisma, KEY, "worker-a")).toBe(true);
    await expect(claimPass(prisma, KEY, NOW, "worker-b")).resolves.toEqual({
      won: true,
      workerId: "worker-b",
    });
  });

  it("refuses to claim a DISABLED pass, and says so", async () => {
    await prisma.brainPass.update({ where: { passKey: KEY }, data: { enabled: false } });
    await expect(claimPass(prisma, KEY, NOW, "worker-a")).resolves.toEqual({
      won: false,
      reason: "disabled",
    });
    const row = await prisma.brainPass.findUnique({
      where: { passKey: KEY },
      select: { runState: true },
    });
    expect(row?.runState).toBe("idle");
  });

  it("reports MISSING for a pass row that does not exist", async () => {
    await expect(claimPass(prisma, `${P}nope`, NOW, "worker-a")).resolves.toEqual({
      won: false,
      reason: "missing",
    });
  });

  it("BOOT SEQUENCE: the claim never creates the row, so only seeding bootstraps a pass", async () => {
    // The fresh-install deadlock, in the database that has to answer it.
    // Before the lease, the corpus row was created by `runCorpusPass`'s own
    // upsert on tick 1. Now the tick claims FIRST, and a conditional
    // `updateMany` against a row that does not exist matches nothing — so the
    // run that would have created it never happens, on every tick, forever.
    const key = `${P}boot`;
    await expect(claimPass(prisma, key, NOW, "worker-a")).resolves.toEqual({
      won: false,
      reason: "missing",
    });
    expect(await prisma.brainPass.findUnique({ where: { passKey: key } })).toBeNull();

    // Seeding is the only bootstrap there is. This is the upsert
    // `seedBrainPasses` now performs for EVERY key in `BRAIN_PASS_KEYS`, the
    // corpus pass included; the DB-less suite pins that list.
    await prisma.brainPass.upsert({
      where: { passKey: key },
      create: { passKey: key },
      update: {},
    });
    await expect(claimPass(prisma, key, NOW, "worker-a")).resolves.toEqual({
      won: true,
      workerId: "worker-a",
    });
  });
});
