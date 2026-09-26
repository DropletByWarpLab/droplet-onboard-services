// WARP-1426 — POST /api/llm/complete route tests.
//
// Scaffolding copied from `llm.test.ts` (auth stub reading `x-test-role`,
// mocked ai-gateway client, supertest against createApp). One deliberate
// deviation: `requireRole` here ENFORCES the allowed-role list (mirroring
// the real middleware) instead of the no-op pass-through llm.test.ts uses,
// so the guard-includes-"service" assertions actually exercise the guard.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { createApp } from "../app.js";
import { completeOnce } from "../services/llm-complete.service.js";
import { initDeviceService } from "../services/device.service.js";

vi.mock("../middleware/auth.js", () => ({
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    const role = req.headers["x-test-role"];
    if (typeof role === "string" && role.length > 0) {
      (req as unknown as { user?: { username: string; role: string } }).user = {
        username: "test",
        role,
      };
    }
    next();
  },
  // Enforcing stub — same contract as the real requireRole (403 when the
  // session has no role or the role is not in the route's allowed list).
  requireRole:
    (...allowed: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as unknown as { user?: { role?: string } }).user?.role;
      if (typeof role !== "string" || !allowed.includes(role)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    },
  requireRoleOrMcpService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePasswordChangeGate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  setAuthPrisma: () => {},
}));

// Stub ChatPersistenceService so createLlmRouter constructs without a live
// Postgres connection (same shape as llm.test.ts; /llm/complete itself
// never touches persistence — that's the point of the route).
vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    renameConversationForUser: vi.fn(),
    createTurnRows: vi.fn(),
    finalizeAssistantMessage: vi.fn(),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
    ensureConversation: vi.fn().mockResolvedValue({ id: "conv-1", created: true }),
  })),
}));

// Controllable ai-gateway client mock. `isTimeoutError` must be exported
// here (unlike llm.test.ts's mock) because llm-complete.service.ts imports
// it by name.
const mockChat = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: (...args: unknown[]) => mockChat(...args),
  saveKey: vi.fn().mockResolvedValue(undefined),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn().mockResolvedValue(undefined),
  isTimeoutError: (err: unknown) =>
    err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"),
}));

// WARP-3047 — a request with no `model` runs on the box's ACTIVE model,
// resolved by active-model.service (whose own suite covers the resolution
// rules). Observed here so the route's wiring is what is under test.
const mockResolveActiveModel = vi.hoisted(() => vi.fn());
vi.mock("../services/active-model.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/active-model.service.js")>()),
  resolveActiveModel: (...args: unknown[]) => mockResolveActiveModel(...args),
}));

vi.mock("../services/cache.service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/cache.service.js")
  >("../services/cache.service.js");
  return {
    ...actual,
    cacheGet: vi.fn().mockResolvedValue(null),
    cacheSet: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
  stopMcp: vi.fn().mockResolvedValue(undefined),
}));

/** Minimal Response-shaped object for the non-streaming chat path. */
function okChatResponse(content: string, model = "mistral:7b-instruct") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "cmpl-1",
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

/** Same, minus `finish_reason` — some providers omit it entirely. */
function okChatResponseNoFinish(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "cmpl-1",
      object: "chat.completion",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

// The route must NOT read the default model from env any more (WARP-3047);
// clear the env vars per test so a host .env can never make a case pass.
const MODEL_ENV_KEYS = ["DEFAULT_MODEL", "LLM_MODEL"] as const;
let savedEnv: Record<string, string | undefined> = {};

/**
 * WARP-2964 — `completeOnce` called directly, because the route only ever
 * forwards `content`/`model` and the bug lived in what it DROPPED: a
 * reasoning model can spend its whole budget in the analysis channel and
 * hand back `content:""` with `finish_reason:"length"`. Without the
 * provider's verdict the caller cannot tell that from a quiet answer.
 */
describe("completeOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces the reasoning channel and finish_reason alongside empty content", async () => {
    mockChat.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "cmpl-1",
        object: "chat.completion",
        model: "gpt-oss:20b",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "", reasoning_content: "thinking…" },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 700, total_tokens: 701 },
      }),
    });

    await expect(completeOnce({ text: "hi", model: "gpt-oss:20b" })).resolves.toEqual({
      content: "",
      model: "gpt-oss:20b",
      reasoning: "thinking…",
      finishReason: "length",
    });
  });

  it("defaults reasoning to '' and finishReason to null when the provider omits them", async () => {
    mockChat.mockResolvedValueOnce(okChatResponseNoFinish("Hello"));
    const r = await completeOnce({ text: "hi", model: "m" });
    expect(r.reasoning).toBe("");
    expect(r.finishReason).toBeNull();
  });

  it("forwards reasoningEffort as `reasoning_effort` on the gateway body", async () => {
    mockChat.mockResolvedValueOnce(okChatResponse("Hello"));
    await completeOnce({ text: "hi", model: "gpt-oss:20b", reasoningEffort: "low" });
    expect(mockChat.mock.calls[0][0].reasoning_effort).toBe("low");
  });

  it("sends NO `reasoning_effort` key when unset — every other call stays byte-for-byte", async () => {
    mockChat.mockResolvedValueOnce(okChatResponse("Hello"));
    await completeOnce({ text: "hi", model: "m" });
    expect(Object.keys(mockChat.mock.calls[0][0])).not.toContain("reasoning_effort");
  });
});

describe("POST /api/llm/complete", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat.mockResolvedValue(okChatResponse("Hello"));
    // The box's active model for these cases (any id — the happy-path
    // assertions below were written against this one).
    mockResolveActiveModel.mockResolvedValue("mistral:7b-instruct");
    savedEnv = {};
    for (const k of MODEL_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of MODEL_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  describe("happy path", () => {
    it("sends exactly one system+user pair, stream:false, defaults, and NO tools", async () => {
      mockChat.mockResolvedValueOnce(okChatResponse("Bonjour"));
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ system: "You translate to French.", text: "Hello" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ content: "Bonjour", model: "mistral:7b-instruct" });

      expect(mockChat).toHaveBeenCalledTimes(1);
      const [sentReq, signal] = mockChat.mock.calls[0];
      // Exact shape — toEqual also proves no `tools` / `tool_choice` key.
      expect(sentReq).toEqual({
        model: "mistral:7b-instruct",
        messages: [
          { role: "system", content: "You translate to French." },
          { role: "user", content: "Hello" },
        ],
        stream: false,
        temperature: 0.2,
        max_tokens: 1024,
      });
      expect(Object.keys(sentReq)).not.toContain("tools");
      expect(Object.keys(sentReq)).not.toContain("tool_choice");
      // Belt-and-braces timeout: the client sets no timeout for chat, so
      // the service must pass its own AbortSignal.
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it("omits the system turn when `system` is absent", async () => {
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ text: "Just this" });

      expect(res.status).toBe(200);
      const [sentReq] = mockChat.mock.calls[0];
      expect(sentReq.messages).toEqual([{ role: "user", content: "Just this" }]);
    });

    it("forwards temperature / max_tokens overrides", async () => {
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ text: "hi", temperature: 0.9, max_tokens: 256 });

      expect(res.status).toBe(200);
      const [sentReq] = mockChat.mock.calls[0];
      expect(sentReq.temperature).toBe(0.9);
      expect(sentReq.max_tokens).toBe(256);
    });

    it("returns 200 with content:'' on an empty completion", async () => {
      mockChat.mockResolvedValueOnce(okChatResponse(""));
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ text: "say nothing" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ content: "", model: "mistral:7b-instruct" });
    });
  });

  describe("model resolution", () => {
    it("honors an explicit model override", async () => {
      mockResolveActiveModel.mockResolvedValue("docker.io/ai/qwen3:8B-Q4_K_M");
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ text: "hi", model: "llama3:8b" });

      expect(res.status).toBe(200);
      expect(res.body.model).toBe("llama3:8b");
      expect(mockChat.mock.calls[0][0].model).toBe("llama3:8b");
    });

    it("no model → the box's ACTIVE model, not env DEFAULT_MODEL/LLM_MODEL (WARP-3047)", async () => {
      // A switch to B on the Models page must move translate_text /
      // summarize_file too — they run inside a B chat turn, and asking for
      // the env model there loads it next to B.
      process.env.DEFAULT_MODEL = "qwen3:4b";
      process.env.LLM_MODEL = "docker.io/ai/gpt-oss:20B-F16";
      mockResolveActiveModel.mockResolvedValue("docker.io/ai/qwen3:8B-Q4_K_M");
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "service")
        .send({ text: "hi" });

      expect(res.status).toBe(200);
      expect(res.body.model).toBe("docker.io/ai/qwen3:8B-Q4_K_M");
      expect(mockChat.mock.calls[0][0].model).toBe("docker.io/ai/qwen3:8B-Q4_K_M");
      expect(mockResolveActiveModel).toHaveBeenCalledTimes(1);
    });

    it("nothing resolvable → 502 llm_unavailable, never a hardcoded tag", async () => {
      mockResolveActiveModel.mockResolvedValue(null);
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ text: "hi" });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "llm_unavailable" });
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe("validation (400)", () => {
    it("rejects a missing text field", async () => {
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ system: "hello" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid request");
      expect(res.body.details).toBeDefined();
      expect(mockChat).not.toHaveBeenCalled();
    });

    it("rejects text over the 24000-char cap", async () => {
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ text: "x".repeat(24001) });

      expect(res.status).toBe(400);
      expect(mockChat).not.toHaveBeenCalled();
    });

    it("rejects unknown keys (strict schema — no smuggling agent-loop fields)", async () => {
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ text: "hi", tools: [{ name: "read_file" }] });

      expect(res.status).toBe(400);
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe("gateway failure (502)", () => {
    it("returns 502 llm_unavailable when the gateway client throws", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockChat.mockRejectedValueOnce(new Error("ECONNREFUSED ai-gateway"));
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ text: "hi" });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "llm_unavailable" });
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it("returns 502 llm_unavailable on the belt-and-braces timeout", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const timeoutErr = new Error("The operation was aborted due to timeout");
      timeoutErr.name = "TimeoutError";
      mockChat.mockRejectedValueOnce(timeoutErr);
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ text: "hi" });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "llm_unavailable" });
      errSpy.mockRestore();
    });

    it("returns 502 llm_unavailable when the gateway returns non-OK", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockChat.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "upstream down",
      });
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "owner")
        .send({ text: "hi" });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "llm_unavailable" });
      errSpy.mockRestore();
    });
  });

  describe("role guard", () => {
    it("admits the mcp-server service principal (role=service)", async () => {
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "service")
        .send({ text: "hi" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ content: "Hello", model: "mistral:7b-instruct" });
    });

    it.each(["owner", "admin", "family", "guest"])(
      "admits the %s role",
      async (role) => {
        const res = await request(app)
          .post("/api/llm/complete")
          .set("x-test-role", role)
          .send({ text: "hi" });
        expect(res.status).toBe(200);
      },
    );

    it("rejects an unauthenticated request (no role)", async () => {
      const res = await request(app)
        .post("/api/llm/complete")
        .send({ text: "hi" });

      expect(res.status).toBe(403);
      expect(mockChat).not.toHaveBeenCalled();
    });

    it("rejects a role outside the allowed list", async () => {
      const res = await request(app)
        .post("/api/llm/complete")
        .set("x-test-role", "stranger")
        .send({ text: "hi" });

      expect(res.status).toBe(403);
      expect(mockChat).not.toHaveBeenCalled();
    });
  });
});
