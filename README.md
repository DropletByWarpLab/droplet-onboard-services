<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/logo.svg">
    <img alt="Droplet" src=".github/logo.svg" height="48">
  </picture>
</p>

<p align="center">
  Control-plane monorepo for the Droplet edge AI appliance.<br>
  Orchestration, web dashboard, AI routing, file management, and file sync — all on-device.
</p>

> **Architecture note:** This repo is the **intelligence layer** (orchestrator, agent loop, MCP server, AI gateway). Inference (Ollama) lives in the sibling repo [`droplet-local-LLM`](https://github.com/DropletByWarpLab/droplet-local-LLM). Both repos deploy side-by-side on the same inference host. See [`docs/agentic-workflows.md`](docs/agentic-workflows.md) for the full picture.

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12+-3776AB?logo=python&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-14.2-000000?logo=next.js&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688?logo=fastapi&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

---

## Quick setup (on device)

```bash
git clone <repo-url> && cd droplet-onboard-services
./scripts/setup.sh
```

Installs Docker, generates unique device secrets, builds all containers, starts the stack, and verifies health. First visit redirects to the setup wizard to create an admin account.

### Setup phases

| Phase | What happens |
|-------|-------------|
| **1. Preflight** | Validates OS, architecture (ARM64/x86_64), disk (>= 8 GB), memory (>= 2 GB), internet |
| **2. Docker** | Installs Docker Engine 25+ and Compose v2 if not present |
| **3. Secrets** | Generates unique-per-device passwords and encryption keys, writes `.env` (chmod 600) |
| **4. Build** | Pulls 7 base images, builds every service with a `Dockerfile` — orchestrator, web-dashboard, ai-gateway, routing, file-indexer, switch, camera-discovery |
| **5. Start** | Starts the Docker Compose stack with health-check waits |
| **6. Verify** | Runs smoke tests against all services |

### Setup options

```
./scripts/setup.sh [OPTIONS]

  --skip-docker      Skip Docker installation (assume already installed)
  --skip-build       Skip building container images
  --skip-start       Skip starting the Docker Compose stack
  --systemd          Install systemd service for auto-start on boot
  --regenerate-env   Force-regenerate .env (backs up existing)
  --verbose          Show full command output
  --dry-run          Show what would be done without executing
  -h, --help         Show help
```

### Common setup scenarios

```bash
# Full first-time setup on a fresh device
./scripts/setup.sh

# Preview what setup would do
./scripts/setup.sh --dry-run

# Re-provision after Docker is already installed
./scripts/setup.sh --skip-docker

# Rotate all secrets (backs up old .env)
./scripts/setup.sh --skip-docker --skip-build --skip-start --regenerate-env

# Production: full setup + auto-start on boot
./scripts/setup.sh --systemd
```

### Generated secrets

Each device gets its own random credentials — no two devices share secrets:

| Secret | Used by | Purpose |
|--------|---------|---------|
| `DEVICE_SECRET` | ai-gateway | Fernet encryption key for BYOK API keys |
| `POSTGRES_PASSWORD` | db, orchestrator, nextcloud | PostgreSQL authentication |
| `REDIS_PASSWORD` | cache, orchestrator, ai-gateway | Redis authentication |
| `NEXTCLOUD_ADMIN_PASSWORD` | nextcloud | Nextcloud bootstrap admin |

Secrets are stored in `.env` (chmod 600) at the repo root.

---

## Factory reset

```bash
./scripts/factory-reset.sh
```

Wipes **all** user data, credentials, and configuration — returning the device to a clean out-of-the-box state. Requires typing `RESET` to confirm.

### What gets deleted

| Data | Location |
|------|----------|
| PostgreSQL databases | `pgdata` volume — user accounts, chat history, file metadata, sync targets |
| Uploaded files | `filedata` volume |
| Nextcloud data | `nextcloud-data` volume — app state + user files |
| LLM provider API keys | `aikeys` volume — Fernet-encrypted keys + salt |
| Matter fabric state | `matter-data` volume — commissioning secrets, paired node list |
| NVR recordings | `nvrdata` volume |
| Device secrets | `.env` — all 5 generated passwords/keys |
| TLS certificates | `docker/certs/` — self-signed cert + key |
| MQTT broker TLS bundle | `data/secrets/service-tls/broker/` (per-CN client identities — WARP-235) |
| Setup logs | `.data/` — logs and lock files |

Source code, git history, Docker images, and system packages are preserved.

### Reset options

```
./scripts/factory-reset.sh [OPTIONS]

  --yes            Skip interactive confirmation (for automation)
  --reinstall      After wiping, auto-run setup.sh to re-provision
  --purge-images   Also remove built Docker images (slower rebuild)
  -h, --help       Show help
```

### Common reset scenarios

```bash
# Interactive reset (prompts for "RESET" confirmation)
./scripts/factory-reset.sh

# Wipe and re-provision in one step
./scripts/factory-reset.sh --reinstall

# Non-interactive for CI/automation
./scripts/factory-reset.sh --yes

# Full clean including Docker images, then re-provision
./scripts/factory-reset.sh --purge-images --reinstall
```

See [scripts/README.md](scripts/README.md) for more details and troubleshooting.

---

## What's in this repo

```
droplet-onboard-services/
├── apps/
│   ├── orchestrator/        REST API (Express 4.19 + TypeScript 5.4 + Prisma 5.14)
│   └── web-dashboard/       Admin UI (Next.js 14.2 + React 18.3 + Tailwind CSS 3.4)
├── packages/
│   └── tools-core/          @droplet/tools-core — canonical LLM tool registry (TypeScript + JSON-Schema)
├── services/
│   ├── ai-gateway/          AI provider router (FastAPI 0.110 + LiteLLM 1.30 + Python 3.12)
│   ├── mcp-server/          @droplet/mcp-server — MCP tool surface (stdio + streamable-HTTP, TypeScript)
│   ├── camera-discovery/    ONVIF/RTSP camera auto-discovery (FastAPI + Python 3.12)
│   ├── file-indexer/        File indexer + embedder (watchdog 4.0 + paho-mqtt 2.0 + Python 3.12)
│   ├── routing/             OpenWrt router control (FastAPI + ubus JSON-RPC)
│   └── switch/              Managed-switch control (FastAPI + abstract driver)
├── docker/                  Docker Compose + Nginx + Mosquitto configs
├── tests/                   Integration test suite
├── turbo.json               Turbo 2.0 monorepo build pipeline
└── package.json             npm 10.9 workspace root
```

---

## Architecture

```
Browser / Mobile App                     External MCP clients
        │                                (droplet-local-LLM, Claude Desktop, …)
        ▼                                          │
   ┌─────────┐                                     │
   │  Nginx   │  :80/:443 — reverse proxy (custom Bookworm build, dormant FIPS provider)
   └────┬─────┘                                    │
        │                                          │
   ┌────┼──────────────────────────────────────────┼─────┐
   │    │                  Docker Compose          │     │
   │    ▼                                          ▼     │
   │  ┌──────────────────┐         ┌──────────────────┐ │
   │  │  Web Dashboard    │ :3001   │  MCP Server       │ :9090
   │  └──────────────────┘         │  (HTTP + JWT/RBAC)│ │
   │           │                    └────────┬─────────┘ │
   │  ┌────────▼─────────┐                  │           │
   │  │  Orchestrator     │ :3000  stdio────┘           │  agent loop
   │  └────────┬─────────┘   (in-process child)         │  uses MCP
   │           │                                         │
   │  ┌────────┼──────────────┐                          │
   │  │  ┌───────────────┐   │                           │
   │  │  │  AI Gateway    │  :8000       │  FastAPI 0.110 + LiteLLM 1.30
   │  │  └───────────────┘   │           │  (provider router only — no tool dispatch)
   │  │  ┌───────────────┐   │           │
   │  │  │  Nextcloud     │  :8080       │  nextcloud:29-apache
   │  │  └───────────────┘   │           │
   │  │  ┌───────────────┐   │           │
   │  │  │  File Indexer  │  (daemon)    │  watchdog 4.0 + paho-mqtt 2.0
   │  │  └───────────────┘   │           │
   │  └──────────────────────┘           │
   │                                     │
   │  PostgreSQL 16  Redis 7  Mosquitto 2 │
   └─────────────────────────────────────┘
        │
        ▼  (LAN or PCIe)
   droplet-local-LLM  — Ollama :11434
```

LLM tool dispatch flows through `@droplet/mcp-server` — the orchestrator
agent loop talks to it over stdio (in-process child), and external MCP
clients reach the same server over HTTP with JWT + per-tool RBAC.
Handlers live in `packages/tools-core/`. The AI Gateway is a thin
provider router and never executes tools.

---

## Services

### Orchestrator (`apps/orchestrator/`)

Express + TypeScript API. The central coordination point — proxies to the AI gateway, manages files, handles auth, and drives the file-sync daemon over MQTT.

**Stack:** Express 4.19 · Prisma 5.14 (PostgreSQL 16) · ioredis 5.4 · MQTT.js 5.5 · Zod 3.23 · Pino 9.1 · multer 2.1 · TypeScript 5.4 · tsx 4.11 · Vitest 1.6

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | System status: DB, Redis, AI Gateway + uptime |
| `GET` | `/api/auth/setup` | Check if first-run setup is required |
| `POST` | `/api/auth/setup` | Create the first admin user (one-time) |
| `POST` | `/api/auth/login` | Authenticate and receive an app-password token |
| `POST` | `/api/auth/logout` | Revoke the current token |
| `GET` | `/api/auth/me` | Current user profile |
| `GET` | `/api/auth/users` | List all users (admin) |
| `POST` | `/api/auth/users` | Create a user (admin) |
| `DELETE` | `/api/auth/users/:username` | Delete a user (admin) |
| `GET` | `/api/llm/models` | Available AI models across all providers (cached 30 s) |
| `POST` | `/api/llm/chat` | Stateless chat completion — streaming SSE or JSON |
| `POST` | `/api/llm/sessions` | Create a new chat session |
| `GET` | `/api/llm/sessions` | List sessions (paginated) |
| `GET` | `/api/llm/sessions/:id` | Get session with full message history |
| `PATCH` | `/api/llm/sessions/:id` | Rename a session |
| `DELETE` | `/api/llm/sessions/:id` | Delete a session |
| `POST` | `/api/llm/sessions/:id/chat` | Continue a session (history auto-managed) |
| `POST` | `/api/llm/keys/:provider` | Store a BYOK API key (Fernet-encrypted) |
| `GET` | `/api/llm/keys` | List configured cloud providers |
| `DELETE` | `/api/llm/keys/:provider` | Remove a provider key |
| `GET` | `/api/files` | Browse directory — `?path=/` |
| `GET` | `/api/files/download` | Download a file — `?path=/file.pdf` |
| `POST` | `/api/files/upload` | Upload files (multipart, up to 20 files, 100 MB each) |
| `DELETE` | `/api/files` | Delete file or directory |
| `POST` | `/api/files/mkdir` | Create a directory |
| `POST` | `/api/files/share` | Create a Nextcloud public share link |
| `GET` | `/api/files/shares` | List share links for a path |

The table above is a core sample, not the full surface — the orchestrator has grown to ~75 route modules (`apps/orchestrator/src/routes/`). File operations live in `routes/files.ts` (plus `files-knowledge.ts` / `files-brain.ts` for library and brain surfaces); the old `/api/sync/*` target-sync endpoints no longer exist.

#### Key implementation details

- **Auth middleware** verifies JWT access tokens first and falls back to Nextcloud's OCS API for legacy tokens, caching results for 5 minutes in Redis (ioredis 5.4). Controlled by `AUTH_ENABLED`. Public paths: `/api/health`, `/api/auth/setup`, `/api/auth/login`.
- **Storage backend** is configurable: `STORAGE_BACKEND=legacy` uses the local filesystem; `STORAGE_BACKEND=nextcloud` routes all file operations to Nextcloud 29 via WebDAV with per-user Redis cache keys.
- **File sharing** uses Nextcloud's OCS Share API — share links are created and managed through the orchestrator.
- **File indexing events** flow over MQTT (MQTT.js 5.5) — e.g. `droplet/files/brain/uploaded` tells the file-indexer service to index a chat-attached file.
- **Chat sessions** are Postgres-backed in the orchestrator (`ChatSession` / `ChatMessage` Prisma models via `services/chat-persistence.service.ts`) — not in the AI gateway.

---

### Web Dashboard (`apps/web-dashboard/`)

Next.js 14 App Router admin UI. Requires authentication for all routes; redirects to `/setup` on first run, `/login` otherwise.

**Stack:** Next.js 14.2 · React 18.3 · Tailwind CSS 3.4 · SWR 2.2 · Lucide React 0.378 · TypeScript 5.4 · Vitest 1.6 · Testing Library 15

#### Pages

| Route | Description |
|-------|-------------|
| `/setup` | First-run wizard: welcome → create admin account → done |
| `/login` | Username + password login |
| `/` | Dashboard: device info, service health cards, model availability |
| `/files` | File browser: navigate, upload (drag-and-drop), download, delete, share, preview (images + text), file detail panel |
| `/chat` | AI chat: session sidebar, model selector, streaming token rendering, session create / delete |
| `/settings` | User management (admin), device info, BYOK key management, sync targets, appearance |

#### Auth flow

1. On load, `AuthGate` checks `/api/auth/setup` — redirects to `/setup` if no users exist yet.
2. After setup, the user logs in at `/login` — in production the token travels in HTTP-only cookies (not `localStorage`).
3. All API calls inject `Authorization: Bearer <token>` via `getAuthHeaders()`.
4. On logout, the token is revoked server-side and cleared locally.

---

### AI Gateway (`services/ai-gateway/`)

FastAPI service that unifies local and cloud AI inference behind a single API. The orchestrator proxies all LLM requests here. As of WARP-104 the gateway is a pure provider router — tool dispatch lives in [`services/mcp-server/`](services/mcp-server/) with handlers in [`packages/tools-core/`](packages/tools-core/).

**Stack:** FastAPI 0.110 · uvicorn 0.29 · LiteLLM 1.30 · Pydantic 2.6 · httpx 0.27 · sse-starlette 2.0 · cryptography 42.0 · redis 5.0 · Python 3.12

#### Routing logic

- Model names are routed to providers by prefix/pattern (e.g. `llama*`/`gpt-oss*` → local Ollama, `claude*` → Anthropic via LiteLLM, `gpt*`/`o1`/`o3` → OpenAI via LiteLLM). **Two collision guards (WARP-604):** `gpt-oss` is OpenAI's *open-weights* model served **locally by Ollama**, so it is matched before the cloud `gpt` prefix; and the one configured `LLM_MODEL` always resolves to local Ollama regardless of name. Without these, the local model is misrouted to the cloud provider and blocked by the off-LAN gate (the live chat-failure root cause).
- Provider keys are stored Fernet-encrypted on disk (cryptography 42.0); the key store is read at request time.

#### Endpoints (internal, called by orchestrator)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ai/health` | Gateway health + inference engine reachability |
| `GET` | `/ai/models` | Aggregate model list from all active providers |
| `POST` | `/ai/chat` | Stateless chat completion (streaming + non-streaming) |
| `POST` | `/ai/sessions` | Create session |
| `GET` | `/ai/sessions` | List sessions |
| `GET` | `/ai/sessions/{id}` | Session detail with message history |
| `PATCH` | `/ai/sessions/{id}` | Rename session |
| `DELETE` | `/ai/sessions/{id}` | Delete session |
| `POST` | `/ai/sessions/{id}/chat` | Session-aware chat (history injected automatically) |
| `POST` | `/ai/keys/{provider}` | Store API key |
| `GET` | `/ai/keys` | List configured providers |
| `DELETE` | `/ai/keys/{provider}` | Remove key |

For local testing without inference engine hardware, see [`services/ai-gateway/TESTING.md`](services/ai-gateway/TESTING.md) — includes a mock Ollama server.

---

### File Indexer (`services/file-indexer/`)

Python background service (formerly `file-sync`) that watches, chunks, and embeds files for retrieval. Communicates with the orchestrator over MQTT.

**Stack:** watchdog 4.0 · paho-mqtt 2.0 · Python 3.12

| Component | What it does |
|-----------|-------------|
| `watcher.py` | Real-time file monitoring via watchdog 4.0 |
| `scheduler_service.py` | Periodic scan / re-index scheduling |
| `chunker.py` / `embedder.py` | Splits extracted text and computes embeddings (extractors in `extractors/`) |
| `mqtt_client.py` | Subscribes to indexing triggers (e.g. `droplet/files/brain/uploaded`, `droplet/transcription/run-one`) |
| `db.py` | Writes chunks + embeddings to Postgres |

---

## Infrastructure

All services run as Docker Compose containers behind an Nginx reverse proxy. The full stack is 29 top-level compose services in `docker/docker-compose.yml` (13 default-on, the rest profile-gated); the table below is the core subset only.

| Service | Image | Host port | Notes |
|---------|-------|-----------|-------|
| **gateway** | local build (`docker/nginx/Dockerfile`) | **:80 / :443** | Custom Bookworm-based nginx with the FIPS provider baked dormant (WARP-1021). Single entry point — routes `/` → dashboard, `/api` → orchestrator, `/ai` → ai-gateway |
| **web-dashboard** | local build | — | Internal only (via Nginx). Next.js 14.2, listens :3001 |
| **orchestrator** | local build | — | Internal only (via Nginx). Express 4.19, listens :3000 |
| **ai-gateway** | local build | — | Internal only (via Nginx). FastAPI 0.110, listens :8000 |
| **nextcloud** | `nextcloud:29-apache` | :8080 | Headless file + user backend |
| **db** | `postgres:16-alpine` | — | Internal. Shared by orchestrator, nextcloud, file-indexer |
| **cache** | `redis:7-alpine` | — | Internal. Token cache + response cache (auth required) |
| **broker** | `eclipse-mosquitto:2` | — | Internal. MQTT bus for orchestrator ↔ file-indexer |
| **file-indexer** | local build | — | Background daemon |

Smart-home control runs through the `matter-controller` host-network sidecar (`services/matter-controller/`, ADR-022), fronted by the orchestrator's `/api/matter/*` routes (`apps/orchestrator/src/services/matter.service.ts` is the HTTP client).

App services (orchestrator, web-dashboard, ai-gateway) are **not exposed to the host** — all traffic goes through Nginx on port 80. This avoids conflicts with local dev servers running on the same ports.

**Volumes:** `pgdata`, `filedata` (shared files), `nextcloud-data`, `aikeys` (encrypted API keys).

---

## Running locally

### Prerequisites

| Tool | Minimum version |
|------|----------------|
| Node.js | 20 |
| npm | 10.9 |
| Python | 3.12 |
| Docker Engine | 25 |
| Docker Compose | v2 |

### Quick start — full stack via Docker

```bash
cd droplet-onboard-services
npm install          # installs Turbo 2.0 and workspace deps
npm run dev:docker   # docker compose up --build
```

Open **http://localhost** — Nginx serves the dashboard.
First visit redirects to the setup wizard to create an admin account.

Nextcloud admin UI (optional): **http://localhost:8080**

### Development — individual services

Start shared infrastructure:

```bash
docker compose -f docker/docker-compose.yml up db cache broker nextcloud -d
```

Then in separate terminals:

```bash
# Orchestrator (tsx 4.11 watch mode, port 3000)
cd apps/orchestrator
npx prisma generate && npx prisma migrate deploy
npm run dev

# AI Gateway (uvicorn 0.29 with --reload, port 8000)
cd services/ai-gateway
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
OLLAMA_URL=http://localhost:11434 uvicorn main:app --reload --port 8000

# Web Dashboard (Next.js 14.2 dev server, port 3001)
cd apps/web-dashboard
npm run dev
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://droplet:droplet@db:5432/droplet` | PostgreSQL 16 connection string |
| `REDIS_URL` | `redis://cache:6379` | Redis 7 connection string |
| `MQTT_BROKER` | `mqtt://broker:1883` | Mosquitto 2 broker URL |
| `AI_GATEWAY_URL` | `http://ai-gateway:8000` | AI Gateway internal URL |
| `OLLAMA_URL` | `http://host.docker.internal:11434` (multi-box) / `http://ollama:11434` (single-box) | Canonical chat path: direct to Ollama. ai-gateway resolves `host.docker.internal` via `extra_hosts: host-gateway` in compose. The legacy `:8002/proxy` URL (ollama-manager) still exists as an opt-in observability layer — tool-call JSON repair + circuit breaker + concurrency limits via `/health.limits` — point this var there only if you want those signals and can tolerate the 120 s upstream read timeout that bites heavy agent-loop prompts on CPU. |
| `FILES_ROOT` | `/data/files` | File storage root |
| `STORAGE_BACKEND` | `nextcloud` | `nextcloud` (WebDAV) or `legacy` (local filesystem) |
| `NEXTCLOUD_URL` | `http://nextcloud:80` | Nextcloud 29 internal URL |
| `AUTH_ENABLED` | `true` | Enable token auth middleware |
| `DEVICE_SECRET` | *(required in prod)* | Fernet key for BYOK encryption (cryptography 42.0) |
| `MAX_UPLOAD_SIZE_MB` | `100` | Per-file upload limit |

---

## Security

### FIPS 140-3 cryptographic posture (WARP-229 + WARP-967)

Every Droplet application service container ships with the OpenSSL 3 FIPS provider activation apparatus in place: the shared `docker/openssl-fips.cnf` activation config, a per-runtime boot self-test (`@droplet/fips-selftest` for Node, `services/_shared/fips_selftest.py` for Python), and PR-blocking CI lint that rejects non-FIPS-approved algorithms. The NIST-validated `fips.so` itself (OpenSSL FIPS provider 3.0.9, CMVP certificate #4282) is source-built from a sha256-pinned release tarball and baked into every shipped service image, with `openssl fipsinstall` running the module's KATs at image build time (`docker/fips/`, WARP-967). Runtime activation is a per-customer option, **default OFF** (WARP-318): the operator flips the single `DROPLET_FIPS_MODE` knob via `scripts/setup.sh --fips` / `--no-fips` and setup.sh derives the container env (`OPENSSL_CONF`, `DROPLET_FIPS_REQUIRED`, plus `NODE_OPTIONS` for Node's bundled OpenSSL) — no rebuild. The nginx edge terminates TLS on the same dormant provider with a `DROPLET_FIPS_MODE`-keyed cipher profile (WARP-1021). The full operator/auditor guide — activation, verification commands, the "library has no ciphers" failure mode, and the enforcement scope table — is [`docs/fips.md`](docs/fips.md); a full-stack activation smoke test (`tests/integration/fips-stack.test.sh`, WARP-317) boots the stack under `DROPLET_FIPS_MODE=1` and asserts the provider is active + enforcing per service and the edge TLS is FIPS-restricted. The boot block that test originally surfaced (`LIBRARY_HAS_NO_CIPHERS` in services carrying two OpenSSL instances — the FIPS module cannot be initialized twice from one file, openssl#25553) is fixed by WARP-1063: per-runtime `fips.so` copies, an explicit FIPS TLS posture in the shared config, and positive (approved-digest) boot self-test probes; the smoke test now asserts the full FIPS-enforcing boot. See `docs/fips.md`.

Two single-page references answer the auditor question "what cryptography does this device use?":
- [`docs/security/fips-allowed-algorithms.md`](docs/security/fips-allowed-algorithms.md) — approved algorithms, key sizes, protocol versions.
- [`docs/security/fips-exceptions.md`](docs/security/fips-exceptions.md) — registry of every protocol-mandated non-FIPS escape (RTSP digest auth, WireGuard X25519). Every entry has a documented rationale, owner, and annual review cadence.

The static lint at [`scripts/test-fips.sh`](scripts/test-fips.sh) runs as a required PR check via `.github/workflows/test-fips.yml` on every change to `apps/`, `services/`, `packages/`, `scripts/`, or `docker/`. Adding a new exception requires editing `docs/security/fips-exceptions.md` and gets code-reviewed.

### Internal service-to-service mTLS (WARP-1061)

Every first-party internal HTTP/gRPC hop and the MQTT broker authenticate peers with X.509 client certificates issued by a compose-network-scoped internal CA. Activation is a single knob: `DROPLET_INTERNAL_TLS=1` plus a stack recreate turns mutual TLS on across the internal mesh. Design, per-hop coverage table, and verification commands: [`docs/security/internal-mtls.md`](docs/security/internal-mtls.md).

## Testing

```bash
npm test                       # All workspaces via Turbo 2.0 (parallel)
npm run test:orchestrator      # Orchestrator unit tests (Vitest 1.6)
npm run test:ai-gateway        # AI Gateway pytest suite
npm run test:dashboard         # Dashboard component + API tests (Vitest 1.6)
npm run test:integration       # Full stack integration (Docker Compose)
```

### Test coverage

| Scope | Framework | Location |
|-------|-----------|----------|
| Orchestrator routes | Vitest 1.6 + Supertest 7.0 | `apps/orchestrator/src/__tests__/` |
| Dashboard components + API client | Vitest 1.6 + Testing Library 15 | `apps/web-dashboard/src/__tests__/` |
| AI Gateway endpoints + provider routing | pytest + pytest-asyncio | `services/ai-gateway/tests/` |
| Full stack | Vitest 1.6 + Docker Compose | `tests/` |

---

## Previously-listed gaps — now shipped

| Feature | Status |
|---------|--------|
| Device inventory (`/api/devices`) | Shipped — real Prisma-backed inventory with Redis caching (`apps/orchestrator/src/services/device.service.ts`); device rooms + aliases landed with WARP-1396 |
| OTA update automation | Shipped — `apps/orchestrator/src/routes/updates.ts` + the update agent (`apps/orchestrator/src/services/update-agent/`), exercised end-to-end by `.github/workflows/ota-e2e.yml` |

---

## Related repos

| Repo | Description |
|------|-------------|
| [`droplet-local-LLM`](https://github.com/DropletByWarpLab/droplet-local-LLM) | GPU inference services: Ollama management, model lifecycle, GPU telemetry ([`CLAUDE.md`](https://github.com/DropletByWarpLab/droplet-local-LLM/blob/main/CLAUDE.md)) |
| [`droplet-ios`](https://github.com/DropletByWarpLab/droplet-ios) | Native SwiftUI iOS client (ADR-008) |
| [`droplet-android`](https://github.com/DropletByWarpLab/droplet-android) | Native Kotlin/Compose Android client (ADR-008) |
| [`droplet-windows`](https://github.com/DropletByWarpLab/droplet-windows) | Windows client |
| [`droplet-analytics`](https://github.com/DropletByWarpLab/droplet-analytics) | Off-device operator / fleet-monitoring portal |
| [`droplet-fleet-hq`](https://github.com/DropletByWarpLab/droplet-fleet-hq) | Per-device TLS issuance + addressing (ADR-023 / ADR-025A) |
| [`design-and-style`](https://github.com/DropletByWarpLab/design-and-style) | Canonical design tokens (WARP-1276) |
| [`releases`](https://github.com/DropletByWarpLab/releases) | Signed release manifests (`manifest.json`) + OTA update configs |

---

## Third-party services + licensing

Everything Droplet runs on-device is open-source and free. No paid subscriptions, no cloud accounts, no per-device licensing. The major upstream components and their licenses:

| Component | License | Notes |
|-----------|---------|-------|
| Frigate NVR | MIT | OSS models only — no Frigate Plus / paid model subscription |
| Nextcloud | AGPLv3 | Self-hosted; no Nextcloud paid hub or remote cloud |
| Matter (matter.js) | Apache 2.0 | Native controller in the orchestrator — no Home Assistant, no Nabu Casa |
| OpenWrt | GPLv2 | Routes the cameras VLAN; runs on the router host |
| FastAPI / Express / Next.js / Prisma / SWR / lucide-react / hls.js / web-push | MIT or Apache 2.0 | All OSS, all free |
| LiteLLM | MIT | Multi-provider LLM proxy. The operator brings their own LLM API keys (BYOK) — no Droplet-side subscription |
| PostgreSQL / Redis / Mosquitto | OSS (PostgreSQL / BSD / EPL) | Self-hosted infra |

**The operator's only out-of-pocket cost is their own LLM provider key** (OpenAI / Anthropic / Gemini etc.) if they want cloud LLMs — and that's optional, since the bundled inference engine runs Ollama locally.

---

## License

Proprietary. All rights reserved.
