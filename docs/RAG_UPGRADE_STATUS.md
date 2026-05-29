# RAG upgrade — status & handoff

**Purpose:** the single living status page for the retrieval-quality upgrade
program. If you are an agent (or human) picking this work up, **read this first**,
then dive into the design rationale in
[`docs/ADR-003-rag-techniques-adoption.md`](ADR-003-rag-techniques-adoption.md).

This doc tracks *where the work is*. The ADR tracks *why the work is shaped the
way it is*. Keep them in sync: when a phase changes state, update both this
file's table and the ADR's "Tickets" table.

**Naming convention (per repo CLAUDE.md):** refer to work by its WARP ticket +
an explicit descriptive name — e.g. "WARP-438 CRAG-lite retrieval grading", not
"Phase 4" or "ADR-003 Phase 4". The phase numbers below exist only to map onto
the ADR's structure; always name the work for what it does.

_Last updated: 2026-05-29 (after WARP-437 query enhancement merged + the
`services/rag-eval/` evaluation service shipped)._

---

## The program at a glance

The upgrade layers advanced-RAG techniques onto the shipped WARP-286 hybrid
retrieval stack (vector + lexical + RRF + cross-encoder rerank). Each technique
is cherry-picked as a small, independently eval-gated change — **no framework
adoption** (no LangChain / LlamaIndex). Five phases, plus the evaluation
infrastructure that gates them.

| # | Work (WARP ticket) | State | Where |
|---|---|---|---|
| 1 | Ingest enrichment — sentence-aware chunking + contextual headers ([WARP-435](https://warp-lab.atlassian.net/browse/WARP-435)) | **Merged** (batch C deferred) | `services/file-indexer/chunker.py`, `extractors/*.py` |
| 2 | RAGAS evaluation harness ([WARP-436](https://warp-lab.atlassian.net/browse/WARP-436)) | **Merged**; baselines still placeholder | `tests/retrieval-eval/ragas/` |
| 3 | Query enhancement — HyDE + multi-query + adaptive routing ([WARP-437](https://warp-lab.atlassian.net/browse/WARP-437)) | **Merged** ([#271](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/271)), shipping dark | orchestrator + mcp-server + ai-gateway + tools-core |
| 4 | CRAG-lite retrieval grading ([WARP-438](https://warp-lab.atlassian.net/browse/WARP-438)) | **To Do** — unblocked once baselines land | not started |
| 5 | Multimodal — VLM caption-first indexing ([WARP-439](https://warp-lab.atlassian.net/browse/WARP-439)) | **To Do** — cross-repo blocker | not started |
| — | Evaluation service (runs the harness on the appliance) | **Merged** ([#299](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/299)) | `services/rag-eval/` |

---

## Detail per phase

### 1. Ingest enrichment — WARP-435 — Merged

Sentence-aware chunking (`semantic-text-splitter`) + contextual chunk headers
(`sectionPath` prepended before embedding). Shipped batches A/B/D. **Batch C**
(live re-index of fixtures + the NDCG@10 eval gate) is deferred to a run on the
full integration stack — it needs the Compose stack up and is not runnable on a
dev laptop. No code blocker; it's a verification step.

Docs: [`docs/RAG_RETRIEVAL.md` § "Ingest enrichment"](RAG_RETRIEVAL.md).

### 2. RAGAS evaluation harness — WARP-436 — Merged (baselines pending)

Adds faithfulness / context-precision / context-recall / answer-relevancy /
factual-correctness on top of NDCG@10, judged by a local Ollama model (or cloud
opt-in). Shipped batches A/B/C/E. **Batch D** — populating
`tests/retrieval-eval/ragas/baselines.json` with real envelopes — was the one
remaining piece. It is no longer blocked on CI: the `services/rag-eval/` service
(below) populates it with a single `bootstrap --runs 5` command on the
appliance. Until that runs, the file holds all-zero floors and the integration
test treats them as "recording mode" (logs metrics, asserts nothing).

Docs: [`docs/RAG_TESTING.md` § "RAGAS metrics"](RAG_TESTING.md).

### 3. Query enhancement — WARP-437 — Merged, shipping dark

HyDE (averaged-vector), multi-query (RRF-fused paraphrases), and adaptive
routing via a `deberta-v3-zeroshot` classifier that maps each query to a preset.
Orchestrator computes enhancement and threads it to retrieval via the MCP
`_meta._enhancement` channel (trusted-stdio only). Merged in
[#271](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/271).

**Two things are intentionally NOT yet active:**

1. **Production wiring is behind a flag.** `EnhancementDeps` is wired into the
   orchestrator's agent loop but gated by `WARP_437_ENHANCEMENT_ENABLED=1`
   (default off). Set it per-environment + recreate the orchestrator container
   to turn enhancement on. Until then the agent loop runs the WARP-286 path
   byte-for-byte.
2. **Per-class eval gates are in recording mode.** The per-class NDCG/RAGAS
   assertions in `tests/retrieval-eval/run.integration.test.ts` log deltas but
   don't fail, pending real baselines (see phase 2).

Docs: [`docs/RAG_RETRIEVAL.md` § "Query enhancement"](RAG_RETRIEVAL.md),
design spec + plan under `docs/superpowers/` (see "Pointers" below).

### 4. CRAG-lite retrieval grading — WARP-438 — To Do

A `cross-encoder/ms-marco-MiniLM` grader between retrieval and generation, with a
multi-query re-query fallback on low-confidence verdicts (no web search). **Hard
blockers:** WARP-436 baselines (faithfulness gate) + WARP-437 (multi-query is the
fallback). WARP-437 is now merged, so the only remaining blocker is the
baselines — which the eval service unblocks. Once baselines land, this is the
next phase to start.

The WARP-437 work left reusable foundations for it: `multiQueryExpand`, the
lazy-singleton gRPC pattern (`services/ai-gateway/query_classifier.py` is the
smallest reference), and the `_meta._enhancement` private-metadata channel
(a sibling `_grading` channel would follow the same shape).

### 5. Multimodal — WARP-439 — To Do

VLM caption-first image indexing (`moondream` via Ollama). **Blocker is
cross-repo:** the `droplet-jetson-ai` sibling must pre-pull the `moondream`
model. Independent of phases 1–4 — can start whenever the sibling lands its
model pre-pull.

---

## Evaluation infrastructure — `services/rag-eval/`

Merged in [#299](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/299).
A Python container (mirrors `services/file-indexer/`'s shape) that runs the
canonical `tests/retrieval-eval/ragas/ragas_runner.py` against the **deployed
stack on the appliance** — not in CI. GitHub Actions is for dev tasks (PR CI,
unit tests, image-build verification); on-machine functionality like running the
eval lives in a service. Opt-in via Compose profile `eval`.

- **Cadence:** hourly during off-hours (`RAG_EVAL_CRON_HOUR=22-23,0-5`,
  8 slots/night) on the appliance GPU. Tunable via env without an image rebuild.
- **Ad-hoc:** `docker exec droplet-rag-eval-1 python /opt/rag-eval/main.py run-once`.
- **Bootstrap baselines:** `docker exec droplet-rag-eval-1 python /opt/rag-eval/main.py bootstrap --runs 5`
  → writes `/data/rag-eval/baselines.candidate.json` (isolated per-bootstrap
  subdir, never polluted by the rolling hourly history). `docker cp` it back to
  `tests/retrieval-eval/ragas/baselines.json` and commit.

Service docs: [`services/rag-eval/README.md`](../services/rag-eval/README.md).

### In-flight follow-ups on the eval service

| Ticket | What | PR | State |
|---|---|---|---|
| [WARP-519](https://warp-lab.atlassian.net/browse/WARP-519) | HTTP trigger + orchestrator proxy + dashboard for ad-hoc runs | [#315](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/315) | In review |
| [WARP-520](https://warp-lab.atlassian.net/browse/WARP-520) | Stream subprocess output instead of buffering | [#312](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/312) | In review |
| [WARP-521](https://warp-lab.atlassian.net/browse/WARP-521) | Unit tests for `aggregate_runs()` quantile/IQR/floor math | [#313](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/313) | In review |

These three touch disjoint files and merge in any order.

---

## Critical path — what to do next

The whole program is currently gated on **one artifact: a populated
`baselines.json`**. The ordered path to keep moving:

1. **Merge the eval-service follow-ups** (WARP-519 / 520 / 521) — all in review,
   no conflicts.
2. **Deploy the eval service on the test/staging appliance:** set
   `COMPOSE_PROFILES=...,eval`, bring up `rag-eval`, run
   `bootstrap --runs 5`, copy the resulting `baselines.candidate.json` to
   `tests/retrieval-eval/ragas/baselines.json`, commit it (PR titled
   `chore(rag-eval): rebaseline RAGAS — initial baselines`).
3. **Flip WARP-437's per-class gates out of recording mode** — once baselines
   exist, change the assertions in
   `tests/retrieval-eval/run.integration.test.ts` from logging to enforcing
   (`short ≥ baseline × 1.05`, `analytical context_recall ≥ baseline × 1.10`,
   `conversational must not regress`, full corpus `≥ baseline × 1.03`).
4. **Turn on WARP-437 enhancement in production** — set
   `WARP_437_ENHANCEMENT_ENABLED=1` on the target environment + recreate the
   orchestrator. Watch the next eval runs for per-class deltas.
5. **Start WARP-438 CRAG-lite** — now fully unblocked.
6. **WARP-439 multimodal** — independent; start whenever `droplet-jetson-ai`
   lands the `moondream` pre-pull.

A separate, low-priority cleanup: WARP-435 batch C (live re-index + NDCG gate)
can run on the integration stack at any time — it's a verification step, not a
blocker.

---

## Pointers

- **Design rationale:** [`docs/ADR-003-rag-techniques-adoption.md`](ADR-003-rag-techniques-adoption.md)
- **Retrieval runtime + tuning:** [`docs/RAG_RETRIEVAL.md`](RAG_RETRIEVAL.md)
- **Eval harness + metrics:** [`docs/RAG_TESTING.md`](RAG_TESTING.md)
- **Eval service:** [`services/rag-eval/README.md`](../services/rag-eval/README.md)
- **Design specs + plans** (per-phase, for resuming the harness-driven build):
  - `docs/superpowers/specs/2026-05-25-warp-437-query-enhancement-design.md`
  - `docs/superpowers/plans/2026-05-25-warp-437-query-enhancement-plan.md`
  - earlier RAG specs/plans under `docs/superpowers/specs/` + `docs/superpowers/plans/`
- **Canonical runner:** `tests/retrieval-eval/ragas/ragas_runner.py` (run mode +
  `aggregate` subcommand)
