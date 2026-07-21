/**
 * WARP-1442 — `reasoning_effort` pass-through in the agent loop.
 *
 * The route resolves the effective reasoning effort (applying the voice
 * principal's server-side default) and hands it to `runAgent`. The loop's job
 * is only to forward it verbatim onto the ai-gateway chat call, exactly as it
 * does for `max_tokens` (WARP-849) — the gateway then decides whether the
 * target model honors it. Unset must forward NOTHING so the outbound request
 * stays byte-for-byte unchanged for the dashboard / every non-voice caller.
 *
 * Mirrors llm-agent.max-tokens.test.ts.
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

describe("runAgent — reasoning_effort pass-through (WARP-1442)", () => {
  it("forwards reasoning_effort verbatim to the ai-gateway chat call", async () => {
    const { deps, chat } = depsWithChatSpy();
    await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "low",
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![0]).toMatchObject({ reasoning_effort: "low" });
  });

  it("forwards a non-default level unchanged", async () => {
    const { deps, chat } = depsWithChatSpy();
    await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
    });
    expect(chat.mock.calls[0]![0]).toMatchObject({ reasoning_effort: "high" });
  });

  it("sends no reasoning_effort when the caller did not set one", async () => {
    const { deps, chat } = depsWithChatSpy();
    await runAgent(deps, {
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(
      (chat.mock.calls[0]![0] as { reasoning_effort?: string }).reasoning_effort,
    ).toBeUndefined();
  });
});
