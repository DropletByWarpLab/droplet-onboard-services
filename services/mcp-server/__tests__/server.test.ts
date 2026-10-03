import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  InMemoryTransport,
} from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type TrustContext } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";
import { NO_MODULE_GATING } from "../src/module-verdict.js";

function buildDeps(): ContextDeps {
  return {
    prisma: {} as never,
    matter: {} as never,
    httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
  };
}

describe("createServer", () => {
  it("advertises serverInfo.name === 'droplet-mcp-server' via the MCP handshake", async () => {
    // Behavioral assertion using the public SDK API: connect a Client to the
    // Server through the in-memory transport pair and verify the handshake
    // exposes `serverInfo` with the expected name. This avoids leaning on
    // SDK private fields like `_serverInfo`, which can rename across
    // patch versions of @modelcontextprotocol/sdk.
    const server = createServer(buildDeps(), { kind: "local-trusted" }, { moduleVerdict: NO_MODULE_GATING });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "server-test-client", version: "0.0.1" },
      { capabilities: {} },
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const serverInfo = client.getServerVersion();
    expect(serverInfo).toBeDefined();
    expect(serverInfo!.name).toBe("droplet-mcp-server");

    await client.close();
    await server.close();
  });

  // A tool that does not exist cannot be reached by a model that has guessed
  // its name: dispatch resolves names against the registry (and the declared
  // additional tools), nothing else.
  it.each([
    ["trusted stdio", { kind: "local-trusted" } as TrustContext],
    ["an owner over HTTP", { kind: "authenticated", claims: { sub: "u-owner", role: "owner" } } as TrustContext],
  ])("refuses a tool name that is not registered, over %s", async (_label, trust) => {
    const server = createServer(buildDeps(), trust, { moduleVerdict: NO_MODULE_GATING });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "server-test-client", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("no_such_tool");
    const res = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(res.isError).toBe(true);
    const payload = JSON.parse((res.content as { text: string }[])[0]!.text) as { error?: unknown };
    expect(payload.error).toMatch(/Unknown tool: no_such_tool/);

    await client.close();
    await server.close();
  });
});
