# ADR-003: RAG Techniques Adoption — Phased Cherry-Pick over Framework Swap

**Status:** Proposed
**Date:** 2026-05-24
**Deciders:** Engineering team
**Source:** Inventory of `NirDiamant/RAG_Techniques` (37 notebooks + 4 eval notebooks, May 2026); audit of `services/file-indexer/`, `services/ai-gateway/`, `apps/orchestrator/src/services/file-search.service.ts`, `services/mcp-server/src/file-search.service.ts`, `docs/RAG_RETRIEVAL.md`, `docs/RAG_TESTING.md`, `docs/ROADMAP.md` M3.3

## Context

The current retrieval stack (WARP-201..206, WARP-218, WARP-286) is more mature than the baseline most advanced-RAG literature assumes:

- **Hybrid retrieval is shipped.** Vector (pgvector cosine, 384-dim `all-MiniLM-L6-v2`) + lexical (Postgres `tsvector` with `ts_rank_cd`), fused with Reciprocal Rank Fusion (`RRF_DEFAULT_K=60`), reranked by `BGE-reranker-base` int8 ONNX via ai-gateway gRPC, cached in Redis with auto-invalidating chunk-id-keyed entries.
- **Extraction covers ~15 MIME types.** PDF (with EasyOCR fallback), DOCX/XLSX/PPTX, plain text/markdown, archives with recursive descent + chain breadcrumbs, EML/MSG with attachment traversal, audio/video routed through the WARP-218 transcription worker with a 3-attempts-per-hour cap.
- **State machine is explicit.** `BrainMemoryItemStatus` enum (`queued_for_transcription | indexing | ready | failed`), with reconciliation for stuck rows and a no-guessing rule (CLAUDE.md) that already forbids deriving status from null columns.
- **RBAC is at the SQL layer.** `WHERE userId = $1` on both retrieval arms; cross-user leakage is impossible by construction.
- **An eval harness exists.** `tests/retrieval-eval/queries.yaml` + `run.integration.test.ts` enforce `ndcg(hybrid) ≥ 1.1 × ndcg(vector-only)` and gate merges.
- **The two `file-search.service.ts` copies (orchestrator + mcp-server) are deliberately mirrored** per WARP-202 so drift is a single-file diff away from being caught.

What does NOT exist today:

1. No query-side transformations — the raw user query is embedded and FTS-parsed as-is. No HyDE, no multi-query/RAG-Fusion, no query classification or adaptive routing.
2. No structural enrichment at ingest — chunks are fixed-window word splits (~512 token equivalent, 20% overlap), with no document/section header prepended, no sentence boundaries, no propositioning.
3. No retrieval grading or correction loop — every retrieval round-trip is "best effort, return what RRF+rerank gives." There is no self-check on whether the top-K is actually relevant before injecting into the prompt.
4. No multimodal embedding — images in `BrainMemoryItem` are stored with `image_only` warning and skipped from semantic search. M3.3 in `docs/ROADMAP.md` flags this and ties it to inference-engine capacity.
5. No structured metadata filtering at query time — `pageNumber`, `warnings`, `source`, `indexedAt`, `chain[]` are stored but not exposed as filter knobs on `searchHybrid`.
6. The eval harness checks NDCG@10 only — no faithfulness, context relevance, hallucination, or answer-correctness metrics. The corpus is 20 hand-curated queries; click-derived ground truth is blocked on Phase B.

The reference corpus (`NirDiamant/RAG_Techniques`) catalogs 37 techniques across chunking, query transformation, retrieval, reranking, context augmentation, iterative/agentic, multimodal, graph, and evaluation. ~70% of those notebooks are LangChain-first; a handful use LlamaIndex as parallel implementations; specialized ones (ColPali, Microsoft GraphRAG, MemoRAG) drop to raw libraries. None of the foundational abstractions in that catalog map cleanly onto our Node+Python split, our trusted-stdio MCP transport, our per-user RBAC injection at context-build time, or our mirrored-implementation pattern.

## Decision

**Cherry-pick high-ROI techniques over a phased rollout. Do not adopt LangChain or LlamaIndex as a framework. Add RAGAS as an eval-only Python dependency inside the existing offline harness.**

Justification:

- The catalog's foundational abstractions (LangChain's `Retriever`, `Document`, `Runnable`; LlamaIndex's `QueryEngine`, `NodeParser`) duplicate what `file-search.service.ts`, the WARP-202 mirror, and `searchHybrid`'s typed param block already provide — but without the per-user RBAC binding, the explicit state machine, or the latency-budgeted operational notes. Adopting either framework would force a rewrite of the MCP context-injection layer and the rerank cache, with no quality gain.
- The catalog is structured as **techniques, not frameworks.** Every technique we want from it (HyDE, contextual headers, small-to-big, adaptive retrieval, CRAG-lite, semantic chunking, CLIP) is a <300-LOC change to `chunker.py`, `file-search.service.ts`, or the orchestrator's agent loop — each adds one capability, each is independently gated on an eval delta, each preserves the abstractions that already work.
- For **evaluation only**, RAGAS gives us faithfulness / context-relevance / answer-correctness metrics that NDCG@10 doesn't cover. It runs offline as a Python script inside `tests/retrieval-eval/`, never in the production path. Its judge LLM can be the local Ollama model for routine runs and a cloud model for golden runs — no production dependency on a cloud judge.

**Adoption priority is set by three filters, in order:** (a) edge-viable on Jetson Orin Nano with local Ollama, (b) measurable in the existing eval harness (NDCG@10 today, RAGAS metrics after Phase 2), (c) leverage proportional to cost.

## Options considered

### Option A — Cherry-pick + custom (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium, spread over 4 phases |
| Cost | ~6 sprints if all phases land |
| Team familiarity | High — every change is local to one file/service |

**Pros:** Preserves WARP-286 abstractions, RBAC layer, and state machine. Every technique is independently gated on eval. No new framework lock-in. RAGAS as a scoped eval-only dep.
**Cons:** No framework convenience — each technique is hand-implemented. Requires discipline to keep `chunker.py` and `file-search.service.ts` from accreting branches without eval evidence.

### Option B — Adopt LangChain as the orchestrator's retrieval layer

**Pros:** Many notebooks port over with minimal change. Active community.
**Cons:** Forces rewrite of `searchHybrid` interface (it doesn't fit `Runnable`); breaks the WARP-202 mirror with the mcp-server; doesn't map onto the trusted-stdio MCP context injection; adds a Python-shaped abstraction (it's Python-first) into a Node service; pre-1.0 churn historically painful. The gain (technique portability) is dwarfed by the rewrite cost.

### Option C — Adopt LlamaIndex on the Python side (ai-gateway / file-indexer)

**Pros:** Better-suited than LangChain to indexing-heavy code. Solid abstractions for ingest pipelines.
**Cons:** Same context-injection / RBAC mismatch. file-indexer's responsibilities (watchdog events, MQTT publishes, state-machine transitions, transcription worker retry caps) extend well beyond LlamaIndex's pipeline model. Would absorb our ingest code rather than augment it.

### Option D — Haystack 2.x

**Pros:** Pipeline-first, has good rerank/retriever primitives, framework-agnostic.
**Cons:** Same context-injection mismatch as A and B; absent from the reference catalog so technique ports require extra work; ecosystem smaller than LangChain or LlamaIndex.

### Option E — Status quo

**Pros:** Zero risk. Current stack passes NDCG@10 ≥ 1.1× threshold.
**Cons:** Leaves measurable wins on the table (HyDE, contextual headers, small-to-big are each likely worth several NDCG points individually based on published benchmarks). Blocks M3.3 (multimodal). Doesn't establish the RAGAS-style metrics needed to safely add CRAG-style validation loops later.

## Adoption plan

Each phase has: a goal, the techniques drawn from the reference catalog, the files that change, the eval gate, and a dependency note. Phases are sequenced so each one strengthens the eval surface that the next one is gated by.

### Phase 1 — Ingest-side enrichment (low-risk, high-ROI)

**Goal:** Improve embedding quality without touching the query path or the agent loop. Each technique is a ~50–150 LOC change to `services/file-indexer/`. None require a schema migration; they all rewrite the *content* of `FileContentChunk.text` before it's embedded.

**Techniques from catalog:**

| Catalog ref | Adoption form |
|---|---|
| Contextual Chunk Headers (`contextual_chunk_headers.ipynb`) | Prepend `"Document: <filename> / Section: <heading-or-page>\n\n"` to every chunk before embedding. Heading derived from PDF outline (already extracted by `pypdf`), DOCX heading style, or filename for plain text. |
| Semantic Chunking (`semantic_chunking.ipynb`) | Replace `chunker.py`'s word-split with `RecursiveCharacterTextSplitter`-style sentence-aware split (separators: paragraph → sentence → word, target 512 tokens). For code/tables, preserve atomic blocks via fenced-region detection. |
| Anthropic-style "Contextual Retrieval" (related to `contextual_chunk_headers` but with LLM) | Defer to Phase 4. Heavy ingest LLM cost; gate on Phase 2 eval showing a measurable lift from the cheaper headers. |

**Files changed:**
- `services/file-indexer/chunker.py` — sentence-aware splitter (~150 LOC).
- `services/file-indexer/extractors/pdf.py`, `docx.py`, `pptx.py` — extract heading hierarchy alongside body text. Most already do (`pageNumber` is already on `FileContentChunk`). Add `sectionPath: string[]` to the per-chunk metadata.
- `services/file-indexer/embedder.py` — accept an optional `prefix` per text in the batch.
- `apps/orchestrator/prisma/schema.prisma` — no migration needed; reuse `metadata jsonb`.
- `tests/retrieval-eval/queries.yaml` — extend with 10 queries where heading context disambiguates the answer (e.g. two PDFs with the same body sentence in different sections).

**Eval gate:** `ndcg@10(hybrid + headers) ≥ ndcg@10(hybrid) × 1.05` on the extended corpus. If we don't see a 5% lift, drop the technique and document why in `RAG_RETRIEVAL.md`.

**Cost:** ~1 sprint. No production LLM cost. Re-index is required (one-time, runs on the existing file-indexer pipeline).

### Phase 2 — Evaluation surface (unblocks every later phase)

**Goal:** Add faithfulness, context-relevance, and answer-correctness metrics to the existing NDCG@10 harness. This is the prerequisite for safely landing query-side and agentic techniques later — without these metrics we can't detect when CRAG-style loops are improving precision but hurting recall, or when query rewriting is drifting from user intent.

**Techniques from catalog:**

| Catalog ref | Adoption form |
|---|---|
| DeepEval / End-to-End RAG Evaluation / Open-RAG-Eval / GroUSE (`evaluation/*.ipynb`) | Adopt **RAGAS** specifically (not in the catalog, but the de-facto standard the catalog's eval notebooks orbit around). Faithfulness, context_relevance, answer_correctness, context_precision, context_recall. |

**Why RAGAS over the catalog's specific notebooks:** RAGAS has the smallest dependency footprint (no LangChain agent runtime required), a stable metric API, and explicit support for local Ollama as the judge LLM. The catalog's notebooks are pedagogical wrappers — they don't ship a stable CLI we want in CI.

**Files changed:**
- `tests/retrieval-eval/ragas/` — new directory. `ragas_runner.py`, `goldens.yaml` (extends `queries.yaml` with expected answers), `requirements.txt` pinning `ragas`.
- `tests/retrieval-eval/run.integration.test.ts` — add a `RAGAS_ENABLED=1` mode that shells out to the Python runner and asserts thresholds.
- `scripts/test-rag.sh` — new flag `--with-ragas`. Default off in PR CI (judge LLM cost is non-trivial); on for nightly + release gates.
- `docs/RAG_TESTING.md` — new "RAGAS metrics" section documenting thresholds and judge-LLM policy.

**Judge-LLM policy:**
- Default judge: the local model (`mistral:7b-instruct` or whatever the appliance ships with). Cheap, deterministic enough for regression detection.
- Golden judge: a cloud model (Claude Sonnet or GPT-4o) gated behind an explicit `RAGAS_JUDGE=cloud` env var. Run on release-candidate builds only, not on every PR.

**Eval gate:** Establish baselines this phase. Thresholds are set in Phase 3 once we have one stable run of numbers.

**Cost:** ~1 sprint. No production runtime impact (offline harness only).

### Phase 3 — Query-side enhancement

**Goal:** Improve retrieval recall on under-specified or short queries via lightweight LLM-driven query expansion. Each technique adds at most one LLM call per user query, gated by a heuristic so the cost only applies when it's likely to help.

**Techniques from catalog:**

| Catalog ref | Adoption form |
|---|---|
| HyDE (`HyDe_*.ipynb`) | One LLM call to generate a hypothetical answer to the query; embed that instead of the raw query. **Gated:** only fired when `query.length < 80 chars` (the under-specified case where HyDE helps most). |
| Query Transformations / multi-query (`query_transformations.ipynb`) | Generate 3 query rewrites via one LLM call. Embed each in parallel (batched in the gRPC `EmbedText` call — already supports up to 256 per batch). Run vector search per query, RRF-fuse the results, then continue the existing pipeline. |
| Adaptive Retrieval (`adaptive_retrieval.ipynb`) | One classifier LLM call: `{factual | analytical | conversational | navigational}`. Each class maps to a `searchHybrid` parameter preset (e.g. factual → `rerank.candidates=100`, conversational → `minSimilarity=0.5` to reduce noise, navigational → metadata filter on filename match). |

**Files changed:**
- `apps/orchestrator/src/services/query-enhancement.service.ts` — new file. Three exported functions: `hydeRewrite`, `multiQueryExpand`, `classifyQuery`. Each is a thin wrapper around the ai-gateway's chat endpoint.
- `apps/orchestrator/src/services/file-search.service.ts` — `searchHybrid` accepts an optional `queryEnhancement: { hyde?, multiQuery?, adaptive? }` block. When omitted, behavior is unchanged. WARP-202 mirror update required.
- `services/mcp-server/src/file-search.service.ts` — same signature change for the mirror.
- `packages/tools-core/src/handlers/files/search-content.ts` — pass enhancement flags through from the LLM agent loop.
- `tests/retrieval-eval/queries.yaml` — extend with 15 queries known to be under-specified (1–3 words), 10 multi-faceted analytical queries, 10 conversational queries.

**Eval gate (per technique, evaluated independently):**
- HyDE: `ndcg@10(hyde) ≥ ndcg@10(baseline) × 1.05` on the under-specified subset, no regression (>2%) on the full corpus.
- Multi-query: `context_recall(multi-query) ≥ context_recall(baseline) × 1.10` (RAGAS metric from Phase 2). Latency p99 budget: +400 ms.
- Adaptive: `ndcg@10` lift on each class is independently positive; if conversational class shows regression, default it off and document.

**Cost:** ~2 sprints. Adds 1 LLM call per query (worst case 2: classification + HyDE), all on the existing local model. Latency budget: +200ms cold, negligible warm.

### Phase 4 — Reflection & correction

**Goal:** Catch low-confidence retrievals before they become bad answers. Add a lightweight grader between retrieval and generation, with a fallback path that re-queries.

**Techniques from catalog:**

| Catalog ref | Adoption form |
|---|---|
| CRAG (`crag.ipynb`) | One grader LLM call on the top-K retrieved chunks: `{relevant | partial | irrelevant}`. On `irrelevant`, fall back to query expansion (Phase 3 multi-query) and re-retrieve once. On `partial`, mark the context with a hedge instruction in the prompt. Do **not** call out to web search (the reference notebook's fallback); we don't have a sanctioned local web search path and adding one belongs to a separate ADR. |
| Reliable RAG (`reliable_rag.ipynb`) | Subsumed into CRAG above — the relevance check is the same call. |
| Self-RAG (`self_rag.ipynb`) | **Anti-recommended for production** per the catalog summary — 3–5 LLM calls per query is too expensive on Jetson Orin. Skip. |

**Files changed:**
- `apps/orchestrator/src/services/retrieval-grader.service.ts` — new file. Single `gradeRetrieval({ query, chunks })` function returning the verdict.
- Orchestrator's agent loop (where `search_content` results are stitched into the prompt) — call the grader, branch on verdict.
- `packages/tools-core/src/handlers/files/search-content.ts` — extend `ToolResult.data` with a `grading?` field so the LLM sees the verdict and can self-hedge.
- `tests/retrieval-eval/ragas/` — gate this phase on the `faithfulness` and `answer_correctness` metrics from Phase 2.

**Eval gate:** `faithfulness(crag) ≥ faithfulness(baseline) + 0.05` AND `answer_correctness(crag) ≥ answer_correctness(baseline) + 0.03`, on the full corpus. Latency p99 budget: +500 ms in the worst case (grader + re-retrieve).

**Cost:** ~2 sprints. The grader runs only after the existing pipeline completes; on `relevant` (expected majority) no extra cost beyond one LLM call.

### Phase 5 — Multimodal (unblocks M3.3)

**Goal:** Land CLIP image embeddings, joining text and image chunks in the same retrieval surface. Already in the ROADMAP as M3.3; this ADR scopes the technique choice and the eval addition.

**Techniques from catalog:**

| Catalog ref | Adoption form |
|---|---|
| Multi-modal RAG with Captioning (`multi_model_rag_with_captioning.ipynb`) | **First.** VLM captions each image at ingest; caption is stored as `FileContentChunk.text` and embedded with the existing text embedder. Zero query-time changes. Acceptable while CLIP capacity is uncertain. |
| Multi-modal RAG with ColPali (`multi_model_rag_with_colpali.ipynb`) | **Anti-recommended for Orin Nano at this scale.** Late-interaction on rendered page images is too memory-heavy. Skip unless the ingest VLM path measurably underperforms. |

**Files changed:**
- `services/file-indexer/extractors/image.py` — currently stub; add VLM-caption path. VLM model selection (LLaVA quantized, MiniCPM-V) is the M3.3 blocker — depends on inference-engine capacity.
- `apps/orchestrator/prisma/schema.prisma` — add `modality: enum('text' | 'image_caption')` to `FileContentChunk`. Migration required.
- `services/ai-gateway/grpc_server.py` — new `CaptionImage` RPC alongside `EmbedText` and `Rerank`.
- `tests/retrieval-eval/queries.yaml` — extend with 10 image-grounded queries (PDF with figures, image-only chat attachments).

**Eval gate:** No regression on text-only queries; `ndcg@10(image queries)` strictly above zero (baseline is zero — images aren't searchable today).

**Cost:** ~2 sprints once inference-engine capacity is confirmed. Cross-repo dependency on `droplet-jetson-ai` for the VLM model.

### Phase 6 — Hold for evidence

**Techniques NOT in this plan** — explicitly held back unless eval evidence justifies them later:

- **pg_search / Tantivy swap** (already documented as a future swap in `RAG_RETRIEVAL.md§Future swap`). Gate: Postgres FTS precision floor measurable in Phase 2 RAGAS metrics.
- **Proposition Chunking / HyPE / Document Augmentation.** Heavy ingest-LLM cost. Gate: Phase 1 (sentence-aware + headers) eval lift is below 3%, indicating chunk-content is the bottleneck.
- **Microsoft GraphRAG / RAPTOR / Hierarchical Indices.** Large ingest cost and complex index footprint. Gate: a user-visible failure mode (multi-hop question, cross-document synthesis) emerges that hybrid+rerank can't address.
- **Sophisticated Controllable RAG Agent / Agentic RAG (Contextual AI).** Vendor lock-in or LangGraph commitment. Out of scope for this ADR.
- **MemoRAG.** GPU-heavy memory model; doesn't quantize gracefully on Orin Nano.

## Roadmap entries (proposed additions to `docs/ROADMAP.md`)

These map onto the GTM milestone style. Suggested placement: under Stage 3 (Production Scale, Month 7+), as a new subsection "Retrieval quality (post-M2)" since they extend the M2.x retrieval work rather than fitting cleanly into an existing milestone.

```markdown
### M-RAG.1 Ingest enrichment (Phase 1 of ADR-003)
- **Scope:** Sentence-aware chunking + contextual chunk headers.
- **Files:** services/file-indexer/chunker.py, services/file-indexer/extractors/*.py
- **Status:** [ ] Not started
- **Eval gate:** ndcg@10 ≥ 1.05× current baseline.

### M-RAG.2 RAGAS eval harness (Phase 2 of ADR-003)
- **Scope:** Faithfulness / context-relevance / answer-correctness metrics.
- **Files:** tests/retrieval-eval/ragas/, scripts/test-rag.sh
- **Status:** [ ] Not started
- **Eval gate:** Baselines established; thresholds set in M-RAG.3+.

### M-RAG.3 Query enhancement (Phase 3 of ADR-003)
- **Scope:** HyDE (gated), multi-query, adaptive retrieval.
- **Files:** apps/orchestrator/src/services/query-enhancement.service.ts, file-search.service.ts (+mirror)
- **Status:** [ ] Not started
- **Blockers:** M-RAG.2 (need RAGAS metrics to gate adaptive).

### M-RAG.4 Retrieval grading / CRAG-lite (Phase 4 of ADR-003)
- **Scope:** Grader-then-rewrite loop; no web-search fallback.
- **Files:** apps/orchestrator/src/services/retrieval-grader.service.ts, orchestrator agent loop
- **Status:** [ ] Not started
- **Blockers:** M-RAG.2 (faithfulness metric required), M-RAG.3 (multi-query is the fallback).

### M-RAG.5 Multimodal indexing (extends M3.3)
- **Scope:** VLM-caption-first multimodal indexing. ColPali deferred.
- **Files:** services/file-indexer/extractors/image.py, services/ai-gateway/grpc_server.py (new CaptionImage RPC), prisma schema (add modality enum)
- **Status:** [ ] Not started
- **Blockers:** inference-engine VLM capacity (cross-repo).
```

## Consequences

**Positive:**
- Every existing abstraction is preserved. WARP-202 mirror, RBAC, state machine, cache invalidation all stay intact.
- Each phase is independently mergeable, independently revertible, independently eval-gated.
- The eval surface is the gate, not the technique. If Phase 1 doesn't lift NDCG, we don't compound it with Phase 3.
- No production runtime depends on a cloud LLM. Cloud judge is opt-in for goldens only.

**Negative:**
- No framework convenience. Every new technique is hand-written and tested. Discipline cost is real, especially on the WARP-202 mirror (every `searchHybrid` signature change is two files).
- RAGAS adds a Python dependency to `tests/retrieval-eval/`. Already Python-heavy in `services/`, so the operational delta is small.
- Phase 4's CRAG-lite without a web-search fallback is weaker than the reference notebook. A follow-up ADR can scope a local web-search path if user evidence shows the fallback is needed.

**Neutral:**
- Three of the techniques here (sentence-aware chunking, contextual headers, HyDE) are foundational enough that we'll likely keep them even if the eval delta is marginal — they're cheap and aligned with how the rest of the field has converged. The eval gate is a safety net, not a tournament.

## References

- `docs/RAG_RETRIEVAL.md` — WARP-286 design, tuning knobs, latency budget, future-swap path for pg_search.
- `docs/RAG_TESTING.md` — WARP-201..206 integration suite, including the end-to-end chat-citation flows.
- `docs/ROADMAP.md` M3.3 — Photo Indexing (CLIP) milestone, currently blocked on inference-engine capacity.
- `apps/orchestrator/src/services/file-search.service.ts` — `searchHybrid`, RRF constants, rerank pipe.
- `services/file-indexer/chunker.py` — current word-split chunker.
- `https://github.com/NirDiamant/RAG_Techniques` — reference catalog.
- `https://docs.ragas.io/` — RAGAS metrics documentation.
