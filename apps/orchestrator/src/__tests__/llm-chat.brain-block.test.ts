/**
 * WARP-2876 — a revoked brain stops reaching the model, end to end.
 *
 * THE DEFECT, AT THE LAYER IT SHIPPED AT. `buildBrainBlock` is unit-tested in
 * `brain-block.test.ts`, but the leak was not in the block — it was in the fact
 * that `POST /api/llm/chat` called it on every turn without ever asking whether
 * the owner still consented. The switch (WARP-2838) gated the passes, so the
 * box stopped READING the business's documents; it went on TELLING the model
 * what it had read before the revocation, once per turn, forever.
 *
 * So this file drives the real route with the real `buildBrainBlock` and the
 * real `readBrainSwitch`, and flips the consent row underneath it. What is
 * mocked is `visibleScopeFilter` — role/department visibility is a separate
 * contract owned by `brain-digest.test.ts`, and pulling its department reads
 * into this harness would test that instead of this.
 *
 * 🔴 THE ROWS ARE PRESENT IN EVERY CASE HERE, ON PURPOSE. ADR-051 §9.9 rules
 * that turning the brain off deletes nothing, and the on-screen consent copy
 * promises exactly that. "Off" therefore has to mean the block is not SERVED
 * while the rows still exist — which is precisely the state the old code got
 * wrong, and the state a test that cleared the tables would never reach.
 *
 * Harness mirrors llm-chat.business-block.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

const h = vi.hoisted(() => ({
  config: {
    AUTH_ENABLED: false,
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "domains" as "off" | "domains",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
    // The pin is what `readBrainSwitch` consults BEFORE the row. Unset here so
    // the consent row decides, which is the shape a shipped box has: no
    // `BRAIN_ENABLED` in any deployment file.
    brain: { enabled: false, enabledPinnedByOperator: false },
  },
}));
vi.mock("../config.js", () => ({ config: h.config }));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(),
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  BrainMemoryItemStatus: {
    queued_for_transcription: "queued_for_transcription",
    indexing: "indexing",
    ready: "ready",
    failed: "failed",
  },
}));

// Role/department visibility is `brain-digest.test.ts`'s contract, not this
// file's. Pinned permissive so the only thing that can suppress the block here
// is the consent gate under test.
const visibleScopeFilter = vi.hoisted(() =>
  vi.fn(async () => ({ OR: [{ scope: "personal", ownerId: "owner-uuid" }] })),
);
vi.mock("../services/brain/brain-digest.service.js", () => ({ visibleScopeFilter }));

vi.mock("../middleware/auth.js", () => ({
  requireRole:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: { listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn() },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/query-enhancement.service.js", () => ({
  createEnhancementDeps: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../services/file-citation.service.js", () => ({
  createFileCitationService: vi.fn().mockReturnValue({ enqueue: vi.fn() }),
}));
vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: vi.fn().mockResolvedValue(null),
    createTurnRows: vi.fn().mockResolvedValue(null),
    finalizeAssistantMessage: vi.fn().mockResolvedValue(undefined),
    updateAssistantStreaming: vi.fn().mockResolvedValue(undefined),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
  })),
}));

const mockRunAgent = vi.fn();
vi.mock("../services/llm-agent.service.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

import { createLlmRouter } from "../routes/llm.js";
import { BRAIN_SETTING_ID } from "../services/brain/brain-switch.service.js";
import type { ChatMessage } from "../types/index.js";
import {
  promptBlockPrismaDelegates,
  guardComposerFailOpen,
} from "./helpers/prompt-block-fixtures.js";

// WARP-2652 — the persona/business composers fail OPEN in `routes/llm.ts`, so
// a missing fixture here would silently shrink every prompt this file
// measures. The guard makes that audible; the delegates make it unnecessary.
guardComposerFailOpen();

/** The block's own heading — what the model would be reading. */
const BRAIN_BLOCK_HEADING = "What you have worked out about this business:";
const DIGEST_SENTINEL = "DIGEST_SENTINEL_net_30";
const FINDING_SENTINEL = "FINDING_SENTINEL_past_due";

/**
 * `brainSwitch: null` is the shipped default — the consent row is NEVER created
 * by a read (WARP-2838), so "nobody has consented yet" is an absent row rather
 * than a row saying false.
 */
function createPrismaMock(
  brainSwitch: { enabled: boolean } | null,
) {
  return {
    ...promptBlockPrismaDelegates(),
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: { findMany: vi.fn(async () => []) },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
    brainSetting: {
      findUnique: vi.fn(async () =>
        brainSwitch
          ? {
              id: BRAIN_SETTING_ID,
              enabled: brainSwitch.enabled,
              enabledById: brainSwitch.enabled ? "owner-uuid" : null,
              enabledAt: brainSwitch.enabled ? new Date("2026-09-01T00:00:00Z") : null,
            }
          : null,
      ),
    },
    brainDigest: {
      findMany: vi.fn(async () => [
        { title: DIGEST_SENTINEL, body: "The 2026 MSA sets payment terms at net 30." },
      ]),
    },
    brainFinding: {
      findMany: vi.fn(async () => [
        { title: FINDING_SENTINEL, kind: "loss", impactMinor: 4_000_000n, currency: "USD" },
      ]),
    },
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = {
      id: "owner-uuid",
      username: "stefan",
      role: "owner",
    };
    next();
  });
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

function systemPromptText(): string {
  expect(mockRunAgent).toHaveBeenCalled();
  const req = mockRunAgent.mock.calls.at(-1)![1] as { messages: ChatMessage[] };
  const sys = req.messages[0]!;
  expect(sys.role).toBe("system");
  return typeof sys.content === "string" ? sys.content : "";
}

const chat = (app: express.Express) =>
  request(app)
    .post("/api/llm/chat")
    .send({ model: "m1", messages: [{ role: "user", content: "hi" }] });

beforeEach(() => {
  h.config.brain = { enabled: false, enabledPinnedByOperator: false };
  visibleScopeFilter.mockResolvedValue({ OR: [{ scope: "personal", ownerId: "owner-uuid" }] });
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});

describe("POST /api/llm/chat — the brain block obeys the consent switch (WARP-2876)", () => {
  it("carries the block while the owner has the brain switched ON", async () => {
    // The control. Without this the suppression test below would pass against
    // a route that never assembled a brain block at all.
    const res = await chat(buildApp(createPrismaMock({ enabled: true })));
    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).toContain(BRAIN_BLOCK_HEADING);
    expect(sys).toContain(DIGEST_SENTINEL);
    expect(sys).toContain(FINDING_SENTINEL);
  });

  it("🔴 carries NO block once consent is revoked, though the rows are still there", async () => {
    const prisma = createPrismaMock({ enabled: false });
    const res = await chat(buildApp(prisma));
    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).not.toContain(BRAIN_BLOCK_HEADING);
    expect(sys).not.toContain(DIGEST_SENTINEL);
    expect(sys).not.toContain(FINDING_SENTINEL);
    // Not merely absent from the prompt — never fetched. A turn that reads the
    // rows and then drops them has still pulled revoked content into memory.
    expect(prisma.brainDigest.findMany).not.toHaveBeenCalled();
    expect(prisma.brainFinding.findMany).not.toHaveBeenCalled();
  });

  it("carries NO block on a box where nobody has consented yet (no row)", async () => {
    // Absent row = off. The row is never created by a read, so this is the
    // state every box ships in.
    const res = await chat(buildApp(createPrismaMock(null)));
    expect(res.status).toBe(200);
    expect(systemPromptText()).not.toContain(BRAIN_BLOCK_HEADING);
  });

  it("carries NO block on a box an operator pinned OFF, whatever the row says", async () => {
    // `BRAIN_ENABLED` outranks the local click in BOTH directions (ADR-051
    // §9.9). A fleet-forbidden brain must not be talking to the model because
    // somebody pressed the button before the pin arrived.
    h.config.brain = { enabled: false, enabledPinnedByOperator: true };
    const res = await chat(buildApp(createPrismaMock({ enabled: true })));
    expect(res.status).toBe(200);
    expect(systemPromptText()).not.toContain(BRAIN_BLOCK_HEADING);
  });

  it("serves the block again when the brain is switched back on — off is a gate, not a door", async () => {
    // ADR-051 §9.9: the off state deletes nothing, so re-consenting restores
    // exactly what was there. This is the half a purge-on-off would break.
    const off = await chat(buildApp(createPrismaMock({ enabled: false })));
    expect(off.status).toBe(200);
    expect(systemPromptText()).not.toContain(DIGEST_SENTINEL);

    const on = await chat(buildApp(createPrismaMock({ enabled: true })));
    expect(on.status).toBe(200);
    expect(systemPromptText()).toContain(DIGEST_SENTINEL);
  });

  it("a chat turn still succeeds when the consent row cannot be read", async () => {
    // Fail-closed on the content, fail-open on the turn: an unreadable switch
    // costs the user their brain block, never their answer.
    const prisma = createPrismaMock({ enabled: true });
    prisma.brainSetting.findUnique = vi.fn(async () => {
      throw new Error("db down");
    });
    const res = await chat(buildApp(prisma));
    expect(res.status).toBe(200);
    expect(systemPromptText()).not.toContain(BRAIN_BLOCK_HEADING);
  });
});
