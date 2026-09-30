import { describe, it, expect, vi } from "vitest";
import { createMcpStepDispatcher } from "./mcp-step-dispatcher.js";

const ok = (text?: string) => ({ isError: false, content: text === undefined ? [] : [{ type: "text", text }] });

describe("createMcpStepDispatcher", () => {
  it("forwards the call context to callTool (it becomes _meta: the person the call is for)", async () => {
    const callTool = vi.fn().mockResolvedValue(ok("{}"));
    await createMcpStepDispatcher({ callTool }).call("get_network_status", { a: 1 }, { userId: "alice" });
    expect(callTool).toHaveBeenCalledWith("get_network_status", { a: 1 }, { userId: "alice" });
  });

  it("passes no context when the caller has none", async () => {
    const callTool = vi.fn().mockResolvedValue(ok("{}"));
    await createMcpStepDispatcher({ callTool }).call("t", {});
    expect(callTool).toHaveBeenCalledWith("t", {}, undefined);
  });

  it("returns the parsed result (stepResultValue owns the parsing rules, pinned in llm-agent.malformed-tool-output.test.ts)", async () => {
    const callTool = vi.fn().mockResolvedValue(ok('{"n":1}'));
    expect(await createMcpStepDispatcher({ callTool }).call("t", {})).toEqual({ n: 1 });
  });

  it("throws the tool's own message when the tool, or a gate in front of it, reports an error", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValue({ isError: true, content: [{ type: "text", text: "module_disabled" }] });
    await expect(createMcpStepDispatcher({ callTool }).call("t", {})).rejects.toThrow("module_disabled");
  });
});
