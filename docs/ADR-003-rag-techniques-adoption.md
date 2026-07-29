# ADR-003: RAG Techniques Adoption — Phased Cherry-Pick over Framework Swap

**Status:** Accepted — the approach was adopted and is 3/5 executed (status corrected 2026-07-27; see Status audit below)
**Date:** 2026-05-24
**Deciders:** Engineering team
**Source:** Inventory of `NirDiamant/RAG_Techniques` (37 notebooks + 4 eval notebooks, May 2026); audit of `services/file-indexer/`, `services/ai-gateway/`, `apps/orchestrator/src/services/file-search.service.ts`, `services/mcp-server/src/file-search.service.ts`, `docs/RAG_RETRIEVAL.md`, `docs/RAG_TESTING.md`, `docs/ROADMAP.md` M3.3
**Tracking:** WARP-RAG epic + WARP-RAG.1..5 phase tickets (see "Tickets" section below)
**Branch:** `feat/rag-techniques-adoption`

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

**Adoption priority is set by three filters, in order:** (a) edge-viable on the appliance's inference host with local Ollama, (b) measurable in the existing eval harness (NDCG@10 today, RAGAS metrics after Phase 2), (c) leverage proportional to cost.

## Options considered

### Option A — Cherry-pick + custom (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium, spread over 4 phases |
| Cost | ~6 weeks if all phases land (calendar, 1 dev focused) |
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

---

## Conventions for the step tables below

Each step row carries:

- **#** — stable step ID, also used as the Jira sub-task identifier when applicable
- **Step** — what to do, in imperative form
- **Files / surfaces** — exact paths or globs the work touches
- **Depends on** — step IDs that must complete first; `—` means no in-phase dependency
- **Batch** — a letter `A`, `B`, `C`... All steps with the same letter in the same phase have no shared state and can be dispatched as one parallel agent group. The harness contract: batch `A` runs first; once every step in `A` is complete, batch `B` runs; etc.

**Parallelization read:** "Phase 1 batch A has 6 independent steps" means the executing agent should dispatch all 6 simultaneously (one Agent tool call with 6 sub-prompts, or 6 parallel subagents) rather than serially. Where two steps touch the same file or share schema, they're put in different batches even if they're logically siblings.

---

## Adoption plan

### Phase 1 — Ingest enrichment (sentence-aware chunking + contextual headers)

**Goal:** Improve embedding quality without touching the query path or the agent loop. Every chunk that lands in `FileContentChunk.text` is now sentence-respecting and prefixed with its document/section path, so the embedder sees text that already carries hierarchical context.

**Framework picks (researched 2026-05-24):**

- **Text splitter: `semantic-text-splitter` v0.30.x** (Rust-backed Python crate, ~8 MB wheel). Sentence-aware via Unicode segmentation, tokenizer-aware via native HuggingFace tokenizers, zero LangChain coupling. Beats `langchain-text-splitters` on footprint (which transitively pulls NLTK or spaCy models, both 100+ MB) and `unstructured` on scope (we already own MIME-specific extractors).
- **PDF heading hierarchy: `pypdf.PdfReader.outline`** (already a transitive dep via existing extractors). Returns the bookmark tree as nested `Destination` objects with `/Title` + page references. No new dep.
- **DOCX heading hierarchy: `python-docx` `paragraph.style.name`** (already a dep). `if name.startswith("Heading"): level = int(name.split()[-1])`. No new dep.
- **PPTX section detection: `python-pptx` slide layout name + `slide.shapes.title.text`** (already a dep). No new dep.

**Step-by-step:**

| # | Step | Files / surfaces | Depends on | Batch |
|---|---|---|---|---|
| 1.1 | Add `semantic-text-splitter` to file-indexer `requirements.txt`; rewrite `chunker.py` to wrap `TextSplitter.from_huggingface_tokenizer(...)` with `CHUNK_SIZE_TOKENS=512`, `chunk_overlap_ratio=0.2`. Keep the existing public signature (`chunk_text(text: str) -> List[Chunk]`) for caller compatibility. | `services/file-indexer/chunker.py`, `services/file-indexer/requirements.txt` | — | A |
| 1.2 | Extract PDF outline tree in `extractors/pdf.py`; map each extracted text span to its nearest preceding outline entry; emit `sectionPath: list[str]` per chunk-candidate. | `services/file-indexer/extractors/pdf.py` | — | A |
| 1.3 | Extract DOCX heading hierarchy in `extractors/docx.py` using `paragraph.style.name`; emit `sectionPath` walking back from each body paragraph. | `services/file-indexer/extractors/docx.py` | — | A |
| 1.4 | Extract PPTX slide-section structure in `extractors/pptx.py` using slide layout + title shape; `sectionPath = [section_name, slide_title]`. | `services/file-indexer/extractors/pptx.py` | — | A |
| 1.5 | For TXT/MD/EML/MSG, emit `sectionPath = [filename]` (no in-file structure available). | `services/file-indexer/extractors/text.py`, `extractors/email.py` | — | A |
| 1.6 | Extend `tests/retrieval-eval/queries.yaml` with 10 disambiguation queries (e.g. two PDFs with the same body sentence in different sections; question must hinge on section path to retrieve the right one). | `tests/retrieval-eval/queries.yaml` | — | A |
| 1.7 | Plumb `sectionPath` through `db.py` upsert; prepend `f"Document: {filename} / Section: {' > '.join(sectionPath)}\n\n"` before embedding. | `services/file-indexer/db.py`, `services/file-indexer/embedder.py` | 1.1, 1.2, 1.3, 1.4, 1.5 | B |
| 1.8 | Trigger a full re-index of fixtures; verify status enum transitions (`queued → indexing → ready`) hold; check WARP-218 retry counters stay at zero. | `services/file-indexer/` runtime | 1.7 | C |
| 1.9 | Run `tests/retrieval-eval/run.integration.test.ts`; assert `ndcg@10(hybrid + headers) ≥ ndcg@10(hybrid) × 1.05` on the extended corpus. | `tests/retrieval-eval/` | 1.8 | C |
| 1.10 | Update `docs/RAG_RETRIEVAL.md` with the new chunking section + `sectionPath` documentation; record measured NDCG delta. | `docs/RAG_RETRIEVAL.md` | 1.9 | D |

**Batches at a glance:** A (6 parallel) → B (1) → C (2 sequential) → D (1).
**Files changed:** ~7 files, ~400 LOC, 0 schema migrations (`sectionPath` rides on existing `metadata jsonb`).
**Eval gate:** `ndcg@10(hybrid + headers) ≥ ndcg@10(hybrid) × 1.05` on the extended corpus.
**Calendar:** 5–8 working days, 1 dev focused.
**Risk:** None of these steps touch the query path. Worst case: re-index produces no measurable delta and we revert step 1.7 to disable header prefixing while keeping sentence-aware chunking. Sentence-aware chunking is foundational enough that we keep it regardless of header-prefix outcome.

---

### Phase 2 — RAGAS evaluation harness

**Goal:** Add faithfulness, context-relevance, and answer-correctness metrics to the existing NDCG@10 harness. Establish baselines so Phases 3 and 4 can be gated on them. No production runtime change — this is offline only.

**Framework picks (researched 2026-05-24):**

- **`ragas==0.4.x`** (current as of 2026-01). Native local-Ollama support via `ragas.llms.llm_factory("mistral", provider="openai", client=OpenAI(base_url="http://localhost:11434/v1"))`. Does NOT drag in LangChain agent runtime — only `langchain-core` types come along. Stable metrics: `Faithfulness`, `LLMContextRecall`, `LLMContextPrecision`, `AnswerRelevancy`, `FactualCorrectness`. Single `evaluate(dataset=..., metrics=[...], llm=...)` entry point.
- **Considered + rejected: DeepEval.** Bigger surface (full eval framework + Confident AI dashboards), unnecessary for nightly CI metrics on an appliance.
- **Considered + rejected: TruLens.** Production-tracing focus; we want offline batch eval.

**Step-by-step:**

| # | Step | Files / surfaces | Depends on | Batch |
|---|---|---|---|---|
| 2.1 | Create `tests/retrieval-eval/ragas/` directory with `requirements.txt` pinning `ragas==0.4.3`, `openai>=1.0`, `datasets`, and `pandas`. Add `pyproject.toml` or `setup.cfg` markers so the dep is isolated from production. | `tests/retrieval-eval/ragas/requirements.txt`, `tests/retrieval-eval/ragas/pyproject.toml` | — | A |
| 2.2 | Author `goldens.yaml` extending `queries.yaml` with `expected_answer` and `expected_contexts` (chunk-id list) per query. Cover the existing 20-query corpus first. | `tests/retrieval-eval/ragas/goldens.yaml` | — | A |
| 2.3 | Implement `ragas_runner.py`: load goldens, call orchestrator's `/api/admin/retrieval-eval/search` for each query, build a `Dataset`, run `evaluate(..., metrics=[Faithfulness, LLMContextRecall, LLMContextPrecision, AnswerRelevancy, FactualCorrectness], llm=local_llm)`. Emit JSON + Markdown summary. | `tests/retrieval-eval/ragas/ragas_runner.py` | 2.1, 2.2 | B |
| 2.4 | Add `RAGAS_ENABLED=1` mode to `tests/retrieval-eval/run.integration.test.ts` that shells out to `ragas_runner.py` and asserts threshold envelopes (set in 2.7). | `tests/retrieval-eval/run.integration.test.ts` | 2.3 | C |
| 2.5 | Add `--with-ragas` flag + `RAGAS_JUDGE={local\|cloud}` env handling to `scripts/test-rag.sh`. Default judge: local Ollama. Cloud judge requires explicit env var. | `scripts/test-rag.sh` | 2.3 | C |
| 2.6 | Run RAGAS on a schedule via an on-appliance service (`services/rag-eval/`, opt-in via Compose profile `eval`), invoking `ragas_runner.py` against the running stack — not via GitHub Actions (project convention: GHA is for dev tasks, not on-machine functionality). PR CI stays NDCG-only (RAGAS too slow per-PR; the appliance cadence is hourly off-hours). | `services/rag-eval/` (new) | 2.5 | C |
| 2.7 | Run baselines 5×, record p50/p95 per metric, set thresholds at `baseline_p50 - 1.5 × IQR` as the regression envelope. Commit baselines to `tests/retrieval-eval/ragas/baselines.json`. | `tests/retrieval-eval/ragas/baselines.json` | 2.4 | D |
| 2.8 | Document RAGAS metrics + judge-LLM policy + threshold rationale in a new `## RAGAS metrics` section of `docs/RAG_TESTING.md`. | `docs/RAG_TESTING.md` | 2.7 | E |

**Batches at a glance:** A (2 parallel) → B (1) → C (3 parallel) → D (1) → E (1).
**Files changed:** ~6 files, ~300 LOC Python + harness wiring, no schema migrations.
**Eval gate:** Baselines established; thresholds set for Phases 3+.
**Calendar:** 4–6 working days, 1 dev focused.
**Risk:** RAGAS metric variance on a small corpus (20 queries) — that's why we average 5 runs and set envelopes from IQR rather than single-shot thresholds. If variance is still too high, extend corpus to ≥50 queries before fixing thresholds.

**Independence from Phase 1:** Phase 2 touches only `tests/retrieval-eval/ragas/` and harness scripts; it does NOT depend on Phase 1's chunker changes. **Phases 1 and 2 can run fully in parallel as two independent work streams.** This is the highest-value parallelization in the whole plan.

---

### Phase 3 — Query enhancement (HyDE + multi-query + adaptive routing)

**Goal:** Improve retrieval recall on under-specified or short queries via lightweight LLM-driven query expansion. Each technique adds at most one LLM call per user query, gated by a heuristic so the cost only applies when it's likely to help.

**Framework picks (researched 2026-05-24):**

- **HyDE / multi-query: hand-rolled prompt module.** No canonical small library exists (`MultiQueryRetriever`, `HypotheticalDocumentEmbedder` are framework-coupled; `texttron/hyde` is two Jupyter notebooks). These are 30-line prompt patterns; vendoring is correct. HyDE prompt: open-domain QA variant from Gao et al. 2022 (`Please write a passage to answer the question. Question: {query} Passage:`). Generate 1 hypothetical doc (not the paper's 8 — LLM call is the bottleneck on Orin).
- **Adaptive classification: `MoritzLaurer/deberta-v3-base-zeroshot-v2.0`** (~110 MB int8). Zero-shot NLI classifier, English. ~50 ms per query on CPU. Categories: `{factual, analytical, conversational, navigational}`. Beats a 7B LLM classifier call by ~100× on cost.
- **Considered + rejected: full LLM-based classifier.** Costs a chat-model round-trip per query for what's a one-vector NLI score with deberta.

**Step-by-step:**

| # | Step | Files / surfaces | Depends on | Batch |
|---|---|---|---|---|
| 3.1 | Add `ClassifyQuery` RPC to ai-gateway gRPC server; load `MoritzLaurer/deberta-v3-base-zeroshot-v2.0` lazily on first call (mirror the BGE-reranker singleton pattern in `reranker.py`). Cache classification result keyed on query SHA-256. | `services/ai-gateway/grpc_server.py`, `services/ai-gateway/query_classifier.py` (new), `services/ai-gateway/protos/*.proto` | — | A |
| 3.2 | Create `apps/orchestrator/src/services/query-enhancement.service.ts`. Export `hydeRewrite(query): Promise<string>` (one LLM call via ai-gateway chat) and `multiQueryExpand(query, n=3): Promise<string[]>` (one LLM call returning 3 rewrites). | `apps/orchestrator/src/services/query-enhancement.service.ts` (new) | — | A |
| 3.3 | Extend `tests/retrieval-eval/queries.yaml` with three labeled subsets: 15 under-specified (1–3 word) queries for HyDE; 10 multi-faceted analytical queries for multi-query; 10 conversational queries for adaptive. Each row gets a `class` field. | `tests/retrieval-eval/queries.yaml` | — | A |
| 3.4 | Add `classifyQuery(query): Promise<QueryClass>` wrapper in `query-enhancement.service.ts` calling the new gRPC method. | `apps/orchestrator/src/services/query-enhancement.service.ts` | 3.1, 3.2 | B |
| 3.5 | Extend `searchHybrid` signature in orchestrator copy: add `queryEnhancement?: { hyde?, multiQuery?, adaptive? }` block. Behavior unchanged when omitted. When `multiQuery: true`, embed each rewrite in one batched `EmbedText` call (already supports 256/batch), run parallel vector searches, RRF-fuse across queries before existing RRF stage. | `apps/orchestrator/src/services/file-search.service.ts` | 3.4 | C |
| 3.6 | Mirror the `searchHybrid` signature change to the mcp-server copy. **WARP-202 mirror contract: this MUST land in the same PR as 3.5 or CI will flag drift.** | `services/mcp-server/src/file-search.service.ts` | 3.5 | C |
| 3.7 | Update `packages/tools-core/src/handlers/files/search-content.ts` to pass enhancement flags through from the LLM agent loop. Default off; orchestrator's agent loop opts in based on adaptive classification. | `packages/tools-core/src/handlers/files/search-content.ts` | 3.5, 3.6 | D |
| 3.8 | Wire adaptive routing in orchestrator's `llm-agent.service.ts`: classify query → map class to enhancement preset (`factual → rerank.candidates=100`; `conversational → minSimilarity=0.5`; `analytical → multiQuery=true`; `navigational → metadata filter on filename`). | `apps/orchestrator/src/services/llm-agent.service.ts` | 3.7 | D |
| 3.9 | Run eval gate per technique. HyDE: `ndcg@10(hyde) ≥ baseline × 1.05` on under-specified subset, no full-corpus regression >2%. Multi-query: `context_recall(multi-query) ≥ baseline × 1.10`. Adaptive: per-class NDCG positive; if conversational regresses, default it off. | `tests/retrieval-eval/`, RAGAS harness from Phase 2 | 3.8 | E |
| 3.10 | Update `docs/RAG_RETRIEVAL.md` with query-enhancement section + per-class adaptive presets table + measured deltas. | `docs/RAG_RETRIEVAL.md` | 3.9 | F |

**Batches at a glance:** A (3 parallel) → B (1) → C (2 — mirror constraint, see 3.6) → D (2 parallel) → E (1) → F (1).
**Files changed:** ~8 files, ~500 LOC across orchestrator + mirror + ai-gateway, 1 new proto definition.
**Eval gate:** Per-technique thresholds above.
**Calendar:** 8–12 working days, 1 dev focused.
**Risk:** WARP-202 mirror drift — explicitly called out in 3.6. The two `file-search.service.ts` copies are deliberately mirrored and CI catches drift; the agent executing this phase must update both in lockstep.

---

### Phase 4 — CRAG-lite (retrieval grading without web fallback)

**Goal:** Catch low-confidence retrievals before they become bad answers. A lightweight grader between retrieval and generation, with a fallback that re-queries via Phase 3's multi-query expansion (no web search — out of scope).

**Framework picks (researched 2026-05-24):**

- **Grader: `cross-encoder/ms-marco-MiniLM-L-6-v2`** (~80 MB, ~22M params). Produces a per-(query, doc) relevance score in ~50 ms CPU. Trichotomized via two thresholds (above upper → relevant, below lower → irrelevant, between → partial) — same signal shape as Yan et al. 2024's T5-Large CRAG grader at 1/30th the size.
- **Considered + rejected: T5-Large fine-tuned grader (the paper's choice).** 770M params (~1.5 GB fp16, ~770 MB int8) competes with the chat LLM for VRAM. The cross-encoder produces the same per-(q, doc) score at 1/10th the memory and is what most production CRAG-lite implementations actually ship.
- **No web-search fallback.** The reference notebook falls back to web search on "irrelevant" verdicts; we don't have a sanctioned local web-search path. Adding one belongs in a separate ADR. Our fallback is to re-run retrieval with Phase 3's `multiQueryExpand`.

**Step-by-step:**

| # | Step | Files / surfaces | Depends on | Batch |
|---|---|---|---|---|
| 4.1 | Add `GradeRetrieval` RPC to ai-gateway: load `cross-encoder/ms-marco-MiniLM-L-6-v2` lazily (same singleton pattern as BGE-reranker and deberta classifier). Input: `(query, docs[])`. Output: `scores[]` (one per doc). | `services/ai-gateway/grpc_server.py`, `services/ai-gateway/grader.py` (new), `services/ai-gateway/protos/*.proto` | — | A |
| 4.2 | Create `apps/orchestrator/src/services/retrieval-grader.service.ts`. Export `gradeRetrieval({ query, chunks }): Promise<{ verdict: 'relevant'\|'partial'\|'irrelevant', scores: number[] }>`. Thresholds named: `GRADE_UPPER = 0.7`, `GRADE_LOWER = 0.3`, tunable via env. | `apps/orchestrator/src/services/retrieval-grader.service.ts` (new) | — | A |
| 4.3 | Extend `tests/retrieval-eval/queries.yaml` with 10 known-low-confidence queries (intentionally ambiguous / out-of-corpus) for grader calibration. | `tests/retrieval-eval/queries.yaml` | — | A |
| 4.4 | Wire grader into orchestrator's `llm-agent.service.ts` between `search_content` tool result and prompt stitching. On `relevant` → use top-K as-is. On `partial` → use top-K with hedge instruction in prompt. On `irrelevant` → invoke Phase 3 `multiQueryExpand` once and retry. | `apps/orchestrator/src/services/llm-agent.service.ts` | 4.1, 4.2 | B |
| 4.5 | Extend `packages/tools-core/src/handlers/files/search-content.ts` `ToolResult.data` with optional `grading: { verdict, scores }` field so the LLM sees the verdict and can self-hedge. | `packages/tools-core/src/handlers/files/search-content.ts` | 4.2 | B |
| 4.6 | Run RAGAS gate from Phase 2: `faithfulness(crag) ≥ faithfulness(baseline) + 0.05` AND `answer_correctness(crag) ≥ answer_correctness(baseline) + 0.03`. Worst-case latency budget p99: +500 ms (grader + re-retrieve). | `tests/retrieval-eval/ragas/` | 4.4 | C |
| 4.7 | Update `docs/RAG_RETRIEVAL.md` with grader pipeline section + threshold rationale + measured deltas. | `docs/RAG_RETRIEVAL.md` | 4.6 | D |

**Batches at a glance:** A (3 parallel) → B (2 parallel) → C (1) → D (1).
**Files changed:** ~6 files, ~300 LOC, no schema migrations.
**Eval gate:** Above.
**Calendar:** 6–10 working days, 1 dev focused.
**Hard blockers:** Phase 2 (RAGAS metrics required to gate this), Phase 3 (multi-query is the fallback). Do not start Phase 4 until both have landed.

---

### Phase 5 — Multimodal (VLM-caption-first, unblocks ROADMAP M3.3)

**Goal:** Land image embeddings into the same retrieval surface as text via a captioning-first strategy. Image arrives → VLM produces caption → caption embedded with existing text embedder → joins the unified `FileContentChunk` index. Zero query-time changes.

**Framework picks (researched 2026-05-24):**

- **VLM: `moondream2`** (2B params, ~1.5 GB Q4, Ollama-native as `moondream`). The only Ollama-native VLM that (a) ships a first-class `caption(image, length)` API purpose-built for our use case, (b) leaves >5 GB headroom for mistral-7b chat on the standard 8GB Orin Nano, (c) has 7 quantization variants for memory tuning.
- **Considered + rejected: LLaVA-1.6 7B / MiniCPM-V 2.6 / Llama 3.2 Vision 11B.** All ≥7B, can't coexist with mistral-7b on 8 GB.
- **Considered + rejected: Qwen2.5-VL 3B.** Fits but needs prompt engineering for captioning (no dedicated API). Reserved as fallback if moondream2 caption quality is insufficient.
- **Considered + rejected: ColPali / Florence-2.** ColPali needs more VRAM than Orin Nano comfortably handles; Florence-2 has no Ollama path.

**Step-by-step:**

| # | Step | Files / surfaces | Depends on | Batch |
|---|---|---|---|---|
| 5.1 | Add `moondream` to the Ollama pre-pulled-models list in the inference sibling repo. Coordinate with that repo's setup (`scripts/setup.sh` or equivalent). **Cross-repo dependency: needs a PR there first.** | `droplet-local-LLM/scripts/setup.sh` (sibling repo) | — | A |
| 5.2 | Author Prisma migration adding `modality: enum('text', 'image_caption')` to `FileContentChunk`. Default `text` for backfill. Add index `(userId, modality, indexedAt)` for filtered queries. | `apps/orchestrator/prisma/schema.prisma`, `apps/orchestrator/prisma/migrations/<ts>_add_modality/` | — | A |
| 5.3 | Extend `tests/retrieval-eval/queries.yaml` with 10 image-grounded queries (PDF with figures, image-only chat attachments). Add fixture images to `tests/fixtures/`. | `tests/retrieval-eval/queries.yaml`, `tests/fixtures/` | — | A |
| 5.4 | Add `CaptionImage` RPC to ai-gateway gRPC server. Input: `(image_bytes, length='normal')`. Output: caption string. Calls Ollama's `moondream` model via OpenAI-compat vision API. Lazy-loaded singleton like reranker/classifier/grader. | `services/ai-gateway/grpc_server.py`, `services/ai-gateway/captioner.py` (new), `services/ai-gateway/protos/*.proto` | 5.1 | B |
| 5.5 | Rewrite `services/file-indexer/extractors/image.py`: replace the current `image_only` warning path with a call to `CaptionImage`; store caption as `text` with `modality='image_caption'` and the original image bytes path in `metadata`. | `services/file-indexer/extractors/image.py` | 5.2, 5.4 | C |
| 5.6 | Update `services/file-indexer/brain_ingest.py` to route image MIME types into the new captioning path instead of marking `image_only` and skipping. | `services/file-indexer/brain_ingest.py` | 5.5 | D |
| 5.7 | Backfill: re-run extraction for existing `BrainMemoryItem` rows where `warnings` contains `image_only`. WARP-218 retry counters apply; this is the same pipeline. | `services/file-indexer/` runtime (manual op) | 5.6 | E |
| 5.8 | Run eval gate: no regression on text-only queries; `ndcg@10(image queries) > 0` (baseline is zero — images aren't searchable today). | `tests/retrieval-eval/` | 5.6 | F |
| 5.9 | Flip ROADMAP M3.3 from `[~] Partial` to `[x]` Done with file references; update `docs/RAG_RETRIEVAL.md` modality section + measured deltas. | `docs/ROADMAP.md`, `docs/RAG_RETRIEVAL.md` | 5.8 | G |

**Batches at a glance:** A (3 parallel) → B (1) → C (1) → D (1) → E (1) → F (1) → G (1).
**Files changed:** ~7 files in this repo + 1 in the sibling repo, ~400 LOC, 1 Prisma migration.
**Eval gate:** Above.
**Calendar:** 8–12 working days *after* the sibling repo's Ollama pre-pull lands (Step 5.1).
**Hard blockers:** Step 5.1 needs droplet-local-LLM capacity confirmation. The actual model fits the budget; the question is whether ops wants to ship a second model on the device. Coordinate before starting.

---

### Phase 6 — Hold for evidence

**Techniques NOT in this plan** — explicitly held back unless eval evidence justifies them later:

- **pg_search / Tantivy swap** (already documented as a future swap in `RAG_RETRIEVAL.md§Future swap`). Gate: Postgres FTS precision floor measurable in Phase 2 RAGAS metrics.
- **Proposition Chunking / HyPE / Document Augmentation.** Heavy ingest-LLM cost. Gate: Phase 1 (sentence-aware + headers) eval lift is below 3%, indicating chunk-content is the bottleneck.
- **Microsoft GraphRAG / RAPTOR / Hierarchical Indices.** Large ingest cost and complex index footprint. Gate: a user-visible failure mode (multi-hop question, cross-document synthesis) emerges that hybrid+rerank can't address.
- **Sophisticated Controllable RAG Agent / Agentic RAG (Contextual AI).** Vendor lock-in or LangGraph commitment. Out of scope for this ADR.
- **MemoRAG.** GPU-heavy memory model; doesn't quantize gracefully on Orin Nano.
- **CRAG web-search fallback.** Out of scope for this ADR; needs a separate "local web search" ADR.

---

## Cross-phase parallelization summary (for the harness)

| Run mode | What can execute in parallel |
|---|---|
| **Maximum parallelism** | Phase 1 batch A (6 steps) + Phase 2 batch A (2 steps) = **8 steps in flight simultaneously**, zero shared files. Compress weeks 1–2 to days. |
| **After Phase 1 batch A** | Phase 1 batch B (1 step). Phase 2 continues independently. |
| **After Phase 1 + Phase 2 complete** | Phase 3 batch A (3 steps in parallel). |
| **After Phase 3 complete** | Phase 4 batch A (3 steps in parallel). Phase 5 batch A (3 steps in parallel) — *but* Phase 5 batch A step 5.1 requires sibling-repo coordination, so don't start 5.x until that PR is open. |
| **Phase 4 and Phase 5** | Independent of each other — different services, different files. Can run as parallel work streams once Phase 3 lands. |

**Harness contract:** Within a batch, dispatch all steps as a single Agent tool call with multiple sub-prompts (per `superpowers:dispatching-parallel-agents`). Between batches, wait for full batch completion before starting the next. Cross-phase parallelism is the property of the dependency table, not the batch letter — a step in Phase 3 batch A still cannot run until Phase 2 has completed.

---

## Tickets

JIRA epic + child stories live in the **WARP** project on `warp-lab.atlassian.net`.

> **Living status:** [`docs/RAG_UPGRADE_STATUS.md`](RAG_UPGRADE_STATUS.md) is the
> up-to-date handoff page — current state per phase, the eval-service follow-ups,
> and the ordered "what to do next". This table is the design-time snapshot; the
> status doc is the source of truth for *where the work is*.

| Phase | Ticket | Status |
|---|---|---|
| Epic | [WARP-434](https://warp-lab.atlassian.net/browse/WARP-434) | In Progress |
| Phase 1 — Ingest enrichment | [WARP-435](https://warp-lab.atlassian.net/browse/WARP-435) | **Merged** — batches A + B + D (sentence-aware chunker, per-extractor sectionPath, contextual-header prefix, docs). Batch C (live re-index + eval gate) deferred to the integration-stack run. |
| Phase 2 — RAGAS eval harness | [WARP-436](https://warp-lab.atlassian.net/browse/WARP-436) | **Done** — all batches landed. Batch D (populate `baselines.json`) completed 2026-07-20 on the appliance via the WARP-1406/WARP-1407 rag-eval pipeline ([#1140](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1140), [#1144](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1144), [#1151](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1151), [#1152](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1152)) — 8 cross-session runs; RAGAS floor assertions now enforce. |
| Phase 3 — Query enhancement | [WARP-437](https://warp-lab.atlassian.net/browse/WARP-437) | **Done** — merged in [#271](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/271). HyDE + multi-query + adaptive routing via `_meta._enhancement`. Shipping dark behind `QUERY_ENHANCEMENT_ENABLED` (renamed from `WARP_437_ENHANCEMENT_ENABLED` 2026-07); per-class gates enforced since the 2026-07-20 baselines. |
| Phase 4 — CRAG-lite | [WARP-438](https://warp-lab.atlassian.net/browse/WARP-438) | To Do — **unblocked**: WARP-437 merged and the WARP-436 baselines landed 2026-07-20. Next phase to start. |
| Phase 5 — Multimodal | [WARP-439](https://warp-lab.atlassian.net/browse/WARP-439) | To Do (blocked on droplet-local-LLM `moondream` pre-pull, cross-repo). |
| Eval service | (no phase ticket) | **Merged** in [#299](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/299) — `services/rag-eval/` runs the harness on the appliance (Compose profile `eval`). Follow-ups all merged: [WARP-519](https://warp-lab.atlassian.net/browse/WARP-519) HTTP trigger ([#315](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/315)), [WARP-520](https://warp-lab.atlassian.net/browse/WARP-520) stream output ([#312](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/312)), [WARP-521](https://warp-lab.atlassian.net/browse/WARP-521) aggregator tests ([#313](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/313)). Appliance pipeline hardening + first real baselines: [WARP-1406](https://warp-lab.atlassian.net/browse/WARP-1406) run fixes ([#1140](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1140)) + [WARP-1407](https://warp-lab.atlassian.net/browse/WARP-1407) eval-fixture seeding and re-baseline ([#1144](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1144), [#1151](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1151), [#1152](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1152)). |

All assigned to Romain. Labels: `origin-ai`, `size-{m\|l}`, `rag`, plus a per-phase topical tag (`ingest`, `eval`, `query`, `grading`, `multimodal`).

Blocking relations wired in Jira:
- WARP-436 blocks WARP-437 (cleared — both progressed)
- WARP-436 blocks WARP-438 (cleared — baselines landed 2026-07-20)
- WARP-437 blocks WARP-438 (cleared — WARP-437 merged)

WARP-439's blocker is cross-repo (droplet-local-LLM sibling) and isn't represented as a Jira link.

> **Note on the original "GitHub Actions nightly" plan (step 2.6):** the eval is
> NOT run via GitHub Actions. Per repo convention GHA is for dev tasks (PR CI,
> unit tests, image-build verification); on-machine functionality like running
> RAGAS lives in the `services/rag-eval/` service. The earlier
> `.github/workflows/rag-eval-nightly.yml` was removed accordingly.

---

## Roadmap entries (proposed additions to `docs/ROADMAP.md`)

These map onto the GTM milestone style. Suggested placement: under Stage 3 (Production Scale, Month 7+), as a new subsection "Retrieval quality (post-M2)" since they extend the M2.x retrieval work rather than fitting cleanly into an existing milestone.

```markdown
### M-RAG.1 Ingest enrichment (Phase 1 of ADR-003)
- **Scope:** Sentence-aware chunking + contextual chunk headers.
- **Framework:** semantic-text-splitter v0.30.x + pypdf.outline + python-docx style.name.
- **Files:** services/file-indexer/chunker.py, services/file-indexer/extractors/*.py
- **Status:** **Shipped.** `services/file-indexer/chunker.py` is on `main`.
- **Eval gate:** ndcg@10 ≥ 1.05× current baseline.
- **Ticket:** WARP-RAG.1

### M-RAG.2 RAGAS eval harness (Phase 2 of ADR-003)
- **Scope:** Faithfulness / context-relevance / answer-correctness metrics.
- **Framework:** ragas==0.4.x with native Ollama via OpenAI-compat.
- **Files:** tests/retrieval-eval/ragas/, scripts/test-rag.sh, services/rag-eval/
- **Status:** **Shipped.** `tests/retrieval-eval/ragas/`, `services/rag-eval/` and `scripts/test-rag.sh` are all on `main` (and `rag-eval` carries its own Dependabot pip target).
- **Eval gate:** Baselines established; thresholds set for M-RAG.3+.
- **Ticket:** WARP-RAG.2
- **Parallel with:** M-RAG.1 (no shared files).

### M-RAG.3 Query enhancement (Phase 3 of ADR-003)
- **Scope:** HyDE (gated), multi-query, adaptive retrieval.
- **Framework:** Hand-rolled prompts + MoritzLaurer/deberta-v3-base-zeroshot-v2.0 for classification.
- **Files:** apps/orchestrator/src/services/query-enhancement.service.ts, file-search.service.ts (+mirror), services/ai-gateway/query_classifier.py
- **Status:** **Shipped** as the query enhancement work, [WARP-437](https://warp-lab.atlassian.net/browse/WARP-437). `apps/orchestrator/src/services/query-enhancement.service.ts` exports `hydeRewrite` + `MULTI_QUERY_DEFAULT_N`, and `services/ai-gateway/query_classifier.py` is on `main`.
- **Blockers:** M-RAG.2 (need RAGAS metrics to gate adaptive).
- **Ticket:** WARP-RAG.3

### M-RAG.4 Retrieval grading / CRAG-lite (Phase 4 of ADR-003)
- **Scope:** Grader-then-rewrite loop; no web-search fallback.
- **Framework:** cross-encoder/ms-marco-MiniLM-L-6-v2 (80 MB) instead of the paper's T5-Large.
- **Files:** apps/orchestrator/src/services/retrieval-grader.service.ts, services/ai-gateway/grader.py, orchestrator agent loop
- **Status:** **Not started.** Neither `apps/orchestrator/src/services/retrieval-grader.service.ts` nor `services/ai-gateway/grader.py` exists on `main`. Tracked as the CRAG-lite retrieval grading work, [WARP-438](https://warp-lab.atlassian.net/browse/WARP-438).
- **Blockers:** M-RAG.2 (faithfulness metric required), M-RAG.3 (multi-query is the fallback).
- **Ticket:** WARP-RAG.4

### M-RAG.5 Multimodal indexing (extends M3.3)
- **Scope:** VLM-caption-first multimodal indexing.
- **Framework:** moondream2 (~1.5 GB) via Ollama as `moondream`. Reserves Qwen2.5-VL 3B as fallback.
- **Files:** services/file-indexer/extractors/image.py, services/ai-gateway/captioner.py (new CaptionImage RPC), prisma schema (add modality enum)
- **Status:** **Partial.** `services/file-indexer/extractors/image.py` exists on `main`; `services/ai-gateway/captioner.py` (the CaptionImage RPC) does not.
- **Blockers:** droplet-local-LLM Ollama pre-pull PR (cross-repo).
- **Ticket:** WARP-RAG.5
```

## Consequences

**Positive:**
- Every existing abstraction is preserved. WARP-202 mirror, RBAC, state machine, cache invalidation all stay intact.
- Each phase is independently mergeable, independently revertible, independently eval-gated.
- The eval surface is the gate, not the technique. If Phase 1 doesn't lift NDCG, we don't compound it with Phase 3.
- No production runtime depends on a cloud LLM. Cloud judge is opt-in for goldens only.
- Phases 1 + 2 can run as fully parallel work streams, compressing the critical path.

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
- `https://github.com/benbrandt/text-splitter` — `semantic-text-splitter` upstream.
- `https://ollama.com/library/moondream` — moondream2 VLM via Ollama.
- `https://huggingface.co/MoritzLaurer/deberta-v3-base-zeroshot-v2.0` — query classifier.
- `https://huggingface.co/cross-encoder/ms-marco-MiniLM-L-6-v2` — CRAG-lite grader.
- Gao et al. 2022, "Precise Zero-Shot Dense Retrieval without Relevance Labels" (HyDE).
- Yan et al. 2024, "Corrective Retrieval Augmented Generation" — arxiv 2401.15884.

## Status audit — 2026-07-27

This ADR was stale in **both** directions, which is why the header moved to
`Accepted` rather than staying `Proposed`.

The *decision* it records — cherry-pick techniques in phases rather than swap
to a RAG framework — was taken and has been executed for three of five
phases. An ADR whose approach is running in production is not a proposal; the
phase list is rollout state, not ADR status.

The phase list itself was the stale part: every one of the five read
`[ ] Not started`, including three that are on `main`. Corrected against the
tree:

| Phase | Was | Actually |
|---|---|---|
| Ingest enrichment | Not started | **Shipped** — `services/file-indexer/chunker.py` |
| RAGAS eval harness | Not started | **Shipped** — `tests/retrieval-eval/ragas/`, `services/rag-eval/`, `scripts/test-rag.sh` |
| Query enhancement (HyDE + multi-query + adaptive routing, WARP-437) | Not started | **Shipped** — `query-enhancement.service.ts`, `query_classifier.py` |
| CRAG-lite retrieval grading (WARP-438) | Not started | **Not started** — confirmed, both files absent |
| Multimodal indexing | Not started | **Partial** — `extractors/image.py` yes, `captioner.py` no |

Remaining work is the CRAG-lite retrieval grading (WARP-438) and the
CaptionImage RPC for multimodal indexing.
