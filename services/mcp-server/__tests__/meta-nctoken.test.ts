import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

/**
 * Per-call session context plumbed via MCP `_meta.ncToken`.
 *
 * The dashboard's chat path (`POST /api/llm/chat`) → orchestrator agent
 * loop → `mcpClient.callTool(name, args, { ncToken })` → MCP `_meta`
 * → `server.ts` `CallToolRequestSchema` handler → `buildContext(...,
 * ncToken)` → handler reads `ctx.ncToken`. This test pins the wire
 * shape so a future change can't silently drop the token mid-pipeline,
 * which would break file-tool authentication.
 */

function buildDepsCapturingNextcloudHeaders(captured: {
  authHeader?: string;
}): ContextDeps {
  return {
    prisma: {} as never,
    matter: {} as never,
    httpFactory: (target) => ({
      get: vi.fn().mockImplementation(async (_path, opts) => {
        if (target === "nextcloud") {
          const headers = (opts as { headers?: Record<string, string> } | undefined)
            ?.headers;
          captured.authHeader = headers?.["X-Nextcloud-Token"];
        }
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }),
      post: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      patch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      delete: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    }),
  };
}

async function connectStdio(deps: ContextDeps) {
  // Stdio transport: claims === undefined → trustedPrincipal: true, so
  // file tools (which are read-only and not gated by RBAC) reach the
  // handler regardless. This matches how the orchestrator's in-proc
  // singleton spawns the child.
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "meta-nctoken-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

describe("MCP _meta.ncToken propagation (stdio)", () => {
  it("threads _meta.ncToken into ctx.ncToken so file handlers send X-Nextcloud-Token", async () => {
    const captured: { authHeader?: string } = {};
    const deps = buildDepsCapturingNextcloudHeaders(captured);
    const { client, server } = await connectStdio(deps);

    await client.callTool({
      name: "list_files",
      arguments: { path: "/" },
      _meta: { ncToken: "nct-abc-123" },
    });

    expect(captured.authHeader).toBe("nct-abc-123");

    await client.close();
    await server.close();
  });

  it("omits the X-Nextcloud-Token header when _meta is absent", async () => {
    const captured: { authHeader?: string } = {};
    const deps = buildDepsCapturingNextcloudHeaders(captured);
    const { client, server } = await connectStdio(deps);

    await client.callTool({
      name: "list_files",
      arguments: { path: "/" },
      // no _meta — the orchestrator passes undefined when the request
      // didn't carry a Nextcloud session. file tools then surface
      // AUTH_REQUIRED at the handler layer for the writes that need it.
    });

    expect(captured.authHeader).toBeUndefined();

    await client.close();
    await server.close();
  });

  it("ignores empty / non-string _meta.ncToken (defensive)", async () => {
    const captured: { authHeader?: string } = {};
    const deps = buildDepsCapturingNextcloudHeaders(captured);
    const { client, server } = await connectStdio(deps);

    await client.callTool({
      name: "list_files",
      arguments: { path: "/" },
      _meta: { ncToken: "" },
    });

    expect(captured.authHeader).toBeUndefined();

    await client.close();
    await server.close();
  });

  it("threads _meta.userId into ctx.userId so search_content scopes to that user (WARP-202 / WARP-286)", async () => {
    // Stdio path: no claims, but the orchestrator passes the calling
    // user's username via _meta.userId. search-content.ts gates on
    // ctx.userId, so this test pins the trusted-stdio plumbing.
    //
    // WARP-286: the tool now calls ctx.searchHybrid (with userId bound
    // at context build time) instead of embedText + raw SQL.
    const searchSpy = vi.fn().mockResolvedValue([]);
    const deps: ContextDeps = {
      prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as never,
      matter: {} as never,
      httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
      searchHybrid: searchSpy,
    };
    const server = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "meta-userid-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "hello world" },
      _meta: { userId: "alice" },
    });

    expect(res.isError).toBe(false);
    // The userId reached the shim — verified by the bound first arg.
    expect(searchSpy).toHaveBeenCalledWith({
      userId: "alice",
      query: "hello world",
      limit: 10,
    });

    await client.close();
    await server.close();
  });

  it("rejects empty / non-string _meta.userId (defensive)", async () => {
    const searchSpy = vi.fn().mockResolvedValue([]);
    const deps: ContextDeps = {
      prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as never,
      matter: {} as never,
      httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
      searchHybrid: searchSpy,
    };
    const server = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "meta-userid-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "hello world" },
      _meta: { userId: "" },
    });

    // Empty userId → ctx.userId remains undefined → AUTH_REQUIRED.
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("AUTH_REQUIRED");

    await client.close();
    await server.close();
  });

  it("does NOT leak _meta.ncToken into the tool's `arguments` payload", async () => {
    // The whole point of using `_meta` instead of `arguments` is that
    // `_meta` is reserved by the MCP spec for protocol metadata and
    // must NOT reach the tool handler as an arg. Verify by spying on
    // a fake handler via the registry — easier: the prior test already
    // proves the token reaches `ctx.ncToken`. This test confirms the
    // tool's `args` parameter doesn't contain `ncToken`.
    const captured: { authHeader?: string } = {};
    const argsSpy = vi.fn();
    const deps: ContextDeps = {
      prisma: {} as never,
      matter: {} as never,
      httpFactory: () => ({
        get: vi.fn().mockImplementation(async (_p, opts) => {
          captured.authHeader = (opts as { headers?: Record<string, string> })
            ?.headers?.["X-Nextcloud-Token"];
          // Capture what the handler actually saw as args.
          argsSpy(_p);
          return new Response(JSON.stringify({ entries: [] }), { status: 200 });
        }),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      }),
    };
    const { client, server } = await connectStdio(deps);

    await client.callTool({
      name: "list_files",
      arguments: { path: "/photos" },
      _meta: { ncToken: "nct-xyz" },
    });

    // `path` reached the handler; `ncToken` did NOT reach the args
    // (it would have been forwarded as a path or query param if it
    // had).
    expect(argsSpy).toHaveBeenCalledWith("/photos");
    // Sanity: the token did make it through the side-channel.
    expect(captured.authHeader).toBe("nct-xyz");

    await client.close();
    await server.close();
  });

  it("threads _meta._enhancement into ctx.searchHybrid for adaptive routing (WARP-437)", async () => {
    // Stdio is the only transport that propagates `_meta._enhancement`
    // (the HTTP path drops it on purpose so attackers can't smuggle
    // pre-computed vectors past the strict input schema). The
    // orchestrator's agent-loop is the only legitimate producer here.
    const searchSpy = vi.fn().mockResolvedValue([]);
    const deps: ContextDeps = {
      prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as never,
      matter: {} as never,
      httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
      searchHybrid: searchSpy,
    };
    const server = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "meta-enh-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const enhancement = {
      hydeVector: [0.1, 0.2, 0.3],
      searchOverrides: { rerankCandidates: 100 },
      metadataFilter: { filenameContains: "invoice" },
    };

    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "hello world" },
      _meta: { userId: "alice", _enhancement: enhancement },
    });

    expect(res.isError).toBe(false);
    expect(searchSpy).toHaveBeenCalledWith({
      userId: "alice",
      query: "hello world",
      limit: 10,
      _enhancement: enhancement,
    });

    await client.close();
    await server.close();
  });

  it("drops malformed _meta._enhancement (defensive)", async () => {
    // A non-object _enhancement (string, array, primitive) is ignored
    // by the server-side extraction — the shim then receives undefined
    // and falls back to baseline retrieval.
    const searchSpy = vi.fn().mockResolvedValue([]);
    const deps: ContextDeps = {
      prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as never,
      matter: {} as never,
      httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
      searchHybrid: searchSpy,
    };
    const server = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "meta-enh-bad-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "hello world" },
      _meta: { userId: "alice", _enhancement: "not-an-object" },
    });

    expect(res.isError).toBe(false);
    expect(searchSpy).toHaveBeenCalledWith({
      userId: "alice",
      query: "hello world",
      limit: 10,
      _enhancement: undefined,
    });

    await client.close();
    await server.close();
  });

  it("drops _meta._enhancement when it is an array (not an object)", async () => {
    // Arrays have `typeof === "object"` and are non-null, so a naive guard
    // would let them through. The Array.isArray() check rejects them so the
    // shim still receives undefined and falls back to baseline retrieval.
    const searchSpy = vi.fn().mockResolvedValue([]);
    const deps: ContextDeps = {
      prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as never,
      matter: {} as never,
      httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
      searchHybrid: searchSpy,
    };
    const server = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "meta-enh-array-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "hello world" },
      _meta: { userId: "alice", _enhancement: [1, 2, 3] },
    });

    expect(res.isError).toBe(false);
    expect(searchSpy).toHaveBeenCalledWith({
      userId: "alice",
      query: "hello world",
      limit: 10,
      _enhancement: undefined,
    });

    await client.close();
    await server.close();
  });
});
