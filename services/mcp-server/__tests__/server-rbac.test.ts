import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type TrustContext } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

/**
 * RBAC at the MCP-protocol layer (not the helper layer that
 * `__tests__/rbac.test.ts` already covers). Drives a real Client/Server
 * pair through `InMemoryTransport` and checks that:
 *   - tools/list is filtered by role
 *   - tools/call refuses write tools for unprivileged roles with
 *     `forbidden_tool_for_role`
 *   - undefined role (stdio in-proc) sees and can call everything
 */
function buildDeps(): ContextDeps {
  return {
    prisma: {} as never,
    matter: {} as never,
    httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
  };
}

async function connectClient(role: "admin" | "family" | "guest" | undefined) {
  // role === undefined models the trusted stdio in-proc principal;
  // a concrete role models an authenticated HTTP caller (WARP-563).
  const trust: TrustContext =
    role === undefined
      ? { kind: "local-trusted" }
      : { kind: "authenticated", claims: { sub: `u-${role}`, role } };
  const server = createServer(buildDeps(), trust);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rbac-test", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

describe("server-level RBAC", () => {
  it("admin role sees write tools (e.g. block_network_device) in tools/list", async () => {
    const { client, server } = await connectClient("admin");
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).toContain("block_network_device");
    await client.close();
    await server.close();
  });

  it("family role does NOT see write tools in tools/list", async () => {
    const { client, server } = await connectClient("family");
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).not.toContain("block_network_device");
    expect(names).not.toContain("write_file");
    await client.close();
    await server.close();
  });

  it("guest role does NOT see write tools in tools/list", async () => {
    const { client, server } = await connectClient("guest");
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).not.toContain("block_network_device");
    await client.close();
    await server.close();
  });

  it("undefined role (stdio in-proc) sees every tool", async () => {
    const { client, server } = await connectClient(undefined);
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).toContain("block_network_device");
    expect(names.length).toBeGreaterThanOrEqual(50);
    await client.close();
    await server.close();
  });

  // WARP-103 reviewer follow-up: an HTTP request whose JWT has no role
  // claim still arrives at createServer with `claims = {sub, role:
  // undefined}` (NOT `claims = undefined`). That must NOT be treated as
  // the trusted-stdio principal — it gets read-only access.
  it("HTTP-shaped claims with role: undefined sees read-only tools, not writes", async () => {
    const server = createServer(buildDeps(), {
      kind: "authenticated",
      claims: { sub: "u-no-role", role: undefined },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "rbac-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).not.toContain("block_network_device");
    expect(names).not.toContain("write_file");
    await client.close();
    await server.close();
  });

  it("HTTP-shaped claims with role: undefined gets forbidden_tool_for_role on a write call", async () => {
    const server = createServer(buildDeps(), {
      kind: "authenticated",
      claims: { sub: "u-no-role", role: undefined },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "rbac-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const res = await client.callTool({
      name: "block_network_device",
      arguments: { mac: "AA:BB:CC:DD:EE:FF" },
    });
    expect(res.isError).toBe(true);
    const blocks = res.content as { type: string; text: string }[];
    const parsed = JSON.parse(blocks[0].text);
    expect(parsed.error.code).toBe("forbidden_tool_for_role");
    await client.close();
    await server.close();
  });

  it("family role calling a write tool gets forbidden_tool_for_role with isError=true", async () => {
    const { client, server } = await connectClient("family");
    const res = await client.callTool({
      name: "block_network_device",
      arguments: { mac: "AA:BB:CC:DD:EE:FF" },
    });
    expect(res.isError).toBe(true);
    const blocks = res.content as { type: string; text: string }[];
    const parsed = JSON.parse(blocks[0].text);
    expect(parsed.error.code).toBe("forbidden_tool_for_role");
    await client.close();
    await server.close();
  });

  it("family role can call a read tool", async () => {
    const { client, server } = await connectClient("family");
    // We don't care what the handler returns — just that RBAC didn't refuse.
    // The handler will fail on the empty deps stub, but the failure shape
    // must NOT be `forbidden_tool_for_role`.
    const res = await client.callTool({ name: "list_network_devices", arguments: {} });
    if (res.isError) {
      const blocks = res.content as { type: string; text: string }[];
      const parsed = JSON.parse(blocks[0].text);
      expect(parsed.error.code).not.toBe("forbidden_tool_for_role");
    }
    await client.close();
    await server.close();
  });
});
