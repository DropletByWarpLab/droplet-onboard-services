# Hybrid retrieval

Hybrid retrieval combines lexical (BM25-style) and vector (ANN) search,
fuses the rankings via Reciprocal Rank Fusion (RRF), and reranks the
top-50 candidates with a cross-encoder. WARP-286.

## Pipeline

```
                          ┌─────────────────────────────┐
                          │ MCP search_content tool     │
                          │ + /knowledge dashboard route│
                          └──────────────┬──────────────┘
                                         │ searchHybrid()
                                         ▼
        ┌────────────────────────────────────────────────────────┐
        │ apps/orchestrator/src/services/file-search.service.ts  │
        │ services/mcp-server/src/file-search.service.ts (mirror)│
        │                                                        │
        │  1. embed(query)              → 384-dim vector         │
        │  2. parallel:                                          │
        │     ├─ vector_search (cosine, k=100)                   │
        │     └─ lexical_search (ts_rank_cd, k=100)              │
        │  3. RRF fusion (k=60)                                  │
        │  4. rerank top-50 via ai-gateway gRPC                  │
        │  5. ACL filter (already in 2's SQL: WHERE userId = $1) │
        │  6. return top-K (default 10)                          │
        └────────────────────────────────────────────────────────┘
```

The dashboard `/knowledge` route consumes the orchestrator's
`searchHybrid` directly. The MCP `search_content` tool runs inside the
mcp-server process; that process owns its own copy of
`file-search.service.ts` and its own `reranker.client.ts`. The two
copies intentionally mirror each other (same SQL, same RRF, same
rerank logic) per the WARP-202 duplication note — they share fixtures,
tests, and the spec's named constants, so drift between them is a
single-file diff away from being caught.

## Lexical engine — Postgres native FTS

v1 uses Postgres's native full-text search:

- `tsvector` generated column on `FileContentChunk.text`, STORED on disk
- `GIN` index for fast `@@` matches
- `websearch_to_tsquery('english', ...)` as the query parser
- `ts_rank_cd(text_tsv, query, 32)` as the ranking function

`ts_rank_cd` with normalization flag `32` (mean-of-distance-between-matches)
is the closest native-FTS analog to BM25's length normalization. Not a
true BM25, but adequate for our use case where vector retrieval covers
the bulk of semantic matching.

The migration is
`apps/orchestrator/prisma/migrations/<timestamp>_add_chunk_tsvector_index/migration.sql`.
The `text_tsv` column is `GENERATED ALWAYS AS ... STORED` so every
insert/update populates it automatically — no application-side write
path changes required.

## Future swap — `pg_search` (Tantivy-on-Postgres)

If eval shows native FTS underperforming on a real workload, the swap
path is:

1. Custom Postgres image based on `pgvector/pgvector:pg16` with the
   `pg_search` extension installed via apt. Affects
   `docker/docker-compose.yml`'s db service build context.
2. New migration: add a `pg_search`-managed index on
   `FileContentChunk.text`.
3. Swap `searchByLexical` body to use the `@@@` operator and
   `paradedb.score()`.
4. Drop the `text_tsv` column after the bake-in period.

The retrieval abstraction in `file-search.service.ts` makes this a
swap, not a rewrite. The eval harness in `tests/retrieval-eval/` is
the gate: re-run after the swap and confirm NDCG@10 improvement.

Why we did NOT swap in v1: pg_search offers proper BM25, language-aware
tokenization, fuzzy + phrase queries. For our v1 acceptance criterion
(≥10% NDCG@10 vs vector-only), native FTS is sufficient; pg_search is
a marginal win at a non-trivial ops cost (custom postgres image affects
every developer's docker-compose).

## Reranker

`BGE-reranker-base` int8 ONNX:

- 278M parameters; ~280 MB on disk
- English-leaning (cross-lingual capability exists but is weaker than v2-m3)
- MTEB rerank avg: 84.8
- ~50 ms/req on CPU for top-50 (Jetson Orin int8)
- Served by `services/ai-gateway` via the gRPC `Rerank` method
- Cached at `/var/cache/droplet/models/bge-reranker-base/` after first
  pull from Hugging Face

Why not BGE-reranker-v2-m3? v2-m3 is multilingual + higher quality but
2× the memory + 3× the CPU. For a household appliance with mostly-
English content, the marginal quality (~1.6 pts on MTEB) doesn't
justify the cost. Swap is mechanical: change the `RERANKER_MODEL_ID`
constant in `services/ai-gateway/reranker.py` and re-run the eval.

## Caching

Rerank results are cached in Redis under
`rerank:<sha256(query || '::' || chunk-id-list)>` with a 5-minute TTL
(`RERANK_DEFAULT_CACHE_TTL_SEC`). The cache key includes the chunk-id
list so it auto-invalidates when the underlying RRF candidate set
changes (e.g. new files indexed). All cache operations are best-effort
try/catch — Redis down does not break search; the request simply skips
the cache and calls the model.

SHA-256 is FIPS-approved; the use here is non-cryptographic (cache key
derivation, not authentication or integrity). The FIPS lint
(`scripts/test-fips.sh`) is PR-blocking and a regression to a
non-approved digest would fail closed.

## Per-user RBAC

Both the vector and lexical SQL queries are parameterized with
`WHERE "userId" = $1`. The userId is bound at MCP context-build time
from JWT claims (HTTP transport) or `_meta.userId` (trusted-stdio
transport from the orchestrator). The `search_content` tool handler
never receives an unauthenticated userId — `ctx.searchHybrid` is
either bound or absent.

Cross-user retrieval is impossible by construction at the SQL layer.

## Eval

`tests/retrieval-eval/` holds the hand-curated query set + the NDCG@10
harness. Run via:

```bash
RUN_RAG_INTEGRATION=1 ./scripts/test-rag.sh
# or
RUN_RAG_INTEGRATION=1 npm run -w tests test:retrieval-eval
```

Acceptance: `ndcg(full hybrid) >= NDCG_IMPROVEMENT_THRESHOLD ×
ndcg(vector-only)` with `NDCG_IMPROVEMENT_THRESHOLD = 1.1` (10%
improvement). The harness runs three pipelines per query and logs
per-query NDCG so regressions can be triaged.

The eval endpoint at `/api/admin/retrieval-eval/search?variant=…` is
mounted in non-production builds only. It returns 404 in production
so the public surface stays unchanged.

### Growth path

Once Phase B (activity graph + click data) lands, the eval set extends
with `(query, clicked_chunk)` pairs mined from `ActivityEvent`. Until
then, manual curation in `tests/retrieval-eval/queries.yaml` is the
source of ground truth. The current corpus is 20 queries across
realistic personas — see the YAML for the schema.

## Tuning knobs

| Knob | Where | Default | When to tune |
|---|---|---|---|
| RRF `k` | `reciprocalRankFusion(_, _, k)` in file-search.service.ts | 60 (`RRF_DEFAULT_K`) | Increase to favor consensus, decrease to favor highly-ranked outliers |
| Per-arm k | `searchHybrid({ perArmK })` | 100 (`SEARCH_HYBRID_DEFAULT_PER_ARM_K`) | Raise if rerank misses good candidates |
| Rerank candidates | `searchHybrid({ rerank: { candidates } })` | 50 (`RERANK_DEFAULT_CANDIDATES`) | Raise to improve recall at higher CPU cost |
| Rerank cache TTL | `rerankPassages({ cacheTtlSec })` | 300 (`RERANK_DEFAULT_CACHE_TTL_SEC`) | Raise if queries repeat heavily; lower if data churns fast |
| Min similarity (vector) | `searchHybrid({ minSimilarity })` | 0.3 (`SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY`) | Raise to drop weak vector matches; lower for noisier corpora |
| Max passage chars | `rerankPassages({ maxPassageChars })` | 512 (`RERANK_DEFAULT_MAX_PASSAGE_CHARS`) | Match the reranker tokenizer's max_length |

All knobs are named constants in the relevant `file-search.service.ts`
(orchestrator + mcp-server mirror) and in `services/ai-gateway/reranker.py`.
Per CLAUDE.md's no-guessing rule, every default has a name and a
documented rationale.

## Operational notes

- The reranker model is downloaded from Hugging Face on first `Rerank`
  call. First call takes 30–60s; subsequent calls hit the disk cache
  (~3s cold start). Production deployments should pre-warm the model
  at container start by issuing one no-op `Rerank` call.
- On embedding service down: `searchHybrid` throws to the caller
  before reaching the lexical/vector arms. The dashboard surfaces this
  as `503 embedding_failed`. The lexical arm is not run alone in v1.
- On reranker service down: `rerankPassages` catches the gRPC error
  and returns the RRF top-K unranked. The dashboard / search tool
  receive results, just without rerank scoring.
- On Redis down: caches are bypassed; both layers still function. Every
  query hits the model.
- Per CLAUDE.md, no `while True` polling loops were introduced. The
  ai-gateway reranker singleton lazy-loads on the first call (init
  serialized by the GIL) and the eval harness uses explicit deadlines
  in its DB-readiness wait.

## Pipeline latency budget

| Step | Time (p50) | Time (p99) |
|---|---|---|
| Embed query | 20 ms | 80 ms |
| Vector ANN (top-100) | 15 ms | 60 ms |
| Lexical FTS (top-100) | 10 ms | 40 ms |
| RRF fusion | <1 ms | <1 ms |
| Rerank top-50 (cache miss, CPU) | 400 ms | 800 ms |
| Rerank top-50 (cache hit) | 5 ms | 10 ms |
| Total cold | 445 ms | 980 ms |
| Total warm | 50 ms | 190 ms |
