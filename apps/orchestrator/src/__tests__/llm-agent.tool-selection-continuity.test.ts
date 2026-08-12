/**
 * WARP-1921 — cross-turn continuity for agent-budgets §3 tool selection.
 *
 * These assert on the `tools[]` array the ai-gateway actually receives —
 * the only thing that decides what the model can call — rather than on the
 * selection helper in isolation.
 *
 * THE BUG THIS CLOSES. The §3 continuity rule ("domains of tools already
 * called stay advertised") read `tool_calls` off replayed assistant
 * messages. `chatRequestSchema` declares only `{role, content,
 * tool_call_id}`, so zod stripped that field from every replayed turn and
 * continuity only ever worked WITHIN one turn's iterations. The spec's §6
 * outcome named this as the prerequisite holding `TOOL_SELECTION_MODE` at
 * "off". The route now reads the names from the persisted trace and passes
 * them as `prior_tool_names`.
 *
 * The scenario, which is the ordinary way people talk:
 *
 *     turn 1  "show me the driveway camera"     → matches `cameras`
 *     turn 2  "rename it to Side Gate"          → matches NOTHING
 *
 * Without continuity, turn 2 advertises core-only and the rename is
 * impossible until a self-heal iteration recovers it.
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

/** A pool spanning two domains + the core set, shaped like listTools(). */
const POOL = [
  { name: "search_content", description: "d", inputSchema: { type: "object", properties: {} } },
  { name: "read_file", description: "d", inputSchema: { type: "object", properties: {} } },
  { name: "list_files", description: "d", inputSchema: { type: "object", properties: {} } },
  { name: "memory_recall", description: "d", inputSchema: { type: "object", properties: {} } },
  { name: "list_cameras", description: "d", inputSchema: { type: "object", properties: {} } },
  { name: "list_camera_events", description: "d", inputSchema: { type: "object", properties: {} } },
  { name: "control_device", description: "d", inputSchema: { type: "object", properties: {} } },
];

function deps() {
  const chat = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
  });
  return {
    chat,
    deps: {
      mcp: { listTools: vi.fn().mockResolvedValue(POOL), callTool: vi.fn() },
      aiGateway: { chat },
    } as unknown as AgentDeps,
  };
}

function advertised(chat: ReturnType<typeof vi.fn>): string[] {
  const req = chat.mock.calls[0]![0] as {
    tools?: { function: { name: string } }[];
  };
  return (req.tools ?? []).map((t) => t.function.name);
}

/**
 * Turn 2: a follow-up carrying no domain keyword whatsoever.
 *
 * Deliberately NOT the obvious "rename it to Side Gate": WARP-1921 added
 * `gate` to the camera vocabulary, so that sentence matches the cameras
 * domain on its own and would make the continuity assertions below pass for
 * the wrong reason. The control test guards exactly this — if a future rule
 * widening swallows this phrase too, the control goes red and tells you.
 */
const FOLLOW_UP = "rename it to Blue Spruce";

describe("WARP-1921 — §3 selection continuity across turns", () => {
  it("a follow-up with NO domain keyword still advertises the prior turn's domain", async () => {
    const { deps: d, chat } = deps();
    await runAgent(d, {
      model: "m",
      messages: [{ role: "user", content: FOLLOW_UP }],
      tool_selection_mode: "domains",
      // What the route now reads out of the persisted trace.
      prior_tool_names: ["list_cameras"],
    } as never);

    const names = advertised(chat);
    expect(names).toContain("list_camera_events");
    expect(names).toContain("list_cameras");
  });

  it("WITHOUT prior_tool_names the same turn loses the camera tools", async () => {
    // The control. If this ever passes, the assertion above proves nothing —
    // it would mean the domain was advertised for some unrelated reason.
    const { deps: d, chat } = deps();
    await runAgent(d, {
      model: "m",
      messages: [{ role: "user", content: FOLLOW_UP }],
      tool_selection_mode: "domains",
    } as never);

    const names = advertised(chat);
    expect(names).not.toContain("list_camera_events");
    expect(names).not.toContain("list_cameras");
    // Core survives — this is narrowing, not emptying.
    expect(names).toContain("search_content");
  });

  it("still honours WITHIN-turn tool_calls (prior_tool_names is additive, not a replacement)", async () => {
    // Within a turn the loop pushes the model's raw message with tool_calls
    // intact, and those calls are not persisted until the turn finalizes —
    // so this source has to keep working independently.
    const { deps: d, chat } = deps();
    await runAgent(d, {
      model: "m",
      messages: [
        { role: "user", content: FOLLOW_UP },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "list_cameras", arguments: "{}" } }],
        },
      ],
      tool_selection_mode: "domains",
    } as never);

    expect(advertised(chat)).toContain("list_camera_events");
  });

  it("continuity can never widen past the caller's pool", async () => {
    // The load-bearing invariant: selection only ever SUBSETS the
    // RBAC-narrowed pool. A prior turn naming a tool the caller may no
    // longer use must not resurrect it.
    const { deps: d, chat } = deps();
    await runAgent(d, {
      model: "m",
      messages: [{ role: "user", content: FOLLOW_UP }],
      tool_selection_mode: "domains",
      allowed_tools: ["search_content", "read_file"],
      prior_tool_names: ["list_cameras", "control_device"],
    } as never);

    expect(advertised(chat).sort()).toEqual(["read_file", "search_content"]);
  });

  it("mode off ignores prior_tool_names entirely (full-pool rollback)", async () => {
    const { deps: d, chat } = deps();
    await runAgent(d, {
      model: "m",
      messages: [{ role: "user", content: FOLLOW_UP }],
      tool_selection_mode: "off",
      prior_tool_names: ["list_cameras"],
    } as never);

    expect(advertised(chat)).toHaveLength(POOL.length);
  });
});
