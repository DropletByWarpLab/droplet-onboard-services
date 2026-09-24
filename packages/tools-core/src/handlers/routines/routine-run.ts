/**
 * WARP-2894 (ADR-056 §5.1) — `routine_run`: run a LIVE routine now, as the
 * person asking.
 *
 * TIER-2 ON PURPOSE. A routine is a sequence of real tool calls, some of
 * which write; pressing Run from chat is the same act as pressing Run on
 * /routines, and the interceptor confirms it the same way it confirms any
 * write. The route then applies the whole-spec pre-flight the dashboard
 * gets — the person's write tier and role grants against every step's tool
 * — and refuses with an honest 403 and NO run row when any step is out of
 * reach. No privilege laundering: `onBehalfOf = ctx.userId`, and the route
 * resolves and checks THAT person.
 *
 * Two gates this tool does NOT pass on the person's behalf:
 *   - a draft or suggested routine cannot run (400) — promotion is a
 *     person's act on the Routines page, never a side effect of a chat turn;
 *   - a routine that writes and is not reversible asks for `?confirm=true`
 *     (409). The interceptor's confirmation covered "run <slug>", not the
 *     derived readback of what that routine does, so the 409 is relayed and
 *     the person is pointed at the page that shows the readback.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    slug: { type: "string", description: "The routine's slug, from routine_list." },
  },
  required: ["slug"],
  additionalProperties: false,
} as const;

function fail(code: string, message: string, details?: unknown): ToolResult {
  return { ok: false, status: "error", error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

interface TraceRow {
  idx: number;
  tool?: string;
  ok: boolean;
  error?: string;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) {
    return fail("NO_PRINCIPAL", "This tool needs to know who it acts for, and does not.");
  }
  const slug = typeof args.slug === "string" ? args.slug.trim() : "";
  if (!slug) return fail("INVALID_ARGS", "slug is required");

  const res = await ctx.http.orchestrator.post(
    `/api/tools/${encodeURIComponent(slug)}/runs`,
    { onBehalfOf: ctx.userId },
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404) return fail("NOT_FOUND", `No routine with the slug "${slug}". Use routine_list to find it.`);
  if (res.status === 403) {
    const err = (await res.json().catch(() => null)) as { error?: string; tool?: string } | null;
    if (err?.error === "forbidden_tool_for_role") {
      return fail(
        "FORBIDDEN_STEP",
        `This routine uses ${err.tool ?? "a tool"} your role may not run. Ask an owner or admin to run it.`,
      );
    }
    return fail("FORBIDDEN", "Your role cannot run routines.");
  }
  if (res.status === 400) {
    const err = (await res.json().catch(() => null)) as { error?: string; status?: string } | null;
    if (err?.status && err.status !== "live") {
      return fail(
        "ROUTINE_NOT_LIVE",
        `"${slug}" is a ${err.status} routine. Only live routines run; the owner can turn it on from the Routines page.`,
      );
    }
    return fail("INVALID_RUN", err?.error ?? "The run was refused.");
  }
  if (res.status === 409) {
    return fail(
      "CONFIRM_ON_PAGE",
      `"${slug}" changes things that cannot be undone. Run it from the Routines page, where you can see exactly what it will do first.`,
    );
  }
  if (!res.ok) return fail("ROUTINE_RUN_FAILED", `orchestrator returned ${res.status}`);

  const data = (await res.json()) as {
    runId: string;
    slug: string;
    status: "ok" | "failed" | "cancelled";
    error?: string | null;
    trace?: TraceRow[];
  };
  const trace = Array.isArray(data.trace) ? data.trace : [];
  const failed = trace.filter((t) => !t.ok);
  return {
    ok: true,
    data: {
      runId: data.runId,
      slug: data.slug,
      status: data.status,
      steps: trace.length,
      ...(data.error ? { error: data.error } : {}),
      ...(failed.length > 0
        ? { failedSteps: failed.map((t) => ({ step: t.idx + 1, tool: t.tool ?? null, error: t.error ?? null })) }
        : {}),
      message:
        data.status === "ok"
          ? `Ran "${slug}": ${trace.length} step${trace.length === 1 ? "" : "s"} completed.`
          : `"${slug}" stopped: ${data.error ?? data.status}.`,
    },
  };
}

const routineRun: Tool = {
  name: "routine_run",
  description:
    "Run a live routine now, as the person asking, and report how each step went. Only live routines run — a draft must be turned on by the owner first. Needs the person's confirmation. Get the slug from routine_list.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default routineRun;
