/**
 * ADR-055 (P4b) §11.5 — the doors read-only rule, on the REAL dispatch path.
 *
 * `services/mcp-server/src/server.ts` is the only site in the repo that calls
 * `tool.handler(...)`, and every dispatch path reaches it: the in-process agent
 * loop, ToolSpec runs and external MCP clients over HTTP. So this is where
 * "an unlock tool cannot be reached by a model that has guessed its name" is
 * proved: a synthetic `doors_unlock` (the kind of tool a remote server or a
 * later change could introduce) is driven through the real
 * `CallToolRequestSchema` handler, over the SDK's in-memory transport, as the
 * trusted stdio principal AND as an owner over HTTP.
 *
 * Asserted with a handler spy, not just on the response: a refused call must
 * never reach handler code.
 *
 * And the module gate (WARP-2972), for the two real tools: `doors` is a tool
 * domain the `doors` module claims, so with the module off or absent both tools
 * are ABSENT from an external client's `tools/list` and refused by `tools/call`
 * on both transports, before their handler runs; with it on they are listed and
 * served. A server built with no verdict source FAILS CLOSED, doors included.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultToolCallInterceptor, MODULE_OWNED_TOOL_DOMAINS, type ModuleVerdict, type Tool } from "@droplet/tools-core";
import { createServer, type ServerOptions, type TrustContext } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";
import { NO_MODULE_GATING, type ModuleVerdictSource } from "../src/module-verdict.js";

function buildDeps(get = vi.fn()): ContextDeps {
  return {
    prisma: {} as never,
    matter: {} as never,
    httpFactory: () => ({ get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
  };
}

function syntheticDoorsTool(over: Partial<Tool> = {}) {
  const invoked: Record<string, unknown>[] = [];
  const tool: Tool = {
    name: "doors_unlock",
    description: "Unlock a door.",
    inputSchema: {
      type: "object",
      properties: { door_id: { type: "string" } },
      required: ["door_id"],
      additionalProperties: false,
    },
    requiresWrite: true,
    requiresConfirmation: true,
    handler: async (args) => {
      invoked.push(args);
      return { ok: true, data: { unlocked: args.door_id } };
    },
    ...over,
  };
  return { tool, invoked };
}

async function connect(trust: TrustContext, options: ServerOptions, deps = buildDeps()) {
  // The dispatch cases below are about the interceptor, not the module gate:
  // they opt out of gating explicitly (a server with no verdict source fails
  // closed). The module-gate cases at the bottom pass a real verdict.
  const server = createServer(deps, trust, { moduleVerdict: NO_MODULE_GATING, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "doors-dispatch-test", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function parse(res: unknown): Record<string, unknown> {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

const OWNER_OVER_HTTP: TrustContext = {
  kind: "authenticated",
  claims: { sub: "u-owner", role: "owner" } as never,
};
const TRUSTED_STDIO: TrustContext = { kind: "local-trusted" };

describe.each([
  ["trusted stdio (the in-process agent loop)", TRUSTED_STDIO],
  ["an owner over HTTP", OWNER_OVER_HTTP],
])("a writing doors_ tool arriving at dispatch — %s", (_label, trust) => {
  afterEach(() => {
    defaultToolCallInterceptor.denyTier.clear();
  });

  it("is refused, and its handler is never invoked", async () => {
    const { tool, invoked } = syntheticDoorsTool();
    const { client, close } = await connect(trust, { additionalTools: new Map([[tool.name, tool]]) });

    const res = await client.callTool({ name: "doors_unlock", arguments: { door_id: "d1" } });
    const payload = parse(res);

    expect(payload.status).toBe("error");
    expect((payload.error as { code: string }).code).toBe("TOOL_DENIED");
    expect(
      ((payload.error as { details: { interceptor: { reason: string } } }).details.interceptor).reason,
    ).toBe("read_only_namespace");
    expect(invoked).toEqual([]);
    await close();
  });

  it("stays refused with the confirmation flow: the model cannot approve its own way to an unlock", async () => {
    const { tool, invoked } = syntheticDoorsTool();
    const { client, close } = await connect(trust, { additionalTools: new Map([[tool.name, tool]]) });
    const args = { door_id: "d1" };

    // A token minted for the exact call — what a leaked one would look like.
    const minted = defaultToolCallInterceptor.tokens.mint(tool.name, args, Date.now());
    const res = await client.callTool({
      name: tool.name,
      arguments: args,
      _meta: { confirmationToken: minted.token },
    });
    expect((parse(res).error as { code: string }).code).toBe("TOOL_DENIED");
    expect(invoked).toEqual([]);
    await close();
  });

  it("is refused even when it declares itself a plain read-flag-less tool (undeclared is not read-only)", async () => {
    const { tool, invoked } = syntheticDoorsTool({
      requiresConfirmation: false,
      requiresWrite: undefined as never,
    });
    const { client, close } = await connect(trust, { additionalTools: new Map([[tool.name, tool]]) });
    const res = await client.callTool({ name: tool.name, arguments: { door_id: "d1" } });
    expect((parse(res).error as { code: string }).code).toBe("TOOL_DENIED");
    expect(invoked).toEqual([]);
    await close();
  });

  it("is refused after the runtime deny tier has been emptied", async () => {
    defaultToolCallInterceptor.denyTier.clear();
    const { tool, invoked } = syntheticDoorsTool();
    const { client, close } = await connect(trust, { additionalTools: new Map([[tool.name, tool]]) });
    const res = await client.callTool({ name: tool.name, arguments: { door_id: "d1" } });
    expect((parse(res).error as { code: string }).code).toBe("TOOL_DENIED");
    expect(invoked).toEqual([]);
    await close();
  });
});

describe("the real doors tools still dispatch", () => {
  it("doors_list reaches its handler and reads GET /api/doors — and nothing else", async () => {
    const get = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ doors: [] }) }));
    const deps = buildDeps(get as never);
    const { client, close } = await connect(TRUSTED_STDIO, {}, deps);
    const res = await client.callTool({ name: "doors_list", arguments: {} });
    const payload = parse(res);
    expect((res as { isError?: boolean }).isError).toBe(false);
    expect(payload.count).toBe(0);
    expect(get).toHaveBeenCalledTimes(1);
    expect((get.mock.calls[0] as unknown as [string])[0]).toBe("/api/doors");
    await close();
  });

  it("there is no doors tool for a model to call by name that writes: the advertised set is the two reads", async () => {
    const { client, close } = await connect(TRUSTED_STDIO, {});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).filter((n) => n.startsWith("doors_")).sort()).toEqual([
      "doors_list",
      "doors_recent_events",
    ]);
    const unknown = await client.callTool({ name: "doors_unlock", arguments: { door_id: "d1" } });
    expect(parse(unknown).error).toMatch(/Unknown tool/);
    await close();
  });
});

// ── the module gate (WARP-2972) over the two real tools ─────────────────────

const withheld = (...domains: string[]): ModuleVerdict => ({ withheldDomains: new Set(domains) });
const DOORS_OFF: ModuleVerdictSource = async () => withheld("doors");
const DOORS_ON: ModuleVerdictSource = async () => withheld();
const DOORS_TOOLS = ["doors_list", "doors_recent_events"];

const adminOverHttp = (sub = "u-admin"): TrustContext => ({
  kind: "authenticated",
  claims: { sub, role: "admin" } as never,
});

function errorCodeOf(res: unknown): string | undefined {
  return (parse(res).error as { code?: string } | undefined)?.code;
}

function recordingDeps() {
  const get = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ doors: [], events: [], nextCursor: null }) }));
  return { get, deps: buildDeps(get as never) };
}

describe("the doors module is off or absent: the tools are absent from MCP", () => {
  it("tools/list over HTTP (an external client) drops both doors tools and keeps the rest", async () => {
    const { client, close } = await connect(adminOverHttp(), { moduleVerdict: DOORS_OFF });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of DOORS_TOOLS) expect(names, name).not.toContain(name);
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain("get_network_status");
    await close();
  });

  it.each([
    ["an admin over HTTP", adminOverHttp()],
    ["an owner over HTTP", OWNER_OVER_HTTP],
    ["trusted stdio (the in-process agent loop)", TRUSTED_STDIO],
  ])("tools/call refuses both tools for %s BEFORE their handler runs, as `module_disabled`", async (_label, trust) => {
    const { get, deps } = recordingDeps();
    const { client, close } = await connect(trust, { moduleVerdict: DOORS_OFF }, deps);
    for (const name of DOORS_TOOLS) {
      const res = await client.callTool({ name, arguments: {} });
      expect((res as { isError?: boolean }).isError, name).toBe(true);
      expect(errorCodeOf(res), name).toBe("module_disabled");
    }
    expect(get).not.toHaveBeenCalled();
    await close();
  });

  it("is per person: the verdict is asked of the JWT subject, so one person's doors can be off while another's are on", async () => {
    const perPerson: ModuleVerdictSource = async (who) => (who === "u-carol" ? withheld("doors") : withheld());
    const carol = await connect(adminOverHttp("u-carol"), { moduleVerdict: perPerson });
    const dave = await connect(adminOverHttp("u-dave"), { moduleVerdict: perPerson });
    expect((await carol.client.listTools()).tools.map((t) => t.name)).not.toContain("doors_list");
    expect((await dave.client.listTools()).tools.map((t) => t.name)).toContain("doors_list");
    await carol.close();
    await dave.close();
  });

  it("a server built with NO verdict source fails closed: doors is a module-owned domain, so both tools are withheld", async () => {
    expect(MODULE_OWNED_TOOL_DOMAINS.has("doors")).toBe(true);
    const { get, deps } = recordingDeps();
    // `moduleVerdict` deliberately left out: the default is the fail-closed source.
    const server = createServer(deps, adminOverHttp());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "doors-fail-closed", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of DOORS_TOOLS) expect(names, name).not.toContain(name);
    const res = await client.callTool({ name: "doors_list", arguments: {} });
    expect(errorCodeOf(res)).toBe("module_disabled");
    expect(get).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });
});

describe("the doors module is on: the tools are listed and served", () => {
  it("tools/list over HTTP carries both", async () => {
    const { client, close } = await connect(adminOverHttp(), { moduleVerdict: DOORS_ON });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of DOORS_TOOLS) expect(names, name).toContain(name);
    await close();
  });

  it.each([
    ["an admin over HTTP", adminOverHttp()],
    ["trusted stdio (the in-process agent loop)", TRUSTED_STDIO],
  ])("tools/call reaches the read-only handlers for %s: GET /api/doors and GET /api/doors/events, nothing else", async (_label, trust) => {
    const { get, deps } = recordingDeps();
    const { client, close } = await connect(trust, { moduleVerdict: DOORS_ON }, deps);
    expect((await client.callTool({ name: "doors_list", arguments: {} }) as { isError?: boolean }).isError).toBe(false);
    expect((await client.callTool({ name: "doors_recent_events", arguments: { limit: 5 } }) as { isError?: boolean }).isError).toBe(false);
    expect(get.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["/api/doors", "/api/doors/events?limit=5"]);
    await close();
  });
});
