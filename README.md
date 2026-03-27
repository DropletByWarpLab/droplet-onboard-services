# Droplet Pi-Platform

Control plane for the Droplet edge AI appliance. Runs on a Raspberry Pi and orchestrates local AI inference (via a Jetson companion), cloud AI providers, file management, and device configuration — all accessible through a web dashboard.

## Architecture

```
Browser / Mobile App
        │
        ▼
   ┌─────────┐
   │  Nginx   │  :80  (reverse proxy)
   └────┬─────┘
        │
   ┌────┼──────────────────────┐
   │    │    Docker Compose     │
   │    ▼                       │
   │  ┌───────────────┐        │
   │  │ Web Dashboard  │ :3001  │  Next.js 14
   │  └───────────────┘        │
   │  ┌───────────────┐        │
   │  │  API Server    │ :3000  │  Express + Prisma
   │  └───────┬───────┘        │
   │          │                 │
   │  ┌───────┼───────┐        │
   │  │ ┌───────────┐ │        │
   │  │ │AI Gateway │ │ :8000  │  FastAPI + LiteLLM
   │  │ └───────────┘ │        │
   │  │ ┌───────────┐ │        │
   │  │ │ File Sync │ │        │  Python watchdog daemon
   │  │ └───────────┘ │        │
   │  └───────────────┘        │
   │                            │
   │  PostgreSQL  Redis  MQTT   │
   └────────────────────────────┘
        │
        ▼  (LAN)
   ┌──────────┐
   │  Jetson   │  Ollama :11434
   └──────────┘
```

## What's Inside

```
pi-platform/
├── apps/
│   ├── api-server/          REST API backend (Express + TypeScript + Prisma)
│   └── web-dashboard/       Web UI (Next.js 14 + React + Tailwind)
├── services/
│   ├── ai-gateway/          Unified AI inference router (Python + FastAPI)
│   └── file-sync/           File indexing daemon (Python + watchdog)
├── docker/                  Docker Compose, Nginx, Mosquitto configs
├── turbo.json               Turbo build pipeline
└── package.json             Monorepo root
```

### API Server (`apps/api-server/`)

Express + TypeScript backend serving the web dashboard and mobile app.

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | System status, uptime, dependency health |
| `GET /api/devices` | List registered Droplet devices |
| `GET /api/llm/models` | Available AI models across all providers |
| `POST /api/llm/chat` | Chat completion with streaming SSE |
| `POST /api/llm/keys/:provider` | Store a BYOK API key |
| `GET /api/files?path=/` | Browse directory contents |
| `GET /api/files/download?path=...` | Download a file |
| `POST /api/files/upload?path=/` | Upload files (multipart) |
| `DELETE /api/files?path=...` | Delete a file or directory |
| `POST /api/files/mkdir` | Create a directory |
| `GET /api/sync/targets` | List sync targets |
| `POST /api/sync/targets` | Create a sync target |
| `POST /api/sync/trigger` | Trigger immediate sync |

**Stack:** Express 4, Prisma ORM (PostgreSQL), ioredis, MQTT.js, Zod, Pino, multer.

### Web Dashboard (`apps/web-dashboard/`)

Next.js 14 app with four pages:

- **Dashboard** — Device status, service health, model availability.
- **Files** — File browser with upload, download, drag-and-drop. Breadcrumb navigation.
- **Chat** — AI chat with model selector, streaming token rendering.
- **Settings** — Device info, BYOK key management, sync target configuration.

**Stack:** Next.js App Router, React 18, Tailwind CSS, SWR, Lucide icons.

### AI Gateway (`services/ai-gateway/`)

Python FastAPI service unifying local and cloud AI inference.

- **Provider routing** — Model name prefix resolves to provider (`llama*`→Ollama, `claude*`→Anthropic, `gpt*`→OpenAI).
- **Local inference** — Jetson Ollama over LAN via httpx.
- **Cloud inference** — Anthropic and OpenAI via LiteLLM with streaming.
- **BYOK keys** — Fernet-encrypted filesystem storage.
- **Model registry** — TTL-cached aggregation from all providers.

### File Sync Daemon (`services/file-sync/`)

Python background service that watches configured folders and keeps file metadata in sync.

- **Scanner** — Walks directories, computes SHA-256 hashes, detects new/modified/deleted files.
- **Watcher** — Real-time filesystem monitoring via watchdog with 500ms debounce.
- **Scheduler** — Periodic scans per sync target interval (configurable 5min–24h).
- **MQTT events** — Publishes `droplet/sync/{targetId}/changed` and `/complete` events.

### Infrastructure

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| **Nginx** | `nginx:alpine` | 80 | Reverse proxy with SSE passthrough |
| **PostgreSQL** | `postgres:16-alpine` | 5432 | Application database |
| **Redis** | `redis:7-alpine` | 6379 | Response caching |
| **Mosquitto** | `eclipse-mosquitto:2` | 1883 | MQTT message broker |

### Planned Services (scaffolded)

| Service | Purpose |
|---------|---------|
| `services/routing/` | Network routing and iptables management |
| `services/nvr/` | Network video recording and playback |
| `system/networking/` | Network configuration scripts |
| `system/provisioning/` | First-boot device registration |

---

## Running Locally

### Prerequisites

- Node.js >= 20
- Python >= 3.12
- Docker + Docker Compose

### Quick Start (Docker — everything at once)

```bash
cd pi-platform
npm install
npm run dev:docker
```

Open **http://localhost** in your browser. All 8 containers start behind Nginx.

### Seed the database (first run only)

```bash
docker compose -f docker/docker-compose.yml exec db \
  psql -U droplet -d droplet -c "
    INSERT INTO \"Device\" (id, \"deviceId\", hostname, \"hardwareRev\", \"networkMode\", ip, \"lastSeen\", \"createdAt\", \"updatedAt\")
    VALUES (gen_random_uuid(), 'droplet-dev-001', 'droplet-pi', 'dev', 'dhcp', '192.168.1.100', NOW(), NOW(), NOW())
    ON CONFLICT (\"deviceId\") DO NOTHING;"
```

### Run services individually (for development)

Start infrastructure only:

```bash
docker compose -f docker/docker-compose.yml up db cache broker -d
```

Then in separate terminals:

```bash
# Terminal 1: API Server
cd apps/api-server
npx prisma generate
npx prisma migrate deploy
npm run dev
# → http://localhost:3000

# Terminal 2: AI Gateway
cd services/ai-gateway
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
JETSON_OLLAMA_URL=http://localhost:11434 uvicorn main:app --reload --port 8000
# → http://localhost:8000

# Terminal 3: Web Dashboard
cd apps/web-dashboard
npm run dev
# → http://localhost:3001 (auto-proxies /api to :3000)

# Terminal 4 (optional): File Sync Daemon
cd services/file-sync
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
DATABASE_URL=postgresql://droplet:droplet@localhost:5432/droplet \
MQTT_BROKER=mqtt://localhost:1883 \
FILES_ROOT=/tmp/droplet-files \
python -m src.main
```

### Database management

```bash
cd apps/api-server
npx prisma migrate dev --name my-change   # Create a new migration
npx prisma db seed                         # Seed dev data
npx prisma studio                          # Browse data in browser
```

---

## Environment Variables

| Variable | Default | Used By |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://droplet:droplet@db:5432/droplet` | api-server, file-sync |
| `REDIS_URL` | `redis://cache:6379` | api-server |
| `MQTT_BROKER` | `mqtt://broker:1883` | api-server, file-sync |
| `AI_GATEWAY_URL` | `http://ai-gateway:8000` | api-server |
| `JETSON_OLLAMA_URL` | `http://jetson-ai.local:11434` | ai-gateway |
| `FILES_ROOT` | `/data/files` | api-server, file-sync |
| `DEVICE_SECRET` | `dev-secret-change-in-production` | ai-gateway (BYOK encryption) |
| `MAX_UPLOAD_SIZE_MB` | `100` | api-server |
| `PORT` | `3000` / `3001` | api-server / web-dashboard |

Copy `.env.example` and adjust as needed.

---

## License

Proprietary. All rights reserved.
