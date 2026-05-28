# WARP-437 — Phase 3: Query Enhancement (HyDE + Multi-Query + Adaptive Routing) — Design

**Status:** Proposed
**Date:** 2026-05-25
**Authors:** Engineering team
**Tracking:** [WARP-437](https://warp-lab.atlassian.net/browse/WARP-437) (Phase 3 of [ADR-003](../../ADR-003-rag-techniques-adoption.md))
**Branch:** `feat/warp-437-query-enhancement`

> Authoritative ADR: [`docs/ADR-003-rag-techniques-adoption.md` §"Phase 3 — Query enhancement"](../../ADR-003-rag-techniques-adoption.md#phase-3--query-enhancement-hyde--multi-query--adaptive-routing). This design document expands that section into the wire-shape, prompt text, threshold table, and mirror-contract details an executing agent needs.

## Context

After Phases 1 (sentence-aware chunking + contextual headers, WARP-435) and 2 (RAGAS harness scaffolded, WARP-436), every retrieval still uses the raw user query verbatim. The query is embedded as-is, sent through `searchByLexical`'s `to_tsquery`, fused via RRF, reranked. Failure modes left on the table:

1. **Short / under-specified queries** ("status", "the photo from last week") embed into low-information vectors. The hybrid arm helps but isn't enough — there is no FTS hit and the vector is too generic to rank.
2. **Multi-faceted analytical queries** ("compare Q1 vs Q2 marketing spend by region") force a single-vector lookup over what should be 2–3 retrieval rounds. The reranker can re-order but cannot add candidates that the embedder + FTS missed.
3. **Class-blind tuning** — `minSimilarity`, `perArmK`, and `rerank.candidates` are static knobs. A conversational "hey how's it going" gets the same retrieval budget as a navigational "open the camera-1 settings page", which is wasteful and noisy.

Three additions close those gaps, each independently gated on the eval harness from Phase 2:

- **HyDE** rewrites the query into a hypothetical answering passage, which we embed instead of (or in addition to) the raw query. One LLM call. Gao et al. 2022 reports +5–15 NDCG on under-specified queries; we expect ≥5% on the short-query subset of `queries.yaml`.
- **Multi-query expansion** generates N (=3) paraphrases, embeds each, runs parallel vector arms, RRF-fuses across queries before the existing RRF stage. One LLM call producing 3 strings. Gains live on analytical queries; we expect ≥10% context-recall on the multi-faceted subset.
- **Adaptive routing** uses a cheap zero-shot classifier (`MoritzLaurer/deberta-v3-base-zeroshot-v2.0`, ~110 MB int8, ~50 ms CPU) to label each query `factual | analytical | conversational | navigational`, then maps the label to an enhancement preset. Cheaper than an LLM classifier and avoids burning chat tokens on a category decision.

The constraint that makes Phase 3 distinctive: **every change must preserve the WARP-202 mirror.** Two copies of `file-search.service.ts` exist by design (orchestrator + mcp-server). Any signature change to `searchHybrid` must land in both files within the same PR, or CI's diff-checker fails. This is non-negotiable per CLAUDE.md and ADR-003.

## Decision

Land HyDE, multi-query, and adaptive routing as **three composable knobs on a single new `queryEnhancement` block** added to `SearchHybridParams`. The orchestrator's agent loop picks the preset; the MCP tool handler passes the preset through; `searchHybrid` consumes it. When the block is omitted, `searchHybrid`'s behaviour is byte-for-byte identical to today's — that's how we make rollout incremental and revert trivial.

Components:

| Component | Location | Responsibility |
|---|---|---|
| `query_classifier.py` | `services/ai-gateway/` | Lazy-load deberta zero-shot pipeline; expose `classify(query) -> QueryClass`. Mirrors `reranker.RerankerSingleton` pattern. |
| `ClassifyQuery` gRPC RPC | `proto/inference.proto`, `services/ai-gateway/grpc_server.py` | Wire surface for the orchestrator. Input: query string. Output: `{class, confidence}`. Cache by SHA-256 of query. |
| `query-enhancement.service.ts` | `apps/orchestrator/src/services/` | `hydeRewrite(query): Promise<string>` (1 LLM call via ai-gateway chat), `multiQueryExpand(query, n=3): Promise<string[]>` (1 LLM call, 3 paraphrases), `classifyQuery(query): Promise<QueryClass>` (1 gRPC call). |
| `queryEnhancement` param on `searchHybrid` | `apps/orchestrator/src/services/file-search.service.ts` + `services/mcp-server/src/file-search.service.ts` (mirror) | New optional block. When present, fans out vector searches across rewritten queries and RRF-fuses across queries before existing RRF. |
| `searchContentTool.input.enhance` flag | `packages/tools-core/src/handlers/files/search-content.ts` | LLM-visible knob to opt into enhancement from the agent's tool call. Default off. |
| Adaptive routing wire-up | `apps/orchestrator/src/services/llm-agent.service.ts` | Classify → choose preset → invoke `search_content` with the preset. |

### `QueryClass` and presets

`QueryClass` is a string-literal union: `'factual' | 'analytical' | 'conversational' | 'navigational' | 'unknown'`. `unknown` is returned when the classifier's top-1 confidence is below `CLASSIFIER_CONFIDENCE_FLOOR = 0.4` — we fall back to the static default in that case rather than route on noise.

Preset map (orchestrator's adaptive layer; tunable via env, defaults shown):

| Class | Preset |
|---|---|
| `factual` | `rerank.candidates = 100`, no HyDE, no multi-query. The reranker does the heavy lifting on a wider candidate pool. |
| `analytical` | `multiQuery = true` (n=3), `rerank.candidates = 80`. RRF across paraphrases adds the recall the reranker can't synthesize. |
| `conversational` | `minSimilarity = 0.5`, `perArmK = 50`, no HyDE, no multi-query. Tighter floor, smaller arms — cheap exits on chit-chat. |
| `navigational` | metadata filter `filename LIKE %{token}%` for tokens that look like filenames, no HyDE, no multi-query. Falls back to default if no filename-shaped token. |
| `unknown` | Default `searchHybrid` parameters. |

Adaptive routing is a layer on top of the three knobs — the knobs themselves are independent and can be hand-toggled from the tool input for tests / debug / future presets.

### HyDE prompt

```
You are a helpful assistant that writes a short hypothetical passage that
would answer the user's question. Write 1 paragraph, 60-120 words, in the
style of a document body (not a chat reply). Do NOT add disclaimers or
preambles. Do NOT use markdown.

Question: {query}

Passage:
```

The HyDE call routes through `ai-gateway`'s `Chat` RPC with `temperature=0.2`, `max_tokens=200`, `priority=5` (automation — lower than user-initiated chat to avoid starving the agent loop). When `queryEnhancement.hyde` is set, `searchHybrid` embeds both the raw query and the HyDE passage, averages the two 384-dim vectors, and proceeds. (Concatenation was considered and rejected: the embedder is `all-MiniLM-L6-v2` with a 512-token cap; concatenating overruns frequently. Averaging is the standard HyDE-in-production trick.)

### Multi-query prompt

```
Rewrite the user's question as 3 alternative search queries that capture the
same intent from different angles. Each rewrite must be self-contained (no
references to "the question"). Output as a JSON array of exactly 3 strings,
no markdown, no commentary.

Question: {query}

Rewrites:
```

`temperature=0.5`, `max_tokens=300`. Output is parsed as JSON; on parse failure (which happens ~5% of the time with local 7B models), we fall back to the raw query and log a `multi_query_parse_failed` counter. The downstream `searchHybrid` is robust to receiving a single-element array.

### Wire shape — `queryEnhancement` block on `SearchHybridParams`

```typescript
export interface QueryEnhancementOption {
  /** When set, embed this passage too and average with the raw-query vector. */
  hydePassage?: string;
  /** When set, also run parallel vector arms against these extra queries
   *  and RRF-fuse across queries before the existing vector+lexical RRF. */
  extraQueries?: string[];
  /** Class-derived metadata filter; today: `filenameContains?: string`. */
  metadataFilter?: {
    filenameContains?: string;
  };
}

export interface SearchHybridParams {
  // ... existing fields ...
  queryEnhancement?: QueryEnhancementOption;
}
```

Why not pass `hyde: boolean` / `multiQuery: boolean` and have `searchHybrid` call back into the orchestrator for the LLM? Because the mcp-server's mirror lives in a different process and doesn't have the LLM client — keeping enhancement orchestration *outside* `searchHybrid` lets the same function run unchanged in both processes. The caller (orchestrator's agent loop) does the LLM calls and hands `searchHybrid` the already-computed passage / queries / filters.

### `search_content` tool — LLM-visible input

```jsonc
{
  "query": "string, >=2 chars",
  "limit": "int 1..50, default 10",
  "enhance": {                                // NEW; default omitted
    "hyde": "bool, default false",
    "multiQuery": "bool, default false",
    "n": "int 2..5, default 3"
  }
}
```

The LLM can opt into HyDE / multi-query directly via the tool call. The orchestrator's agent-loop preset chooser sets this based on adaptive classification. When the LLM hand-overrides, the override wins (LLM judgment beats classifier).

### Eval gate

| Subset | Metric | Gate |
|---|---|---|
| Under-specified (15 queries, 1–3 words) | NDCG@10 with HyDE vs baseline | `ndcg_hyde ≥ ndcg_baseline × 1.05` AND no full-corpus regression > 2% |
| Multi-faceted analytical (10 queries) | RAGAS `context_recall` with multi-query vs baseline | `context_recall_multiquery ≥ context_recall_baseline × 1.10` |
| Conversational (10 queries) | NDCG@10 with adaptive vs baseline | Positive delta required; if regress, default-off the `conversational` preset. |
| Full corpus (45 queries) | NDCG@10 with all enhancements vs baseline | `ndcg_all ≥ ndcg_baseline × 1.03` |

RAGAS metrics are read from baselines once Phase 2 batch D's CI run populates `tests/retrieval-eval/ragas/baselines.json`. Until then, this phase's CI test runs in `RECORDING_MODE=1` — same pattern as the existing RAGAS runner — and the eval gate at step 3.9 is "advisory pass" (record values, do not block merge). Once baselines exist, the gate is enforced.

### Latency budget

Per query, worst case: 1 deberta classify (~50 ms CPU) + 1 HyDE chat (~600 ms local Ollama mistral-7b on Orin Nano warm, p95) + 1 multi-query chat (~600 ms) + 4 parallel vector arms (~30 ms each, in flight together) + 1 rerank batch (~120 ms) ≈ **1.4 s p95**, vs today's ~250 ms p95. This is acceptable for the agent loop (the LLM round-trip dominates anyway), but the adaptive layer guarantees the worst case applies ONLY to analytical queries; conversational queries skip both LLM calls and stay near baseline.

### What we don't do

- **No web-search fallback.** That's Phase 4 / future work.
- **No HyDE-only retrieval.** Averaging with the raw vector is the safer default; pure-HyDE retrieval is a knob we can add later if the eval shows the raw vector is hurting.
- **No fine-tuned classifier.** The off-the-shelf deberta zero-shot is good enough for 4 classes; fine-tuning is a future ticket if classes drift or new ones get added.
- **No agent-loop self-reflection / re-query on bad retrieval.** That's Phase 4 (CRAG-lite).

## Open questions

These don't block Phase 3 but should be resolved before merge:

1. **Cache TTL for classifier results.** `RerankerSingleton`'s cache is short-lived (Redis TTL 1 h, chunk-id-keyed and invalidating). Classifier cache is keyed on query SHA-256 with no natural invalidation; propose 24 h TTL since the classifier is deterministic and queries repeat.
2. **HyDE on conversational queries.** Probably negative-value (the LLM hallucinates a "passage" answering "hey how's it going"). The adaptive layer disables it; should the tool input also gate HyDE on classifier-class to prevent the LLM from over-using it? Lean: yes, gate at the `search_content` handler before reaching `searchHybrid`.
3. **Multi-query temperature.** 0.5 is a compromise; need to verify the local 7B Ollama model gives diverse-enough rewrites. If not, raise to 0.7 and accept higher parse-failure rate.

## References

- [ADR-003](../../ADR-003-rag-techniques-adoption.md) §"Phase 3"
- Gao et al. 2022, "Precise Zero-Shot Dense Retrieval without Relevance Labels" — HyDE.
- [`MoritzLaurer/deberta-v3-base-zeroshot-v2.0`](https://huggingface.co/MoritzLaurer/deberta-v3-base-zeroshot-v2.0)
- WARP-286 design — [`docs/RAG_RETRIEVAL.md`](../../RAG_RETRIEVAL.md)
- Phase 2 design — RAGAS runner — [`tests/retrieval-eval/ragas/README.md`](../../../tests/retrieval-eval/ragas/README.md)
