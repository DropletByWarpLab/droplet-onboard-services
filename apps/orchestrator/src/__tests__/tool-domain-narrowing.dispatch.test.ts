/**
 * WARP-1529 (RBAC v2 T5) — enforcement point 2 of 2: the DISPATCH re-check.
 *
 * The catalog filter is UX; THIS is the security boundary. A stale client
 * tool shelf — an `allowed_tools` list a browser tab cached before the role
 * was narrowed, or a replayed assistant `tool_calls` entry — must not be able
 * to invoke a tool the role no longer holds. So the loop re-applies the SAME
 * §3 predicate immediately before `deps.mcp.callTool` and fails closed: the
 * MCP child is never reached, the model gets a structured refusal it can
 * recover from, and the refusal lands in the turn trace.
 *
 * Also pins §3 `locks`: a lock-like `control_device` invocation needs the
 * role's `mayOperateLocks`. With the flag the dispatch proceeds — and the
 * tools-core handler's own forced confirmation is still what actually
 * answers, unweakened.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { ToolAccessScope } from "../services/tool-access.service.js";

const POOL_TOOLS = [
  { name: "list_files", description: "d", inputSchema: {} },
  { name: "write_file", description: "d", inputSchema: {} },
  { name: "list_cameras", description: "d", inputSchema: {} },
  { name: "list_smart_home_devices", description: "d", inputSchema: {} },
  { name: "control_device", description: "d", inputSchema: {} },
];

const scope = (
  domains: string[],
  writeDomains: string[] = [],
  locks = false,
): ToolAccessScope => ({
  domains: new Set(domains),
  writeDomains: new Set(writeDomains),
  locks,
});

function callOf(name: string, args: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

function makeDeps(assistantTurns: unknown[]) {
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message:
            assistantTurns[
              Math.min(chat.mock.calls.length - 1, assistantTurns.length - 1)
            ],
        },
      ],
    }),
  }));
  const callTool = vi.fn().mockResolvedValue({
    isError: false,
    content: [{ type: "text", text: "{}" }],
  });
  const deps: AgentDeps = {
    mcp: { listTools: vi.fn().mockResolvedValue(POOL_TOOLS), callTool } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

const toolNames = (call: unknown) =>
  (call as { tools: { function: { name: string } }[] }).tools.map((t) => t.function.name);

describe("runAgent — §3 tool-domain narrowing of the advertised pool", () => {
  it("advertises only the scope's domains, read-only under a `view` grant", async () => {
    const { deps, chat } = makeDeps([{ role: "assistant", content: "hi" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "hello" }],
      toolAccessScope: scope(["files"]),
    });
    expect(toolNames(chat.mock.calls[0]![0])).toEqual(["list_files"]);
  });

  it("leaves the pool untouched when no scope applies (no AccessRole / owner)", async () => {
    const { deps, chat } = makeDeps([{ role: "assistant", content: "hi" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(toolNames(chat.mock.calls[0]![0])).toEqual(POOL_TOOLS.map((t) => t.name));
  });
});

describe("runAgent — fail-closed dispatch re-check (the stale-shelf case)", () => {
  it("refuses a dropped-domain tool the client shelf still lists, without dispatching", async () => {
    const { deps, callTool } = makeDeps([
      callOf("list_cameras"),
      { role: "assistant", content: "ok" },
    ]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "show me the cameras" }],
      // The stale shelf: the client still asks for a tool the role lost.
      allowed_tools: ["list_files", "list_cameras"],
      toolAccessScope: scope(["files"]),
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(result.trace[0]).toMatchObject({
      tool: "list_cameras",
      result: { status: "error", error: { code: "FORBIDDEN_TOOL_FOR_ROLE" } },
    });
  });

  it("refuses a write tool under a `view` grant, without dispatching", async () => {
    const { deps, callTool } = makeDeps([
      callOf("write_file", { path: "/x", content: "y" }),
      { role: "assistant", content: "ok" },
    ]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "write a file" }],
      allowed_tools: ["list_files", "write_file"],
      toolAccessScope: scope(["files"]),
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(result.trace[0]).toMatchObject({
      result: { error: { code: "FORBIDDEN_TOOL_FOR_ROLE" } },
    });
  });

  it("dispatches normally when the scope allows the tool", async () => {
    const { deps, callTool } = makeDeps([
      callOf("write_file", { path: "/x" }),
      { role: "assistant", content: "ok" },
    ]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "write a file" }],
      toolAccessScope: scope(["files"], ["files"]),
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]![0]).toBe("write_file");
  });

  it("trips the consecutive-guard circuit breaker with an honest reason", async () => {
    // A model that keeps re-issuing a refused tool must stop the turn rather
    // than burn every iteration — and the breaker's error must say WHY.
    const { deps, callTool } = makeDeps([callOf("list_cameras")]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "cameras?" }],
      allowed_tools: ["list_cameras"],
      toolAccessScope: scope(["files"]),
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(result.stop_reason).toBe("error");
    expect(result.error).toBe("model repeatedly called forbidden tool: list_cameras");
  });

  it("feeds the refusal back to the model so the turn still answers", async () => {
    const { deps } = makeDeps([callOf("list_cameras"), { role: "assistant", content: "ok" }]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "cameras?" }],
      allowed_tools: ["list_cameras"],
      toolAccessScope: scope(["files"]),
    });
    expect(result.message.content).toBe("ok");
  });
});

describe("runAgent — §3 locks (mayOperateLocks)", () => {
  const smartHome = (locks: boolean) => scope(["smart-home"], ["smart-home"], locks);

  it("denies a lock command when the role lacks mayOperateLocks", async () => {
    const { deps, callTool } = makeDeps([
      callOf("control_device", { node_id: "n1", command: "lock" }),
      { role: "assistant", content: "ok" },
    ]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "lock the front door" }],
      toolAccessScope: smartHome(false),
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(result.trace[0]).toMatchObject({
      result: { status: "error", error: { code: "LOCK_OPERATION_NOT_PERMITTED" } },
    });
  });

  it("denies the data-stuffing bypass shape too", async () => {
    const { deps, callTool } = makeDeps([
      callOf("control_device", { node_id: "n1", command: "set_state", data: { set_locked: true } }),
      { role: "assistant", content: "ok" },
    ]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "secure the door" }],
      toolAccessScope: smartHome(false),
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("dispatches the lock command when the role holds mayOperateLocks (handler still confirms)", async () => {
    const { deps, callTool } = makeDeps([
      callOf("control_device", { node_id: "n1", command: "lock" }),
      { role: "assistant", content: "ok" },
    ]);
    callTool.mockResolvedValue({
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "confirmation_required",
            error: { message: "confirm in the dashboard" },
          }),
        },
      ],
    });
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "lock the front door" }],
      toolAccessScope: smartHome(true),
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.trace[0]!.result).toMatchObject({ status: "confirmation_required" });
  });

  it("never blocks ordinary smart-home control without the flag", async () => {
    const { deps, callTool } = makeDeps([
      callOf("control_device", { node_id: "n1", command: "turn_off" }),
      { role: "assistant", content: "ok" },
    ]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "lights off" }],
      toolAccessScope: smartHome(false),
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("does not gate locks at all when no scope applies (owner / no AccessRole)", async () => {
    const { deps, callTool } = makeDeps([
      callOf("control_device", { node_id: "n1", command: "lock" }),
      { role: "assistant", content: "ok" },
    ]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "lock up" }],
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
