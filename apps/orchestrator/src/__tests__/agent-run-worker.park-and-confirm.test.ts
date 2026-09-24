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
 *   2. Approve → resume (a fresh worker, as after a restart) → the worker runs
 *      the STORED call itself, through the handshake: the tool runs exactly
 *      once, with the SECOND token (minted at resume), the pending columns
 *      clear, the run succeeds, the deadline was extended by the parked time.
 *   3. Deny → resume → the model receives CONFIRMATION_DENIED as the parked
 *      call's result, adapts, and finishes; the tool never runs.
 *   4. Approval is not an escalation path: refused when the run's principal
 *      can no longer reach the tool; refused for a non-owner; the run stays
 *      parked.
 *   5. Tier-3 is refused, never parked: a tool outside the run's pool, and a
 *      tool the interceptor's deny tier blocks.
 *   6. Every outcome writes a `tool_call` ActivityRow with `refs.agentRunId`.
 *   7. Review findings (Stefan, #2013): the handshake is crash-safe — the
 *      decision is consumed before the first dispatch, so a crash between
 *      dispatch and completion write re-PARKS on resume instead of re-running
 *      the approved write; a thrown or refused redeem leg is a tool error the
 *      run survives, audited as "approved but did not run"; a cancel while
 *      parked clears the parked call.
 *   8. WARP-3044 — the model is never asked to re-issue a decided call, so a
 *      model that rewords free text on every ask (gpt-oss, run 1efa11c8 on
 *      .195) still gets exactly one execution per approval, with the parked
 *      args; a denial executes nothing; a second approval cannot
 *      double-execute; a byte-identical re-issue after the result is answered
 *      from the trace, not run and not parked; the stored call must still
 *      match its binding and the principal's reach at the claim.
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
      maxWallMs: 2_400_000, maxIter: 10,
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
  cancelAgentRun,
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
  if (last.includes("tool_dispatch_failed") || last.includes("CONFIRMATION_REJECTED")) {
    return { role: "assistant", content: "The delete did not go through; nothing changed." };
  }
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
function interceptingMcp(
  tools: string[],
  tier2: Set<string>,
  denied: Set<string> = new Set(),
  opts: { refuseRedeem?: boolean; throwOnRedeem?: boolean; challengeAsError?: boolean } = {},
) {
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
          if (opts.throwOnRedeem) throw new Error("mcp transport closed");
          if (opts.refuseRedeem || !live.has(presented)) {
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
          }, opts.challengeAsError === true);
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
    // WARP-2909 — the park links to the run and says a decision is pending.
    // `userId` is the USERNAME (the fake's id and username differ on purpose).
    const link = note as unknown as { userId: string; url: string; tag: string; data: Record<string, unknown> };
    expect(link.userId).toBe(OWNER.username);
    expect(link.userId).not.toBe(OWNER.id);
    expect(link.url).toBe(`/workshop?run=${id}`);
    expect(link.tag).toBe(`agent-run:${id}`);
    expect(link.data).toEqual({ agentRunId: id, pendingTool: "delete_file", needsDecision: true });
    // Nothing that could approve it, and no args (they can carry customer data).
    expect(Object.keys(note).filter((k) => /token|hash|confirm/i.test(k))).toEqual([]);
    expect(JSON.stringify({ url: link.url, tag: link.tag, data: link.data })).not.toMatch(/token|hash|confirm|old\.txt/i);
    expect([...new URL(link.url, "https://box.local").searchParams.keys()]).toEqual(["run"]);
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
    // Resume did not re-park: one "approval needed" at park, then one
    // "finished" on the terminal status (WARP-2180), nothing else.
    const titles = sendNotificationMock.mock.calls.map((c) => (c[1] as { title: string }).title);
    expect(titles.filter((t) => t.startsWith("Approval needed"))).toHaveLength(1);
    expect(titles.filter((t) => t.startsWith("Background run finished"))).toHaveLength(1);
    // WARP-2909 — the finish carries the same link and tag, and NO needsDecision.
    const finished = sendNotificationMock.mock.calls
      .map((c) => c[1] as { title: string; userId: string; url: string; tag: string; data: Record<string, unknown> })
      .find((n) => n.title.startsWith("Background run finished"))!;
    expect(finished.userId).toBe(OWNER.username);
    expect(finished.url).toBe(`/workshop?run=${id}`);
    expect(finished.tag).toBe(`agent-run:${id}`);
    expect(finished.data).toEqual({ agentRunId: id, status: "succeeded" });
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
    expect(sendNotificationMock.mock.calls.some((c) => (c[1] as { title: string }).title.startsWith("Approval needed"))).toBe(false);
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
    expect(sendNotificationMock.mock.calls.some((c) => (c[1] as { title: string }).title.startsWith("Approval needed"))).toBe(false);
  });
});

describe("agent runs — the handshake is crash-safe and error-safe (WARP-2179 review)", () => {
  /** Park, approve, and hand back a DB whose row is queued with the approval. */
  async function approvedRun(mcp: ReturnType<typeof interceptingMcp>, now: () => Date) {
    const db = createAgentRunPrismaMock({ users: [OWNER], now });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "tidy up", model: "m" });
    const a = makeWorker(db, mcp, { workerId: "A", now });
    await a.worker.tickOnce();
    await settle(a.worker);
    expect(db.row(id).status).toBe("awaiting_confirmation");
    const decided = await decideAgentRun(db.prisma, {
      id,
      decision: "approved",
      decidedBy: { id: OWNER.id, role: "owner" },
      resolveAccess: ownerAccess as never,
      now: now(),
    });
    expect(decided).toMatchObject({ ok: true });
    return { db, id };
  }

  it("a crash between the redeem dispatch and the completion write re-PARKS on resume — the approved write runs once, never twice", async () => {
    let clock = new Date("2026-09-04T03:00:00Z");
    const now = () => clock;
    const mcp = interceptingMcp(["delete_file"], new Set(["delete_file"]));
    const { db, id } = await approvedRun(mcp, now);

    // The DB dies at the completion write: the entry already carries the
    // consumed decision and now a result — and stays dead for that worker.
    let dead = false;
    db.setFailOn((op, args) => {
      const trace = (args as { data?: { trace?: AgentRunTraceEntry[] } }).data?.trace;
      if (op === "updateMany" && Array.isArray(trace) && trace.some((e) => e.confirmation === "confirmed" && e.completedAt)) {
        dead = true;
      }
      return dead;
    });
    const b = makeWorker(db, mcp, { workerId: "B", now });
    await b.worker.tickOnce();
    await settle(b.worker);
    db.setFailOn(null);
    const crashed = db.row(id);
    expect(crashed.status).toBe("running"); // no terminal write survived
    expect(mcp.executed).toHaveLength(1); // the approved delete DID run, once
    // The decision was consumed BEFORE the dispatch: nothing approved is left
    // on the row for a resumed worker to redeem again.
    expect(crashed.pendingDecision).toBeNull();
    expect(crashed.pendingTool).toBeNull();
    const consumed = (crashed.trace as AgentRunTraceEntry[]).find((e) => e.confirmation === "confirmed");
    expect(consumed).toBeDefined();
    expect(consumed!.text).toBeUndefined(); // outcome never recorded

    // Reclaim + resume on C: the consumed-but-unrecorded approved call is
    // found at the checkpoint and the run parks again on THAT stored call
    // (WARP-3044) — a second prompt, not a silent second delete, and not a
    // question about whatever the model would re-issue.
    clock = new Date(clock.getTime() + 61_000);
    const c = makeWorker(db, mcp, { workerId: "C", now });
    const tick = await c.worker.tickOnce();
    expect(tick.reclaimed).toBe(1);
    await settle(c.worker);
    const reparked = db.row(id);
    expect(reparked.status).toBe("awaiting_confirmation");
    expect(reparked.pendingTool).toBe("delete_file");
    expect(reparked.pendingArgs).toEqual({ path: "/old.txt" });
    expect(reparked.pendingDecision).toBeNull();
    expect(mcp.executed).toHaveLength(1); // still exactly one execution
    // Park, resume leg 1 — and no third: the re-park is decided on the stored
    // call with nothing dispatched, so no fresh challenge is needed.
    expect(mcp.minted()).toBe(2);
    const titles = sendNotificationMock.mock.calls.map((x) => (x[1] as { title: string }).title);
    expect(titles.filter((t) => t.startsWith("Approval needed"))).toHaveLength(2);

    // WARP-2877 — the SECOND prompt must not repeat "Nothing has been done
    // yet". The approval was spent on the lost dispatch and the delete DID
    // run; the person being asked a second time is the only one who can tell.
    const lost = (reparked.trace as AgentRunTraceEntry[]).filter((e) => e.unknownOutcome);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.tool).toBe("delete_file");
    expect(lost[0]!.text).toBeUndefined();
    const bodies = sendNotificationMock.mock.calls
      .map((x) => x[1] as { title: string; body: string })
      .filter((n) => n.title.startsWith("Approval needed"))
      .map((n) => n.body);
    expect(bodies[0]).toContain("Nothing has been done yet");
    expect(bodies[1]).toContain("MAY ALREADY");
    expect(bodies[1]).not.toContain("Nothing has been done yet");
  });

  it("a redeem leg that THROWS is a tool error the run survives, audited as approved-but-did-not-run", async () => {
    const clock = new Date("2026-09-04T03:00:00Z");
    const mcp = interceptingMcp(["delete_file"], new Set(["delete_file"]), new Set(), { throwOnRedeem: true });
    const { db, id } = await approvedRun(mcp, () => clock);
    recordActivityMock.mockClear();
    const b = makeWorker(db, mcp, { workerId: "B", now: () => clock });
    await b.worker.tickOnce();
    await settle(b.worker);
    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("The delete did not go through; nothing changed.");
    expect(done.pendingTool).toBeNull();
    expect(mcp.executed).toHaveLength(0);
    const entry = (done.trace as AgentRunTraceEntry[]).find((e) => e.confirmation === "confirmed");
    expect(entry).toMatchObject({ isError: true });
    expect(String(entry!.text)).toContain("tool_dispatch_failed");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warn",
        what: "delete_file approved but did not run",
        refs: expect.objectContaining({ agentRunId: id, confirmation: "confirmed_failed" }),
      }),
    );
    expect(recordActivityMock).not.toHaveBeenCalledWith(expect.objectContaining({ what: "delete_file approved and run" }));
  });

  it("a REFUSED token on the redeem leg is an error for the model, not a success; audited as approved-but-did-not-run", async () => {
    const clock = new Date("2026-09-04T03:00:00Z");
    const mcp = interceptingMcp(["delete_file"], new Set(["delete_file"]), new Set(), { refuseRedeem: true });
    const { db, id } = await approvedRun(mcp, () => clock);
    recordActivityMock.mockClear();
    const b = makeWorker(db, mcp, { workerId: "B", now: () => clock });
    await b.worker.tickOnce();
    await settle(b.worker);
    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("The delete did not go through; nothing changed.");
    expect(mcp.executed).toHaveLength(0);
    expect((done.trace as AgentRunTraceEntry[]).find((e) => e.confirmation === "confirmed")).toMatchObject({ isError: true });
    expect(rowText(done)).not.toMatch(/tok-\d/); // the refused token never persisted either
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "delete_file approved but did not run",
        refs: expect.objectContaining({ agentRunId: id, confirmation: "confirmed_failed" }),
      }),
    );
  });

  it("cancelling a parked run clears the parked call with the terminal write", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "tidy up", model: "m" });
    const mcp = interceptingMcp(["delete_file"], new Set(["delete_file"]));
    const { worker } = makeWorker(db, mcp);
    await worker.tickOnce();
    await settle(worker);
    expect(db.row(id).pendingTool).toBe("delete_file");
    expect(await cancelAgentRun(db.prisma, id)).toBe(true);
    const row = db.row(id);
    expect(row.status).toBe("cancelled");
    expect(row.pendingTool).toBeNull();
    expect(row.pendingBindingHash).toBeNull();
    expect(row.pendingArgs).toBeNull();
    expect(row.parkedAt).toBeNull();
  });
});

describe("agent runs — an approved park runs the STORED call; the model never re-issues it (WARP-3044)", () => {
  /**
   * gpt-oss on the house unit (.195), run 1efa11c8: each time the parked
   * iteration was re-run after an approval, the model reworded the free-text
   * argument. The binding never matched the approval, the run re-parked, and
   * after three approvals nothing had run. These are its four wordings.
   */
  const REWORDINGS = [
    "Both tsc and npm test exited with code 0.",
    "Compilation exit code 0, tests exit code 0",
    "Compiled src/ with tsc (exit code 0). Ran npm test (exit code 0).",
    "tsc exit code 0, npm test exit code 0",
  ];
  const TOOL = "memory_extract_fact";
  const factArgs = (fact: string) => ({ category: "workflow", fact });
  const PARKED = factArgs(REWORDINGS[0]!);

  type Msg = { role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };

  /**
   * Asks to save a fact with no result in front of it, rewording the fact on
   * every ask. With a result in front of it, it reports. `repeat` makes it
   * send the decided call once more, byte for byte, after seeing its result.
   * `seen` snapshots every conversation it was handed (the loop's array is
   * live, so the mock's own call record would show later pushes).
   */
  function rewordingModel(opts: { repeat?: boolean } = {}) {
    let asks = 0;
    const seen: Msg[][] = [];
    const chat = scripted((req) => {
      seen.push(JSON.parse(JSON.stringify(req.messages)) as Msg[]);
      const replies = req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      if (replies.length === 0) {
        const fact = REWORDINGS[asks % REWORDINGS.length]!;
        asks += 1;
        return { role: "assistant", content: null, tool_calls: [toolCall(`c${asks}`, TOOL, factArgs(fact))] };
      }
      if (opts.repeat && replies.length === 1) {
        return { role: "assistant", content: null, tool_calls: [toolCall("c-again", TOOL, PARKED)] };
      }
      const last = replies[replies.length - 1]!;
      if (last.includes("CONFIRMATION_DENIED")) return { role: "assistant", content: "Not saved, as you asked." };
      if (replies.some((r) => r.includes('"ok":true'))) return { role: "assistant", content: "Saved the fact." };
      return { role: "assistant", content: "The fact was not saved." };
    });
    return { chat, seen };
  }

  const decide = (db: ReturnType<typeof createAgentRunPrismaMock>, id: string, decision: "approved" | "denied", now?: Date) =>
    decideAgentRun(db.prisma, {
      id,
      decision,
      decidedBy: { id: OWNER.id, role: "owner", username: OWNER.username },
      resolveAccess: ownerAccess as never,
      ...(now ? { now } : {}),
    });

  async function parked(
    model: ReturnType<typeof rewordingModel>,
    opts: {
      maxIter?: number;
      resolveAccess?: unknown;
      userId?: string;
      now?: () => Date;
      mcp?: Parameters<typeof interceptingMcp>[3];
    } = {},
  ) {
    const db = createAgentRunPrismaMock({ users: [OWNER, { id: "u-adm", username: "stefan", role: "admin" }], now: opts.now });
    const { id } = await enqueueAgentRun(db.prisma, {
      userId: opts.userId ?? OWNER.id,
      goal: "record what the build did",
      model: "m",
      ...(opts.maxIter ? { maxIter: opts.maxIter } : {}),
    });
    const mcp = interceptingMcp([TOOL], new Set([TOOL]), new Set(), opts.mcp);
    const a = makeWorker(db, mcp, { workerId: "A", chat: model.chat, resolveAccess: opts.resolveAccess, now: opts.now });
    await a.worker.tickOnce();
    await settle(a.worker);
    const row = db.row(id);
    expect(row.status).toBe("awaiting_confirmation");
    expect(row.pendingArgs).toEqual(PARKED);
    return { db, id, mcp };
  }

  async function resume(
    db: ReturnType<typeof createAgentRunPrismaMock>,
    mcp: ReturnType<typeof interceptingMcp>,
    model: ReturnType<typeof rewordingModel>,
    opts: { workerId?: string; resolveAccess?: unknown; now?: () => Date } = {},
  ) {
    const w = makeWorker(db, mcp, { workerId: opts.workerId ?? "B", chat: model.chat, resolveAccess: opts.resolveAccess, now: opts.now });
    const tick = await w.worker.tickOnce();
    await settle(w.worker);
    return tick;
  }

  const approvalPrompts = () =>
    sendNotificationMock.mock.calls.map((c) => c[1] as { title: string; body: string }).filter((n) => n.title.startsWith("Approval needed"));

  function expectPendingCleared(row: ReturnType<ReturnType<typeof createAgentRunPrismaMock>["row"]>) {
    expect(row.pendingTool).toBeNull();
    expect(row.pendingBindingHash).toBeNull();
    expect(row.pendingArgs).toBeNull();
    expect(row.pendingToolCallId).toBeNull();
    expect(row.pendingDecision).toBeNull();
    expect(row.pendingDecidedAt).toBeNull();
    expect(row.pendingDecidedBy).toBeNull();
    expect(row.parkedAt).toBeNull();
  }

  it("one approval runs the parked call exactly once, with the PARKED args, though the model would reword them; the model resumes with the result in context", async () => {
    const model = rewordingModel();
    const { db, id, mcp } = await parked(model);
    expect(await decide(db, id, "approved")).toMatchObject({ ok: true, decision: "approved" });

    await resume(db, mcp, model);

    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("Saved the fact.");
    // Exactly one execution: the stored call, redeemed with the token the
    // interceptor minted at resume — never the park's, which was dropped.
    expect(mcp.executed).toEqual([{ name: TOOL, args: PARKED, token: "tok-2" }]);
    expect(mcp.minted()).toBe(2);
    expectPendingCleared(done);
    expect(rowText(done)).not.toMatch(/tok-\d/);

    // The model was asked twice in all: the ask that parked, then — with the
    // approved call and its result already in the conversation — for its
    // report. It was never asked to re-issue the call.
    expect(model.chat).toHaveBeenCalledTimes(2);
    const resumed = model.seen[1]!;
    const [call, reply] = resumed.slice(-2);
    expect(call).toMatchObject({ role: "assistant" });
    expect(call!.tool_calls).toHaveLength(1);
    expect(call!.tool_calls![0]).toMatchObject({ id: "c1", type: "function", function: { name: TOOL } });
    expect(JSON.parse(call!.tool_calls![0]!.function.arguments)).toEqual(PARKED);
    expect(reply).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(String(reply!.content)).toContain('"ok":true');
    // The checkpoint holds the same conversation.
    const persisted = done.messages as Msg[];
    expect(persisted.some((m) => m.role === "tool" && m.tool_call_id === "c1" && String(m.content).includes('"ok":true'))).toBe(true);

    // The trace: the park's challenge, then the approved call and its result.
    const trace = done.trace as AgentRunTraceEntry[];
    const confirmed = trace.filter((e) => e.confirmation === "confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ tool_call_id: "c1", tool: TOOL, args: PARKED, isError: false, iteration: 0 });
    expect(confirmed[0]!.completedAt).toBeDefined();
    // Iteration 0 asked and parked; the approved call completed it; iteration 1 reported.
    expect(done.iteration).toBe(2);

    expect(approvalPrompts()).toHaveLength(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: `${TOOL} approved and run`,
        refs: expect.objectContaining({ agentRunId: id, name: TOOL, confirmation: "confirmed" }),
      }),
    );
  });

  it("a denial executes nothing: the model gets CONFIRMATION_DENIED as the parked call's result and is not asked to re-issue", async () => {
    const model = rewordingModel();
    const { db, id, mcp } = await parked(model);
    expect(await decide(db, id, "denied")).toMatchObject({ ok: true, decision: "denied" });

    await resume(db, mcp, model);

    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("Not saved, as you asked.");
    expect(mcp.executed).toHaveLength(0);
    expect(mcp.minted()).toBe(1); // the park's challenge only; no handshake on a denial
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
    expectPendingCleared(done);
    expect(model.chat).toHaveBeenCalledTimes(2);
    const reply = model.seen[1]!.at(-1)!;
    expect(reply).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(String(reply.content)).toContain("CONFIRMATION_DENIED");
    const denied = (done.trace as AgentRunTraceEntry[]).filter((e) => e.confirmation === "denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ tool_call_id: "c1", tool: TOOL, args: PARKED, isError: true });
    expect(approvalPrompts()).toHaveLength(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ refs: expect.objectContaining({ agentRunId: id, confirmation: "denied" }) }),
    );
  });

  it("a second approval cannot double-execute: a repeat tap finds nothing parked, and a byte-identical re-issue is answered from the trace — not run, not parked", async () => {
    const model = rewordingModel({ repeat: true });
    const { db, id, mcp } = await parked(model);
    expect(await decide(db, id, "approved")).toMatchObject({ ok: true });
    // The owner taps Approve again before the worker gets to it.
    expect(await decide(db, id, "approved")).toEqual({ ok: false, reason: "not_parked" });

    await resume(db, mcp, model);
    // …and once more after the run is done; a further tick claims nothing.
    expect(await decide(db, id, "approved")).toEqual({ ok: false, reason: "not_parked" });
    expect((await resume(db, mcp, model, { workerId: "C" })).claimed).toBe(0);

    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("Saved the fact.");
    expect(mcp.executed).toEqual([{ name: TOOL, args: PARKED, token: "tok-2" }]);
    expect(mcp.minted()).toBe(2);
    expect(approvalPrompts()).toHaveLength(1);
    expectPendingCleared(done);
    const again = (done.trace as AgentRunTraceEntry[]).find((e) => e.tool_call_id === "c-again");
    expect(again).toMatchObject({ tool: TOOL, replayOf: "c1", isError: true });
    expect(String(again!.text)).toContain("REPEATED_CALL");
    expect(model.chat).toHaveBeenCalledTimes(3);
  });

  it("an approved call lost to a crash re-parks THE STORED call — not the model's rewording — and says it may already have run", async () => {
    let clock = new Date("2026-09-04T03:00:00Z");
    const now = () => clock;
    const model = rewordingModel();
    const { db, id, mcp } = await parked(model, { now });
    expect(await decide(db, id, "approved", clock)).toMatchObject({ ok: true });

    // The DB dies at the completion write, after the redeem ran the tool.
    let dead = false;
    db.setFailOn((op, args) => {
      const trace = (args as { data?: { trace?: AgentRunTraceEntry[] } }).data?.trace;
      if (op === "updateMany" && Array.isArray(trace) && trace.some((e) => e.confirmation === "confirmed" && e.completedAt)) {
        dead = true;
      }
      return dead;
    });
    await resume(db, mcp, model, { now });
    db.setFailOn(null);
    expect(db.row(id).status).toBe("running");
    expect(mcp.executed).toHaveLength(1);
    const asked = (model.chat as ReturnType<typeof vi.fn>).mock.calls.length;

    clock = new Date(clock.getTime() + 61_000);
    expect((await resume(db, mcp, model, { workerId: "C", now })).reclaimed).toBe(1);

    const reparked = db.row(id);
    expect(reparked.status).toBe("awaiting_confirmation");
    expect(reparked.pendingTool).toBe(TOOL);
    expect(reparked.pendingArgs).toEqual(PARKED);
    expect(reparked.pendingBindingHash).toBe(confirmationBindingHash(TOOL, PARKED));
    expect(reparked.pendingDecision).toBeNull();
    // Decided on the stored call alone: no model turn, no dispatch, no challenge.
    expect(model.chat).toHaveBeenCalledTimes(asked);
    expect(mcp.executed).toHaveLength(1);
    expect(mcp.minted()).toBe(2);
    const prompts = approvalPrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.body).toContain("MAY ALREADY");
    expect(prompts[1]!.body).not.toContain("Nothing has been done yet");
    const lost = (reparked.trace as AgentRunTraceEntry[]).filter((e) => e.unknownOutcome);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ tool: TOOL, args: PARKED, confirmation: "confirmed" });
  });

  it("the approval does not outlive the principal's reach: narrowed between approval and claim, the stored call is not run", async () => {
    const writes = vi.fn(async () => ({
      scope: { domains: new Set(["memory"]), writeDomains: new Set(["memory"]), locks: false },
      tier: "admin",
      unresolved: null,
    }));
    const readsOnly = vi.fn(async () => ({
      scope: { domains: new Set(["memory"]), writeDomains: new Set<string>(), locks: false },
      tier: "admin",
      unresolved: null,
    }));
    const model = rewordingModel();
    const { db, id, mcp } = await parked(model, { userId: "u-adm", resolveAccess: writes });
    expect(
      await decideAgentRun(db.prisma, {
        id,
        decision: "approved",
        decidedBy: { id: "u-adm", role: "admin" },
        resolveAccess: writes as never,
      }),
    ).toMatchObject({ ok: true });
    recordActivityMock.mockClear();

    await resume(db, mcp, model, { resolveAccess: readsOnly });

    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("The fact was not saved.");
    expect(mcp.executed).toHaveLength(0);
    expect(mcp.minted()).toBe(1);
    expectPendingCleared(done);
    const entry = (done.trace as AgentRunTraceEntry[]).find((e) => e.confirmation === "confirmed");
    expect(entry).toMatchObject({ tool: TOOL, isError: true });
    expect(String(entry!.text)).toContain("FORBIDDEN_TOOL_FOR_ROLE");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: `${TOOL} approved but did not run`, refs: expect.objectContaining({ confirmation: "confirmed_failed" }) }),
    );
  });

  it("what runs is what was approved: stored args that no longer match the parked binding are refused, nothing dispatched", async () => {
    const model = rewordingModel();
    const { db, id, mcp } = await parked(model);
    expect(await decide(db, id, "approved")).toMatchObject({ ok: true });
    db.row(id).pendingArgs = factArgs("Ship it without the tests.");
    recordActivityMock.mockClear();

    await resume(db, mcp, model);

    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("The fact was not saved.");
    expect(mcp.executed).toHaveLength(0);
    expect(mcp.minted()).toBe(1);
    expectPendingCleared(done);
    const entry = (done.trace as AgentRunTraceEntry[]).find((e) => e.confirmation === "confirmed");
    expect(entry).toMatchObject({ tool: TOOL, isError: true });
    expect(String(entry!.text)).toContain("APPROVED_CALL_MISMATCH");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: `${TOOL} approved but did not run` }),
    );
  });

  it("an approval on the run's last iteration runs the call and ends on the iteration cap — the model is not asked past it", async () => {
    const model = rewordingModel();
    const { db, id, mcp } = await parked(model, { maxIter: 1 });
    expect(await decide(db, id, "approved")).toMatchObject({ ok: true });

    await resume(db, mcp, model);

    const done = db.row(id);
    expect(mcp.executed).toEqual([{ name: TOOL, args: PARKED, token: "tok-2" }]);
    expect(model.chat).toHaveBeenCalledTimes(1);
    expect(done.status).toBe("failed");
    expect(done.stopReason).toBe("iteration_limit");
    expect(done.iteration).toBe(1);
    expectPendingCleared(done);
    expect(approvalPrompts()).toHaveLength(1);
  });

  it("a denied call re-sent byte for byte is answered with the same denial — not run, not parked again", async () => {
    const model = rewordingModel({ repeat: true });
    const { db, id, mcp } = await parked(model);
    expect(await decide(db, id, "denied")).toMatchObject({ ok: true });

    await resume(db, mcp, model);

    const done = db.row(id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("Not saved, as you asked.");
    expect(mcp.executed).toHaveLength(0);
    expect(mcp.minted()).toBe(1);
    expect(approvalPrompts()).toHaveLength(1);
    const again = (done.trace as AgentRunTraceEntry[]).find((e) => e.tool_call_id === "c-again");
    expect(again).toMatchObject({ tool: TOOL, replayOf: "c1", isError: true });
    expect(String(again!.text)).toContain("CONFIRMATION_DENIED");
  });

  it("an approved call that did NOT run is not answered from the trace: an identical re-send asks the owner again", async () => {
    const model = rewordingModel({ repeat: true });
    const { db, id, mcp } = await parked(model, { mcp: { refuseRedeem: true } });
    expect(await decide(db, id, "approved")).toMatchObject({ ok: true });

    await resume(db, mcp, model);

    const row = db.row(id);
    expect(mcp.executed).toHaveLength(0);
    expect(row.status).toBe("awaiting_confirmation");
    expect(row.pendingArgs).toEqual(PARKED);
    expect(row.pendingToolCallId).toBe("c-again");
    expect(approvalPrompts()).toHaveLength(2);
  });

  it("no confirmation token reaches the conversation or the row, even when the redeem leg hands one back", async () => {
    const model = rewordingModel();
    // A transport that flags the interceptor's challenge as an error: the
    // handshake stops at leg 1 and the challenge — token and all — is the
    // outcome it hands back.
    const { db, id, mcp } = await parked(model, { mcp: { challengeAsError: true } });
    expect(await decide(db, id, "approved")).toMatchObject({ ok: true });

    await resume(db, mcp, model);

    const done = db.row(id);
    expect(mcp.executed).toHaveLength(0);
    expect(mcp.minted()).toBe(2);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("The fact was not saved.");
    expect(JSON.stringify(model.seen)).not.toMatch(/tok-\d/);
    expect(rowText(done)).not.toMatch(/tok-\d/);
  });

  it("a run whose wall clock ran out while it waited in the queue does not run the approved call", async () => {
    const model = rewordingModel();
    const { db, id, mcp } = await parked(model);
    expect(await decide(db, id, "approved")).toMatchObject({ ok: true });
    db.row(id).deadlineAt = new Date(Date.now() - 1_000);

    await resume(db, mcp, model);

    const done = db.row(id);
    expect(done.status).toBe("failed");
    expect(done.stopReason).toBe("deadline");
    expect(mcp.executed).toHaveLength(0);
    expect(mcp.callTool).toHaveBeenCalledTimes(1); // the park's own dispatch only
    expectPendingCleared(done);
  });

  describe("a lease lost mid-resume stops the resume where it stands", () => {
    type Update = { where: Record<string, unknown>; data: Record<string, unknown> };
    /** Answer `count: 0` — the lease was taken — to the one write `lost` picks. */
    function loseLeaseOn(db: ReturnType<typeof createAgentRunPrismaMock>, lost: (u: Update) => boolean) {
      const updateMany = db.prisma.agentRun.updateMany as unknown as ReturnType<typeof vi.fn>;
      const real = updateMany.getMockImplementation()!;
      updateMany.mockImplementation(async (args: Update) => (lost(args) ? { count: 0 } : real(args)));
    }
    const confirmedEntry = (u: Update, completed: boolean) =>
      Array.isArray(u.data.trace) &&
      (u.data.trace as AgentRunTraceEntry[]).some((e) => e.confirmation === "confirmed" && Boolean(e.completedAt) === completed);

    it("lost at the write that consumes the approval: nothing is dispatched and the approval stays for the lease holder", async () => {
      const model = rewordingModel();
      const { db, id, mcp } = await parked(model);
      expect(await decide(db, id, "approved")).toMatchObject({ ok: true });
      loseLeaseOn(db, (u) => u.data.pendingDecision === null && u.data.messages === undefined && confirmedEntry(u, false));

      await resume(db, mcp, model);

      expect(mcp.executed).toHaveLength(0);
      expect(mcp.minted()).toBe(1);
      expect(model.chat).toHaveBeenCalledTimes(1);
      expect(db.row(id).pendingDecision).toBe("approved");
    });

    it("lost at the write that records the result: the model is not asked on a lease this worker no longer holds", async () => {
      const model = rewordingModel();
      const { db, id, mcp } = await parked(model);
      expect(await decide(db, id, "approved")).toMatchObject({ ok: true });
      loseLeaseOn(db, (u) => u.data.messages !== undefined && confirmedEntry(u, true));

      await resume(db, mcp, model);

      expect(mcp.executed).toHaveLength(1);
      expect(model.chat).toHaveBeenCalledTimes(1);
      expect(db.row(id).iteration).toBe(0);
    });
  });

  describe("a decided park never outlives the run: every terminal write clears it (WARP-2720)", () => {
    it("the principal can no longer be resolved at the claim: failed, nothing run, the approval gone with it", async () => {
      const model = rewordingModel();
      const { db, id, mcp } = await parked(model);
      expect(await decide(db, id, "approved")).toMatchObject({ ok: true });

      await resume(db, mcp, model, {
        resolveAccess: vi.fn(async () => ({ scope: null, tier: null, unresolved: "no_role" })),
      });

      const done = db.row(id);
      expect(done.status).toBe("failed");
      expect(done.error).toBe("attribution_failed:no_role");
      expect(mcp.executed).toHaveLength(0);
      expectPendingCleared(done);
    });

    it("the iteration cap was lowered while it sat parked: failed at the claim, the approval gone with it", async () => {
      const model = rewordingModel();
      const { db, id, mcp } = await parked(model);
      expect(await decide(db, id, "approved")).toMatchObject({ ok: true });
      db.row(id).maxIter = 0;

      await resume(db, mcp, model);

      const done = db.row(id);
      expect(done.status).toBe("failed");
      expect(done.stopReason).toBe("iteration_limit");
      expect(mcp.executed).toHaveLength(0);
      expectPendingCleared(done);
    });

    it("a claimed run that dies past AGENT_RUN_MAX_ATTEMPTS before consuming its approval: failed, the approval gone with it", async () => {
      let clock = new Date("2026-09-04T03:00:00Z");
      const now = () => clock;
      const model = rewordingModel();
      const { db, id, mcp } = await parked(model, { now });
      expect(await decide(db, id, "approved", clock)).toMatchObject({ ok: true });
      // A worker claimed it and vanished before touching the decision, on its last attempt.
      Object.assign(db.row(id), { status: "running", claimedBy: "gone", claimedAt: clock, heartbeatAt: clock, attempts: 3 });

      clock = new Date(clock.getTime() + 61_000);
      expect((await resume(db, mcp, model, { workerId: "C", now })).failed).toBe(1);

      const done = db.row(id);
      expect(done.status).toBe("failed");
      expect(mcp.executed).toHaveLength(0);
      expectPendingCleared(done);
    });
  });
});
