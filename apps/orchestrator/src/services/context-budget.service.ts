/**
 * WARP-1118 — request-size estimator + degradation trigger (§10).
 *
 * THE Phase-0 gate. Static per-block char caps (identity 4000, persona 1200,
 * business 1500, memory-facts 2000; see prompt-budget.consts.ts) are
 * necessary but NOT sufficient: chars ≠ tokens, and the serialized `tools[]`
 * schemas / pins / attachments / history live in no block. So we size the
 * WHOLE assembled request in tokens and, when it would overflow the effective
 * window, degrade DETERMINISTICALLY (§10 degradation ranks):
 *   1. drop the business block (Phase 2)
 *   2. drop the persona block
 *   3. hand off to the existing history/attachment trimming
 * Each drop emits a structured warning. Identity, tool guidance, and the
 * interview conductor block are never dropped.
 *
 * WINDOW (corrected 2026-07-08): the bundled single-box Ollama already runs
 * `OLLAMA_CONTEXT_LENGTH=16384` (docker-compose.yml, the WARP-854 fix — the
 * owner-role tool schemas alone overflow Ollama's own 4096 default, which
 * surfaced as instant empty chat answers). The orchestrator reads that same
 * value (config.OLLAMA_CONTEXT_LENGTH) and passes it in as `contextWindow`.
 * At 16384 nothing normally drops — this degradation path is defense-in-depth
 * for a future wider tool list / long-history turn, not a routine occurrence.
 *
 * The estimator is intentionally conservative and provider-agnostic: a
 * ~4-chars-per-token heuristic (matching the codebase's "12k chars ≈ 3k
 * tokens" note in routes/llm.ts) rounding UP, so we under-fill rather than
 * over-fill the real window.
 */
import { OUTPUT_RESERVE, ITERATION_MIN_HEADROOM } from "./prompt-budget.consts.js";

/**
 * The shipping single-box context window (tokens). Mirrors the
 * `OLLAMA_CONTEXT_LENGTH` default in docker-compose.yml + config.ts, and is
 * the value the estimator's own tests pin against. Production passes
 * config.OLLAMA_CONTEXT_LENGTH explicitly; this is the fallback + the
 * documented default.
 */
export const DEFAULT_CONTEXT_WINDOW = 16384;

/** Chars per token for the estimate heuristic. */
const CHARS_PER_TOKEN = 4;

/**
 * WARP-2851 — the ai-gateway's total-message-content cap, in chars.
 *
 * `services/ai-gateway/schemas.py` `_MAX_TOTAL_CONTENT_CHARS`, enforced
 * fail-closed by `_validate_total_content` → FastAPI 422. Restated here
 * because this module is TypeScript and that one is Python; the two are held
 * in step by `context-window-ceiling.guard.test.ts`, which READS the Python
 * file rather than trusting this literal.
 */
export const GATEWAY_MAX_TOTAL_CONTENT_CHARS = 128_000;

/**
 * WARP-2851 — the largest window the orchestrator will budget against, however
 * large a window the model catalogue advertises.
 *
 * DERIVED, not hand-picked. A model's own window is not the binding constraint
 * on this box: every request goes through the ai-gateway, which refuses more
 * than `GATEWAY_MAX_TOTAL_CONTENT_CHARS` of message content. So budgeting a
 * 200,000-token model at 200,000 does not unlock 200,000 tokens — it unlocks a
 * 422, and it does so by DISABLING the graceful stop that would otherwise have
 * fired first:
 *
 *   in-loop guard trips at   window − OUTPUT_RESERVE − ITERATION_MIN_HEADROOM
 *   gateway refuses at       tokens(GATEWAY_MAX_TOTAL_CONTENT_CHARS)
 *
 * Setting the ceiling where those two meet keeps the guard strictly ahead of
 * the refusal, so an over-long turn still ends with "answer now from what you
 * have" rather than a failed turn. The loop's estimate is
 * `JSON.stringify(messages)`, which over-counts against the gateway's
 * text-only sum, so in practice the guard fires earlier still — conservative
 * in the safe direction.
 *
 * Deliberately NOT an env knob. A ceiling an operator can raise above the
 * gateway's cap re-introduces exactly the 422 this prevents, and one they can
 * lower is already expressible as `OLLAMA_CONTEXT_LENGTH` for the local model.
 */
export const MAX_RESOLVABLE_CONTEXT_WINDOW =
  Math.ceil(GATEWAY_MAX_TOTAL_CONTENT_CHARS / CHARS_PER_TOKEN) +
  OUTPUT_RESERVE +
  ITERATION_MIN_HEADROOM;

/** Where a turn's budgeted window came from — stamped on the log line so a
 *  wrong budget is diagnosable without reproducing the turn. */
export type ContextWindowSource =
  /** The model catalogue published a window and it fit under the ceiling. */
  | "catalogue"
  /** The catalogue published a window larger than the gateway can carry. */
  | "catalogue_capped"
  /** No published window (every local model, an unknown id, or a gateway
   *  the client could not reach) — the operator's local setting stands. */
  | "local_default";

export interface ResolvedContextWindow {
  window: number;
  source: ContextWindowSource;
  /** What the catalogue said, for the log line. `null` when it said nothing. */
  advertised: number | null;
}

/**
 * WARP-2851 — how many tokens THIS turn's model can actually carry.
 *
 * Before this, every budget site passed `config.OLLAMA_CONTEXT_LENGTH`
 * regardless of provider, so a 200,000-token cloud model was budgeted at
 * 16,384: the tool advertisement ceiling threw, `degradeToFit` dropped the
 * business, persona and brain blocks, and the in-loop guard cut the turn short
 * — all with ~92% of the window unused.
 *
 * Fail-safe direction is DOWN. Anything the catalogue cannot vouch for
 * (absent, null, non-finite, zero or negative) resolves to the local window,
 * because over-stating a window is the WARP-854 overflow and under-stating it
 * only costs headroom.
 */
export function resolveTurnContextWindow(opts: {
  /** `getModelContextWindow()` for the model that will actually run. */
  advertised: number | null | undefined;
  /** `config.OLLAMA_CONTEXT_LENGTH` — the deployed local runtime's window. */
  localWindow: number;
  /** Test seam; production takes the derived ceiling. */
  ceiling?: number;
}): ResolvedContextWindow {
  const ceiling = opts.ceiling ?? MAX_RESOLVABLE_CONTEXT_WINDOW;
  const advertised = opts.advertised;
  if (
    typeof advertised !== "number" ||
    !Number.isFinite(advertised) ||
    advertised <= 0
  ) {
    return { window: opts.localWindow, source: "local_default", advertised: null };
  }
  // A catalogue window BELOW the local setting is still authoritative: it is a
  // real property of a real model, and honouring it is what stops us
  // over-filling a small cloud model.
  if (advertised > ceiling) {
    return { window: ceiling, source: "catalogue_capped", advertised };
  }
  return { window: advertised, source: "catalogue", advertised };
}

/**
 * Every char-bearing component of the assembled chat request. The route
 * builds these strings (or their serialized form, for tools[]) and hands
 * them here — the estimator stays a pure function with no Prisma / no I/O.
 */
export interface RequestSizeParts {
  /** Identity core (+ tool guidance, folded in by the route) — never dropped. */
  identityBlock: string;
  /** Persona style block — dropped 2nd. */
  personaBlock: string;
  /** Role-filtered business block — dropped 1st (Phase 2; "" until then). */
  businessBlock: string;
  /** Tool-guidance bullets, when the route passes them separately — never
   *  dropped. (The route currently folds these into identityBlock.) */
  toolGuidance: string;
  /** Durable memory-facts block — trimmed by its own budget, not dropped. */
  memoryFactsBlock: string;
  /** WARP-2752 (ADR-051) — the brain block: what the box worked out about this
   *  business, bounded by its own char budget at build time. Droppable, but
   *  LAST of the three (see `degradeToFit`). */
  brainBlock: string;
  /** `JSON.stringify(tools[])` — the schemas sent to the model. */
  toolSchemasJson: string;
  /** Context-pin descriptions prepended for this conversation. */
  pinsText: string;
  /** Inlined attachment context (OCR text etc.). */
  attachmentsText: string;
  /** Serialized conversation history (prior turns). */
  historyText: string;
}

/** Convert a char count to an estimated token count (round UP). */
export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Total estimated tokens across every component of the request. */
export function estimateRequestTokens(parts: RequestSizeParts): number {
  const totalChars =
    parts.identityBlock.length +
    parts.personaBlock.length +
    parts.businessBlock.length +
    parts.toolGuidance.length +
    parts.memoryFactsBlock.length +
    parts.brainBlock.length +
    parts.toolSchemasJson.length +
    parts.pinsText.length +
    parts.attachmentsText.length +
    parts.historyText.length;
  return estimateTokensFromChars(totalChars);
}

/** Which optional blocks were dropped, in the order they were dropped. */
export type DroppedBlock = "business" | "persona" | "brain";

export interface DegradeOptions {
  /**
   * Effective context window in tokens (config.OLLAMA_CONTEXT_LENGTH in
   * production). The request must fit under `contextWindow − OUTPUT_RESERVE`.
   */
  contextWindow: number;
  /**
   * Structured warn sink. One call per drop; the payload names the block
   * and carries the estimate/threshold for observability. Defaults to a
   * no-op so unit callers can omit it.
   */
  warn?: (event: {
    block: DroppedBlock;
    estimatedTokens: number;
    thresholdTokens: number;
  }) => void;
}

export interface DegradeResult {
  /** Persona block after degradation ("" if dropped). */
  personaBlock: string;
  /** Business block after degradation ("" if dropped). */
  businessBlock: string;
  /** Brain block after degradation ("" if dropped). */
  brainBlock: string;
  /** Blocks dropped, in drop order (business, then persona, then brain). */
  dropped: DroppedBlock[];
  /** Estimated tokens after degradation. */
  estimatedTokens: number;
  /**
   * True when the request STILL overflows after dropping ALL THREE optional
   * blocks (business, persona, brain — it said "both" until the brain block
   * was added by WARP-2752).
   *
   * 🔴 NO CALLER READS THIS. The sentence that stood here — "the caller must
   * fall through to the existing history/attachment trimming (which this pure
   * function does not own)" — described a handoff that was never built. There
   * is no history or attachment trimming anywhere in the orchestrator, and
   * `routes/llm.ts` takes `personaBlock` / `businessBlock` / `brainBlock` off
   * the result and discards the rest. `tool-budget.service.ts` in turn cited
   * this gate as the thing that "protects history", which is why the gap was
   * invisible from both ends.
   *
   * A turn that reaches here therefore goes to the model over-budget and comes
   * back as the WARP-854 empty completion — a failed turn with a retry chip
   * and no stated cause. It is also the ONLY outcome of this function that
   * emits no `warn`. Tracked on WARP-2849; until then, treat this field as a
   * diagnostic that nothing acts on.
   */
  historyTrimNeeded: boolean;
}

/**
 * Deterministically shrink the request to fit `contextWindow − OUTPUT_RESERVE`.
 *
 * Drops the business block first, re-estimates, drops the persona block only
 * if still over, then the BRAIN block, and finally flags `historyTrimNeeded`
 * if even a stripped request overflows. Never touches identity / tool guidance
 * / tool schemas — those are load-bearing or caller-owned.
 *
 * WARP-2752 — WHY THE BRAIN BLOCK IS DROPPED LAST of the three. It is the only
 * one of them DERIVED from the business's own data: `businessBlock` is a
 * 1,500-char summary a human typed once and `personaBlock` is tone, while the
 * brain block is what the box actually read. Dropping it first would mean the
 * turns most likely to need it — long, busy, business-shaped ones — are exactly
 * the turns that lose it, which is the shape of the defect this ordering exists
 * to avoid.
 */
export function degradeToFit(
  parts: RequestSizeParts,
  opts: DegradeOptions,
): DegradeResult {
  const warn = opts.warn ?? (() => {});
  const thresholdTokens = Math.max(0, opts.contextWindow - OUTPUT_RESERVE);

  let personaBlock = parts.personaBlock;
  let businessBlock = parts.businessBlock;
  let brainBlock = parts.brainBlock;
  const dropped: DroppedBlock[] = [];

  const estimate = () =>
    estimateRequestTokens({ ...parts, personaBlock, businessBlock, brainBlock });

  let estimatedTokens = estimate();

  // Rank 1: drop the business block.
  if (estimatedTokens > thresholdTokens && businessBlock.length > 0) {
    businessBlock = "";
    dropped.push("business");
    estimatedTokens = estimate();
    warn({ block: "business", estimatedTokens, thresholdTokens });
  }

  // Rank 2: drop the persona block.
  if (estimatedTokens > thresholdTokens && personaBlock.length > 0) {
    personaBlock = "";
    dropped.push("persona");
    estimatedTokens = estimate();
    warn({ block: "persona", estimatedTokens, thresholdTokens });
  }

  // Rank 3: drop the brain block. Last, deliberately — see the docstring.
  if (estimatedTokens > thresholdTokens && brainBlock.length > 0) {
    brainBlock = "";
    dropped.push("brain");
    estimatedTokens = estimate();
    warn({ block: "brain", estimatedTokens, thresholdTokens });
  }

  return {
    personaBlock,
    businessBlock,
    brainBlock,
    dropped,
    estimatedTokens,
    historyTrimNeeded: estimatedTokens > thresholdTokens,
  };
}
