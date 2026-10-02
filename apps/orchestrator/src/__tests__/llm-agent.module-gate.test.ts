/**
 * WARP-2972 — module gating reaches the chat tool pool.
 *
 * The §3 tool SCOPE narrows a person who holds an AccessRole. It is NULL for
 * the owner and for everybody with no AccessRole — every user on a box today —
 * and a null scope narrows nothing, so a switched-off module's tools reached the
 * model. The loop now applies the module verdict (tools-core's one predicate) on
 * top of the MCP client's cached `tools/list`, whatever the scope is.
 *
 * ABSENT, not empty and not erroring: the turn runs, the model is given a
 * shorter list, and a call it makes to a withheld tool by name is never
 * dispatched.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { FAIL_CLOSED_MODULE_VERDICT, type ModuleVerdict } from "@droplet/tools-core";
import { runAgent, type AgentDeps, type AgentRequest } from "../services/llm-agent.service.js";
import {
  _setToolModuleVerdictForTests,
  type ModuleVerdictResolver,
} from "../services/tool-module-verdict.service.js";
import { readPackageFile } from "./helpers/test-paths.js";

const REGISTRY = [
  { name: "list_cameras", description: "cameras", inputSchema: { type: "object" } },
  { name: "list_network_devices", description: "network", inputSchema: { type: "object" } },
  { name: "get_system_health", description: "health", inputSchema: { type: "object" } },
  { name: "email_search", description: "email", inputSchema: { type: "object" } },
  { name: "control_device", description: "control", inputSchema: { type: "object" } },
  { name: "find_dashboard_page", description: "find a page", inputSchema: { type: "object" } },
  { name: "open_dashboard_page", description: "open a page", inputSchema: { type: "object" } },
];

const NAVIGATION = ["find_dashboard_page", "open_dashboard_page"];

const withheld = (...domains: string[]): ModuleVerdict => ({ withheldDomains: new Set(domains) });

function makeDeps(script: unknown[] = []) {
  const replies = [...script];
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () =>
      replies.shift() ?? { choices: [{ message: { role: "assistant", content: "done" } }] },
  }));
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "{}" }], isError: false });
  const deps: AgentDeps = {
    mcp: { listTools: vi.fn().mockResolvedValue(REGISTRY), callTool } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

const base = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  model: "m",
  messages: [{ role: "user", content: "show me the cameras and the network" }],
  tool_selection_mode: "off",
  ...over,
});

const advertised = (chat: ReturnType<typeof vi.fn>, call = 0): string[] =>
  (chat.mock.calls[call]![0] as { tools?: { function: { name: string } }[] }).tools?.map(
    (t) => t.function.name,
  ) ?? [];

afterEach(() => {
  // Back to the suite-wide permissive default (setup.ts).
  _setToolModuleVerdictForTests(async () => withheld());
});

describe("runAgent — module verdict on the pool", () => {
  it("a null-scope caller (owner / role-less) loses a withheld domain's tools; the rest stay", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(deps, base({ toolAccessScope: null, moduleVerdict: withheld("cameras") }));
    const names = advertised(chat);
    expect(names).not.toContain("list_cameras");
    expect(names).toContain("list_network_devices");
    expect(names).toContain("get_system_health");
  });

  it("with the scope absent altogether", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(deps, base({ moduleVerdict: withheld("cameras", "email") }));
    expect(advertised(chat)).toEqual(["list_network_devices", "get_system_health", "control_device"]);
  });

  it("an explicit allowed_tools naming a withheld tool is a request, never a grant", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(
      deps,
      base({ allowed_tools: ["list_cameras", "get_system_health"], moduleVerdict: withheld("cameras") }),
    );
    expect(advertised(chat)).toEqual(["get_system_health"]);
  });

  it("a verdict that withholds nothing changes nothing", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(deps, base({ moduleVerdict: withheld() }));
    // No dashboard page list on this turn, so stage's navigation withholding
    // (WARP-3116) still applies on its own axis.
    expect(advertised(chat)).toEqual(
      REGISTRY.map((t) => t.name).filter((n) => !NAVIGATION.includes(n)),
    );
  });

  it("the turn RUNS with a shorter list: absent is not an error and not an empty pool", async () => {
    const { deps, chat } = makeDeps();
    const result = await runAgent(deps, base({ moduleVerdict: withheld("cameras", "network", "email") }));
    expect(result.message.content).toBe("done");
    expect(advertised(chat)).toEqual(["get_system_health", "control_device"]);
  });

  it("a call the model makes to a withheld tool by name is never dispatched", async () => {
    const { deps, callTool } = makeDeps([
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "list_cameras", arguments: "{}" } },
              ],
            },
          },
        ],
      },
    ]);
    await runAgent(deps, base({ moduleVerdict: withheld("cameras") }));
    expect(callTool).not.toHaveBeenCalled();
  });

  it("the same call IS dispatched when the module is on (the control)", async () => {
    const { deps, callTool } = makeDeps([
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "list_cameras", arguments: "{}" } },
              ],
            },
          },
        ],
      },
    ]);
    await runAgent(deps, base({ moduleVerdict: withheld() }));
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("tool_choice none advertises nothing and asks nobody", async () => {
    const resolver = vi.fn<ModuleVerdictResolver>(async () => withheld());
    _setToolModuleVerdictForTests(resolver);
    const { deps, chat } = makeDeps();
    await runAgent(deps, base({ tool_choice: "none" }));
    expect(advertised(chat)).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("runAgent — module gating and navigation withholding are independent axes (WARP-3116)", () => {
  it("with no page list, BOTH a withheld module's tools and the navigation tools are absent", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(deps, base({ moduleVerdict: withheld("cameras") }));
    const names = advertised(chat);
    expect(names).not.toContain("list_cameras");
    for (const n of NAVIGATION) expect(names, n).not.toContain(n);
    expect(names).toContain("list_network_devices");
  });

  it("with a page list, the navigation tools are advertised and the withheld module's still are not", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(
      deps,
      base({
        moduleVerdict: withheld("cameras"),
        toolCallContext: { dashboardPages: [{ href: "/network", label: "Network" }] },
      }),
    );
    const names = advertised(chat);
    for (const n of NAVIGATION) expect(names, n).toContain(n);
    expect(names).not.toContain("list_cameras");
  });

  it("navigation tools live in an unclaimed domain, so even the fail-closed verdict keeps them", async () => {
    _setToolModuleVerdictForTests(null);
    const { deps, chat } = makeDeps();
    await runAgent(
      deps,
      base({ toolCallContext: { dashboardPages: [{ href: "/network", label: "Network" }] } }),
    );
    for (const n of NAVIGATION) expect(advertised(chat), n).toContain(n);
  });
});

describe("runAgent — no verdict on the request (durable runs, service callers)", () => {
  it("resolves one for the acting person from the tool context", async () => {
    const resolver = vi.fn<ModuleVerdictResolver>(async () => withheld("email"));
    _setToolModuleVerdictForTests(resolver);
    const { deps, chat } = makeDeps();
    await runAgent(deps, base({ toolCallContext: { userId: "carol", userRole: "admin" } }));
    expect(resolver).toHaveBeenCalledWith("carol");
    expect(advertised(chat)).not.toContain("email_search");
    expect(advertised(chat)).toContain("list_cameras");
  });

  it("asks about the box when the request names nobody", async () => {
    const resolver = vi.fn<ModuleVerdictResolver>(async () => withheld());
    _setToolModuleVerdictForTests(resolver);
    const { deps } = makeDeps();
    await runAgent(deps, base());
    expect(resolver).toHaveBeenCalledWith(undefined);
  });

  it("an explicit verdict on the request wins and nothing is resolved", async () => {
    const resolver = vi.fn<ModuleVerdictResolver>(async () => withheld("email"));
    _setToolModuleVerdictForTests(resolver);
    const { deps, chat } = makeDeps();
    await runAgent(deps, base({ moduleVerdict: withheld("cameras") }));
    expect(resolver).not.toHaveBeenCalled();
    expect(advertised(chat)).toContain("email_search");
    expect(advertised(chat)).not.toContain("list_cameras");
  });

  it("an UNWIRED process fails closed: module-owned tools withheld, unclaimed kept", async () => {
    _setToolModuleVerdictForTests(null);
    const { deps, chat } = makeDeps();
    await runAgent(deps, base());
    expect(FAIL_CLOSED_MODULE_VERDICT.withheldDomains.has("cameras")).toBe(true);
    expect(advertised(chat)).toEqual(["get_system_health"]);
  });
});

describe("route ↔ loop: the estimate sizes the pool the loop advertises", () => {
  // The route sizes the request before the loop builds it (WARP-1118 §10). If
  // the loop drops a withheld tool and the estimate still charges for it, the
  // budget degrades persona/business blocks to make room for schemas that are
  // never sent — the WARP-2552 phantom, reopened along the module axis. Same
  // style as tool-selection.parity.test.ts: pin the shared call at each site.
  const ROUTE_SRC = readPackageFile("src", "routes/llm.ts");

  it("the estimate applies the module verdict where the loop does, after the scope", () => {
    // Mutation: `const effectiveTools = narrowToolsToScope(pooledTools, toolAccessScope);` → red.
    expect(ROUTE_SRC).toMatch(
      /withholdModuleTools\(\s*narrowToolsToScope\(pooledTools, toolAccessScope\),\s*moduleVerdict,?\s*\)/,
    );
  });

  it("both wire payloads (streaming and not) carry the SAME per-turn verdict", () => {
    // Mutation: drop `moduleVerdict,` at either site → the loop resolves its own,
    // which may differ from the one the estimate and the guidance used.
    const sites = [...ROUTE_SRC.matchAll(/toolAccessScope,\s*\/\/[^\n]*\n\s*moduleVerdict,/g)];
    expect(sites.length).toBe(2);
  });
});
