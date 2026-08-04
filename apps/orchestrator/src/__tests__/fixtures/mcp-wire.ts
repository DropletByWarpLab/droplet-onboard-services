/**
 * WARP-1604 — the mcp-server wire fixture.
 *
 * Tests must never hand-build a "parsed tool result". The WARP-473 suite
 * did exactly that — it constructed `{ ok, data: { … } }`, a shape the
 * production path has never emitted — and so it happily passed while the
 * real citation trail was dead for every successful tool call.
 *
 * Everything here starts from a real `ToolResult` (the shared envelope
 * type from `@droplet/tools-core`, i.e. what a tool handler actually
 * returns) and runs it through the SAME serialization mcp-server's
 * `toolResultToContent` applies before the value ever reaches the
 * orchestrator. Feed the output to `extractCitedFilePaths` and you are
 * testing production.
 *
 * Two things keep this honest:
 *   1. `ToolResult` is the shared type — if the envelope changes, this
 *      file stops compiling.
 *   2. `file-citation.test.ts` pins the serializer expressions in
 *      `services/mcp-server/src/server.ts` (the "serializer canary"), so a
 *      change on that side reds this suite instead of silently starving
 *      the `FileCitation` table again.
 */
import type { ToolResult } from "@droplet/tools-core";

import {
  parseToolResultPayload,
  type ToolResultPayload,
} from "../../services/tool-result-payload.js";

/**
 * Byte-for-byte what mcp-server puts in `content[0].text`.
 *
 * Mirrors `toolResultToContent` in `services/mcp-server/src/server.ts`:
 * the success branch drops the envelope entirely (`result.data` only) and
 * the failure branch emits `{ status, error }` — never `ok`, never `data`.
 */
export function mcpWireText(result: ToolResult): string {
  if (result.ok) {
    return JSON.stringify(result.data);
  }
  return JSON.stringify({ status: result.status, error: result.error });
}

/**
 * The wire text, parsed exactly the way the agent loop parses it. This is
 * the only supported way for a test to obtain a `ToolResultPayload`.
 */
export function mcpWirePayload(result: ToolResult): ToolResultPayload {
  return parseToolResultPayload(mcpWireText(result));
}
