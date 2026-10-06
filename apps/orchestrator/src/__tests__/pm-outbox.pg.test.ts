/**
 * ADR-069 §7 — what the PmActivity outbox promises, against a real
 * Postgres.
 *
 * The unit file (`services/pm/pm-outbox.test.ts`) proves the control flow
 * against an in-memory Prisma that interprets exactly the query shape the
 * framework issues. Four things it cannot prove, because they are Postgres's:
 *
 *   * the order of rows that share a millisecond (`createMany` stamps one
 *     timestamp on every row and the ids are random UUIDs);
 *   * a rolled-back transaction's rows are never visible to a consumer;
 *   * a transaction that commits late, BEHIND a younger row, is not lost —
 *     the gap the settle window exists to close;
 *   * the advisory lock really keeps a second sweeper out.
 *
 * Every fixture here uses a fake clock in 2099 and explicit `createdAt`s, so a
 * real PmActivity row written by a concurrently running pg suite (2026) is
 * before every cursor and cannot leak into an assertion. The one test that must
 * use the real clock (the end-to-end nudge) filters on its own work item.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { PmActivity, PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PmActivity outbox — what only Postgres can prove ", () => {
  let prisma: PrismaClient;
  let pm: typeof import("../services/pm/pm-outbox.js");
  let cron: typeof import("../services/cron-runtime.service.js");
  let workItemId = "";

  const OURS = { startsWith: "pm-outbox-test-" } as const;
  const FLAGS = { startsWith: "pm-outbox:pm-outbox-test-" } as const;

  /** A deterministic instant in 2099, `s` seconds past a fixed origin. */
  const T0 = Date.parse("2099-01-01T00:00:00.000Z");
  const at = (seconds: number) => new Date(T0 + seconds * 1000);

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new RealPrismaClient();
    await prisma.$connect();
    pm = await import("../services/pm/pm-outbox.js");
    cron = await import("../services/cron-runtime.service.js");
  });

  afterAll(async () => {
    await prisma.systemFlag.deleteMany({ where: { key: FLAGS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.systemFlag.deleteMany({ where: { key: FLAGS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `pm-outbox-test-ws-${Date.now()}`, name: "pm-outbox-test" },
    });
    const project = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "pm-outbox-test-project", identifier: "W32O" },
    });
    const item = await prisma.pmWorkItem.create({
      data: { projectId: project.id, sequenceId: 1, name: "pm-outbox-test-item" },
    });
    workItemId = item.id;
  });

  afterEach(() => {
    pm.stopOutbox();
  });

  const row = (createdAt: Date, verb: PmActivity["verb"] = "updated") =>
    prisma.pmActivity.create({ data: { workItemId, verb, createdAt } });

  /** Park a consumer's cursor so only fixtures after `from` are in play. */
  const parkCursor = (name: string, from: Date) =>
    prisma.systemFlag.upsert({
      where: { key: `pm-outbox:${name}` },
      create: { key: `pm-outbox:${name}`, valueJson: { createdAt: from.toISOString(), id: "" } },
      update: { valueJson: { createdAt: from.toISOString(), id: "" } },
    });

  const consumer = (name: string, over: Partial<import("../services/pm/pm-outbox.js").OutboxConsumer> = {}) => {
    const seen: PmActivity[] = [];
    return {
      seen,
      def: {
        name,
        intervalMs: 60_000,
        settleMs: 0,
        handle: async (r: PmActivity) => {
          if (r.workItemId === workItemId) seen.push(r);
        },
        ...over,
      },
    };
  };

  // ── order ────────────────────────────────────────────────────────────────

  it("delivers rows that share a millisecond exactly once, in (createdAt, id) order, across batches", async () => {
    await parkCursor("pm-outbox-test-order", at(-1));
    // One timestamp, seven random UUIDs: the id is the only tiebreaker there is.
    await prisma.pmActivity.createMany({
      data: Array.from({ length: 7 }, () => ({ workItemId, verb: "updated" as const, createdAt: at(10) })),
    });
    await row(at(11));
    await row(at(9));

    const c = consumer("pm-outbox-test-order", { batchSize: 3 });
    await pm.runOutboxSweep(prisma, c.def, { now: () => at(100) });

    const expected = await prisma.pmActivity.findMany({
      where: { workItemId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(expected).toHaveLength(9);
    expect(c.seen.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    expect(new Set(c.seen.map((r) => r.id)).size).toBe(9);

    // And nothing is delivered twice by a second sweep.
    await pm.runOutboxSweep(prisma, c.def, { now: () => at(100) });
    expect(c.seen).toHaveLength(9);
  });

  it("resumes after a partial sweep without repeating or skipping a row", async () => {
    await parkCursor("pm-outbox-test-resume", at(-1));
    await prisma.pmActivity.createMany({
      data: Array.from({ length: 5 }, () => ({ workItemId, verb: "updated" as const, createdAt: at(10) })),
    });
    const c = consumer("pm-outbox-test-resume", { batchSize: 2 });
    let calls = 0;
    c.def.handle = async (r: PmActivity) => {
      calls += 1;
      if (calls === 3) throw new Error("fails on the third row");
      c.seen.push(r);
    };

    await expect(pm.runOutboxSweep(prisma, c.def, { now: () => at(100) })).rejects.toThrow("third row");
    expect(c.seen).toHaveLength(2);

    calls = 100; // never fail again
    await pm.runOutboxSweep(prisma, c.def, { now: () => at(100) });
    expect(c.seen).toHaveLength(5);
    expect(new Set(c.seen.map((r) => r.id)).size).toBe(5);
  });

  // ── starts at now ────────────────────────────────────────────────────────

  it("a brand-new consumer never replays history", async () => {
    await row(at(-3000)); // a year-old edit
    await row(at(5));

    const c = consumer("pm-outbox-test-new");
    // First sweep, at t=10: no cursor yet, so one is created AT t=10.
    await pm.runOutboxSweep(prisma, c.def, { now: () => at(10) });
    expect(c.seen).toHaveLength(0);
    expect(await prisma.systemFlag.findUnique({ where: { key: "pm-outbox:pm-outbox-test-new" } })).toMatchObject({
      valueJson: { createdAt: at(10).toISOString(), id: "" },
    });

    // Only what happens afterwards is delivered.
    const later = await row(at(20));
    await pm.runOutboxSweep(prisma, c.def, { now: () => at(30) });
    expect(c.seen.map((r) => r.id)).toEqual([later.id]);
  });

  it("two consumers keep separate cursors over the same rows", async () => {
    await parkCursor("pm-outbox-test-a", at(-1));
    await parkCursor("pm-outbox-test-b", at(-1));
    await row(at(1));
    await row(at(2));
    const a = consumer("pm-outbox-test-a");
    const b = consumer("pm-outbox-test-b");

    await pm.runOutboxSweep(prisma, a.def, { now: () => at(100) });
    expect(a.seen).toHaveLength(2);
    expect(b.seen).toHaveLength(0);

    await pm.runOutboxSweep(prisma, b.def, { now: () => at(100) });
    expect(b.seen).toHaveLength(2);
    const keys = await prisma.systemFlag.findMany({ where: { key: FLAGS }, select: { key: true } });
    expect(keys.map((k) => k.key).sort()).toEqual(["pm-outbox:pm-outbox-test-a", "pm-outbox:pm-outbox-test-b"]);
  });

  // ── transactions ─────────────────────────────────────────────────────────

  it("never sees a row from a transaction that rolled back", async () => {
    await parkCursor("pm-outbox-test-rollback", at(-1));
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.pmActivity.create({ data: { workItemId, verb: "created", createdAt: at(1) } });
        throw new Error("the mutation failed after its activity row was written");
      }),
    ).rejects.toThrow("mutation failed");

    const c = consumer("pm-outbox-test-rollback");
    await pm.runOutboxSweep(prisma, c.def, { now: () => at(100) });
    expect(c.seen).toHaveLength(0);
  });

  /** Open a transaction that has inserted `createdAt` and stays open until released. */
  async function holdOpen(createdAt: Date) {
    let release!: () => void;
    let inserted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (inserted = r));
    const done = prisma.$transaction(
      async (tx) => {
        await tx.pmActivity.create({ data: { workItemId, verb: "updated", createdAt } });
        inserted();
        await gate;
      },
      { timeout: 30_000 },
    );
    await ready;
    return { commit: () => { release(); return done; } };
  }

  it("does not skip a transaction that commits late, behind a younger row that committed first (the settle window)", async () => {
    await parkCursor("pm-outbox-test-gap", at(-1));

    // A is slow: it inserted at t=1 and has not committed. B inserted at t=2
    // and committed at once. Ordered by createdAt, A is first and B second.
    const slow = await holdOpen(at(1));
    await row(at(2));

    const c = consumer("pm-outbox-test-gap", { settleMs: 6_000 });
    // t=3: both rows are younger than the 6 s settle window, so NEITHER is read,
    // and the cursor stays where it was.
    await pm.runOutboxSweep(prisma, c.def, { now: () => at(3) });
    expect(c.seen).toHaveLength(0);

    await slow.commit();

    // t=10: both have settled; both are delivered, A before B.
    await pm.runOutboxSweep(prisma, c.def, { now: () => at(10) });
    expect(c.seen.map((r) => r.createdAt.toISOString())).toEqual([at(1).toISOString(), at(2).toISOString()]);
  });

  it("…and that is the failure the window prevents: with no settle window the late commit is lost for good", async () => {
    // The contrast case, kept so the window cannot be 'simplified' away: the
    // same two writers, read at settleMs: 0.
    await parkCursor("pm-outbox-test-nogap", at(-1));
    const slow = await holdOpen(at(1));
    await row(at(2));

    const c = consumer("pm-outbox-test-nogap", { settleMs: 0 });
    await pm.runOutboxSweep(prisma, c.def, { now: () => at(3) });
    expect(c.seen.map((r) => r.createdAt.toISOString())).toEqual([at(2).toISOString()]);

    await slow.commit();
    await pm.runOutboxSweep(prisma, c.def, { now: () => at(10) });
    // A's row (t=1) is behind the cursor (t=2): never delivered.
    expect(c.seen).toHaveLength(1);
  });

  // ── the scheduler ────────────────────────────────────────────────────────

  /** Wait for `check` to hold, polling; the real clock, short, bounded. */
  async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("condition not reached in time");
  }

  it("a write wakes the consumer through the real cron runtime and advisory lock, long before the interval", async () => {
    const runtime = cron.createCronRuntime(prisma as never);
    const c = consumer("pm-outbox-test-nudge", { intervalMs: 60_000, settleMs: 0 });
    try {
      pm.registerOutboxConsumer(c.def, { prisma, cronRuntime: runtime });
      // The registration run creates the cursor at 'now'. A row written before
      // that would be history, so wait for it.
      await until(async () => (await prisma.systemFlag.findUnique({ where: { key: "pm-outbox:pm-outbox-test-nudge" } })) !== null);

      const written = await prisma.pmActivity.create({ data: { workItemId, verb: "created" } });
      pm.nudgeOutbox();

      await until(() => c.seen.length === 1);
      expect(c.seen[0]!.id).toBe(written.id);
    } finally {
      runtime.stop();
    }
  });

  it("a second sweeper is kept out by the advisory lock until the first lets go", async () => {
    const runtime = cron.createCronRuntime(prisma as never);
    const c = consumer("pm-outbox-test-lock", { intervalMs: 60_000, settleMs: 0 });
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holding = new Promise<void>((r) => (locked = r));
    // Another replica, mid-sweep: the same key cron-runtime derives for this consumer.
    const other = prisma.$transaction(
      async (tx) => {
        // $executeRaw, not $queryRaw: the function returns void, which Prisma
        // cannot deserialize as a result column.
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', "droplet:pm-outbox:pm-outbox-test-lock");
        locked();
        await gate;
      },
      { timeout: 30_000 },
    );
    try {
      await holding;
      await parkCursor("pm-outbox-test-lock", new Date(Date.now() - 60_000));
      const written = await prisma.pmActivity.create({ data: { workItemId, verb: "created" } });

      pm.registerOutboxConsumer(c.def, { prisma, cronRuntime: runtime }); // immediate run — skipped, lock is held
      await new Promise((r) => setTimeout(r, 400));
      expect(c.seen).toHaveLength(0);

      release();
      await other;
      pm.nudgeOutbox();
      await until(() => c.seen.length === 1);
      expect(c.seen[0]!.id).toBe(written.id);
    } finally {
      release();
      await other.catch(() => undefined);
      runtime.stop();
    }
  });
});
