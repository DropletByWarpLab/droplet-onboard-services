# Droplet Pi-Platform

Control plane for the Droplet edge AI appliance. Runs on a Raspberry Pi and orchestrates local AI inference (via a Jetson companion), cloud AI providers, device management, and a web-based dashboard.

## What's Inside

```
pi-platform/
├── apps/
│   ├── api-server/          REST API backend (Express + TypeScript)
│   └── web-dashboard/       Web UI (Next.js + React + Tailwind)
├── services/
│   └── ai-gateway/          Unified AI inference router (Python + FastAPI)
├── docker/                  Docker Compose, Nginx, Mosquitto configs
├── tests/                   Integration test suite
├── turbo.json               Turbo build pipeline
└── CONTRIBUTING.md          Full developer guide
```

### API Server (`apps/api-server/`)

Express + TypeScript backend that serves as the main entry point for the mobile app and web dashboard.

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | System status, uptime, and dependency health (DB, Redis, AI Gateway) |
| `GET /api/devices` | List registered Droplet devices |
| `GET /api/llm/models` | Available AI models across all providers |
| `POST /api/llm/chat` | Chat completion with streaming SSE support |
| `POST /api/llm/keys/:provider` | Store a BYOK API key for a cloud provider |
| `GET /api/llm/keys` | List which providers have configured keys |
| `DELETE /api/llm/keys/:provider` | Remove a stored API key |

**Stack:** Express 4, Prisma ORM (PostgreSQL), ioredis, MQTT.js, Zod validation, Pino logging.

### Web Dashboard (`apps/web-dashboard/`)

Next.js 14 app with three pages:

- **Dashboard** — Device status cards, service health indicators, model availability overview.
- **Chat** — Full AI chat interface with model selector, streaming token rendering, and conversation history.
- **Settings** — Device info display, BYOK key management for Anthropic and OpenAI, Jetson connection status.

**Stack:** Next.js App Router, React 18, Tailwind CSS, SWR for data fetching, Lucide icons.

### AI Gateway (`services/ai-gateway/`)

Python FastAPI service that unifies local and cloud AI inference behind a single API.

- **Provider routing** — Automatically resolves model names to providers (`llama*` and `mistral*` to local Ollama, `claude*` to Anthropic, `gpt*` to OpenAI). Explicit provider override supported.
- **Local inference** — Connects to a Jetson running Ollama over LAN via `httpx`.
- **Cloud inference** — Routes to Anthropic and OpenAI via LiteLLM with streaming support.
- **BYOK key management** — Fernet-encrypted filesystem storage for user API keys.
- **Model registry** — TTL-cached aggregation of models from all providers.

**Stack:** FastAPI, LiteLLM, httpx, Pydantic v2, cryptography (Fernet).

### Infrastructure

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| **Nginx** | `nginx:alpine` | 80 | Reverse proxy with SSE passthrough |
| **PostgreSQL** | `postgres:16-alpine` | 5432 | Application database |
| **Redis** | `redis:7-alpine` | 6379 | Response caching |
| **Mosquitto** | `eclipse-mosquitto:2` | 1883 | MQTT message broker |

### Planned Services (scaffolded, not yet implemented)

| Service | Purpose |
|---------|---------|
| `services/routing/` | Network routing and iptables management |
| `services/file-sync/` | Local cloud file synchronization |
| `services/nvr/` | Network video recording and playback |
| `system/networking/` | Network configuration scripts |
| `system/provisioning/` | First-boot device registration |

---

## Running Locally

### Prerequisites

- Node.js >= 20
- Python >= 3.12
- Docker + Docker Compose

### Setup

```bash
# Install all Node.js dependencies
npm install

# Set up Python environment for the AI Gateway
cd services/ai-gateway
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
cd ../..

# Generate the Prisma client
cd apps/api-server && npx prisma generate && cd ../..
```

### Option 1 — Docker Compose (everything at once)

```bash
npm run dev:docker
```

Open [http://localhost](http://localhost). All services start behind an Nginx reverse proxy.

### Option 2 — Run services individually

Start the infrastructure containers:

```bash
docker compose -f docker/docker-compose.yml up db cache broker -d
```

Then in separate terminals:

```bash
# AI Gateway
cd services/ai-gateway && source .venv/bin/activate
uvicorn main:app --port 8000 --reload

# API Server
cd apps/api-server
DATABASE_URL=postgresql://droplet:droplet@localhost:5432/droplet \
REDIS_URL=redis://localhost:6379 \
AI_GATEWAY_URL=http://localhost:8000 \
npx tsx watch src/index.ts

# Web Dashboard
cd apps/web-dashboard && npm run dev
```

Open [http://localhost:3001](http://localhost:3001). The Next.js dev server proxies API calls automatically.

### Database

```bash
cd apps/api-server
npx prisma migrate dev --name init   # Create initial migration
npx tsx prisma/seed.ts               # Seed dev data
npx prisma studio                    # Browse data in browser
```

---

## Testing

Run all 97 unit tests across the three services in parallel:

```bash
npm run test
```

| Command | What it runs |
|---------|-------------|
| `npm run test` | All unit tests via Turbo (parallel) |
| `npm run test:ai-gateway` | 54 pytest tests (schemas, keystore, router, endpoints) |
| `npm run test:api-server` | 18 Vitest tests (health, devices, LLM routes) |
| `npm run test:dashboard` | 25 Vitest tests (components, API client) |
| `npm run test:integration` | Docker Compose end-to-end tests |

See [CONTRIBUTING.md](./CONTRIBUTING.md) for watch mode, coverage reports, and the full test strategy.

---

## Environment Variables

| Variable | Default | Used by |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://droplet:droplet@db:5432/droplet` | API Server |
| `REDIS_URL` | `redis://cache:6379` | API Server, AI Gateway |
| `MQTT_BROKER` | `mqtt://broker:1883` | API Server, AI Gateway |
| `AI_GATEWAY_URL` | `http://ai-gateway:8000` | API Server |
| `JETSON_OLLAMA_URL` | `http://jetson-ai.local:11434` | AI Gateway |
| `DEVICE_SECRET` | `dev-secret-change-in-production` | AI Gateway (BYOK encryption) |

Copy `.env.example` and adjust as needed.

---

## License

Proprietary. All rights reserved.
