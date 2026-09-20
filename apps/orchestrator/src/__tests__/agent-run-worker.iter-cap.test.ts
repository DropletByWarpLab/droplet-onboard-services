/**
 * WARP-2749 — a background run's iteration cap is its own (`AGENT_RUN_MAX_ITER`),
 * not the interactive chat cap (`AGENT_MAX_ITER_CAP`).
 *
 * The config here sets the chat cap to 3 and the run cap to 6. A run that
 * needs five tool calls before it can answer must complete at iteration 6 —
 * which proves both enforcement points read the run cap: `enqueueAgentRun`
 * (the row's `maxIter`) and the loop itself (`AgentDeps.maxIterCap`, without
 * which the loop's own clamp would stop it at 3 with `iteration_limit`).
 * The second test pins that the cap really is what the worker hands the loop:
 * a worker told to cap at 3 stops at 3.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    AGENT_BLANK_TURN_DEBUG: false,
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "off",
    AGENT_TOOL_RESULT_CAP_CHARS: 8000,
    agentMaxIter: { defaultIter: 3, capIter: 3 },
    agentRuns: {
      concurrency: 1,
      tickMs: 5_000,
      heartbeatMs: 15_000,
      reclaimAfterMs: 60_000,
      maxAttempts: 3,
      maxWallMs: 2_400_000,
      maxIter: 6,
    },
  },
}));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/notifications.service.js", () => ({
  sendNotification: vi.fn().mockResolvedValue({ id: "n", channels: ["toast"], delivered: true }),
}));

import { createAgentRunWorker, enqueueAgentRun } from "../services/agent-run-worker.service.js";
import { createAgentRunPrismaMock } from "./helpers/agent-run-prisma-mock.js";

const OWNER = { id: "u-owner", username: "romain", role: "owner" };

/**
 * Five checks of the time, then an answer: six model calls to finish. Each
 * check carries different arguments — the loop's repetition guard would
 * otherwise stop an identical call repeated, which is not what this pins.
 */
function fiveChecksThenAnswer() {
  return vi.fn(async (req: { messages: Array<{ role: string }> }) => {
    const replies = req.messages.filter((m) => m.role === "tool").length;
    const message =
      replies < 5
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `c${replies}`,
                type: "function",
                function: { name: "get_current_datetime", arguments: JSON.stringify({ check: replies + 1 }) },
              },
            ],
          }
        : { role: "assistant", content: "Done after five checks." };
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
}

function makeWorker(db: ReturnType<typeof createAgentRunPrismaMock>, maxIterCap?: number) {
  const chat = fiveChecksThenAnswer();
  const callTool = vi.fn(async () => ({ isError: false, content: [{ type: "text", text: '{"now":"noon"}' }] }));
  const worker = createAgentRunWorker({
    prisma: db.prisma,
    agent: {
      mcp: {
        listTools: vi.fn().mockResolvedValue([{ name: "get_current_datetime", description: "d", inputSchema: {} }]),
        callTool,
        isStarted: true,
      } as never,
      aiGateway: { chat } as never,
    },
    workerId: "A",
    resolveAccess: (async () => ({ scope: null, tier: "owner", unresolved: null })) as never,
    toolSelectionMode: "off",
    ...(maxIterCap !== undefined ? { maxIterCap } : {}),
  });
  return { worker, chat, callTool };
}

async function settle(worker: ReturnType<typeof createAgentRunWorker>) {
  while (worker.inFlight().size > 0) await new Promise((r) => setTimeout(r, 5));
}

describe("agent runs — the run cap is not the chat cap (WARP-2749)", () => {
  it("a run enqueued without maxIter gets the RUN cap, and the loop honours it past the chat cap", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "check the time five times", model: "m" });
    expect(db.row(id).maxIter).toBe(6); // the run cap, not 3
    const { worker, chat, callTool } = makeWorker(db);
    await worker.tickOnce();
    await settle(worker);
    expect(db.row(id)).toMatchObject({ status: "succeeded", iteration: 6, result: "Done after five checks." });
    expect(chat).toHaveBeenCalledTimes(6);
    expect(callTool).toHaveBeenCalledTimes(5);
  });

  it("the cap the worker hands the loop is the one that binds: capped at 3, the same run stops at 3", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "check the time five times", model: "m" });
    const { worker, chat } = makeWorker(db, 3);
    await worker.tickOnce();
    await settle(worker);
    expect(db.row(id)).toMatchObject({ status: "failed", iteration: 3, stopReason: "iteration_limit" });
    expect(db.row(id).error).toContain("within 3 iterations");
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it("an explicit maxIter above the run cap is clamped to the run cap at enqueue", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m", maxIter: 50 });
    expect(db.row(id).maxIter).toBe(6);
  });
});
