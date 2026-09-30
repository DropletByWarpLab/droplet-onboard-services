/**
 * WARP-3338 — every system message reaches the model as ONE system message
 * at index 0. gpt-oss's GGUF template on the Docker Model Runner drops every
 * later system message, which silently dropped the chat route's attachment
 * block, pin block and a chat's own instructions. The fold keeps their order,
 * heads each marked block, and keeps the result under the ai-gateway's
 * per-message cap by cutting attachments first, then chat instructions, and
 * never the base prompt or the pins.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    AGENT_BLANK_TURN_DEBUG: false,
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "off",
    agentMaxIter: { defaultIter: 10, capIter: 10 },
  },
}));

interface LoggedLine {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}
const { logged, gatewayChat } = vi.hoisted(() => ({
  logged: [] as LoggedLine[],
  gatewayChat: vi.fn(),
}));
vi.mock("../lib/logger.js", () => {
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    logged.push({ level, obj, msg });
  };
  const stub = {
    warn: push("warn"),
    debug: push("debug"),
    info: push("info"),
    error: push("error"),
    trace: push("trace"),
    fatal: push("fatal"),
    silent: () => {},
    child: () => stub,
  };
  return { createLogger: () => stub };
});
// Email analysis reaches the gateway through this module's `chat`.
vi.mock("../services/ai-gateway.client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ai-gateway.client.js")>()),
  chat: gatewayChat,
}));

import {
  FOLD_TRUNCATED_MARKER,
  FOLDED_SYSTEM_MAX_CHARS,
  foldSystemMessages,
  runAgent,
  type AgentDeps,
} from "../services/llm-agent.service.js";
import { createEmailAnalysisFn } from "../services/email-analysis.service.js";
import type { ChatMessage, ChatStreamChunk } from "../types/index.js";

const sys = (content: string, contextBlock?: ChatMessage["contextBlock"]): ChatMessage =>
  contextBlock ? { role: "system", content, contextBlock } : { role: "system", content };
const text = (m: ChatMessage | undefined) => (typeof m?.content === "string" ? m.content : "");
const systemCount = (ms: readonly ChatMessage[]) => ms.filter((m) => m.role === "system").length;

/** The route's layout: base, then attachments, pins and the chat's own instructions. */
function routeLayout(sizes: { base?: number; attachments?: number; pins?: number; chat?: number } = {}) {
  return [
    sys("B".repeat(sizes.base ?? 4)),
    sys("A".repeat(sizes.attachments ?? 4), "attachments"),
    sys("P".repeat(sizes.pins ?? 4), "pins"),
    sys("C".repeat(sizes.chat ?? 4), "chat_instructions"),
    { role: "user", content: "q" } as ChatMessage,
  ];
}

const HEADERS = {
  attachments: "## Files attached to this conversation\n\n",
  pins: "## Pinned context\n\n",
  chat_instructions: "## Instructions for this chat\n\n",
};
/** Folded length of `routeLayout` before any cut. */
const foldedLength = (b: number, a: number, p: number, c: number) =>
  b + HEADERS.attachments.length + a + HEADERS.pins.length + p + HEADERS.chat_instructions.length + c + 3 * 2;

beforeEach(() => {
  logged.length = 0;
  gatewayChat.mockReset();
});

describe("foldSystemMessages (WARP-3338)", () => {
  it("leaves a request whose only system message is first untouched (agent runs, email analysis)", () => {
    const m: ChatMessage[] = [sys("base"), { role: "user", content: "hi" }];
    const out = foldSystemMessages(m);
    expect(out.messages).toBe(m);
    expect(out.trimmed).toEqual({});
  });

  it("sends exactly one system message, at index 0: base, attachments, pins, chat instructions, each block headed", () => {
    const out = foldSystemMessages([
      sys("BASE"),
      sys("ATTACH", "attachments"),
      sys("PINS", "pins"),
      sys("CHAT", "chat_instructions"),
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
    expect(systemCount(out.messages)).toBe(1);
    expect(out.messages[0]).toEqual({
      role: "system",
      content:
        "BASE\n\n" +
        HEADERS.attachments + "ATTACH\n\n" +
        HEADERS.pins + "PINS\n\n" +
        HEADERS.chat_instructions + "CHAT",
    });
    expect(out.messages.slice(1)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
  });

  it("folds an unmarked later system message too, without a header", () => {
    const out = foldSystemMessages([
      sys("BASE"),
      { role: "user", content: "q" },
      sys("late note"),
    ]);
    expect(out.messages).toEqual([sys("BASE\n\nlate note"), { role: "user", content: "q" }]);
  });

  it("hoists system messages that are not first", () => {
    const out = foldSystemMessages([{ role: "user", content: "q" }, sys("only")]);
    expect(out.messages).toEqual([sys("only"), { role: "user", content: "q" }]);
  });

  describe("size guard", () => {
    it("cuts nothing when the folded message is exactly at the cap", () => {
      const base = FOLDED_SYSTEM_MAX_CHARS - foldedLength(0, 100, 100, 100);
      const out = foldSystemMessages(routeLayout({ base, attachments: 100, pins: 100, chat: 100 }));
      expect(text(out.messages[0])).toHaveLength(FOLDED_SYSTEM_MAX_CHARS);
      expect(out.trimmed).toEqual({});
    });

    it("one char over: cuts the attachments, marks the cut, and lands at or under the cap", () => {
      const base = FOLDED_SYSTEM_MAX_CHARS - foldedLength(0, 100, 100, 100) + 1;
      const out = foldSystemMessages(routeLayout({ base, attachments: 100, pins: 100, chat: 100 }));
      const folded = text(out.messages[0]);
      expect(folded.length).toBeLessThanOrEqual(FOLDED_SYSTEM_MAX_CHARS);
      expect(out.trimmed).toEqual({ attachments: 1 + FOLD_TRUNCATED_MARKER.length });
      expect(folded).toContain(HEADERS.attachments + "A".repeat(100 - 1 - FOLD_TRUNCATED_MARKER.length) + FOLD_TRUNCATED_MARKER + "\n\n");
      expect(folded.startsWith("B".repeat(base) + "\n\n")).toBe(true);
      expect(folded).toContain(HEADERS.pins + "P".repeat(100));
      expect(folded.endsWith(HEADERS.chat_instructions + "C".repeat(100))).toBe(true);
    });

    it("cuts the chat instructions once the attachments are down to their header, never the base or the pins", () => {
      // 2,000 attachment chars cannot cover a ~2,500-char overflow.
      const base = 26_000;
      const pins = 1_400;
      const out = foldSystemMessages(routeLayout({ base, attachments: 2_000, pins, chat: 4_000 }));
      const folded = text(out.messages[0]);
      expect(folded.length).toBeLessThanOrEqual(FOLDED_SYSTEM_MAX_CHARS);
      // Everything after the header: its blank line and the whole body.
      expect(out.trimmed.attachments).toBe(2 + 2_000);
      expect(out.trimmed.chat_instructions).toBeGreaterThan(0);
      expect(folded.startsWith("B".repeat(base) + "\n\n")).toBe(true);
      expect(folded).toContain(HEADERS.attachments.trimEnd() + FOLD_TRUNCATED_MARKER);
      expect(folded).toContain(HEADERS.pins + "P".repeat(pins));
      expect(folded.endsWith(FOLD_TRUNCATED_MARKER)).toBe(true);
    });

    it("leaves the base prompt and the pins whole even when nothing else is left to cut", () => {
      const out = foldSystemMessages(
        routeLayout({ base: FOLDED_SYSTEM_MAX_CHARS, attachments: 50, pins: 200, chat: 50 }),
      );
      const folded = text(out.messages[0]);
      expect(folded.startsWith("B".repeat(FOLDED_SYSTEM_MAX_CHARS) + "\n\n")).toBe(true);
      expect(folded).toContain(HEADERS.pins + "P".repeat(200));
    });

    it("never splits a surrogate pair", () => {
      const base = FOLDED_SYSTEM_MAX_CHARS - foldedLength(0, 200, 4, 4);
      const emoji = "\u{1F4C4}".repeat(100); // 200 UTF-16 units
      const layout = routeLayout({ base: base + 1, pins: 4, chat: 4 });
      layout[1] = sys(emoji, "attachments");
      const folded = text(foldSystemMessages(layout).messages[0]);
      expect(folded.length).toBeLessThanOrEqual(FOLDED_SYSTEM_MAX_CHARS);
      expect(folded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });
  });
});

function blockingDeps(content = "done") {
  const chat = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { role: "assistant", content } }] }),
  });
  const deps: AgentDeps = {
    mcp: { listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn() } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat };
}

function streamingDeps() {
  const chatStream = vi.fn((_req: { messages: ChatMessage[] }, _signal?: AbortSignal) => ({
    async *[Symbol.asyncIterator]() {
      const chunk: ChatStreamChunk = {
        choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
      } as ChatStreamChunk;
      yield chunk;
    },
  }));
  const chat = vi.fn();
  const deps: AgentDeps = {
    mcp: { listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn() } as never,
    aiGateway: { chat, chatStream } as never,
    onEvent: () => {},
  };
  return { deps, chat, chatStream };
}

const FOLDED_WIRE = [
  sys("BASE\n\n" + HEADERS.pins + "PINS"),
  { role: "user", content: "q" },
];

describe("runAgent sends the folded shape on both transports (WARP-3338)", () => {
  it("blocking", async () => {
    const { deps, chat } = blockingDeps();
    await runAgent(deps, {
      model: "m",
      messages: [sys("BASE"), sys("PINS", "pins"), { role: "user", content: "q" }],
    });
    expect(chat.mock.calls[0][0].messages).toEqual(FOLDED_WIRE);
  });

  it("streaming", async () => {
    const { deps, chat, chatStream } = streamingDeps();
    await runAgent(deps, {
      model: "m",
      messages: [sys("BASE"), sys("PINS", "pins"), { role: "user", content: "q" }],
    });
    expect(chat).not.toHaveBeenCalled();
    expect(chatStream.mock.calls[0][0].messages).toEqual(FOLDED_WIRE);
  });

  it("logs one agent_system_fold_trimmed line with counts and no content", async () => {
    const { deps } = blockingDeps();
    await runAgent(deps, {
      model: "m",
      messages: routeLayout({ base: 20_000, attachments: 15_000, pins: 10, chat: 10 }),
    });
    const lines = logged.filter((l) => l.msg === "agent_system_fold_trimmed");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj.trimmed_chars).toEqual({ attachments: expect.any(Number) });
    expect(lines[0]!.obj.max_chars).toBe(FOLDED_SYSTEM_MAX_CHARS);
    expect(JSON.stringify(lines[0]!.obj)).not.toMatch(/AAAA|BBBB/);
  });

  it("logs nothing when nothing was cut", async () => {
    const { deps } = blockingDeps();
    await runAgent(deps, { model: "m", messages: routeLayout() });
    expect(logged.some((l) => l.msg === "agent_system_fold_trimmed")).toBe(false);
  });

  it("an agent run's request (system prompt + goal) goes out unchanged", async () => {
    const { deps, chat } = blockingDeps();
    const messages: ChatMessage[] = [sys("RUN SYSTEM PROMPT"), { role: "user", content: "the goal" }];
    await runAgent(deps, { model: "m", messages });
    expect(chat.mock.calls[0][0].messages).toEqual(messages);
  });

  it("email analysis's request goes out unchanged", async () => {
    gatewayChat.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "{}" } }] }),
    });
    const analyse = createEmailAnalysisFn(
      { listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn() } as never,
      async () => "m",
    );
    await analyse({ subject: "Invoice", messages: [] } as never);
    const sent = gatewayChat.mock.calls[0][0].messages as ChatMessage[];
    expect(systemCount(sent)).toBe(1);
    expect(sent[0]!.role).toBe("system");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.role).toBe("user");
  });
});
