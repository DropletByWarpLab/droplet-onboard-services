# Implementation status — droplet-onboard-services

Last updated: 2026-07-26
Source context: `droplet-gtm-strategy.docx` (April 2026) and `git ls-files` at the branch point.
This refresh reconciles ~190 commits landed since the previous 2026-06-15 revision.

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

### Security & access control
- **RBAC with per-route guards.** `Role` enum on the Prisma `User` model (`apps/orchestrator/prisma/schema.prisma`, `enum Role`), `requireRole(...)` middleware (`apps/orchestrator/src/middleware/auth.ts`, scope helper in `middleware/scope.ts`) applied per-route (e.g. `routes/aps.ts`, `routes/activity.ts`, `routes/auth.ts`). Covered by `__tests__/rbac.test.ts` + `__tests__/require-role.middleware.test.ts`.
- **Postgres-backed append-only audit log.** `ActivityRow` model (`schema.prisma`, WARP-456) with an HMAC-SHA256 hash-chain — each row signs over canonical JSON and hashes the prior signature so the chain is tamper-evident (`apps/orchestrator/src/services/audit-signing.service.ts`). Sealed export via `POST /api/activity/export` (`apps/orchestrator/src/routes/activity.ts`, owner/admin gated).
- **HTTPS with auto-generated cert + HTTP→HTTPS redirect.** Nginx terminates TLS on `:443` (`docker/nginx/nginx.conf`: `listen 443 ssl` with `droplet.crt`/`droplet.key`) and 301-redirects `:80` → `https://` for all paths. The self-signed cert is generated/regenerated on first boot by `_generate_tls_cert` (`scripts/lib/secrets.sh`).
- **QR/PIN device pairing.** `POST /api/devices/pair` mints a short-lived 6-char code + `droplet://pair?...` QR payload, `GET /api/devices/pair/:code/status` polls, and `POST /api/devices/pair/claim` completes the pairing (`apps/orchestrator/src/routes/device-clients.ts`).
- **WireGuard remote access.** `VpnPeer` Prisma model (`schema.prisma`) + `routes/vpn.ts` + `services/vpn.service.ts` (IP allocation from `10.13.13.0/24`, `.conf` rendering); router-side keypair/peer provisioning via `services/routing/` (ubus/ACL). Dashboard "Remote Access" page renders the `.conf` as a QR.

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

### Conversation persistence
- **Postgres-backed chat history.** `ChatSession` / `ChatMessage` Prisma models (`apps/orchestrator/prisma/schema.prisma`) persisted via `apps/orchestrator/src/services/chat-persistence.service.ts` (create/find/list/delete sessions, transactional message writes, `updatedAt` maintenance). Chat survives across sessions; session state is owned by the orchestrator + Prisma (not in-memory and not the ai-gateway). GTM M1.5 is `[x]` Done.

### Response streaming
- **Server-side token streaming shipped (WARP-1442, commit `fa255f71`).** The agent loop (`apps/orchestrator/src/services/llm-agent.service.ts`, WARP-1442 block from ~line 504) consumes the ai-gateway token stream and emits `content_delta` events incrementally as the model generates; `routes/llm.ts` relays them over the existing `encodeSSE` channel with WARP-329 debounced persistence to Postgres. On stream transport errors the loop falls back to the blocking `chat()` path — streaming is additive, never a new failure mode. GTM M1.6 is `[x]` Done.

### Web UI
- Next.js 14 App Router with setup wizard, login, dashboard, files, chat, settings (`apps/web-dashboard/src/app/`).
- Auth-gated routes; token flow via HTTP-only cookies (this line previously read `localStorage` — corrected per the stale-banner; prod is cookie-based, see `LAUNCH_READINESS_AUDIT.md`); `/setup` redirect when no users exist (`apps/web-dashboard/src/app/setup/`, `apps/web-dashboard/src/app/users/`, `apps/web-dashboard/src/app/settings/`).

### Infrastructure
- **Unified Docker Compose stack** — 29 top-level compose services in a single file (`docker/docker-compose.yml`), 13 default-on and the rest profile-gated.
- Nginx reverse proxy terminating on `:80` and `:443` (`docker/nginx/nginx.conf`, `docker/certs/`).
- PostgreSQL 16, Redis 7, Mosquitto 2 MQTT broker, Nextcloud 29 (apache), Frigate NVR (`docker/docker-compose.yml`, `docker/frigate/config.yml`, `docker/mosquitto.conf`, `docker/nextcloud-skeleton/`, `docker/init-nextcloud-db.sh`, `docker/nextcloud-init.sh`). Smart-home devices are controlled by the `matter-controller` host-network sidecar (`services/matter-controller/`, ADR-022/WARP-850 — BLE commissioning + LAN mDNS), fronted by the orchestrator's `/api/matter/*` routes.
- OpenWrt single-box AP container image (`openwrt/singlebox-image/`) + UCI config overlay (`openwrt/files/`, `openwrt/scripts/`, `openwrt/README.md`). The legacy multi-box bare-metal router image builder (`openwrt/build.sh`) is still on disk but retired (ADR-011, see `openwrt/README.md`) — the router runs in a container on single-box.
- Setup + factory-reset scripts with flags for `--dry-run`, `--systemd`, `--regenerate-env`, etc. (`scripts/setup.sh`, `scripts/factory-reset.sh`, `scripts/README.md`).
- Turbo 2.0 monorepo pipeline (`turbo.json`, `package.json`).
- gRPC proto definitions (`proto/inference.proto`).
- Helper scripts: `scripts/verify.sh`, `scripts/test-security.sh`, `scripts/build-image.sh`, `scripts/camera-drivers.sh`, `scripts/generate-grpc.sh`.
- **CI/CD pipeline** — 43 GitHub Actions workflows under `.github/workflows/`. The required PR check is `ci.yml` (path-aware `detect` job → dynamic test matrices; fails closed — see `docs/ci-cost-budget.md`); per-service `*-tests.yml` suites run push-to-main only as the post-merge canary, plus `docker-build.yml`, `security-tests.yml`, `test-fips.yml`, `setup-e2e.yml`, `ota-e2e.yml`, `rag-eval-tests.yml`, etc. GTM M1.8 is `[x]` Done.

### Test coverage
- Orchestrator unit tests (`apps/orchestrator/src/__tests__/`).
- AI gateway pytest suite (`services/ai-gateway/tests/`).
- Web dashboard component tests (`apps/web-dashboard/src/__tests__/`).
- Integration tests (`tests/api.integration.test.ts`, `tests/auth.integration.test.ts`, `tests/docker-compose.test.yml`, `tests/Dockerfile.test`).
- Bash smoke tests (`tests/setup.test.sh`, `tests/factory-reset.test.sh`).

---

## 🟡 Partial / stubbed

- **Auth middleware** (`apps/orchestrator/src/middleware/auth.ts`): JWT access tokens (15 min) + refresh tokens (7 days). Auth middleware verifies JWT first, falls back to Nextcloud OCS for legacy tokens. Role claim (owner/admin/family/guest) included in JWT. GTM M1.3 is `[x]` Done. RBAC per-route guards (M2.2) are also `[x]` Done — see "Security & access control" above.
- **NVR integration** (`docker/frigate/config.yml`, `services/camera-discovery/`, `apps/orchestrator/src/routes/cameras.ts`): Frigate is wired into Compose; ONVIF scanner + Frigate client exist; event subscriptions and clip-export delegation need auditing. GTM M2.1 is `[~]`.
- **Prompt-injection hardening** (`services/ai-gateway/middleware/rate_limit.py`, `services/ai-gateway/schemas.py`): Sliding-window rate limiter implemented (Redis + in-memory fallback) on chat endpoints. Input validation: `max_tokens` capped at 4096, messages capped at 100, content at 32k chars. CORS restricted to explicit origins. Remaining: output schema validation for tool-call responses. GTM M2.7 is `[~]`.
- **Photo indexing** (`services/file-indexer/embedder.py`, `services/file-indexer/extractors/`): text indexing plumbing is present; image/CLIP embedding is not. GTM M3.3 is `[~]`.
- **Guided setup wizard** (`apps/web-dashboard/src/app/setup/page.tsx`, `apps/orchestrator/src/routes/setup.ts`): the wizard is multi-step (account → network → storage → cameras → VPN → AI — see `docs/SETUP_WIZARD_WALKTHROUGH.md`) and CI-gated: `.github/workflows/setup-e2e.yml` builds and exercises the setup path on onboarding/orchestrator PRs (WARP-971). GTM M2.5 is substantially done; remaining polish tracked per-step.
- **SD-card appliance image** (`openwrt/build.sh`, `scripts/build-image.sh`): OpenWrt image builder exists; a combined "OS + Docker stack" `.img` for the full appliance is unclear — `scripts/build-image.sh` needs inspection. GTM M2.8 is `[~]`.
- **Test suite** (`tests/`, per-service `__tests__/`): unit and integration scaffolding is in place, but no streaming E2E, no browser E2E (no Playwright), no latency benchmarks for the AI path. GTM M1.7 is `[~]`.

---

## 🔴 Not started

- **PWA / mobile-responsive audit** (GTM M2.4). Next.js app responsiveness is untested; no PWA manifest.
- **Community marketplace** (GTM M3.6). No `Extension` model, no `/extensions` route, no extension registry.

> JWT auth + RBAC (M1.3, M2.2), CI/CD (M1.8), device pairing (M2.3), WireGuard (M2.6), Postgres-backed audit logging (GTM §2.3), and the OTA update system (M3.4 — `apps/orchestrator/src/routes/updates.ts` + `apps/orchestrator/src/services/update-agent/` with signed-manifest verification, exercised by `.github/workflows/ota-e2e.yml`) have all shipped since this file was last revised — see "Working" above.

---

## Since 2026-06-15 — major landed themes

- **Internal service-to-service mTLS** (WARP-1061) — every first-party internal hop + MQTT authenticates with client certs; `DROPLET_INTERNAL_TLS=1` activates. See `docs/security/internal-mtls.md`.
- **Departments/teams + libraries** (ADR-029, epic WARP-1251) — org structure and shared library model across orchestrator, Nextcloud provisioning, and the dashboard.
- **Own-WireGuard overlay remote access** (ADR-031, epic WARP-1382) — direct-punch overlay supersedes the Cloudflare-relay customer-facing client story.
- **Custom RBAC v2** (ADR-032, epic WARP-1522) — custom roles + per-axis grants replacing the fixed four-role system.
- **RAG upgrade program phases 1–3** (WARP-435/436/437) — hybrid retrieval, reranking, and query enhancement (HyDE + multi-query + adaptive routing); see `docs/RAG_UPGRADE_STATUS.md`.
- **Voice pipeline** (`services/voice-io` + Wyoming STT/TTS compose services) — on-box voice in/out.
- **Nextcloud provisioning self-heal** (WARP-1327/1328/1359/1381) — file-id resolution, `oc_*` read grants, WebDAV `.part` rename handling, credential survival across invite-accept/logout.
- **CI cost-budget redesign** (`ci.yml`) — path-aware detect job + dynamic matrices as the single required PR check; per-service workflows moved to push-to-main canaries. See `docs/ci-cost-budget.md`.

---

## Health against GTM phases (PH1–PH5)

| Phase | Name | Status here | Notes |
|---|---|---|---|
| PH1 | Repo + Runtime | `[x]` Complete | Turbo monorepo, 29-service Compose stack, setup/factory-reset scripts, per-workspace tests, OpenWrt image builder. |
| PH2 | Device Control API — auth/RBAC | `[x]` Complete | JWT auth (M1.3) and RBAC per-route guards (M2.2) both done — `Role` enum on the Prisma `User` model + `requireRole()` middleware applied per-route. |
| PH3 | Service stubs → real | `[~]` Partial | `services/routing/`, `services/camera-discovery/`, `services/file-indexer/` are real services (not stubs). Postgres-backed append-only audit log (`ActivityRow`, WARP-456) now shipped. Remaining gaps: storage metrics endpoint completeness, full NVR clip-export path. |
| PH4 | Assistant tooling hardening | `[~]` (cross-repo) | This repo's `services/ai-gateway/` is the outer input layer; primary hardening (OpenClaw sandbox, tool policy) lives in `droplet-local-LLM`. Verify input-validation + rate-limit coverage here as part of M2.7. |
| PH5 | Docs + polish | `[~]` Partial | README, CLAUDE.md, CONTRIBUTING.md, scripts/README.md, service-level TESTING.md, and the threat model (`docs/THREAT_MODEL.md`) exist. **Missing:** OpenAPI wiring (the API contract is documented in `docs/mobile-api-contract.md` + `packages/shared-types`, not generated specs), architecture diagrams beyond README ASCII art. |

---

## Pointers

- Roadmap with per-milestone status: `docs/ROADMAP.md`
- GTM doc ↔ repo mapping: `docs/gtm-mapping.md`
- Authoritative session state for Claude Code: `CLAUDE.md`
- Contribution workflow: `CONTRIBUTING.md`
- Setup + factory-reset: `scripts/README.md`, `README.md`
- AI gateway testing (incl. mock Ollama): `services/ai-gateway/TESTING.md`
- OpenWrt router builder: `openwrt/README.md`
