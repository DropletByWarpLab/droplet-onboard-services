/**
 * WARP-2897 (ADR-056 slice I-0) — the ONE way a routine (ToolSpec) draft is
 * validated and created.
 *
 * Extracted verbatim from `POST /api/tools` (routes/tools.ts), which is now
 * a thin caller. The reason is slice I-1: a promoted extension's toolset
 * seeds routine drafts, and they must pass exactly the checks a person's or
 * the model's `routine_draft` does — slug shape, step references, the
 * `writes` reconcile and unknown tools — not a second copy that drifts. The
 * PATCH route keeps using the step schema and helpers from here too.
 *
 * Behaviour is unchanged for every existing caller. The one widening is
 * OPTIONAL and unused by the route: {@link RuntimeToolSets} lets a caller
 * that knows a set of runtime tools (a toolset's own, at promote time) count
 * them as known and — unless classified read — as writes, so the draft's
 * `writes` flag is honest. The route passes none: the ToolSpec walker
 * dispatches through the local MCP child only (WARP-2894), so a routine
 * naming a runtime tool is still `unknown_tools` from a person or the model.
 *
 * A draft is ALWAYS born `status: "draft"`, written explicitly rather than
 * left to the schema default, so no caller's body can make one live.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { plannedToolNames, referencedStepNames } from "./tool-spec-runner.service.js";
import { unknownToolsIn, writeToolsIn } from "./tool-access.service.js";

// Per-tool slug shape — lowercase kebab, 2..80 chars. Tight enough to
// be URL-safe in `/api/tools/:slug` without escaping; loose enough for
// operator-typed names.
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * WARP-2670 — the name a step may publish its result under, for later steps
 * to read as `${steps.<name>}`. Lowercase snake so the reference syntax needs
 * no quoting or escaping, and so two names cannot differ only by case.
 */
const OUTPUT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const outputNameSchema = z.string().regex(OUTPUT_NAME_RE).optional();

/**
 * A step is either a tool CALL or — since WARP-1996 — a SUMMARIZE, which
 * turns what the earlier steps gathered into prose. `call` stays the default
 * so every spec authored before this keeps parsing unchanged.
 *
 * A summarize step names no tool: there is nothing for the §3 scope check to
 * authorize, and it can only read the trace the run already produced under
 * that check.
 */
const callStepSchema = z.object({
  kind: z.literal("call").default("call"),
  tool: z.string().min(1).max(64),
  args: z.record(z.unknown()).optional(),
  as: outputNameSchema,
  /** A failure of this step is recorded and the walk continues. */
  optional: z.boolean().optional(),
});

const summarizeStepSchema = z.object({
  kind: z.literal("summarize"),
  /** Optional framing; the runner supplies its default when absent. */
  prompt: z.string().min(1).max(4000).optional(),
  as: outputNameSchema,
});

/**
 * WARP-2895 — a `transform` step runs customer-written Python over the run's
 * named results in services/sandbox and publishes `output`; a `when` step is
 * the same call whose truthiness decides whether the walk continues. Neither
 * names a tool: nothing for the §3 scope check to authorize, nothing for the
 * `writes` derivation to count (`writeToolNamesIn` reads `plannedToolNames`,
 * which ignores both kinds — pinned by tool-spec-runner.transform.test.ts).
 *
 * `code` is bounded here at 64 KB (the service refuses more); `inputs` is an
 * object whose values may carry `${steps.x}` references.
 */
const transformStepSchema = z.object({
  kind: z.literal("transform"),
  code: z.string().min(1).max(64_000),
  inputs: z.record(z.unknown()).optional(),
  as: outputNameSchema,
});

const whenStepSchema = z.object({
  kind: z.literal("when"),
  code: z.string().min(1).max(64_000),
  inputs: z.record(z.unknown()).optional(),
  as: outputNameSchema,
});

export const stepSchema = z.union([callStepSchema, summarizeStepSchema, transformStepSchema, whenStepSchema]);

export type ParsedStep = z.infer<typeof stepSchema>;

/**
 * Shape a validated step for the `ToolStep.args` JSON column.
 *
 * The two kinds store different payloads, so this cannot be one literal:
 * a `call` keeps `{tool, args}` — the shape `parseCallStep` reads — and a
 * `summarize` keeps `{prompt}`. Writing a summarize step through the call
 * shape would persist `tool: undefined` and the runner would reject it as
 * malformed on the next run.
 */
export function storedArgsFor(s: ParsedStep): Record<string, unknown> {
  // WARP-2670 — `as` rides in the same JSON blob for both kinds. It is not a
  // column because `ToolStep.args` is Json and `kind` is a plain String, the
  // seam C1's schema comment already nominated for exactly this; a column
  // would cost a migration to store something only the walker reads.
  const named = s.as ? { as: s.as } : {};
  if (s.kind === "summarize") {
    return { ...(s.prompt ? { prompt: s.prompt } : {}), ...named };
  }
  if (s.kind === "transform" || s.kind === "when") {
    return { code: s.code, inputs: s.inputs ?? {}, ...named };
  }
  return { tool: s.tool, args: s.args ?? {}, ...(s.optional ? { optional: true } : {}), ...named };
}

/**
 * WARP-2670 — refuse a reference graph the runner could not satisfy.
 *
 * Three ways to write a spec that parses but cannot run:
 *   - two steps publishing the same name (the second silently shadows);
 *   - `${steps.x}` where nothing is named `x`;
 *   - `${steps.x}` where `x` is published by a LATER step, or by this one.
 *
 * The walker catches all three, but only on the first fire — and for a
 * scheduled spec the first fire is at 03:00 with nobody reading. Checking
 * here means the author is told while they are still looking at the step
 * they typed. This is the same argument the schedule routes make for
 * parsing an rrule at write time instead of auto-disabling it later.
 *
 * Paths are NOT checked: `${steps.invoices.0.total}` depends on what the
 * tool returns at run time, which authoring cannot know. Only the name
 * graph — which is static — is decided here.
 *
 * A summarize step's `prompt` is NOT scanned either. The runner hands the
 * prompt to the summarizer verbatim — it never runs `resolveRefs` over it —
 * so a `${steps.x}` inside prose is text, not a reference, and refusing it
 * here would enforce a contract the runtime does not implement. Only the
 * args a `call` step dispatches are resolved, so only those are checked.
 */
export function stepReferenceError(steps: ParsedStep[]): Record<string, unknown> | null {
  const published = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const scanned = step.kind === "summarize" ? {} : storedArgsFor(step);
    for (const ref of referencedStepNames(scanned)) {
      if (!published.has(ref)) {
        return {
          error: `Step ${i} refers to \${steps.${ref}}, which no earlier step publishes`,
          detail:
            "give the producing step an `as` name, and make sure it comes first",
          step: i,
          reference: ref,
        };
      }
    }
    if (step.as) {
      if (published.has(step.as)) {
        return {
          error: `Two steps publish the name "${step.as}"`,
          detail: "step output names must be unique within a spec",
          step: i,
          reference: step.as,
        };
      }
      published.add(step.as);
    }
  }
  return null;
}

/**
 * WARP-2665 — the write tools a step list actually calls.
 *
 * `ToolSpec.writes` gates two safety decisions: run-now's 409 confirmation
 * (`POST /tools/:slug/runs`) and the WARP-463 ticker's refusal to auto-fire a
 * `writes && !reversible` spec unattended. Until now it was whatever the
 * author put in the request body and was never checked against the steps, so
 * a spec calling a writing tool could be stored as `writes: false` and would
 * then fire with nobody watching. The ADR-004 write tier still applied at
 * fire time — this was never an escalation — but a gate that exists for
 * "destructive, and nobody is looking" was deciding on a self-declared field.
 *
 * Names come from `plannedToolNames`, the runner's OWN parser and the same one
 * the walker dispatches through, rather than a second reading of the step
 * shape that could drift from it. A step kind that dispatches no tool (today
 * `summarize`) contributes no name, so it can never make a spec look like it
 * writes — which is also what keeps a future non-dispatching kind correct here
 * without touching this function.
 *
 * `writeToolsIn` is the classification the ticker's gate and the miner read
 * too, against `WRITE_TOOLS` — derived from each tool's `requiresWrite` in
 * `@droplet/tools-core` — so a write tool added to the registry is classified
 * everywhere without anyone remembering to update a list.
 */
export function writeToolNamesIn(
  steps: ReadonlyArray<{ kind: string; args: unknown }>,
  /** WARP-2897 — runtime tool names to count as writes (a runtime tool is a
   *  write unless classified read). Omitted = compiled-only. */
  runtimeWrite?: ReadonlySet<string>,
): string[] {
  return writeToolsIn(plannedToolNames(steps), runtimeWrite);
}

/** Parsed request steps in the stored `{kind, args}` shape `plannedToolNames` reads. */
export function toStoredShape(
  steps: ParsedStep[],
): Array<{ kind: string; args: unknown }> {
  return steps.map((s) => ({ kind: s.kind, args: storedArgsFor(s) }));
}

/**
 * WARP-2665 — reconcile a declared `writes` against the derived one.
 *
 * Asymmetric on purpose. Declaring `writes: true` on a spec that calls no
 * write tool is a CONSERVATIVE disagreement: it can only add a confirmation
 * prompt and keep the scheduler's hands off, so it is accepted as authored.
 * Declaring `writes: false` on a spec that does call one is the only
 * direction that defeats a safety gate, and it is refused — loudly, at
 * authoring time while a human is present to read the error, rather than
 * silently at 03:00 when the schedule fires.
 *
 * Omitting the field derives it. That is what keeps existing clients and the
 * miner's draft→live promotion correct without asking either to change.
 */
export function reconcileWrites(
  declared: boolean | undefined,
  writeTools: string[],
): { ok: true; writes: boolean } | { ok: false; writeTools: string[] } {
  if (declared === false && writeTools.length > 0) {
    return { ok: false, writeTools };
  }
  return { ok: true, writes: declared === true ? true : writeTools.length > 0 };
}

/** The 400 body for a `writes: false` declaration the steps contradict. */
export function writesDisagreementBody(writeTools: string[]): Record<string, unknown> {
  return {
    error: "Declared writes:false, but these steps call write tools",
    detail:
      "omit `writes` to have it derived from the steps, or declare writes:true",
    writeTools,
  };
}

export const createSpecSchema = z.object({
  /** WARP-2894 — username the mcp principal acts for. Ignored for everyone else. */
  onBehalfOf: z.string().trim().min(1).max(200).optional(),
  slug: z.string().min(2).max(80).regex(SLUG_RE),
  name: z.string().min(1).max(200),
  category: z.string().max(64).optional(),
  description: z.string().max(2000).optional(),
  share: z.string().max(64).optional(),
  safety: z.number().int().min(1).max(3).optional(),
  writes: z.boolean().optional(),
  reversible: z.boolean().optional(),
  steps: z.array(stepSchema).min(1).max(32),
});

export type CreateSpecInput = Omit<z.infer<typeof createSpecSchema>, "onBehalfOf">;

/** Runtime tools a caller may declare known (and which of them write). */
export interface RuntimeToolSets {
  /** Runtime tool names to accept as known steps. */
  known?: ReadonlySet<string>;
  /** Of those, the ones to count as writes — every runtime tool whose
   *  classification row does not say read. */
  writes?: ReadonlySet<string>;
}

/** A refusal the route answers verbatim. */
export interface DraftSpecRefusal {
  status: 400 | 409;
  body: Record<string, unknown>;
}

/**
 * The POST /api/tools validators, in the route's order: unknown tools, the
 * step reference graph, then the `writes` reconcile. Pure.
 */
export function validateDraftSpec(
  input: CreateSpecInput,
  runtime: RuntimeToolSets = {},
): { ok: true; writes: boolean } | { ok: false; refusal: DraftSpecRefusal } {
  // WARP-2894 — a step naming a tool this box does not have is refused
  // here, where the author (a person or the model) can fix it, rather
  // than at the first run.
  const unknown = unknownToolsIn(
    input.steps.flatMap((st) => (st.kind === "call" ? [st.tool] : [])),
    runtime.known,
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: "unknown_tools",
          detail: "these steps name tools this box does not have",
          tools: unknown,
        },
      },
    };
  }
  // WARP-2670 — refuse a reference graph the walker could not satisfy.
  const refError = stepReferenceError(input.steps);
  if (refError) return { ok: false, refusal: { status: 400, body: refError } };

  // WARP-2665 — classify from the steps, not from the body.
  const reconciled = reconcileWrites(
    input.writes,
    writeToolNamesIn(toStoredShape(input.steps), runtime.writes),
  );
  if (!reconciled.ok) {
    return { ok: false, refusal: { status: 400, body: writesDisagreementBody(reconciled.writeTools) } };
  }
  return { ok: true, writes: reconciled.writes };
}

/** The Prisma surface a draft create needs — a client or a transaction. */
export type DraftSpecTx = Pick<Prisma.TransactionClient, "toolSpec">;

/**
 * A slug collision on create. THROWN, never returned: on Postgres a unique
 * violation aborts an interactive transaction, so nothing after it may run on
 * the same `tx` (25P02), and a `$transaction` callback that returns normally
 * commits an aborted transaction as a silent ROLLBACK. Throwing makes the one
 * safe move — unwind — the default. `refusal` is the 409 the route answers.
 */
export class DraftSlugTakenError extends Error {
  readonly refusal: DraftSpecRefusal;
  constructor(slug: string) {
    super(`tool spec slug already in use: ${slug}`);
    this.name = "DraftSlugTakenError";
    this.refusal = { status: 409, body: { error: "Slug already in use", slug } };
  }
}

/**
 * Validate, then create the draft with its ordered steps. `ownerId` is the
 * acting person's `User.id` (WARP-485 — never a username).
 *
 * Two failure shapes, split by whether the caller's transaction is still
 * usable:
 *   - a validation refusal is RETURNED (`{ok:false}`): no statement ran, the
 *     transaction is intact. A caller running several drafts in one
 *     transaction must still throw to roll the earlier ones back.
 *   - a slug collision (P2002) THROWS {@link DraftSlugTakenError}: the
 *     statement failed, the transaction is aborted, and the only correct
 *     move is to unwind. The route maps it to 409.
 */
export async function createDraftSpecTx<Row>(
  tx: DraftSpecTx,
  input: CreateSpecInput,
  ownerId: string,
  runtime: RuntimeToolSets = {},
): Promise<{ ok: true; spec: Row } | { ok: false; refusal: DraftSpecRefusal }> {
  const valid = validateDraftSpec(input, runtime);
  if (!valid.ok) return valid;
  try {
    const spec = (await tx.toolSpec.create({
      data: {
        slug: input.slug,
        name: input.name,
        category: input.category ?? null,
        description: input.description ?? null,
        share: input.share ?? null,
        safety: input.safety ?? 1,
        writes: valid.writes,
        reversible: input.reversible ?? true,
        // Explicit, never the schema default and never the body's.
        status: "draft",
        ownerId,
        steps: {
          create: input.steps.map((s, idx) => ({
            idx,
            kind: s.kind,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            args: storedArgsFor(s) as any,
          })),
        },
      },
      include: { steps: { orderBy: { idx: "asc" } } },
    })) as unknown as Row;
    return { ok: true, spec };
  } catch (err) {
    // Prisma surfaces unique-constraint violations as P2002 — "slug already
    // in use" for the dashboard. Thrown typed (see DraftSlugTakenError).
    if ((err as { code?: string }).code === "P2002") {
      throw new DraftSlugTakenError(input.slug);
    }
    throw err;
  }
}
