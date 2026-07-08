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
import { OUTPUT_RESERVE } from "./prompt-budget.consts.js";

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
    parts.toolSchemasJson.length +
    parts.pinsText.length +
    parts.attachmentsText.length +
    parts.historyText.length;
  return estimateTokensFromChars(totalChars);
}

/** Which optional blocks were dropped, in the order they were dropped. */
export type DroppedBlock = "business" | "persona";

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
  /** Blocks dropped, in drop order (business before persona). */
  dropped: DroppedBlock[];
  /** Estimated tokens after degradation. */
  estimatedTokens: number;
  /**
   * True when the request STILL overflows after dropping both optional
   * blocks — the caller must fall through to the existing history/
   * attachment trimming (which this pure function does not own).
   */
  historyTrimNeeded: boolean;
}

/**
 * Deterministically shrink the request to fit `contextWindow − OUTPUT_RESERVE`.
 *
 * Drops the business block first, re-estimates, drops the persona block only
 * if still over, re-estimates, and finally flags `historyTrimNeeded` if even
 * a persona-less request overflows. Never touches identity / tool guidance /
 * tool schemas — those are load-bearing or caller-owned.
 */
export function degradeToFit(
  parts: RequestSizeParts,
  opts: DegradeOptions,
): DegradeResult {
  const warn = opts.warn ?? (() => {});
  const thresholdTokens = Math.max(0, opts.contextWindow - OUTPUT_RESERVE);

  let personaBlock = parts.personaBlock;
  let businessBlock = parts.businessBlock;
  const dropped: DroppedBlock[] = [];

  const estimate = () =>
    estimateRequestTokens({ ...parts, personaBlock, businessBlock });

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

  return {
    personaBlock,
    businessBlock,
    dropped,
    estimatedTokens,
    historyTrimNeeded: estimatedTokens > thresholdTokens,
  };
}
