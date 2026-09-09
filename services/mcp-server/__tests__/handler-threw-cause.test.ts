/**
 * WARP-1480 — `HANDLER_THREW` must carry the cause chain.
 *
 * The catch in `server.ts` built its message from
 * `err instanceof Error ? err.message : String(err)` and DROPPED `err.cause`.
 * That is where undici puts the only value worth having when a fetch dies
 * intermittently: `ECONNRESET`, `UND_ERR_HEADERS_TIMEOUT`, `ENOTFOUND`. The
 * model, the trace, and the orchestrator's new `agent_tool_error` line all saw
 * a bare "fetch failed" — the same two words for a DNS failure, a reset socket
 * and a timeout.
 *
 * The end-to-end case at the bottom is the load-bearing one: it drives the REAL
 * `read_file` handler (the tool WARP-1480 is actually about) through the REAL
 * catch and asserts the errno survives all the way onto the wire.
 */
import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";
import { describeThrown } from "../src/thrown-cause.js";

describe("describeThrown", () => {
  it("passes a plain Error message through unchanged", () => {
    expect(describeThrown(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error throw", () => {
    expect(describeThrown("just a string")).toBe("just a string");
    expect(describeThrown(42)).toBe("42");
  });

  it("appends the cause's errno — the undici `fetch failed` shape", () => {
    // Exactly what undici throws: a TypeError whose message says nothing and
    // whose cause carries the diagnosis.
    const cause = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const err = new TypeError("fetch failed", { cause });

    const out = describeThrown(err);

    expect(out).toContain("fetch failed");
    expect(out).toContain("ECONNRESET");
  });

  it("prefers the cause's `code` over its message", () => {
    const cause = Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    expect(describeThrown(new TypeError("fetch failed", { cause }))).toContain(
      "UND_ERR_HEADERS_TIMEOUT",
    );
  });

  it("falls back to the cause's message when it has no code", () => {
    const err = new Error("wrapper", { cause: new Error("the real reason") });
    expect(describeThrown(err)).toContain("the real reason");
  });

  it("surfaces the THROWN error's own code when its message omits it", () => {
    const err = Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    expect(describeThrown(err)).toContain("UND_ERR_HEADERS_TIMEOUT");
  });

  it("does not duplicate a code already present in the message", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND nextcloud"), {
      code: "ENOTFOUND",
    });
    expect(describeThrown(err).match(/ENOTFOUND/g)).toHaveLength(1);
  });

  it("walks a multi-level chain", () => {
    const inner = Object.assign(new Error("socket"), { code: "ECONNREFUSED" });
    const mid = new Error("upstream unavailable", { cause: inner });
    const out = describeThrown(new TypeError("fetch failed", { cause: mid }));

    expect(out).toContain("fetch failed");
    expect(out).toContain("upstream unavailable");
    expect(out).toContain("ECONNREFUSED");
  });

  it("terminates on a cyclic cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;

    // The assertion is that this RETURNS at all.
    expect(describeThrown(a)).toContain("a");
  });

  it("bounds the total length so one pathological error can't flood the wire", () => {
    const err = new Error("x".repeat(50_000), {
      cause: new Error("y".repeat(50_000)),
    });
    expect(describeThrown(err).length).toBeLessThanOrEqual(2048);
  });

  it("ignores a null / undefined cause", () => {
    expect(describeThrown(new Error("solo", { cause: undefined }))).toBe("solo");
    expect(describeThrown(new Error("solo", { cause: null }))).toBe("solo");
  });
});

describe("HANDLER_THREW end-to-end (WARP-1480)", () => {
  /** An `httpFactory` whose nextcloud GET rejects the way undici does. */
  function depsThatReject(cause: unknown): ContextDeps {
    return {
      prisma: {} as never,
      matter: {} as never,
      httpFactory: () => ({
        get: vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause })),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      }),
    } as unknown as ContextDeps;
  }

  it("carries the errno onto the wire when read_file's fetch dies", async () => {
    const server = createServer(
      depsThatReject(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      ),
      { kind: "local-trusted" },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "handler-threw-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const res = (await client.callTool({
      name: "read_file",
      arguments: { path: "/Notes/a.md" },
      _meta: { ncToken: "nct-abc-123", userId: "alice" },
    })) as { isError: boolean; content: { text: string }[] };

    expect(res.isError).toBe(true);
    const wire = JSON.parse(res.content[0].text) as {
      status: string;
      error: { code: string; message: string };
    };
    expect(wire.status).toBe("error");
    expect(wire.error.code).toBe("HANDLER_THREW");
    // Before WARP-1480 this read exactly "fetch failed" and nothing else.
    expect(wire.error.message).toContain("ECONNRESET");

    await client.close();
    await server.close();
  });
});
