/**
 * WARP-2177 — the durable agent-run worker, driven from a test.
 *
 * Every acceptance criterion of the ticket that a mocked Prisma can hold:
 *
 *   - a claim flips the row to `running` with the lease fields, in one
 *     transaction, and two workers racing one row yield exactly one claim
 *     (the real-Postgres proof is `agent-run-claim.pg.test.ts`);
 *   - a checkpoint `{ iteration, messages }` lands before every iteration;
 *   - a worker that dies between two iterations is reclaimed and the run
 *     RESUMES from the last checkpoint, spending only the remaining
 *     iterations, and lands the SAME final answer as an uninterrupted run;
 *   - the replay guard: a `send_notification` that already fired before the
 *     crash is fed back from the trace, never dispatched again;
 *   - `attempts` is bounded — a stale lease past the bound fails the run
 *     with an error naming the count;
 *   - tool reach is re-resolved at claim time from the attributed user, and
 *     an unresolvable principal does not run;
 *   - `AGENT_RUN_CONCURRENCY` (1) holds a second queued run back;
 *   - the wall-clock ceiling and cancellation both stop a run before its
 *     next tool dispatch, through the loop's own `AbortController`;
 *   - a Tier-2 tool fails the run with a reason naming WARP-2179 and is
 *     never dispatched;
 *   - every dispatch carries `agentRunId` on its tool-call context.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  createAgentRunWorker,
  enqueueAgentRun,
  cancelAgentRun,
  tier1ToolPool,
  type AgentRunTraceEntry,
} from "../services/agent-run-worker.service.js";
import { DENY_ALL_TOOL_SCOPE } from "../services/tool-access.service.js";
import { createAgentRunPrismaMock } from "./helpers/agent-run-prisma-mock.js";

// ── a deterministic "model" ─────────────────────────────────────────────
//
// Decides from the CONVERSATION, not from a call counter, so a resumed run
// makes the same decisions an uninterrupted one made: with no tool replies
// yet it asks the time, with one it notifies, with two it answers.

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

function scriptedModel(
  script: (toolReplies: number, messages: Array<{ role: string }>) => unknown,
) {
  return vi.fn(async (req: { messages: Array<{ role: string }> }) => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: script(
            req.messages.filter((m) => m.role === "tool").length,
            req.messages,
          ),
        },
      ],
    }),
  }));
}

const threeStep = (toolReplies: number) => {
  if (toolReplies === 0) {
    return { role: "assistant", content: null, tool_calls: [toolCall("c1", "get_current_datetime", {})] };
  }
  if (toolReplies === 1) {
    return {
      role: "assistant",
      content: null,
      tool_calls: [toolCall("c2", "send_notification", { title: "Done", body: "noon" })],
    };
  }
  return { role: "assistant", content: "Notified you at noon." };
};

function fakeMcp(tools: string[] = ["get_current_datetime", "send_notification"]) {
  const callTool = vi.fn(async (name: string, _args?: unknown, _ctx?: unknown) => ({
    isError: false,
    content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name, at: "noon" }) }],
  }));
  return {
    mcp: {
      listTools: vi.fn().mockResolvedValue(tools.map((name) => ({ name, description: "d", inputSchema: {} }))),
      callTool,
      isStarted: true,
    } as never,
    callTool,
  };
}

/**
 * The crash seam: the DB "dies" at the checkpoint for `iteration`, and STAYS
 * dead for every later call from that worker — a real crash writes nothing
 * after the failing write, so the dying executor must not get to record a
 * terminal status either.
 */
function dieAtCheckpoint(iteration: number) {
  let dead = false;
  return (op: string, args: Record<string, unknown>) => {
    const data = (args as { data?: Record<string, unknown> }).data;
    if (op === "updateMany" && data?.iteration === iteration && data && "messages" in data) dead = true;
    return dead;
  };
}

const OWNER = { id: "u-owner", username: "romain", role: "owner" };
const ownerAccess = vi.fn(async () => ({ scope: null, tier: "owner", unresolved: null }));

function makeWorker(
  db: ReturnType<typeof createAgentRunPrismaMock>,
  overrides: Partial<Parameters<typeof createAgentRunWorker>[0]> & {
    chat?: ReturnType<typeof scriptedModel>;
    mcp?: ReturnType<typeof fakeMcp>;
  } = {},
) {
  const chat = overrides.chat ?? scriptedModel(threeStep);
  const m = overrides.mcp ?? fakeMcp();
  const worker = createAgentRunWorker({
    prisma: db.prisma,
    agent: { mcp: m.mcp, aiGateway: { chat } as never },
    workerId: overrides.workerId ?? "worker-A",
    now: overrides.now,
    resolveAccess: (overrides.resolveAccess ?? ownerAccess) as never,
    toolSelectionMode: "off",
    limits: overrides.limits,
  });
  return { worker, chat, callTool: m.callTool };
}

async function settle(worker: ReturnType<typeof createAgentRunWorker>) {
  // Drain the tracked executions.
  while (worker.inFlight().size > 0) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  recordActivityMock.mockClear();
  ownerAccess.mockClear();
});

describe("agent-run worker — claim + lease (WARP-2177)", () => {
  it("claims a queued run: running + claimedBy/claimedAt/startedAt/deadlineAt, and executes it", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "tell me the time", model: "m" });
    const { worker, chat, callTool } = makeWorker(db);

    const counts = await worker.tickOnce();
    expect(counts.claimed).toBe(1);
    const mid = db.row(id);
    expect(mid.status).toBe("running");
    expect(mid.claimedBy).toBe("worker-A");
    expect(mid.claimedAt).toBeInstanceOf(Date);
    expect(mid.startedAt).toBeInstanceOf(Date);
    expect(mid.deadlineAt!.getTime() - mid.startedAt!.getTime()).toBe(2_400_000);
    expect(db.prisma.$transaction).toHaveBeenCalledTimes(1);

    await settle(worker);
    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("Notified you at noon.");
    expect(done.stopReason).toBe("model_done");
    expect(done.iteration).toBe(3);
    expect(done.endedAt).toBeInstanceOf(Date);
    expect(chat).toHaveBeenCalledTimes(3);
    expect(callTool).toHaveBeenCalledTimes(2);
    // Every dispatch carries the run id for the tool_call ActivityRow.
    for (const call of callTool.mock.calls) {
      expect(call[2]).toMatchObject({ agentRunId: id, userId: "romain", userRole: "owner" });
    }
  });

  it("two workers racing one row: exactly one claims", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    const a = makeWorker(db, { workerId: "A" });
    const b = makeWorker(db, { workerId: "B" });
    const [ca, cb] = await Promise.all([a.worker.tickOnce(), b.worker.tickOnce()]);
    expect(ca.claimed + cb.claimed).toBe(1);
    await Promise.all([settle(a.worker), settle(b.worker)]);
    expect(db.rows[0]!.status).toBe("succeeded");
  });

  it("AGENT_RUN_CONCURRENCY=1: a second queued run waits while the first is in flight", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "one", model: "m" });
    await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "two", model: "m" });
    // A model that never answers until released keeps the first run in flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const chat = vi.fn(async () => {
      await gate;
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
    });
    const { worker } = makeWorker(db, { chat: chat as never });
    expect((await worker.tickOnce()).claimed).toBe(1);
    expect((await worker.tickOnce()).claimed).toBe(0);
    expect(db.rows.filter((r) => r.status === "queued")).toHaveLength(1);
    release();
    await settle(worker);
    expect((await worker.tickOnce()).claimed).toBe(1);
    await settle(worker);
    expect(db.rows.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
  });
});

describe("agent-run worker — checkpoint, crash, resume (WARP-2177)", () => {
  it("writes { iteration, messages } before every iteration and completes the trace around each dispatch", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    const { worker } = makeWorker(db);
    const checkpoints: number[] = [];
    db.prisma.agentRun.updateMany.mockImplementation(
      (((orig) => async (args: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        if ("messages" in args.data) checkpoints.push(args.data.iteration as number);
        return orig(args);
      })(db.prisma.agentRun.updateMany.getMockImplementation()!)) as never,
    );
    await worker.tickOnce();
    await settle(worker);
    expect(checkpoints).toEqual([0, 1, 2]);
    const trace = db.row(id).trace as AgentRunTraceEntry[];
    expect(trace.map((e) => [e.tool, e.iteration, typeof e.text])).toEqual([
      ["get_current_datetime", 0, "string"],
      ["send_notification", 1, "string"],
    ]);
    expect(trace.every((e) => e.dispatchedAt && e.completedAt)).toBe(true);
  });

  it("a worker killed between iterations is reclaimed; the resumed run spends only the remaining iterations and lands the same answer", async () => {
    // Reference: the uninterrupted answer.
    const ref = createAgentRunPrismaMock({ users: [OWNER] });
    await enqueueAgentRun(ref.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    const refWorker = makeWorker(ref);
    await refWorker.worker.tickOnce();
    await settle(refWorker.worker);
    const expected = ref.rows[0]!.result;
    expect(expected).toBe("Notified you at noon.");

    // Interrupted: the DB "goes away" exactly when iteration 2's checkpoint
    // is written — after iteration 1 (the notification) completed.
    let clock = new Date("2026-09-04T12:00:00Z");
    const now = () => clock;
    const db = createAgentRunPrismaMock({ users: [OWNER], now });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    const a = makeWorker(db, { workerId: "A", now });
    db.setFailOn(dieAtCheckpoint(2));
    await a.worker.tickOnce();
    await settle(a.worker);
    db.setFailOn(null);
    const crashed = db.row(id);
    expect(crashed.status).toBe("running"); // the dead worker never wrote a terminal
    expect(crashed.iteration).toBe(1);
    expect(a.callTool.mock.calls.map((c) => c[0])).toEqual(["get_current_datetime", "send_notification"]);

    // Time passes; B's tick reclaims the stale lease, then claims and resumes.
    clock = new Date(clock.getTime() + 61_000);
    const b = makeWorker(db, { workerId: "B", now });
    const first = await b.worker.tickOnce();
    expect(first.reclaimed).toBe(1);
    expect(first.claimed).toBe(1);
    await settle(b.worker);

    const resumed = db.row(id);
    expect(resumed.status).toBe("succeeded");
    expect(resumed.result).toBe(expected);
    expect(resumed.attempts).toBe(1);
    expect(resumed.claimedBy).toBe("B");
    // Resumed from iteration 1: only iterations 1 and 2 ran again (2 model
    // calls), not the whole run (3).
    expect(b.chat).toHaveBeenCalledTimes(2);
    expect(resumed.iteration).toBe(3);
  });

  it("replay guard: a send_notification that already fired is fed back from the trace, never re-sent", async () => {
    let clock = new Date("2026-09-04T12:00:00Z");
    const now = () => clock;
    const db = createAgentRunPrismaMock({ users: [OWNER], now });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    const a = makeWorker(db, { workerId: "A", now });
    db.setFailOn(dieAtCheckpoint(2));
    await a.worker.tickOnce();
    await settle(a.worker);
    db.setFailOn(null);
    expect(a.callTool.mock.calls.filter((c) => c[0] === "send_notification")).toHaveLength(1);

    clock = new Date(clock.getTime() + 61_000);
    const b = makeWorker(db, { workerId: "B", now });
    await b.worker.tickOnce();
    await settle(b.worker);

    // B's model re-issued send_notification (same conversation → same
    // decision); the worker replayed it from the trace.
    expect(b.callTool.mock.calls.filter((c) => c[0] === "send_notification")).toHaveLength(0);
    expect(b.callTool.mock.calls.filter((c) => c[0] === "get_current_datetime")).toHaveLength(0);
    const trace = db.row(id).trace as AgentRunTraceEntry[];
    const replayed = trace.find((e) => e.replayOf);
    expect(replayed).toMatchObject({ tool: "send_notification", iteration: 1, replayOf: "c2" });
    expect(db.row(id).status).toBe("succeeded");
    // And the model saw the ORIGINAL result as the tool reply.
    const lastReq = b.chat.mock.calls.at(-1)![0] as { messages: Array<{ role: string; content: string }> };
    const toolReplies = lastReq.messages.filter((m) => m.role === "tool");
    expect(toolReplies).toHaveLength(2);
    expect(String(toolReplies[1]!.content)).toContain('"tool":"send_notification"');
  });

  it("attempts is bounded: a stale lease past AGENT_RUN_MAX_ATTEMPTS fails the run naming the count", async () => {
    let clock = new Date("2026-09-04T12:00:00Z");
    const now = () => clock;
    const db = createAgentRunPrismaMock({ users: [OWNER], now });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    const row = db.row(id);
    row.status = "running";
    row.claimedBy = "dead-worker";
    row.heartbeatAt = new Date(clock.getTime() - 120_000);
    row.attempts = 3;
    const { worker } = makeWorker(db, { now });
    const counts = await worker.tickOnce();
    expect(counts).toEqual({ reclaimed: 0, failed: 1, claimed: 0 });
    expect(db.row(id).status).toBe("failed");
    expect(db.row(id).error).toMatch(/lease lost 4 time\(s\) \(AGENT_RUN_MAX_ATTEMPTS=3\)/);
    expect(db.row(id).error).toContain("dead-worker");
  });

  it("a stale lease under the bound is re-queued with attempts + 1", async () => {
    let clock = new Date("2026-09-04T12:00:00Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => clock });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    Object.assign(db.row(id), {
      status: "running",
      claimedBy: "dead-worker",
      heartbeatAt: new Date(clock.getTime() - 120_000),
      attempts: 1,
    });
    // Concurrency 0 capacity: fill the slot so the tick only reclaims.
    const { worker } = makeWorker(db, { now: () => clock, limits: {
      concurrency: 0, tickMs: 5_000, heartbeatMs: 15_000, reclaimAfterMs: 60_000, maxAttempts: 3, maxWallMs: 2_400_000,
    } });
    expect(await worker.tickOnce()).toEqual({ reclaimed: 1, failed: 0, claimed: 0 });
    expect(db.row(id)).toMatchObject({ status: "queued", attempts: 2, claimedBy: null, heartbeatAt: null });
  });
});

describe("agent-run worker — access, tiers, ceilings, cancellation (WARP-2177)", () => {
  it("re-resolves tool reach at claim time from the attributed user and advertises only what it allows", async () => {
    const db = createAgentRunPrismaMock({ users: [{ id: "u-fam", username: "kid", role: "family" }] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: "u-fam", goal: "g", model: "m" });
    // A narrowed role: only the `data` domain (get_current_datetime lives
    // there); notifications are out of reach.
    const resolveAccess = vi.fn(async () => ({
      scope: { domains: new Set(["data"]), writeDomains: new Set<string>(), locks: false },
      tier: "family",
      unresolved: null,
    }));
    const chat = scriptedModel(() => ({ role: "assistant", content: "ok" }));
    const { worker } = makeWorker(db, { resolveAccess: resolveAccess as never, chat });
    await worker.tickOnce();
    await settle(worker);
    expect(resolveAccess).toHaveBeenCalledWith(db.prisma, "u-fam");
    const advertised = (chat.mock.calls[0]![0] as unknown as { tools: Array<{ function: { name: string } }> }).tools.map(
      (t) => t.function.name,
    );
    expect(advertised).toEqual(["get_current_datetime"]);
    expect(db.row(id).status).toBe("succeeded");
  });

  it("an unresolvable principal does not run: failed with the attribution reason, audited", async () => {
    const db = createAgentRunPrismaMock();
    const { id } = await enqueueAgentRun(db.prisma, { userId: "u-gone", goal: "g", model: "m" });
    const resolveAccess = vi.fn(async () => ({ scope: DENY_ALL_TOOL_SCOPE, tier: null, unresolved: "user_missing" }));
    const { worker, chat } = makeWorker(db, { resolveAccess: resolveAccess as never });
    await worker.tickOnce();
    await settle(worker);
    expect(db.row(id).status).toBe("failed");
    expect(db.row(id).error).toBe("attribution_failed:user_missing");
    expect(chat).not.toHaveBeenCalled();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tool_run", refs: expect.objectContaining({ agentRunId: id, reason: "user_missing" }) }),
    );
  });

  it("the Tier-1 pool excludes every confirming tool and re-admits send_notification", () => {
    const pool = tier1ToolPool();
    expect(pool).toContain("send_notification");
    expect(pool).toContain("get_current_datetime");
    expect(pool).not.toContain("delete_file");
    expect(pool).not.toContain("apply_update");
  });

  it("a Tier-2 tool call fails the run with a reason naming the tool and WARP-2179, and is never dispatched", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    const chat = scriptedModel((replies) =>
      replies === 0
        ? { role: "assistant", content: null, tool_calls: [toolCall("c9", "delete_file", { path: "/x" })] }
        : { role: "assistant", content: "worked around it" },
    );
    // The registry advertises it, the run's Tier-1 pool does not: the loop's
    // unknown-tool guard refuses it and the worker turns that refusal into a
    // failed run rather than letting the model spend iterations around it.
    const mcp = fakeMcp(["delete_file", "get_current_datetime"]);
    const { worker } = makeWorker(db, { chat, mcp });
    await worker.tickOnce();
    await settle(worker);
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(db.row(id).status).toBe("failed");
    expect(db.row(id).stopReason).toBe("tier2_unsupported");
    expect(db.row(id).error).toMatch(/delete_file requires confirmation/);
    expect(db.row(id).error).toMatch(/WARP-2179/);
    // The model was never asked again after the refusal.
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("cancellation stops the run before its next tool dispatch and leaves it cancelled", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    let releaseFirst!: () => void;
    const firstDispatch = new Promise<void>((r) => (releaseFirst = r));
    const callTool = vi.fn(async (name: string, _args?: unknown, _ctx?: unknown) => {
      if (name === "get_current_datetime") await firstDispatch;
      return { isError: false, content: [{ type: "text", text: "{}" }] };
    });
    const mcp = {
      mcp: {
        listTools: vi.fn().mockResolvedValue(
          ["get_current_datetime", "send_notification"].map((name) => ({ name, description: "d", inputSchema: {} })),
        ),
        callTool,
        isStarted: true,
      } as never,
      callTool,
    };
    // Two calls in ONE iteration: the second must never dispatch after cancel.
    const chat = scriptedModel((replies) =>
      replies === 0
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              toolCall("c1", "get_current_datetime", {}),
              toolCall("c2", "send_notification", { title: "t" }),
            ],
          }
        : { role: "assistant", content: "done" },
    );
    const { worker } = makeWorker(db, { chat, mcp });
    await worker.tickOnce();
    // Wait until the first dispatch is in flight.
    while (callTool.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 2));
    expect(await cancelAgentRun(db.prisma, id)).toBe(true);
    await worker.heartbeatOnce(); // observes `cancelled` → aborts the loop
    releaseFirst();
    await settle(worker);
    expect(callTool.mock.calls.map((c) => c[0])).toEqual(["get_current_datetime"]);
    expect(db.row(id).status).toBe("cancelled");
    expect(db.row(id).stopReason).toBe("cancelled");
    expect(db.row(id).endedAt).toBeInstanceOf(Date);
  });

  it("the wall-clock ceiling stops a run whose deadline passed, as failed", async () => {
    let clock = new Date("2026-09-04T12:00:00Z");
    const now = () => clock;
    const db = createAgentRunPrismaMock({ users: [OWNER], now });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    const chat = scriptedModel((replies) => {
      // Time jumps past the deadline during the first model call.
      clock = new Date(clock.getTime() + 3_000_000);
      return threeStep(replies);
    });
    const { worker, callTool } = makeWorker(db, { chat, now });
    await worker.tickOnce();
    await settle(worker);
    expect(db.row(id).status).toBe("failed");
    expect(db.row(id).stopReason).toBe("deadline");
    expect(db.row(id).error).toMatch(/wall_clock_ceiling/);
    // Observed at the dispatch hook: the first tool never ran.
    expect(callTool).not.toHaveBeenCalled();
  });

  it("releaseAll hands in-flight runs back to queued without charging an attempt", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const chat = vi.fn(async () => {
      await gate;
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
    });
    const { worker } = makeWorker(db, { chat: chat as never });
    await worker.tickOnce();
    expect(db.row(id).status).toBe("running");
    const releasing = worker.releaseAll();
    release();
    await releasing;
    expect(db.row(id)).toMatchObject({ status: "queued", claimedBy: null, attempts: 0 });
  });
});
