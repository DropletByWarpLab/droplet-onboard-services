/**
 * WARP-2177 — the claim is exclusive on a REAL Postgres.
 *
 * The mocked suite next door shows the worker's logic; this file shows the
 * property the logic relies on: two workers issuing the conditional
 * `UPDATE … WHERE status = 'queued'` for the same row at the same time get
 * `count` 1 and 0, never 1 and 1. Postgres row locking makes the second
 * writer re-evaluate its WHERE after the first commits, and by then the
 * status is `running`. No advisory lock is involved here on purpose — the
 * cron lock serialises TICKS, but the claim must be safe even without it.
 *
 * Also exercises the migration: the enum, the table and the indexes the
 * worker's scans depend on all have to exist for this to pass.
 *
 * Real-Postgres and gated exactly like the other `*.pg.test.ts` suites.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    AGENT_BLANK_TURN_DEBUG: false,
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "off",
    agentMaxIter: { defaultIter: 10, capIter: 10 },
    agentRuns: {
      concurrency: 1,
      tickMs: 5_000,
      heartbeatMs: 15_000,
      reclaimAfterMs: 60_000,
      maxAttempts: 3,
      maxWallMs: 2_400_000,
    },
  },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("AgentRun claim is exclusive on Postgres (WARP-2177)", () => {
  let prisma: PrismaClient;
  const created: string[] = [];

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterEach(async () => {
    if (created.length > 0) {
      await prisma.agentRun.deleteMany({ where: { id: { in: created } } });
      created.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("two racing workers: exactly one claim succeeds", async () => {
    const { enqueueAgentRun, createAgentRunWorker } = await import(
      "../services/agent-run-worker.service.js"
    );
    const { id } = await enqueueAgentRun(prisma, {
      userId: "00000000-0000-0000-0000-000000000000",
      goal: "race",
      model: "m",
    });
    created.push(id);

    // Executors that never get to run anything: the model is a rejecting
    // stub and the access resolver denies, so the only DB effect is the
    // claim itself.
    const mk = (workerId: string) =>
      createAgentRunWorker({
        prisma,
        agent: {
          mcp: { listTools: async () => [], callTool: async () => ({ isError: true, content: [] }), isStarted: true } as never,
          aiGateway: { chat: async () => { throw new Error("never"); } } as never,
        },
        workerId,
        resolveAccess: (async () => ({ scope: null, tier: null, unresolved: "user_missing" })) as never,
      });
    const a = mk("A");
    const b = mk("B");

    const [ca, cb] = await Promise.all([a.tickOnce(), b.tickOnce()]);
    expect(ca.claimed + cb.claimed).toBe(1);

    // Let the winning executor finish (it fails on attribution immediately).
    while (a.inFlight().size + b.inFlight().size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id } });
    expect(["A", "B"]).toContain(row.claimedBy);
    expect(row.startedAt).not.toBeNull();
    expect(row.deadlineAt).not.toBeNull();
    expect(row.status).toBe("failed");
    expect(row.error).toBe("attribution_failed:user_missing");
  });

  it("the conditional update itself: a second UPDATE on a running row changes nothing", async () => {
    const row = await prisma.agentRun.create({
      data: { userId: "u", goal: "g", model: "m", maxIter: 3 },
    });
    created.push(row.id);
    const first = await prisma.agentRun.updateMany({
      where: { id: row.id, status: "queued" },
      data: { status: "running", claimedBy: "A" },
    });
    const second = await prisma.agentRun.updateMany({
      where: { id: row.id, status: "queued" },
      data: { status: "running", claimedBy: "B" },
    });
    expect(first.count).toBe(1);
    expect(second.count).toBe(0);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: row.id } })).claimedBy).toBe("A");
  });
});
