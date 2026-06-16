# GTM Doc → Repo Mapping

The April 2026 GTM strategy doc (`droplet-gtm-strategy.docx`) describes a reference architecture that has drifted from this repo's actual layout. This file is the bridge.

The GTM doc is the **current reference**: this mapping does not claim the doc is wrong — it enumerates the deltas so that anyone reading the doc and looking at the code can reconcile the two.

## Reference architecture (per GTM doc, Appendix A)

The GTM doc's "File Inventory" appendix cites the following paths:

- `docker-compose.yml` (root) — router/NAS stack orchestration
- `infra/docker-compose.yml` — assistant stack orchestration (separate compose file)
- `docker/entrypoint.sh` — router/NAS service startup
- `services/assistant-api/app/main.py` — FastAPI chat endpoint
- `services/assistant-api/app/llm.py` — Ollama tool-calling loop
- `services/assistant-api/app/tools.py` — tool definitions and execution
- `services/assistant-api/app/config.py` — Pydantic settings
- `services/device-api-stub/app/main.py` — mock Device Control API
- `services/assistant-ui/index.html` — web chat interface
- `services/assistant-ui/nginx.conf` — reverse proxy config
- `docker/configs/smb.conf`, `docker/configs/sshd_config` — hardened service configs
- `deploy/install.sh` — automated setup script
- `deploy/droplet-assistant.service` — systemd unit for boot persistence

And the phase/milestone language throughout §1–§6 assumes this layout.

## Actual architecture (this repo, 2026-04-15)

```
edge-platform/
  apps/
    orchestrator/           Express + Prisma (Node), the control plane
    web-dashboard/          Next.js 14 admin UI
  services/
    ai-gateway/             FastAPI + LiteLLM — LLM proxy to inference-engine
    routing/                FastAPI — OpenWrt ubus JSON-RPC client
    camera-discovery/       FastAPI — ONVIF/RTSP + Frigate client
    file-indexer/           Python — filesystem watcher + embedder + MQTT
  openwrt/                  OpenWrt image builder + config overlay (replaces the old Docker-based router)
  docker/
    docker-compose.yml      Unified Compose stack (20 services)
    nginx.conf              Reverse proxy
    frigate/config.yml
    mosquitto.conf, mosquitto_passwd_dir/
    certs/                  TLS certs
    nextcloud-skeleton/, nextcloud-init.sh, init-nextcloud-db.sh
  proto/
    inference.proto         gRPC definitions for orchestrator ↔ ai-gateway/inference-engine
  scripts/
    setup.sh, factory-reset.sh, verify.sh, test-security.sh
    build-image.sh, camera-drivers.sh, generate-grpc.sh
  tests/                    Vitest integration tests (+ bash smoke tests)
  turbo.json                Turbo monorepo pipeline
  package.json              npm 10.9 workspaces
```

## Mapping table

| GTM reference | Actual location | Notes |
|---|---|---|
| `services/assistant-api/app/main.py` | `apps/orchestrator/src/index.ts` + `apps/orchestrator/src/app.ts` | Control plane is now Node/Express/Prisma, not Python/FastAPI. Same role: the single HTTP entry point that fronts everything. |
| `services/assistant-api/app/llm.py` | `services/ai-gateway/main.py` + `services/ai-gateway/router.py` | The LLM tool-calling loop moved out of the control plane and into a dedicated FastAPI/LiteLLM gateway that proxies to `inference-engine`. |
| `services/assistant-api/app/tools.py` | `inference-engine/services/openclaw/config/openclaw.json` (+ agent workspaces) | Tool definitions live in the inference-engine's OpenClaw configs, not this repo. The ai-gateway here is a thin proxy. |
| `services/assistant-api/app/config.py` | `apps/orchestrator/src/config.ts` (Zod-validated) + `services/ai-gateway/` Pydantic settings | Split across the control plane (Node/Zod) and the gateway (Python/Pydantic). |
| `services/device-api-stub/app/main.py` | **does not exist** | The stub has been replaced by `apps/orchestrator` + `services/routing` + `services/camera-discovery` + `services/file-indexer`. The stub role is obsolete. |
| `services/assistant-ui/index.html` | `apps/web-dashboard/` (Next.js 14) | Static HTML UI replaced by a full Next.js App Router SPA with Tailwind. |
| `services/assistant-ui/nginx.conf` | `docker/nginx.conf` | Same file, different location; still runs in the `gateway` service (`nginx:alpine` on `:80/:443`). |
| `docker/entrypoint.sh` | **does not exist** in this repo | The router/NAS "entrypoint script" model was abandoned. Router bring-up now goes through OpenWrt's own init system (`openwrt/`). App containers have per-service entrypoints inside their Dockerfiles. `scripts/setup.sh` handles host-side orchestration. |
| `docker/configs/smb.conf` | `openwrt/files/` (OpenWrt Samba package config) | Samba now lives on the OpenWrt router as a native package, not a Docker container. |
| `docker/configs/sshd_config` | `openwrt/files/` | Same — SSH is an OpenWrt package, not a Docker container. |
| `deploy/install.sh` | `scripts/setup.sh` | Same role: install Docker, generate secrets, build, start, verify. Adds flags (`--dry-run`, `--systemd`, `--regenerate-env`, `--skip-*`). |
| `deploy/droplet-assistant.service` | `openwrt/scripts/droplet-router-monitor.service` + (optional) systemd unit installed by `scripts/setup.sh --systemd` | Systemd for the **router** side lives under `openwrt/`; boot-persistence for the app stack is opt-in via the `--systemd` flag on `setup.sh`. |
| `docker-compose.yml` (root, router/NAS) | `docker/docker-compose.yml` | No separate root/infra compose files exist. The single file at `docker/docker-compose.yml` manages all 20 services. |
| `infra/docker-compose.yml` (assistant) | folded into `docker/docker-compose.yml` | No separate `infra/` directory. Stack convergence (GTM M1.1) is already done by this structural change. |
| dnsmasq, iptables, hostapd (Docker-based router) | `openwrt/` (OpenWrt image) | The router stack runs OpenWrt natively instead of Docker. dnsmasq / firewall / WiFi AP are OpenWrt packages, controlled via ubus JSON-RPC from `services/routing/`. |

## Deltas / divergences

### 1. Router/NAS moved from Docker-based router to OpenWrt
The GTM doc describes a privileged Docker container running dnsmasq + iptables + hostapd + Samba + NFS + SSH as the router/NAS stack. This repo instead runs **OpenWrt** as the router OS, and the `services/routing/` FastAPI service talks to OpenWrt via ubus JSON-RPC. Consequences:

- GTM's "privileged container escape" critical risk (§5.1) is **already mitigated** — there is no privileged Docker container for routing.
- GTM's `docker/entrypoint.sh` and `docker/configs/smb.conf` / `sshd_config` references are obsolete; those concerns are now OpenWrt package configs.
- M2.6 WireGuard likely lands on the OpenWrt side (first-class wg package) rather than as a Compose service.
- The image-building story (GTM M2.8) bifurcates: `openwrt/build.sh` produces the router image; a separate flow is needed for the app stack's appliance image.

### 2. Control plane is Node/Express/Prisma, not Python/FastAPI
The GTM doc assumes a single Python FastAPI service (`assistant-api`) that does both chat and device control. This repo splits that into:

- **`apps/orchestrator/`** — Node/Express/Prisma control plane (the "Device Control API" role)
- **`services/ai-gateway/`** — Python/FastAPI/LiteLLM LLM-proxy

Implications:
- All GTM file references pointing at `services/assistant-api/app/*.py` need to be split between the Node orchestrator and the Python gateway.
- Auth middleware is in TypeScript (`apps/orchestrator/src/middleware/auth.ts`), not Python — M1.3 JWT work is Node-side here.
- ORM is Prisma (PostgreSQL), not whatever Python ORM the GTM doc assumed.

### 3. Tool-calling loop moved into `inference-engine` (OpenClaw)
GTM §2.2 places the tool-calling loop inside `assistant-api`. In reality, the loop, tool allowlist, and sandbox live in the separate **`inference-engine`** repo (OpenClaw agent gateway). `services/ai-gateway/` in this repo is a thinner router that forwards chat requests to OpenClaw and streams responses back.

This means:
- M2.7 prompt-injection hardening is **two-layer**: input/rate-limit layer in this repo's ai-gateway, sandbox/guardrail layer in `inference-engine`.
- `tools.py` is not in this repo at all — look in `inference-engine` for tool definitions.

### 4. Web UI is Next.js 14, not static HTML
GTM's `services/assistant-ui/index.html` is superseded by `apps/web-dashboard/` — a Next.js 14 App Router SPA with Tailwind 3.4 and SWR. Feature surface is much larger than the GTM doc contemplated: files browser, chat with session management, settings (admin + BYOK keys + sync targets), setup wizard, user management.

M2.4 (PWA / mobile-responsive web) and M2.5 (guided first-run) land in this app rather than as new files.

### 5. `services/file-sync` was renamed to `services/file-indexer`
Historical reference: CLAUDE.md (pre-this-change) and parts of README.md still refer to `services/file-sync/`. The actual on-disk directory is `services/file-indexer/` and the MQTT topics it subscribes to remain `droplet/sync/config/changed` / `droplet/sync/+/trigger` (i.e. the topic names preserve the older `sync` vocabulary). CLAUDE.md has been updated in this pass to call out the rename.

### 6. Stack convergence is already done (M1.1)
GTM §4.1 and §6.1 M1.1 describe "stack convergence" as P0 future work. In this repo, `docker/docker-compose.yml` is already the single unified compose file, with 20 services sharing one Compose network and one `.env`. M1.1 can be marked `[x]` Done — the remaining work is documenting that it's done (this file) and keeping new services inside the same file.

### 7. Test scaffolding exists (M1.7 partial)
GTM §5.3 claims "the codebase has no test suite." This is out of date for this repo:
- `apps/orchestrator/src/__tests__/` — Vitest
- `services/ai-gateway/tests/` — pytest
- `apps/web-dashboard/src/__tests__/` — Vitest + Testing Library
- `tests/api.integration.test.ts`, `tests/auth.integration.test.ts` — integration
- `tests/setup.test.sh`, `tests/factory-reset.test.sh` — bash smoke tests
- `scripts/verify.sh`, `scripts/test-security.sh` — security/integrity checks

Coverage gaps remain (streaming E2E, browser E2E), but the "no tests" framing in the GTM doc is no longer accurate.

### 8. HTTPS is partial, not pending
GTM M1.4 lists HTTPS as P0 future work. The `gateway` service already binds `:443` and mounts `docker/certs/`; the missing piece is confirming a self-signed cert is auto-generated on first boot by `scripts/setup.sh`. M1.4 should be `[~]` Partial, not `[ ]` Not started.

### 9. Model name and hardware assumption
The GTM doc's §5.1 latency risk mentions **phi3:mini** on a low-power host. Per cross-repo notes, the `inference-engine` repo runs **llama3.2:3b** on the inference host, not phi3:mini on a low-power host. Mapping impact: the "10–30s per response" risk quantity is calibrated for the wrong model+hardware pair and should be re-measured; the qualitative risk (latency hurts UX → streaming is the mitigation) still applies. Tracked authoritatively in `inference-engine/docs/gtm-mapping.md`.
