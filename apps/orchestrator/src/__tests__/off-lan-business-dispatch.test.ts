/**
 * WARP-2990 — a cloud turn cannot reach the `business` tools even by naming
 * one directly. The route withholds them from `allowed_tools`
 * (`withholdStoredContentTools`); this pins the OTHER half: the agent loop,
 * handed that narrowed list, refuses a call to a withheld name without ever
 * dispatching it to the MCP child. The domain self-heal must not bring it
 * back either, since it only expands names already in the pool.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import {
  OFF_LAN_WITHHELD_TOOLS,
  withholdStoredContentTools,
} from "../services/stored-content-egress.service.js";

const REGISTRY = ["business_profile_get", "business_find", "get_network_status"];

function toolCallTurn(name: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c-1", type: "function", function: { name, arguments: "{}" } },
            ],
          },
        },
      ],
    }),
  };
}

describe("WARP-2990 — business tools on a cloud turn", () => {
  it("withholds every business_* tool by domain, not by name", () => {
    for (const name of [
      "business_profile_get",
      "business_find",
      "business_timeline",
      "business_create",
      "business_update",
      "business_link",
    ]) {
      expect(OFF_LAN_WITHHELD_TOOLS.has(name)).toBe(true);
    }
    expect(withholdStoredContentTools(REGISTRY)).toEqual(["get_network_status"]);
  });

  it("refuses a direct call to a withheld business tool and never dispatches it", async () => {
    const callTool = vi.fn();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolCallTurn("business_profile_get"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "It stays on the Droplet." } }],
        }),
      });
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue(
          REGISTRY.map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        ),
        callTool,
      } as never,
      aiGateway: { chat } as never,
      onEvent: () => {},
    };

    const result = await runAgent(deps, {
      model: "claude-opus-4-20250514",
      messages: [{ role: "user", content: "what's our business profile?" }],
      // Exactly what routes/llm.ts hands the loop on an off-LAN turn.
      allowed_tools: withholdStoredContentTools(REGISTRY),
    });

    expect(callTool).not.toHaveBeenCalled();
    // Not advertised on the wire either.
    const advertised = (chat.mock.calls[0][0].tools ?? []).map(
      (t: { function: { name: string } }) => t.function.name,
    );
    expect(advertised).not.toContain("business_profile_get");
    expect(result.trace[0]?.tool).toBe("business_profile_get");
    expect((result.trace[0]?.result as { status?: string }).status).toBe("error");
  });
});
