/**
 * WARP-2894 (ADR-056 §5.1) — `routine_draft`: the model writes a routine
 * DOWN; a person turns it ON.
 *
 * The pattern this whole epic generalises: everything the model builds is a
 * draft, and a human promotion is the only thing that makes it exist
 * (ADR-047 §5.2, ADR-056 I2). POST /api/tools has no `status` field — a
 * ToolSpec is born `draft` by schema default — so this tool has no path to
 * `live` whatever it sends. That is why it is Write-tier with NO
 * confirmation: a draft is inert. It runs nothing, schedules nothing, and
 * sits on the Drafts tab of /routines until the owner reads the readback
 * (derived from the steps, never from this tool's `description`) and
 * promotes it.
 *
 * The route is the validator: slug shape, step count, `${steps.x}`
 * references, the writes/steps agreement, and — since WARP-2894 — every
 * `call` step must name a tool this box actually has. Each refusal comes
 * back as a 400 with the reason, relayed verbatim so the model can fix the
 * draft on its next turn instead of guessing.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    slug: {
      type: "string",
      description: "Short id, lowercase words joined by hyphens, e.g. morning-bookings-digest. Must be unique on this box.",
    },
    name: { type: "string", description: "Human name, e.g. Morning bookings digest." },
    description: {
      type: "string",
      description: "One or two sentences on what it does and why. Shown to the person, but the promotion readback is derived from the steps, not from this.",
    },
    category: { type: "string", description: "Optional grouping word, e.g. front-desk." },
    steps: {
      type: "array",
      description:
        "1 to 32 ordered steps. A call step runs one tool with its args; a summarize step turns what earlier steps gathered into prose. A step may publish its result under `as` and a later step may reference it as ${steps.<as>}.",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", description: "call (default) or summarize." },
          tool: { type: "string", description: "For call: the exact tool name, e.g. list_files." },
          args: { type: "object", description: "For call: the tool's arguments." },
          prompt: { type: "string", description: "For summarize: optional framing for the summary." },
          as: { type: "string", description: "Optional name later steps may reference, lowercase snake_case." },
        },
        additionalProperties: false,
      },
    },
  },
  required: ["slug", "name", "steps"],
  additionalProperties: false,
} as const;

function fail(code: string, message: string, details?: unknown): ToolResult {
  return { ok: false, status: "error", error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) {
    return fail("NO_PRINCIPAL", "This tool needs to know who it acts for, and does not.");
  }
  const slug = typeof args.slug === "string" ? args.slug.trim() : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!slug || !name) return fail("INVALID_ARGS", "slug and name are required");
  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    return fail("INVALID_ARGS", "steps must be a non-empty list");
  }
  const body: Record<string, unknown> = {
    onBehalfOf: ctx.userId,
    slug,
    name,
    steps: args.steps,
  };
  if (typeof args.description === "string" && args.description.trim()) body.description = args.description.trim();
  if (typeof args.category === "string" && args.category.trim()) body.category = args.category.trim();

  const res = await ctx.http.orchestrator.post("/api/tools", body, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) return fail("FORBIDDEN", "Your role cannot draft routines.");
  if (res.status === 409) {
    return fail("SLUG_TAKEN", `A routine with the slug "${slug}" already exists. Pick another slug, or list routines first.`);
  }
  if (res.status === 400) {
    const err = (await res.json().catch(() => null)) as
      | { error?: string; detail?: string; tools?: string[]; details?: unknown }
      | null;
    if (err?.error === "unknown_tools" && Array.isArray(err.tools)) {
      return fail(
        "UNKNOWN_TOOLS",
        `These steps name tools this box does not have: ${err.tools.join(", ")}. Use exact tool names.`,
        { tools: err.tools },
      );
    }
    return fail("INVALID_ROUTINE", err?.detail ?? err?.error ?? "The routine was refused as invalid.", err?.details);
  }
  if (!res.ok) return fail("ROUTINE_DRAFT_FAILED", `orchestrator returned ${res.status}`);
  const data = (await res.json()) as { slug: string; status: string; writes?: boolean; steps?: unknown[] };
  return {
    ok: true,
    data: {
      slug: data.slug,
      status: data.status,
      writes: data.writes ?? false,
      steps: Array.isArray(data.steps) ? data.steps.length : args.steps.length,
      message:
        "Saved as a draft. It does nothing until the owner reviews it on the Routines page and turns it on — tell them it is there.",
    },
  };
}

const routineDraft: Tool = {
  name: "routine_draft",
  description:
    "Write a routine as a DRAFT: an ordered sequence of tool calls (and optional summaries) the box can later run on a schedule or on demand. A draft runs nothing until the owner promotes it on the Routines page. Use when someone wants something done every day/week, automated, or scheduled. Name only tools that exist; check with routine_list first to avoid a duplicate.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default routineDraft;
