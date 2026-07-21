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

_Last updated: 2026-07-19 (after the WARP-1406/WARP-1407 rag-eval appliance
pipeline landed and the first real RAGAS baselines were committed to
`tests/retrieval-eval/ragas/baselines.json`)._

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
| 2 | RAGAS evaluation harness ([WARP-436](https://warp-lab.atlassian.net/browse/WARP-436)) | **Done** — real baselines committed 2026-07-20 | `tests/retrieval-eval/ragas/` |
| 3 | Query enhancement — HyDE + multi-query + adaptive routing ([WARP-437](https://warp-lab.atlassian.net/browse/WARP-437)) | **Merged** ([#271](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/271)), shipping dark | orchestrator + mcp-server + ai-gateway + tools-core |
| 4 | CRAG-lite retrieval grading ([WARP-438](https://warp-lab.atlassian.net/browse/WARP-438)) | **To Do** — unblocked, next to start | not started |
| 5 | Multimodal — VLM caption-first indexing ([WARP-439](https://warp-lab.atlassian.net/browse/WARP-439)) | **To Do** — cross-repo blocker | not started |
| — | Evaluation service (runs the harness on the appliance) | **Merged** ([#299](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/299)) | `services/rag-eval/` |
| — | rag-eval appliance pipeline + first real baselines ([WARP-1406](https://warp-lab.atlassian.net/browse/WARP-1406) / [WARP-1407](https://warp-lab.atlassian.net/browse/WARP-1407)) | **Merged** ([#1140](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1140), [#1144](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1144), [#1151](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1151), [#1152](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1152)) | `services/rag-eval/`, `tests/retrieval-eval/ragas/baselines.json` |

---

## Detail per phase

### 1. Ingest enrichment — WARP-435 — Merged

Sentence-aware chunking (`semantic-text-splitter`) + contextual chunk headers
(`sectionPath` prepended before embedding). Shipped batches A/B/D. **Batch C**
(live re-index of fixtures + the NDCG@10 eval gate) is deferred to a run on the
full integration stack — it needs the Compose stack up and is not runnable on a
dev laptop. No code blocker; it's a verification step.

Docs: [`docs/RAG_RETRIEVAL.md` § "Ingest enrichment"](RAG_RETRIEVAL.md).

### 2. RAGAS evaluation harness — WARP-436 — Done

Adds faithfulness / context-precision / context-recall / answer-relevancy /
factual-correctness on top of NDCG@10, judged by a local Ollama model (or cloud
opt-in). All batches have landed. **Batch D** — populating
`tests/retrieval-eval/ragas/baselines.json` with real envelopes — completed on
2026-07-20 via the WARP-1406/WARP-1407 rag-eval appliance pipeline (see
"Evaluation infrastructure" below): envelopes over 8 cross-session runs on the
seeded eval-fixtures corpus, floors `context_recall` 0.28 /
`llm_context_precision_with_reference` 0.28 / `faithfulness` 0.16
(`factual_correctness` 0.0 at this corpus stage), computed with the WARP-1407
containment clamp (floor never exceeds min sample mean − 0.02). The
`RAGAS_ENABLED=1` integration test enforces these floors automatically now
that the file exists — recording mode is over for the top-level RAGAS
assertions. (The per-class WARP-437 NDCG test is a separate, still-recording
gate — see phase 3.)

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
   don't fail. Real baselines have now landed (see phase 2), so flipping these
   assertions to enforcing is the next actionable step — see "Critical path"
   below. Note that `envelopes_by_class` in `baselines.json` currently covers
   only the `factual` class; the flip likely needs a per-class envelope
   backfill for the other classes first.

Docs: [`docs/RAG_RETRIEVAL.md` § "Query enhancement"](RAG_RETRIEVAL.md),
design spec + plan under `docs/superpowers/` (see "Pointers" below).

### 4. CRAG-lite retrieval grading — WARP-438 — To Do

A `cross-encoder/ms-marco-MiniLM` grader between retrieval and generation, with a
multi-query re-query fallback on low-confidence verdicts (no web search). **Both
hard blockers are cleared:** WARP-437 query enhancement is merged, and the
WARP-436 baselines landed on 2026-07-20 via the WARP-1406/WARP-1407 rag-eval
appliance pipeline. This is the next phase to start.

The WARP-437 work left reusable foundations for it: `multiQueryExpand`, the
lazy-singleton gRPC pattern (`services/ai-gateway/query_classifier.py` is the
smallest reference), and the `_meta._enhancement` private-metadata channel
(a sibling `_grading` channel would follow the same shape).

### 5. Multimodal — WARP-439 — To Do

VLM caption-first image indexing (`moondream` via Ollama). **Blocker is
cross-repo:** the `droplet-local-LLM` sibling must pre-pull the `moondream`
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

### Follow-ups on the eval service — all merged

| Ticket | What | PR | State |
|---|---|---|---|
| [WARP-519](https://warp-lab.atlassian.net/browse/WARP-519) | HTTP trigger + orchestrator proxy + dashboard for ad-hoc runs | [#315](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/315) | **Merged** |
| [WARP-520](https://warp-lab.atlassian.net/browse/WARP-520) | Stream subprocess output instead of buffering | [#312](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/312) | **Merged** |
| [WARP-521](https://warp-lab.atlassian.net/browse/WARP-521) | Unit tests for `aggregate_runs()` quantile/IQR/floor math | [#313](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/313) | **Merged** |

### Appliance pipeline hardening + first real baselines — WARP-1406 / WARP-1407

Landed 2026-07-19/20, closing the program's last gating artifact:

- **WARP-1406 appliance RAGAS run fixes**
  ([#1140](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1140)) —
  service-token auth for the runner's orchestrator calls + durable run records,
  so unattended appliance runs work and their results stay visible afterwards.
- **WARP-1407 eval-fixture seeding**
  ([#1144](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1144)) —
  one-command seeded corpus (`scripts/seed-eval-fixtures.sh`,
  `RAGAS_EVAL_USER=eval-fixtures`) so every run scores the same 20-query corpus.
- **First real baselines promoted**
  ([#1151](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1151)),
  then **re-baselined with the containment clamp**
  ([#1152](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1152))
  after the initial back-to-back-only envelopes proved overtight (IQR ~0 made
  ordinary judge variance "fail" the floors). `baselines.json` now carries
  envelopes over 8 cross-session runs; floor = max(0, min(p50 − 1.5 × IQR,
  min sample mean − 0.02)).

---

## Critical path — what to do next

The artifact the whole program was gated on — a populated
`tests/retrieval-eval/ragas/baselines.json` — **landed on 2026-07-20**
(8 cross-session appliance runs via the WARP-1406/WARP-1407 rag-eval pipeline,
committed in [#1151](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1151)
/ [#1152](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1152)).
The top-level RAGAS floor assertions enforce automatically now that the file
exists. The ordered path from here:

1. **Flip WARP-437's per-class gates out of recording mode** — change the
   per-class assertions in `tests/retrieval-eval/run.integration.test.ts` from
   logging to enforcing
   (`short ≥ baseline × 1.05`, `analytical context_recall ≥ baseline × 1.10`,
   `conversational must not regress`, full corpus `≥ baseline × 1.03`).
   `envelopes_by_class` in `baselines.json` currently covers only the
   `factual` class — backfill the other classes' envelopes as part of this.
2. **Turn on WARP-437 enhancement per environment** — set
   `WARP_437_ENHANCEMENT_ENABLED=1` on the target environment + recreate the
   orchestrator. Watch the next eval runs for per-class deltas.
3. **Start WARP-438 CRAG-lite retrieval grading** — now fully unblocked (both
   hard blockers cleared).
4. **WARP-439 multimodal** — independent; start whenever `droplet-local-LLM`
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
