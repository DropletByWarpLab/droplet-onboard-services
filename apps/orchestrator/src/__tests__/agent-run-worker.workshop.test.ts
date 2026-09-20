/**
 * WARP-2896 (ADR-056 slice G) — a WORKSHOP run: the workspace tools in the
 * pool, the workspace on the wire, the replay rule, and the ending.
 *
 *   1. `WORKSPACE_TOOLS` is DERIVED from the tool→route manifest — every tool
 *      whose every hop is under `/api/workspace/` — and this test ENUMERATES
 *      the members, so a tool that gains a hop elsewhere (or a new tool
 *      that slips under the prefix) is a visible diff, not a silent change
 *      to what an unattended run may write.
 *   2. A run WITH a workspace carries them; a run WITHOUT does not; the
 *      Romain-2026-09-04 clause (no ungated write but send_notification)
 *      still holds for the ordinary pool.
 *   3. `redispatchSafe`: write / commit / run repeat (idempotent by
 *      contract, loudly); propose is gated and follows the confirming rule.
 *   4. `workspace_propose` ENDS the run: Tier-2 parks it, the owner
 *      approves, the resumed worker performs the handshake, the tool runs
 *      ONCE, and the run is `succeeded` with `stopReason: proposed` and the
 *      proposal as its result — the model is never asked for a final answer
 *      and the person is notified.
 *   5. `_meta.workspaceId` rides every dispatch of a workshop run and none
 *      of an ordinary one.
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

import { TOOL_CATALOG, TOOL_ROUTES } from "@droplet/tools-core";
import {
  WORKSPACE_TOOLS,
  createAgentRunWorker,
  decideAgentRun,
  enqueueAgentRun,
  redispatchSafe,
  runToolPool,
} from "../services/agent-run-worker.service.js";
import { createAgentRunPrismaMock } from "./helpers/agent-run-prisma-mock.js";

const OWNER = { id: "u-owner", username: "romain", role: "owner" };
const ownerAccess = vi.fn(async () => ({ scope: null, tier: "owner", unresolved: null }));

const EXPECTED_WORKSPACE_TOOLS = [
  "workspace_read",
  "workspace_search",
  "workspace_diff",
  "workspace_log",
  "workspace_write",
  "workspace_commit",
  "workspace_run",
  "workspace_propose",
];

describe("WORKSPACE_TOOLS is the manifest's /api/workspace/ family, enumerated", () => {
  it("names exactly the eight WARP-2896 tools", () => {
    expect([...WORKSPACE_TOOLS].sort()).toEqual([...EXPECTED_WORKSPACE_TOOLS].sort());
  });

  it("is derived, not listed: every member's every hop is under /api/workspace/, and nothing else's is", () => {
    for (const entry of TOOL_ROUTES) {
      const under = entry.hops.length > 0 && entry.hops.every((h) => h.pathPattern.startsWith("/api/workspace/"));
      expect(WORKSPACE_TOOLS.has(entry.tool), entry.tool).toBe(under);
    }
  });
});

describe("runToolPool — the workshop's tools ride a workspace-bound run only", () => {
  it("an ordinary run carries none of them; the ungated-write clause still holds", () => {
    const pool = new Set(runToolPool());
    for (const name of EXPECTED_WORKSPACE_TOOLS) expect(pool.has(name), name).toBe(false);
    const unattendedWrites = TOOL_CATALOG.filter((t) => pool.has(t.name) && t.requiresWrite && !t.requiresConfirmation).map((t) => t.name);
    expect(unattendedWrites).toEqual(["send_notification"]);
  });

  it("a workshop run carries all eight, on top of the ordinary pool", () => {
    // MUTATION: drop the `opts.workspace === true && WORKSPACE_TOOLS.has`
    // clause and the eight vanish; drop the `!WORKSPACE_TOOLS.has` clause
    // from the general branch and the four reads leak into ordinary runs.
    const ordinary = new Set(runToolPool());
    const workshop = new Set(runToolPool({ workspace: true }));
    for (const name of EXPECTED_WORKSPACE_TOOLS) expect(workshop.has(name), name).toBe(true);
    for (const name of ordinary) expect(workshop.has(name), name).toBe(true);
    expect(workshop.size).toBe(ordinary.size + EXPECTED_WORKSPACE_TOOLS.length);
    // The ungated writes a workshop run may carry are exactly the notification
    // channel plus the three workspace writes — and nothing else.
    const unattended = TOOL_CATALOG.filter((t) => workshop.has(t.name) && t.requiresWrite && !t.requiresConfirmation).map((t) => t.name).sort();
    expect(unattended).toEqual(["send_notification", "workspace_commit", "workspace_run", "workspace_write"]);
    expect(workshop.has("start_agent_run")).toBe(false);
  });
});

describe("redispatchSafe — the workspace replay rule", () => {
  it("write, commit and run repeat; propose follows the confirming rule", () => {
    // MUTATION: drop the WORKSPACE_TOOLS clause in redispatchSafe and the
    // three ungated writes fall to the `false` branch — a lost
    // workspace_write would halt the run as unknown_outcome.
    expect(redispatchSafe("workspace_write", {})).toBe(true);
    expect(redispatchSafe("workspace_commit", {})).toBe(true);
    expect(redispatchSafe("workspace_run", {})).toBe(true);
    expect(redispatchSafe("workspace_propose", {})).toBe(true);
    expect(redispatchSafe("workspace_propose", { confirmation: "confirmed" })).toBe(false);
    // The rule is scoped: an ordinary ungated write is still never repeated.
    expect(redispatchSafe("send_notification", {})).toBe(false);
  });
});

// ── the ending ──────────────────────────────────────────────────────────

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

function scripted(script: (req: { messages: Array<{ role: string; content: unknown }> }) => unknown) {
  return vi.fn(async (req: { messages: Array<{ role: string; content: unknown }> }) => ({
    ok: true,
    json: async () => ({ choices: [{ message: script(req) }] }),
  }));
}

/** The model: write a file, then propose; if ever asked again, it would keep going. */
const writeThenPropose = (req: { messages: Array<{ role: string; content: unknown }> }) => {
  const replies = req.messages.filter((m) => m.role === "tool");
  if (replies.length === 0) {
    return { role: "assistant", content: null, tool_calls: [toolCall("c1", "workspace_write", { path: "a.txt", content: "x" })] };
  }
  const last = String(replies[replies.length - 1]!.content);
  if (last.includes("confirmation_required")) return { role: "assistant", content: "Waiting for your approval." };
  if (last.includes("proposal/")) {
    // Would keep calling tools after a proposal — the worker must not let it.
    return { role: "assistant", content: null, tool_calls: [toolCall("c9", "workspace_write", { path: "b.txt", content: "y" })] };
  }
  return { role: "assistant", content: null, tool_calls: [toolCall("c2", "workspace_propose", { name: "N", version: "0.1.0", summary: "s" })] };
};

function interceptingMcp(tier2: Set<string>) {
  let minted = 0;
  const live = new Set<string>();
  const executed: Array<{ name: string; args: Record<string, unknown>; ctx?: Record<string, unknown> }> = [];
  const wire = (payload: unknown, isError = false) => ({ isError, content: [{ type: "text", text: JSON.stringify(payload) }] });
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
    if (tier2.has(name)) {
      const presented = ctx?.confirmationToken as string | undefined;
      if (presented) {
        if (!live.has(presented)) {
          return wire({ status: "confirmation_required", error: { code: "CONFIRMATION_REJECTED", message: "refused", details: { interceptor: { outcome: "confirmation_rejected", tool: name } } } });
        }
        live.delete(presented);
      } else {
        const token = `tok-${++minted}`;
        live.add(token);
        return wire({
          status: "confirmation_required",
          error: {
            code: "CONFIRMATION_REQUIRED",
            message: "needs a thumbs-up",
            details: { interceptor: { outcome: "confirmation_required", tool: name, confirmationToken: token, expiresAt: Date.now() + 300_000 }, confirmationToken: token },
          },
        });
      }
    }
    executed.push({ name, args, ctx });
    if (name === "workspace_propose") return wire({ ok: true, data: { tag: "proposal/0.1.0", commit: "abc" } });
    return wire({ ok: true, data: { changed: true } });
  });
  const listed = [...EXPECTED_WORKSPACE_TOOLS, "list_files"].map((name) => ({ name, description: "d", inputSchema: {} }));
  return {
    mcp: { listTools: vi.fn().mockResolvedValue(listed), callTool, isStarted: true } as never,
    callTool,
    executed,
  };
}

function makeWorker(db: ReturnType<typeof createAgentRunPrismaMock>, mcp: ReturnType<typeof interceptingMcp>, workerId = "A") {
  const chat = scripted(writeThenPropose);
  const worker = createAgentRunWorker({
    prisma: db.prisma,
    agent: { mcp: mcp.mcp, aiGateway: { chat } as never },
    workerId,
    resolveAccess: ownerAccess as never,
    toolSelectionMode: "off",
  });
  return { worker, chat };
}

async function settle(worker: ReturnType<typeof createAgentRunWorker>) {
  while (worker.inFlight().size > 0) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  recordActivityMock.mockClear();
  sendNotificationMock.mockClear();
});

describe("a workshop run ends on workspace_propose (WARP-2896)", () => {
  it("write runs ungated with the workspace on the wire; propose parks; approve → the tool runs once and the run is succeeded/proposed", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "build a word counter", model: "m", workspaceId: "ws-a" });
    const mcp = interceptingMcp(new Set(["workspace_propose"]));
    const a = makeWorker(db, mcp, "A");
    await a.worker.tickOnce();
    await settle(a.worker);

    // The ungated write ran, addressed with the workspace and the run.
    expect(mcp.executed.map((e) => e.name)).toEqual(["workspace_write"]);
    expect(mcp.executed[0]!.ctx).toMatchObject({ agentRunId: id, workspaceId: "ws-a", userId: "romain" });
    // Propose parked the run.
    const parked = db.row(id);
    expect(parked.status).toBe("awaiting_confirmation");
    expect(parked.pendingTool).toBe("workspace_propose");

    // The owner approves; a fresh worker resumes.
    expect(await decideAgentRun(db.prisma, { id, decision: "approved", decidedBy: { id: OWNER.id, username: "romain", role: "owner" } })).toMatchObject({ ok: true });
    const b = makeWorker(db, mcp, "B");
    await b.worker.tickOnce();
    await settle(b.worker);

    const row = db.row(id);
    expect(row.status).toBe("succeeded");
    expect(row.stopReason).toBe("proposed");
    expect(row.result).toContain("proposal/0.1.0");
    expect(row.pendingTool).toBeNull();
    // The proposal ran exactly once, and NOTHING after it — the model's
    // next write (c9) was never dispatched, and the model was not asked.
    expect(mcp.executed.map((e) => e.name)).toEqual(["workspace_write", "workspace_propose"]);
    expect(b.chat).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "romain", title: "Extension proposed" }),
    );
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: "Agent run proposed an extension", refs: expect.objectContaining({ agentRunId: id }) }),
    );
  });

  it("an ordinary run puts no workspaceId on the wire and never sees the workspace tools", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: "m" });
    const mcp = interceptingMcp(new Set());
    const { worker } = makeWorker(db, mcp);
    await worker.tickOnce();
    await settle(worker);
    // workspace_write is outside the ordinary pool: refused, never dispatched.
    expect(mcp.executed).toEqual([]);
    expect(db.row(id).workspaceId).toBeNull();
    for (const call of mcp.callTool.mock.calls) {
      expect((call[2] as Record<string, unknown> | undefined)?.workspaceId).toBeUndefined();
    }
  });
});
