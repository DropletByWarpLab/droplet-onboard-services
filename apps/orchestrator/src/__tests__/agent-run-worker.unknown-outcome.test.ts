/**
 * WARP-2877 — a lost tool outcome must not become a second write.
 *
 * The crash this pins: the worker dispatched a tool, `mcp.callTool` returned,
 * and the process died before `afterToolCall` wrote the result. What is left
 * in `AgentRun.trace` is an entry with no `text`. On resume `beforeToolCall`
 * finds it, and the old code logged `agent_run_redispatch_unknown_outcome`
 * and re-dispatched anyway — so an approved `delete_file` deleted twice and a
 * `send_notification` sent two toasts.
 *
 * Now the catalog's own tier metadata decides (`redispatchSafe`): a read may
 * be repeated, anything that writes or confirms may not. A run that cannot
 * proceed without possibly doubling a write stops — `failed`, with
 * `stopReason: "unknown_outcome"` and a message a person can act on — and the
 * step is marked so the run detail view stops saying "dispatched…".
 *
 * The fake trace below is the crash: written straight onto the row, exactly
 * the shape a killed worker leaves behind.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    AGENT_BLANK_TURN_DEBUG: false,
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "off",
    AGENT_TOOL_RESULT_CAP_CHARS: 8000,
    agentMaxIter: { defaultIter: 10, capIter: 10 },
    agentRuns: {
      concurrency: 1,
      tickMs: 5_000,
      heartbeatMs: 15_000,
      reclaimAfterMs: 60_000,
      maxAttempts: 3,
      maxWallMs: 2_400_000,
      maxIter: 10,
    },
  },
}));

const { recordActivityMock, sendNotificationMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
  sendNotificationMock: vi.fn().mockResolvedValue({ id: "n", channels: ["toast"], delivered: true }),
}));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));
vi.mock("../services/notifications.service.js", () => ({ sendNotification: sendNotificationMock }));

import {
  createAgentRunWorker,
  enqueueAgentRun,
  redispatchSafe,
  type AgentRunTraceEntry,
} from "../services/agent-run-worker.service.js";
import { createAgentRunPrismaMock } from "./helpers/agent-run-prisma-mock.js";

const OWNER = { id: "u-owner", username: "romain", role: "owner" };
const ownerAccess = vi.fn(async () => ({ scope: null, tier: "owner", unresolved: null }));

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** The model re-issues the SAME call it made before the crash, then reports. */
function reissuing(tool: string, args: Record<string, unknown>) {
  return vi.fn(async (req: { messages: Array<{ role: string }> }) => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: req.messages.some((m) => m.role === "tool")
            ? { role: "assistant", content: "Done." }
            : { role: "assistant", content: null, tool_calls: [toolCall("c2", tool, args)] },
        },
      ],
    }),
  }));
}

function mcpFor(tools: string[]) {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    executed.push({ name, args });
    return { isError: false, content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name }) }] };
  });
  return {
    mcp: {
      listTools: vi.fn().mockResolvedValue(tools.map((name) => ({ name, description: "d", inputSchema: {} }))),
      callTool,
      isStarted: true,
    } as never,
    executed,
  };
}

/**
 * Enqueue a run and leave it looking like a worker died mid-call: one trace
 * entry for `tool`, dispatched, never completed.
 */
async function crashedMidCall(
  db: ReturnType<typeof createAgentRunPrismaMock>,
  tool: string,
  args: Record<string, unknown>,
) {
  const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "tidy up", model: "m" });
  const entry: AgentRunTraceEntry = {
    tool_call_id: "c1",
    tool,
    args,
    iteration: 0,
    dispatchedAt: "2026-09-12T03:00:00.000Z",
  };
  db.row(id).trace = [entry];
  return id;
}

function makeWorker(
  db: ReturnType<typeof createAgentRunPrismaMock>,
  mcp: ReturnType<typeof mcpFor>,
  chat: ReturnType<typeof reissuing>,
) {
  return createAgentRunWorker({
    prisma: db.prisma,
    agent: { mcp: mcp.mcp, aiGateway: { chat } as never },
    workerId: "B",
    resolveAccess: ownerAccess as never,
    toolSelectionMode: "off",
  });
}

async function settle(worker: ReturnType<typeof createAgentRunWorker>) {
  while (worker.inFlight().size > 0) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  recordActivityMock.mockClear();
  sendNotificationMock.mockClear();
});

describe("redispatchSafe (WARP-2877)", () => {
  it("a read repeats harmlessly", () => {
    expect(redispatchSafe("list_files", {})).toBe(true);
    expect(redispatchSafe("read_file", {})).toBe(true);
  });

  it("an UNGATED write never repeats — nothing stands between the call and its effect", () => {
    // The one Tier-1 write a run's pool re-admits. Two toasts is two toasts.
    expect(redispatchSafe("send_notification", {})).toBe(false);
  });

  it("a GATED write depends on which dispatch was lost", () => {
    // No token was carried, so the interceptor challenged and it did not run.
    expect(redispatchSafe("delete_file", {})).toBe(true);
    expect(redispatchSafe("delete_file", { confirmation: "parked" })).toBe(true);
    // The human's approval was already spent on that dispatch.
    expect(redispatchSafe("delete_file", { confirmation: "confirmed" })).toBe(false);
  });

  it("refuses a tool the catalog does not know", () => {
    expect(redispatchSafe("not_a_tool", {})).toBe(false);
  });
});

describe("agent runs — an unknown tool outcome on resume (WARP-2877)", () => {
  it("halts instead of re-dispatching an UNGATED write: run failed, stopReason typed, step marked, tool never called again", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const args = { title: "done", body: "swept" };
    const id = await crashedMidCall(db, "send_notification", args);
    const mcp = mcpFor(["send_notification", "list_files"]);
    const worker = makeWorker(db, mcp, reissuing("send_notification", args));

    await worker.tickOnce();
    await settle(worker);

    const row = db.row(id);
    expect(row.status).toBe("failed");
    expect(row.stopReason).toBe("unknown_outcome");
    expect(row.error).toContain("send_notification");
    expect(row.error).toContain("NOT run again");
    expect(row.endedAt).not.toBeNull();
    // THE POINT: the write did not happen a second time.
    expect(mcp.executed).toHaveLength(0);

    const trace = row.trace as AgentRunTraceEntry[];
    const orphan = trace.find((e) => e.tool_call_id === "c1")!;
    expect(orphan.unknownOutcome).toBe(true);
    expect(orphan.text).toBeUndefined();
    // No second entry was pushed for the re-issued call.
    expect(trace).toHaveLength(1);

    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool_run",
        severity: "err",
        what: "Agent run halted (outcome unknown)",
        refs: expect.objectContaining({ agentRunId: id, status: "failed" }),
      }),
    );
  });

  it("re-dispatches a read as before: the run completes and the tool runs again", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const args = { path: "/notes" };
    const id = await crashedMidCall(db, "list_files", args);
    const mcp = mcpFor(["delete_file", "list_files"]);
    const worker = makeWorker(db, mcp, reissuing("list_files", args));

    await worker.tickOnce();
    await settle(worker);

    const row = db.row(id);
    expect(row.status).toBe("succeeded");
    expect(row.result).toBe("Done.");
    expect(mcp.executed).toEqual([{ name: "list_files", args }]);
    const trace = row.trace as AgentRunTraceEntry[];
    expect(trace.some((e) => e.unknownOutcome)).toBe(false);
    // The orphan is still there, and the re-dispatch is its own entry.
    expect(trace).toHaveLength(2);
    expect(trace[1]).toMatchObject({ tool_call_id: "c2", tool: "list_files", isError: false });
  });
});
