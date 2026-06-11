/**
 * WARP-859 — citation relevance → display percent.
 *
 * Citation scores reach the UI in two different shapes:
 *   - bounded COSINE similarities in [-1, 1] (the file-search content path,
 *     `1 - (embedding <=> vec)`), and
 *   - unbounded cross-encoder RERANKER logits (the hybrid/chat retrieval
 *     path — BGE-reranker-base emits raw logits, commonly ~+10 for a strong
 *     match and negative for a poor one).
 *
 * The old render sites did `Math.round(score * 100)` unconditionally, so a
 * reranker logit of ~10.2 displayed as "1020%" (the bug Romain reported on
 * the parsed PDF). A negative logit would show a negative percent.
 *
 * Heuristic, render-only fix (no backend rebuild, single chokepoint for both
 * the chat citation chips and the /knowledge search viewers):
 *   - score > 1  → treat as a reranker logit; squash through the logistic so
 *                  it lands in (0, 1) while preserving rank order.
 *   - score ≤ 1  → treat as a similarity; clamp the [-1, 1] range into [0, 1].
 * Then scale to a clamped 0–100 integer.
 */
export function relevancePct(score: number): number {
  if (!Number.isFinite(score)) return 0;
  const p = score > 1 ? 1 / (1 + Math.exp(-score)) : score;
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}
