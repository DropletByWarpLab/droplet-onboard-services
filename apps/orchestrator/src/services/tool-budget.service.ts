/**
 * WARP-2440 / WARP-2445 — measuring the tool advertisement, and refusing to
 * ship one that does not fit.
 *
 * ── why this file exists ───────────────────────────────────────────
 *
 * `chat-tool-scope.ts` has carried the sentence "serializes to ~85K chars
 * (~21K tokens)" since the WARP-1423 rollout. Those tildes were good enough to
 * justify a hand-maintained exclusion list; they are not good enough to size a
 * selection strategy against, and by WARP-2348 they had drifted: the measured
 * figure is materially larger (see `tool-budget.service.test.ts`, which
 * re-derives it on every run rather than quoting it). Every number this
 * module compares against is computed from the shipping constants, so the
 * registry growing cannot leave a stale literal behind.
 *
 * ── the failure mode being designed out ────────────────────────────
 *
 * When an assembled prompt exceeds the window the tempting behaviour is to
 * trim tools until it fits. That is the worst outcome available: the agent
 * silently loses capability, nobody knows WHICH capability, and the resulting
 * degradation is attributed to model quality rather than to the budget. So
 * over-budget here is a typed, logged failure carrying the overage — never a
 * shortened `tools[]`. There is no truncation path in this file, and
 * `tool-budget.service.test.ts` asserts the failure rather than a shortened
 * prompt.
 *
 * The runtime overflow gate (`estimateRequestTokens` / `degradeToFit`) still
 * owns pins, attachments and history. This module owns exactly one term of
 * that sum — the serialised `tools[]` — because that is the term per-turn
 * selection controls.
 */
import {
  estimateTokensFromChars,
  DEFAULT_CONTEXT_WINDOW,
} from "./context-budget.service.js";
import {
  PERSONA_PROMPT_MAX_CHARS,
  BUSINESS_CONTEXT_MAX_CHARS,
  INTERVIEW_PROMPT_MAX_CHARS,
  TOOL_GUIDANCE_MAX_CHARS,
  OUTPUT_RESERVE,
} from "./prompt-budget.consts.js";
import { IDENTITY_MAX_CHARS } from "./identity-prompt.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tool-budget");

/**
 * `buildMemoryFactsBlock`'s MEMORY_FACTS_CHAR_BUDGET (routes/llm.ts). The
 * const is route-local and unexported, so it is mirrored here to keep the
 * fixed-block sum complete. A change to the route budget must update this in
 * lockstep — `base-prompt-budget.test.ts` pins the total, so a drift shows up
 * as a red canary rather than as a quietly wrong ceiling.
 */
export const MEMORY_FACTS_CHAR_BUDGET = 2000;

/**
 * Worst-case sum of every FIXED system-prompt block, in chars.
 *
 * Composed from the shipping constants rather than restated as a literal:
 * identity + persona + business + tool guidance + memory facts + interview.
 * `base-prompt-budget.test.ts` asserts this equals 11800 and stays under
 * `BASE_PROMPT_MAX_CHARS`, so the two files cannot drift apart.
 */
export const FIXED_SYSTEM_BLOCK_CHARS =
  IDENTITY_MAX_CHARS +
  PERSONA_PROMPT_MAX_CHARS +
  BUSINESS_CONTEXT_MAX_CHARS +
  TOOL_GUIDANCE_MAX_CHARS +
  MEMORY_FACTS_CHAR_BUDGET +
  INTERVIEW_PROMPT_MAX_CHARS;

/** The wire shape a tool takes in an OpenAI-style `tools[]` array. */
export interface AdvertisedToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

/** A measured serialisation: what it costs, and over how many tools. */
export interface ToolAdvertisementSize {
  count: number;
  chars: number;
  tokens: number;
}

/** Serialise an advertisement exactly as the agent loop puts it on the wire. */
export function serializeToolSpecs(specs: readonly AdvertisedToolSpec[]): string {
  return JSON.stringify(specs);
}

/** Measure an advertisement: tool count, serialised chars, estimated tokens. */
export function measureToolSpecs(
  specs: readonly AdvertisedToolSpec[],
): ToolAdvertisementSize {
  const chars = serializeToolSpecs(specs).length;
  return {
    count: specs.length,
    chars,
    tokens: estimateTokensFromChars(chars),
  };
}

/** Build the wire spec for anything carrying a name/description/schema —
 *  registry `Tool`s and runtime descriptors alike. */
export function toAdvertisedSpec(tool: {
  name: string;
  description: string;
  inputSchema: unknown;
}): AdvertisedToolSpec {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * How many tokens the serialised `tools[]` may occupy on a turn.
 *
 * DERIVED, never hand-picked (WARP-2445: "the budget compared against is the
 * measured figure … not a hand-picked constant"):
 *
 *     window − OUTPUT_RESERVE − tokens(fixed system blocks)
 *
 * `window` is the READ value of `OLLAMA_CONTEXT_LENGTH` — the caller passes
 * `config.OLLAMA_CONTEXT_LENGTH`, defaulting to `DEFAULT_CONTEXT_WINDOW`.
 * Never infer the runtime from the variable's name: boxes provisioned after
 * 2026-08-11 run Docker Model Runner on :12434 (ADR-036 / WARP-1870) and carry
 * the window in that same variable.
 *
 * Note what this ceiling does NOT reserve: conversation history and tool
 * RESULTS. A turn is allowed to spend its whole non-fixed budget on tool
 * schemas here; the runtime `degradeToFit` gate is what protects history. The
 * split is deliberate — this module's job is to make an impossible
 * advertisement loud, not to second-guess the runtime estimator.
 */
export function toolAdvertisementCeilingTokens(opts?: {
  contextWindow?: number;
  fixedBlockChars?: number;
}): number {
  const window = opts?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const fixedChars = opts?.fixedBlockChars ?? FIXED_SYSTEM_BLOCK_CHARS;
  return Math.max(
    0,
    window - OUTPUT_RESERVE - estimateTokensFromChars(fixedChars),
  );
}

/**
 * Typed failure for an advertisement that does not fit. Carries the numbers a
 * reader needs to act — how big, how much too big, over how many tools, and
 * which tools — so the cause is diagnosable from one log line rather than from
 * a reproduction (WARP-2445: "the failure names how far over budget the
 * selection was").
 */
export class ToolBudgetExceededError extends Error {
  readonly name = "ToolBudgetExceededError";
  readonly code = "TOOL_BUDGET_EXCEEDED";
  readonly toolCount: number;
  readonly chars: number;
  readonly tokens: number;
  readonly ceilingTokens: number;
  readonly overageTokens: number;
  readonly contextWindow: number;
  /** Largest-first, so the first names are the ones worth trimming. */
  readonly largestTools: readonly { name: string; chars: number }[];

  constructor(input: {
    size: ToolAdvertisementSize;
    ceilingTokens: number;
    contextWindow: number;
    largestTools: readonly { name: string; chars: number }[];
  }) {
    const overage = input.size.tokens - input.ceilingTokens;
    super(
      `tool advertisement is ${input.size.tokens} tokens ` +
        `(${input.size.chars} chars over ${input.size.count} tools) against a ` +
        `${input.ceilingTokens}-token ceiling — ${overage} tokens over budget. ` +
        `Context window ${input.contextWindow}, output reserve ${OUTPUT_RESERVE}, ` +
        `fixed blocks ${FIXED_SYSTEM_BLOCK_CHARS} chars. Largest tools: ` +
        input.largestTools
          .slice(0, 5)
          .map((t) => `${t.name} (${t.chars})`)
          .join(", "),
    );
    this.toolCount = input.size.count;
    this.chars = input.size.chars;
    this.tokens = input.size.tokens;
    this.ceilingTokens = input.ceilingTokens;
    this.overageTokens = overage;
    this.contextWindow = input.contextWindow;
    this.largestTools = input.largestTools;
  }
}

/** Per-tool serialised sizes, largest first — the naming half of a failure. */
export function toolSpecSizes(
  specs: readonly AdvertisedToolSpec[],
): { name: string; chars: number }[] {
  return specs
    .map((s) => ({ name: s.function.name, chars: JSON.stringify(s).length }))
    .sort((a, b) => b.chars - a.chars);
}

/**
 * Assert that an assembled advertisement fits, and THROW loudly if it does
 * not. Returns the measured size on success so callers can log it.
 *
 * There is deliberately no `truncate` option and no "trim to fit" branch: an
 * over-budget advertisement is a bug in selection or in the registered tool
 * set, and the only honest response is to surface it. A caller that catches
 * this and drops tools anyway has re-introduced exactly the silent capability
 * loss WARP-2348 exists to prevent.
 */
export function assertToolAdvertisementFitsBudget(opts: {
  specs: readonly AdvertisedToolSpec[];
  contextWindow?: number;
  fixedBlockChars?: number;
  /** Free-form context stamped on the log line (conversation id, mode…). */
  logContext?: Record<string, unknown>;
  /** Injected for tests, so the log CALL is assertable rather than merely
   *  believed. Production omits it and the module logger is used. */
  errorLog?: (fields: Record<string, unknown>, msg: string) => void;
}): ToolAdvertisementSize {
  const size = measureToolSpecs(opts.specs);
  const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const ceilingTokens = toolAdvertisementCeilingTokens({
    contextWindow,
    fixedBlockChars: opts.fixedBlockChars,
  });
  if (size.tokens <= ceilingTokens) return size;

  const err = new ToolBudgetExceededError({
    size,
    ceilingTokens,
    contextWindow,
    largestTools: toolSpecSizes(opts.specs),
  });
  const emit =
    opts.errorLog ??
    ((fields: Record<string, unknown>, msg: string) => logger.error(fields, msg));
  emit(
    {
      ...opts.logContext,
      toolCount: size.count,
      chars: size.chars,
      tokens: size.tokens,
      ceilingTokens,
      overageTokens: err.overageTokens,
      contextWindow,
      largestTools: err.largestTools.slice(0, 5),
    },
    "tool_budget_exceeded",
  );
  throw err;
}
