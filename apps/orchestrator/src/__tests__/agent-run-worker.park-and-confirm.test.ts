/**
 * WARP-2179 — a background run must not silently take a privileged action.
 *
 * The fake MCP below behaves like the mcp-server with the WARP-2305
 * interceptor in front of a Tier-2 tool: a call without a token is answered
 * with a `confirmation_required` challenge and a freshly minted token; a call
 * presenting a live token runs the tool and spends the token; anything else
 * is refused. The worker never sees the interceptor's code — only its wire
 * shape — which is exactly the boundary this suite pins.
 *
 *   1. A Tier-2 call PARKS the run: `awaiting_confirmation`, the lease
 *      released, the pending call bound as the interceptor binds its token,
 *      NO token anywhere on the row, the owner notified, the tool never run,
 *      the model not asked again.
 *   2. Approve → resume (a fresh worker, as after a restart) → the model
 *      re-issues → the worker performs the handshake: the tool runs exactly
 *      once, with the SECOND token (minted at resume), the pending columns
 *      clear, the run succeeds, the deadline was extended by the parked time.
 *   3. Deny → resume → the model receives CONFIRMATION_DENIED, adapts, and
 *      finishes; the tool never runs.
 *   4. Approval is not an escalation path: refused when the run's principal
 *      can no longer reach the tool; refused for a non-owner; the run stays
 *      parked.
 *   5. Tier-3 is refused, never parked: a tool outside the run's pool, and a
 *      tool the interceptor's deny tier blocks.
 *   6. Every outcome writes a `tool_call` ActivityRow with `refs.agentRunId`.
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
    },
  },
}));

const { recordActivityMock, sendNotificationMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
  sendNotificationMock: vi.fn().mockResolvedValue({ id: "n", channels: ["toast"], delivered: true }),
}));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));
vi.mock("../services/notifications.service.js", () => ({ sendNotification: sendNotificationMock }));

import { confirmationBindingHash } from "@droplet/tools-core";
import {
  createAgentRunWorker,
  decideAgentRun,
  enqueueAgentRun,
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

/** The model: delete the old file; then report on what the tool said. */
const deleteThenReport = (req: { messages: Array<{ role: string; content: unknown }> }) => {
  const replies = req.messages.filter((m) => m.role === "tool");
  if (replies.length === 0) {
    return { role: "assistant", content: null, tool_calls: [toolCall("c1", "delete_file", { path: "/old.txt" })] };
  }
  const last = String(replies[replies.length - 1]!.content);
  if (last.includes("CONFIRMATION_DENIED")) return { role: "assistant", content: "Left it alone, as you asked." };
  if (last.includes("confirmation_required")) return { role: "assistant", content: "Waiting for your approval." };
  return { role: "assistant", content: "Deleted /old.txt." };
};

function scripted(script: (req: { messages: Array<{ role: string; content: unknown }> }) => unknown) {
  return vi.fn(async (req: { messages: Array<{ role: string; content: unknown }> }) => ({
    ok: true,
    json: async () => ({ choices: [{ message: script(req) }] }),
  }));
}

/** An MCP port with the interceptor's behaviour in front of `tier2`. */
function interceptingMcp(tools: string[], tier2: Set<string>, denied: Set<string> = new Set()) {
  let minted = 0;
  const live = new Set<string>();
  const executed: Array<{ name: string; args: Record<string, unknown>; token?: string }> = [];
  const wire = (payload: unknown, isError = false) => ({
    isError,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });
  const callTool = vi.fn(
    async (name: string, args: Record<string, unknown>, ctx?: { confirmationToken?: string }) => {
      if (denied.has(name)) {
        return wire(
          {
            status: "error",
            error: {
              code: "TOOL_DENIED",
              message: "blocked",
              details: { interceptor: { outcome: "denied", tool: name, reason: "policy" } },
            },
          },
          true,
        );
      }
      if (tier2.has(name)) {
        const presented = ctx?.confirmationToken;
        if (presented) {
          if (!live.has(presented)) {
            return wire({
              status: "confirmation_required",
              error: {
                code: "CONFIRMATION_REJECTED",
                message: "refused",
                details: { interceptor: { outcome: "confirmation_rejected", tool: name, reason: "unknown_token" } },
              },
            });
          }
          live.delete(presented);
        } else {
          const token = `tok-${++minted}`;
          live.add(token);
          return wire({
            status: "confirmation_required",
            error: {
              code: "CONFIRMATION_REQUIRED",
              message: `'${name}' writes, so it needs a thumbs-up.`,
              details: {
                interceptor: { outcome: "confirmation_required", tool: name, confirmationToken: token, expiresAt: Date.now() + 300_000 },
                confirmationToken: token,
              },
            },
          });
        }
      }
      executed.push({ name, args, token: ctx?.confirmationToken });
      return wire({ ok: true, tool: name });
    },
  );
  return {
    mcp: {
      listTools: vi.fn().mockResolvedValue(tools.map((name) => ({ name, description: "d", inputSchema: {} }))),
      callTool,
      isStarted: true,
    } as never,
    callTool,
    executed,
    minted: () => minted,
    tokens: () => [...Array(minted).keys()].map((i) => `tok-${i + 1}`),
  };
}

function makeWorker(
  db: ReturnType<typeof createAgentRunPrismaMock>,
  mcp: ReturnType<typeof interceptingMcp>,
  opts: { workerId?: string; now?: () => Date; chat?: ReturnType<typeof scripted>; resolveAccess?: unknown } = {},
) {
  const chat = opts.chat ?? scripted(deleteThenReport);
  const worker = createAgentRunWorker({
    prisma: db.prisma,
    agent: { mcp: mcp.mcp, aiGateway: { chat } as never },
    workerId: opts.workerId ?? "A",
    now: opts.now,
    resolveAccess: (opts.resolveAccess ?? ownerAccess) as never,
    toolSelectionMode: "off",
  });
  return { worker, chat };
}

async function settle(worker: ReturnType<typeof createAgentRunWorker>) {
  while (worker.inFlight().size > 0) await new Promise((r) => setTimeout(r, 5));
}

const rowText = (row: object) => JSON.stringify(row);

beforeEach(() => {
  recordActivityMock.mockClear();
  sendNotificationMock.mockClear();
  ownerAccess.mockClear();
});

describe("agent runs — Tier-2 parks (WARP-2179)", () => {
  it("a Tier-2 call parks the run: bound pending call, lease released, no token, owner notified, tool never run", async () => {
    const clock = new Date("2026-09-04T03:00:00Z");
    const db = createAgentRunPrismaMock({ users: [OWNER], now: () => clock });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "tidy up old files", model: "m" });
    const mcp = interceptingMcp(["delete_file", "list_files"], new Set(["delete_file"]));
    const { worker, chat } = makeWorker(db, mcp, { now: () => clock });
    await worker.tickOnce();
    await settle(worker);

    const row = db.row(id);
    expect(row.status).toBe("awaiting_confirmation");
    expect(row.claimedBy).toBeNull();
    expect(row.heartbeatAt).toBeNull();
    expect(row.parkedAt).toEqual(clock);
    expect(row.pendingTool).toBe("delete_file");
    expect(row.pendingArgs).toEqual({ path: "/old.txt" });
    expect(row.pendingBindingHash).toBe(confirmationBindingHash("delete_file", { path: "/old.txt" }));
    expect(row.pendingToolCallId).toBe("c1");
    expect(row.pendingDecision).toBeNull();
    // No token anywhere on the row — the interceptor's secret was dropped.
    expect(mcp.minted()).toBe(1);
    expect(rowText(row)).not.toContain("tok-1");
    // The checkpoint is the top of the parked iteration: resume re-runs it.
    expect(row.iteration).toBe(0);
    expect(mcp.executed).toHaveLength(0);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const note = sendNotificationMock.mock.calls[0]![1] as { userId: string; kind: string; title: string; body: string };
    expect(note.userId).toBe("romain");
    expect(note.kind).toBe("ai");
    expect(note.title).toContain("delete_file");
    expect(note.body).toContain("tidy up old files");
    expect(note.body).toContain("Nothing has been done yet");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool_call",
        refs: expect.objectContaining({ agentRunId: id, name: "delete_file", confirmation: "parked" }),
      }),
    );
  });

  it("approve → resume on a fresh worker: the tool runs once with a token minted at resume; pending clears; deadline extended", async () => {
    let clock = new Date("2026-09-04T03:00:00Z");
    const now = () => clock;
    const db = createAgentRunPrismaMock({ users: [OWNER], now });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "tidy up", model: "m" });
    const mcp = interceptingMcp(["delete_file"], new Set(["delete_file"]));
    const a = makeWorker(db, mcp, { workerId: "A", now });
    await a.worker.tickOnce();
    await settle(a.worker);
    const parked = db.row(id);
    expect(parked.status).toBe("awaiting_confirmation");
    const deadlineBefore = parked.deadlineAt!.getTime();

    // A day later the owner approves.
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    const decided = await decideAgentRun(db.prisma, {
      id,
      decision: "approved",
      decidedBy: { id: OWNER.id, role: "owner", username: "romain" },
      resolveAccess: ownerAccess as never,
      now: clock,
    });
    expect(decided).toEqual({ ok: true, tool: "delete_file", decision: "approved" });
    const queued = db.row(id);
    expect(queued.status).toBe("queued");
    expect(queued.pendingDecision).toBe("approved");
    expect(queued.pendingDecidedBy).toBe(OWNER.id);
    expect(queued.deadlineAt!.getTime() - deadlineBefore).toBe(24 * 3_600_000);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: expect.objectContaining({ agentRunId: id, confirmation: "user_approved" }),
        actor: { type: "user", id: OWNER.id },
      }),
    );

    // A different process resumes it (the box restarted while parked).
    const b = makeWorker(db, mcp, { workerId: "B", now });
    expect((await b.worker.tickOnce()).claimed).toBe(1);
    await settle(b.worker);

    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("Deleted /old.txt.");
    expect(done.pendingTool).toBeNull();
    expect(done.pendingBindingHash).toBeNull();
    expect(done.pendingDecision).toBeNull();
    expect(done.parkedAt).toBeNull();
    // Exactly one execution, with the token minted at RESUME, not at park.
    expect(mcp.executed).toEqual([{ name: "delete_file", args: { path: "/old.txt" }, token: "tok-2" }]);
    expect(mcp.minted()).toBe(2);
    const trace = db.row(id).trace as AgentRunTraceEntry[];
    expect(trace.find((e) => e.confirmation === "confirmed")).toMatchObject({ tool: "delete_file" });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: expect.objectContaining({ agentRunId: id, name: "delete_file", confirmation: "confirmed" }),
      }),
    );
    // Resume did not re-park.
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("deny → resume: the model gets CONFIRMATION_DENIED as a tool result, adapts, and the tool never runs", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "tidy up", model: "m" });
    const mcp = interceptingMcp(["delete_file"], new Set(["delete_file"]));
    const a = makeWorker(db, mcp);
    await a.worker.tickOnce();
    await settle(a.worker);
    expect(db.row(id).status).toBe("awaiting_confirmation");

    const decided = await decideAgentRun(db.prisma, {
      id,
      decision: "denied",
      decidedBy: { id: OWNER.id, role: "owner" },
    });
    expect(decided).toEqual({ ok: true, tool: "delete_file", decision: "denied" });

    const b = makeWorker(db, mcp, { workerId: "B" });
    await b.worker.tickOnce();
    await settle(b.worker);
    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("Left it alone, as you asked.");
    expect(mcp.executed).toHaveLength(0);
    expect(mcp.minted()).toBe(1); // only the park's challenge; no handshake on deny
    const trace = db.row(id).trace as AgentRunTraceEntry[];
    expect(trace.find((e) => e.confirmation === "denied")).toMatchObject({ tool: "delete_file", isError: true });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ refs: expect.objectContaining({ agentRunId: id, confirmation: "denied" }) }),
    );
  });
});

describe("agent runs — confirmation is not an escalation path (WARP-2179)", () => {
  async function parkedRun() {
    const db = createAgentRunPrismaMock({ users: [OWNER, { id: "u-fam", username: "kid", role: "family" }] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: "u-fam", goal: "tidy", model: "m" });
    const mcp = interceptingMcp(["delete_file"], new Set(["delete_file"]));
    // At park time the family member still reaches `files` writes.
    const reachable = vi.fn(async () => ({
      scope: { domains: new Set(["files"]), writeDomains: new Set(["files"]), locks: false },
      tier: "admin",
      unresolved: null,
    }));
    const { worker } = makeWorker(db, mcp, { resolveAccess: reachable });
    await worker.tickOnce();
    await settle(worker);
    expect(db.row(id).status).toBe("awaiting_confirmation");
    return { db, id };
  }

  it("refuses approval when the run's principal can no longer reach the tool; the run stays parked", async () => {
    const { db, id } = await parkedRun();
    const narrowed = vi.fn(async () => ({
      scope: { domains: new Set(["files"]), writeDomains: new Set<string>(), locks: false },
      tier: "family",
      unresolved: null,
    }));
    const decided = await decideAgentRun(db.prisma, {
      id,
      decision: "approved",
      decidedBy: { id: "u-fam", role: "family" },
      resolveAccess: narrowed as never,
    });
    expect(decided).toEqual({ ok: false, reason: "forbidden_tool_for_role" });
    expect(db.row(id).status).toBe("awaiting_confirmation");
    expect(db.row(id).pendingDecision).toBeNull();
  });

  it("refuses a decision from a non-owner", async () => {
    const { db, id } = await parkedRun();
    const decided = await decideAgentRun(db.prisma, {
      id,
      decision: "approved",
      decidedBy: { id: "u-someone-else", role: "admin" },
    });
    expect(decided).toEqual({ ok: false, reason: "not_owner" });
    expect(db.row(id).status).toBe("awaiting_confirmation");
  });

  it("denial needs no reach check and always lands", async () => {
    const { db, id } = await parkedRun();
    const decided = await decideAgentRun(db.prisma, {
      id,
      decision: "denied",
      decidedBy: { id: "u-fam", role: "family" },
    });
    expect(decided).toEqual({ ok: true, tool: "delete_file", decision: "denied" });
    expect(db.row(id).status).toBe("queued");
  });

  it("a run that is not parked cannot be decided", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    expect(await decideAgentRun(db.prisma, { id, decision: "approved", decidedBy: { id: OWNER.id } })).toEqual({
      ok: false,
      reason: "not_parked",
    });
    expect(await decideAgentRun(db.prisma, { id: "nope", decision: "approved", decidedBy: { id: OWNER.id } })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("agent runs — Tier-3 is refused, never parked (WARP-2179)", () => {
  it("a tool outside the run's pool is refused by the loop's guard and the run continues", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    // `delete_clip` is registered and even a Tier-2 in the catalog, but chat
    // policy keeps it out of the pool — so a run may never reach it.
    const mcp = interceptingMcp(["delete_clip", "get_current_datetime"], new Set(["delete_clip"]));
    const chat = scripted((req) =>
      req.messages.filter((m) => m.role === "tool").length === 0
        ? { role: "assistant", content: null, tool_calls: [toolCall("c1", "delete_clip", { clipId: "x" })] }
        : { role: "assistant", content: "I can't delete clips from a background run." },
    );
    const { worker } = makeWorker(db, mcp, { chat });
    await worker.tickOnce();
    await settle(worker);
    expect(db.row(id).status).toBe("succeeded");
    expect(db.row(id).pendingTool).toBeNull();
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("a tool the interceptor's deny tier blocks is a tool error, not a park", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    const mcp = interceptingMcp(["delete_file"], new Set(["delete_file"]), new Set(["delete_file"]));
    const chat = scripted((req) =>
      req.messages.filter((m) => m.role === "tool").length === 0
        ? { role: "assistant", content: null, tool_calls: [toolCall("c1", "delete_file", { path: "/x" })] }
        : { role: "assistant", content: "That was blocked." },
    );
    const { worker } = makeWorker(db, mcp, { chat });
    await worker.tickOnce();
    await settle(worker);
    expect(db.row(id).status).toBe("succeeded");
    expect(db.row(id).pendingTool).toBeNull();
    expect(mcp.executed).toHaveLength(0);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});
