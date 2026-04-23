import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  callRemoteTool,
  discoverRemoteTools,
  parseServerConfig,
  type RemoteServerConfig,
} from "../services/mcp-client.js";
import { MCP_PROTOCOL_VERSION } from "../services/mcp-protocol.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseServerConfig", () => {
  it("parses a single name=url entry", () => {
    expect(parseServerConfig("primary=https://mcp.example.com/jsonrpc")).toEqual([
      { name: "primary", url: "https://mcp.example.com/jsonrpc", bearerToken: undefined },
    ]);
  });

  it("parses multiple entries separated by comma", () => {
    const r = parseServerConfig(
      "search=https://search.example/jsonrpc,gh=https://github-mcp.example/jsonrpc",
    );
    expect(r).toHaveLength(2);
    expect(r[0].name).toBe("search");
    expect(r[1].name).toBe("gh");
  });

  it("strips #token=... from the URL and stores it as bearerToken", () => {
    const [r] = parseServerConfig("a=https://x.com/jsonrpc#token=abc123");
    expect(r.url).toBe("https://x.com/jsonrpc");
    expect(r.bearerToken).toBe("abc123");
  });

  it("URL-decodes the bearer token from the fragment", () => {
    const [r] = parseServerConfig("a=https://x.com/jsonrpc#token=hello%20world");
    expect(r.bearerToken).toBe("hello world");
  });

  it("rejects names with disallowed characters", () => {
    // Slash, dot, space — none allowed
    expect(parseServerConfig("a/b=https://x")).toEqual([]);
    expect(parseServerConfig("foo.bar=https://x")).toEqual([]);
    expect(parseServerConfig("foo bar=https://x")).toEqual([]);
  });

  it("rejects non-http(s) URLs", () => {
    expect(parseServerConfig("a=ftp://x")).toEqual([]);
    expect(parseServerConfig("a=javascript:alert(1)")).toEqual([]);
    expect(parseServerConfig("a=file:///etc/passwd")).toEqual([]);
  });

  it("returns an empty list for empty / undefined input", () => {
    expect(parseServerConfig(undefined)).toEqual([]);
    expect(parseServerConfig("")).toEqual([]);
    expect(parseServerConfig("   ")).toEqual([]);
  });

  it("ignores entries missing '='", () => {
    const r = parseServerConfig("ok=https://a.com,bad-no-eq,also=https://b.com");
    expect(r.map((c) => c.name)).toEqual(["ok", "also"]);
  });
});

describe("discoverRemoteTools", () => {
  function makeServer(initResp: unknown, listResp: unknown): RemoteServerConfig {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "initialize") return new Response(JSON.stringify(initResp));
      if (body.method === "tools/list") return new Response(JSON.stringify(listResp));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -1, message: "no" } }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return { name: "test", url: "https://test/jsonrpc" };
  }

  it("returns prefixed tool descriptors", async () => {
    const cfg = makeServer(
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "remote", version: "1.0" } } },
      { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search_web", description: "Web search", inputSchema: { type: "object" } }] } },
    );
    const tools = await discoverRemoteTools(cfg);
    expect(tools).toHaveLength(1);
    expect(tools[0].prefixedName).toBe("test__search_web");
    expect(tools[0].descriptor.name).toBe("test__search_web");
    expect(tools[0].remoteName).toBe("search_web");
  });

  it("propagates initialize errors", async () => {
    const cfg = makeServer(
      { jsonrpc: "2.0", id: 1, error: { code: -1, message: "bad protocol" } },
      null,
    );
    await expect(discoverRemoteTools(cfg)).rejects.toThrow(/initialize failed: bad protocol/);
  });

  it("propagates tools/list errors", async () => {
    const cfg = makeServer(
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "x", version: "1" } } },
      { jsonrpc: "2.0", id: 2, error: { code: -1, message: "no permission" } },
    );
    await expect(discoverRemoteTools(cfg)).rejects.toThrow(/tools\/list failed/);
  });

  it("sends Authorization header when bearerToken is set", async () => {
    let observedAuth: string | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      observedAuth = headers.Authorization;
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "x", version: "1" } } }));
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));
    }) as unknown as typeof fetch;
    await discoverRemoteTools({ name: "x", url: "https://x/jsonrpc", bearerToken: "secret" });
    expect(observedAuth).toBe("Bearer secret");
  });
});

describe("callRemoteTool", () => {
  it("unwraps a JSON-encoded text result back into an object", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: '{"results":[{"id":"1"}]}' }] },
      })),
    ) as unknown as typeof fetch;
    const r = await callRemoteTool({ name: "x", url: "https://x/jsonrpc" }, "search", { q: "test" });
    expect(r).toEqual({ results: [{ id: "1" }] });
  });

  it("returns plain text when content isn't JSON", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: "hello world" }] },
      })),
    ) as unknown as typeof fetch;
    const r = await callRemoteTool({ name: "x", url: "https://x/jsonrpc" }, "echo", {});
    expect(r).toBe("hello world");
  });

  it("returns { error } when the remote tool reported isError", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: "boom" }], isError: true },
      })),
    ) as unknown as typeof fetch;
    const r = await callRemoteTool({ name: "x", url: "https://x/jsonrpc" }, "fail", {}) as { error: string };
    expect(r.error).toBe("boom");
  });

  it("returns { error } when the JSON-RPC response is an error", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        error: { code: -32001, message: "tool not found" },
      })),
    ) as unknown as typeof fetch;
    const r = await callRemoteTool({ name: "x", url: "https://x/jsonrpc" }, "missing", {}) as { error: string };
    expect(r.error).toMatch(/tool not found/);
  });
});
