# RAGAS eval harness — WARP-436

Offline harness that layers RAGAS metrics on top of the existing NDCG@10
eval in `tests/retrieval-eval/`. See `docs/ADR-003-rag-techniques-adoption.md`
Phase 2 for the design and rationale; see `docs/RAG_TESTING.md` for the
broader RAG integration-test picture.

## Status (2026-05-24)

This directory is being built out across the WARP-436 batches:

| Batch | Lands | Status |
|---|---|---|
| A | `requirements.txt`, `README.md`, `goldens.yaml` | ✅ (this PR) |
| B | `ragas_runner.py` | pending |
| C | `RAGAS_ENABLED=1` mode in `run.integration.test.ts`, `--with-ragas` flag in `scripts/test-rag.sh`, nightly GH Actions workflow | pending |
| D | `baselines.json` (recorded p50/p95 from 5 runs) | pending |
| E | `docs/RAG_TESTING.md` "RAGAS metrics" section | pending |

Until batch B lands, `ragas_runner.py` does not exist — `requirements.txt`
and `goldens.yaml` here are scaffolding only. Installing them does not
make the harness runnable yet.

## Isolation contract

**Production code must not import from this directory.** That's enforced
socially (this README, the `WARP-436` comment header on every file, and
review discipline) — there's no Python import boundary because we don't
ship a `pyproject.toml` for the eval harness.

If a production service ever needs RAGAS-style metrics at runtime, that's
a separate ADR — it's not what this harness is for.

## Judge-LLM policy (preview, finalized in batch C)

- **Default judge:** local Ollama model (`mistral` or whatever the
  appliance ships with). Cheap, deterministic enough for regression
  detection. Pointed at via `OPENAI_BASE_URL` defaulting to
  `http://localhost:11434/v1`.
- **Golden judge:** cloud model (Claude Sonnet, GPT-4o) gated behind
  `RAGAS_JUDGE=cloud`. Run only on release-candidate builds, not per-PR.
  PR CI never spends cloud judge tokens.

## Files

- `requirements.txt` — pinned RAGAS + OpenAI-compat + parsing deps.
- `goldens.yaml` — extends `../queries.yaml` with `expected_answer` and
  `reference_contexts` per query. Match by `id`.
- `ragas_runner.py` *(batch B)* — load goldens, query the orchestrator,
  build a `Dataset`, run `ragas.evaluate(...)`.
- `baselines.json` *(batch D)* — recorded p50/p95 per metric across 5
  runs; thresholds derived from `p50 − 1.5 × IQR`.

## See also

- `docs/ADR-003-rag-techniques-adoption.md` — Phase 2 scope and gates
- `docs/RAG_TESTING.md` — overall RAG integration-test architecture
- `tests/retrieval-eval/queries.yaml` — the 20-query corpus that
  `goldens.yaml` extends
- `tests/retrieval-eval/run.integration.test.ts` — the existing NDCG@10
  harness; batch C teaches it to optionally call RAGAS
