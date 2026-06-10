/**
 * WARP-849 — `max_tokens` pass-through in the agent loop.
 *
 * The /api/llm/chat zod schema has always ACCEPTED `max_tokens`, but the
 * agent loop never forwarded it to the ai-gateway, so a caller's budget
 * silently became a no-op (the provider ran on its own default). The
 * setup wizard's "Ask the AI" probe needs a real budget: reasoning
 * models (gpt-oss:20b) burn completion tokens on the reasoning channel
 * BEFORE any user-visible content, so the probe must be able to size
 * `max_tokens` for reasoning + answer and trust it reaches Ollama.
 *
 * Verifies:
 *   1. `runAgent` forwards `max_tokens` verbatim on the gateway chat call.
 *   2. When the caller sets no budget, none is invented (undefined —
 *      provider default behavior unchanged).
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

function depsWithChatSpy() {
  const chat = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content: "hi" } }],
    }),
  });
  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn(),
    } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat };
}

describe("runAgent — max_tokens pass-through (WARP-849)", () => {
  it("forwards max_tokens verbatim to the ai-gateway chat call", async () => {
    const { deps, chat } = depsWithChatSpy();
    await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 2000,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![0]).toMatchObject({ max_tokens: 2000 });
  });

  it("sends no max_tokens when the caller did not set one", async () => {
    const { deps, chat } = depsWithChatSpy();
    await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(
      (chat.mock.calls[0]![0] as { max_tokens?: number }).max_tokens,
    ).toBeUndefined();
  });
});
