/**
 * Base system prompt + durable-memory injection for POST /api/llm/chat.
 *
 * Before this change the model received ZERO server-side guidance: RAG
 * invocation relied entirely on the search_content tool description
 * (which already failed in practice — the WARP-642 hallucinated-tool
 * guard exists because gpt-oss:20b invented `knowledge_base_search`),
 * and WARP-461 memory facts only surfaced if the model spontaneously
 * called memory_recall.
 *
 * Now the route splices a base system message at index 0 (additive —
 * same pattern as WARP-460 context pins) that:
 *   - names search_content as the way to answer questions about the
 *     user's files/documents,
 *   - names memory_recall / memory_extract_fact for durable memory,
 *   - inlines the active MemoryFact rows (bounded) so saved facts
 *     reach the model without a tool round-trip.
 *
 * Skipped entirely when tool_choice="none" — that's voice-io's
 * greeting path, which advertises zero tools and supplies its own
 * persona prompt; tool guidance there would be misleading.
 *
 * Test harness mirrors llm-chat.attachments.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
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

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

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
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";

// WARP-2652 — this file measures the ASSEMBLED base prompt, so a block that
// silently failed to compose was measured as absent. See the helper's header.
guardComposerFailOpen();

interface MockFact {
  category: string;
  fact: string;
  active: boolean;
  addedAt: Date;
}

function createPrismaMock(facts: MockFact[]) {
  return {
    // WARP-2652 — persona + business + workspace. Absent here until now, so
    // both block composers threw on every turn and the route's fail-open ate
    // it: every assertion below ran against a prompt missing two blocks.
    ...promptBlockPrismaDelegates(),
    memoryFact: {
      findMany: vi.fn(async ({ where }: { where: { active: boolean } }) =>
        facts.filter((f) => f.active === where.active),
      ),
    },
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
    const asUser = { id: "user-uuid", username: "test", role: "owner" };
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

function agentMessages(): ChatMessage[] {
  expect(mockRunAgent).toHaveBeenCalled();
  const req = mockRunAgent.mock.calls.at(-1)![1] as { messages: ChatMessage[] };
  return req.messages;
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

describe("POST /api/llm/chat — base system prompt + memory injection", () => {
  // WARP-2652 — the fixture floor: the prompt every case below measures
  // carries both composed blocks. One assertion per block, on the marker each
  // composer builds its output from, so a fixture regression names which one
  // went missing instead of vanishing into the fail-open.
  it("assembles a base prompt carrying both the persona and the business block", async () => {
    const app = buildApp(createPrismaMock([]));

    const res = await request(app)
      .post("/api/llm/chat")
      .send({ model: "m1", messages: [{ role: "user", content: "hello" }] });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    expect(sys.content).toContain(PERSONA_BLOCK_PREFIX);
    expect(sys.content).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });

  it("injects a base system message naming the retrieval and memory tools", async () => {
    const app = buildApp(createPrismaMock([]));

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    const messages = agentMessages();
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("search_content");
    expect(messages[0]!.content).toContain("memory_recall");
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "hello" });
  });

  it("leads the base system message with the shared Droplet identity block", async () => {
    const app = buildApp(createPrismaMock([]));

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    expect(sys.role).toBe("system");
    // data/droplet-identity.md content (identity-prompt.ts), not the
    // legacy one-liner — every surface shares this block.
    expect(sys.content).toContain("You are Droplet");
    expect(sys.content).toContain("What the box does");
    // Business-voice rollout (2026-07-23 spec): the identity is business-
    // framed on every box; the household voice is gone.
    expect(sys.content).toContain("for this business");
    expect(sys.content).not.toContain("household");
    expect(sys.content).not.toContain("housemate");
    // Identity leads; tool guidance follows it.
    const sysText = typeof sys.content === "string" ? sys.content : "";
    expect(sysText.indexOf("You are Droplet")).toBeLessThan(
      sysText.indexOf("Tool guidance:"),
    );
  });

  it("inlines active memory facts into the base system message", async () => {
    const app = buildApp(
      createPrismaMock([
        {
          category: "Workflow",
          fact: "Prefers answers in French",
          active: true,
          addedAt: new Date("2026-06-01T00:00:00Z"),
        },
        {
          category: "Schedule",
          fact: "Standup is at 9am",
          active: true,
          addedAt: new Date("2026-06-02T00:00:00Z"),
        },
        {
          category: "Other",
          fact: "This one was deactivated",
          active: false,
          addedAt: new Date("2026-06-03T00:00:00Z"),
        },
      ]),
    );

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("Prefers answers in French");
    expect(sys.content).toContain("Standup is at 9am");
    expect(sys.content).not.toContain("This one was deactivated");
  });

  it("steers calculate and the wider tool surface for privileged callers", async () => {
    const app = buildApp(createPrismaMock([]));

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "what is 15% of 2400?" }],
      });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    // The mocked auth user is privileged → allowed=undefined → full render.
    expect(sys.content).toContain("Never do arithmetic in your head");
    expect(sys.content).toContain("calculate");
    expect(sys.content).toContain("email_search");
    expect(sys.content).toContain("business_profile_get");
  });

  it("renders guidance from an explicit allowed_tools list only", async () => {
    const app = buildApp(createPrismaMock([]));

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hi" }],
        allowed_tools: ["calculate"],
      });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    expect(sys.content).toContain("Never do arithmetic in your head");
    // WARP-642: nothing outside the explicit list may be named.
    expect(sys.content).not.toContain("unit_convert");
    expect(sys.content).not.toContain("search_content");
    expect(sys.content).not.toContain("email_search");
  });

  it("frames the durable-memory block for the business, not a household", async () => {
    const app = buildApp(
      createPrismaMock([
        {
          category: "Workflow",
          fact: "Invoices go out on the 1st",
          active: true,
          addedAt: new Date("2026-06-01T00:00:00Z"),
        },
      ]),
    );

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    expect(sys.content).toContain("facts previously saved for this business");
    expect(sys.content).not.toContain("household");
  });

  it("keeps a caller-supplied system message (additive, after the base prompt)", async () => {
    const app = buildApp(createPrismaMock([]));

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [
          { role: "system", content: "You are a pirate." },
          { role: "user", content: "hello" },
        ],
      });

    expect(res.status).toBe(200);
    const messages = agentMessages();
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("search_content");
    // The caller's persona prompt survives, after the base prompt.
    const pirate = messages.find((m) => m.content === "You are a pirate.");
    expect(pirate).toBeDefined();
  });

  it("omits stripped write tools from the base prompt for non-privileged roles", async () => {
    // family role: narrowAllowedToolsForRole strips requiresWrite tools
    // (memory_extract_fact) from the advertised set; the base prompt must
    // not instruct a tool the model can't call (it would steer small
    // local models straight into the WARP-642 unknown-tool guard).
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const asUser = { id: "fam-uuid", username: "fam", role: "family" };
      (req as unknown as { user?: typeof asUser }).user = asUser;
      next();
    });
    app.use("/api", createLlmRouter(createPrismaMock([]) as never));

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "remember that I like tea" }],
      });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    expect(sys.role).toBe("system");
    // mcpClient.listTools is mocked to [] → family's allowed set is
    // empty → no tool guidance at all, and specifically no instruction
    // to call the stripped write tool.
    expect(sys.content).not.toContain("memory_extract_fact");
    expect(sys.content).not.toContain("search_content");
    // Identity block (data/droplet-identity.md) still leads even when
    // every tool is stripped.
    expect(sys.content).toContain("You are Droplet");
  });

  it("skips the base prompt entirely when tool_choice is 'none'", async () => {
    const prisma = createPrismaMock([]);
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
    expect(agentMessages()).toEqual([
      { role: "system", content: "voice persona" },
      { role: "user", content: "good morning" },
    ]);
    expect(prisma.memoryFact.findMany).not.toHaveBeenCalled();
  });

  it("still injects the base prompt when the memory-fact lookup throws", async () => {
    const prisma = createPrismaMock([]);
    prisma.memoryFact.findMany.mockRejectedValueOnce(new Error("db down"));
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("search_content");
  });
});
