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

  it("parses a JSON result, keeps non-JSON as raw, and returns null for an empty one", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(ok('{"n":1}'))
      .mockResolvedValueOnce(ok("plain"))
      .mockResolvedValueOnce(ok());
    const d = createMcpStepDispatcher({ callTool });
    expect(await d.call("t", {})).toEqual({ n: 1 });
    expect(await d.call("t", {})).toEqual({ raw: "plain" });
    expect(await d.call("t", {})).toBeNull();
  });

  it("throws the tool's own message when the tool, or a gate in front of it, reports an error", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValue({ isError: true, content: [{ type: "text", text: "module_disabled" }] });
    await expect(createMcpStepDispatcher({ callTool }).call("t", {})).rejects.toThrow("module_disabled");
  });
});
