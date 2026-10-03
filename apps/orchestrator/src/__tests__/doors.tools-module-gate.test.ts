/**
 * ADR-055 P4b (WARP-3438) — the two doors tools are ABSENT from every surface
 * that lists tools unless the `doors` module is on (WARP-2972).
 *
 * `doors` is a tool domain the `doors` module claims, and WARP-2972's one
 * predicate withholds a claimed domain whose module is off for the box, or not
 * held by the acting person. This file drives that for the two real tools, with
 * the REAL module registry (`DOORS_ENABLED` and the Settings toggle decide the
 * box axis through `computeEffectiveIds`, the same set the route gate reads) and
 * the REAL §3 composition (`computeEffectiveAccess`) for the person axis:
 *
 *   - the box axis: absent when the flag is off (even with an enabling row),
 *     absent when the flag is on but the module was never switched on (it ships
 *     dark), present only when both are true;
 *   - the person axis: an owner follows the box; a role-less admin keeps the
 *     tools unless a deny exception removes them; a family or guest person never
 *     holds `doors` (the access catalog refuses their tier), so the tools are
 *     never offered to them even with the module on;
 *   - the chat pool (`runAgent`), `GET /api/llm/tools` and the catalog's
 *     `reach.module`, which ANNOTATES rather than filters;
 *   - the verdict the mcp-server is told, so `tools/list` and `tools/call` drop
 *     the same two names (the MCP protocol layer itself is driven in
 *     services/mcp-server/__tests__/doors-dispatch.test.ts).
 *
 * ABSENT, not empty and not erroring: a list without the two tools, never a
 * list that names them and refuses.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { PrismaClient, type ModuleId } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import {
  FAIL_CLOSED_MODULE_VERDICT,
  TOOL_CATALOG,
  isToolWithheldByModule,
  serializeModuleVerdict,
  type ModuleVerdict,
} from "@droplet/tools-core";

vi.mock("../middleware/auth.js", () => ({
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    const role = req.headers["x-test-role"];
    const id = req.headers["x-test-id"];
    if (typeof role === "string" && role.length > 0) {
      (req as unknown as { user?: Record<string, string> }).user = {
        id: typeof id === "string" ? id : "u-anon",
        username: typeof id === "string" ? id : "anon",
        role,
      };
    }
    next();
  },
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrMcpService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePasswordChangeGate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  setAuthPrisma: () => {},
}));

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn(),
  deleteKey: vi.fn(),
}));

// The live MCP child's list: every registered tool, as its `tools/list` returns them.
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn(async () =>
      (await import("@droplet/tools-core")).TOOL_CATALOG.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: "object" },
      })),
    ),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
  stopMcp: vi.fn().mockResolvedValue(undefined),
}));

import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";
import { runAgent, type AgentDeps, type AgentRequest } from "../services/llm-agent.service.js";
import { GATEABLE_MODULE_IDS } from "../services/access-catalog.js";
import { computeEffectiveAccess } from "../services/effective-access.service.js";
import { computeEffectiveIds } from "../services/modules.service.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";
import {
  _setToolModuleVerdictForTests,
  createModuleVerdictResolver,
} from "../services/tool-module-verdict.service.js";

const DOORS = ["doors_list", "doors_recent_events"];

/** Every other module available, so the only thing that varies is the doors flag. */
const CFG: AvailabilityConfig = {
  AI_GATEWAY_URL: "http://ai-gateway:8000",
  FILE_INDEXER_URL: "http://file-indexer:8001",
  NEXTCLOUD_URL: "http://nextcloud",
  DOCS_ENABLED: "1",
  DOCS_INTERNAL_URL: "http://docs",
  SERVICE_TOKEN_EMAIL: "tok",
  SERVICE_TOKEN_VOICE: "tok",
  FRIGATE_URL: "http://frigate:5000",
  DROPLET_MATTER_SERVICE_URL: "http://matter:8003",
  ROUTING_SERVICE_URL: "http://routing:8004",
  SWITCH_SERVICE_URL: "http://switch:8005",
  DOORS_ENABLED: "0",
};
const FLAG_ON: AvailabilityConfig = { ...CFG, DOORS_ENABLED: "1" };

/** The box's effective modules: the flag decides availability, the Settings row decides enablement (doors ships OFF). */
function boxWith(cfg: AvailabilityConfig, doorsRow: boolean | "none"): Set<ModuleId> {
  return computeEffectiveIds(new Map<ModuleId, boolean>(doorsRow === "none" ? [] : [["doors", doorsRow]]), cfg);
}

type Person = { role: "owner" | "admin" | "family" | "guest"; deny?: ModuleId[] };

/** The shipped resolver over an in-memory directory: real verdict resolver, real §3 composition. */
function resolverFor(box: Set<ModuleId>, people: Record<string, Person> = {}) {
  return createModuleVerdictResolver({
    prisma: {
      user: {
        findMany: vi.fn(async ({ where }: { where: { OR: Array<Record<string, string>> } }) => {
          const wanted = new Set(where.OR.flatMap((c) => Object.values(c)));
          return Object.entries(people)
            .filter(([id]) => wanted.has(id))
            .map(([id, p]) => ({
              id,
              username: id,
              role: p.role,
              displayName: id,
              email: null,
              directoryStatus: "ACTIVE",
            }));
        }),
      },
    } as never,
    boxModuleIds: async () => box,
    personModuleIds: async (userId) => {
      const p = people[userId];
      if (!p) return null;
      return new Set(
        computeEffectiveAccess({
          user: { id: userId, role: p.role, accessRole: null },
          exceptions: (p.deny ?? []).map((moduleId, i) => ({
            id: `x${i}`,
            moduleId,
            effect: "deny" as const,
            level: null,
          })),
          workspaceModuleIds: box,
          cloudEscapeEnabled: false,
          connections: [],
          usagePolicy: null,
          deptRights: [],
        }).features.map((f) => f.moduleId),
      );
    },
  });
}

const bind = (box: Set<ModuleId>, people?: Record<string, Person>) =>
  _setToolModuleVerdictForTests(resolverFor(box, people));

const PEOPLE: Record<string, Person> = {
  olive: { role: "owner" },
  ada: { role: "admin" },
  carol: { role: "admin", deny: ["doors"] },
  fay: { role: "family" },
  gus: { role: "guest" },
};

afterEach(() => _setToolModuleVerdictForTests(async () => ({ withheldDomains: new Set() })));

describe("the fixtures name the two real tools, in the domain the module claims", () => {
  it("doors_list and doors_recent_events are the doors domain, and the module claims it", () => {
    for (const name of DOORS) expect(TOOL_CATALOG.find((t) => t.name === name)?.domain, name).toBe("doors");
    expect(GATEABLE_MODULE_IDS).toContain("doors");
  });
});

describe("the BOX axis: the flag and the Settings toggle, through the real registry", () => {
  const withheldFor = async (box: Set<ModuleId>) => (await resolverFor(box)(null)).withheldDomains.has("doors");

  it("DOORS_ENABLED off: absent, even when a Settings row says enabled (an unavailable module cannot be switched on)", async () => {
    expect(await withheldFor(boxWith(CFG, "none"))).toBe(true);
    expect(await withheldFor(boxWith(CFG, true))).toBe(true);
    expect(await withheldFor(boxWith({ ...CFG, DOORS_ENABLED: "" }, true))).toBe(true);
  });

  it("flag on but never switched on: still absent — the module ships dark", async () => {
    expect(await withheldFor(boxWith(FLAG_ON, "none"))).toBe(true);
    expect(await withheldFor(boxWith(FLAG_ON, false))).toBe(true);
  });

  it("flag on and switched on: present", async () => {
    expect(await withheldFor(boxWith(FLAG_ON, true))).toBe(false);
  });

  it("the tool predicate agrees, for both tools, and keeps every other tool", async () => {
    const off = await resolverFor(boxWith(CFG, "none"))(null);
    for (const name of DOORS) expect(isToolWithheldByModule(name, off), name).toBe(true);
    expect(isToolWithheldByModule("list_network_devices", off)).toBe(false);
    const on = await resolverFor(boxWith(FLAG_ON, true))(null);
    for (const name of DOORS) expect(isToolWithheldByModule(name, on), name).toBe(false);
  });

  it("the verdict the mcp-server is told carries `doors` while the module is off, and not once it is on", async () => {
    const off = serializeModuleVerdict(await resolverFor(boxWith(CFG, "none"))(null));
    expect(off.withheldDomains).toContain("doors");
    const on = serializeModuleVerdict(await resolverFor(boxWith(FLAG_ON, true))(null));
    expect(on.withheldDomains).not.toContain("doors");
  });

  it("a verdict that cannot be had fails closed with `doors` withheld", () => {
    expect(FAIL_CLOSED_MODULE_VERDICT.withheldDomains.has("doors")).toBe(true);
  });
});

describe("the PERSON axis: the real §3 composition", () => {
  const box = boxWith(FLAG_ON, true);
  const doorsWithheldFor = async (who: string) => (await resolverFor(box, PEOPLE)(who)).withheldDomains.has("doors");

  it("the owner follows the box: present when the module is on, absent when it is not", async () => {
    expect(await doorsWithheldFor("olive")).toBe(false);
    expect((await resolverFor(boxWith(CFG, "none"), PEOPLE)("olive")).withheldDomains.has("doors")).toBe(true);
  });

  it("a role-less admin keeps the tools; a deny exception on doors removes them for that person alone", async () => {
    expect(await doorsWithheldFor("ada")).toBe(false);
    expect(await doorsWithheldFor("carol")).toBe(true);
    expect(await doorsWithheldFor("olive")).toBe(false);
  });

  it("a family or guest person is never offered the tools, even with the module on: the catalog refuses their tier", async () => {
    expect(await doorsWithheldFor("fay")).toBe(true);
    expect(await doorsWithheldFor("gus")).toBe(true);
  });

  it("an unknown person fails closed (nobody attributable): the tools are withheld", async () => {
    expect(await doorsWithheldFor("ghost")).toBe(true);
  });
});

describe("the chat pool (runAgent): absent when off, present when on, never dispatched when withheld", () => {
  const REGISTRY = [
    { name: "doors_list", description: "doors", inputSchema: { type: "object" } },
    { name: "doors_recent_events", description: "events", inputSchema: { type: "object" } },
    { name: "list_network_devices", description: "network", inputSchema: { type: "object" } },
    { name: "get_system_health", description: "health", inputSchema: { type: "object" } },
  ];

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
    messages: [{ role: "user", content: "which doors are open?" }],
    tool_selection_mode: "off",
    ...over,
  });

  const advertised = (chat: ReturnType<typeof vi.fn>, call = 0): string[] =>
    (chat.mock.calls[call]![0] as { tools?: { function: { name: string } }[] }).tools?.map((t) => t.function.name) ?? [];

  it("module off: both tools are gone from the pool for a null-scope caller (owner or role-less), the rest stay", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(deps, base({ toolAccessScope: null, moduleVerdict: withheld("doors") }));
    expect(advertised(chat)).toEqual(["list_network_devices", "get_system_health"]);
  });

  it("module on: both are in the pool", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(deps, base({ toolAccessScope: null, moduleVerdict: withheld() }));
    expect(advertised(chat)).toEqual(["doors_list", "doors_recent_events", "list_network_devices", "get_system_health"]);
  });

  it("a verdict resolved from the real registry drives it when the caller passes none (a run with no chat route)", async () => {
    const { deps, chat } = makeDeps();
    bind(boxWith(CFG, "none"), PEOPLE);
    await runAgent(deps, base({ toolCallContext: { userId: "olive" } as never }));
    expect(advertised(chat)).toEqual(["list_network_devices", "get_system_health"]);
    const again = makeDeps();
    bind(boxWith(FLAG_ON, true), PEOPLE);
    await runAgent(again.deps, base({ toolCallContext: { userId: "olive" } as never }));
    expect(advertised(again.chat)).toContain("doors_list");
  });

  it("a call the model makes to doors_list by name while the module is off is never dispatched", async () => {
    const { deps, callTool } = makeDeps([
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "c1", type: "function", function: { name: "doors_list", arguments: "{}" } }],
            },
          },
        ],
      },
    ]);
    await runAgent(deps, base({ moduleVerdict: withheld("doors") }));
    expect(callTool).not.toHaveBeenCalled();
  });

  it("an explicit allowed_tools naming a doors tool is a request, never a grant", async () => {
    const { deps, chat } = makeDeps();
    await runAgent(deps, base({ allowed_tools: ["doors_list", "get_system_health"], moduleVerdict: withheld("doors") }));
    expect(advertised(chat)).toEqual(["get_system_health"]);
  });
});

describe("GET /api/llm/tools and the catalog's reach.module", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => bind(boxWith(FLAG_ON, true), PEOPLE));

  async function toolsFor(role: string, id?: string): Promise<string[]> {
    const req = request(app).get("/api/llm/tools").set("x-test-role", role);
    const res = await (id ? req.set("x-test-id", id) : req);
    expect(res.status).toBe(200);
    return (res.body.tools as { name: string }[]).map((t) => t.name);
  }

  it("module on: the owner and an admin are offered both tools", async () => {
    for (const [role, id] of [["owner", "olive"], ["admin", "ada"]] as const) {
      const names = await toolsFor(role, id);
      for (const name of DOORS) expect(names, `${role}/${name}`).toContain(name);
    }
  });

  it("module on: a family or guest person is not offered them (the catalog refuses the tier), and an admin with a deny exception is not either", async () => {
    for (const [role, id] of [["family", "fay"], ["guest", "gus"], ["admin", "carol"]] as const) {
      const names = await toolsFor(role, id);
      for (const name of DOORS) expect(names, `${id}/${name}`).not.toContain(name);
      expect(names, id).toContain("list_network_devices");
    }
  });

  it.each([
    ["the flag is off", boxWith(CFG, "none")],
    ["the flag is off even with an enabling row", boxWith(CFG, true)],
    ["the flag is on but the module was never switched on", boxWith(FLAG_ON, "none")],
  ])("module off (%s): the OWNER is not offered either tool, and the rest of the list is untouched", async (_label, box) => {
    bind(box, PEOPLE);
    const names = await toolsFor("owner", "olive");
    for (const name of DOORS) expect(names, name).not.toContain(name);
    expect(names).toContain("list_network_devices");
    expect(names.length).toBeGreaterThan(50);
  });

  it("a caller with no principal id is the box", async () => {
    bind(boxWith(CFG, "none"), PEOPLE);
    const names = await toolsFor("owner");
    for (const name of DOORS) expect(names, name).not.toContain(name);
  });

  it("an unwired process fails closed: no doors tools, still a 200 list", async () => {
    _setToolModuleVerdictForTests(null);
    const names = await toolsFor("owner", "olive");
    for (const name of DOORS) expect(names, name).not.toContain(name);
    expect(names.length).toBeGreaterThan(0);
  });

  it("the catalog ANNOTATES rather than filters: the doors tools stay listed with reach.module withheld while off, allowed when on", async () => {
    const reach = async () => {
      const res = await request(app).get("/api/llm/tools/catalog").set("x-test-role", "owner").set("x-test-id", "olive");
      expect(res.status).toBe(200);
      const tools = res.body.tools as { name: string; reach: { module: string; chat: string } }[];
      return Object.fromEntries(DOORS.map((n) => [n, tools.find((t) => t.name === n)?.reach]));
    };
    bind(boxWith(CFG, "none"), PEOPLE);
    const off = await reach();
    for (const name of DOORS) {
      expect(off[name], name).toBeDefined();
      expect(off[name]!.module, name).toBe("withheld");
      // …and the chat axis no longer excludes them: the module gate is what holds them back.
      expect(off[name]!.chat, name).toBe("allowed");
    }
    bind(boxWith(FLAG_ON, true), PEOPLE);
    const on = await reach();
    for (const name of DOORS) expect(on[name]!.module, name).toBe("allowed");
  });
});
