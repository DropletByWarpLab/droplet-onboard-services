/**
 * WARP-203 follow-up — chat attachments must reach the LLM.
 *
 * The dashboard uploads chat attachments to brain memory
 * (POST /api/files/brain/upload) and the file-indexer extracts + embeds
 * them, but until this change POST /api/llm/chat carried no reference
 * to the attached files, so the model never knew an attachment existed.
 *
 * These tests cover the injection block in routes/llm.ts: the request
 * may carry `attachments: [{ itemId }]`; the route verifies ownership
 * against BrainMemoryItem.userId, inlines budgeted extracted text from
 * FileContentChunk for ready items, and notes the status for items that
 * are still processing or failed.
 *
 * Pattern mirrors context-pins.routes.test.ts: mock heavy dependencies,
 * mount createLlmRouter with a synthetic auth middleware, drive the
 * endpoint via supertest. `runAgent` is mocked so we can assert on the
 * exact message array the agent loop receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

// The global setup.ts mock of @prisma/client only exports PrismaClient +
// Prisma; routes/llm.ts now also imports the BrainMemoryItemStatus enum
// (same situation files-brain.test.ts handles). Re-mock with the enum
// values the real generated client emits.
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

// Persistence intentionally returns null conversation rows — the
// attachment injection must NOT depend on a persisted conversation
// (attachments are most often present on the very FIRST turn, before
// any X-Conversation-Id exists).
const mockEnsureConversation = vi.fn().mockResolvedValue(null);
const mockCreateTurnRows = vi.fn().mockResolvedValue(null);
vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: (...a: unknown[]) => mockEnsureConversation(...a),
    createTurnRows: (...a: unknown[]) => mockCreateTurnRows(...a),
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

const USERNAME = "test";

interface MockBrainItem {
  id: string;
  userId: string;
  filename: string;
  mimeType: string | null;
  status: string;
}

interface MockChunk {
  brainItemId: string;
  chunkIdx: number;
  text: string;
}

function createPrismaMock(items: MockBrainItem[], chunks: MockChunk[]) {
  return {
    // Base-prompt injection (covered in llm-chat.base-prompt.test.ts)
    // queries memory facts on every non-"none" turn — return none here.
    memoryFact: {
      findMany: vi.fn(async () => []),
    },
    brainMemoryItem: {
      findMany: vi.fn(
        async ({ where }: { where: { id: { in: string[] }; userId: string } }) =>
          items.filter(
            (i) => where.id.in.includes(i.id) && i.userId === where.userId,
          ),
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    fileContentChunk: {
      findMany: vi.fn(
        async ({ where }: { where: { brainItemId: string } }) =>
          chunks
            .filter((c) => c.brainItemId === where.brainItemId)
            .sort((a, b) => a.chunkIdx - b.chunkIdx)
            .map((c) => ({ text: c.text })),
      ),
    },
    contextPin: {
      findMany: vi.fn(async () => []),
    },
    chatSession: {
      findFirst: vi.fn(async () => null),
    },
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const asUser = { id: "user-uuid", username: USERNAME, role: "owner" };
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

/** The message array runAgent received on its last invocation. */
function agentMessages(): ChatMessage[] {
  expect(mockRunAgent).toHaveBeenCalled();
  const req = mockRunAgent.mock.calls.at(-1)![1] as { messages: ChatMessage[] };
  return req.messages;
}

/** The attachment-context system message, or undefined when none was
 *  injected. Distinct from the base system prompt (which is always
 *  present on tool-enabled turns and covered by its own test file). */
function attachmentSystemMessage(): ChatMessage | undefined {
  return agentMessages().find(
    (m) => m.role === "system" && m.content.includes("attached"),
  );
}

beforeEach(() => {
  mockRunAgent.mockReset();
  mockEnsureConversation.mockReset();
  mockEnsureConversation.mockResolvedValue(null);
  mockCreateTurnRows.mockReset();
  mockCreateTurnRows.mockResolvedValue(null);
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});

describe("POST /api/llm/chat — attachment context injection", () => {
  it("injects a system message with filename + extracted text for a ready attachment", async () => {
    const prisma = createPrismaMock(
      [
        {
          id: "bmi-1",
          userId: USERNAME,
          filename: "report.pdf",
          mimeType: "application/pdf",
          status: "ready",
        },
      ],
      [
        { brainItemId: "bmi-1", chunkIdx: 0, text: "Quarterly revenue rose 12%." },
        { brainItemId: "bmi-1", chunkIdx: 1, text: "Churn fell to 2.1%." },
      ],
    );
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "summarize the report" }],
        attachments: [{ itemId: "bmi-1" }],
      });

    expect(res.status).toBe(200);
    const sys = attachmentSystemMessage();
    expect(sys).toBeDefined();
    expect(sys!.content).toContain("report.pdf");
    expect(sys!.content).toContain("Quarterly revenue rose 12%.");
    expect(sys!.content).toContain("Churn fell to 2.1%.");
    // The user turn must survive, after the injected context.
    expect(agentMessages().at(-1)).toMatchObject({
      role: "user",
      content: "summarize the report",
    });
  });

  it("skips attachments owned by another user (no content leak)", async () => {
    const prisma = createPrismaMock(
      [
        {
          id: "bmi-foreign",
          userId: "someone-else",
          filename: "secret.pdf",
          mimeType: "application/pdf",
          status: "ready",
        },
      ],
      [{ brainItemId: "bmi-foreign", chunkIdx: 0, text: "TOP SECRET" }],
    );
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hi" }],
        attachments: [{ itemId: "bmi-foreign" }],
      });

    expect(res.status).toBe(200);
    // No attachment context injected, and the foreign content never
    // reaches the model.
    expect(attachmentSystemMessage()).toBeUndefined();
    for (const m of agentMessages()) {
      expect(m.content).not.toContain("TOP SECRET");
      expect(m.content).not.toContain("secret.pdf");
    }
    expect(prisma.fileContentChunk.findMany).not.toHaveBeenCalled();
  });

  it("notes still-processing and failed attachments without fetching chunks", async () => {
    const prisma = createPrismaMock(
      [
        {
          id: "bmi-indexing",
          userId: USERNAME,
          filename: "meeting.mp3",
          mimeType: "audio/mpeg",
          status: "queued_for_transcription",
        },
        {
          id: "bmi-failed",
          userId: USERNAME,
          filename: "broken.pdf",
          mimeType: "application/pdf",
          status: "failed",
        },
      ],
      [],
    );
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "what did I attach?" }],
        attachments: [{ itemId: "bmi-indexing" }, { itemId: "bmi-failed" }],
      });

    expect(res.status).toBe(200);
    const sys = attachmentSystemMessage();
    expect(sys).toBeDefined();
    expect(sys!.content).toContain("meeting.mp3");
    expect(sys!.content).toMatch(/still being processed/i);
    expect(sys!.content).toContain("broken.pdf");
    expect(sys!.content).toMatch(/could not be processed/i);
    expect(prisma.fileContentChunk.findMany).not.toHaveBeenCalled();
  });

  it("truncates oversized content to the per-item budget and points at search_content", async () => {
    const bigChunk = "x".repeat(10_000);
    const prisma = createPrismaMock(
      [
        {
          id: "bmi-big",
          userId: USERNAME,
          filename: "novel.txt",
          mimeType: "text/plain",
          status: "ready",
        },
      ],
      [{ brainItemId: "bmi-big", chunkIdx: 0, text: bigChunk }],
    );
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "summarize" }],
        attachments: [{ itemId: "bmi-big" }],
      });

    expect(res.status).toBe(200);
    const sys = attachmentSystemMessage();
    expect(sys).toBeDefined();
    // Whole-message bound: well under the raw 10k chunk, plus framing.
    expect(sys!.content.length).toBeLessThan(6_000);
    expect(sys!.content).toMatch(/truncated/i);
    expect(sys!.content).toContain("search_content");
  });

  it("does not inject anything when the request has no attachments", async () => {
    const prisma = createPrismaMock([], []);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    expect(attachmentSystemMessage()).toBeUndefined();
    expect(agentMessages().at(-1)).toMatchObject({
      role: "user",
      content: "hello",
    });
    expect(prisma.brainMemoryItem.findMany).not.toHaveBeenCalled();
  });

  it("rejects more than 8 attachments per turn", async () => {
    const prisma = createPrismaMock([], []);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hello" }],
        attachments: Array.from({ length: 9 }, (_, i) => ({
          itemId: `bmi-${i}`,
        })),
      });

    expect(res.status).toBe(400);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("re-stamps originatingChatId to the conversationId on persisted turns", async () => {
    mockEnsureConversation.mockResolvedValue({ id: "conv-77" });
    mockCreateTurnRows.mockResolvedValue({
      userMessageId: "um-1",
      assistantMessageId: "am-1",
      assistantAlreadyFinal: false,
    });
    const prisma = createPrismaMock(
      [
        {
          id: "bmi-1",
          userId: USERNAME,
          filename: "report.pdf",
          mimeType: "application/pdf",
          status: "ready",
        },
      ],
      [{ brainItemId: "bmi-1", chunkIdx: 0, text: "hello" }],
    );
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "summarize" }],
        attachments: [{ itemId: "bmi-1" }],
      });

    expect(res.status).toBe(200);
    expect(prisma.brainMemoryItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["bmi-1"] },
        userId: USERNAME,
        NOT: { originatingChatId: "conv-77" },
      },
      data: { originatingChatId: "conv-77" },
    });
  });

  it("re-stamps ALL items tagged with the draft chatId on the first persisted turn", async () => {
    mockEnsureConversation.mockResolvedValue({ id: "conv-9" });
    mockCreateTurnRows.mockResolvedValue({
      userMessageId: "um-1",
      assistantMessageId: "am-1",
      assistantAlreadyFinal: false,
    });
    const prisma = createPrismaMock([], []);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hello" }],
        // No attachments on the wire — the upload may still be in flight —
        // but the draft tag lets the server adopt whatever finished or
        // finishes against the row that already exists.
        draftChatId: "chat-1749600000000",
      });

    expect(res.status).toBe(200);
    expect(prisma.brainMemoryItem.updateMany).toHaveBeenCalledWith({
      where: {
        originatingChatId: "chat-1749600000000",
        userId: USERNAME,
      },
      data: { originatingChatId: "conv-9" },
    });
  });

  it("does not re-stamp when the turn has no persisted conversation", async () => {
    const prisma = createPrismaMock(
      [
        {
          id: "bmi-1",
          userId: USERNAME,
          filename: "report.pdf",
          mimeType: "application/pdf",
          status: "ready",
        },
      ],
      [{ brainItemId: "bmi-1", chunkIdx: 0, text: "hello" }],
    );
    const app = buildApp(prisma);

    await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "summarize" }],
        attachments: [{ itemId: "bmi-1" }],
      });

    expect(prisma.brainMemoryItem.updateMany).not.toHaveBeenCalled();
  });

  it("degrades gracefully when the attachment lookup throws", async () => {
    const prisma = createPrismaMock([], []);
    prisma.brainMemoryItem.findMany.mockRejectedValueOnce(
      new Error("db down"),
    );
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hello" }],
        attachments: [{ itemId: "bmi-1" }],
      });

    // Chat must still work — the turn proceeds without the context.
    expect(res.status).toBe(200);
    expect(attachmentSystemMessage()).toBeUndefined();
    expect(agentMessages().at(-1)).toMatchObject({
      role: "user",
      content: "hello",
    });
  });
});
