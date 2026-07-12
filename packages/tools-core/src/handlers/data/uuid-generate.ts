/**
 * WARP-901 — `uuid_generate` LLM tool.
 *
 * Misc dev-utility: generates RFC 4122 v4 UUID(s) via Node's built-in
 * `crypto.randomUUID()`. Tier-1 read; pure computation, no I/O.
 */
import { randomUUID } from "node:crypto";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const MAX_COUNT = 100;

const inputSchema = {
  type: "object",
  properties: {
    count: {
      type: "integer",
      minimum: 1,
      maximum: MAX_COUNT,
      description: `How many UUIDs to generate (default 1, max ${MAX_COUNT}).`,
    },
  },
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const count =
    typeof args.count === "number" && Number.isFinite(args.count)
      ? Math.max(1, Math.min(MAX_COUNT, Math.floor(args.count)))
      : 1;

  const uuids = Array.from({ length: count }, () => randomUUID());

  return {
    ok: true,
    data: { type: "uuid_generate", uuids },
  };
}

const tool: Tool = {
  name: "uuid_generate",
  description:
    "Generate one or more RFC 4122 v4 UUIDs. Optional `count` (default 1, max 100). Tier-1 read; pure computation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
