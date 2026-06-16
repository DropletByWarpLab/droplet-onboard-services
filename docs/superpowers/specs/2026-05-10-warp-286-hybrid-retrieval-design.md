# WARP-286 — Hybrid retrieval (BM25 + RRF + cross-encoder reranker)

**Status:** Design approved 2026-05-10 across 4 sections.

**Parent:** Phase A of the long-term design doc (`docs/superpowers/specs/2026-05-09-local-knowledge-platform-design.md`). First product-lane ticket of the post-E→C alternation.

**Sibling:** WARP-287 — section anchors + citation deep-linking (Phase A continuation; queued behind WARP-286).

## Goals

1. The MCP `search_content` tool and `/knowledge` dashboard route return **hybrid retrieval results**: parallel BM25 + vector ANN, fused via RRF, reranked by a cross-encoder, ACL-filtered per user.
2. **Measurably improves** retrieval quality: ≥10% NDCG@10 vs the existing vector-only baseline on a hand-curated 20-30 query eval set.
3. Lands as a clean retrieval abstraction so the future swap to `pg_search` (Tantivy-on-Postgres) is mechanical, not a rewrite.

## Non-goals

- Section anchors at chunk-write time (WARP-287)
- Citation deep-link rendering in the web-dashboard (WARP-287)
- Activity-graph-based personalization features (Phase B — WARP-LXC-10..14)
- GPU/TensorRT reranker acceleration (separate follow-up; CPU is fast enough for v1)
- `pg_search` (Tantivy) extension swap (path documented; future work)
- LoRA fine-tuned embeddings (Phase G)

## Locked decisions from brainstorm

| Q | Decision |
|---|---|
| Q1 — scope | **C** — bundle BM25 + RRF + reranker in this ticket; anchors + citation deep-links split to WARP-287 |
| Q2 — lexical engine | **A** — Postgres native FTS (`tsvector` + `ts_rank_cd` + GIN). No extension install. Future swap to `pg_search` documented in `docs/RAG_RETRIEVAL.md` |
| Q3 — reranker model | **A** — BGE-reranker-base int8 (~280 MB, English-leaning, MTEB 84.8, ~50 ms CPU/req for top-50). Loaded in `services/ai-gateway` via `optimum-onnxruntime`. Cached on disk after first run |
| Q4 — eval set | **A** — 20-30 hand-curated queries against existing fixtures; documented growth path to mine from click data once Phase B activity-graph lands |

## Architecture

```
                          ┌─────────────────────────────┐
                          │ MCP search_content tool     │
                          │ + /knowledge dashboard route│
                          └──────────────┬──────────────┘
                                         │ searchHybrid(query, userId, limit)
                                         ▼
        ┌────────────────────────────────────────────────────────┐
        │ apps/orchestrator/src/services/file-search.service.ts  │
        │                                                        │
        │  1. embed(query)              → 384-dim vector         │
        │                                                        │
        │  2. Parallel:                                          │
        │     ├─ vector_search(vec, k=100, userId)  → cosine     │
        │     └─ lexical_search(query, k=100, userId) → ts_rank  │
        │                                                        │
        │  3. RRF fusion(vec_results, lex_results, k=60) → top-50│
        │                                                        │
        │  4. rerank_call(query, top-50 passages)                │
        │     → ai-gateway gRPC /v1/rerank                       │
        │     → BGE-reranker-base int8                           │
        │     → top-10 with rerank_score                         │
        │                                                        │
        │  5. ACL filter (already WHERE userId = $1 in 2)        │
        │                                                        │
        │  6. return top-K (caller-clamped, default 10)          │
        └────────────────────────────────────────────────────────┘
```

- **Code placement:** extend the existing `apps/orchestrator/src/services/file-search.service.ts` — the canonical shared retrieval surface. Add `searchHybrid()` alongside the existing `searchByVector()`. Existing callers (`/knowledge`, MCP `search_content`) switch to `searchHybrid` in this PR. `searchByVector` stays as a debug primitive.
- **Cache layer:** Redis cached rerank result keyed on `sha256(query + sorted(chunk_ids))`, 5-min TTL. Skips rerank cost on repeated queries within the window.
- **Per-user RBAC:** `WHERE userId = $1` baked into both BM25 + vector SQL. No app-level filter.

## SQL changes — lexical search

### Schema migration (Prisma)

```sql
-- Add a generated tsvector column on FileContentChunk for lexical search.
-- Postgres native FTS (no extension needed). Designed to be swappable later
-- to pg_search (Tantivy) — see docs/RAG_RETRIEVAL.md for the swap path.
ALTER TABLE "FileContentChunk"
  ADD COLUMN "text_tsv" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("text", '')), 'A')
  ) STORED;

CREATE INDEX "FileContentChunk_text_tsv_idx"
  ON "FileContentChunk" USING GIN ("text_tsv");

CREATE INDEX "FileContentChunk_userId_text_tsv_idx"
  ON "FileContentChunk" ("userId");
```

`STORED` generated column means the tsvector is computed at insert/update time and persisted — no per-query computation cost.

### Lexical query

```ts
async function searchByLexical(
  prisma: PrismaClient,
  { userId, query, limit, source }: SearchByLexicalParams,
): Promise<SearchHit[]> {
  const rows = await prisma.$queryRawUnsafe<RawSearchRow[]>(`
    SELECT
      source, path, "chunkIdx", "pageNumber", "brainItemId", metadata,
      "text" as snippet,
      ts_rank_cd("text_tsv", websearch_to_tsquery('english', $2), 32) AS score
    FROM "FileContentChunk"
    WHERE "userId" = $1
      AND "text_tsv" @@ websearch_to_tsquery('english', $2)
      ${source !== undefined ? `AND source = $3::"FileContentSource"` : ''}
    ORDER BY score DESC
    LIMIT $${source !== undefined ? 4 : 3}
  `, userId, query, ...(source !== undefined ? [source, limit] : [limit]));
  return rows.map(rowToHit);
}
```

- `websearch_to_tsquery` — forgiving query parser; handles raw user input, quoted phrases (`"error 42"`), and OR / `-` operators without crashing on punctuation.
- `ts_rank_cd` with normalization flag `32` (mean-of-distance-between-matches) — penalizes long documents proportionally to match clustering, closest native-FTS analog to BM25's length-normalization.

## RRF fusion

Standard reciprocal rank fusion with `k=60` (canonical value from Cormack et al., 2009):

```ts
function reciprocalRankFusion(
  vectorHits: SearchHit[],
  lexicalHits: SearchHit[],
  k: number = 60,
): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; score: number }>();

  for (const [rank, hit] of vectorHits.entries()) {
    const key = `${hit.source}:${hit.path}:${hit.chunkIdx}`;
    scores.set(key, { hit, score: 1 / (k + rank) });
  }
  for (const [rank, hit] of lexicalHits.entries()) {
    const key = `${hit.source}:${hit.path}:${hit.chunkIdx}`;
    const prev = scores.get(key);
    scores.set(key, {
      hit: prev?.hit ?? hit,
      score: (prev?.score ?? 0) + 1 / (k + rank),
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ hit, score }) => ({ ...hit, score }));
}
```

Deduplicates by `(source, path, chunkIdx)`. The pre-fusion vector/lexical scores can be carried in a future `metadata.scores` field if needed (out of scope for v1).

## Reranker — gRPC + ai-gateway

### Proto

`proto/inference.proto`:

```proto
service Inference {
  // existing methods...
  rpc Rerank(RerankRequest) returns (RerankResponse) {}
}

message RerankRequest {
  string query = 1;
  repeated string passages = 2;
  string model = 3;  // "bge-reranker-base" (only supported v1 value)
}

message RerankResponse {
  repeated float scores = 1;  // same order as input passages
}
```

### ai-gateway handler

```python
class InferenceServicer:
    _reranker = None  # lazy-loaded singleton

    def Rerank(self, request, context):
        if self._reranker is None:
            self._reranker = _load_reranker()  # cached on disk after first run
        scores = self._reranker.compute_score(
            [[request.query, p] for p in request.passages],
            batch_size=8,
        )
        return RerankResponse(scores=scores)
```

`_load_reranker()`:
- Loads `BGE-reranker-base` int8 ONNX from `/var/cache/droplet/models/bge-reranker-base/`.
- First run: pulls from Hugging Face with sha256 checksum verification, ~280 MB.
- Subsequent runs: load from cache (~3 s cold-start).
- Inference via `optimum.onnxruntime.ORTModelForSequenceClassification` on CPU.
- Future: TensorRT backend on the inference host (separate ticket; not in v1 scope).

### Orchestrator caller

```ts
async function rerankPassages(
  query: string,
  hits: SearchHit[],
): Promise<SearchHit[]> {
  if (hits.length === 0) return hits;
  const cacheKey = `rerank:${sha256(query + hits.map(h => `${h.source}:${h.path}:${h.chunkIdx}`).join('|'))}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    const scores = JSON.parse(cached) as number[];
    return hits
      .map((h, i) => ({ ...h, score: scores[i] }))
      .sort((a, b) => b.score - a.score);
  }
  const passages = hits.map(h => h.snippet.slice(0, 512));  // cap input length
  const { scores } = await rerankerClient.rerank({
    query,
    passages,
    model: 'bge-reranker-base',
  });
  await redis.setex(cacheKey, 300, JSON.stringify(scores));  // 5 min TTL
  return hits
    .map((h, i) => ({ ...h, score: scores[i] }))
    .sort((a, b) => b.score - a.score);
}
```

## Pipeline latency budget

| Step | Time (p50) | Time (p99) |
|---|---|---|
| Embed query | 20 ms | 80 ms |
| Vector ANN (top-100) | 15 ms | 60 ms |
| Lexical FTS (top-100) | 10 ms | 40 ms |
| RRF fusion | <1 ms | <1 ms |
| Rerank top-50 (cache miss, CPU) | 400 ms | 800 ms |
| Rerank top-50 (cache hit) | 5 ms | 10 ms |
| **Total cold** | **445 ms** | **980 ms** |
| **Total warm** | **50 ms** | **190 ms** |

## Eval harness

### Location

`tests/retrieval-eval/`:
- `queries.yaml` — 20-30 hand-curated queries with relevance labels
- `run.ts` — vitest-shaped harness; gated by `RUN_RAG_INTEGRATION=1`
- `results-<date>.json` — output (gitignored)

### Query shape

```yaml
- id: q01
  query: "what is the budget for Q4"
  relevant_chunks:
    - source: nextcloud
      path: "/admin/files/test-rag-end-to-end/sample.pdf"
      chunk_idx_any: true  # any chunk from this doc counts
    - source: brain
      path_contains: "warp224-audio.wav"
  notes: "exact-phrase match + audio transcript synonym"
```

### Harness flow

1. Seeds existing fixtures via Nextcloud-scan + brain-upload (uses the WARP-224 helpers from `tests/helpers/rag-retrieval.ts`).
2. For each query, runs **three** pipelines:
   - `vector-only` (baseline — existing `searchByVector`)
   - `vector + lexical + RRF` (no reranker)
   - `full-hybrid + rerank` (target)
3. Computes NDCG@10 for each pipeline against the labels.
4. Writes `results-<date>.json`.
5. Asserts: `ndcg(full-hybrid) >= 1.1 * ndcg(vector-only)` — the ≥10% acceptance criterion.

Run command: `npm run -w tests test:retrieval-eval`. Not PR-required CI; runnable manually + via `workflow_dispatch`. Same skip-gate pattern as `rag-end-to-end.integration.test.ts`.

### Growth path

Documented in `docs/RAG_RETRIEVAL.md`: after Phase B (activity graph + click data) lands, the eval set extends with `(query, clicked_chunk)` pairs mined from `ActivityEvent`. Until then, manual curation.

## Unit test coverage

- `searchByLexical` — mocked `$queryRawUnsafe` returning fixture rows; verifies the SQL parameters + result mapping
- `reciprocalRankFusion` — pure function, ~10 cases (empty inputs, all-overlap, no-overlap, score ordering, k tuning)
- `rerankPassages` — mocked Redis + mocked gRPC client; tests cache hit + cache miss + empty input
- `searchHybrid` — integration test mocking the three primitives
- ai-gateway `Rerank` handler — pytest fixtures (mocked `model.compute_score`; verifies gRPC contract)

## Future-swap to `pg_search` (documented in `docs/RAG_RETRIEVAL.md`)

Path to swap if eval shows native FTS underperforming or a real BM25 need emerges:
1. Custom Postgres image based on `pgvector/pgvector:pg16` with `pg_search` extension installed via apt.
2. `ALTER TABLE "FileContentChunk" ADD COLUMN "text_pgsearch" ...` — pg_search-specific index.
3. Swap `searchByLexical` body to use the `@@@` operator + `paradedb.score()`.
4. Drop the `text_tsv` column after the bake-in period.

Why we'd swap: pg_search offers proper BM25, language-aware tokenization, fuzzy + phrase queries. For our v1 acceptance criterion (≥10% NDCG@10 vs vector-only), native FTS is sufficient; pg_search is a marginal win at a non-trivial ops cost (custom postgres image affects every developer's docker-compose). The retrieval abstraction makes this a swap, not a rewrite.

## Phasing — single PR, 8 commits

1. **`feat(db): add text_tsv generated column + GIN index`** — Prisma migration. Backfill is automatic via `GENERATED ALWAYS AS STORED`.
2. **`feat(orchestrator): add searchByLexical + RRF fusion`** — `file-search.service.ts` extended. Unit tests for both. `searchByVector` unchanged; new `searchHybrid` (BM25 + RRF, no reranker yet) wires the two.
3. **`feat(proto): add Rerank gRPC method`** — proto change + regenerate stubs in both `apps/orchestrator/grpc-generated/` and `services/ai-gateway/grpc_generated/`.
4. **`feat(ai-gateway): implement Rerank handler with BGE-reranker-base int8`** — model loading, ONNX inference, gRPC handler. pytest fixtures.
5. **`feat(orchestrator): rerankPassages with Redis cache`** — `rerankPassages()` helper + integration into `searchHybrid()`. Unit + integration tests.
6. **`feat: switch callers from searchByVector to searchHybrid`** — MCP `search_content` handler + dashboard `/knowledge` route. End-to-end smoke updated.
7. **`tests(retrieval-eval): hand-curated eval set + NDCG@10 harness`** — eval set + harness. Asserts ≥10% improvement.
8. **`docs(retrieval): RAG_RETRIEVAL.md`** — architecture diagram, native FTS rationale, future-swap-to-pg_search path, eval methodology, tuning knobs.

Total: ~5-7 days of focused subagent work. Single PR.

## Error handling

| Failure | Behavior |
|---|---|
| `text_tsv` migration fails on existing data | Migration aborts; rollback; investigate row size. STORED column should never fail; fallback would be `coalesce("text", '')` already in place |
| Lexical query returns 0 rows | RRF degrades gracefully to vector-only ranking (`prev?.score ?? 0` in fusion handles missing-key) |
| Vector query returns 0 rows | RRF degrades to lexical-only |
| Both return 0 rows | `searchHybrid` returns empty array; caller handles |
| ai-gateway gRPC unreachable | rerank step throws; `searchHybrid` falls back to RRF top-K with a warn log. Caller sees results, just unreranked |
| Reranker model not cached + offline | `_load_reranker()` throws; ai-gateway returns gRPC error; same fallback as above |
| Redis down | Cache write/read skipped (best-effort try/catch); each rerank call hits the model |
| Query length > 512 chars | Pre-truncated at the orchestrator before sending |
| Passage longer than 512 chars | Pre-truncated to 512 chars per passage |

## Acceptance criteria

- All 8 commits land in a single PR; all four PR-required CI lanes green
- `text_tsv` column + GIN index migrated
- `searchHybrid` wired into MCP `search_content` + `/knowledge` route; `searchByVector` retained as debug primitive
- 7 unit + ~5 integration tests added; all green
- ai-gateway `Rerank` gRPC method handles top-50 in < 800 ms p99 on CPU
- Eval harness asserts ≥10% NDCG@10 improvement vs vector-only on the 20-30 query hand-curated set
- p99 latency for `searchHybrid` warm-cache ≤ 200 ms
- `docs/RAG_RETRIEVAL.md` documents architecture + future-swap path

## Out of scope (other tickets)

- Section anchors at chunk-write — **WARP-287**
- Citation deep-link rendering — **WARP-287**
- Activity-graph-based personalization — Phase B (WARP-LXC-10..14, not yet filed)
- GPU/TensorRT reranker acceleration — separate follow-up if eval shows CPU is the bottleneck
- LoRA fine-tuned embeddings — Phase G
- `pg_search` swap — documented path; future work driven by eval data
