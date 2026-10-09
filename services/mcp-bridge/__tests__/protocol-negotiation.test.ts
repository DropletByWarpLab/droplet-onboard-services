/**
 * WARP-3921 — probe-and-fallback between MCP revision 2026-07-28 and the
 * legacy `initialize` revisions. Spec wording is quoted in
 * `src/modern-connection.ts`.
 *
 * NOTHING HERE OPENS A SOCKET: `globalThis.fetch` is replaced by an in-process
 * stub server, so the assertions are about the requests the bridge would send.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// WARP-3914: this suite stubs the SOCKET (`globalThis.fetch`), so the DNS-
// pinning fetch is swapped for a pass-through to it, as in rate-limit-seam.
// The pin itself is covered in pinned-fetch.test.ts and streamable-http.test.ts.
vi.mock("../src/pinned-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/pinned-fetch.js")>()),
  guardedFetch: (url: string | URL, init?: RequestInit) => globalThis.fetch(url, init),
}));
import { createStreamableHttpConnection } from "../src/streamable-http.js";
import { classifyRemoteMcpError } from "../src/session-state.js";
import { MAX_EVENT_BYTES, MAX_RESPONSE_BYTES } from "../src/modern-connection.js";

const URL_ = "https://mcp.vendor.example/v1/mcp";
const INPUT = {
  serverId: "vendor",
  url: URL_,
  headers: { authorization: "Bearer FAKE-000000" },
};
const PROBE = { protocolNegotiation: "probe" } as const;

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: any;
}

type Handler = (req: Seen, signal?: AbortSignal | null) => Response | Promise<Response>;

/** Install `handler` as the whole network; returns every request made. */
function stubNetwork(handler: Handler): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const req: Seen = {
        url: String(url),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      seen.push(req);
      return handler(req, init?.signal);
    }),
  );
  return seen;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const rpc = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result });

const TOOL = { name: "echo", description: "d", inputSchema: { type: "object" } };

/** A modern (2026-07-28) server. `onCall` supplies the tools/call result. */
function modernServer(onCall: (req: Seen) => Response = (r) =>
  rpc(r.body.id, { resultType: "complete", content: [{ type: "text", text: "ok" }] })): Handler {
  return (req) => {
    switch (req.body?.method) {
      case "server/discover":
        return rpc(req.body.id, {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
        });
      case "tools/list":
        return rpc(req.body.id, { resultType: "complete", tools: [TOOL] });
      case "tools/call":
        return onCall(req);
      default:
        return json({ jsonrpc: "2.0", id: req.body?.id, error: { code: -32601, message: "nope" } }, 404);
    }
  };
}

/** A legacy (2025-11-25) server: rejects the modern probe with `probeAnswer`,
 *  then serves the `initialize` handshake. */
function legacyServer(probeAnswer: () => Response): Handler {
  return (req) => {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    switch (req.body.method) {
      case "server/discover":
        return probeAnswer();
      case "initialize":
        return rpc(req.body.id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "legacy", version: "1" },
        });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return rpc(req.body.id, { tools: [TOOL] });
      default:
        return json({ jsonrpc: "2.0", id: req.body.id, error: { code: -32601, message: "x" } });
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("modern server (2026-07-28)", () => {
  it("is spoken statelessly: no initialize, per-request _meta, capabilities {}", async () => {
    const seen = stubNetwork(modernServer());
    const conn = await createStreamableHttpConnection(INPUT, PROBE);
    expect(await conn.listTools()).toEqual([
      { name: "echo", description: "d", inputSchema: { type: "object" } },
    ]);
    const out = await conn.callTool("echo", { a: 1 });
    expect(out).toMatchObject({ isError: false, content: [{ type: "text", text: "ok" }] });

    expect(seen.map((s) => s.body.method)).toEqual([
      "server/discover",
      "tools/list",
      "tools/call",
    ]);
    for (const s of seen) {
      expect(s.headers.get("mcp-protocol-version")).toBe("2026-07-28");
      expect(s.headers.get("mcp-method")).toBe(s.body.method);
      expect(s.headers.get("mcp-session-id")).toBeNull();
      expect(s.headers.get("authorization")).toBe("Bearer FAKE-000000");
      const meta = s.body.params._meta;
      expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
      // ADR-072 §5: server-initiated requests stay closed.
      expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
    }
    expect(seen[2]!.headers.get("mcp-name")).toBe("echo");
  });

  it("reads a request-scoped SSE answer, ignoring notifications and server requests", async () => {
    stubNetwork(
      modernServer((r) => {
        const sse =
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n` +
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} })}\n\n` +
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: r.body.id, result: { content: [{ type: "text", text: "streamed" }] } })}\n\n`;
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }),
    );
    const seen = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls;
    const conn = await createStreamableHttpConnection(INPUT, PROBE);
    const out = await conn.callTool("echo", {});
    expect(out.content).toEqual([{ type: "text", text: "streamed" }]);
    // Nothing was sent in answer to the server's sampling request.
    expect(seen).toHaveLength(2);
  });

  it("refuses an InputRequiredResult with a readable error and never answers it", async () => {
    const seen = stubNetwork(
      modernServer((r) =>
        rpc(r.body.id, {
          resultType: "input_required",
          inputRequests: {
            who: { method: "elicitation/create", params: { mode: "url", url: "https://evil.example/x" } },
          },
          requestState: "opaque",
        }),
      ),
    );
    const conn = await createStreamableHttpConnection(INPUT, PROBE);
    const out = await conn.callTool("echo", {});
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/asked this client for more input/);
    expect(out.content[0]!.text).toMatch(/does not answer server-initiated requests/);
    // discover + tools/call, and NO retry carrying inputResponses.
    expect(seen.map((s) => s.body.method)).toEqual(["server/discover", "tools/call"]);
    expect(JSON.stringify(seen)).not.toContain("inputResponses");
    // The URL in the request is never requested.
    expect(seen.every((s) => s.url === URL_)).toBe(true);
  });

  it("never fetches a URL or resource link found in a result", async () => {
    const seen = stubNetwork(
      modernServer((r) =>
        rpc(r.body.id, {
          content: [
            { type: "text", text: "see https://evil.example/pixel.png" },
            { type: "resource_link", uri: "https://evil.example/doc", name: "doc" },
            { type: "image", data: "", mimeType: "image/png" },
          ],
        }),
      ),
    );
    const conn = await createStreamableHttpConnection(INPUT, PROBE);
    const out = await conn.callTool("echo", {});
    expect(out.content).toHaveLength(3);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.url === URL_)).toBe(true);
  });

  it("close() is terminal: refuses new requests and aborts the in-flight one", async () => {
    let aborted = false;
    stubNetwork((req, signal) => {
      if (req.body.method !== "tools/call") return modernServer()(req);
      return new Promise<Response>((_res, rej) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          rej(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const conn = await createStreamableHttpConnection(INPUT, PROBE);
    const inflight = conn.callTool("echo", {});
    // Let the request reach the stub before tearing down.
    await new Promise((r) => setTimeout(r, 0));
    await conn.close();
    await expect(inflight).rejects.toThrow();
    expect(aborted).toBe(true);
    await expect(conn.callTool("echo", {})).rejects.toThrow(/closed/);
    await expect(conn.listTools()).rejects.toThrow(/closed/);
  });
});

describe("legacy server (2025-11-25)", () => {
  const legacyCases: [string, () => Response][] = [
    ["400 with an empty body", () => new Response(null, { status: 400 })],
    ["400 with a plain-text body", () => new Response("Bad Request", { status: 400 })],
    [
      "400 with a non-modern JSON-RPC error",
      () => json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Bad Request: no session" } }, 400),
    ],
  ];
  for (const [name, answer] of legacyCases) {
  it(`falls back to initialize on ${name}`, async () => {
    const seen = stubNetwork(legacyServer(answer));
    const conn = await createStreamableHttpConnection(INPUT, PROBE);
    expect((await conn.listTools()).map((t) => t.name)).toEqual(["echo"]);

    const init = seen.find((s) => s.body?.method === "initialize");
    expect(init).toBeDefined();
    // ADR-072 §5 on the legacy path too: no sampling, roots or elicitation.
    expect(init!.body.params.capabilities).toEqual({});
    await conn.close();
  });
  }

  it("is the unchanged default: no probe unless the profile opts in", async () => {
    const seen = stubNetwork(legacyServer(() => new Response(null, { status: 400 })));
    const conn = await createStreamableHttpConnection(INPUT);
    await conn.listTools();
    expect(seen.some((s) => s.body?.method === "server/discover")).toBe(false);
    expect(seen[0]!.body.method).toBe("initialize");
    await conn.close();
  });
});

describe("the fallback is taken ONLY on the documented signal", () => {
  const modernBody = (code: number, data?: unknown) =>
    json({ jsonrpc: "2.0", id: 1, error: { code, message: "m", data } }, 400);

  const refusals: [string, () => Response][] = [
    ["401", () => new Response("no", { status: 401 })],
    ["403", () => new Response("no", { status: 403 })],
    ["404", () => new Response("no", { status: 404 })],
    ["500", () => new Response("boom", { status: 500 })],
    ["503", () => new Response("down", { status: 503 })],
    ["400 + HeaderMismatch (-32020)", () => modernBody(-32020)],
    ["400 + MissingRequiredClientCapability (-32021)", () => modernBody(-32021)],
    [
      "400 + UnsupportedProtocolVersion (-32022)",
      () => modernBody(-32022, { supported: ["2025-11-25"], requested: "2026-07-28" }),
    ],
  ];
  for (const [name, answer] of refusals) {
    it(`does NOT fall back on ${name}`, async () => {
      const seen = stubNetwork(legacyServer(answer));
      await expect(createStreamableHttpConnection(INPUT, PROBE)).rejects.toThrow();
      expect(seen.some((s) => s.body?.method === "initialize")).toBe(false);
    });
  }

  it("does not fall back on a network failure", async () => {
    const seen = stubNetwork(() => {
      throw new TypeError("fetch failed");
    });
    await expect(createStreamableHttpConnection(INPUT, PROBE)).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("classifies a 401 as auth_rejected and -32022 as protocol_mismatch", async () => {
    stubNetwork(legacyServer(() => new Response("no", { status: 401 })));
    const e401 = await createStreamableHttpConnection(INPUT, PROBE).catch((e) => e);
    expect(classifyRemoteMcpError(e401).state).toBe("auth_rejected");

    stubNetwork(legacyServer(() => modernBody(-32022)));
    const e32022 = await createStreamableHttpConnection(INPUT, PROBE).catch((e) => e);
    expect(classifyRemoteMcpError(e32022).state).toBe("protocol_mismatch");
  });

  it("refuses a discover result that does not list 2026-07-28", async () => {
    stubNetwork((req) =>
      rpc(req.body.id, { resultType: "complete", supportedVersions: ["2025-11-25"], capabilities: {} }),
    );
    await expect(createStreamableHttpConnection(INPUT, PROBE)).rejects.toThrow(/protocol version/);
  });

  it("refuses probe combined with a pin", async () => {
    stubNetwork(modernServer());
    await expect(
      createStreamableHttpConnection(INPUT, { ...PROBE, pinnedProtocolVersion: "2025-11-25" }),
    ).rejects.toThrow(/cannot be combined/);
  });
});

describe("an untrusted server cannot exhaust memory", () => {
  /** An endless body that records how many bytes were pulled from it. */
  function endless(chunk: Uint8Array, pulled: { n: number }): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull(c) {
        pulled.n += chunk.byteLength;
        c.enqueue(chunk);
      },
    });
  }
  const CHUNK = new Uint8Array(1024 * 1024).fill(97); // 1 MiB of "a"

  it("refuses an oversized JSON body without reading far past the cap", async () => {
    const pulled = { n: 0 };
    stubNetwork(
      modernServer(
        () =>
          new Response(endless(CHUNK, pulled), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const conn = await createStreamableHttpConnection(INPUT, PROBE);
    const out = await conn.callTool("echo", {});
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/exceeded the \d+-byte limit/);
    expect(pulled.n).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 4 * CHUNK.byteLength);
  });

  it("refuses an endless SSE event with no delimiter without buffering past the cap", async () => {
    const pulled = { n: 0 };
    stubNetwork(
      modernServer(
        () =>
          new Response(endless(CHUNK, pulled), {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const conn = await createStreamableHttpConnection(INPUT, PROBE);
    const out = await conn.callTool("echo", {});
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/event exceeded/);
    expect(pulled.n).toBeLessThanOrEqual(MAX_EVENT_BYTES + 4 * CHUNK.byteLength);
  });

  it("bounds all tools/list pages together, not each page", async () => {
    const page = JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      result: { tools: [], nextCursor: "next", pad: "x".repeat(3 * 1024 * 1024) },
    });
    stubNetwork((req) =>
      req.body.method === "server/discover"
        ? modernServer()(req)
        : new Response(page.replace('"id":0', `"id":${req.body.id}`), {
            headers: { "content-type": "application/json" },
          }),
    );
    const conn = await createStreamableHttpConnection(INPUT, PROBE);
    // 3 MiB x 20 pages would be 60 MiB; the shared 8 MiB budget stops it.
    await expect(conn.listTools()).rejects.toThrow(/exceeded/);
  });
});
