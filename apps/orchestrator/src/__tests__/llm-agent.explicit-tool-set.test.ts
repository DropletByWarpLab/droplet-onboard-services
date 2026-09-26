/**
 * WARP-3125 — the agent loop under `tool_selection_mode: "explicit"`.
 *
 * The chat route picks `explicit` for a service principal that sent its own
 * `allowed_tools` (voice-io). The loop must then put the caller's set on the
 * wire unchanged: the SAME bytes on every turn, whatever the sentence, so
 * llama-server can reuse the cached prefix through the tool block. And unlike
 * `off`, it must still assert the tool budget.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import { ToolBudgetExceededError } from "../services/tool-budget.service.js";

// Registry order as `mcp.listTools()` returns it. Includes tools OUTSIDE the
// caller's set so the filter has something to exclude.
const REGISTRY = [
  { name: "search_content", description: "search", inputSchema: { type: "object" } },
  { name: "read_file", description: "read", inputSchema: { type: "object" } },
  { name: "list_cameras", description: "cameras", inputSchema: { type: "object" } },
  { name: "get_system_health", description: "health", inputSchema: { type: "object" } },
  { name: "control_device", description: "control", inputSchema: { type: "object" } },
  { name: "business_find", description: "business", inputSchema: { type: "object" } },
  { name: "list_network_devices", description: "network", inputSchema: { type: "object" } },
];

// The caller's set, deliberately NOT in registry order.
const CALLER_SET = [
  "get_system_health",
  "list_cameras",
  "control_device",
  "search_content",
  "read_file",
];

function makeDeps() {
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    }),
  }));
  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue(REGISTRY),
      callTool: vi.fn(),
    } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat };
}

const toolsOf = (call: unknown) => (call as { tools: unknown[] }).tools;
const toolNames = (call: unknown) =>
  (call as { tools: { function: { name: string } }[] }).tools.map(
    (t) => t.function.name,
  );

async function advertisedFor(
  content: string,
  mode: "explicit" | "domains",
): Promise<unknown[]> {
  const { deps, chat } = makeDeps();
  await runAgent(deps, {
    model: "m",
    messages: [{ role: "user", content }],
    tool_selection_mode: mode,
    allowed_tools: CALLER_SET,
  });
  return toolsOf(chat.mock.calls[0]![0]);
}

describe("runAgent — explicit tool set (WARP-3125)", () => {
  it("advertises the caller's whole set, in registry order", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "is everything working?" }],
      tool_selection_mode: "explicit",
      allowed_tools: CALLER_SET,
    });
    // Registry order, not caller order, and nothing outside the set.
    expect(toolNames(chat.mock.calls[0]![0])).toEqual([
      "search_content",
      "read_file",
      "list_cameras",
      "get_system_health",
      "control_device",
    ]);
  });

  it("two different sentences put byte-identical tools[] on the wire", async () => {
    // The cache property itself. Mutation: let `explicit` fall into the
    // keyword branch → the health question advertises core only and the two
    // serialisations differ.
    const a = await advertisedFor("is everything working?", "explicit");
    const b = await advertisedFor("is the front camera online?", "explicit");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("the same two sentences differ under `domains` (the defect this fixes)", async () => {
    const a = await advertisedFor("is everything working?", "domains");
    const b = await advertisedFor("is the front camera online?", "domains");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(
      (a as { function: { name: string } }[]).map((t) => t.function.name),
    ).not.toContain("get_system_health");
  });

  it("still asserts the tool budget, unlike `off`", async () => {
    // Mutation: gate the assert on `=== "domains"` again → the explicit run
    // resolves instead of throwing.
    const { deps } = makeDeps();
    await expect(
      runAgent(deps, {
        model: "m",
        messages: [{ role: "user", content: "is everything working?" }],
        tool_selection_mode: "explicit",
        allowed_tools: CALLER_SET,
        context_window: 1000,
      }),
    ).rejects.toBeInstanceOf(ToolBudgetExceededError);

    // `off` is the rollback lever and deliberately skips the assert.
    const off = makeDeps();
    await expect(
      runAgent(off.deps, {
        model: "m",
        messages: [{ role: "user", content: "is everything working?" }],
        tool_selection_mode: "off",
        allowed_tools: CALLER_SET,
        context_window: 1000,
      }),
    ).resolves.toBeDefined();
  });

  it("an explicit empty set is still zero tools", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "is everything working?" }],
      tool_selection_mode: "explicit",
      allowed_tools: [],
    });
    expect(toolNames(chat.mock.calls[0]![0])).toEqual([]);
  });
});
