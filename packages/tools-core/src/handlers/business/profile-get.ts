/**
 * WARP-1120 (Phase 2, §13) — `business_profile_get` LLM tool.
 *
 * Read-only Tier 1 (no write, no confirmation). Returns the structured
 * `BusinessProfile` singleton respecting the §12 role subset via
 * `ToolContext.role`, so the model can answer "what do you know about this
 * business?" without ever leaking what the API hides:
 *   - owner/admin → summary + every structured field
 *   - family      → summary ONLY
 *   - guest/service (or absent role) → nothing (`present:false`)
 *
 * The response is bounded to a documented RESULT_BUDGET_CHARS (4000) budget:
 * every handler's output shares the model's context window, so even a fully
 * filled profile (summary 1500 + six 600-char fields) cannot flood it. When
 * the serialized result would exceed the budget, the lowest-priority fields
 * are dropped (summary is highest priority and always survives) and
 * `truncated:true` is set — the long tail stays reachable via the REST route.
 *
 * PRIVACY: the profile is LOCAL box state, never sent off the box (brief §5-12).
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** The fixed singleton key (ApplianceSetup precedent — mirrors the
 *  orchestrator's BUSINESS_PROFILE_SINGLETON_ID; tools-core cannot import
 *  orchestrator code so the literal is duplicated here). */
const SINGLETON_ID = "singleton";

/** Documented output budget (§13). The tool result cannot flood the context
 *  window; the long tail is reachable via GET /api/business-profile. */
const RESULT_BUDGET_CHARS = 4000;

/** Structured fields in DROP priority — the FIRST entry is dropped first when
 *  the result overflows the budget. Summary is not in this list: it is the
 *  highest-priority field and is never dropped. */
const DROP_ORDER: ReadonlyArray<
  "goals" | "typicalDay" | "toolsUsed" | "teamShape" | "customers" | "whatWeDo"
> = ["goals", "typicalDay", "toolsUsed", "teamShape", "customers", "whatWeDo"];

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

interface BusinessProfileShape {
  summary: string;
  whatWeDo: string;
  customers: string;
  teamShape: string;
  toolsUsed: string;
  typicalDay: string;
  goals: string;
}

function roleView(role: string | undefined): "full" | "summary" | "none" {
  if (role === "owner" || role === "admin") return "full";
  if (role === "family") return "summary";
  return "none";
}

/** Serialized-length-aware clamp for the owner/admin full view. Drops the
 *  lowest-priority fields (DROP_ORDER) until the JSON fits the budget, marking
 *  `truncated`. Deterministic — same profile in, same trimmed shape out. */
function clampFull(profile: BusinessProfileShape): Record<string, unknown> {
  const data: Record<string, unknown> = {
    present: true,
    summary: profile.summary,
    whatWeDo: profile.whatWeDo,
    customers: profile.customers,
    teamShape: profile.teamShape,
    toolsUsed: profile.toolsUsed,
    typicalDay: profile.typicalDay,
    goals: profile.goals,
  };
  for (const field of DROP_ORDER) {
    if (JSON.stringify(data).length <= RESULT_BUDGET_CHARS) break;
    delete data[field];
    // Set the flag INSIDE the loop so its own serialized length is counted by
    // the next iteration's budget check — otherwise adding it afterwards can
    // push a just-under-budget result back over.
    data.truncated = true;
  }
  return data;
}

async function handler(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const view = roleView(ctx.role);
  if (view === "none") {
    // Guest/service/unknown: the business profile is not theirs to read.
    return { ok: true, data: { present: false } };
  }

  const row = (await ctx.prisma.businessProfile.findUnique({
    where: { id: SINGLETON_ID },
  })) as BusinessProfileShape | null;

  if (!row) {
    // Fresh box — no profile committed yet. Report absence explicitly rather
    // than inventing empty fields.
    return { ok: true, data: { present: false } };
  }

  if (view === "summary") {
    return { ok: true, data: { present: true, summary: row.summary } };
  }

  return { ok: true, data: clampFull(row) };
}

const tool: Tool = {
  name: "business_profile_get",
  description:
    "Read the structured business profile the box holds — what the business " +
    "does, its customers, team shape, tools/systems, a typical day, and goals, " +
    "plus a short summary. Tier-1 read; safe to call without operator " +
    "confirmation. Output is role-filtered (family callers see the summary " +
    "only). Use to ground answers about the business in its own recorded " +
    "context before falling back to memory_recall or search_content.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
