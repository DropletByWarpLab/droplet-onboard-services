# rag-eval

Scheduled RAGAS evaluation service. Lives on the appliance test box,
runs hourly during off-hours, writes results to a shared volume.

This is the path for measuring retrieval quality on a deployed
appliance — it talks to the running orchestrator over the internal
Docker network and uses the appliance's existing local-judge LLM
(Ollama). GitHub Actions does NOT run the eval; per project
convention, GHA is for dev tasks (PR CI, image-build verification),
not for functionality that runs on the machine.

## Deploy

The service is opt-in via the `eval` Compose profile. On a test /
staging appliance, enable it by appending to `COMPOSE_PROFILES`:

```bash
echo 'COMPOSE_PROFILES=linux,display,eval' >> .env
docker compose -f docker/docker-compose.yml --env-file .env up -d rag-eval
```

(User-facing appliances should NOT carry the `eval` profile — RAGAS is
GPU-bound and adds nothing for end users.)

## What the container does

1. On startup: starts an apscheduler `AsyncIOScheduler` job with cron
   `hour=$RAG_EVAL_CRON_HOUR minute=$RAG_EVAL_CRON_MINUTE` in the
   container's local timezone, AND a FastAPI HTTP trigger server (uvicorn)
   on `$RAG_EVAL_HTTP_PORT` (default 8090) — both in one asyncio event
   loop. The scheduled job hands the ~12-minute RAGAS subprocess to a
   thread executor so it never freezes the HTTP server.
2. Each tick: spawns a subprocess for `ragas_runner.py` baked into the
   image at `/opt/rag-eval/tests/retrieval-eval/ragas/ragas_runner.py`.
   The runner sits at this exact repo-tree-shaped path so its own
   `Path(__file__).resolve().parents[3]` repo-root lookup resolves
   to `/opt/rag-eval/` and the sibling `queries.yaml` + `goldens.yaml`
   load with no patching — same invocation as the offline docs. The
   subprocess hits the orchestrator's `/api/admin/retrieval-eval/search`
   for each query, synthesizes answers, scores via the judge LLM, and
   writes `/data/rag-eval/runs/results-<UTC>.json` + `.md`.
3. Per-run output is isolated under `/data/rag-eval/runs/`. Retention
   (WARP-1192): after each run the service prunes to the newest 500
   `results-*.json`/`.md` pairs and — independently — the newest 500
   `record-*.json` run records (`RAG_EVAL_KEEP_RUNS` overrides the 500).
   The lists are pruned separately because a failed run has a record but
   no results pair.

The container's local timezone matters because the cron expression is
written in local time. Set `TZ=America/Los_Angeles` (or your zone)
either in the compose `environment:` block or in `.env`.

## Seeding the eval fixture corpus (WARP-1407)

The goldens (`tests/retrieval-eval/ragas/goldens.yaml`) are written
against the WARP-224 fixture corpus, NOT a real user's files — pointed
at a real corpus, every metric mean reads ~0.0 and baselines can't be
bootstrapped. Seed the fixtures under a dedicated Nextcloud user so
eval numbers are stable, golden-comparable, and never pollute anyone's
real retrieval:

```bash
# On the appliance host (stack up). Idempotent — re-run after a
# factory reset or volume wipe.
./scripts/seed-eval-fixtures.sh

# Then aim the eval at the seeded corpus (recreate, NOT restart —
# `docker restart` never re-reads env_file):
#   .env: RAGAS_EVAL_USER=eval-fixtures
docker compose -p droplet -f docker/docker-compose.yml --env-file .env \
  up -d --force-recreate --no-deps rag-eval
```

The script creates NC user `eval-fixtures` (via occ; the user never
logs in), copies `sample.pdf` / `simple.zip` / the WARP-206 PNG / the
WARP-224 EML into `files/test-rag-end-to-end/`, runs `occ files:scan`,
and polls `FileContentChunk` until the indexer has embedded them.
Audio/video fixtures are not seeded (they need transcribe-now,
WARP-218); the eval tolerates the partial set. Verify with an ad-hoc
run: `error_counts` all zero and non-zero `context_recall` /
`llm_context_precision_with_reference` means.

## Bootstrap baselines (WARP-436 batch D path)

The "first time `baselines.json` gets populated" workflow is now one
command on the box:

```bash
# 5 sequential RAGAS runs, then aggregate into
# /data/rag-eval/baselines.candidate.json. Takes ~1h on the appliance.
docker exec -it droplet-rag-eval-1 \
  python /opt/rag-eval/main.py bootstrap --runs 5
```

Then promote the candidate to the canonical baselines file by copying
it out of the volume and committing into the repo at
`tests/retrieval-eval/ragas/baselines.json`. Once committed, flip the
WARP-437 per-class assertions in
`tests/retrieval-eval/run.integration.test.ts:252-304` from recording
mode to enforced gates.

**Include independent-session runs before promoting (WARP-1407
lesson).** The bootstrap's 5 runs execute back-to-back — correlated
samples whose IQR can collapse to ~0, producing floors ≈ p50 that the
very next fresh-session run "fails" on ordinary judge variance (seen
live: precision iqr 0.006 across the bootstrap vs a 0.30–0.43 spread
across sessions). The aggregator now clamps every floor to
`min(sample means) − FLOOR_MARGIN` as a backstop, but the real fix is
sample diversity: before promoting, re-run the aggregate over a
directory that also contains a few single runs from different
sessions/days (copy the relevant `results-*.json` into a scratch dir
and point `ragas_runner.py aggregate --results-dir` at it). Exclude
runs made against a different corpus or `RAGAS_EVAL_USER` — mixing
corpora poisons the envelope.

## Ad-hoc single run (shell)

```bash
docker exec -it droplet-rag-eval-1 python /opt/rag-eval/main.py run-once
```

Useful right after merging a retrieval change to confirm the next
hourly tick will see the new code path. The `run-once` and `bootstrap`
CLI subcommands still work unchanged — they're independent of the HTTP
server below.

## HTTP trigger surface (WARP-519)

The container also serves a small FastAPI app on `$RAG_EVAL_HTTP_PORT`
(default `8090`) so operators can fire ad-hoc runs from the dashboard
without `docker exec`. It binds on the internal Docker network only —
**no host publish, no auth of its own.** The orchestrator's
`/api/admin/rag-eval/*` route (admin/owner-gated) is the auth wall and
proxies to it by service name (`rag-eval:8090`).

A single in-process busy flag (`run_state.STORE`) is shared between the
scheduler's cron job and these HTTP triggers, so a manual `/run` can
never overlap a scheduled run (and vice-versa) — the HTTP-side equivalent
of apscheduler's `max_instances=1`.

| Method + path        | Behavior |
|----------------------|----------|
| `POST /run`          | Start one RAGAS pass as a background task. `202 {runId, startedAt}`. `409 {error:"run_in_progress", runId}` if a run/bootstrap is already in flight. |
| `POST /bootstrap`    | Body `{runs:int}` (default 5, clamped 1..10). Start N sequential runs + aggregate into `baselines.candidate.json` as a background task. `202 {runId, startedAt, runs}`. Same `409` semantics. |
| `GET /runs`          | Recent runs (newest first, cap 20). Merges durable `record-<runId>.json` files (terminal runs — succeeded AND failed, runs AND bootstraps, written at finish), legacy `results-*.json` with no record (pre-upgrade successes, status inferred `succeeded`), and the in-flight run from memory (highest precedence). `resultsPath` + top-level `metrics` attached when `results-<runId>.json` exists; NaN/Infinity in results files are mapped to `null` on read. |
| `GET /runs/{runId}`  | Status of one run: `running \| succeeded \| failed \| unknown` (explicit enum). Precedence: in-memory record → `record-<runId>.json` → legacy results file (inferred `succeeded`) → `unknown`. `resultsPath` + `metrics` attached if the results file exists. |
| `GET /baselines`     | `baselines.candidate.json` if present, else `404 {error:"no_baselines"}`. |
| `GET /health`        | `200 {status:"ok"}`. |

In-flight state lives in an in-memory dict — a rag-eval restart forgets
in-flight runs. Terminal runs survive: every finish (succeeded or
failed) writes an atomic `record-<runId>.json` under `runs/`, so failed
runs and finished bootstraps stay visible across restarts. That split is
acceptable and intentional.

`RAG_EVAL_DISABLED=1` skips registering the scheduler's cron job but the
HTTP server **still serves** — "disabled" means "no automatic schedule",
not "no service". The trigger surface is the whole point of WARP-519.

### Orchestrator proxy paths (auth-gated)

The dashboard never talks to rag-eval directly. It calls the
orchestrator, which proxies:

| Dashboard → orchestrator | → rag-eval |
|--------------------------|------------|
| `POST /api/admin/rag-eval/run`        | `POST /run` |
| `POST /api/admin/rag-eval/bootstrap`  | `POST /bootstrap` |
| `GET  /api/admin/rag-eval/runs`       | `GET /runs` |
| `GET  /api/admin/rag-eval/runs/:id`   | `GET /runs/{id}` |
| `GET  /api/admin/rag-eval/baselines`  | `GET /baselines` |

When the `eval` Compose profile is inactive, `rag-eval` isn't running and
its service name doesn't resolve — the orchestrator route returns
`503 {error:"rag_eval_unavailable"}`. (This route is NOT production-gated,
unlike `admin-retrieval-eval`.)

### Dashboard page

`/admin/rag-eval` (admin/owner only) gives operators a "Run RAG eval now"
button, a "Bootstrap baselines" button with a confirm dialog, and a list
of recent runs with their top-level metric means. On a `503` it renders a
banner explaining how to enable the `eval` Compose profile.

## Env vars

| Env | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_URL` | `http://orchestrator:3000` | Where to call `/api/admin/retrieval-eval/search`. Docker internal DNS. |
| `RAGAS_JUDGE` | `local` | `local` = Ollama on the appliance; `cloud` = OpenAI (requires `OPENAI_API_KEY`). |
| `RAGAS_OLLAMA_URL` | `http://host.docker.internal:11434/v1` | Where the local judge lives — host's Ollama daemon. `host.docker.internal` resolves via `extra_hosts: host-gateway` on Linux. |
| `RAGAS_LOCAL_JUDGE_MODEL` | `mistral` | Ollama model name for local judge. |
| `RAGAS_VARIANT` | `hybrid` | Retrieval pipeline variant. Switch to `hybrid-enhanced` once WARP-437 is fully wired and you want adaptive routing to count. |
| `RAGAS_LIMIT` | `10` | Top-K per query (matches NDCG@10 convention). |
| `RAG_EVAL_CRON_HOUR` | `22-23,0-5` | Local-time hour window for the scheduled run. Default = 22:00–05:00 (8 slots/night). |
| `RAG_EVAL_CRON_MINUTE` | `0` | Local-time minute. |
| `RAG_EVAL_DISABLED` | `0` | Set to `1` to skip registering the scheduler's cron job. The HTTP trigger server STILL serves so dashboard/`docker exec` ad-hoc runs work — "disabled" = "no automatic schedule", not "no service". |
| `RAG_EVAL_CORPUS_GATE_DISABLED` | `0` | WARP-1868: set to `1` to run every scheduled slot regardless of whether the corpus changed. The gate exists because a healthy pass pins the GPU at 98–100% for ~10 minutes and the cron fires 8×/night whether or not a file was indexed. Disable it when you are deliberately holding the corpus constant and varying something else — bisecting a judge or model change, where skipping would defeat the exercise. Never affects the HTTP trigger, which is always unconditional. |
| `RAG_EVAL_FINGERPRINT_TIMEOUT_SEC` | `10` | WARP-1868: how long to wait for the orchestrator's `/api/admin/retrieval-eval/corpus-fingerprint`. Bounded so a slow answer cannot wedge the scheduler ahead of a ~10-minute job. On timeout the gate **fails open** and the run proceeds — skipping on an unreadable fingerprint would silently stop measuring retrieval quality. |
| `RAG_EVAL_HTTP_PORT` | `8090` | Port the FastAPI HTTP trigger server binds on the internal Docker network. The orchestrator proxies here via `RAG_EVAL_URL`. |
| `OPENAI_API_KEY` | `""` | Only required when `RAGAS_JUDGE=cloud`. |

On the **orchestrator** service, `RAG_EVAL_URL` (default
`http://rag-eval:8090`) points the proxy route at this server.

## Updating goldens

The goldens, queries, and the runner script are **baked into the
image** at build time per the project's "image-first, no repo on
appliance" deploy convention. To change them:

1. Edit the canonical source in the repo:
   - `tests/retrieval-eval/queries.yaml`
   - `tests/retrieval-eval/ragas/goldens.yaml`
   - `tests/retrieval-eval/ragas/ragas_runner.py`
2. Rebuild the image: `docker compose -f docker/docker-compose.yml build rag-eval`
3. Redeploy: `docker compose -f docker/docker-compose.yml up -d rag-eval`

The runner takes no runtime config that depends on these files — they
ship together as one image version.

## Why this isn't in the orchestrator

The orchestrator is Node + TypeScript. `ragas` is a Python package with
~500 MB of transitive deps (torch via transformers, langchain-core,
datasets, etc.). Bolting Python into the orchestrator image would
inflate every appliance — including user-facing ones that don't run the
eval — by half a gigabyte. A dedicated service keeps the deps
contained, matches the existing `services/file-indexer/` Python-service
pattern, and lets us gate behind a Compose profile.

## See also

- ADR: `docs/ADR-003-rag-techniques-adoption.md` — the broader phased plan.
- WARP-437: the query-enhancement work this eval measures.
- WARP-436: the RAGAS harness this service runs.
- `tests/retrieval-eval/ragas/ragas_runner.py` — canonical runner; this
  service invokes it as a subprocess.
- `services/file-indexer/scheduler_service.py` — the apscheduler
  convention this service mirrors.
