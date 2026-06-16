import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  InMemoryTransport,
} from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

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
    const server = createServer(buildDeps(), { kind: "local-trusted" });

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
});
