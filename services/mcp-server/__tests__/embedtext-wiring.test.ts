/**
 * embedText wiring — verifies that ContextDeps.embedText surfaces in
 * `ToolContext.embedText` and is callable from a tool handler.
 *
 * The `search_content` tool calls `ctx.embedText([query])` to vectorize
 * the input. By driving it through the in-memory MCP transport with a
 * mocked Prisma + embed spy, we assert the wiring without standing up
 * the full ai-gateway gRPC channel.
 */

import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

function buildDeps(
  embedText: (texts: string[]) => Promise<number[][]>,
  // search_content runs `prisma.$queryRawUnsafe` — minimal stub returning
  // an empty result set keeps the tool path deterministic.
  prismaQueryResult: unknown[] = [],
): ContextDeps {
  return {
    prisma: {
      $queryRawUnsafe: vi.fn().mockResolvedValue(prismaQueryResult),
    } as never,
    matter: {} as never,
    httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
    embedText,
  };
}

describe("embedText wiring (MCP server stdio path)", () => {
  it("AUTH_REQUIRED short-circuits before ctx.embedText is called", async () => {
    const embedSpy = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
    const deps = buildDeps(embedSpy);

    // No claims → no userId → search_content returns AUTH_REQUIRED.
    const server = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "embed-wiring-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "hello world" },
    }, undefined, { timeout: 5000 });

    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("AUTH_REQUIRED");
    // The wiring guarantee: embed is gated by auth — never invoked
    // without a userId. Prevents leaking embedding compute on
    // unauthenticated requests if the tool ever forgets to gate.
    expect(embedSpy).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });

  it("embed spy is invoked when search_content has a valid userId", async () => {
    const embedSpy = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
    // Inject a synthetic Claims object via the HTTP-style createServer
    // path. createServer accepts an optional `claims` param — when set,
    // ctx.userId is populated from `claims.sub`.
    const deps = buildDeps(embedSpy, []);
    const server = createServer(deps, { sub: "u1", role: "owner" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "embed-wiring-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "alphahotel" },
    }, undefined, { timeout: 5000 });

    expect(embedSpy).toHaveBeenCalledWith(["alphahotel"]);
    // Empty $queryRawUnsafe result → results: []
    expect(res.isError).toBe(false);

    await client.close();
    await server.close();
  });

  it("when ctx.embedText is undefined, search_content surfaces EMBEDDING_UNAVAILABLE", async () => {
    const deps: ContextDeps = {
      prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as never,
      matter: {} as never,
      httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
      // embedText omitted — simulates a startup where ai-gateway wasn't reachable.
    };
    const server = createServer(deps, { sub: "u1", role: "owner" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "embed-wiring-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "alphahotel" },
    }, undefined, { timeout: 5000 });

    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("EMBEDDING_UNAVAILABLE");

    await client.close();
    await server.close();
  });

  it("when ctx.embedText throws, search_content surfaces EMBEDDING_UNAVAILABLE", async () => {
    const embedSpy = vi.fn().mockRejectedValue(new Error("UNAVAILABLE: ai-gateway"));
    const deps = buildDeps(embedSpy, []);
    const server = createServer(deps, { sub: "u1", role: "owner" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "embed-wiring-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "alphahotel" },
    }, undefined, { timeout: 5000 });

    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("EMBEDDING_UNAVAILABLE");
    expect(embedSpy).toHaveBeenCalledWith(["alphahotel"]);

    await client.close();
    await server.close();
  });
});
