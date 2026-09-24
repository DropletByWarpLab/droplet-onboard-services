/**
 * WARP-2900 (ADR-056 slice H3) — the extension's McpClientPort over the
 * sandbox relay.
 *
 *   - tools/list crosses as {name, description, inputSchema} and NOTHING else:
 *     a listing that carries annotations (readOnlyHint) loses them here, by
 *     construction. MUTATION: spread the wire entry → red.
 *   - tools/call maps the result to text content and an isError flag; a
 *     JSON-RPC error or a relay refusal is a tool error, never a throw into
 *     the agent loop.
 *   - it dials only the sandbox client's rpc (no SDK transport, no URL of
 *     its own): the file imports no @modelcontextprotocol module and names
 *     no fetch.
 *   - a port is always pinned to the signed manifest's tools: `pinned` is
 *     required by type and at runtime (review #2325);
 *   - each text entry of a result is capped at
 *     EXTENSION_CONTENT_TEXT_CAP_BYTES, cut on a character boundary and
 *     saying so (MUTATION: drop the cap → red).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("../config.js", () => ({ config: { SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "t" } }));

import {
  EXTENSION_CONTENT_TEXT_CAP_BYTES,
  ExtensionListingMismatchError,
  ExtensionMcpPort,
} from "./extension-mcp.port.js";
import { ExtensionSandboxError } from "./extension-sandbox.client.js";
import type { McpToolDescriptor } from "./mcp-client.port.js";

type Rpc = (slug: string, message: unknown, timeoutMs?: number) => Promise<{ status: number; json: unknown }>;

const WORD_COUNT = [{ name: "word_count", description: "Count words.", inputSchema: { type: "object" } }];

function port(rpc: Rpc, pinned: readonly McpToolDescriptor[] = WORD_COUNT) {
  const fn = vi.fn<Rpc>(rpc);
  return { port: new ExtensionMcpPort({ slug: "wc", sandbox: { rpc: fn }, pinned }), rpc: fn };
}

const ok = (id: unknown, result: unknown) => ({ status: 200, json: { jsonrpc: "2.0", id, result } });

describe("listTools", () => {
  it("keeps name, description and inputSchema and drops everything else the wire sent", async () => {
    const pinned = [{ name: "delete_everything", description: "Deletes every file.", inputSchema: { type: "object" } }];
    const { port: p, rpc } = port(async (_s, m) =>
      ok((m as { id: number }).id, {
        tools: [
          {
            name: "delete_everything",
            description: "Deletes every file.",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true, destructiveHint: false },
            _meta: { privileged: true },
          },
        ],
      }),
      pinned,
    );
    const tools = await p.listTools();
    expect(tools).toEqual([{ name: "delete_everything", description: "Deletes every file.", inputSchema: { type: "object" } }]);
    expect(Object.keys(tools[0]).sort()).toEqual(["description", "inputSchema", "name"]);
    expect(rpc.mock.calls[0][0]).toBe("wc");
    expect(rpc.mock.calls[0][1]).toMatchObject({ jsonrpc: "2.0", method: "tools/list" });
  });

  it("refuses a malformed listing rather than guessing at it", async () => {
    const bad = [
      { status: 200, json: { jsonrpc: "2.0", id: 1, result: { tools: "nope" } } },
      { status: 200, json: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } } },
      { status: 404, json: { detail: "extension wc is not installed in this sandbox" } },
      { status: 200, json: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: 7, description: "x", inputSchema: {} }] } } },
    ];
    for (const r of bad) {
      const { port: p } = port(async () => r);
      await expect(p.listTools()).rejects.toThrow();
    }
  });
});

describe("a port pinned to the signed manifest", () => {
  it("cannot be built without the signed manifest's tools", () => {
    const rpc = vi.fn<Rpc>();
    // @ts-expect-error `pinned` is required: an unpinned port would pass the wire's listing through.
    expect(() => new ExtensionMcpPort({ slug: "wc", sandbox: { rpc } })).toThrow(/pinned/);
    expect(rpc).not.toHaveBeenCalled();
  });

  const signed = [{ name: "word_count", description: "Count words.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }];
  const pinnedPort = (tools: unknown[]) =>
    new ExtensionMcpPort({
      slug: "wc",
      pinned: signed,
      sandbox: { rpc: async (_s, m) => ok((m as { id: number }).id, { tools }) },
    });

  it("returns the manifest's copy when the listing matches (key order in the schema does not matter)", async () => {
    const tools = await pinnedPort([{ name: "word_count", description: "Count words.", inputSchema: { properties: { text: { type: "string" } }, type: "object" } }]).listTools();
    expect(tools).toEqual(signed);
  });

  it("throws a mismatch for any difference in names, descriptions or schemas", async () => {
    const variants = [
      [],
      [{ ...signed[0], name: "words" }],
      [{ ...signed[0], description: "Harmless." }],
      [{ ...signed[0], inputSchema: { type: "object" } }],
      [signed[0], signed[0]],
      [signed[0], { name: "more", description: "x", inputSchema: { type: "object" } }],
    ];
    for (const v of variants) {
      await expect(pinnedPort(v).listTools()).rejects.toBeInstanceOf(ExtensionListingMismatchError);
    }
  });
});

describe("callTool", () => {
  it("sends name + arguments and maps the result to text content", async () => {
    const { port: p, rpc } = port(async (_s, m) =>
      ok((m as { id: number }).id, { content: [{ type: "text", text: '{"words":3}', extra: 1 }], isError: false }),
    );
    const out = await p.callTool("word_count", { text: "a b c" });
    expect(out).toEqual({ content: [{ type: "text", text: '{"words":3}' }], isError: false });
    expect(rpc.mock.calls[0][1]).toMatchObject({ method: "tools/call", params: { name: "word_count", arguments: { text: "a b c" } } });
  });

  it("a tool-reported failure stays a failure", async () => {
    const { port: p } = port(async (_s, m) => ok((m as { id: number }).id, { content: [{ type: "text", text: "Error: boom" }], isError: true }));
    expect((await p.callTool("word_count", {})).isError).toBe(true);
  });

  it("a JSON-RPC error, a relay refusal or a sandbox error is a tool error, not a throw", async () => {
    const cases: Rpc[] = [
      async (_s, m) => ({ status: 200, json: { jsonrpc: "2.0", id: (m as { id: number }).id, error: { code: -32602, message: "unknown tool" } } }),
      async () => ({ status: 404, json: { detail: "extension wc is not installed in this sandbox" } }),
      async () => {
        throw new ExtensionSandboxError("extension wc did not answer", 502, "SANDBOX_ERROR");
      },
    ];
    for (const c of cases) {
      const { port: p } = port(c);
      const out = await p.callTool("word_count", {});
      expect(out.isError).toBe(true);
      expect(out.content[0].type).toBe("text");
    }
  });

  it("drops non-text content and a non-boolean isError reads as an error", async () => {
    const { port: p } = port(async (_s, m) =>
      ok((m as { id: number }).id, { content: [{ type: "image", data: "AAAA" }, { type: "text", text: "hi" }], isError: "no" }),
    );
    const out = await p.callTool("word_count", {});
    expect(out).toEqual({ content: [{ type: "text", text: "hi" }], isError: true });
  });
});

describe("a result's text is bounded per entry (review #2325)", () => {
  const answering = (text: string) =>
    port(async (_s, m) => ok((m as { id: number }).id, { content: [{ type: "text", text }, { type: "text", text: "short" }], isError: false }));

  it("passes an entry at the cap unchanged", async () => {
    const text = "a".repeat(EXTENSION_CONTENT_TEXT_CAP_BYTES);
    const out = await answering(text).port.callTool("word_count", {});
    expect(out.content[0].text).toBe(text);
  });

  it("cuts an entry over the cap at the cap and says how much it held", async () => {
    const text = "a".repeat(EXTENSION_CONTENT_TEXT_CAP_BYTES * 3);
    const out = await answering(text).port.callTool("word_count", {});
    const first = out.content[0].text as string;
    expect(first.startsWith("a".repeat(EXTENSION_CONTENT_TEXT_CAP_BYTES))).toBe(true);
    expect(first.slice(EXTENSION_CONTENT_TEXT_CAP_BYTES)).toMatch(/^\n\[truncated: the extension returned \d+ bytes; the first \d+ are shown\]$/);
    expect(first).toContain(`returned ${EXTENSION_CONTENT_TEXT_CAP_BYTES * 3} bytes`);
    expect(out.content[1].text).toBe("short");
  });

  it("cuts on a character boundary, never inside a multi-byte character", async () => {
    // Two-byte characters with the cap falling one byte into one of them.
    const text = "x" + "é".repeat(EXTENSION_CONTENT_TEXT_CAP_BYTES);
    const out = await answering(text).port.callTool("word_count", {});
    const kept = (out.content[0].text as string).split("\n[truncated")[0];
    expect(kept).not.toContain("\uFFFD");
    expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(EXTENSION_CONTENT_TEXT_CAP_BYTES);
    expect(Buffer.byteLength(kept, "utf8")).toBeGreaterThan(EXTENSION_CONTENT_TEXT_CAP_BYTES - 2);
  });
});

describe("the ADR-043 §5 boundary", () => {
  it("imports no MCP SDK and dials nothing but the sandbox client", () => {
    const src = readFileSync(path.join(__dirname, "extension-mcp.port.ts"), "utf8");
    expect(src).not.toMatch(/@modelcontextprotocol/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/https?:\/\//);
  });
});
