/**
 * WARP-2894 (ADR-056 §5.1) — `routine_list`: the routines this box holds,
 * as the acting person sees them on /routines.
 *
 * Tier-1, scoped by the route: GET /api/tools is owner/admin/family and
 * answers `{ specs }` — every routine on the box, since a routine is a
 * box-level object (its steps run as the person who triggers it, which is
 * where narrowing happens). `onBehalfOf = ctx.userId` so the route can hold
 * the acting person to the same role floor a browser caller meets.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const STATUSES = ["live", "draft", "suggested"] as const;

const inputSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      description:
        "Only routines in this state: live, draft or suggested. Omit for all. Drafts are promoted on the Routines page; only live routines can run.",
    },
  },
  additionalProperties: false,
} as const;

interface SpecRow {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  version: number;
  status: string;
  writes: boolean;
  reversible: boolean;
  updatedAt: string;
  stepCount?: number;
  runCount?: number;
  schedules?: Array<{ rrule: string; timezone: string; enabled: boolean; nextFireAt: string }>;
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) {
    return fail("NO_PRINCIPAL", "This tool needs to know who it acts for, and does not.");
  }
  const qs = new URLSearchParams({ onBehalfOf: ctx.userId });
  if (typeof args.status === "string" && (STATUSES as readonly string[]).includes(args.status)) {
    qs.set("status", args.status);
  }
  const res = await ctx.http.orchestrator.get(`/api/tools?${qs.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) return fail("FORBIDDEN", "Your role cannot use routines.");
  if (!res.ok) return fail("ROUTINE_LIST_FAILED", `orchestrator returned ${res.status}`);
  const body = (await res.json()) as { specs?: SpecRow[] };
  const routines = (body.specs ?? []).map((r) => ({
    slug: r.slug,
    name: r.name,
    status: r.status,
    ...(r.description ? { description: r.description.slice(0, 300) } : {}),
    ...(r.category ? { category: r.category } : {}),
    writes: r.writes,
    reversible: r.reversible,
    steps: r.stepCount ?? null,
    runs: r.runCount ?? null,
    schedules: (r.schedules ?? []).map((s) => ({
      rrule: s.rrule,
      timezone: s.timezone,
      enabled: s.enabled,
      nextFireAt: s.nextFireAt,
    })),
    updatedAt: r.updatedAt,
  }));
  return { ok: true, data: { routines, count: routines.length } };
}

const routineList: Tool = {
  name: "routine_list",
  description:
    "List the routines on this box — sequences of tools that run on a schedule or on demand — with their state (live, draft, suggested), whether they write, their schedules, and how many steps and runs they have. Use before drafting one, to avoid a duplicate, and before running one, to get its slug.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default routineList;
