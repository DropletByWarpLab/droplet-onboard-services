/**
 * ADR-055 (P4a) §11.5 — the doors read-only rule, on the REAL dispatch path.
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
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultToolCallInterceptor, type Tool } from "@droplet/tools-core";
import { createServer, type ServerOptions, type TrustContext } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

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
  const server = createServer(deps, trust, options);
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
