# edge-platform

Control-plane monorepo for the Droplet edge AI appliance. This monorepo contains the orchestrator API, web dashboard, AI gateway proxy, file indexer service, and all supporting Docker infrastructure.

## Monorepo structure

```
apps/orchestrator/      Express + Prisma — central API and device control
apps/web-dashboard/     Next.js 14 — admin UI
services/ai-gateway/    FastAPI + LiteLLM — model routing proxy
services/routing/       FastAPI — OpenWrt router control via ubus JSON-RPC
services/file-indexer/  Python watchdog — filesystem indexer + embedder (formerly `file-sync`)
services/camera-discovery/ Python FastAPI — ONVIF/RTSP camera auto-discovery
services/switch/        FastAPI — Managed switch control (Lantronix/ASIC driver)
openwrt/                OpenWrt image builder + config overlay for Pi 5 router
docker/                 Nginx, PostgreSQL 16, Redis 7, MQTT, Nextcloud 29, Frigate NVR
```

## Tech stack

- **Orchestrator:** Node.js, Express, Prisma ORM, PostgreSQL
- **Web dashboard:** Next.js 14, React
- **AI gateway:** Python, FastAPI, LiteLLM
- **Routing service:** Python, FastAPI, OpenWrt ubus JSON-RPC SDK
- **File indexer:** Python, watchdog (was `file-sync`; renamed to reflect its indexer+embedder role)
- **Camera discovery:** Python, FastAPI, ONVIF, WS-Discovery
- **Switch service:** Python, FastAPI, abstract driver interface (Lantronix SM8TAT2SA / future ASIC)
- **NVR:** Frigate (open-source), TensorRT GPU detection, RTSP
- **Infra:** Docker Compose, Nginx, Redis, MQTT (Mosquitto), Nextcloud, Frigate
- **Smart home:** Native Matter controller in the orchestrator (`matter.service.ts`). The dashboard talks to Matter directly via `/api/matter/*`.

## Device setup

Run `./scripts/setup.sh` to provision a fresh device. Generates unique per-device secrets, installs Docker, builds and starts the full stack. Idempotent — safe to re-run. See `scripts/README.md` for flags and troubleshooting.

## Commands

```bash
# Full stack via Docker
npm run dev:docker

# Local orchestrator dev
cd apps/orchestrator && npm run dev

# Tests
npm test                    # all tests
npm run test:orchestrator   # orchestrator only
npm run test:ai-gateway     # ai-gateway only

# Factory reset (wipe all data, return to out-of-the-box state)
./scripts/factory-reset.sh

# Factory reset + re-provision in one step
./scripts/factory-reset.sh --reinstall
```

## Docker services

| Service        | Port  | Notes                      |
|----------------|-------|----------------------------|
| gateway        | :80, :443 | Nginx reverse proxy — single host entry point |
| web-dashboard  | —     | Proxied at `/`                            |
| orchestrator   | —     | Proxied at `/api/`                        |
| nextcloud      | —     | Proxied at `/nextcloud/` (no host port — collided with routing) |
| db             | —     | PostgreSQL 16, internal only              |
| cache          | —     | Redis 7, internal only                    |
| broker         | —     | MQTT, internal only                       |
| ai-gateway     | —     | Proxied at `/ai/`                         |
| frigate        | —     | NVR + AI detection, profile `linux` (needs `/dev/dri/renderD128`) |
| switch         | :8081 | Managed switch control, profile `full`    |
| camera-discovery | —   | ONVIF/RTSP scanner, profile `full`        |
| routing        | :8080 | OpenWrt control, host network             |

`COMPOSE_PROFILES=linux` is set in `.env` automatically by `setup.sh` on Linux so Frigate starts with the default stack; on macOS it's empty so the GPU device mount never trips. Add `full` to opt into switch/camera-discovery on either OS.

## Updating `.env` on a running stack

`docker restart <container>` does **not** re-read the env_file. Containers
keep the env they were originally booted with. After editing `.env`, recreate
the affected services:

```bash
docker compose -f docker/docker-compose.yml --env-file .env up -d --force-recreate <service>
```

This caught us once on `FRIGATE_CAMERA_*_PASSWORD` — `.env` had the right
value but Frigate's container still had the stale one. `scripts/test-security.sh`
now also blocks URL-encoded camera passwords (Frigate ffmpeg doesn't decode
percent-escapes; store raw `Droplet123!`, not `Droplet123%21`).

## Environment variables

> ⚠ **Never add new `MATTER_*` env vars.** matter.js scans `process.env` at startup and auto-imports every `MATTER_*` variable into its internal `VariableService`, dot-namespacing each one. Collisions with root-node behavior ids throw `UnsupportedCastError: Property "X" is unsupported` and break controller init. Use a `DROPLET_MATTER_*` prefix for our own env vars instead. `MATTER_STORAGE_PATH` is the only surviving `MATTER_*` name and is allow-listed by `scripts/test-security.sh`. Full rationale: [`apps/orchestrator/src/config.ts`](apps/orchestrator/src/config.ts) — the block comment above the `Matter` schema section.

| Variable             | Description                                          |
|----------------------|------------------------------------------------------|
| `DATABASE_URL`       | PostgreSQL connection string                         |
| `REDIS_URL`          | Redis connection string                              |
| `MQTT_BROKER`        | MQTT broker address                                  |
| `AI_GATEWAY_URL`     | AI gateway endpoint                                  |
| `FILES_ROOT`         | `.data/files` (local) / `/data/files` (Docker)       |
| `STORAGE_BACKEND`    | `legacy` or `nextcloud`                              |
| `NEXTCLOUD_URL`      | Nextcloud instance URL                               |
| `AUTH_ENABLED`       | Enable/disable auth                                  |
| `PORT`               | Server listen port                                   |
| `DEVICE_SECRET`      | Device authentication secret                         |
| `MAX_UPLOAD_SIZE_MB` | Upload size limit in MB                              |
| `ROUTING_SERVICE_URL`| Routing service endpoint (default `http://host.docker.internal:8080` — routing uses `network_mode: host`, so orchestrator reaches it via the host gateway) |
| `OPENWRT_HOST`       | OpenWrt router IP (default `192.168.50.1`)           |
| `OPENWRT_USERNAME`   | OpenWrt rpcd user (default `droplet-ai`)             |
| `OPENWRT_PASSWORD`   | OpenWrt rpcd password                                |
| `FRIGATE_URL`        | Frigate NVR API endpoint (default `http://frigate:5000`) |
| `CAMERA_SCAN_INTERVAL` | Camera discovery scan interval in seconds (default `30`) |
| `CAMERA_SUBNET`      | Camera isolation subnet CIDR (default `192.168.100.0/24`) |
| `CAMERA_DEFAULT_USERNAME` | Operator-supplied admin user for IP cameras; tried before factory defaults |
| `CAMERA_DEFAULT_PASSWORD` | Operator-supplied admin password (paired with `CAMERA_DEFAULT_USERNAME`) |
| `CAMERA_CREDENTIALS_JSON` | JSON array of `[user, pw]` pairs probed before factory defaults |
| `ONVIF_WS_DISCOVERY_ENABLED` | `1` to enable WS-Discovery multicast scan (default `0`; `python-ws-discovery` leaks FDs on Python 3.12+) |
| `CAMERA_AUTO_INITIALIZE` | `1` to auto-run the vendor first-run admin-password flow (Hanwha `/init-cgi/pw_init.cgi`) using `CAMERA_DEFAULT_PASSWORD` when an uninitialized camera is seen (default `0`) |
| `FRIGATE_IMAGE`      | Frigate container image (default `stable` CPU; set `stable-tensorrt-jp6` on JetPack 6 Orin hardware) |
| `FRIGATE_RUNTIME`    | Docker runtime for the Frigate container (`runc` default; set `nvidia` on Jetson / x86+NVIDIA hosts) |
| `YOLO_MODELS`        | JP6-image model preparator trigger; leave empty until the s6 prepare script stops expecting legacy `.cfg` inputs |
| `SWITCH_HOST`        | Managed switch IP (default `192.168.1.77`)             |
| `SWITCH_PORT`        | Managed switch HTTPS port (default `443`)              |
| `SWITCH_USERNAME`    | Switch admin username (default `admin`)                |
| `SWITCH_PASSWORD`    | Switch admin password                                  |
| `SWITCH_DRIVER`      | Switch driver: `lantronix` (default) or `asic` (future) |
| `SWITCH_SERVICE_URL` | Switch service endpoint (default `http://host.docker.internal:8081` — same host-mode rationale as `ROUTING_SERVICE_URL`) |
| `DISPLAY_SERVICE_URL`| OLED/TFT display service endpoint (default `http://host.docker.internal:8082` — display runs host-mode on the Jetson) |
| `ROUTING_MODE`       | `real` (default) / `mock` (fixture-driven, no OpenWrt needed) / `disabled` (orchestrator skips router calls). See WARP-44. |

## GTM Alignment (April 2026)

The April 2026 internal GTM strategy doc (`droplet-gtm-strategy.docx`) assesses the project against a reference architecture that has drifted from this repo's layout. When following the GTM doc, use `docs/gtm-mapping.md` to translate its file paths to the ones that actually exist here. The most frequent mapping: GTM's `services/assistant-api/` is split between `apps/orchestrator/` (Node control plane) and `services/ai-gateway/` (Python LLM proxy); tool-calling lives in the separate `inference-engine` repo.

### Phase status against GTM §1 (scoped to this repo)

| Phase | Name | Status here | Notes |
|---|---|---|---|
| PH1 | Repo + Runtime | **Complete** | Turbo monorepo + `docker/docker-compose.yml` (20 services, unified) + `scripts/setup.sh` / `factory-reset.sh`. Stack convergence (GTM M1.1) is already done here — no separate router/assistant compose files. |
| PH2 | Device Control API — auth/RBAC | **Not started** for JWT/RBAC | Auth middleware (`apps/orchestrator/src/middleware/auth.ts`) validates Bearer tokens against Nextcloud OCS with a 5-minute Redis cache and `droplet_session` cookies. No JWT issuance/refresh, no role model in Prisma. |
| PH3 | Service stubs → real | **Partial** | `services/routing/` (OpenWrt ubus), `services/camera-discovery/` (ONVIF/RTSP/Frigate), `services/file-indexer/` (filesystem + embeddings) are real services. Gaps: audit-log table, storage-metrics completeness, NVR clip-export delegation. |
| PH4 | Assistant tooling hardening | **N/A here** | Primary hardening lives in `inference-engine` (OpenClaw sandbox + tool policy). This repo's `services/ai-gateway/` is the outer input layer — M2.7 input-validation + rate-limit coverage needs to be audited here. |
| PH5 | Docs + polish | **Partial** | README.md, this CLAUDE.md, CONTRIBUTING.md, scripts/README.md, TESTING.md are solid. Missing: OpenAPI wiring (delegated to `shared-api`), threat model, architecture diagrams beyond the README's ASCII art. |

### GTM milestones that touch this repo

Most of Stage 1 (M1.1–M1.8) lives here in some form, most of Stage 2 (M2.1–M2.8) does too, and Stage 3 participation is mostly M3.4 (OTA update agent) and M3.6 (extension-registry backend + UI). Per-milestone status and file pointers live in `docs/ROADMAP.md`.

### Pointers

- `docs/ROADMAP.md` — per-milestone status (M1.1–M3.6), blockers, next actions
- `docs/gtm-mapping.md` — path-by-path bridge from GTM reference architecture to this repo's layout, plus the major architectural deltas (OpenWrt vs. Pi-Docker router, Node vs. Python control plane, `file-sync` → `file-indexer` rename, Next.js vs. static HTML UI)
- `docs/STATUS.md` — Working / Partial / Not started capabilities with file references, and PH1–PH5 table

When starting new work in this repo, read `docs/ROADMAP.md` first to check whether the task is already scoped to a milestone and whether cross-repo dependencies (inference-engine for streaming + tool sandboxing; shared-api for OpenAPI specs; mobile-app for native pairing) are blocking it.
