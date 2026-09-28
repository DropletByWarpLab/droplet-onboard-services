/**
 * WARP-1604 — the ONE contract for what a tool call puts on the wire.
 *
 * mcp-server does **not** serialize the `ToolResult` envelope. Its
 * `toolResultToContent` (`services/mcp-server/src/server.ts`) emits:
 *
 *   ok: true   → `JSON.stringify(result.data)`
 *                the handler's payload **unwrapped**, at the ROOT.
 *   ok: false  → `JSON.stringify({ status, error })`
 *                no `ok`, no `data` — status + error at the ROOT.
 *
 * So every consumer downstream of `JSON.parse(content[0].text)` sees
 * `{ path }`, `{ results: [...] }`, `{ files: [...] }` … directly. There is
 * never an `ok` discriminant and never a `data` wrapper. Reading
 * `payload.data` is ALWAYS `undefined` — that was the WARP-1604 bug:
 * `extractCitedFilePaths` walked the envelope, so it returned `[]` for
 * every successful tool call and no `FileCitation` row was ever written.
 *
 * ## Why the type is opaque
 *
 * `ToolResultPayload` is nominally branded and `parseToolResultPayload` is
 * its ONLY producer. That is deliberate: the original WARP-473 unit test
 * hid this bug for a full release cycle by hand-constructing `{ ok, data }`
 * — a shape the production path never emits — and the compiler had no way
 * to object because the extractor took `unknown`. With the brand, a
 * hand-rolled object is a **compile error**; callers (production loop and
 * tests alike) must start from real wire text. Combine that with the
 * mcp-server serializer canary in
 * `src/__tests__/file-citation.test.ts` and the two sides cannot drift
 * apart silently again.
 *
 * The brand is a nominal marker, not a structural claim — the wire value is
 * arbitrary JSON. Widen with `toolResultPayloadValue()` before inspecting.
 */
import type { ToolError, ToolResult } from "@droplet/tools-core";

declare const TOOL_RESULT_PAYLOAD_BRAND: unique symbol;

/**
 * A parsed mcp-server tool-result wire payload. Opaque on purpose — see the
 * module docblock. Obtain one with {@link parseToolResultPayload}, read one
 * with {@link toolResultPayloadValue}.
 */
export type ToolResultPayload = {
  readonly [TOOL_RESULT_PAYLOAD_BRAND]: "mcp-server-wire";
};

/**
 * The failure branch of the wire contract, spelled out. Field types are
 * pulled from the shared `ToolResult` in `@droplet/tools-core` — the same
 * type mcp-server's serializer is typed against — so a change to the
 * envelope's error shape breaks this file at compile time.
 *
 * Note `status: "confirmation_required"` also lands here, and the agent
 * loop treats it as a NON-error (the tool is asking for approval, it did
 * not fail), so it does reach citation extraction. It carries no file
 * paths at the root, which is correct: nothing was read yet.
 */
export interface ToolFailureWirePayload {
  status: Extract<ToolResult, { ok: false }>["status"];
  error: ToolError;
}

/** WARP-3284 — the error code for output that claimed to be JSON and wasn't. */
export const TOOL_OUTPUT_MALFORMED = "TOOL_OUTPUT_MALFORMED";
const MALFORMED_EXCERPT_CHARS = 200;

/**
 * Parse the raw `content[0].text` mcp-server put on the wire.
 *
 * This is the single parse point for a tool result in the agent loop.
 *
 * WARP-3284 — non-JSON text splits two ways, because both are real:
 *
 *   - Text that STARTS like JSON (`{` / `[`) but does not parse is a broken
 *     tool: a truncated stream, a crash mid-write, an extension body cut by
 *     the 32 KiB cap. It becomes an explicit `status: "error"` envelope with
 *     code TOOL_OUTPUT_MALFORMED; the agent loop marks the call failed. A
 *     bounded `raw` excerpt rides along for the trace, never as data.
 *   - Any other text keeps the historical `{ raw }` success shape. Local
 *     tools can't produce it (mcp-server always `JSON.stringify`s), but
 *     remote MCP servers (`mcp-multiplexer` → `remote-mcp-gateway`) and
 *     extension tools (`extension-mcp.port`) pass the upstream's text
 *     content through verbatim, and markdown/plain text is a normal MCP
 *     success. An HTML error page from an upstream also lands here; it is
 *     only caught if the upstream sets `isError`.
 */
export function parseToolResultPayload(text: string): ToolResultPayload {
  try {
    return JSON.parse(text) as ToolResultPayload;
  } catch {
    const head = text.trimStart()[0];
    if (head === "{" || head === "[") {
      return {
        status: "error",
        error: {
          code: TOOL_OUTPUT_MALFORMED,
          message:
            "The tool returned output that could not be read, so this call failed. " +
            "Tell the user which tool failed; do not treat it as an empty result " +
            "and do not ask the user to supply the data.",
        },
        raw: text.slice(0, MALFORMED_EXCERPT_CHARS),
      } as unknown as ToolResultPayload;
    }
    return { raw: text } as unknown as ToolResultPayload;
  }
}

/** WARP-3284 — true when {@link parseToolResultPayload} rejected the text. */
export function isMalformedToolOutput(payload: ToolResultPayload): boolean {
  const v = payload as unknown as { error?: { code?: unknown } } | null;
  return (
    v !== null &&
    typeof v === "object" &&
    typeof v.error === "object" &&
    v.error !== null &&
    v.error.code === TOOL_OUTPUT_MALFORMED
  );
}

/**
 * Widen a payload back to `unknown` for inspection. Every reader goes
 * through here, which keeps the "you may only inspect what the wire
 * actually produced" boundary visible in the diff.
 */
export function toolResultPayloadValue(payload: ToolResultPayload): unknown {
  return payload as unknown;
}
