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
- ~50 ms/req on CPU for top-50 (inference host, int8)
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

## Ingest enrichment (WARP-435 / ADR-003 Phase 1)

Two changes land at ingest time, before chunks reach pgvector. Both
are query-path-invariant — `searchHybrid` is untouched. The win is
purely on the embedding side: the embedder now sees text that already
carries hierarchical context, so semantically-equivalent chunks from
different sections separate more cleanly in vector space.

### Sentence-aware chunking

The legacy chunker (`services/file-indexer/chunker.py` pre-WARP-435)
split text on whitespace word boundaries with a hardcoded
`0.75 * words ≈ tokens` heuristic. That cut mid-sentence routinely
and produced chunks anywhere from 60% to 110% of the intended
`CHUNK_SIZE_TOKENS` budget.

The new chunker uses
[`semantic-text-splitter`](https://github.com/benbrandt/text-splitter)
(Rust-backed Python wheel, ~8 MB) driven by the embedder's actual
HuggingFace tokenizer
(`BAAI/bge-small-en-v1.5` — WARP-2196; the repo org is resolved through
`services/file-indexer/embedding_models.py`, never by prefixing the short
model id, because bge does not live under `sentence-transformers/`):

```python
from semantic_text_splitter import TextSplitter
from tokenizers import Tokenizer

tok = Tokenizer.from_pretrained("BAAI/bge-small-en-v1.5")
splitter = TextSplitter.from_huggingface_tokenizer(
    tok,
    # WARP-2191: CHUNK_SIZE_TOKENS (512) is the WHOLE per-chunk embedder
    # budget. The contextual header is prepended AFTER splitting, so its
    # 64-token reservation comes out of the splitter's capacity —
    # otherwise the header is pure overrun past the embedder window.
    capacity=CHUNK_SIZE_TOKENS - CHUNK_HEADER_BUDGET_TOKENS,   # 448 body tokens
    overlap=int(448 * 0.2),                                    # 89-token overlap
)
chunks = splitter.chunks(text)
```

The splitter walks the text with three levels of granularity in order:
Unicode-aware sentence segmentation, then word boundaries, then
character boundaries. Mid-sentence cuts only happen when a single
sentence overruns `capacity`. Real-token accounting means a chunk that
fits at index time is guaranteed to fit at query time — no more
"ai-gateway returned a 512-token-truncated embedding" warnings.

Public signature `chunk_text(text: str) -> list[str]` is preserved so
callers in `watcher.py`, `brain_ingest.py`, and `transcription_worker.py`
keep working without per-caller changes.

Degradation path: if the HF tokenizer can't be fetched (offline dev,
network failure), the chunker falls back to the legacy word-split path
with a one-shot warning — better than failing the row. The next
successful run upgrades it.

### Contextual chunk headers (`sectionPath`)

Every chunk is prefixed with a hierarchical header before embedding:

```
Document: ADR-003.pdf / Section: Phase 1 — Ingest enrichment > Step 1.7

When the embedder grades the chunk's similarity to a query, it gets
the document + section anchor for free instead of having to infer it
from the body text.
```

The header lives in `FileContentChunk.text` — i.e. **the same string
the embedder saw is the string we persist** so the lexical arm and
the LLM's citation surface both reflect the section context. No
divergence between embedding input and stored representation.

#### Where `sectionPath` comes from

Each extractor emits a per-document `metadata.section_paths` list of
`(char_offset, [section, ...])` tuples. The chunker maps each chunk's
start offset to the most recent preceding entry's path:

| Extractor | Source of hierarchy |
|---|---|
| `extractors/pdf.py` | Walks `PdfReader.outline` (PDF bookmarks tree). Pages without an outline entry get `[]` — chunk falls back to `[filename]` |
| `extractors/docx.py` | Tracks paragraph-style heading depth (`Heading 1..9`); snapshots the live stack at every body paragraph |
| `extractors/pptx.py` | `[section_name, slide_title]` per slide via python-pptx layout/title APIs; new extractor in WARP-435 |
| `extractors/text.py` | `[filename]` (flat formats have no in-body hierarchy) |
| `extractors/email.py` | `[filename]` (the recursive `chain[]` breadcrumb carries attachment lineage separately) |
| `extractors/audio.py`, `video.py` | Pass-through — inherit `[filename]` since transcripts are flat streams |

#### Where `sectionPath` lands

The new helpers live in `services/file-indexer/chunker.py`:

- `chunk_text_with_offsets(text)` — sentence-aware chunker that also
  returns each chunk's byte offset.
- `section_path_for_offset(offset, section_paths)` — sweep lookup over
  the extractor's `(offset, path)` tuples.
- `format_chunk_with_header(chunk, filename, section_path)` — formats
  the `Document: ... / Section: ...\n\n...` prefix.

The chunk-emitting paths (`brain_ingest.py`, `watcher.py`,
`transcription_worker.py`) all call these helpers in the same shape.
Chunks without a matching section entry still get the document-level
header (`Document: foo.pdf`) so cross-document disambiguation works
even on outline-less files.

`sectionPath` rides on the existing `metadata jsonb` column on
`FileContentChunk`. No schema migration.

### Eval gate

Per ADR-003 Phase 1: `ndcg@10(hybrid + headers) ≥ ndcg@10(hybrid) × 1.05`
on the extended `tests/retrieval-eval/queries.yaml` corpus
(q01..q30). The extension (q21..q30) adds two query families:

- **Sentence-spanning queries** (q21..q26) — phrasings whose terms
  span a sentence boundary the legacy word-split chunker would have
  cut mid-sentence, breaking recall.
- **Section-path disambiguation** (q27..q30) — queries hinging on
  document/section context to pick the correctly-scoped chunk over a
  same-body twin.

Measured NDCG delta: *to be filled in by the live eval run* — Phase 1
batch C (steps 1.8 + 1.9) requires the full integration stack
(`./scripts/test-rag.sh`). The delta is recorded here once the
parent-shell run completes and the harness reports per-pipeline NDCG@10.

## Query enhancement (WARP-437 / ADR-003 Phase 3)

Hybrid retrieval is still doing the same vector + lexical + RRF + rerank
pipeline. WARP-437 layers **three optional knobs in front of it**: HyDE
(hypothetical document embeddings), multi-query expansion, and adaptive
routing via a zero-shot query classifier. When all three are off — the
default — `searchHybrid` runs byte-for-byte the WARP-286 path. When the
orchestrator's LLM agent loop decides a query benefits from enhancement,
the relevant pre-computed vectors and overrides flow into `searchHybrid`
through a single `queryEnhancement` block on `SearchHybridParams`.

### Three orthogonal knobs

- **HyDE** rewrites a short query into a hypothetical-answer passage,
  embeds it, and the vector arm searches against the element-wise mean
  of `[raw_query_vector, hyde_passage_vector]`. One ai-gateway chat call
  per active query. Highest expected lift on under-specified (1–3 word)
  queries.
- **Multi-query expansion** generates `n` paraphrases of the query (one
  LLM call returning a JSON array), embeds them in a single batched
  `EmbedText` call, runs N+1 parallel vector arms, then RRF-fuses the
  vector arms together before fusing with the lexical arm. Highest
  expected lift on multi-faceted analytical queries.
- **Adaptive routing** uses a `MoritzLaurer/deberta-v3-base-zeroshot-v2.0`
  zero-shot NLI classifier (~110 MB int8, ~50 ms CPU on the inference host) to
  label each query and pick a preset. The classifier runs in ai-gateway
  behind the new `ClassifyQuery` gRPC RPC; results are SHA-256-keyed and
  cached for 24 h (`warp437:cls:` Redis prefix).

### Adaptive routing preset map

| Query class | Example | Preset |
|---|---|---|
| `factual` | "what is the budget for Q4" | `rerank.candidates = 100`, no HyDE, no multi-query — let the reranker do the heavy lifting on a wider candidate pool. |
| `analytical` | "compare budget content between the PDF and the audio transcript" | `multiQuery = true (n=3)`, `rerank.candidates = 80` — fan out across paraphrases to recover recall the reranker can't synthesize. |
| `conversational` | "hey what's up" | `minSimilarity = 0.5`, `perArmK = 50`, no enhance — tight floor + smaller arms so chit-chat doesn't burn retrieval budget. |
| `navigational` | "open camera-1 settings" | metadata filter `path LIKE %<token>%` on both retrieval arms, derived from the first filename-shaped token in the query. |
| `unknown` | top-1 confidence below `CLASSIFIER_CONFIDENCE_FLOOR` (0.40) | default `searchHybrid` parameters — don't route on noise. |

The preset map lives in `presetForClass()` in
`apps/orchestrator/src/services/llm-agent.service.ts`. Filename-token
extraction prefers alphanum-with-dash tokens of length ≥3, falling back
to undefined when no such token exists.

### Wire surface: two separate enhancement channels

The MCP `search_content` tool exposes an LLM-visible `enhance` field —
`{ hyde?: boolean, multiQuery?: boolean, n?: integer 2..5 }` — so a
sufficiently-confident model can opt in directly via its tool call. This
is the simple, JSON-schema-validated channel.

The orchestrator's agent loop separately attaches a richer
`_enhancement` bundle (already-computed `hydeVector` / `extraQueryVectors`
/ `metadataFilter` / `searchOverrides`) via the MCP `_meta` channel, NOT
via the tool's args. The mcp-server's `ctx.searchHybrid` shim picks
`_enhancement` off the per-call context and threads it into
`searchHybrid(prisma, { …, queryEnhancement, minSimilarity, perArmK,
rerank.candidates })`. Why the two channels stay separate:

1. The LLM-visible `enhance` is for the model's own judgment. It's
   bounded by `additionalProperties: false` on the tool's input schema
   and validated like any other tool arg.
2. The orchestrator-computed `_enhancement` carries 384-dim float
   vectors and overrides that the LLM has no business synthesizing. It
   bypasses the args/schema layer entirely to keep the trust boundary
   crisp.

When both channels carry the same field (e.g. the LLM sets `enhance.hyde = true`
AND the orchestrator's adaptive preset already chose HyDE), the LLM's choice
wins: `llmEnhance ?? preset.enhance` in
`apps/orchestrator/src/services/llm-agent.service.ts:335-342`. The rationale
is that the LLM has seen the query in conversational context and may correctly
override a class-based default — the classifier is a cheap prior, not a hard
constraint.

### Trust boundary (MCP `_meta._enhancement`)

`_enhancement` is read from `_meta` ONLY on the trusted-stdio transport
(`services/mcp-server/src/server.ts`, gated on `claims === undefined`).
The HTTP transport never reads `_enhancement` — an off-host MCP client
with a valid JWT cannot smuggle pre-computed vectors past the input-
schema validator. The extraction also drops anything that isn't an
object (`null`, primitives, arrays — `typeof [] === "object"` so the
array check is explicit).

### Latency budget

Per query, worst case (analytical class, both LLM calls active):

| Stage | Cost (p95) |
|---|---|
| Classify (deberta zero-shot, CPU) | ~50 ms |
| HyDE chat (inference host warm, mistral-7b) | ~600 ms |
| Multi-query chat | ~600 ms |
| 4 parallel vector arms (raw + 3 paraphrases, pgvector) | ~30 ms (parallel) |
| Reranker batch (BGE-base int8 ONNX) | ~120 ms |
| **Total** | **~1.4 s p95** |

Compare to today's hybrid p95 of ~250 ms. The full budget applies ONLY
to the `analytical` preset; `factual` and `navigational` skip both LLM
calls (~190 ms), and `conversational` skips them with a tighter
similarity floor on top (~150 ms). The adaptive layer is what bounds
the worst case to the queries that benefit most.

> **Numbers above are estimated.** Measured per-class latency lands once
> the per-class eval (Task 9 / commit a1b3237) runs against the full
> Linux CI Compose stack with `RAGAS_ENABLED=1` — the harness prints
> per-pipeline timings and per-class NDCG deltas at the end of the run.
> Until then this table is a budget, not a measurement.

### Eval gate (recording mode today)

Per-class NDCG@10 slicing landed in commit `a1b3237` (Task 9). The
`it("per-class NDCG@10 — baseline vs enhanced", …)` block in
`tests/retrieval-eval/run.integration.test.ts` calls both the existing
`hybrid` and the new `hybrid-enhanced` admin variants for every query,
groups by `class`, and logs per-class baseline → enhanced deltas. The
test runs only when `SHOULD_RUN=1` (Linux CI with the full Compose
stack), and the assertion is a benign "at least one class produced
results" — **recording mode** until `tests/retrieval-eval/ragas/baselines.json`
is populated by a Linux CI run.

The spec gates that activate once baselines exist:

- **short** (`q-short-*`): `ndcg@10(enhanced) ≥ ndcg@10(baseline) × 1.05`
  AND no full-corpus regression above 2%.
- **analytical** (`q-analytical-*`): RAGAS `context_recall(enhanced) ≥
  baseline × 1.10`. Per-class context-recall is emitted into
  `metrics_by_class` by `tests/retrieval-eval/ragas/ragas_runner.py`;
  the assertion side wires up when baselines land.
- **conversational** (`q-conv-*`): if the preset regresses, default-off
  conversational routing.
- **full corpus** (q01..q30 plus all WARP-437 additions): `ndcg@10(all
  enhanced) ≥ baseline × 1.03`.

> **Measured deltas are not yet recorded** in this doc — the harness is
> in recording mode (`tests/retrieval-eval/run.integration.test.ts:252`)
> and prints values to console without persisting them. Once the first
> Linux CI run produces baselines, this section will be amended with the
> measured per-class NDCG / RAGAS deltas alongside the spec gates.

### Files

- `services/ai-gateway/query_classifier.py` — deberta zero-shot singleton.
- `services/ai-gateway/grpc_server.py` — `ClassifyQuery` handler.
- `apps/orchestrator/src/services/query-enhancement.service.ts` —
  `hydeRewrite`, `multiQueryExpand`, `classifyQuery`.
- `apps/orchestrator/src/services/query-classifier.client.ts` — gRPC wrapper.
- `apps/orchestrator/src/services/llm-agent.service.ts` —
  `presetForClass`, `EnhancementDeps`, the agent-loop pre-dispatch hook
  on `search_content` calls.
- `apps/orchestrator/src/services/file-search.service.ts` +
  `services/mcp-server/src/file-search.service.ts` —
  `QueryEnhancementOption` mirror, HyDE averaging, multi-query fan-out,
  `filenameContains` plumbing on both retrieval arms.
- `packages/tools-core/src/private-enhancement.ts` — shared
  `PrivateEnhancement` type carried via MCP `_meta`.
- `apps/orchestrator/src/routes/admin-retrieval-eval.ts` — the
  `hybrid-enhanced` variant the eval harness consumes.

### Production wiring status

The agent loop's `EnhancementDeps` is wired in production behind the
`QUERY_ENHANCEMENT_ENABLED=1` feature flag (default OFF; named
`WARP_437_ENHANCEMENT_ENABLED` before 2026-07). When the
flag is unset or any value other than `"1"`, `createEnhancementDeps` in
`apps/orchestrator/src/services/query-enhancement.service.ts` returns
`undefined` and the agent loop runs byte-for-byte the WARP-286 path.
When the flag is `"1"`, the factory wires:

- `EmbeddingClient` (existing) on `AI_GATEWAY_GRPC_URL` for HyDE /
  multi-query vector encoding.
- `QueryClassifierClient` (WARP-437 new) on the same gRPC endpoint for
  the deberta zero-shot classify call.
- A Redis-backed `ClassifyQueryCache` over the orchestrator's existing
  singleton (`apps/orchestrator/src/services/cache.service.ts`).
- An HTTP chat adapter wrapping `aiGateway.chat` in the `ChatClient`
  shape expected by `hydeRewrite` / `multiQueryExpand`. The HTTP route
  doesn't carry the gRPC `priority` field — the adapter accepts and
  discards it; HyDE / multi-query land at default HTTP priority.

The flag is per-environment, not per-user. Roll out by setting it in
the orchestrator's `.env` (and recreate the container — `docker restart`
doesn't re-read env files; see CLAUDE.md's "Updating `.env` on a running
stack").

First-time deberta model download is ~110 MB; the Dockerfile pre-warm
covers it for fresh builds. On running containers, the first
`search_content` call after the flag flip pays the cold-load latency
(<60 s on the WARP appliance), then steady-state is ~50 ms per classify.

The admin retrieval-eval `hybrid-enhanced` variant does NOT consult the
feature flag — it always runs the full pipeline so eval coverage is
independent of the rollout.

### See also

- ADR-003 §"Phase 3 — Query enhancement"
  ([`docs/ADR-003-rag-techniques-adoption.md`](ADR-003-rag-techniques-adoption.md))
- Design spec:
  [`docs/superpowers/specs/2026-05-25-warp-437-query-enhancement-design.md`](superpowers/specs/2026-05-25-warp-437-query-enhancement-design.md)
- Implementation plan:
  [`docs/superpowers/plans/2026-05-25-warp-437-query-enhancement-plan.md`](superpowers/plans/2026-05-25-warp-437-query-enhancement-plan.md)
