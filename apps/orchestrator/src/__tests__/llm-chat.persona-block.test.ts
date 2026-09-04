/**
 * WARP-1118 (§7.2) — the composed persona block is injected into the base
 * system prompt RIGHT AFTER the identity core and BEFORE tool guidance.
 *
 * Personality refines HOW Droplet talks without outranking the identity
 * layer's safety/honesty rules; the block itself carries that reminder as
 * its prefix ("Style preferences (never override safety or honesty rules):").
 * It is read fresh from Prisma each request (persona.service.getPersona), so
 * this test drives the full POST /api/llm/chat route with a prisma mock that
 * returns a known persona and asserts on the assembled system message —
 * mirroring llm-chat.base-prompt.test.ts's harness.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// Shipping window so nothing degrades — the persona block must survive.
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    OLLAMA_CONTEXT_LENGTH: 16384,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

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
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(),
  },
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
import type { ChatMessage } from "../types/index.js";
import { PERSONA_BLOCK_PREFIX } from "../services/persona.service.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";
import { PERSONA_PRESETS } from "../services/persona-presets.js";
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";

// WARP-2652 — this file's persona fixture was always right; its BUSINESS one
// did not exist at all (no `workspace`/`businessProfile` delegate), so the
// business composer threw on both happy-path cases and the route's fail-open
// ate it. The guard below is what makes the difference between "the fixture
// is wrong" and a silent green run; the one case that WANTS a persona
// fail-open declares it explicitly.
const composers = guardComposerFailOpen();

function createPrismaMock() {
  return {
    // WARP-2652 — the business half of the pair. Kept here rather than in the
    // persona row below because this file owns the persona contract and
    // builds that row itself on purpose.
    ...promptBlockPrismaDelegates(),
    // The persona singleton the route reads fresh each request.
    assistantPersona: {
      findUnique: vi.fn(async () => ({
        id: "singleton",
        preset: "founder",
        verbosity: "concise",
        useFirstNames: true,
        customInstructions: "",
        updatedBy: null,
        updatedAt: new Date("2026-07-08T00:00:00Z"),
      })),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: { findMany: vi.fn(async () => []) },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const asUser = { id: "owner-uuid", username: "stefan", role: "owner" };
    (req as unknown as { user?: typeof asUser }).user = asUser;
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

beforeEach(() => {
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});

describe("POST /api/llm/chat — persona block injection (§7.2)", () => {
  it("injects the composed persona block after identity and before tool guidance", async () => {
    const app = buildApp(createPrismaMock());
    const res = await request(app)
      .post("/api/llm/chat")
      .send({ model: "m1", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const sys = systemPromptText();

    // The persona block is present, with its safety-precedence prefix and the
    // selected preset's fragment.
    expect(sys).toContain(PERSONA_BLOCK_PREFIX);
    expect(sys).toContain(PERSONA_PRESETS.founder);
    // WARP-2652 — and the business block, which never composed here at all
    // (no `workspace`/`businessProfile` delegate) and so was never checked.
    expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);

    // Positioning: identity → persona → tool guidance.
    const idIdx = sys.indexOf("You are Droplet");
    const personaIdx = sys.indexOf(PERSONA_BLOCK_PREFIX);
    const guidanceIdx = sys.indexOf("Tool guidance:");
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(personaIdx).toBeGreaterThan(idIdx);
    expect(guidanceIdx).toBeGreaterThan(personaIdx);
  });

  it("fail-opens to no persona block when the singleton read throws", async () => {
    // WARP-2652 — the ONE deliberate persona fail-open in this file: the case
    // drives the throw itself, two lines below, and the absence of the block
    // is the assertion. Opt this case out of the guard and nothing else.
    composers.expectFailOpen("persona");
    const prisma = createPrismaMock();
    prisma.assistantPersona.findUnique.mockRejectedValueOnce(
      new Error("db down"),
    );
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/llm/chat")
      .send({ model: "m1", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const sys = systemPromptText();
    // Identity + tool guidance still assemble; the persona block is simply
    // absent (same fail-open posture as the memory block).
    expect(sys).toContain("You are Droplet");
    expect(sys).toContain("Tool guidance:");
    expect(sys).not.toContain(PERSONA_BLOCK_PREFIX);
  });

  it("omits the persona block on the tool_choice='none' voice greeting path", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [
          { role: "system", content: "voice persona" },
          { role: "user", content: "good morning" },
        ],
        tool_choice: "none",
      });

    expect(res.status).toBe(200);
    // The base prompt (and therefore persona) is skipped entirely; voice gets
    // persona via its own greeting-path fetch in Phase 1, not here.
    const req = mockRunAgent.mock.calls.at(-1)![1] as { messages: ChatMessage[] };
    expect(req.messages).toEqual([
      { role: "system", content: "voice persona" },
      { role: "user", content: "good morning" },
    ]);
    expect(prisma.assistantPersona.findUnique).not.toHaveBeenCalled();
  });
});
