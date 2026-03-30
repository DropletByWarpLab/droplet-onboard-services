# Droplet Edge Platform

Control plane for the Droplet edge AI appliance. Orchestrates local AI inference (via the inference engine), cloud AI providers, file management through Nextcloud, and device configuration — all accessible through a web dashboard.

## Architecture

```
Browser / Mobile App
        │
        ▼
   ┌─────────┐
   │  Nginx   │  :80  (reverse proxy)
   └────┬─────┘
        │
   ┌────┼───────────────────────────┐
   │    │      Docker Compose        │
   │    ▼                            │
   │  ┌─────────────────┐           │
   │  │  Web Dashboard   │  :3001   │  Next.js 14
   │  └─────────────────┘           │
   │  ┌─────────────────┐           │
   │  │  Orchestrator    │  :3000   │  Express + Prisma
   │  └────────┬────────┘           │
   │           │                     │
   │  ┌────────┼──────────┐         │
   │  │  ┌─────────────┐  │         │
   │  │  │ AI Gateway   │  │ :8000  │  FastAPI + LiteLLM
   │  │  └─────────────┘  │         │
   │  │  ┌─────────────┐  │         │
   │  │  │ Nextcloud    │  │ :8080  │  Headless file backend
   │  │  └─────────────┘  │         │
   │  └────────────────────┘         │
   │                                 │
   │  PostgreSQL  Redis  MQTT        │
   └─────────────────────────────────┘
        │
        ▼  (LAN)
   ┌──────────┐
   │  Jetson   │  Ollama :11434
   └──────────┘
```

## What's Inside

```
edge-platform/
├── apps/
│   ├── orchestrator/        REST API backend (Express + TypeScript + Prisma)
│   └── web-dashboard/       Web UI (Next.js 14 + React + Tailwind)
├── services/
│   ├── ai-gateway/          Unified AI inference router (Python + FastAPI)
│   └── file-sync/           File indexing daemon (Python + watchdog)
├── docker/                  Docker Compose, Nginx, Mosquitto configs
├── turbo.json               Turbo build pipeline
└── package.json             Monorepo root
```

### Orchestrator (`apps/orchestrator/`)

Express + TypeScript backend serving the web dashboard and mobile app. Central coordination point for all services.

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | System status, uptime, dependency health |
| `GET /api/devices` | List registered Droplet devices |
| `GET /api/llm/models` | Available AI models across all providers |
| `POST /api/llm/chat` | Chat completion with streaming SSE |
| `POST /api/llm/keys/:provider` | Store a BYOK API key |
| `GET /api/files?path=/` | Browse directory contents |
| `POST /api/files/upload?path=/` | Upload files (multipart) |
| `POST /api/files/mkdir` | Create a directory |
| `GET /api/sync/targets` | List sync targets |
| `POST /api/sync/trigger` | Trigger immediate sync |

**Stack:** Express 4, Prisma ORM (PostgreSQL), ioredis, MQTT.js, Zod, Pino, multer.

**Feature flags:** `STORAGE_BACKEND` (`legacy`|`nextcloud`), `AUTH_ENABLED`, `NEXTCLOUD_URL`.

### Web Dashboard (`apps/web-dashboard/`)

Next.js 14 app with four pages:

- **Dashboard** — Device status, service health, model availability.
- **Files** — File browser with upload, download, drag-and-drop, breadcrumb navigation.
- **Chat** — AI chat with model selector, streaming token rendering.
- **Settings** — Device info, BYOK key management, sync target configuration, appearance (light/dark mode).

**Stack:** Next.js App Router, React 18, Tailwind CSS, SWR, Lucide icons.

### AI Gateway (`services/ai-gateway/`)

Python FastAPI service unifying local and cloud AI inference.

- **Provider routing** — Model name prefix resolves to provider (`llama*`→Ollama, `claude*`→Anthropic, `gpt*`→OpenAI).
- **Local inference** — Jetson Ollama over LAN via httpx.
- **Cloud inference** — Anthropic and OpenAI via LiteLLM with streaming.
- **BYOK keys** — Fernet-encrypted filesystem storage.

### Infrastructure

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| **Nginx** | `nginx:alpine` | 80 | Reverse proxy with SSE passthrough |
| **Nextcloud** | `nextcloud:29-apache` | 8080 | Headless file/auth backend |
| **PostgreSQL** | `postgres:16-alpine` | 5432 | Application database |
| **Redis** | `redis:7-alpine` | 6379 | Response caching |
| **Mosquitto** | `eclipse-mosquitto:2` | 1883 | MQTT message broker |
| **Home Assistant** | `ghcr.io/home-assistant/...` | 8123 | Smart home hub (profile: full) |

---

## Running Locally

### Prerequisites

- Node.js >= 20
- Python >= 3.12
- Docker + Docker Compose

### Quick Start (Docker — everything at once)

```bash
cd edge-platform
npm install
npm run dev:docker
```

Open **http://localhost** in your browser. All containers start behind Nginx.
Nextcloud is available at **http://localhost:8080** (admin/admin).

### Run services individually (for development)

Start infrastructure only:

```bash
docker compose -f docker/docker-compose.yml up db cache broker -d
```

Then in separate terminals:

```bash
# Orchestrator
cd apps/orchestrator && npx prisma generate && npx prisma migrate deploy && npm run dev

# AI Gateway
cd services/ai-gateway && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && uvicorn main:app --reload --port 8000

# Web Dashboard
cd apps/web-dashboard && npm run dev
```

### Testing

```bash
npm test                     # All tests via Turbo
npm run test:orchestrator    # Orchestrator unit tests (48 tests)
npm run test:ai-gateway      # AI Gateway pytest (54 tests)
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://droplet:droplet@db:5432/droplet` | PostgreSQL |
| `REDIS_URL` | `redis://cache:6379` | Redis cache |
| `MQTT_BROKER` | `mqtt://broker:1883` | MQTT broker |
| `AI_GATEWAY_URL` | `http://ai-gateway:8000` | AI Gateway |
| `JETSON_OLLAMA_URL` | `http://inference-engine.local:11434` | Inference engine Ollama endpoint |
| `FILES_ROOT` | `.data/files` (dev) / `/data/files` (Docker) | File storage root |
| `STORAGE_BACKEND` | `legacy` | `legacy` or `nextcloud` |
| `NEXTCLOUD_URL` | `http://localhost:8080` | Nextcloud instance |
| `AUTH_ENABLED` | `false` | Enable Nextcloud OAuth2 auth |
| `DEVICE_SECRET` | `dev-secret-change-in-production` | BYOK encryption key |
| `MAX_UPLOAD_SIZE_MB` | `100` | Upload size limit |

---

## Related Repos

| Repo | Purpose |
|------|---------|
| [`inference-engine`](https://github.com/Nahast/droplet-inference-engine) | GPU inference services (Ollama, model management, GPU scheduler) |
| [`mobile-app`](https://github.com/Nahast/droplet-mobile-app) | Mobile client (React Native / Flutter) |
| [`shared-api`](https://github.com/Nahast/droplet-shared-api) | OpenAPI specs and generated clients |
| [`releases`](https://github.com/Nahast/droplet-releases) | Factory manifests and OTA configs |

## License

Proprietary. All rights reserved.
