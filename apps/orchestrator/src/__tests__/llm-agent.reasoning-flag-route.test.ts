/**
 * WARP-458 — `/api/llm/chat` integration coverage for the captureReasoning
 * flag + ChatMessage.reasoning persistence.
 *
 * The unit-level emit-ordering + parser tests live in
 * `llm-agent.reasoning.test.ts` and `llm-agent.reasoning-emit.test.ts`.
 * This file covers the route layer's responsibilities (per AC §4, §5,
 * §6):
 *
 *   - captureReasoning is read off the Zod request schema and threaded
 *     into runAgent.
 *   - captureReasoning=false (the default) SUPPRESSES `reasoning_step`
 *     SSE events on the wire, but the orchestrator still parses + writes
 *     to `ChatMessage.reasoning` so the dashboard can lazy-load on
 *     rehydrate.
 *   - captureReasoning=true emits the same reasoning_step events as the
 *     unit tests verify.
 *   - finalizeAssistantMessage receives the reasoning trace verbatim on
 *     non-streaming (and would on streaming — that path lives in the
 *     llm-chat.integration test file).
 *   - The route still emits ONE chat-kind ActivityRow per turn (AC §6
 *     — reasoning is metadata on ChatMessage, NOT a new activity row).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";

import { PERSONA_BLOCK_PREFIX } from "../services/persona.service.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";
import {
  guardComposerFailOpen,
  withPromptBlockDelegates,
} from "./helpers/prompt-block-fixtures.js";

// WARP-2652 — `new PrismaClient()` here resolves to the shared in-memory
// double from src/__tests__/setup.ts, which has no `assistantPersona`,
// `businessProfile` or `workspace` model. Both block composers therefore threw
// on every turn and the route's fail-open swallowed it. See the helper header.
guardComposerFailOpen();

// Stub auth so we can flip roles via x-test-role header. Mirrors the
// pattern from `llm.test.ts` so this file slots into the same testing
// regime.
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    const role = req.headers["x-test-role"];
    if (typeof role === "string" && role.length > 0) {
      (req as unknown as { user?: { username: string; role: string } }).user = {
        username: "alice",
        role,
      };
    }
    next();
  },
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrMcpService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  // BUG-11 follow-up: app.ts now installs requirePasswordChangeGate on
  // every request; stub it as a pass-through like requireRole.
  requirePasswordChangeGate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  setAuthPrisma: () => {},
}));

const mockFinalizeAssistantMessage = vi.fn().mockResolvedValue(undefined);
const mockEnsureConversation = vi
  .fn()
  .mockResolvedValue({ id: "conv-1", created: true });
const mockCreateTurnRows = vi.fn().mockResolvedValue({
  userMessageId: "user-1",
  assistantMessageId: "asst-1",
  assistantAlreadyFinal: false,
});

vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: mockEnsureConversation,
    createTurnRows: mockCreateTurnRows,
    finalizeAssistantMessage: mockFinalizeAssistantMessage,
    updateAssistantStreaming: vi.fn().mockResolvedValue(undefined),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
    renameConversationForUser: vi.fn().mockResolvedValue(null),
  })),
}));

// Capture ActivityRow writes so we can assert one-per-turn (AC §6).
const mockRecordActivity = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...args: unknown[]) => mockRecordActivity(...args),
}));

const mockChat = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: (...args: unknown[]) => mockChat(...args),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
  stopMcp: vi.fn().mockResolvedValue(undefined),
}));

// Don't bother with the real nextcloud-session resolver in this test;
// the route falls back to undefined ncToken when this returns null.
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue(null),
}));

describe("POST /api/llm/chat — WARP-458 captureReasoning flag", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    // WARP-2652 — the three delegates the prompt-block composers need,
    // layered on for THIS suite only.
    app = createApp(withPromptBlockDelegates(prisma));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock returns after clearAllMocks (which wipes both
    // call history AND implementations on `vi.fn().mockResolvedValue(...)`).
    mockEnsureConversation.mockResolvedValue({ id: "conv-1", created: true });
    mockCreateTurnRows.mockResolvedValue({
      userMessageId: "user-1",
      assistantMessageId: "asst-1",
      assistantAlreadyFinal: false,
    });
    mockFinalizeAssistantMessage.mockResolvedValue(undefined);
    mockRecordActivity.mockResolvedValue(undefined);
  });

  /**
   * Model response factory — returns the same fixture both reasoning-on
   * and reasoning-off cases use, so the only variable between the two
   * tests is the request body.
   */
  function reasoningResponse() {
    return {
      ok: true,
      json: vi.fn().mockResolvedValue({
        id: "chatcmpl-1",
        model: "ollama/qwen3",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "<reasoning>The user asked for the capital of France.</reasoning>" +
                "<reasoning>I know that's Paris.</reasoning>" +
                "Paris.",
            },
            finish_reason: "stop",
          },
        ],
      }),
    };
  }

  /** WARP-2652 — the outbound gateway payload's system message. The route
   *  hands the assembled prompt to the agent loop, which serializes it into
   *  the ai-gateway request; capturing it there is the honest read of what a
   *  turn in this suite actually sends. */
  function captureSystemPrompt(): () => string {
    let sys = "";
    mockChat.mockImplementationOnce(
      async (req: { messages?: { role: string; content: unknown }[] }) => {
        const first = req.messages?.[0];
        sys = first && typeof first.content === "string" ? first.content : "";
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
        };
      },
    );
    return () => sys;
  }

  // WARP-2652 — the fixture floor. Not a test of the persona or business
  // feature (llm-chat.persona-block.test.ts / llm-chat.business-block.test.ts
  // own those); it is the statement that the turns measured in the rest of
  // this file run against the prompt the product assembles, blocks included.
  it("assembles a base prompt carrying both the persona and the business block", async () => {
    const systemPrompt = captureSystemPrompt();

    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "ollama/qwen3",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });

    expect(res.status).toBe(200);
    expect(systemPrompt()).toContain(PERSONA_BLOCK_PREFIX);
    expect(systemPrompt()).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });

  it("captureReasoning=true persists reasoning AND surfaces it in the agent result", async () => {
    mockChat.mockResolvedValueOnce(reasoningResponse());

    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "ollama/qwen3",
        messages: [{ role: "user", content: "capital of france" }],
        stream: false,
        captureReasoning: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.message?.content).toBe("Paris.");
    // The agent result carries the parsed reasoning.
    expect(res.body.message?.reasoning).toBe(
      "The user asked for the capital of France.\n\nI know that's Paris.",
    );

    // Persistence: finalizeAssistantMessage was called with the trace
    // verbatim.
    expect(mockFinalizeAssistantMessage).toHaveBeenCalledTimes(1);
    const finalizeArgs = mockFinalizeAssistantMessage.mock.calls[0][0];
    expect(finalizeArgs.reasoning).toBe(
      "The user asked for the capital of France.\n\nI know that's Paris.",
    );
    expect(finalizeArgs.content).toBe("Paris.");
    expect(finalizeArgs.status).toBe("completed");

    // AC §6 — exactly ONE activity row per chat turn (kind=chat).
    // Reasoning is metadata on ChatMessage, not its own row.
    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
    expect(mockRecordActivity.mock.calls[0][0]).toMatchObject({
      kind: "chat",
    });
  });

  it("captureReasoning=false (default) still persists reasoning but does not surface it in stream events", async () => {
    mockChat.mockResolvedValueOnce(reasoningResponse());

    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "ollama/qwen3",
        messages: [{ role: "user", content: "capital of france" }],
        stream: false,
        // captureReasoning omitted → default false.
      });

    expect(res.status).toBe(200);
    expect(res.body.message?.content).toBe("Paris.");
    // AgentResult ALWAYS carries the parsed reasoning even when
    // captureReasoning=false. The flag gates wire-emission only.
    expect(res.body.message?.reasoning).toBe(
      "The user asked for the capital of France.\n\nI know that's Paris.",
    );

    // Persistence path runs unconditionally — the dashboard can
    // lazy-load the reasoning trace from ChatMessage.reasoning later.
    expect(mockFinalizeAssistantMessage).toHaveBeenCalledTimes(1);
    expect(
      mockFinalizeAssistantMessage.mock.calls[0][0].reasoning,
    ).toBe(
      "The user asked for the capital of France.\n\nI know that's Paris.",
    );

    // Still exactly one chat activity row per turn.
    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
  });

  it("when the model returns no <reasoning> segments, reasoning is null in persistence", async () => {
    mockChat.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        id: "chatcmpl-2",
        model: "ollama/qwen3",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "plain answer" },
            finish_reason: "stop",
          },
        ],
      }),
    });

    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "ollama/qwen3",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        captureReasoning: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.message?.content).toBe("plain answer");
    // No reasoning produced → AgentResult.message.reasoning is absent.
    expect(res.body.message?.reasoning).toBeUndefined();

    // Persistence sees `null` (explicit clear) rather than `undefined`
    // (skip). On a retried turn that previously had reasoning, this
    // clears the column rather than leaving stale text in the DB.
    expect(mockFinalizeAssistantMessage).toHaveBeenCalledTimes(1);
    expect(mockFinalizeAssistantMessage.mock.calls[0][0].reasoning).toBeNull();
  });

  it("rejects captureReasoning that isn't a boolean (Zod schema)", async () => {
    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "ollama/qwen3",
        messages: [{ role: "user", content: "hi" }],
        captureReasoning: "yes-please", // not a boolean
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("streaming path emits reasoning_step BEFORE content_delta when captureReasoning=true", async () => {
    mockChat.mockResolvedValueOnce(reasoningResponse());

    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "ollama/qwen3",
        messages: [{ role: "user", content: "capital of france" }],
        stream: true,
        captureReasoning: true,
      });

    expect(res.status).toBe(200);
    // SSE response body is a concatenation of frames. Parse the
    // event types in order and assert reasoning_step lands before
    // content_delta on the same turn (AC §3 + §5).
    const body = res.text;
    const eventLines = body
      .split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice("event: ".length).trim());
    const firstReasoning = eventLines.indexOf("reasoning_step");
    const firstText = eventLines.indexOf("content_delta");
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstText).toBeGreaterThanOrEqual(0);
    expect(firstReasoning).toBeLessThan(firstText);

    // Two reasoning_step events in arrival order.
    const reasoningCount = eventLines.filter(
      (e) => e === "reasoning_step",
    ).length;
    expect(reasoningCount).toBe(2);

    // ActivityRow still single per chat turn (AC §6).
    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
    expect(mockRecordActivity.mock.calls[0][0]).toMatchObject({
      kind: "chat",
    });

    // Reasoning is persisted on finalize.
    expect(mockFinalizeAssistantMessage).toHaveBeenCalledTimes(1);
    expect(
      mockFinalizeAssistantMessage.mock.calls[0][0].reasoning,
    ).toBe(
      "The user asked for the capital of France.\n\nI know that's Paris.",
    );
  });

  it("streaming path SUPPRESSES reasoning_step events when captureReasoning=false but still persists", async () => {
    mockChat.mockResolvedValueOnce(reasoningResponse());

    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "ollama/qwen3",
        messages: [{ role: "user", content: "capital of france" }],
        stream: true,
        // captureReasoning intentionally omitted.
      });

    expect(res.status).toBe(200);
    const body = res.text;
    const eventLines = body
      .split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice("event: ".length).trim());

    // No reasoning_step events on the wire when the flag is off.
    expect(eventLines.includes("reasoning_step")).toBe(false);
    // content_delta still lands.
    expect(eventLines.includes("content_delta")).toBe(true);

    // Persistence still gets the reasoning trace (lazy-load support).
    expect(mockFinalizeAssistantMessage).toHaveBeenCalledTimes(1);
    expect(
      mockFinalizeAssistantMessage.mock.calls[0][0].reasoning,
    ).toBe(
      "The user asked for the capital of France.\n\nI know that's Paris.",
    );
  });
});
