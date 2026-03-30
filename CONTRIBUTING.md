# Contributing to Droplet Edge Platform

## Architecture

```
edge-platform/                  Turbo monorepo
├── apps/
│   ├── api-server/             Express + TypeScript (port 3000)
│   └── web-dashboard/          Next.js + React (port 3001)
├── services/
│   └── ai-gateway/             Python FastAPI + LiteLLM (port 8000)
├── docker/
│   ├── docker-compose.yml      Full orchestration
│   ├── nginx.conf              Reverse proxy
│   └── mosquitto.conf          MQTT broker
├── tests/                      Integration test suite
└── turbo.json                  Build pipeline
```

## Prerequisites

- **Node.js** >= 20
- **Python** >= 3.12
- **Docker** + Docker Compose
- **npm** (comes with Node.js)

## Quick Start

```bash
# Clone and enter the repo
cd edge-platform

# Install Node.js dependencies (all workspaces)
npm install

# Set up the AI Gateway Python environment
cd services/ai-gateway
python3 -m venv .venv
source .venv/bin/activate    # or .venv\Scripts\activate on Windows
pip install -r requirements-dev.txt
cd ../..

# Generate Prisma client
cd apps/api-server && npx prisma generate && cd ../..

# Run all tests
npm run test
```

## Running Tests

### All unit tests (via Turbo, parallel)

```bash
npm run test
```

This runs tests across all 3 services concurrently:
- **AI Gateway**: 54 pytest tests (schemas, keystore, BYOK, router, endpoints)
- **API Server**: 18 vitest tests (health, devices, LLM routes)
- **Web Dashboard**: 25 vitest tests (components, API client, hooks)

### Individual service tests

```bash
# AI Gateway (Python)
npm run test:ai-gateway
# or directly:
cd services/ai-gateway && source .venv/bin/activate && python -m pytest tests/ -v

# API Server (TypeScript)
npm run test:api-server
# or directly:
cd apps/api-server && npx vitest run

# Web Dashboard (React)
npm run test:dashboard
# or directly:
cd apps/web-dashboard && npx vitest run
```

### Watch mode (auto-rerun on changes)

```bash
cd apps/api-server && npx vitest        # API server
cd apps/web-dashboard && npx vitest     # Dashboard
```

### Test coverage

```bash
# AI Gateway
cd services/ai-gateway
source .venv/bin/activate
python -m pytest tests/ -v --cov=. --cov-report=term-missing

# API Server
cd apps/api-server && npx vitest run --coverage

# Dashboard
cd apps/web-dashboard && npx vitest run --coverage
```

### Integration tests (Docker Compose)

Spins up Postgres, Redis, MQTT, AI Gateway, and API Server in containers, then runs end-to-end HTTP tests:

```bash
npm run test:integration
```

Or manually:

```bash
cd tests
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit
```

## Running Locally

### Option 1: Docker Compose (recommended)

```bash
npm run dev:docker
# Open http://localhost
```

This starts all services:
- Nginx gateway on port 80
- API server on port 3000
- Web dashboard on port 3001
- AI Gateway on port 8000
- PostgreSQL on port 5432
- Redis on port 6379
- MQTT broker on port 1883

### Option 2: Individual services (for development)

Start infrastructure with Docker:

```bash
docker compose -f docker/docker-compose.yml up db cache broker -d
```

Then run services individually:

```bash
# Terminal 1: AI Gateway
cd services/ai-gateway
source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2: API Server
cd apps/api-server
DATABASE_URL=postgresql://droplet:droplet@localhost:5432/droplet \
REDIS_URL=redis://localhost:6379 \
MQTT_BROKER=mqtt://localhost:1883 \
AI_GATEWAY_URL=http://localhost:8000 \
npx tsx watch src/index.ts

# Terminal 3: Web Dashboard
cd apps/web-dashboard
npm run dev
# Open http://localhost:3001
```

The Next.js dev server auto-proxies `/api/*` to localhost:3000 and `/ai/*` to localhost:8000 via `next.config.js` rewrites.

### Database setup

```bash
cd apps/api-server

# Create a migration (first time only)
npx prisma migrate dev --name init

# Apply migrations
npx prisma migrate deploy

# Seed development data
npx tsx prisma/seed.ts

# View database in browser
npx prisma studio
```

## Test Strategy

### Unit Tests

| Service | Framework | Location | What's tested |
|---------|-----------|----------|---------------|
| AI Gateway | pytest + pytest-asyncio | `services/ai-gateway/tests/` | Schemas, keystore encryption, BYOK validation, router resolution, FastAPI endpoints |
| API Server | Vitest + Supertest | `apps/api-server/src/__tests__/` | Express routes, request validation, service mocking |
| Web Dashboard | Vitest + Testing Library | `apps/web-dashboard/src/__tests__/` | React components, API client, user interactions |

**Mocking strategy:**
- API Server tests mock Prisma, Redis, MQTT, and the AI Gateway client
- Dashboard tests mock `fetch`, Next.js navigation, and the API layer
- AI Gateway tests use a real FastAPI test client but mock external services (Jetson, cloud providers)

### Integration Tests

Located in `tests/api.integration.test.ts`. These run against real services in Docker:
- Health endpoint contracts
- Device listing
- Model listing
- Chat request validation
- BYOK key CRUD lifecycle

### What's NOT tested (yet)

- Streaming SSE end-to-end (requires a running Ollama or cloud provider)
- Web dashboard page rendering (add Playwright for E2E later)
- Docker image ARM64 builds

## Project Structure Details

### AI Gateway (`services/ai-gateway/`)

```
main.py                  FastAPI app with /ai/* endpoints
schemas.py               Pydantic models for all requests/responses
router.py                Model-to-provider routing logic
providers/
  base.py                Abstract BaseProvider interface
  ollama_local.py        Jetson Ollama via httpx
  anthropic_cloud.py     Claude via LiteLLM
  openai_cloud.py        GPT via LiteLLM
auth/
  keystore.py            Fernet-encrypted key storage
  byok.py                Key validation and management
models/
  registry.py            TTL-cached model registry
  model_config.py        Static model metadata
tests/                   pytest test suite
```

### API Server (`apps/api-server/`)

```
src/
  index.ts               Entry point (Prisma, Redis, MQTT init)
  app.ts                 Express app factory
  config.ts              Zod-validated environment config
  routes/
    health.ts            GET /api/health
    devices.ts           GET /api/devices
    llm.ts               GET/POST /api/llm/* (proxy to ai-gateway)
  services/
    ai-gateway.client.ts HTTP client for AI Gateway
    device.service.ts    Prisma device queries
    cache.service.ts     Redis wrapper
    mqtt.service.ts      MQTT publish/subscribe
  middleware/
    error-handler.ts     Global error handler
    request-logger.ts    Pino HTTP logging
prisma/
  schema.prisma          Database schema
  seed.ts                Development seed data
```

### Web Dashboard (`apps/web-dashboard/`)

```
src/
  app/
    layout.tsx           Root layout with sidebar
    page.tsx             Dashboard (device status, service health)
    chat/page.tsx        AI chat with streaming
    settings/page.tsx    Provider key management
  components/
    Sidebar.tsx          Navigation sidebar
    StatusCard.tsx       Status indicator card
    ChatMessage.tsx      Chat bubble component
    ChatInput.tsx        Message input with keyboard shortcuts
    ModelSelector.tsx    Model dropdown with provider badge
    ProviderKeyForm.tsx  BYOK key entry form
  lib/
    api.ts               API client functions
    types.ts             Shared TypeScript types
    hooks/
      useChat.ts         Streaming chat state management
      useModels.ts       SWR-powered model fetching
      useDevice.ts       SWR-powered device status
```
