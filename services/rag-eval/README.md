# rag-eval

Scheduled RAGAS evaluation service. Lives on the appliance test box,
runs hourly during off-hours, writes results to a shared volume.

This is the **production-shape** path for measuring retrieval quality —
it talks to the running orchestrator over the internal Docker network
and uses the appliance's existing local-judge LLM (Ollama). The
historical GHA-runner approach (`./.github/workflows/rag-eval-nightly.yml`)
remains in the repo for ad-hoc PR-side runs but is not the canonical
cadence anymore.

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

1. On startup: registers a single apscheduler `BlockingScheduler` job
   with cron `hour=$RAG_EVAL_CRON_HOUR minute=$RAG_EVAL_CRON_MINUTE` in
   the container's local timezone.
2. Each tick: spawns a subprocess for `ragas_runner.py` baked into the
   image at `/opt/rag-eval/ragas_runner.py`. The subprocess hits the
   orchestrator's `/api/admin/retrieval-eval/search` for each query,
   synthesizes answers, scores via the judge LLM, and writes
   `/data/rag-eval/runs/results-<UTC>.json` + `.md`.
3. Per-run output is isolated under `/data/rag-eval/runs/`. The
   container never deletes old runs — operator sweeps `runs/` when the
   volume grows uncomfortably.

The container's local timezone matters because the cron expression is
written in local time. Set `TZ=America/Los_Angeles` (or your zone)
either in the compose `environment:` block or in `.env`.

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

## Ad-hoc single run

```bash
docker exec -it droplet-rag-eval-1 python /opt/rag-eval/main.py run-once
```

Useful right after merging a retrieval change to confirm the next
hourly tick will see the new code path.

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
| `RAG_EVAL_DISABLED` | `0` | Set to `1` to skip the scheduler entirely (container stays alive for `docker exec` ad-hoc runs but doesn't fire on schedule). |
| `OPENAI_API_KEY` | `""` | Only required when `RAGAS_JUDGE=cloud`. |

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
