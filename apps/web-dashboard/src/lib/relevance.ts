/**
 * WARP-859 / WARP-1603 — citation relevance → display percent.
 *
 * Citation scores reach the UI in two different scales:
 *   - a bounded 0–1 RELEVANCE / similarity (cosine `1 - (embedding <=> vec)`,
 *     RRF fusion weights, and — since WARP-1603 — the mcp-server's
 *     sigmoid-normalized reranker score), and
 *   - an unbounded cross-encoder LOGIT (BGE-reranker-base emits raw
 *     `outputs.logits`: roughly +10 for a strong match, and NEGATIVE for
 *     all but a strong match). Retrieval paths that have not yet
 *     normalized at the source still hand us this shape.
 *
 * History of this function:
 *   - Pre-WARP-859 the render sites did `Math.round(score * 100)`
 *     unconditionally, so a logit of ~10.2 displayed as "1020%".
 *   - WARP-859 squashed through the logistic only when `score > 1`. That
 *     cured the overflow but converted it into an UNDERFLOW: BGE's
 *     negative logits fell into the else-branch, were treated as bounded
 *     similarities, and clamped to 0% — so every chat citation chip read
 *     0% (WARP-1603).
 *
 * The fix is to stop inferring the scale from "is it bigger than 1":
 *   - Callers that KNOW the scale pass `kind` explicitly. Producers should
 *     tag their payload (`scoreKind`) rather than leave the scale to the
 *     renderer — the mcp-server now normalizes reranker logits at the
 *     source (`services/mcp-server/src/file-search.service.ts`).
 *   - Untagged scores fall back to `inferScoreKind`: a value INSIDE [0, 1]
 *     is a bounded relevance; anything outside — above 1 or below 0 — can
 *     only be a raw logit. So −1 now reads ~27%, not 0%.
 *
 * The inference deliberately reads a negative score as a logit rather than
 * as a negative cosine: the retrieval SQL filters on `minSimilarity`
 * (default 0.65 since WARP-2196 recalibrated it for bge-small-en-v1.5; 0.3
 * before that), so a negative cosine never reaches a citation chip, while
 * negative reranker logits are the common case. The exact value does not
 * change this inference — any positive floor rules out negative cosines —
 * but naming a stale one invites the wrong conclusion later.
 */

/**
 * The scale a raw citation score is expressed in.
 *   - "similarity" — already bounded in [0, 1] (cosine, RRF, or a
 *     source-normalized reranker relevance). Rendered as-is.
 *   - "logit"      — unbounded cross-encoder output. Squashed through the
 *     logistic, which is monotonic and therefore rank-preserving.
 */
export type ScoreKind = "logit" | "similarity";

/** Logistic squash. Maps ℝ → (0, 1) preserving order. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Best-effort scale detection for a score that arrived without a
 * `scoreKind` tag (older mcp-server builds, the `/knowledge` search
 * route). Prefer passing `kind` explicitly when the call site knows it.
 */
export function inferScoreKind(score: number): ScoreKind {
  return score >= 0 && score <= 1 ? "similarity" : "logit";
}

/**
 * Render a citation score as a clamped 0–100 integer percent.
 *
 * @param score raw score off the wire
 * @param kind  the scale `score` is in; omit to infer (see `inferScoreKind`)
 */
export function relevancePct(score: number, kind?: ScoreKind): number {
  if (!Number.isFinite(score)) return 0;
  const resolved = kind ?? inferScoreKind(score);
  const p = resolved === "logit" ? sigmoid(score) : score;
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}
