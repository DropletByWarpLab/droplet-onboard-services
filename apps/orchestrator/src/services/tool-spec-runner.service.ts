/**
 * WARP-462 (C1) — imperative ToolSpec step walker.
 *
 * Walks `ToolStep[]` in idx order and dispatches each via the
 * pluggable `StepDispatcher`. Production wiring injects the singleton
 * MCP client so the same tool registry serves chat + scheduled runs;
 * tests inject a mock dispatcher and verify call-order + halt-on-fail.
 *
 * Semantics:
 *   - Steps walk in ascending `idx`.
 *   - Step N's parsed result is exposed to step N+1's args via simple
 *     `${prev.json_path}` template substitution. v1 supports the
 *     special variable `${prev}` (the entire previous result JSON);
 *     more elaborate JSONPath is C2 territory.
 *   - A step failure stops the walk — step N+1 onwards is NOT
 *     attempted. The ToolRun row is written with `status=failed` and
 *     `error` populated from the failing step.
 *   - The trace array captures `{idx, tool, args, ok, result|error}`
 *     per step so the dashboard's run-detail drawer can render
 *     "step 2 of 5 failed: <reason>".
 *
 * Pluggable per CLAUDE.md no-half-implementations rule — the
 * dispatcher abstraction is tiny and the production wiring lives in
 * routes/tools.ts (next to the route handler) so a future code-reading
 * Romain doesn't have to chase three files to understand a run.
 */
import type { PrismaClient } from "@prisma/client";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tool-spec-runner");

export interface StepDispatcher {
  /** Returns the parsed tool result (any JSON shape). Throws on failure. */
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

interface StoredStep {
  id: string;
  idx: number;
  kind: string;
  args: unknown;
}

export interface RunStepTrace {
  idx: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface RunOutcome {
  status: "ok" | "failed";
  trace: RunStepTrace[];
  error: string | null;
}

interface RunArgs {
  specId: string;
  specName: string;
  steps: StoredStep[];
  triggeredBy: string | null;
}

/**
 * Resolve `${prev}` template references in the args of step N+1
 * against the parsed result of step N. v1 deliberately supports only
 * the bare `${prev}` substitution; richer JSONPath is C2 scope.
 *
 * Substitution is structural: a string value of exactly `${prev}`
 * becomes the previous result; any other string is returned as-is
 * (no partial-string substitution to avoid surprise stringification).
 */
function resolvePrev(
  raw: unknown,
  prev: unknown,
): unknown {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === "string") {
    if (raw === "${prev}") return prev;
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw.map((v) => resolvePrev(v, prev));
  }
  if (typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = resolvePrev(v, prev);
    }
    return out;
  }
  return raw;
}

/**
 * Parse a step's stored `args` JSON into the dispatcher's
 * `{tool, args}` shape. Returns null on a malformed step (kind
 * mismatch, missing tool name, etc.) so the walker can record a
 * failure trace rather than throw.
 */
function parseCallStep(
  step: StoredStep,
): { tool: string; args: Record<string, unknown> } | null {
  if (step.kind !== "call") return null;
  if (typeof step.args !== "object" || step.args === null) return null;
  const a = step.args as Record<string, unknown>;
  if (typeof a.tool !== "string" || a.tool.length === 0) return null;
  const inner =
    a.args !== undefined && typeof a.args === "object" && a.args !== null
      ? (a.args as Record<string, unknown>)
      : {};
  return { tool: a.tool, args: inner };
}

/**
 * Run a ToolSpec imperatively. Persists a ToolRun row and emits one
 * ActivityRow capturing the outcome.
 *
 * Caller is responsible for ordering steps by idx before passing them
 * in (routes/tools.ts uses `orderBy: { idx: "asc" }` in its include).
 */
export async function runToolSpec(
  prisma: PrismaClient,
  dispatcher: StepDispatcher,
  args: RunArgs,
): Promise<{ runId: string; outcome: RunOutcome }> {
  const trace: RunStepTrace[] = [];
  let prev: unknown = undefined;
  let outcome: RunOutcome = { status: "ok", trace, error: null };

  for (const step of args.steps) {
    const parsed = parseCallStep(step);
    if (!parsed) {
      const msg = `step ${step.idx}: malformed (kind=${step.kind})`;
      trace.push({
        idx: step.idx,
        tool: "(unknown)",
        args: {},
        ok: false,
        error: msg,
      });
      outcome = { status: "failed", trace, error: msg };
      break;
    }

    const resolvedArgs = resolvePrev(parsed.args, prev) as Record<
      string,
      unknown
    >;

    try {
      const result = await dispatcher.call(parsed.tool, resolvedArgs);
      trace.push({
        idx: step.idx,
        tool: parsed.tool,
        args: resolvedArgs,
        ok: true,
        result,
      });
      prev = result;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      trace.push({
        idx: step.idx,
        tool: parsed.tool,
        args: resolvedArgs,
        ok: false,
        error: msg,
      });
      outcome = {
        status: "failed",
        trace,
        error: `step ${step.idx} (${parsed.tool}): ${msg}`,
      };
      // Halt — no further steps attempted per the C1 contract.
      break;
    }
  }

  const endedAt = new Date();
  const run = (await prisma.toolRun.create({
    data: {
      specId: args.specId,
      triggeredBy: args.triggeredBy,
      endedAt,
      status: outcome.status as any,
      error: outcome.error,
      trace: outcome.trace as any,
    },
  })) as unknown as { id: string };

  await recordActivity({
    kind: "tool_run",
    severity: outcome.status === "ok" ? "ok" : "err",
    sourceIcon: "play",
    what:
      outcome.status === "ok"
        ? "Spec run completed"
        : "Spec run failed",
    sub: `${args.specName} (${outcome.trace.length} step(s))`,
    refs: {
      specId: args.specId,
      runId: run.id,
      stepCount: outcome.trace.length,
      status: outcome.status,
      triggeredBy: args.triggeredBy,
    },
  });

  if (outcome.status === "failed") {
    logger.warn(
      { runId: run.id, specId: args.specId, error: outcome.error },
      "tool spec run failed",
    );
  }

  return { runId: run.id, outcome };
}
