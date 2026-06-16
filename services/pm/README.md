# `services/pm/` — embedded Plane project-management stack

Wraps [Plane](https://plane.so) (AGPL-3.0) as Droplet's on-prem project-management surface.

- **ADR:** [ADR-010 — Plane self-hosted PM stack adoption](../../docs/ADR-010-pm-stack-selection.md)
- **Spec:** [`docs/superpowers/specs/2026-05-27-warp-498-pm-stack-design.md`](../../docs/superpowers/specs/2026-05-27-warp-498-pm-stack-design.md)
- **Epic:** WARP-496

## What this directory contains

This is the **Droplet-side wrapper** around Plane upstream. We ship vanilla Plane images (pinned by SHA) plus a tiny FastAPI sidecar that exposes the team's standardized `/health` endpoint.

```
services/pm/
├── README.md                ← you are here
├── Dockerfile               ← image for the health sidecar
├── main.py                  ← FastAPI app: GET /health
├── config.py                ← Pydantic settings (DROPLET_PM_*)
├── requirements.txt
├── requirements-dev.txt
├── pytest.ini
├── docker-compose.local.yml ← local-dev only: runs the full Plane stack
├── PATCHES.md               ← AGPL-3 obligation tracking (per ADR-010)
├── .env.example             ← documented env vars
└── tests/
    └── test_health.py       ← happy-path + Plane-unreachable failure mode
```

## Components in the deployed stack

Per spec OQ1 (dedicated PG/Redis):

| Container | Source | Internal port | Notes |
|---|---|---|---|
| `pm-web` | `makeplane/plane-frontend:<sha>` | 3000 | Next.js. Behind Nginx at `/pm/`. |
| `pm-api` | `makeplane/plane-backend:<sha>` | 8000 | Django REST API. Server-to-server only. |
| `pm-worker` | `makeplane/plane-worker:<sha>` | — | Celery worker. |
| `pm-health` | this directory | 8090 | Sidecar exposing standardized `/health`. |
| `postgres-pm` | `postgres:15-alpine` | 5432 | Dedicated; volume `postgres-pm-data`. |
| `redis-pm` | `redis:7-alpine` | 6379 | Dedicated; volume `redis-pm-data`. |

Compose wiring lands in WARP-501. Nginx routing lands in WARP-502.

## Running locally (dev only — NOT the production stack)

```bash
# From the repo root, with .env populated:
docker compose -f services/pm/docker-compose.local.yml up
curl http://localhost:8090/health
```

`docker-compose.local.yml` is **dev-only**. Production runs the same containers via the root `docker/docker-compose.yml` under the `single-box` / `multi-box` profiles.

## Environment variables

All Plane-related env vars use the `DROPLET_PM_*` prefix per architecture-guard rule 11 (never `MATTER_*`). Defaults must work on a brand-new install or fail loud — no host-specific defaults (rule 14).

See [`.env.example`](.env.example) for the canonical list.

## Health endpoint

`GET /health` on `pm-health:8090`:

```json
{
  "status": "ok",
  "service": "pm",
  "version": "<pinned-plane-sha>",
  "plane_api_reachable": true
}
```

The sidecar polls `pm-api:8000/api/health` internally. If Plane is unreachable, `plane_api_reachable` is `false` and the overall `status` is `degraded`.

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `/health` returns `degraded` with `plane_api_reachable: false` | `pm-api` container not started or still booting | `docker compose ps pm-api`; check logs |
| `pm-web` shows "Bad Gateway" via Nginx | `pm-web` healthcheck failing | check Nginx error log + `pm-web` logs |
| Plane login fails with "session expired" | `DROPLET_PM_SECRET_KEY` rotated without restart | restart `pm-web` + `pm-api` together |
| `postgres-pm` won't start after `factory-reset.sh --reinstall` | Volume permission drift | wipe `postgres-pm-data` volume manually; re-run `setup.sh` |

## Engineering-handbook compliance

This service follows [`08-templates/new-service-checklist.md`](https://github.com/DropletByWarpLab/warp-lab-engineering-handbook/blob/main/08-templates/new-service-checklist.md):

- ✅ README, Dockerfile, `/health` endpoint, structured JSON logs, env validation (`config.py`)
- ✅ `DROPLET_PM_*` env-var prefix (rule 11)
- ✅ No host-specific defaults (rule 14)
- ✅ No `while True` scheduling (rule 9 — health poll uses asyncio sleep with cancellation)
- ✅ No `MATTER_*` env vars (rule 11)
- ✅ No `poc`/`test`/`dev`/`prototype` framing in user-facing surfaces (rule 17)

## AGPL-3 compliance

Per [ADR-010](../../docs/ADR-010-pm-stack-selection.md): we ship vanilla Plane upstream. Any local patches are recorded in [`PATCHES.md`](PATCHES.md). The dashboard footer links to the Plane upstream source.

## See also

- WARP-500 — this skeleton
- WARP-501 — compose wiring
- WARP-502 — Nginx reverse-proxy
- WARP-503 — `setup.sh` provisioning
- WARP-504 — `ship-check.sh` additions
- Phase 2: WARP-505/506/507 (SSO + RBAC + onboarding wizard)
- Phase 3: WARP-508/509/510/511 (tools-core + MCP + webhook)
