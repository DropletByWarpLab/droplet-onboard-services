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
// Only the DB read of the §3 resolver is faked; the composition, the scope
// builder and the worker's own attributed-access resolver stay real.
const resolveEffectiveAccessMock = vi.hoisted(() => vi.fn());
vi.mock("../services/effective-access.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/effective-access.service.js")>()),
  resolveEffectiveAccess: resolveEffectiveAccessMock,
}));

import type { ModuleId } from "@prisma/client";
import { TOOL_CATALOG, TOOL_ROUTES } from "@droplet/tools-core";
import { GATEABLE_MODULE_IDS, GRANTABLE_TOOL_DOMAINS } from "../services/access-catalog.js";
import { computeEffectiveAccess, type EffectiveAccessInputs } from "../services/effective-access.service.js";
import {
  WORKSPACE_TOOLS,
  WORKSPACE_TOOL_DOMAINS,
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

function makeWorker(
  db: ReturnType<typeof createAgentRunPrismaMock>,
  mcp: ReturnType<typeof interceptingMcp>,
  workerId = "A",
  toolSelectionMode: "off" | "domains" = "off",
) {
  const chat = scripted(writeThenPropose);
  const worker = createAgentRunWorker({
    prisma: db.prisma,
    agent: { mcp: mcp.mcp, aiGateway: { chat } as never },
    workerId,
    resolveAccess: ownerAccess as never,
    toolSelectionMode,
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
      expect.objectContaining({ username: "romain", title: "Extension proposed" }),
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

// ── what the MODEL is offered, under the shipping selection mode ──────────
//
// Every test above runs with `toolSelectionMode: "off"`, which advertises the
// whole pool — so they proved the POOL and never what reached the model. The
// box ships `TOOL_SELECTION_MODE=domains` (config.ts default), where each
// turn advertises the core floor plus the domains the sentence matches. The
// `workspace` domain has no keyword rule (chat must never be promised it), so
// on the bench box (2026-09-23) a workshop run was offered ZERO workspace
// tools, answered that it had no way to edit or propose, and ended
// `model_done` with no tool call. These pin the fix: the worker hands the
// run's binding to the loop as `bound_tool_domains` (WORKSPACE_TOOL_DOMAINS),
// and selection admits a bound domain on every turn.

function advertisedOnFirstTurn(chat: ReturnType<typeof scripted>): string[] {
  const req = chat.mock.calls[0]![0] as unknown as { tools?: Array<{ function: { name: string } }> };
  return (req.tools ?? []).map((t) => t.function.name);
}

describe("a workshop run is OFFERED its tools under domain selection (WARP-2896, live-proof regression)", () => {
  // The live proof's goal: names no workspace word and matches no rule that
  // would reach the domain.
  const GOAL =
    "Extend the extension: in src/index.ts add a 'lines' field to Output that counts the lines of input.text. Add a test for it, then run the build and the tests, commit, and propose version 0.2.0.";

  it("the first turn advertises all eight workspace tools, and the run reaches `proposed`", async () => {
    // MUTATION: drop the worker's `bound_tool_domains` spread (or the
    // `boundDomains` merge in effectiveAdvertisedToolNames) and the eight
    // vanish from the first turn — the live failure.
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: GOAL, model: "m", workspaceId: "ws-d" });
    const mcp = interceptingMcp(new Set(["workspace_propose"]));
    const a = makeWorker(db, mcp, "A", "domains");
    await a.worker.tickOnce();
    await settle(a.worker);

    const offered = advertisedOnFirstTurn(a.chat);
    for (const name of EXPECTED_WORKSPACE_TOOLS) expect(offered, name).toContain(name);
    expect(db.row(id).status).toBe("awaiting_confirmation");
    expect(db.row(id).pendingTool).toBe("workspace_propose");

    expect(await decideAgentRun(db.prisma, { id, decision: "approved", decidedBy: { id: OWNER.id, username: "romain", role: "owner" } })).toMatchObject({ ok: true });
    const b = makeWorker(db, mcp, "B", "domains");
    await b.worker.tickOnce();
    await settle(b.worker);
    expect(db.row(id).status).toBe("succeeded");
    expect(db.row(id).stopReason).toBe("proposed");
    expect(mcp.executed.map((e) => e.name)).toEqual(["workspace_write", "workspace_propose"]);
  });

  it("WORKSPACE_TOOL_DOMAINS is read off the catalog: exactly the workspace domain", () => {
    expect([...WORKSPACE_TOOL_DOMAINS]).toEqual(["workspace"]);
  });

  it("an ordinary run under the same mode is offered none of them", async () => {
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: GOAL, model: "m" });
    const mcp = interceptingMcp(new Set());
    const { worker, chat } = makeWorker(db, mcp, "A", "domains");
    await worker.tickOnce();
    await settle(worker);
    const offered = advertisedOnFirstTurn(chat);
    for (const name of EXPECTED_WORKSPACE_TOOLS) expect(offered, name).not.toContain(name);
    expect(mcp.executed).toEqual([]);
  });
});

// ── a role-scoped ADMIN with every module switched off ─────────────────────
//
// Every run above belongs to an OWNER, and owners bypass the feature axis
// (resolveAttributedToolAccess answers `scope: null`), so none of them says
// anything about it. An admin holding an access role is narrowed by §3:
// toolDomains = writeFilter(tier) ∩ moduleToolDomains(features) ∩ roleToolGrants.
// Since #2295 (WARP-2742) the middle term FAILS CLOSED: a domain no module
// claims passes only when FEATURE_UNGATED_TOOL_DOMAINS (access-catalog.ts)
// declares it. No module owns the workshop, so `workspace` is declared there;
// this pins why. With every module off, the admin's workshop run must still
// be offered the eight tools, and its write must still dispatch.

describe("a role-scoped ADMIN's workshop run keeps the workspace tools with every module off (WARP-2896 × WARP-2742)", () => {
  const ADMIN = { id: "u-admin", username: "stefan", role: "admin" };

  it("the run's pool offers all eight workspace tools and the write dispatches", async () => {
    // MUTATION: delete `workspace` from FEATURE_UNGATED_TOOL_DOMAINS and
    // domainsForFeatures drops the domain, the admin's scope loses it, and the
    // eight leave the run's pool: absent from the turn AND refused at dispatch.
    const toolGrants = GRANTABLE_TOOL_DOMAINS.map((domain) => ({ domain, level: "use" as const }));
    const inputs: EffectiveAccessInputs = {
      user: {
        id: ADMIN.id,
        role: "admin",
        accessRole: {
          mayOperateLocks: false,
          cloudModelsAllowed: false,
          storageQuotaBytes: null,
          maxUploadSizeMb: null,
          llmDailyMessageCap: null,
          // The widest Admin-based role: every feature at manage, every
          // grantable tool domain at `use`. The box is what switches them off.
          featureGrants: GATEABLE_MODULE_IDS.map((moduleId) => ({ moduleId, level: "manage" as const })),
          toolGrants,
          connectorGrants: [],
        },
      },
      exceptions: [],
      // Every gateable module off box-wide; only the always-on chat floor.
      workspaceModuleIds: new Set<ModuleId>(["chat"]),
      cloudEscapeEnabled: false,
      connections: [],
      usagePolicy: null,
      deptRights: [],
    };
    const effective = computeEffectiveAccess(inputs);
    // Precondition: the feature set really does exclude every module.
    const gateable = new Set<string>(GATEABLE_MODULE_IDS);
    expect(effective.features.filter((f) => gateable.has(f.moduleId))).toEqual([]);
    resolveEffectiveAccessMock.mockReset();
    resolveEffectiveAccessMock.mockResolvedValue(effective);

    // The row the worker's resolver reads: an active admin WITH an access role.
    const adminRow = { ...ADMIN, directoryStatus: "ACTIVE", accessRoleId: "r-admin", accessRole: { toolGrants } };
    const db = createAgentRunPrismaMock({ users: [adminRow] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: ADMIN.id, goal: "build a word counter", model: "m", workspaceId: "ws-admin" });
    const mcp = interceptingMcp(new Set(["workspace_propose"]));
    const chat = scripted(writeThenPropose);
    // No `resolveAccess` override: the worker's own attributed resolver, the
    // one production uses, reads the role. Shipping selection mode.
    const worker = createAgentRunWorker({
      prisma: db.prisma,
      agent: { mcp: mcp.mcp, aiGateway: { chat } as never },
      workerId: "A",
      toolSelectionMode: "domains",
    });
    await worker.tickOnce();
    await settle(worker);

    // The admin was narrowed through §3 (the owner bypass did not fire) ...
    expect(resolveEffectiveAccessMock).toHaveBeenCalledWith(ADMIN.id);
    // ... and the run was still offered all eight, and its write dispatched.
    const offered = advertisedOnFirstTurn(chat);
    for (const name of EXPECTED_WORKSPACE_TOOLS) expect(offered, name).toContain(name);
    expect(mcp.executed.map((e) => e.name)).toEqual(["workspace_write"]);
    expect(db.row(id).pendingTool).toBe("workspace_propose");
  });
});
