# ADR-012 — Per-container resource limits (WARP-569)

**Status:** accepted  
**Date:** 2026-05-31  
**Ticket:** [WARP-569](https://warp-lab.atlassian.net/browse/WARP-569)

## Context

`docker/docker-compose.yml` shipped with ~30 services and zero cgroup ceilings.
On the target single-box hardware (~7 GB shared RAM), the Linux OOM killer is
the only backstop. When any container's working set spikes, the kernel kills
whichever host process has the worst `oom_score` — frequently Postgres or the
orchestrator, not the offending container. Because nearly every service uses
`restart: always`, the hog is restarted immediately and re-triggers the same
OOM, producing an appliance-wide crash loop.

## Decision

Add explicit per-service memory limits (`mem_limit`), CPU ceilings (`cpus`),
and PID limits (`pids_limit`) to **every** service in `docker/docker-compose.yml`.
Add `mem_reservation` to the three core-infrastructure services (`db`, `cache`,
`orchestrator`) to protect them from OOM eviction first.

Drive all limits through `.env` variables with sane defaults so operators on
larger hardware can raise them without editing tracked files.

Add a CI guard in `scripts/test-security.sh` (Test 10) that fails if any
service is missing `mem_limit`, preventing silent regression when a new service
is added.

## Key constraint: top-level keys, not `deploy.resources`

**`deploy.resources.limits` is silently IGNORED by `docker compose up` outside
Swarm mode.** Using it would make the limits appear to be enforced while
actually doing nothing, leaving the OOM risk fully intact. The correct keys are
the top-level `mem_limit`, `cpus`, and `pids_limit` — these are enforced by
`docker compose up` on any single-host deployment.

The `test-security.sh` CI guard (Test 10) explicitly fails on any service that
uses `deploy.resources.limits`, so a future refactor cannot silently disable
enforcement.

## RAM budget

> **These are ceilings, not reservations.** `mem_limit` caps a container's
> *peak* usage; it does not pre-allocate RAM. On a single box the summed
> `mem_limit` values across *all* profiles intentionally exceed physical RAM —
> no deployment runs every profile at once, and even within one profile
> containers rarely hit their ceiling simultaneously. Only `mem_reservation`
> (set on `db`, `cache`, `orchestrator`) represents guaranteed floor RAM. The
> budget that must fit physical RAM is the **default-profile total (~5 GB)**
> plus whichever profiles are enabled — not the grand sum of every row below.

### Default-profile services (always-on, counted against the 7 GB target)

| Service | `mem_limit` | `mem_reservation` | Notes |
|---|---|---|---|
| gateway | 128 MB | — | nginx |
| web-dashboard | 384 MB | — | Next.js SSR |
| orchestrator | 768 MB | 512 MB | Protected core |
| device-identity-svc | 128 MB | — | gRPC, TPM |
| mcp-server | 256 MB | — | MCP HTTP |
| nextcloud | 768 MB | — | PHP-Apache |
| db | 1,024 MB | 512 MB | Postgres 16 + pgvector — most protected |
| cache | 256 MB | 128 MB | Redis 7 — protected |
| broker | 64 MB | — | Mosquitto |
| ai-gateway | 512 MB | — | FastAPI + LiteLLM |
| file-indexer | 512 MB | — | Watchdog + embed |
| routing | 256 MB | — | FastAPI, host-net |
| **Total** | **~5.0 GB** | | Leaves ~2 GB for host/kernel/profile-gated heavies |

Host/kernel reserve target: ~1 GB. Default-profile budget fits within ~6 GB.

### Profile-gated services (additive, sized for their provisioned hardware)

| Service | Profile | `mem_limit` | Notes |
|---|---|---|---|
| rag-eval | eval | 1 GB | RAGAS scoring |
| email-indexer | full | 256 MB | IMAP/SMTP |
| switch | full | 128 MB | FastAPI, host-net |
| camera-discovery | full | 256 MB | ONVIF scan |
| frigate | linux | 1 GB | NVR + FFmpeg + detector. cgroups v2: the `shm_size: 256mb` tmpfs counts against `mem_limit`, so the effective process budget is ~768 MB. Single-stream is fine; for 2+ streams set `FRIGATE_MEM_LIMIT=1536m`. |
| voice-io | linux | 512 MB | Voice loop |
| wyoming-faster-whisper | linux | 1 GB | Whisper small.en ~470 MB |
| wyoming-piper | linux | 512 MB | Piper TTS |
| oled-display | display | 128 MB | PyPortal serial bridge |
| ops-console | ops | 256 MB | docker.sock operator UI |
| postgres-pm | pm | 512 MB | Plane Postgres |
| redis-pm | pm | 256 MB | Plane Redis |
| pm-api | pm | 768 MB | Plane Django backend |
| pm-worker | pm | 512 MB | Plane Celery worker |
| pm-web | pm | 384 MB | Plane Next.js frontend |
| pm-health | pm | 128 MB | Droplet health sidecar |
| ollama | single-box | 4 GB | ROCm LLM inference — biggest single consumer |
| openwrt | single-box | 512 MB | Router-in-container |

## Env-variable indirection

Every limit is overridable from `.env`:

```
GATEWAY_MEM_LIMIT=128m         GATEWAY_CPUS=0.5
WEB_DASHBOARD_MEM_LIMIT=384m   WEB_DASHBOARD_CPUS=1.0
ORCHESTRATOR_MEM_LIMIT=768m    ORCHESTRATOR_MEM_RESERVATION=512m   ORCHESTRATOR_CPUS=2.0
DB_MEM_LIMIT=1g                DB_MEM_RESERVATION=512m              DB_CPUS=2.0
CACHE_MEM_LIMIT=256m           CACHE_MEM_RESERVATION=128m           CACHE_CPUS=0.5
OLLAMA_MEM_LIMIT=4g            OLLAMA_CPUS=4.0                      OLLAMA_PIDS_LIMIT=2048
FRIGATE_MEM_LIMIT=1g           FRIGATE_CPUS=2.0                     FRIGATE_PIDS_LIMIT=1024
CONTAINER_PIDS_LIMIT=512       (global default for all others)
... (see CLAUDE.md Environment variables table for the full list)
```

## Restart-policy interaction

With `restart: always`, a container whose working set permanently exceeds
`mem_limit` enters a hot-restart loop (killed by the cgroup OOM, immediately
restarted). This is **intentional**: an isolated container crash loop is
preferable to the host-wide OOM cascade. If a specific service is observed
hot-looping, the operator has two options:

1. Raise its limit in `.env` and recreate the container:
   ```bash
   docker compose -f docker/docker-compose.yml --env-file .env up -d --force-recreate <service>
   ```
2. Switch to `restart: on-failure` via a compose override to let it stay down
   after repeated failures while the root cause is investigated.

## Recreate gotcha

`docker restart <container>` does **not** re-read the env file. Containers keep
the environment they were originally booted with. After changing a limit in
`.env`, recreate the affected service:

```bash
docker compose -f docker/docker-compose.yml --env-file .env up -d --force-recreate <service>
```

See also the "Updating `.env` on a running stack" section in CLAUDE.md.

## Consequences

- Every service now has an explicit memory ceiling, turning a host-wide OOM
  cascade into an isolated single-container OOM restart.
- `db`, `cache`, and `orchestrator` have `mem_reservation` so the OOM killer
  targets unpinned services first.
- The CI guard (Test 10 in `test-security.sh`) prevents any new service from
  shipping without a limit.
- Operators on hardware smaller or larger than 7 GB can tune limits via `.env`
  without touching tracked files.
- Under-sized limits will cause isolated container OOM restarts until tuned.
  The defaults are generous estimates; validate under realistic load with
  `docker stats --no-stream`.
