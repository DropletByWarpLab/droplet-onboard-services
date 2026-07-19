/**
 * WARP-1331 — agent-loop output hygiene.
 *
 * Three defect classes observed across staging-suite runs 1–3 (evidence on
 * the ticket): (1) the iteration-limit failure copy interpolated
 * model-controlled tool names verbatim — users saw "the memory_repay?? tool
 * kept failing" for tools that don't exist; (2) the finalize path returned
 * raw tool-call JSON (`{"path":"/Admin"}`) as the assistant's answer; and
 * (3) blank final answers — `cleanedContent` empty meant no content_delta
 * AND an empty persisted message. Plus citation cruft (`【3†source=…】`)
 * leaking into otherwise-correct answers.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { SSEEvent } from "../types/sse-events.js";

const TOOL = {
  name: "search_content",
  description: "...",
  inputSchema: { type: "object", properties: {} },
};

function finalContent(content: string | null) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content } }],
    }),
  };
}

function toolCall(name: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name, arguments: "{}" },
              },
            ],
          },
        },
      ],
    }),
  };
}

function makeDeps(chat: ReturnType<typeof vi.fn>, callTool = vi.fn()) {
  const events: SSEEvent[] = [];
  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue([TOOL]),
      callTool,
    } as never,
    aiGateway: { chat } as never,
    onEvent: (e: SSEEvent) => events.push(e),
  };
  return { deps, events };
}


// ChatMessage.content is `string | ContentBlock[]`; the agent loop always
// finalises with a string — coerce for assertions without weakening types.
function asText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

const REQ = {
  model: "gpt-oss:20b",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("runAgent — finalize guard (WARP-1331)", () => {
  it("leaves an empty completion empty — WARP-854 owns that error path", async () => {
    const chat = vi.fn().mockResolvedValue(finalContent(""));
    const { deps, events } = makeDeps(chat);
    const result = await runAgent(deps, REQ);
    expect(result.stop_reason).toBe("model_done");
    expect(asText(result.message.content).trim()).toBe("");
    // No content_delta for an empty completion — the route layer rewrites
    // it to a done error frame / FAILED turn (WARP-854 contract).
    expect(events.find((e) => e.type === "content_delta")).toBeUndefined();
  });

  it("demotes a bare tool-call JSON final to empty (WARP-854 failed turn)", async () => {
    const chat = vi
      .fn()
      .mockResolvedValue(finalContent('{"path":"/Admin/IDs"}'));
    const { deps } = makeDeps(chat);
    const result = await runAgent(deps, REQ);
    expect(asText(result.message.content)).not.toContain('"path"');
    expect(asText(result.message.content).trim()).toBe("");
  });

  it("strips citation cruft but keeps the real answer", async () => {
    const chat = vi
      .fn()
      .mockResolvedValue(
        finalContent(
          "The code is **HMKQ8Z2T4F**【3†source=functions.search_content】 " +
            "and check-in is 15:00【4†source=nextcloud】.",
        ),
      );
    const { deps } = makeDeps(chat);
    const result = await runAgent(deps, REQ);
    expect(asText(result.message.content)).toContain("HMKQ8Z2T4F");
    expect(asText(result.message.content)).toContain("15:00");
    expect(asText(result.message.content)).not.toContain("【");
  });
});

describe("runAgent — failure-copy tool names (WARP-1331)", () => {
  it("does not reflect model-invented tool names into user-facing copy", async () => {
    // The model calls a nonexistent, garbled tool every iteration; the
    // guard records the failures and the loop exhausts its budget.
    const chat = vi.fn().mockResolvedValue(toolCall("memory_repay??"));
    const { deps } = makeDeps(chat);
    const result = await runAgent(deps, { ...REQ, max_iter: 2 });
    expect(result.stop_reason).toBe("iteration_limit");
    expect(asText(result.message.content)).not.toContain("memory_repay");
    // Still honest about the failure class.
    expect(asText(result.message.content)).toMatch(/tool/i);
  });

  it("still names a real registry tool that kept failing", async () => {
    const chat = vi.fn().mockResolvedValue(toolCall("search_content"));
    const callTool = vi.fn().mockRejectedValue(new Error("boom"));
    const { deps } = makeDeps(chat, callTool);
    const result = await runAgent(deps, { ...REQ, max_iter: 2 });
    expect(result.stop_reason).toBe("iteration_limit");
    expect(asText(result.message.content)).toContain("search_content");
  });
});
