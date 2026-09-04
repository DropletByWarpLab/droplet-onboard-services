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
 *     `${prev}` template substitution (the entire previous result JSON).
 *   - WARP-2670: a step may also publish its result under a name
 *     (`args.as`), which any LATER step reads as `${steps.<name>}` or
 *     `${steps.<name>.<path>}` — dotted, with numeric segments indexing
 *     arrays. This is what lets step 3 see step 1; with `${prev}` alone a
 *     spec is a pipeline, and anything needing two earlier results had to
 *     collapse into a single tool call.
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
  /** WARP-2670 — the name this step's result was published under, when it
   *  was given one. Present in the trace so the run-detail drawer can show
   *  which step a later `${steps.x}` was actually reading. */
  as?: string;
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
 * WARP-2670 — a reference that named a step, or a path inside one, that the
 * run cannot supply. Thrown by `resolveRefs` and caught by the walk, which
 * records it as an ordinary failed step rather than letting it escape.
 */
export class StepReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepReferenceError";
  }
}

/** `${steps.<name>}` / `${steps.<name>.<path>.<into>}`. */
const STEP_REF_RE = /^\$\{steps\.([a-z][a-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\}$/;

/**
 * Read a dotted path out of a step result.
 *
 * Numeric segments index arrays, so `${steps.invoices.0.id}` works without a
 * second syntax. A missing key is distinguished from a present-but-null value
 * with own-property / bounds checks: `null` is a legitimate result a spec may
 * want to pass on, and treating it as "missing" would fail runs that are fine.
 * Strict on both axes: a segment is an index only if it is ALL digits, and a
 * key only if the object OWNS it — nothing inherited, nothing prefix-parsed.
 */
function readPath(
  root: unknown,
  segments: string[],
): { ok: true; value: unknown } | { ok: false; at: string } {
  let cur = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const here = segments.slice(0, i + 1).join(".");
    if (Array.isArray(cur)) {
      // The WHOLE segment must be digits. `Number.parseInt("5abc")` is 5, so
      // a typo'd `${steps.r.rows.5abc}` would silently read row 5 — the exact
      // "silent undefined reaching a tool" class this file refuses to
      // tolerate, just one row over.
      const idx = Number.parseInt(seg, 10); // MUTANT
      if (idx >= cur.length) return { ok: false, at: here };
      cur = cur[idx];
      continue;
    }
    if (
      typeof cur === "object" &&
      cur !== null &&
      Object.prototype.hasOwnProperty.call(cur, seg)
    ) {
      // Own properties only. `"constructor" in {}` is true, so the `in`
      // operator would resolve `${steps.r.constructor}` to a function and
      // forward it into the next tool's args instead of failing the step.
      cur = (cur as Record<string, unknown>)[seg];
      continue;
    }
    return { ok: false, at: here };
  }
  return { ok: true, value: cur };
}

/**
 * The results a step may refer to: the immediately previous one, and every
 * earlier step that was given a name.
 */
export interface RefContext {
  prev: unknown;
  named: ReadonlyMap<string, unknown>;
}

/**
 * WARP-2670 — resolve template references in a step's args.
 *
 * Two forms, and the distinction between them is deliberate:
 *
 *   `${prev}`               — the whole previous result. UNCHANGED from C1,
 *                             including the fact that step 0 resolves it to
 *                             `undefined` rather than failing. Existing specs
 *                             keep behaving byte-for-byte; making the old form
 *                             strict would break stored programs written
 *                             against the documented v1 semantics.
 *   `${steps.name.path}`    — a NAMED earlier result, optionally indexed into.
 *                             Strict: an unknown name or an unreadable path
 *                             fails the step. This form is new, so there is no
 *                             history to preserve, and a silent `undefined`
 *                             reaching a tool as an argument is exactly the
 *                             class of bug the summarizer contract already
 *                             refuses to tolerate elsewhere in this file.
 *
 * Named results are what lift a spec from a pipeline to a procedure: with
 * `${prev}` alone, step 3 cannot see step 1, so anything that needs two
 * earlier results has to be one giant tool call.
 *
 * Substitution stays STRUCTURAL — a string equal to exactly `${...}` becomes
 * the value; any other string is returned as-is. No partial-string
 * interpolation, for the same reason C1 gave: surprise stringification of an
 * object into the middle of a sentence.
 */
function resolveRefs(raw: unknown, ctx: RefContext): unknown {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === "string") {
    if (raw === "${prev}") return ctx.prev;
    const m = STEP_REF_RE.exec(raw);
    if (!m) return raw;
    const [, name, rest] = m;
    if (!ctx.named.has(name)) {
      throw new StepReferenceError(
        `no earlier step is named "${name}" (referenced as ${raw})`,
      );
    }
    const segments = rest ? rest.slice(1).split(".") : [];
    const read = readPath(ctx.named.get(name), segments);
    if (!read.ok) {
      throw new StepReferenceError(
        `step "${name}" has no value at "${read.at}" (referenced as ${raw})`,
      );
    }
    return read.value;
  }
  if (Array.isArray(raw)) {
    return raw.map((v) => resolveRefs(v, ctx));
  }
  if (typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = resolveRefs(v, ctx);
    }
    return out;
  }
  return raw;
}

/**
 * WARP-2670 — every `${steps.X}` name a step's args refer to.
 *
 * Exported so the create/patch routes can refuse a forward or unknown
 * reference at AUTHORING time. The runner would catch it too, but only on the
 * first fire — which for a scheduled spec is at 03:00 with nobody reading.
 */
export function referencedStepNames(raw: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof raw === "string") {
    const m = STEP_REF_RE.exec(raw);
    if (m) into.add(m[1]);
    return into;
  }
  if (Array.isArray(raw)) {
    for (const v of raw) referencedStepNames(v, into);
    return into;
  }
  if (typeof raw === "object" && raw !== null) {
    for (const v of Object.values(raw as Record<string, unknown>)) {
      referencedStepNames(v, into);
    }
  }
  return into;
}

/**
 * The output name a stored step was given, if any. Lives inside `args` rather
 * than in its own column: `ToolStep.args` is a Json blob and `kind` is a plain
 * String, which the C1 schema comment already nominates as the extension seam
 * ("future kinds may include branch, wait"). No migration.
 */
export function stepOutputName(step: { args: unknown }): string | null {
  if (typeof step.args !== "object" || step.args === null) return null;
  const as = (step.args as Record<string, unknown>).as;
  return typeof as === "string" && as.length > 0 ? as : null;
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
  // WARP-2670 — results published by earlier steps that carried an `as` name.
  // Only successful steps land here: a failed step halts the walk, so nothing
  // downstream can read a result that was never produced.
  const named = new Map<string, unknown>();
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
        const outName = stepOutputName(step);
        trace.push({
          idx: step.idx,
          tool: SUMMARIZE_PSEUDO_TOOL,
          args: { prompt: summarizeStep.prompt },
          ok: true,
          result: prose,
          ...(outName ? { as: outName } : {}),
        });
        if (outName) named.set(outName, prose);
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

    // WARP-2670 — a bad `${steps.x}` reference is a step failure, not a
    // thrown request. It is recorded like any other so the run-detail drawer
    // can say "step 2 of 5 failed: no earlier step is named ..." instead of
    // surfacing a 500 with no trace at all.
    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveRefs(parsed.args, { prev, named }) as Record<
        string,
        unknown
      >;
    } catch (err) {
      if (!(err instanceof StepReferenceError)) throw err;
      const msg = `step ${step.idx} (${parsed.tool}): ${err.message}`;
      trace.push({
        idx: step.idx,
        tool: parsed.tool,
        args: {},
        ok: false,
        error: err.message,
      });
      outcome = { status: "failed", trace, error: msg };
      break;
    }

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
      const outName = stepOutputName(step);
      trace.push({
        idx: step.idx,
        tool: parsed.tool,
        args: resolvedArgs,
        ok: true,
        result,
        ...(outName ? { as: outName } : {}),
      });
      if (outName) named.set(outName, result);
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
