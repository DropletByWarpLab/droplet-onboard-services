/**
 * WARP-2997 — a background run on a cloud model passes the same two gates as
 * a chat turn, at EVERY claim:
 *
 *   - the per-person cloud gate (`decideCloudTurn`, WARP-1530): a person who
 *     may not use cloud gets no run, and the refusal is stored as an enum;
 *   - the stored-content egress gate (`withholdStoredContentTools` over
 *     `OFF_LAN_WITHHELD_DOMAINS`, WARP-1983/2746/2990): a permitted cloud run
 *     is not offered Drive, memory or business tools, and is told why.
 *
 * Every assertion is on what the MODEL was actually handed — the `tools` and
 * `messages` of the gateway request — not on an internal list.
 *
 * Only the two edges the gate reads are faked: the model catalogue
 * (`getModelProvider`) and the person's effective access (`cloud`). The
 * decision functions themselves are the real ones chat uses.
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
      maxIter: 10,
    },
  },
}));

const { recordActivityMock, cloudGrants, providers } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
  /** userId → the resolver's AND-gated `cloud` verdict. */
  cloudGrants: new Map<string, boolean>(),
  /** model → the catalogue's provider. */
  providers: new Map<string, string>([
    ["llama3.1:8b", "local"],
    ["claude-opus-4", "anthropic"],
  ]),
}));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));
vi.mock("../services/notifications.service.js", () => ({
  sendNotification: vi.fn().mockResolvedValue({ id: "n", channels: ["toast"], delivered: true }),
}));
vi.mock("../services/ai-gateway.client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ai-gateway.client.js")>()),
  getModelProvider: vi.fn(async (model: string) => providers.get(model)),
}));
vi.mock("../services/effective-access.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/effective-access.service.js")>()),
  resolveEffectiveAccess: vi.fn(async (userId: string) =>
    cloudGrants.has(userId) ? { cloud: cloudGrants.get(userId) } : null,
  ),
}));

import {
  AGENT_RUN_SYSTEM_PROMPT,
  createAgentRunWorker,
  enqueueAgentRun,
  runToolPool,
} from "../services/agent-run-worker.service.js";
import { tickAgentRunSchedules } from "../services/agent-run-schedule-ticker.service.js";
import {
  OFF_LAN_WITHHELD_NOTICE,
  OFF_LAN_WITHHELD_TOOLS,
} from "../services/stored-content-egress.service.js";
import { createAgentRunPrismaMock } from "./helpers/agent-run-prisma-mock.js";

const OWNER = { id: "u-owner", username: "romain", role: "owner" };
const LOCAL_MODEL = "llama3.1:8b";
const CLOUD_MODEL = "claude-opus-4";

/** One tool from each withheld domain, plus one that stays. */
const STORED = ["read_file", "search_files", "memory_recall", "business_find"];
const KEPT = "get_current_datetime";

interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

function answeringModel() {
  return vi.fn(async (_req: ModelRequest) => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: "assistant", content: "Report: done." } }] }),
  }));
}

function makeWorker(db: ReturnType<typeof createAgentRunPrismaMock>) {
  const chat = answeringModel();
  const worker = createAgentRunWorker({
    prisma: db.prisma,
    agent: {
      mcp: {
        listTools: vi
          .fn()
          .mockResolvedValue([KEPT, ...STORED].map((name) => ({ name, description: "d", inputSchema: {} }))),
        callTool: vi.fn(),
        isStarted: true,
      } as never,
      aiGateway: { chat } as never,
    },
    workerId: "worker-A",
    resolveAccess: (async () => ({ scope: null, tier: "owner", unresolved: null })) as never,
    toolSelectionMode: "off",
  });
  return { worker, chat };
}

async function runOnce(db: ReturnType<typeof createAgentRunPrismaMock>) {
  const { worker, chat } = makeWorker(db);
  await worker.tickOnce();
  while (worker.inFlight().size > 0) await new Promise((r) => setTimeout(r, 5));
  return chat;
}

const toolsHanded = (chat: ReturnType<typeof answeringModel>) =>
  (chat.mock.calls[0]![0].tools ?? []).map((t) => t.function.name).sort();
const systemHanded = (chat: ReturnType<typeof answeringModel>) => chat.mock.calls[0]![0].messages[0]!;

const terminalRefs = () =>
  recordActivityMock.mock.calls
    .map((c) => c[0] as { kind: string; what: string; refs: Record<string, unknown> })
    .filter((r) => r.kind === "tool_run")
    .at(-1)!.refs;

beforeEach(() => {
  recordActivityMock.mockClear();
  cloudGrants.clear();
});

describe("agent-run worker — cloud gate + stored-content gate (WARP-2997)", () => {
  it("precondition: the fixture's stored-content tools are in a run's pool and withheld off-LAN", () => {
    for (const t of [KEPT, ...STORED]) expect(runToolPool()).toContain(t);
    for (const t of STORED) expect(OFF_LAN_WITHHELD_TOOLS.has(t)).toBe(true);
    expect(OFF_LAN_WITHHELD_TOOLS.has(KEPT)).toBe(false);
  });

  it("a LOCAL run keeps the full surface and the plain prompt; nothing withheld", async () => {
    cloudGrants.set(OWNER.id, false); // irrelevant on the box: never read
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "summarise my contracts", model: LOCAL_MODEL });
    const chat = await runOnce(db);

    expect(toolsHanded(chat)).toEqual([KEPT, ...STORED].sort());
    expect(systemHanded(chat)).toEqual({ role: "system", content: AGENT_RUN_SYSTEM_PROMPT });
    expect(db.row(id)).toMatchObject({ status: "succeeded", cloudGate: "local", offLanProvider: null, offLanWithheldTools: [] });
    expect(terminalRefs()).toMatchObject({ cloudGate: "local" });
    expect(terminalRefs().offLanProvider).toBeUndefined();
  });

  it("an ALLOWED cloud run gets no Drive/memory/business tools, is told why, and records what was withheld", async () => {
    cloudGrants.set(OWNER.id, true);
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "summarise my contracts", model: CLOUD_MODEL });
    const chat = await runOnce(db);

    expect(chat.mock.calls[0]![0].model).toBe(CLOUD_MODEL);
    expect(toolsHanded(chat)).toEqual([KEPT]);
    expect(systemHanded(chat)).toEqual({
      role: "system",
      content: `${AGENT_RUN_SYSTEM_PROMPT}\n\n${OFF_LAN_WITHHELD_NOTICE}`,
    });
    const row = db.row(id);
    expect(row).toMatchObject({ status: "succeeded", cloudGate: "cloud_allowed", offLanProvider: "anthropic" });
    // Recorded at POOL level: every stored-content tool the run would have
    // had, not only the ones this fixture's MCP happens to list.
    const expectedWithheld = runToolPool().filter((t) => OFF_LAN_WITHHELD_TOOLS.has(t)).sort();
    for (const t of STORED) expect(expectedWithheld).toContain(t);
    expect([...row.offLanWithheldTools].sort()).toEqual(expectedWithheld);
    const refs = terminalRefs();
    expect(refs).toMatchObject({ agentRunId: id, status: "succeeded", cloudGate: "cloud_allowed", offLanProvider: "anthropic" });
    expect([...(refs.offLanWithheldTools as string[])].sort()).toEqual(expectedWithheld);
  });

  it("a REFUSED cloud run never reaches the model: failed, cloudGate=cloud_refused, audited", async () => {
    cloudGrants.set(OWNER.id, false);
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "summarise my contracts", model: CLOUD_MODEL });
    const chat = await runOnce(db);

    expect(chat).not.toHaveBeenCalled();
    expect(db.row(id)).toMatchObject({
      status: "failed",
      cloudGate: "cloud_refused",
      stopReason: "cloud_refused",
      offLanProvider: "anthropic",
    });
    expect(db.row(id).error).toMatch(/^off_lan_blocked: Cloud models are not available/);
    expect(terminalRefs()).toMatchObject({ agentRunId: id, status: "failed", cloudGate: "cloud_refused" });
  });

  it("an unreadable gate fails closed: cloud_unverified, no model call", async () => {
    // No entry for the owner → resolveEffectiveAccess returns null → 503.
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: OWNER.id, goal: "g", model: CLOUD_MODEL });
    const chat = await runOnce(db);
    expect(chat).not.toHaveBeenCalled();
    expect(db.row(id)).toMatchObject({ status: "failed", cloudGate: "cloud_unverified" });
  });

  it("a SCHEDULED cloud run is re-checked at every fire: revoking the grant stops the next one", async () => {
    cloudGrants.set(OWNER.id, true);
    const db = createAgentRunPrismaMock({ users: [OWNER] });
    await db.prisma.agentRunSchedule.create({
      data: {
        userId: OWNER.id,
        goal: "morning digest",
        model: CLOUD_MODEL,
        maxIter: 10,
        rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0",
        timezone: "UTC",
        nextFireAt: new Date("2026-09-04T06:00:00Z"),
      },
    });

    await tickAgentRunSchedules(db.prisma, new Date("2026-09-04T06:00:30Z"));
    const first = await runOnce(db);
    expect(toolsHanded(first)).toEqual([KEPT]);
    expect(db.rows[0]).toMatchObject({ status: "succeeded", cloudGate: "cloud_allowed" });

    // The owner's role loses cloud models. The schedule itself is untouched.
    cloudGrants.set(OWNER.id, false);
    db.schedules[0]!.nextFireAt = new Date("2026-09-05T06:00:00Z");
    await tickAgentRunSchedules(db.prisma, new Date("2026-09-05T06:00:30Z"));
    expect(db.rows).toHaveLength(2);
    const second = await runOnce(db);

    expect(second).not.toHaveBeenCalled();
    expect(db.rows[1]).toMatchObject({
      scheduleId: db.schedules[0]!.id,
      status: "failed",
      cloudGate: "cloud_refused",
    });
  });
});
