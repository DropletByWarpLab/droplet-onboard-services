/**
 * searchHybrid wiring — verifies that ContextDeps.searchHybrid surfaces
 * in `ToolContext.searchHybrid` (with userId bound) and is callable
 * from the `search_content` tool handler.
 *
 * Was: embedText wiring (pre-WARP-286). After WARP-286 the
 * `search_content` tool delegates entirely to `ctx.searchHybrid`, so
 * what we now wire is the hybrid retrieval shim. embedText still lives
 * on ToolContext but the search tool no longer touches it directly.
 */

import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

function buildDeps(
  searchHybrid?: ContextDeps["searchHybrid"],
): ContextDeps {
  return {
    prisma: {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    } as never,
    matter: {} as never,
    httpFactory: () => ({
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    }),
    searchHybrid,
  };
}

describe("searchHybrid wiring (MCP server stdio path)", () => {
  it("AUTH_REQUIRED short-circuits before ctx.searchHybrid is called", async () => {
    const searchSpy = vi.fn().mockResolvedValue([]);
    const deps = buildDeps(searchSpy);

    // Trusted stdio posture, but no _meta.userId → no userId →
    // search_content returns AUTH_REQUIRED (WARP-563).
    const server = createServer(deps, { kind: "local-trusted" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "search-wiring-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const res = await client.callTool(
      { name: "search_content", arguments: { query: "hello world" } },
      undefined,
      { timeout: 5000 },
    );

    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("AUTH_REQUIRED");
    // Wiring guarantee: hybrid retrieval is gated by auth — never
    // invoked without a userId.
    expect(searchSpy).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });

  it("searchHybrid spy is invoked with bound userId when authed", async () => {
    const searchSpy = vi.fn().mockResolvedValue([]);
    const deps = buildDeps(searchSpy);
    const server = createServer(deps, { kind: "authenticated", claims: { sub: "u1", role: "owner" } });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "search-wiring-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const res = await client.callTool(
      { name: "search_content", arguments: { query: "alphahotel" } },
      undefined,
      { timeout: 5000 },
    );

    expect(res.isError).toBe(false);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    // WARP-286: userId is bound at context build time; the handler
    // only passes { query, limit }.
    expect(searchSpy).toHaveBeenCalledWith({
      userId: "u1",
      query: "alphahotel",
      limit: 10,
    });

    await client.close();
    await server.close();
  });

  it("when ctx.searchHybrid is undefined, search_content surfaces SEARCH_UNAVAILABLE", async () => {
    const deps = buildDeps(undefined);
    const server = createServer(deps, { kind: "authenticated", claims: { sub: "u1", role: "owner" } });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "search-wiring-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const res = await client.callTool(
      { name: "search_content", arguments: { query: "alphahotel" } },
      undefined,
      { timeout: 5000 },
    );

    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("SEARCH_UNAVAILABLE");

    await client.close();
    await server.close();
  });

  it("when ctx.searchHybrid throws, search_content surfaces SEARCH_FAILED", async () => {
    const searchSpy = vi
      .fn()
      .mockRejectedValue(new Error("UNAVAILABLE: ai-gateway"));
    const deps = buildDeps(searchSpy);
    const server = createServer(deps, { kind: "authenticated", claims: { sub: "u1", role: "owner" } });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "search-wiring-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const res = await client.callTool(
      { name: "search_content", arguments: { query: "alphahotel" } },
      undefined,
      { timeout: 5000 },
    );

    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("SEARCH_FAILED");
    expect(searchSpy).toHaveBeenCalledOnce();

    await client.close();
    await server.close();
  });
});
