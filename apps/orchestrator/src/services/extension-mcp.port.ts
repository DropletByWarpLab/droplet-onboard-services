/**
 * WARP-2900 (ADR-056 slice H3) — one promoted extension, seen as an
 * {@link McpClientPort}.
 *
 * THE TRANSPORT IS THE SANDBOX RELAY. The extension's host shim listens on
 * 127.0.0.1 inside the sandbox container, which sits only on
 * `droplet-internal`; nothing outside that container can reach it. The
 * sandbox (our code, bearer-gated) relays one JSON-RPC message at a time to
 * it: `POST /extensions/{slug}/rpc`. This port speaks that relay through
 * {@link ExtensionSandboxClient.rpc} and nothing else — no MCP SDK client
 * transport, no URL of its own, no socket (ADR-043 §5: the orchestrator
 * never holds a remote MCP session; `adr-043-boundary.test.ts` is unchanged).
 *
 * ANNOTATIONS NEVER CROSS. `tools/list` is mapped to {name, description,
 * inputSchema} and nothing else, the same three fields
 * {@link McpToolDescriptor} is limited to. A `readOnlyHint` the extension's
 * code puts on the wire is dropped here, so no later reader can mistake it
 * for a privilege claim. The classification record (WARP-2426) decides.
 *
 * A FAILED CALL IS A TOOL ERROR. A JSON-RPC error, a relay refusal (the
 * extension is not running) or a sandbox error comes back as
 * `{isError: true}` with a bounded message, the shape the agent loop feeds
 * back to the model; it is never thrown into the loop. `listTools` DOES
 * throw: the multiplexer records that as REMOTE_CATALOG_UNAVAILABLE, and the
 * attach path refuses to advertise a catalog it could not read.
 */
import type { McpClientPort, McpToolCallOutcome, McpToolDescriptor } from "./mcp-client.port.js";
import type { ExtensionSandboxClient } from "./extension-sandbox.client.js";

/** How long a tools/list may take through the relay. */
export const EXTENSION_LIST_TIMEOUT_MS = 15_000;
/** How long one tools/call may take; the sandbox clamps to its own ceiling. */
export const EXTENSION_CALL_TIMEOUT_MS = 30_000;
/** Bound on an error message handed back to the model. */
const MAX_ERROR_TEXT = 500;
/** Bound on content entries relayed from one result. */
const MAX_CONTENT_ENTRIES = 16;

export interface ExtensionMcpPortOptions {
  slug: string;
  sandbox: Pick<ExtensionSandboxClient, "rpc">;
  listTimeoutMs?: number;
  callTimeoutMs?: number;
}

export class ExtensionMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionMcpError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bounded = (s: string): string => (s.length > MAX_ERROR_TEXT ? `${s.slice(0, MAX_ERROR_TEXT)}…` : s);

function toolError(tool: string, message: string): McpToolCallOutcome {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: "extension_call_failed", tool, message: bounded(message) }) }],
  };
}

export class ExtensionMcpPort implements McpClientPort {
  readonly isStarted = true;
  readonly slug: string;
  readonly #sandbox: Pick<ExtensionSandboxClient, "rpc">;
  readonly #listTimeoutMs: number;
  readonly #callTimeoutMs: number;
  #nextId = 1;

  constructor(opts: ExtensionMcpPortOptions) {
    this.slug = opts.slug;
    this.#sandbox = opts.sandbox;
    this.#listTimeoutMs = opts.listTimeoutMs ?? EXTENSION_LIST_TIMEOUT_MS;
    this.#callTimeoutMs = opts.callTimeoutMs ?? EXTENSION_CALL_TIMEOUT_MS;
  }

  /** One JSON-RPC exchange; returns `result` or throws with the reason. */
  async #request(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId++;
    const message = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    const r = await this.#sandbox.rpc(this.slug, message, timeoutMs);
    const body = r.json;
    if (r.status !== 200 || !isObject(body)) {
      const detail = isObject(body) && typeof body.detail === "string" ? body.detail : `HTTP ${r.status}`;
      throw new ExtensionMcpError(`the sandbox refused ${method} for ${this.slug}: ${detail}`);
    }
    if (isObject(body.error)) {
      const msg = typeof body.error.message === "string" ? body.error.message : "unknown error";
      throw new ExtensionMcpError(`${this.slug} answered ${method} with an error: ${msg}`);
    }
    if (body.id !== id || !("result" in body)) {
      throw new ExtensionMcpError(`${this.slug} answered ${method} with something that is not its answer`);
    }
    return body.result;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.#request("tools/list", undefined, this.#listTimeoutMs);
    if (!isObject(result) || !Array.isArray(result.tools)) {
      throw new ExtensionMcpError(`${this.slug}'s tools/list has no tools array`);
    }
    return result.tools.map((t, i) => {
      if (!isObject(t) || typeof t.name !== "string" || typeof t.description !== "string" || !isObject(t.inputSchema)) {
        throw new ExtensionMcpError(`${this.slug}'s tools/list entry ${i} is not {name, description, inputSchema}`);
      }
      // These three and nothing else: annotations and any other field the
      // extension's code put on the wire stop here.
      return { name: t.name, description: t.description, inputSchema: t.inputSchema };
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallOutcome> {
    let result: unknown;
    try {
      result = await this.#request("tools/call", { name, arguments: args }, this.#callTimeoutMs);
    } catch (err) {
      return toolError(name, err instanceof Error ? err.message : String(err));
    }
    if (!isObject(result) || !Array.isArray(result.content)) {
      return toolError(name, `${this.slug} answered tools/call without content`);
    }
    const content = result.content
      .filter((c): c is { type: string; text: string } => isObject(c) && c.type === "text" && typeof c.text === "string")
      .slice(0, MAX_CONTENT_ENTRIES)
      .map((c) => ({ type: "text", text: c.text }));
    // Omitted is false (MCP default); anything but a boolean is an error.
    const isError = result.isError === undefined ? false : result.isError !== false;
    return { content, isError };
  }
}
