/**
 * WARP-3921 — the MCP `2026-07-28` ("modern", stateless) client half, and the
 * probe that decides whether a server speaks it.
 *
 * Spec, read 2026-10-08 (cite these, do not paraphrase from memory):
 *   - versioning / era model:
 *     https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
 *   - Streamable HTTP, incl. "Backward Compatibility":
 *     https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
 *   - `server/discover`:
 *     https://modelcontextprotocol.io/specification/2026-07-28/server/discover
 *   - per-request `_meta`:
 *     https://modelcontextprotocol.io/specification/2026-07-28/basic/index
 *   - multi round-trip requests (`InputRequiredResult`):
 *     https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
 *
 * ## The documented fallback signal (Streamable HTTP, "Backward Compatibility")
 *
 *   "A client that supports both modern ... and a legacy version that requires
 *   an `initialize` handshake MAY detect which era the server implements by
 *   attempting a modern request first. On `400 Bad Request`, the client SHOULD
 *   inspect the response body before falling back: modern servers also use
 *   `400` for `UnsupportedProtocolVersionError`,
 *   `MissingRequiredClientCapabilityError`, and header-validation failures.
 *   - If the body contains a recognized modern JSON-RPC error, the server
 *     speaks a modern version of MCP ... rather than falling back.
 *   - If the body is empty or is not a recognized modern JSON-RPC error, fall
 *     back to `initialize` and continue with the legacy version"
 *
 * So the fallback is taken on a 400 and ONLY a 400 whose body carries no
 * recognized modern error. A 401, a 5xx, a network failure, or a 400 with a
 * modern error body is NOT a fallback. (The matrix's wider "4xx" and the
 * deprecated HTTP+SSE leg for 404/405 are deliberately not implemented: SSE
 * stays unimplemented, see `streamable-http.ts`.)
 *
 * ## Server-initiated requests stay closed (ADR-072 §5)
 *
 * `clientCapabilities` is `{}` on every request, so a conforming server may not
 * send sampling / elicitation / roots. If one sends an `InputRequiredResult`
 * anyway it is REFUSED as an error the model can read and never answered, and a
 * JSON-RPC request arriving on a response stream is ignored. Nothing here
 * fetches a URL or resource link found in a result: the only URL this module
 * ever requests is the registered MCP endpoint.
 */
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ProtocolVersionMismatchError } from "./protocol-pin.js";
import type {
  RemoteMcpConnection,
  RemoteMcpConnectInput,
  RemoteToolCallOutcome,
  RemoteToolDescriptor,
} from "./remote-session.js";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** HeaderMismatch, MissingRequiredClientCapability, UnsupportedProtocolVersion
 *  (spec: basic/index "Error Codes"). The "recognized modern JSON-RPC errors"
 *  of the fallback rule. -32602 is NOT listed: legacy servers use it too. */
const MODERN_ERROR_CODES: ReadonlySet<number> = new Set([-32020, -32021, -32022]);
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const REQUEST_TIMEOUT_MS = 60_000;
/** A server paging forever must not pin a request loop. */
const MAX_LIST_PAGES = 20;

type Json = Record<string, unknown>;

/** An HTTP failure. Carries `status` (read by `classifyRemoteMcpError`) and
 *  NEVER the body: a server's error text can echo our own headers. */
class ModernHttpError extends Error {
  constructor(readonly status: number) {
    super(`MCP endpoint answered HTTP ${status}`);
    this.name = "ModernHttpError";
  }
}

/** A JSON-RPC error answer. `rpcCode` rather than `code`: a negative JSON-RPC
 *  code must not be read as an HTTP status. */
class ModernRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(`MCP error ${rpcCode}: ${message}`);
    this.name = "ModernRpcError";
  }
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The recognized modern JSON-RPC error in a body, if there is one. */
function modernErrorIn(body: unknown): { code: number; data: unknown } | null {
  if (!isObject(body) || !isObject(body.error)) return null;
  const code = body.error.code;
  if (typeof code !== "number" || !MODERN_ERROR_CODES.has(code)) return null;
  return { code, data: body.error.data };
}

/** `Mcp-Name` value: plain ASCII as-is, else the spec's Base64 sentinel
 *  (streamable-http "Value Encoding"). */
function headerSafe(value: string): string {
  const plain = /^[\x21-\x7e]+(?: +[\x21-\x7e]+)*$/.test(value);
  const sentinel = value.startsWith("=?base64?") && value.endsWith("?=");
  return plain && !sentinel
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

interface ModernClientOptions {
  url: string;
  headers: Record<string, string>;
  fetch: FetchLike;
  clientInfo: { name: string; version: string };
}

/** Issue one stateless request. Resolves with the parsed JSON-RPC message, or
 *  the raw HTTP response for the caller (the probe) that must read a 400. */
async function postRequest(
  o: ModernClientOptions,
  signal: AbortSignal,
  id: number,
  method: string,
  params: Json,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...o.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (method === "tools/call" && typeof params.name === "string") {
    headers["mcp-name"] = headerSafe(params.name);
  }
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [META_VERSION]: MODERN_PROTOCOL_VERSION,
        [META_CLIENT_INFO]: o.clientInfo,
        // ADR-072 §5: no sampling, roots or elicitation. Ever.
        [META_CLIENT_CAPABILITIES]: {},
      },
    },
  };
  return o.fetch(o.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
}

/** Read the JSON-RPC response for `id` from a JSON or request-scoped SSE body.
 *  Notifications are skipped; a server-to-client REQUEST (has `method` and `id`)
 *  is skipped too and never answered. */
async function readResponse(res: Response, id: number): Promise<Json> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    const msg = parseJson(await res.text());
    if (!isObject(msg)) throw new Error("MCP endpoint answered a non-JSON-RPC body");
    return msg;
  }
  if (!res.body) throw new Error("MCP endpoint opened an empty event stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      if (done && buffer) events.push(buffer);
      for (const ev of events) {
        const data = ev
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        const msg = data ? parseJson(data) : undefined;
        if (isObject(msg) && msg.id === id && !("method" in msg)) return msg;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error("MCP event stream ended without a response");
}

/** Unwrap a response message into its `result`, raising on JSON-RPC errors. */
function resultOf(msg: Json): Json {
  if (isObject(msg.error)) {
    const e = msg.error;
    throw new ModernRpcError(
      typeof e.code === "number" ? e.code : -32603,
      typeof e.message === "string" ? e.message : "unknown error",
    );
  }
  if (!isObject(msg.result)) throw new Error("MCP response carried no result");
  return msg.result;
}

/**
 * Probe, then (if modern) return a stateless connection. Returns `"legacy"`
 * ONLY on the documented signal; every other failure throws.
 */
export async function connectModern(
  input: RemoteMcpConnectInput,
  fetchImpl: FetchLike,
  clientInfo: { name: string; version: string },
): Promise<RemoteMcpConnection | "legacy"> {
  const o: ModernClientOptions = {
    url: input.url,
    headers: { ...input.headers },
    fetch: fetchImpl,
    clientInfo,
  };
  const controller = new AbortController();
  let nextId = 1;
  let closed = false;

  // --- the probe: `server/discover`, a modern request ---------------------
  const probeId = nextId++;
  const res = await postRequest(o, controller.signal, probeId, "server/discover", {});
  if (res.status === 400) {
    const body = parseJson(await res.text());
    const modern = modernErrorIn(body);
    if (!modern) return "legacy";
    if (modern.code === UNSUPPORTED_PROTOCOL_VERSION) {
      // We speak exactly one modern revision, so there is nothing to retry
      // with: surface it the way the pin does (state: protocol_mismatch).
      throw new ProtocolVersionMismatchError(MODERN_PROTOCOL_VERSION, undefined);
    }
    throw new ModernRpcError(modern.code, "the server rejected the modern request");
  }
  if (!res.ok) throw new ModernHttpError(res.status);
  const discovered = resultOf(await readResponse(res, probeId));
  const supported = discovered.supportedVersions;
  if (!Array.isArray(supported) || !supported.includes(MODERN_PROTOCOL_VERSION)) {
    throw new ProtocolVersionMismatchError(MODERN_PROTOCOL_VERSION, undefined);
  }

  // --- a modern request ----------------------------------------------------
  async function call(method: string, params: Json): Promise<Json> {
    // Teardown is terminal: a closed connection refuses new requests.
    if (closed) throw new Error("MCP connection is closed");
    const id = nextId++;
    const r = await postRequest(o, controller.signal, id, method, params);
    if (!r.ok) throw new ModernHttpError(r.status);
    const result = resultOf(await readResponse(r, id));
    // Absent resultType means "complete" (basic/index "ResultType").
    const resultType = result.resultType ?? "complete";
    if (resultType !== "complete") {
      throw new InputRefusedError(resultType);
    }
    return result;
  }

  return {
    async listTools(): Promise<RemoteToolDescriptor[]> {
      const tools: RemoteToolDescriptor[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await call("tools/list", cursor ? { cursor } : {});
        for (const t of Array.isArray(result.tools) ? result.tools : []) {
          if (!isObject(t) || typeof t.name !== "string") continue;
          tools.push({
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            // ADR-043 §2: `annotations` is never read.
            inputSchema: isObject(t.inputSchema)
              ? t.inputSchema
              : { type: "object", properties: {} },
          });
        }
        if (typeof result.nextCursor !== "string" || !result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return tools;
    },
    async callTool(name, args): Promise<RemoteToolCallOutcome> {
      let result: Json;
      try {
        result = await call("tools/call", { name, arguments: args });
      } catch (err) {
        if (err instanceof InputRefusedError) {
          // A readable tool error, not a throw: the model sees why.
          return {
            content: [{ type: "text", text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
      return {
        content: (Array.isArray(result.content) ? result.content : []) as {
          type: string;
          text?: string;
        }[],
        isError: Boolean(result.isError),
        structuredContent: result.structuredContent,
      };
    },
    async close(): Promise<void> {
      // Stateless teardown: refuse new requests, abort in-flight ones and any
      // open response stream. There is no session to DELETE.
      closed = true;
      controller.abort();
    },
    onClosed(): void {
      // No long-lived stream is ever opened, so the transport has nothing to
      // drop and there is nothing to report.
    },
  };
}

/** The refusal text for an `InputRequiredResult` (or any non-`complete`
 *  resultType). Never answers the server's request. */
class InputRefusedError extends Error {
  constructor(resultType: unknown) {
    super(
      resultType === "input_required"
        ? "The remote server asked this client for more input (sampling, " +
            "elicitation or roots) instead of answering. Droplet does not " +
            "answer server-initiated requests, so the call was not completed."
        : `The remote server returned an unrecognized result type (${String(resultType)}); the call was not completed.`,
    );
    this.name = "InputRefusedError";
  }
}
