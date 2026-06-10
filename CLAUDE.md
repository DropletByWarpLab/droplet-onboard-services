# droplet-onboard-services

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.


> **Architecture note:** This repo is the **intelligence layer** (orchestrator, agent loop, MCP server, AI gateway). Inference (Ollama) lives in the sibling repo [`droplet-local-LLM`](../droplet-local-LLM). Both repos deploy side-by-side on the same inference host. See [`docs/agentic-workflows.md`](docs/agentic-workflows.md) for the full picture.

Control-plane monorepo for the Droplet edge AI appliance. This monorepo contains the orchestrator API, web dashboard, AI gateway proxy, file indexer service, and all supporting Docker infrastructure.

> **New to this repo / an agent?** Read [`docs/COMPONENTS.md`](docs/COMPONENTS.md) first — an agent-usable fact sheet for every component (purpose, entry point, ports, what it talks to, and gotchas), plus the system map and repo-wide conventions.

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
services/switch/        FastAPI — Managed switch control (pluggable driver: managed-switch / future ASIC)
services/pm/            Python FastAPI sidecar wrapping upstream Plane (AGPL-3) — embedded PM stack per ADR-010
openwrt/                OpenWrt image builder + config overlay for the router host
docker/                 Nginx, PostgreSQL 16, Redis 7, MQTT, Nextcloud 29, Frigate NVR, Plane (pm-web/api/worker + dedicated postgres-pm/redis-pm)
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
- **Switch service:** Python, FastAPI, abstract driver interface (managed-switch driver / future ASIC)
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

The sibling repo `droplet-local-LLM` ships two services on the inference
host: **Ollama** (`:11434`, the inference engine) and **ollama-manager**
(`:8002`, a lifecycle + opt-in observability sidecar). They are NOT
interchangeable proxy layers — each owns separate concerns:

- **Chat path is direct to Ollama** (`OLLAMA_URL=http://...:11434`).
  ai-gateway's `OllamaLocalProvider` posts straight to Ollama's
  OpenAI-compat `/v1/chat/completions`. Production's `.env` and the
  `OllamaLocalProvider` code default both point here. Going direct
  matters because ollama-manager's `TIMEOUT_PROXY` read leg is 120 s
  (see `droplet-local-LLM/services/ollama-manager/timeouts.py`), which
  the orchestrator's agent loop blows past on CPU inference and on
  cold-loads of larger models — surfacing as 502 from the manager and
  500 from the orchestrator. ADR-004 in `droplet-local-LLM` records the
  original rationale for the sidecar's `/proxy` endpoint, but the chat
  path in production deliberately does not use it.
- **ollama-manager owns model lifecycle**: `GET/POST /models/*`,
  `GET /health` (limits contract that `OllamaLocalProvider._LimitsCache`
  reads), `GET /metrics`. These are NOT exposed through ai-gateway —
  they're called directly by setup scripts and observability tooling.
- **ollama-manager's `/proxy/v1/chat/completions` is opt-in observability**
  (tool-call counter, JSON repair, circuit breaker). Point
  `OLLAMA_URL` at `http://...:8002/proxy` ONLY when you want those
  signals and your prompts fit inside the 120 s read budget — typical
  for production on the inference host with warm models, NOT for CPU dev or
  heavy first-call cold loads.

If you're debugging an "AI not reachable" issue, the first thing to
check is `OLLAMA_URL` inside the running ai-gateway container
(`docker exec droplet-ai-gateway-1 env | grep OLLAMA`).
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
| voice-io       | —     | Voice loop (wake → STT → orchestrator agent loop → TTS), profile `linux` (needs `/dev/snd`) |
| oled-display   | —     | PyPortal screen service, profile `display` (auto-falls back to sim backend when no `/dev/ttyACM*`) |
| switch         | :8081 | Managed switch control, profile `full`    |
| camera-discovery | —   | ONVIF/RTSP scanner, profile `full`        |
| routing        | :8080 | OpenWrt control, host network             |

`COMPOSE_PROFILES=linux,display` is set in `.env` automatically by `setup.sh` on Linux so Frigate + voice-io + oled-display all start with the default stack (PyPortal absence is a no-op via sim backend); on macOS it's empty so the GPU/audio device mounts never trip. Add `full` by hand to opt into switch/camera-discovery — both need real hardware + operator-supplied credentials and aren't default-on so a fresh install doesn't scan the LAN or hit a missing switch.

## Updating `.env` on a running stack

`docker restart <container>` does **not** re-read the env_file. Containers
keep the env they were originally booted with. After editing `.env`, recreate
the affected services. This applies to resource-limit changes too — editing
`ORCHESTRATOR_MEM_LIMIT` in `.env` requires `--force-recreate orchestrator` to
take effect. See [`docs/ADR-012-container-resource-limits.md`](docs/ADR-012-container-resource-limits.md)
for the per-service RAM budget and tuning guidance.

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
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowlist of browser Origins permitted to make credentialed cross-origin requests against the orchestrator (WARP-562). Exact-match — entries are compared byte-for-byte against the request `Origin` with no normalization, so a trailing slash (`https://x.example/`) or differing case will silently never match; supply each origin as scheme+host(+port) only, e.g. `https://droplet-ai.local`. `credentials: true` is always on so the orchestrator never reflects an arbitrary Origin. Default when unset: `https://droplet-ai.local` (covered by the TLS cert SANs) plus `http://localhost:3001` (the Next.js dashboard dev server; `:3000` is the orchestrator's own port) outside production. A `*` value is **rejected at startup** (mirrors `services/ai-gateway/main.py`). |
| `RATE_LIMIT_TRUSTED_PROXIES` | (ai-gateway, GW-14) Comma-separated socket-peer IPs/CIDRs whose forwarded client-IP headers (`X-Real-IP`/`X-Forwarded-For`) the gateway's rate limiter trusts for per-client bucketing. ai-gateway has no app-level auth and is reachable by any peer on the compose network, so a forged `X-Real-IP` could mint a private bucket and bypass the limit. Default empty → trust nothing → always key on the real socket peer (safe). Set to your nginx edge's address/subnet (e.g. `172.18.0.0/16`) to restore header-based client identification through the proxy. |
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
| `FRIGATE_IMAGE`      | Frigate container image (default `stable` CPU; set `stable-tensorrt-jp6` on the inference host with JetPack 6 / NVIDIA GPU) |
| `FRIGATE_RUNTIME`    | Docker runtime for the Frigate container (`runc` default; set `nvidia` on inference hosts / x86+NVIDIA hosts) |
| `YOLO_MODELS`        | JP6-image model preparator trigger; leave empty until the s6 prepare script stops expecting legacy `.cfg` inputs |
| `SWITCH_HOST`        | Managed switch IP (default `192.168.1.77`)             |
| `SWITCH_PORT`        | Managed switch HTTPS port (default `443`)              |
| `SWITCH_USERNAME`    | Switch admin username (default `admin`)                |
| `SWITCH_PASSWORD`    | Switch admin password                                  |
| `SWITCH_DRIVER`      | Switch driver: `lantronix` (default) or `asic` (future) |
| `SWITCH_SERVICE_URL` | Switch service endpoint (default `http://host.docker.internal:8081` — same host-mode rationale as `ROUTING_SERVICE_URL`) |
| `DISPLAY_SERVICE_URL`| OLED/TFT display service endpoint (default `http://host.docker.internal:8082` — display runs host-mode on the inference host) |
| `DROPLET_PM_API_URL` | Plane backend API URL on the compose network (default `http://pm-api:8000`) — embedded PM stack per ADR-010 |
| `DROPLET_PM_WEB_URL` | LAN-facing URL Plane bakes into emails / share links (default `https://droplet-ai.local/pm`) — covered by the existing TLS cert SANs |
| `DROPLET_PM_ADMIN_TOKEN` | Orchestrator-only token for provisioning Plane users via admin API. **NEVER** exposed to the dashboard or LLM agent. Empty default makes the SSO bridge 503 until `setup.sh` populates `.env` |
| `DROPLET_PM_WEBHOOK_SECRET` | HMAC signing key for Plane → orchestrator webhooks (WARP-511). Empty default → webhook receiver fail-CLOSED per the engineering-handbook `04-coding-standards/security-rules.md` §1 |
| `DROPLET_PM_DB_NAME` / `_USER` / `_PASSWORD` / `_HOST` / `_PORT` | Dedicated `postgres-pm` connection (OQ1 — separate from the orchestrator's main Postgres) |
| `DROPLET_PM_REDIS_HOST` / `_PORT` | Dedicated `redis-pm` connection (OQ1) |
| `DROPLET_PM_SECRET_KEY` | Plane Django `SECRET_KEY` (session signing, etc.) — generated by `setup.sh` |
| `DROPLET_PM_DEFAULT_WORKSPACE` | First workspace name seeded by the setup wizard (WARP-507). Falls back to "My Workspace" if empty |
| `ROUTING_MODE`       | `real` (default) / `mock` (fixture-driven, no OpenWrt needed) / `disabled` (orchestrator skips router calls). See WARP-44. |
| `CONTAINER_PIDS_LIMIT` | Global PID limit applied to all services (default `512`). Raise for services with many worker threads. |
| `GATEWAY_MEM_LIMIT` | nginx mem ceiling (default `128m`) |
| `WEB_DASHBOARD_MEM_LIMIT` | Next.js mem ceiling (default `384m`) |
| `ORCHESTRATOR_MEM_LIMIT` | Orchestrator mem ceiling (default `768m`) |
| `ORCHESTRATOR_MEM_RESERVATION` | Orchestrator mem reservation — protected from OOM eviction (default `512m`) |
| `ORCHESTRATOR_CPUS` | Orchestrator CPU ceiling (default `2.0`) |
| `DB_MEM_LIMIT` | Postgres mem ceiling (default `1g`) |
| `DB_MEM_RESERVATION` | Postgres mem reservation — most protected core service (default `512m`) |
| `DB_CPUS` | Postgres CPU ceiling (default `2.0`) |
| `CACHE_MEM_LIMIT` | Redis mem ceiling (default `256m`) |
| `CACHE_MEM_RESERVATION` | Redis mem reservation (default `128m`) |
| `AI_GATEWAY_MEM_LIMIT` | AI gateway mem ceiling (default `512m`) |
| `FRIGATE_MEM_LIMIT` | Frigate NVR mem ceiling (default `1g`) — raise for higher-resolution streams |
| `OLLAMA_MEM_LIMIT` | Ollama LLM inference mem ceiling (default `4g`) — raise for larger models |
| `OLLAMA_CONTEXT_LENGTH` | Context window for the bundled single-box Ollama (default `16384`). Ollama's own default is 4096, which the owner-role tool schemas alone overflow — symptom: instant empty chat answers (WARP-854) |
| `OLLAMA_CPUS` | Ollama CPU ceiling (default `4.0`) |
| `WHISPER_MEM_LIMIT` | Wyoming Whisper STT mem ceiling (default `1g`) — small.en model is ~470 MB |
| (other `*_MEM_LIMIT` / `*_CPUS`) | Per-service overrides for every container. See `docs/ADR-012-container-resource-limits.md` for the full list and RAM budget. |

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
