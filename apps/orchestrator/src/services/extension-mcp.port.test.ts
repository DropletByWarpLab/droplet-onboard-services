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
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("../config.js", () => ({ config: { SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "t" } }));

import { ExtensionMcpPort } from "./extension-mcp.port.js";
import { ExtensionSandboxError } from "./extension-sandbox.client.js";

type Rpc = (slug: string, message: unknown, timeoutMs?: number) => Promise<{ status: number; json: unknown }>;

function port(rpc: Rpc) {
  const fn = vi.fn<Rpc>(rpc);
  return { port: new ExtensionMcpPort({ slug: "wc", sandbox: { rpc: fn } }), rpc: fn };
}

const ok = (id: unknown, result: unknown) => ({ status: 200, json: { jsonrpc: "2.0", id, result } });

describe("listTools", () => {
  it("keeps name, description and inputSchema and drops everything else the wire sent", async () => {
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

describe("the ADR-043 §5 boundary", () => {
  it("imports no MCP SDK and dials nothing but the sandbox client", () => {
    const src = readFileSync(path.join(__dirname, "extension-mcp.port.ts"), "utf8");
    expect(src).not.toMatch(/@modelcontextprotocol/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/https?:\/\//);
  });
});
