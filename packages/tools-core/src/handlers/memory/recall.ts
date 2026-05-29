/**
 * WARP-461 — `memory.recall` LLM tool.
 *
 * Searches the per-workspace `MemoryFact` table for facts whose `fact`
 * text contains the query substring (case-insensitive). Optional
 * `category` filter narrows to one of the five `MemoryFactCategory`
 * values (`Tone | Workflow | Scope | Schedule | Other`).
 *
 * Only `active=true` facts are returned. Soft-disabled facts stay in
 * the DB for the evidence chain but don't influence the model.
 *
 * Tier 1 (read-only). No confirmation, no write.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Substring to search for in fact text. Case-insensitive.",
    },
    category: {
      type: "string",
      enum: ["Tone", "Workflow", "Scope", "Schedule", "Other"],
      description: "Optional category filter.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Max facts to return (default 10, max 50).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length === 0) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "query is required" },
    };
  }
  const category =
    typeof args.category === "string" &&
    ["Tone", "Workflow", "Scope", "Schedule", "Other"].includes(args.category)
      ? (args.category as "Tone" | "Workflow" | "Scope" | "Schedule" | "Other")
      : undefined;
  const limit =
    typeof args.limit === "number" && args.limit > 0
      ? Math.min(Math.floor(args.limit), 50)
      : 10;

  const facts = await ctx.prisma.memoryFact.findMany({
    where: {
      active: true,
      ...(category ? { category } : {}),
      fact: { contains: query, mode: "insensitive" },
    },
    orderBy: { addedAt: "desc" },
    take: limit,
  });

  return {
    ok: true,
    data: {
      facts: facts.map((f: { id: string; category: string; fact: string; addedBy: string; addedAt: Date }) => ({
        id: f.id,
        category: f.category,
        fact: f.fact,
        addedBy: f.addedBy,
        addedAt: f.addedAt.toISOString(),
      })),
    },
  };
}

const tool: Tool = {
  name: "memory_recall",
  description:
    "Recall durable memory facts about the user or workspace. Returns facts whose text contains the query substring (case-insensitive). Optional category filter (Tone, Workflow, Scope, Schedule, Other). Tier-1 read; safe to call without operator confirmation. Use BEFORE answering questions about user preferences, recurring workflows, scope assumptions, or schedule.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
