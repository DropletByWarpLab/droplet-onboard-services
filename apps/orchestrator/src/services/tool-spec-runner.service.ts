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
 *
 * WARP-1580 — ACCESS. The walker reaches the same MCP registry chat does, so
 * it must honour the same WARP-1529 (RBAC v2 T5) per-role tool narrowing.
 * `RunArgs.scope` carries the caller's (or, for a scheduled fire, the
 * attributed creator's) resolved §3 reach and is enforced HERE, at the one
 * choke point both surfaces share:
 *
 *   - PRE-FLIGHT, before step 0 dispatches: the whole step list is checked
 *     with `firstForbiddenToolName`. A spec containing ANY out-of-reach tool
 *     is refused whole. Refusing at step N instead would leave steps 0..N-1
 *     already executed — a half-applied automation is worse than a refused
 *     one, and the caller cannot undo it.
 *   - PER-STEP, immediately before each `dispatcher.call`: the full
 *     `toolDispatchDenial`, including the args-dependent §3 lock rule. NOT
 *     redundant with the pre-flight — `${prev}` substitution means a step's
 *     real args do not exist until the previous step returns, so a
 *     lock-flavoured invocation can only be seen here.
 *
 * `scope` omitted or `null` = no §3 narrowing applies (the §3 owner bypass,
 * service principals, and every user with no AccessRole, i.e. every user on a
 * box today). On that path this file behaves byte-for-byte as it did before.
 * Callers that cannot attribute a run pass `DENY_ALL_TOOL_SCOPE`, never
 * `null` — "I couldn't check" must not resolve to "full reach".
 *
 * WARP-1621 — WHAT THIS FILE DOES *NOT* ENFORCE, deliberately: the ADR-004
 * coarse WRITE-TIER axis. Both entry points (routes/tools.ts run-now and the
 * WARP-463 ticker) apply it in their pre-flight, via the same
 * `firstToolDeniedForPrincipal` in tool-access.service.ts, because that axis
 * is NAME-only — and a spec's tool names are static, so a whole-list
 * pre-flight decides it completely. Re-checking it here would buy nothing a
 * second `scope`-shaped parameter didn't already risk: an optional `tier`
 * would fail OPEN for any caller that forgot it, which is a worse floor than
 * an explicit one. The per-step gate below stays for the rule a pre-flight
 * genuinely cannot decide — the §3 lock rule, whose args only exist after
 * `${prev}` substitution.
 */
import type { PrismaClient } from "@prisma/client";
import { recordActivity } from "./activity.singleton.js";
import {
  firstForbiddenToolName,
  toolDispatchDenial,
  type ToolAccessScope,
} from "./tool-access.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tool-spec-runner");

export interface StepDispatcher {
  /** Returns the parsed tool result (any JSON shape). Throws on failure. */
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * WARP-1996 — the `summarize` step's seam.
 *
 * A spec could previously only CALL tools; there was no way to turn what it
 * gathered into prose. That is the whole shape of a daily report, so the
 * step model gains its second kind. The Prisma comment on ToolStep already
 * anticipated this ("future kinds may include branch, wait") and `kind` is a
 * plain String column, so no migration is involved.
 *
 * Injected rather than imported so the walk stays testable without an
 * inference backend, exactly like `StepDispatcher`.
 */
export interface Summarizer {
  /**
   * `facts` is the run's trace SO FAR — the results the earlier steps
   * gathered. Returns the prose. Throws on failure, which the walk records
   * as a failed step like any other.
   */
  summarize(prompt: string, facts: RunStepTrace[]): Promise<string>;
}

/** The trace's `tool` slot for a step that calls no tool. Reserved rather
 *  than blank so a reader (and the Activity row) can tell what ran. */
export const SUMMARIZE_PSEUDO_TOOL = "(summarize)";

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
  /**
   * WARP-1580 — set when the run was refused on ACCESS rather than failing on
   * execution. Lets callers answer 403 instead of 207 without re-deriving the
   * reason from the error string.
   */
  denialCode?: "FORBIDDEN_TOOL_FOR_ROLE" | "LOCK_OPERATION_NOT_PERMITTED";
}

interface RunArgs {
  specId: string;
  specName: string;
  steps: StoredStep[];
  triggeredBy: string | null;
  /**
   * WARP-1996 — required only by specs containing a `summarize` step. When a
   * spec has one and this is absent the step fails honestly rather than
   * silently producing nothing: a report that quietly skipped its narrative
   * would look like a report with nothing to say.
   */
  summarizer?: Summarizer | null;
  /**
   * WARP-1580 — the resolved §3 tool reach this run executes under. `null` /
   * omitted = no narrowing (owner, service, role-less). Never pass `null` to
   * mean "unknown"; pass `DENY_ALL_TOOL_SCOPE`.
   */
  scope?: ToolAccessScope | null;
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
  step: { kind: string; args: unknown },
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
 * WARP-1996 — parse a `summarize` step. `args.prompt` is optional; a spec
 * that omits it gets the default framing.
 *
 * Returns null for any other kind, so the caller can fall through to the
 * malformed handling that already existed.
 */
function parseSummarizeStep(step: { kind: string; args: unknown }): { prompt: string } | null {
  if (step.kind !== "summarize") return null;
  const a =
    typeof step.args === "object" && step.args !== null
      ? (step.args as Record<string, unknown>)
      : {};
  const prompt = typeof a.prompt === "string" && a.prompt.trim() ? a.prompt : DEFAULT_SUMMARY_PROMPT;
  return { prompt };
}

/**
 * The default framing. Deliberately instructs the model to name gaps rather
 * than omit them — a report that silently drops the half it couldn't read is
 * the failure mode this whole surface is built against.
 */
export const DEFAULT_SUMMARY_PROMPT =
  "Write a short briefing, in the second person, from the results above. " +
  "Two to five short paragraphs of prose — no bullet points, no headings. " +
  "Use only figures that appear in the results; never estimate or infer a " +
  "number. If something could not be read, say so plainly in one clause " +
  "rather than leaving it out.";

/**
 * WARP-1580 — the tool names a spec's steps will call, in step order.
 *
 * Exported so the run-now route can pre-flight the SAME names the walker
 * will, off the SAME parser. A malformed step contributes no name: it is an
 * execution problem (handled inside the walk, with its own trace entry), not
 * an authorization one, and coercing it to a sentinel would turn a typo into
 * a confusing 403.
 */
export function plannedToolNames(
  steps: ReadonlyArray<{ kind: string; args: unknown }>,
): string[] {
  return steps
    .map((step) => parseCallStep(step)?.tool)
    .filter((tool): tool is string => typeof tool === "string");
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

  // ── WARP-1580 pre-flight: refuse a forbidden spec WHOLE ──────────
  //
  // Malformed steps contribute no name and fall through to the existing
  // per-step malformed handling below — a spec that is both malformed and
  // forbidden is still refused here, because the forbidden name is what the
  // filter kept.
  const forbiddenTool = firstForbiddenToolName(
    plannedToolNames(args.steps),
    args.scope,
  );
  if (forbiddenTool !== null) {
    const idx =
      args.steps.find((step) => parseCallStep(step)?.tool === forbiddenTool)?.idx ?? 0;
    const msg =
      `step ${idx} (${forbiddenTool}): not permitted by this run's access role`;
    trace.push({ idx, tool: forbiddenTool, args: {}, ok: false, error: msg });
    outcome = {
      status: "failed",
      trace,
      error: msg,
      denialCode: "FORBIDDEN_TOOL_FOR_ROLE",
    };
  }

  // Zero steps walked when the pre-flight refused — nothing dispatches.
  const stepsToWalk = forbiddenTool === null ? args.steps : [];

  for (const step of stepsToWalk) {
    // WARP-1996 — `summarize` is checked BEFORE the malformed guard, which
    // treats every non-"call" kind as malformed. It dispatches no tool, so
    // it is outside the §3 scope check by construction: there is nothing to
    // authorize. What it reads is the trace this run already gathered under
    // that check, so it can never widen the run's reach.
    const summarizeStep = parseSummarizeStep(step);
    if (summarizeStep) {
      if (!args.summarizer) {
        // Fail rather than skip. A report that quietly dropped its narrative
        // would render as a report with nothing to say.
        const msg = `step ${step.idx}: summarize step but no summarizer configured`;
        trace.push({
          idx: step.idx,
          tool: SUMMARIZE_PSEUDO_TOOL,
          args: {},
          ok: false,
          error: msg,
        });
        outcome = { status: "failed", trace, error: msg };
        break;
      }
      try {
        // The facts are the trace SO FAR — a copy, so the summarizer cannot
        // mutate the run's own record of what happened.
        const prose = await args.summarizer.summarize(summarizeStep.prompt, [...trace]);
        trace.push({
          idx: step.idx,
          tool: SUMMARIZE_PSEUDO_TOOL,
          args: { prompt: summarizeStep.prompt },
          ok: true,
          result: prose,
        });
        prev = prose;
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        trace.push({
          idx: step.idx,
          tool: SUMMARIZE_PSEUDO_TOOL,
          args: { prompt: summarizeStep.prompt },
          ok: false,
          error: msg,
        });
        outcome = { status: "failed", trace, error: `step ${step.idx} (summarize): ${msg}` };
        break;
      }
      continue;
    }

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

    // WARP-1580 — the boundary. Same predicate the agent loop runs before
    // `mcp.callTool`, applied to the args this step will ACTUALLY send: only
    // now, after `${prev}` substitution, can the §3 lock rule see them.
    const denial = toolDispatchDenial(parsed.tool, resolvedArgs, args.scope);
    if (denial) {
      trace.push({
        idx: step.idx,
        tool: parsed.tool,
        args: resolvedArgs,
        ok: false,
        error: denial.message,
      });
      outcome = {
        status: "failed",
        trace,
        error: `step ${step.idx} (${parsed.tool}): ${denial.message}`,
        denialCode: denial.code,
      };
      break;
    }

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
    // WARP-1580 — an access refusal is `warn`, not `err`: nothing broke, the
    // system did exactly what it was told to. Matches the ticker's own
    // skip-gate severity so the two refusal paths read alike in the feed.
    severity:
      outcome.status === "ok" ? "ok" : outcome.denialCode ? "warn" : "err",
    sourceIcon: outcome.denialCode ? "shield" : "play",
    // WARP-181: spec runs execute through the tool dispatcher (agent
    // surface); RunArgs carries no user UUID today, so id stays null.
    actor: { type: "ai", id: null },
    what:
      outcome.status === "ok"
        ? "Spec run completed"
        : outcome.denialCode
          ? "Spec run refused (access)"
          : "Spec run failed",
    sub: `${args.specName} (${outcome.trace.length} step(s))`,
    refs: {
      specId: args.specId,
      runId: run.id,
      stepCount: outcome.trace.length,
      status: outcome.status,
      triggeredBy: args.triggeredBy,
      // WARP-1580 — present only on an access refusal, so the Activity feed
      // distinguishes "your role does not permit this" from "the tool broke".
      ...(outcome.denialCode ? { reason: outcome.denialCode } : {}),
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
