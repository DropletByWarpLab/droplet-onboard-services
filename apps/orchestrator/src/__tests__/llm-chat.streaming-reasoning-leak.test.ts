/**
 * WARP-1602 — `/api/llm/chat` (stream=true) must persist the TERMINAL answer,
 * not the delta accumulator.
 *
 * The route used to sum every `content_delta` into `liveAssistantContent` and
 * hand THAT to `finalizeAssistantMessage`. On a multi-iteration turn the
 * agent loop emitted a delta per iteration — including the tool-call
 * iterations, whose content is the model's analysis — so the row stored the
 * chain-of-thought welded to the answer while the non-streaming path stored
 * `result.message.content` clean. A reload then re-read the polluted column,
 * which is why "a reload heals it" was never true.
 *
 * This file drives the real route with a streaming ai-gateway over a
 * three-iteration turn shaped like the failing row on the .87 box, and pins
 * both halves of the contract: what goes on the wire, and what goes in the DB.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";
import { REASONING_STEP_SEPARATOR } from "../services/llm-agent.service.js";
import type { ChatStreamChunk } from "../types/index.js";

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
  requirePasswordChangeGate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  setAuthPrisma: () => {},
}));

const mockFinalizeAssistantMessage = vi.fn().mockResolvedValue(undefined);
const mockUpdateAssistantStreaming = vi.fn().mockResolvedValue(undefined);
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
    updateAssistantStreaming: mockUpdateAssistantStreaming,
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
    renameConversationForUser: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

// The cold-model probe is the first thing the streaming branch does; keep it
// off the network.
vi.mock("../services/model-readiness.service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeColdModel: vi.fn().mockResolvedValue(null),
}));

const mockChatStream = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  chatStream: (...args: unknown[]) => mockChatStream(...args),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

const mockCallTool = vi.fn();
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([
      {
        name: "list_files",
        description: "List files in a folder",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: {} },
      },
    ]),
    callTool: (...args: unknown[]) => mockCallTool(...args),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
  stopMcp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue(null),
}));

function streamOf(chunks: ChatStreamChunk[]): AsyncIterable<ChatStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function toolCallChunk(id: string, name: string): ChatStreamChunk {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id, type: "function", function: { name, arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

/** The failing .87 turn: analysis on delta.content for two tool iterations,
 *  then the real answer. */
const ANALYSIS_1 =
  'We need to answer "how much money did I spent in June?" Likely refers to ' +
  "expenses. Let's look at Invoices folder: list files.";
const ANALYSIS_2 = "Let's read csv.";
const ANSWER = "You spent 6,240 EUR in June 2026.";

describe("POST /api/llm/chat stream=true — WARP-1602 analysis quarantine", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureConversation.mockResolvedValue({ id: "conv-1", created: true });
    mockCreateTurnRows.mockResolvedValue({
      userMessageId: "user-1",
      assistantMessageId: "asst-1",
      assistantAlreadyFinal: false,
    });
    mockFinalizeAssistantMessage.mockResolvedValue(undefined);
    mockUpdateAssistantStreaming.mockResolvedValue(undefined);
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ files: [] }) }],
      isError: false,
    });
    mockChatStream
      .mockReturnValueOnce(
        streamOf([
          { choices: [{ delta: { content: ANALYSIS_1 } }] },
          toolCallChunk("c1", "list_files"),
        ]),
      )
      .mockReturnValueOnce(
        streamOf([
          { choices: [{ delta: { content: ANALYSIS_2 } }] },
          toolCallChunk("c2", "read_file"),
        ]),
      )
      .mockReturnValueOnce(
        streamOf([
          { choices: [{ delta: { content: ANSWER }, finish_reason: "stop" }] },
        ]),
      );
  });

  async function runTurn(captureReasoning: boolean) {
    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "gpt-oss:20b",
        messages: [
          { role: "user", content: "how much money did I spend in June?" },
        ],
        stream: true,
        captureReasoning,
      });
    expect(res.status).toBe(200);
    return res.text;
  }

  /** Concatenate the `text` field of every content_delta frame, in order. */
  function joinContentDeltas(sse: string): string {
    const frames = sse.split("\n\n").filter(Boolean);
    let out = "";
    for (const frame of frames) {
      const [evtLine, dataLine] = frame.split("\n");
      if (evtLine !== "event: content_delta" || !dataLine) continue;
      out += (JSON.parse(dataLine.slice("data: ".length)) as { text: string }).text;
    }
    return out;
  }

  it("never puts intermediate analysis on the wire as content_delta", async () => {
    const sse = await runTurn(true);
    const streamed = joinContentDeltas(sse);
    expect(streamed).toBe(ANSWER);
    expect(streamed).not.toContain("We need to answer");
    expect(streamed).not.toContain("Let's read csv");
    // The run-on join the live row carried ("…list files.Let's read csv.You
    // spent…") cannot form when the fragments never share a channel.
    expect(streamed).not.toMatch(/files\.Let/);
  });

  it("persists the terminal answer, not the delta accumulator", async () => {
    await runTurn(true);
    expect(mockFinalizeAssistantMessage).toHaveBeenCalledTimes(1);
    const args = mockFinalizeAssistantMessage.mock.calls[0][0];
    expect(args.content).toBe(ANSWER);
    expect(args.status).toBe("completed");
    // The DB row equals what the blocking path would have stored.
    expect(args.content).not.toContain("We need to answer");
  });

  it("persists the per-step reasoning trace instead of leaving the column NULL", async () => {
    await runTurn(true);
    const args = mockFinalizeAssistantMessage.mock.calls[0][0];
    expect(args.reasoning).not.toBeNull();
    const steps = (args.reasoning as string).split(REASONING_STEP_SEPARATOR);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain("We need to answer");
    expect(steps[1]).toBe(ANALYSIS_2);
  });

  it("emits the quarantined analysis as reasoning_step, and only when asked", async () => {
    const withCapture = await runTurn(true);
    expect(withCapture).toContain("event: reasoning_step");

    vi.clearAllMocks();
    mockEnsureConversation.mockResolvedValue({ id: "conv-1", created: true });
    mockCreateTurnRows.mockResolvedValue({
      userMessageId: "user-1",
      assistantMessageId: "asst-1",
      assistantAlreadyFinal: false,
    });
    mockFinalizeAssistantMessage.mockResolvedValue(undefined);
    mockUpdateAssistantStreaming.mockResolvedValue(undefined);
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ files: [] }) }],
      isError: false,
    });
    mockChatStream
      .mockReturnValueOnce(
        streamOf([
          { choices: [{ delta: { content: ANALYSIS_1 } }] },
          toolCallChunk("c1", "list_files"),
        ]),
      )
      .mockReturnValueOnce(
        streamOf([
          { choices: [{ delta: { content: ANSWER }, finish_reason: "stop" }] },
        ]),
      );

    const withoutCapture = await runTurn(false);
    expect(withoutCapture).not.toContain("event: reasoning_step");
    // …but the trace is still persisted for a later lazy-load (WARP-458).
    expect(
      mockFinalizeAssistantMessage.mock.calls[0][0].reasoning,
    ).toContain("We need to answer");
  });
});
