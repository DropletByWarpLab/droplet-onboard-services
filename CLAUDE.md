# edge-platform

Control-plane monorepo for the Droplet edge AI appliance. This monorepo contains the orchestrator API, web dashboard, AI gateway proxy, file sync service, and all supporting Docker infrastructure.

> **Note:** "orchestrator" was renamed from "api-server" per design doc alignment. Legacy references may still use the old name.

## Monorepo structure

```
apps/orchestrator/      Express + Prisma — central API and device control
apps/web-dashboard/     Next.js 14 — admin UI
services/ai-gateway/    FastAPI + LiteLLM — model routing proxy
services/routing/       FastAPI — OpenWrt router control via ubus JSON-RPC
services/file-sync/     Python watchdog — file sync daemon
openwrt/                OpenWrt image builder + config overlay for Pi 5 router
docker/                 Nginx, PostgreSQL 16, Redis 7, MQTT, Nextcloud 29, Home Assistant
```

## Tech stack

- **Orchestrator:** Node.js, Express, Prisma ORM, PostgreSQL
- **Web dashboard:** Next.js 14, React
- **AI gateway:** Python, FastAPI, LiteLLM
- **Routing service:** Python, FastAPI, OpenWrt ubus JSON-RPC SDK
- **File sync:** Python, watchdog
- **Infra:** Docker Compose, Nginx, Redis, MQTT (Mosquitto), Nextcloud, Home Assistant

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
| gateway        | :80   | Nginx reverse proxy        |
| web-dashboard  | :3001 |                            |
| orchestrator   | :3000 |                            |
| nextcloud      | :8080 |                            |
| db             | :5432 | PostgreSQL 16              |
| cache          | :6379 | Redis 7                    |
| broker         | :1883 | MQTT                       |
| ai-gateway     | :8000 | FastAPI + LiteLLM          |
| homeassistant  | :8123 | Profile: `full`            |
| routing        | :8080 | OpenWrt control, `full`    |

## Environment variables

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
| `ROUTING_SERVICE_URL`| Routing service endpoint (default `http://localhost:8080`) |
| `OPENWRT_HOST`       | OpenWrt router IP (default `192.168.50.1`)           |
| `OPENWRT_USERNAME`   | OpenWrt rpcd user (default `droplet-ai`)             |
| `OPENWRT_PASSWORD`   | OpenWrt rpcd password                                |
