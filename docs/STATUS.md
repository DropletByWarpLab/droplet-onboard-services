# Implementation status — edge-platform

Last updated: 2026-04-15
Source context: `droplet-gtm-strategy.docx` (April 2026) and `git ls-files` at the branch point.

This file is a walk-through of what's actually implemented in this repo, categorised by maturity. File references use the actual on-disk paths; `docs/gtm-mapping.md` covers how these map to the GTM doc's reference architecture.

---

## ✅ Working

### Control plane
- REST API skeleton with structured routes (`apps/orchestrator/src/routes/`): `auth.ts`, `cameras.ts`, `device-clients.ts`, `devices.ts`, `files.ts`, `health.ts`, `llm.ts`, `matter.ts`, `network.ts`, `smart-home.ts`, `storage.ts`.
- Prisma ORM + PostgreSQL 16 wiring (`apps/orchestrator/prisma/schema.prisma`, `apps/orchestrator/src/services/`).
- Redis token cache + MQTT bus clients (`apps/orchestrator/src/services/cache.service.ts`, MQTT initialisation in `apps/orchestrator/src/index.ts`).
- Global error handler + request logger (`apps/orchestrator/src/middleware/error-handler.ts`, `apps/orchestrator/src/middleware/request-logger.ts`).
- Zod-validated env config (`apps/orchestrator/src/config.ts`).
- First-run setup endpoint (`POST /api/auth/setup`) and public-path allowlist in auth middleware.

### AI gateway
- FastAPI app with routing, scheduler, gRPC server (`services/ai-gateway/main.py`, `router.py`, `scheduler.py`, `grpc_server.py`).
- Pydantic request/response models (`services/ai-gateway/schemas.py`).
- Provider abstraction (`services/ai-gateway/providers/`) for local Ollama + cloud via LiteLLM.
- BYOK key store (Fernet-encrypted) (`services/ai-gateway/auth/`).
- TTL-cached model registry (`services/ai-gateway/models/`).
- Test harness (`services/ai-gateway/tests/`, `services/ai-gateway/TESTING.md`).

### Device services
- OpenWrt ubus JSON-RPC SDK + FastAPI service (`services/routing/main.py`, `droplet_openwrt_sdk.py`, `schemas.py`).
- ONVIF + RTSP camera scanner + driver checker + Frigate client (`services/camera-discovery/onvif_scanner.py`, `rtsp_prober.py`, `driver_checker.py`, `frigate_client.py`, `main.py`).
- Filesystem watcher + embedder + MQTT publisher (`services/file-indexer/watcher.py`, `chunker.py`, `embedder.py`, `db.py`, `mqtt_client.py`, `main.py`, `extractors/`).

### Web UI
- Next.js 14 App Router with setup wizard, login, dashboard, files, chat, settings (`apps/web-dashboard/src/app/`).
- Auth-gated routes; token flow via `localStorage`; `/setup` redirect when no users exist (`apps/web-dashboard/src/app/setup/`, `apps/web-dashboard/src/app/users/`, `apps/web-dashboard/src/app/settings/`).

### Infrastructure
- **Unified Docker Compose stack** — 20 services in a single file (`docker/docker-compose.yml`).
- Nginx reverse proxy terminating on `:80` and `:443` (`docker/nginx.conf`, `docker/certs/`).
- PostgreSQL 16, Redis 7, Mosquitto 2 MQTT broker, Nextcloud 29 (apache), Home Assistant, Frigate NVR (`docker/docker-compose.yml`, `docker/frigate/config.yml`, `docker/mosquitto.conf`, `docker/nextcloud-skeleton/`, `docker/init-nextcloud-db.sh`, `docker/nextcloud-init.sh`).
- OpenWrt router image builder (`openwrt/build.sh`, `openwrt/files/`, `openwrt/scripts/`, `openwrt/README.md`).
- Setup + factory-reset scripts with flags for `--dry-run`, `--systemd`, `--regenerate-env`, etc. (`scripts/setup.sh`, `scripts/factory-reset.sh`, `scripts/README.md`).
- Turbo 2.0 monorepo pipeline (`turbo.json`, `package.json`).
- gRPC proto definitions (`proto/inference.proto`).
- Helper scripts: `scripts/verify.sh`, `scripts/test-security.sh`, `scripts/build-image.sh`, `scripts/camera-drivers.sh`, `scripts/generate-grpc.sh`.

### Test coverage
- Orchestrator unit tests (`apps/orchestrator/src/__tests__/`).
- AI gateway pytest suite (`services/ai-gateway/tests/`).
- Web dashboard component tests (`apps/web-dashboard/src/__tests__/`).
- Integration tests (`tests/api.integration.test.ts`, `tests/auth.integration.test.ts`, `tests/docker-compose.test.yml`, `tests/Dockerfile.test`).
- Bash smoke tests (`tests/setup.test.sh`, `tests/factory-reset.test.sh`).

---

## 🟡 Partial / stubbed

- **Auth middleware** (`apps/orchestrator/src/middleware/auth.ts`): validates Bearer tokens against Nextcloud OCS API with a 5-minute Redis cache and `droplet_session` cookies. **No JWT issuance**, **no role claims**, **no refresh tokens**. GTM M1.3 is not done.
- **HTTPS** (`docker/docker-compose.yml` `gateway`, `docker/nginx.conf`, `docker/certs/`): port `:443` is exposed and certs volume is mounted, but self-signed cert auto-generation on first boot needs to be verified inside `scripts/setup.sh`. GTM M1.4 is `[~]`.
- **Conversation persistence** (`services/ai-gateway/sessions/`, `apps/orchestrator/src/routes/llm.ts`): session CRUD endpoints exist; whether the backing store is Postgres or in-memory is unverified — needs audit. GTM M1.5 is `[~]`.
- **Response streaming** (`apps/orchestrator/src/routes/llm.ts`, `services/ai-gateway/main.py`, `services/ai-gateway/providers/`): `sse-starlette` is in the gateway's deps and streaming hooks exist, but true end-to-end streaming depends on upstream `inference-engine` which per cross-repo notes has not implemented Ollama-streaming passthrough yet. GTM M1.6 is `[~]`.
- **NVR integration** (`docker/frigate/config.yml`, `services/camera-discovery/`, `apps/orchestrator/src/routes/cameras.ts`): Frigate is wired into Compose; ONVIF scanner + Frigate client exist; event subscriptions and clip-export delegation need auditing. GTM M2.1 is `[~]`.
- **Prompt-injection hardening** (`services/ai-gateway/middleware/rate_limit.py`, `services/ai-gateway/schemas.py`): Sliding-window rate limiter implemented (Redis + in-memory fallback) on chat endpoints. Input validation: `max_tokens` capped at 4096, messages capped at 100, content at 32k chars. CORS restricted to explicit origins. Remaining: output schema validation for tool-call responses. GTM M2.7 is `[~]`.
- **Photo indexing** (`services/file-indexer/embedder.py`, `services/file-indexer/extractors/`): text indexing plumbing is present; image/CLIP embedding is not. GTM M3.3 is `[~]`.
- **Guided setup wizard** (`apps/web-dashboard/src/app/setup/page.tsx`, `apps/orchestrator/src/routes/auth.ts`): admin-account creation works; WiFi/NAS/camera wizard steps are not implemented. GTM M2.5 is `[~]`.
- **SD-card appliance image** (`openwrt/build.sh`, `scripts/build-image.sh`): OpenWrt image builder exists; a combined "OS + Docker stack" `.img` for the full appliance is unclear — `scripts/build-image.sh` needs inspection. GTM M2.8 is `[~]`.
- **Test suite** (`tests/`, per-service `__tests__/`): unit and integration scaffolding is in place, but no streaming E2E, no browser E2E (no Playwright), no latency benchmarks for the AI path. GTM M1.7 is `[~]`.

---

## 🔴 Not started

- **JWT authentication / RBAC** (GTM M1.3, M2.2). Auth layer needs an ADR and replacement of the Nextcloud-OCS-only path with JWT issuance + refresh + role enum on the `User` Prisma model.
- **CI/CD pipeline** (GTM M1.8). `.github/` contains only logo assets — no `.github/workflows/` directory. Manual runs only (`scripts/verify.sh`, `npm test`, `turbo test`).
- **Device pairing flow** (GTM M2.3). No QR/PIN pairing endpoint; mobile-app has no paired-entry point.
- **PWA / mobile-responsive audit** (GTM M2.4). Next.js app responsiveness is untested; no PWA manifest.
- **WireGuard remote access** (GTM M2.6). No WireGuard service in Compose or OpenWrt overlay.
- **OTA update system** (GTM M3.4). No `updates.ts` route, no A/B partition scheme, no signed-manifest verification.
- **Community marketplace** (GTM M3.6). No `Extension` model, no `/extensions` route, no extension registry.
- **Audit logging** (GTM §2.3 Device Control API row): orchestrator logs via Pino but there is no Postgres-backed append-only audit trail.

---

## Health against GTM phases (PH1–PH5)

| Phase | Name | Status here | Notes |
|---|---|---|---|
| PH1 | Repo + Runtime | `[x]` Complete | Turbo monorepo, 20-service Compose stack, setup/factory-reset scripts, per-workspace tests, OpenWrt image builder. |
| PH2 | Device Control API — auth/RBAC | `[ ]` Not started (as specified by GTM) | Routes exist under `apps/orchestrator/src/routes/` but auth is Nextcloud-session-cookie based, not JWT/RBAC. No role model in Prisma. See `docs/ROADMAP.md` M1.3, M2.2. |
| PH3 | Service stubs → real | `[~]` Partial | `services/routing/`, `services/camera-discovery/`, `services/file-indexer/` are real services (not stubs). Gaps: storage metrics endpoint completeness, audit log, full NVR clip-export path. |
| PH4 | Assistant tooling hardening | `[~]` (cross-repo) | This repo's `services/ai-gateway/` is the outer input layer; primary hardening (OpenClaw sandbox, tool policy) lives in `inference-engine`. Verify input-validation + rate-limit coverage here as part of M2.7. |
| PH5 | Docs + polish | `[~]` Partial | README, CLAUDE.md, CONTRIBUTING.md, scripts/README.md, service-level TESTING.md exist. **Missing:** OpenAPI wiring (delegated to `shared-api` repo), threat model document, architecture diagrams beyond README ASCII art. |

---

## Pointers

- Roadmap with per-milestone status: `docs/ROADMAP.md`
- GTM doc ↔ repo mapping: `docs/gtm-mapping.md`
- Authoritative session state for Claude Code: `CLAUDE.md`
- Contribution workflow: `CONTRIBUTING.md`
- Setup + factory-reset: `scripts/README.md`, `README.md`
- AI gateway testing (incl. mock Ollama): `services/ai-gateway/TESTING.md`
- OpenWrt router builder: `openwrt/README.md`
