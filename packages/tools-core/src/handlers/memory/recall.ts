/**
 * WARP-461 — `memory.recall` LLM tool.
 *
 * Searches the per-workspace `MemoryFact` table for facts whose `fact`
 * text contains ANY query term (case-insensitive). Optional `category`
 * filter narrows to one of the six `MemoryFactCategory` values
 * (`Tone | Workflow | Scope | Schedule | Other | Business`). WARP-1335:
 * a keyword miss falls back to the recent active facts (memory is a
 * small curated set) with `broadened: true`, so the model never wrongly
 * concludes a fact doesn't exist.
 *
 * Only `active=true` facts are returned. Soft-disabled facts stay in
 * the DB for the evidence chain but don't influence the model.
 *
 * Tier 1 (read-only). No confirmation, no write.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** WARP-845 — audience ladder (mirror of the orchestrator's
 *  memory-audience.ts; tools-core cannot import orchestrator code).
 *  A caller reads audiences at or below their role rank; absent role →
 *  guest view (most restrictive). */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  family: 1,
  service: 1,
  guest: 0,
};
const AUDIENCES = ["owner", "admin", "family", "guest"] as const;
const AUDIENCE_RANK: Record<(typeof AUDIENCES)[number], number> = {
  owner: 3,
  admin: 2,
  family: 1,
  guest: 0,
};
function visibleAudiences(
  role: string | undefined,
): (typeof AUDIENCES)[number][] {
  const rank = ROLE_RANK[role ?? ""] ?? 0;
  return AUDIENCES.filter((a) => AUDIENCE_RANK[a] <= rank) as (typeof AUDIENCES)[number][];
}

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Keywords to search for in fact text (case-insensitive; matches any term). On a miss, recent facts are returned so nothing is silently hidden.",
    },
    category: {
      type: "string",
      enum: ["Tone", "Workflow", "Scope", "Schedule", "Other", "Business"],
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
    ["Tone", "Workflow", "Scope", "Schedule", "Other", "Business"].includes(args.category)
      ? (args.category as
          | "Tone"
          | "Workflow"
          | "Scope"
          | "Schedule"
          | "Other"
          | "Business")
      : undefined;
  const limit =
    typeof args.limit === "number" && args.limit > 0
      ? Math.min(Math.floor(args.limit), 50)
      : 10;

  // WARP-845 — facts the CALLER may read; shared by both queries below.
  const baseWhere = {
    active: true,
    audience: { in: visibleAudiences(ctx.role) },
    ...(category ? { category } : {}),
  };

  // WARP-1335 — a single substring match on the whole query missed facts
  // whose TEXT doesn't contain the query keyword (C02: "accountant" never
  // matched "Sophie Bergerac … will take over URSSAF"). Match ANY query
  // term instead; a query word like "the" won't help, but multi-word
  // queries get far more forgiving.
  const terms = query.split(/\s+/).filter((t) => t.length > 0);

  let facts = await ctx.prisma.memoryFact.findMany({
    where: {
      ...baseWhere,
      OR: terms.map((t) => ({ fact: { contains: t, mode: "insensitive" as const } })),
    },
    orderBy: { addedAt: "desc" },
    take: limit,
  });

  // WARP-1335 — memory is a small curated set; a keyword miss must not
  // return "nothing" and let the model claim the fact doesn't exist. Fall
  // back to the recent active facts so the model can see and judge them.
  let broadened = false;
  if (facts.length === 0) {
    facts = await ctx.prisma.memoryFact.findMany({
      where: baseWhere,
      orderBy: { addedAt: "desc" },
      take: limit,
    });
    broadened = facts.length > 0;
  }

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
      // Signals the model that these are the recent facts (keyword miss),
      // not direct hits — so it judges relevance rather than assuming a match.
      ...(broadened ? { broadened: true } : {}),
    },
  };
}

const tool: Tool = {
  name: "memory_recall",
  description:
    "Recall durable memory facts about the user or workspace. Returns facts whose text contains the query substring (case-insensitive). Optional category filter (Tone, Workflow, Scope, Schedule, Other, Business). Tier-1 read; safe to call without operator confirmation. Use BEFORE answering questions about user preferences, recurring workflows, scope assumptions, schedule, or business knowledge.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
