/**
 * WARP-399 — Tier-2 deferral hook in runAgent.
 *
 * Verifies the safety boundary: in autonomous mode, calling a tool
 * for which the hook returns a `ToolDeferral` does NOT dispatch
 * through mcp.callTool. Instead the model receives a synthetic
 * `confirmation_required` tool result, and the loop continues.
 */

import { describe, it, expect, vi } from "vitest";
import {
  runAgent,
  type AgentDeps,
  type ToolDeferralHook,
} from "../services/llm-agent.service.js";

function makeDeps(
  callTool: ReturnType<typeof vi.fn>,
  chat: ReturnType<typeof vi.fn>,
  deferTier2ToolCall?: ToolDeferralHook,
): AgentDeps {
  return {
    mcp: {
      listTools: vi.fn().mockResolvedValue([
        { name: "set_port_vlan", description: "...", inputSchema: { type: "object", properties: {} } },
        { name: "get_switch_ports", description: "...", inputSchema: { type: "object", properties: {} } },
      ]),
      callTool,
    } as never,
    aiGateway: { chat } as never,
    deferTier2ToolCall,
  };
}

function chatAdvertisingToolCall(name: string, id = "c1") {
  return vi
    .fn()
    // First turn: model issues the tool call.
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id,
                  type: "function",
                  function: { name, arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    })
    // Second turn: model returns a textual reply ending the loop.
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "done" } }],
      }),
    });
}

describe("runAgent Tier-2 deferral (WARP-399)", () => {
  it("interactive mode dispatches every tool call (deferral hook ignored)", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      isError: false,
    });
    const deferTier2ToolCall = vi.fn(); // would defer, but mode is interactive
    const chat = chatAdvertisingToolCall("set_port_vlan");
    const deps = makeDeps(callTool, chat, deferTier2ToolCall);

    const result = await runAgent(deps, {
      model: "x",
      messages: [{ role: "user", content: "do it" }],
      mode: "interactive",
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(deferTier2ToolCall).not.toHaveBeenCalled();
    expect(result.stop_reason).toBe("model_done");
  });

  it("autonomous mode + deferral DOES NOT call mcp.callTool", async () => {
    const callTool = vi.fn();
    const deferTier2ToolCall: ToolDeferralHook = vi.fn(async () => ({
      proposal_id: "prop_xyz",
      reason: "Tier-2 deferred for operator approval",
    }));
    const chat = chatAdvertisingToolCall("set_port_vlan");
    const deps = makeDeps(callTool, chat, deferTier2ToolCall);

    const result = await runAgent(deps, {
      model: "x",
      messages: [{ role: "user", content: "do it" }],
      mode: "autonomous",
      agentRunId: "audit_abc",
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(deferTier2ToolCall).toHaveBeenCalledWith({
      toolName: "set_port_vlan",
      toolArgs: {},
      agentRunId: "audit_abc",
    });
    expect(result.stop_reason).toBe("model_done");

    // The synthetic result the model received should be in the trace.
    const traceEntry = result.trace.find((t) => t.tool === "set_port_vlan");
    expect(traceEntry).toBeDefined();
    const r = traceEntry!.result as {
      ok: boolean;
      status: string;
      error?: { details?: { proposal_id?: string; deferred?: boolean } };
    };
    expect(r.status).toBe("confirmation_required");
    expect(r.error?.details?.proposal_id).toBe("prop_xyz");
    expect(r.error?.details?.deferred).toBe(true);
  });

  it("autonomous mode + hook returns null DOES call mcp.callTool (Tier-1 read)", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ ports: [] }) }],
      isError: false,
    });
    // Hook says "not a Tier-2 tool, proceed".
    const deferTier2ToolCall: ToolDeferralHook = vi.fn(async () => null);
    const chat = chatAdvertisingToolCall("get_switch_ports");
    const deps = makeDeps(callTool, chat, deferTier2ToolCall);

    const result = await runAgent(deps, {
      model: "x",
      messages: [{ role: "user", content: "look" }],
      mode: "autonomous",
      agentRunId: "audit_abc",
    });

    expect(deferTier2ToolCall).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.stop_reason).toBe("model_done");
  });

  it("autonomous mode without a hook silently degrades to dispatch (back-compat)", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      isError: false,
    });
    const chat = chatAdvertisingToolCall("set_port_vlan");
    const deps = makeDeps(callTool, chat); // no deferTier2ToolCall

    const result = await runAgent(deps, {
      model: "x",
      messages: [{ role: "user", content: "do it" }],
      mode: "autonomous",
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.stop_reason).toBe("model_done");
  });
});
