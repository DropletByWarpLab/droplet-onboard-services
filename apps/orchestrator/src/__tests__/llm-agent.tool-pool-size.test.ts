/**
 * WARP-2921 — the ADR-056 §7/§12 window-budget gate needs the per-turn
 * SELECTED tool pool measured on real hardware, next to the per-dispatch
 * `agent_tool_result_size` line (WARP-2178). `assertToolAdvertisementFitsBudget`
 * already measures the advertisement at both sites where one is committed —
 * before the loop, and on a WARP-642 self-heal — but the size it returns was
 * discarded. These tests pin the `agent_tool_pool_size` debug line that keeps
 * it:
 *
 *   1. the initial advertisement, `phase: "initial"`, `iter: 0`;
 *   2. a COMMITTED self-heal, `phase: "self_heal"`, the loop's iter and the
 *      healed tool — and never a REFUSED one (that path already logs
 *      `tool_budget_exceeded` and commits nothing);
 *   3. `runtime_count` — how much of the advertisement came from the runtime
 *      registry (remote MCP servers / extensions, the growth ADR-056 gates);
 *   4. silence when selection is off or tool_choice is "none" (the assert
 *      does not run there, so there is no measured advertisement to report);
 *   5. `agent_run_id` only on a durable run;
 *   6. names and sizes only — never a spec, a schema, a description or a
 *      tool-name list.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    AGENT_BLANK_TURN_DEBUG: false,
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "off",
    AGENT_TOOL_RESULT_CAP_CHARS: 8000,
    agentMaxIter: { defaultIter: 10, capIter: 10 },
  },
}));

interface LoggedLine {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}
const logged = vi.hoisted(() => [] as LoggedLine[]);
vi.mock("../lib/logger.js", () => {
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    logged.push({ level, obj, msg });
  };
  const stub = {
    warn: push("warn"),
    debug: push("debug"),
    info: push("info"),
    error: push("error"),
    trace: push("trace"),
    fatal: push("fatal"),
    silent: () => {},
    child: () => stub,
  };
  return { createLogger: () => stub };
});

import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import {
  measureToolSpecs,
  toolAdvertisementCeilingTokens,
  type AdvertisedToolSpec,
} from "../services/tool-budget.service.js";
import { DEFAULT_CONTEXT_WINDOW } from "../services/context-budget.service.js";
import { runtimeToolRegistry } from "../services/runtime-tool-registry.service.js";

const POOL_TOOLS = [
  { name: "search_content", description: "d", inputSchema: {} },
  { name: "read_file", description: "d", inputSchema: {} },
  { name: "list_files", description: "d", inputSchema: {} },
  { name: "memory_recall", description: "d", inputSchema: {} },
  { name: "control_device", description: "d", inputSchema: {} },
  { name: "list_network_devices", description: "d", inputSchema: {} },
];

const ALLOWED_KEYS = new Set([
  "turn_id",
  "iter",
  "phase",
  "count",
  "chars",
  "tokens",
  "ceiling_tokens",
  "context_window",
  "selection_mode",
  "runtime_count",
  "healed_tool",
  "agent_run_id",
]);

function makeDeps(
  assistantTurns: unknown[],
  pool: { name: string; description: string; inputSchema: unknown }[] = POOL_TOOLS,
) {
  const chat = vi.fn(async (_req: { tools: AdvertisedToolSpec[] }) => ({
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
  const callTool = vi.fn(async () => ({
    isError: false,
    content: [{ type: "text", text: "{}" }],
  }));
  const deps: AgentDeps = {
    mcp: { listTools: vi.fn(async () => pool), callTool } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

const poolLines = () => logged.filter((l) => l.msg === "agent_tool_pool_size");
const byPhase = (phase: string) => poolLines().filter((l) => l.obj.phase === phase);

const callControl = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "c1",
      type: "function",
      function: { name: "control_device", arguments: "{}" },
    },
  ],
};

afterEach(() => {
  logged.length = 0;
  runtimeToolRegistry.clear();
});

describe("WARP-2921 — agent_tool_pool_size", () => {
  it("emits agent_tool_pool_size at debug on the initial advertisement", async () => {
    const { deps, chat } = makeDeps([{ role: "assistant", content: "done" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "turn off the kitchen lights" }],
      tool_selection_mode: "domains",
    });

    const lines = byPhase("initial");
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.level).toBe("debug");

    // The numbers are the advertisement the model actually received.
    const sent = chat.mock.calls[0]![0].tools;
    const size = measureToolSpecs(sent);
    expect(line.obj).toMatchObject({
      iter: 0,
      phase: "initial",
      count: size.count,
      chars: size.chars,
      tokens: size.tokens,
      context_window: DEFAULT_CONTEXT_WINDOW,
      ceiling_tokens: toolAdvertisementCeilingTokens({
        contextWindow: DEFAULT_CONTEXT_WINDOW,
      }),
      selection_mode: "domains",
      runtime_count: 0,
    });
    // The ADR-056 §12 ceiling the go/no-go rule is stated against.
    expect(line.obj.ceiling_tokens).toBe(12_410);
    expect(size.count).toBeGreaterThan(0);
    expect(typeof line.obj.turn_id).toBe("string");
    expect((line.obj.turn_id as string).length).toBeGreaterThan(0);
    expect(line.obj).not.toHaveProperty("agent_run_id");
    expect(line.obj).not.toHaveProperty("healed_tool");
  });

  it("carries an explicit context_window through to context_window and ceiling_tokens", async () => {
    const { deps } = makeDeps([{ role: "assistant", content: "done" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "turn off the kitchen lights" }],
      tool_selection_mode: "domains",
      context_window: 32_768,
    });
    const line = byPhase("initial")[0]!;
    expect(line.obj.context_window).toBe(32_768);
    expect(line.obj.ceiling_tokens).toBe(
      toolAdvertisementCeilingTokens({ contextWindow: 32_768 }),
    );
  });

  it("emits a self_heal pool line with healed_tool when a filtered tool is re-admitted", async () => {
    const { deps, chat } = makeDeps([
      callControl, // iter 0: filtered → heal
      callControl, // iter 1: now advertised → dispatch
      { role: "assistant", content: "done" },
    ]);
    await runAgent(deps, {
      model: "m",
      // "hello there" matches no rule → core-only advertisement.
      messages: [{ role: "user", content: "hello there" }],
      tool_selection_mode: "domains",
    });

    const initial = byPhase("initial");
    const heals = byPhase("self_heal");
    expect(initial).toHaveLength(1);
    expect(heals).toHaveLength(1);
    const heal = heals[0]!;
    expect(heal.level).toBe("debug");
    // The heal happens while dispatching iteration 0's tool calls.
    expect(heal.obj).toMatchObject({
      iter: 0,
      phase: "self_heal",
      healed_tool: "control_device",
      selection_mode: "domains",
      runtime_count: 0,
      turn_id: initial[0]!.obj.turn_id,
    });
    // The healed numbers describe the widened advertisement that went out
    // on the NEXT request, not the one before it.
    const widened = measureToolSpecs(chat.mock.calls[1]![0].tools);
    expect(heal.obj.count).toBe(widened.count);
    expect(heal.obj.chars).toBe(widened.chars);
    expect(heal.obj.tokens).toBe(widened.tokens);
    expect(heal.obj.count as number).toBeGreaterThan(initial[0]!.obj.count as number);
  });

  it("a REFUSED heal emits no self_heal pool line", async () => {
    const { deps } = makeDeps([callControl, { role: "assistant", content: "done" }]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "hello there" }],
      tool_selection_mode: "domains",
      // Same fixture as llm-agent.tool-selection.test.ts: the core-only
      // advertisement fits, admitting smart-home does not.
      context_window: 4070,
    });
    expect(byPhase("initial")).toHaveLength(1);
    expect(byPhase("self_heal")).toHaveLength(0);
    const refused = logged.find((l) => l.msg === "tool_budget_exceeded");
    expect(refused).toBeTruthy();
    expect(refused!.obj.phase).toBe("self_heal");
  });

  it("runtime_count counts advertised tools that came from the runtime registry", async () => {
    runtimeToolRegistry.registerServerTools("srv", [
      {
        name: "srv__lamp",
        serverId: "srv",
        domain: "smart-home",
        domainSource: "server",
        description: "d",
        inputSchema: {},
      },
    ]);
    const { deps, chat } = makeDeps(
      [{ role: "assistant", content: "done" }],
      [...POOL_TOOLS, { name: "srv__lamp", description: "d", inputSchema: {} }],
    );
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "turn off the kitchen lights" }],
      tool_selection_mode: "domains",
    });
    const sentNames = chat.mock.calls[0]![0].tools.map((t) => t.function.name);
    expect(sentNames).toContain("srv__lamp");
    const line = byPhase("initial")[0]!;
    expect(line.obj.runtime_count).toBe(1);
    expect(line.obj.count).toBe(sentNames.length);
  });

  it("is silent when selection is off or tool_choice is none", async () => {
    for (const extra of [
      {},
      { tool_selection_mode: "off" as const },
      { tool_selection_mode: "domains" as const, tool_choice: "none" as const },
    ]) {
      logged.length = 0;
      const { deps } = makeDeps([{ role: "assistant", content: "done" }]);
      await runAgent(deps, {
        model: "m",
        messages: [{ role: "user", content: "turn off the kitchen lights" }],
        ...extra,
      });
      expect(poolLines()).toHaveLength(0);
    }
  });

  it("carries agent_run_id on both phases of a durable run", async () => {
    const { deps } = makeDeps([
      callControl,
      callControl,
      { role: "assistant", content: "done" },
    ]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "hello there" }],
      tool_selection_mode: "domains",
      toolCallContext: { agentRunId: "run_1" },
    });
    expect(byPhase("initial")[0]!.obj.agent_run_id).toBe("run_1");
    expect(byPhase("self_heal")[0]!.obj.agent_run_id).toBe("run_1");
  });

  it("carries names and sizes only — never specs, schemas or a tool list", async () => {
    const { deps } = makeDeps([
      callControl,
      callControl,
      { role: "assistant", content: "done" },
    ]);
    await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "hello there" }],
      tool_selection_mode: "domains",
    });
    const lines = poolLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      for (const key of Object.keys(line.obj)) {
        expect(ALLOWED_KEYS.has(key), `unexpected key ${key}`).toBe(true);
      }
      // healed_tool is the one sanctioned name; strip it and no tool name,
      // schema or description may remain anywhere in the payload.
      const { healed_tool: _healed, ...rest } = line.obj;
      const wire = JSON.stringify(rest);
      for (const banned of ["inputSchema", "parameters", "description", "function"]) {
        expect(wire).not.toContain(banned);
      }
      for (const t of POOL_TOOLS) expect(wire).not.toContain(t.name);
      for (const value of Object.values(rest)) {
        expect(typeof value === "number" || typeof value === "string").toBe(true);
      }
    }
  });
});
