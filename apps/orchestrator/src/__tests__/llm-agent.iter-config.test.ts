/**
 * Spec §1 — the agent loop reads its iteration limits from config, not
 * hard-coded 5/10. Config is mocked to distinctive values so a regression to
 * the literals fails loudly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../config.js")>();
  return {
    ...mod,
    config: { ...mod.config, agentMaxIter: { defaultIter: 2, capIter: 3 } },
  };
});

import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

/** Gateway that ALWAYS returns a tool call, so the loop runs to its cap. */
function loopingDeps() {
  const chat = vi.fn().mockResolvedValue({
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
                function: { name: "list_files", arguments: "{}" },
              },
            ],
          },
        },
      ],
    }),
  });
  const deps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue([
          { name: "list_files", description: "d", inputSchema: {} },
        ]),
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "{}" }],
      }),
    } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat };
}

describe("runAgent — config-driven iteration limits (spec §1)", () => {
  it("uses config.agentMaxIter.defaultIter when max_iter unset", async () => {
    const { deps, chat } = loopingDeps();
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chat).toHaveBeenCalledTimes(2); // mocked default = 2
    expect(result.stop_reason).toBe("iteration_limit");
    expect(result.iterations).toBe(2);
  });

  it("clamps an oversized caller max_iter to config.agentMaxIter.capIter", async () => {
    const { deps, chat } = loopingDeps();
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_iter: 99,
    });
    expect(chat).toHaveBeenCalledTimes(3); // mocked cap = 3
    expect(result.iterations).toBe(3);
  });
});
