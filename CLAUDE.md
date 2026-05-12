# edge-platform

> **Architecture note:** This repo is the **intelligence layer** (orchestrator, agent loop, MCP server, AI gateway). Inference (Ollama) lives in the sibling repo [`droplet-jetson-ai`](../droplet-jetson-ai). Both repos deploy side-by-side on the same Jetson. See [`docs/agentic-workflows.md`](docs/agentic-workflows.md) for the full picture.

Control-plane monorepo for the Droplet edge AI appliance. This monorepo contains the orchestrator API, web dashboard, AI gateway proxy, file indexer service, and all supporting Docker infrastructure.

## Monorepo structure

```
apps/orchestrator/      Express + Prisma — central API and device control
apps/web-dashboard/     Next.js 14 — admin UI
packages/tools-core/    @droplet/tools-core — single canonical LLM tool registry (TypeScript)
services/mcp-server/    @droplet/mcp-server — MCP server (stdio + streamable-HTTP)
services/ai-gateway/    FastAPI provider router — LiteLLM for cloud (OpenAI, Anthropic), direct httpx for local Ollama (no tool dispatch)
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
- **Tools-core:** TypeScript, JSON-Schema; canonical registry consumed by orchestrator + mcp-server
- **MCP server:** TypeScript, `@modelcontextprotocol/sdk`; stdio (in-process child) + streamable-HTTP (external clients)
- **AI gateway:** Python, FastAPI. Multi-provider router with **mixed transports**: LiteLLM (`litellm.acompletion`) for cloud providers — `services/ai-gateway/providers/openai_cloud.py`, `anthropic_cloud.py` — and a custom httpx-based provider for local Ollama (`providers/ollama_local.py`) hitting the OpenAI-compat `/v1/chat/completions` endpoint. Also exposes a gRPC `EmbedText` service on port 50051 (used by `services/file-indexer/`). Provider router only — does NOT dispatch tools (orchestrator owns that via MCP).
- **Routing service:** Python, FastAPI, OpenWrt ubus JSON-RPC SDK
- **File indexer:** Python, watchdog (was `file-sync`; renamed to reflect its indexer+embedder role)
- **Camera discovery:** Python, FastAPI, ONVIF, WS-Discovery
- **Switch service:** Python, FastAPI, abstract driver interface (Lantronix SM8TAT2SA / future ASIC)
- **NVR:** Frigate (open-source), TensorRT GPU detection, RTSP
- **Infra:** Docker Compose, Nginx, Redis, MQTT (Mosquitto), Nextcloud, Frigate
- **Smart home:** Native Matter controller in the orchestrator (`matter.service.ts`). The dashboard talks to Matter directly via `/api/matter/*`.

## Coding standards

- **No `while True` loops for scheduling.** Use a proper scheduler instead:
  - **Python services:** `apscheduler` (`AsyncIOScheduler` for asyncio services,
    `BackgroundScheduler` otherwise). Pinned to `apscheduler` in each service's
    `requirements.txt`. The first canonical usage lands in WARP-218
    (`services/file-indexer`); copy that pattern.
  - **TypeScript orchestrator:** `apps/orchestrator/src/services/cron-runtime.service.ts`
    via `createCronRuntime(...).scheduleCron(...)` or `.scheduleInterval(...)`.
    Already used by reminders-poller, schedule ticker, and the daily 03:00 purge.
  - Existing `while True` violations are tracked in WARP-221 (camera-discovery's
    ONVIF scan, switch driver's keepalive). Add new ones to that ticket if you
    spot more — don't introduce them.
  - Legitimate `while True` patterns DO exist and are NOT covered by this rule:
    event-driven dispatch loops (`await event.wait()`), bounded chunk-streaming
    reads, and microcontroller event loops on different runtimes (CircuitPython).
    The rule is about *scheduling* — fire X every N seconds / at time Y — not
    about every loop in the codebase.
- **No guessing, ever.** Persistent state lives in explicit columns, not in
  the absence of other columns. If `status` is a property of a row, declare
  it as `status: SomeEnum`; do not derive it from `indexedAt IS NULL` or
  similar absence patterns. Querying for "all failed transcripts" should be
  `WHERE status = 'failed'` — direct, indexable, no joins, no compound
  predicates over nullable fields. Adding a column for the canonical
  representation is cheaper than every reader having to remember the
  derivation rule. WARP-218's `BrainMemoryItemStatus` enum is the canonical
  example; copy that pattern.

## LLM tool calling

- All LLM-callable tools live in the `@droplet/tools-core` workspace package
  with a single canonical registry. The orchestrator's `llm-agent.service.ts`
  runs the agent loop and dispatches tool calls via `@droplet/mcp-server`
  (MCP, stdio child process). External MCP clients (inference-engine,
  Claude Desktop, etc.) reach the same server over streamable HTTP with
  JWT auth and per-tool RBAC. `services/ai-gateway/` is a thin provider
  router (LiteLLM for cloud, direct httpx for local Ollama); it does NOT
  dispatch tools.
- The dashboard's `/chat` page hits `POST /api/llm/chat` which drives the
  orchestrator's MCP-backed agent loop. `GET /api/llm/tools` proxies
  `mcp-client.service.ts → listTools()` so the wire shape matches what
  off-host MCP clients see.
- **Adding a new tool:** add a handler under
  `packages/tools-core/src/handlers/<domain>/`, register it in
  `packages/tools-core/src/registry.ts`, set `requiresWrite` and
  `requiresConfirmation`, and add a unit test. The MCP server picks it up
  automatically. The orchestrator's `WRITE_TOOLS` set in
  `apps/orchestrator/src/routes/llm.ts` is derived from `requiresWrite`,
  so RBAC tracks per-tool intent without manual sync.

## Ollama call path (chat vs lifecycle)

The sibling repo `droplet-jetson-ai` ships two services on the inference
host: **Ollama** (`:11434`, the inference engine) and **ollama-manager**
(`:8002`, a lifecycle + opt-in observability sidecar). They are NOT
interchangeable proxy layers — each owns separate concerns:

- **Chat path is direct to Ollama** (`JETSON_OLLAMA_URL=http://...:11434`).
  ai-gateway's `OllamaLocalProvider` posts straight to Ollama's
  OpenAI-compat `/v1/chat/completions`. Production's `.env` and the
  `OllamaLocalProvider` code default both point here. Going direct
  matters because ollama-manager's `TIMEOUT_PROXY` read leg is 120 s
  (see `droplet-jetson-ai/services/ollama-manager/timeouts.py`), which
  the orchestrator's agent loop blows past on CPU inference and on
  cold-loads of larger models — surfacing as 502 from the manager and
  500 from the orchestrator. ADR-004 in `droplet-jetson-ai` records the
  original rationale for the sidecar's `/proxy` endpoint, but the chat
  path in production deliberately does not use it.
- **ollama-manager owns model lifecycle**: `GET/POST /models/*`,
  `GET /health` (limits contract that `OllamaLocalProvider._LimitsCache`
  reads), `GET /metrics`. These are NOT exposed through ai-gateway —
  they're called directly by setup scripts and observability tooling.
- **ollama-manager's `/proxy/v1/chat/completions` is opt-in observability**
  (tool-call counter, JSON repair, circuit breaker). Point
  `JETSON_OLLAMA_URL` at `http://...:8002/proxy` ONLY when you want those
  signals and your prompts fit inside the 120 s read budget — typical
  for production on the Orin Nano with warm models, NOT for CPU dev or
  heavy first-call cold loads.

If you're debugging an "AI not reachable" issue, the first thing to
check is `JETSON_OLLAMA_URL` inside the running ai-gateway container
(`docker exec droplet-pi-platform-ai-gateway-1 env | grep JETSON`).
A trailing `/proxy` is the smoking gun for "manager timed out my agent
loop"; a stale `inference-engine.local` is the smoking gun for "mDNS
doesn't resolve from inside Docker on macOS" (use
`host.docker.internal:11434` locally).

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
