/**
 * WARP-903 — `/api/llm/chat` streaming coverage for the `model_loading`
 * SSE event that kills the silent cold-load hang.
 *
 * Selecting a not-yet-loaded local model used to hang chat 30-60 s with
 * ZERO feedback while Ollama loaded the weights. The route now runs a
 * one-shot, budgeted coldness probe (`probeColdModel` in
 * `services/model-readiness.service.ts` — Ollama `/api/ps` + `/api/tags`,
 * NEVER ollama-manager's /proxy) before the agent loop and, when the
 * model is cold, emits `model_loading` as the FIRST frame on the wire so
 * the dashboard can render an explicit loading state.
 *
 * Contract under test:
 *   - cold model  → `model_loading` emitted BEFORE any agent-loop output,
 *     payload `{model, sizeGb}`.
 *   - warm model  → NO `model_loading`; the turn is byte-for-byte the
 *     pre-WARP-903 wire.
 *   - probe failure → NO `model_loading`, chat proceeds normally (the
 *     probe is an optimization, never a dependency).
 *   - non-streaming turns never probe (there is no SSE channel to tell).
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
// pattern from `llm-agent.reasoning-flag-route.test.ts` so this file
// slots into the same testing regime.
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

vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: vi
      .fn()
      .mockResolvedValue({ id: "conv-1", created: true }),
    createTurnRows: vi.fn().mockResolvedValue({
      userMessageId: "user-1",
      assistantMessageId: "asst-1",
      assistantAlreadyFinal: false,
    }),
    finalizeAssistantMessage: vi.fn().mockResolvedValue(undefined),
    updateAssistantStreaming: vi.fn().mockResolvedValue(undefined),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
    renameConversationForUser: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

const mockChat = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  getModelCapabilities: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue(null),
}));

// The unit under integration: the route's coldness probe. Mocked at the
// module boundary so each test dictates cold / warm / broken. The other
// exports are stubbed because routes/setup.ts (mounted by createApp)
// imports warmDefaultModel from the same module.
const mockProbeColdModel = vi.fn();
vi.mock("../services/model-readiness.service.js", () => ({
  probeColdModel: (...args: unknown[]) => mockProbeColdModel(...args),
  warmDefaultModel: vi.fn().mockResolvedValue(undefined),
  ensureDefaultModelPulled: vi.fn().mockResolvedValue(undefined),
  backgroundPull: vi.fn().mockResolvedValue(undefined),
  resetWarmStateForTests: vi.fn(),
}));

/** One assistant completion, no tool calls — the minimal happy turn. */
function plainResponse(text = "Hello!") {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      id: "chatcmpl-1",
      model: "gpt-oss:20b",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
    }),
  };
}

/** Ordered `event:` names from a raw SSE body. */
function eventNames(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => l.startsWith("event: "))
    .map((l) => l.slice("event: ".length).trim());
}

/** Payload of the FIRST frame with the given event name, or null. */
function payloadOf(body: string, event: string): Record<string, unknown> | null {
  for (const frame of body.split("\n\n")) {
    const lines = frame.split("\n");
    const evLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!evLine || !dataLine) continue;
    if (evLine.slice("event: ".length).trim() !== event) continue;
    return JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
  }
  return null;
}

describe("POST /api/llm/chat — WARP-903 model_loading SSE", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    // WARP-2652 — the three delegates the prompt-block composers need,
    // layered on for THIS suite only.
    app = createApp(withPromptBlockDelegates(prisma));
  });

  beforeEach(() => {
    mockChat.mockReset();
    mockProbeColdModel.mockReset();
  });

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
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });

    expect(res.status).toBe(200);
    expect(systemPrompt()).toContain(PERSONA_BLOCK_PREFIX);
    expect(systemPrompt()).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });

  it("emits model_loading BEFORE any agent-loop output when the model is cold", async () => {
    mockProbeColdModel.mockResolvedValueOnce({
      model: "gpt-oss:20b",
      sizeGb: 13.8,
    });
    mockChat.mockResolvedValueOnce(plainResponse());

    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });

    expect(res.status).toBe(200);
    const events = eventNames(res.text);
    const loadingIdx = events.indexOf("model_loading");
    const firstDelta = events.indexOf("content_delta");
    // Present, exactly once, and FIRST on the wire — before the agent
    // loop produced anything.
    expect(loadingIdx).toBe(0);
    expect(events.filter((e) => e === "model_loading")).toHaveLength(1);
    expect(firstDelta).toBeGreaterThan(loadingIdx);

    // Payload carries the model + size so the dashboard can render
    // "Loading gpt-oss:20b (13.8 GB)…".
    expect(payloadOf(res.text, "model_loading")).toEqual({
      model: "gpt-oss:20b",
      sizeGb: 13.8,
    });

    // The probe was asked about the model this turn actually runs on.
    expect(mockProbeColdModel).toHaveBeenCalledTimes(1);
    expect(mockProbeColdModel).toHaveBeenCalledWith("gpt-oss:20b");
  });

  it("emits NO model_loading when the model is warm", async () => {
    mockProbeColdModel.mockResolvedValueOnce(null);
    mockChat.mockResolvedValueOnce(plainResponse());

    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });

    expect(res.status).toBe(200);
    const events = eventNames(res.text);
    expect(events).not.toContain("model_loading");
    // The turn itself is unaffected.
    expect(events).toContain("content_delta");
    expect(events).toContain("done");
  });

  it("proceeds with chat (no event) when the probe rejects — never blocks on the probe", async () => {
    mockProbeColdModel.mockRejectedValueOnce(new Error("probe blew up"));
    mockChat.mockResolvedValueOnce(plainResponse("still here"));

    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });

    expect(res.status).toBe(200);
    const events = eventNames(res.text);
    expect(events).not.toContain("model_loading");
    expect(events).toContain("content_delta");
    expect(payloadOf(res.text, "content_delta")).toEqual({ text: "still here" });
    expect(events).toContain("done");
  });

  it("does not probe on the non-streaming path (no SSE channel to tell)", async () => {
    mockChat.mockResolvedValueOnce(plainResponse());

    const res = await request(app)
      .post("/api/llm/chat")
      .set("x-test-role", "owner")
      .send({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.message?.content).toBe("Hello!");
    expect(mockProbeColdModel).not.toHaveBeenCalled();
  });
});
