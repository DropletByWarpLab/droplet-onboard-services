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
import { parseNamespacedToolName } from "./mcp-multiplexer.service.js";

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

/** WARP-3284 — the error code for tool output that could not be parsed. */
export const TOOL_OUTPUT_MALFORMED = "TOOL_OUTPUT_MALFORMED";
const MALFORMED_EXCERPT_CHARS = 200;

/**
 * The payloads {@link parseToolResultPayload} itself built for a parse
 * failure. Identity, not the `code` string: a well-formed upstream reply that
 * happens to carry `TOOL_OUTPUT_MALFORMED` is that tool's own answer, not
 * ours, and must not be reclassified.
 */
const malformed = new WeakSet<object>();

/**
 * Parse the raw `content[0].text` a tool call put on the wire.
 *
 * Every consumer of a tool result parses through here: the agent loop, the
 * agent-run worker's approval resume, and the ToolSpec step dispatchers.
 *
 * WARP-3284 — what non-JSON text means depends on who produced it, so the
 * caller passes the tool name:
 *
 *   - A LOCAL tool (no `__` in its name) is served by mcp-server, whose
 *     `toolResultToContent` always `JSON.stringify`s. Any text that does not
 *     parse — a truncated stream, a crash mid-write, a quote-rooted fragment,
 *     empty text — is a broken call. It becomes an explicit
 *     `status: "error"` envelope with code TOOL_OUTPUT_MALFORMED, recognised
 *     by {@link isMalformedToolOutput}; callers mark the call failed. A
 *     bounded `raw` excerpt rides along for the trace, never as data.
 *   - A namespaced tool — a remote MCP server's `<serverId>__<tool>`
 *     (`mcp-multiplexer`) or an extension's `ext-<slug>__<tool>`
 *     (`extension-mcp.port`) — passes its upstream's text through verbatim,
 *     and plain text or markdown is a normal MCP success (`[INFO] 3 matches`,
 *     `{{name}} updated`). It keeps the historical `{ raw }` success shape.
 *     That includes an extension body cut at the 32 KiB cap: the port
 *     appends a `[truncated: …]` line, and the text reaches the model as a
 *     success like any other (the WARP-2203 cap then applies, with its own
 *     reduction note).
 */
export function parseToolResultPayload(text: string, toolName: string): ToolResultPayload {
  try {
    return JSON.parse(text) as ToolResultPayload;
  } catch {
    if (parseNamespacedToolName(toolName) !== null) {
      return { raw: text } as unknown as ToolResultPayload;
    }
    const envelope = {
      status: "error",
      error: {
        code: TOOL_OUTPUT_MALFORMED,
        message:
          "The tool's response could not be read; the action may still have run. " +
          "Tell the user which tool failed and do not repeat the call. Do not treat it " +
          "as an empty result and do not ask the user to supply the data.",
      },
      raw: text.slice(0, MALFORMED_EXCERPT_CHARS),
    };
    malformed.add(envelope);
    return envelope as unknown as ToolResultPayload;
  }
}

/** WARP-3284 — true when {@link parseToolResultPayload} rejected the text. */
export function isMalformedToolOutput(payload: ToolResultPayload): boolean {
  const v = payload as unknown;
  return typeof v === "object" && v !== null && malformed.has(v);
}

/**
 * WARP-3284 — what the model is handed for a malformed result: the error
 * envelope WITHOUT the fragment, or `null` when the payload parsed.
 */
export function malformedToolOutputText(payload: ToolResultPayload): string | null {
  if (!isMalformedToolOutput(payload)) return null;
  const { status, error } = payload as unknown as { status: string; error: unknown };
  return JSON.stringify({ status, error });
}

/**
 * Widen a payload back to `unknown` for inspection. Every reader goes
 * through here, which keeps the "you may only inspect what the wire
 * actually produced" boundary visible in the diff.
 */
export function toolResultPayloadValue(payload: ToolResultPayload): unknown {
  return payload as unknown;
}
