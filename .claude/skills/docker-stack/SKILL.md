---
name: docker-stack
description: |
  Reference for the Docker Compose stack: per-service ports/profiles
  table (all 34 services), COMPOSE_PROFILES behavior per deployment
  shape, and the update-.env-on-a-running-stack procedure. Use when
  starting/restarting services, editing .env on a deployed stack,
  wondering which profile a service belongs to, why a service didn't
  start on macOS, or why a container ignores a changed env var.
---

# Docker stack reference

## Services (34 in `docker/docker-compose.yml`)

| Service        | Port  | Profile | Notes                      |
|----------------|-------|---------|----------------------------|
| gateway        | :80, :443 | — | Nginx reverse proxy — single host entry point |
| web-dashboard  | —     | — | Proxied at `/`                            |
| orchestrator   | —     | — | Proxied at `/api/`                        |
| device-identity-svc | — | — | Device identity (TPM-sealed, WARP-230)  |
| mcp-server     | —     | — | `@droplet/mcp-server` — streamable-HTTP for external MCP clients |
| nextcloud      | —     | — | Proxied at `/nextcloud/` (no host port — collided with routing) |
| db             | —     | — | PostgreSQL 16, internal only              |
| cache          | —     | — | Redis 7, internal only                    |
| broker         | —     | — | MQTT, internal only                       |
| ai-gateway     | —     | — | Proxied at `/ai/`                         |
| file-indexer   | —     | — | Filesystem indexer + embedder             |
| routing        | :8080 | — | OpenWrt control, host network             |
| frigate        | —     | `linux` | NVR + AI detection (needs `/dev/dri/renderD128`) |
| voice-io       | —     | `linux` | Voice loop (wake → STT → orchestrator agent loop → TTS; needs `/dev/snd`) |
| wyoming-faster-whisper | — | `linux` | STT backend for the voice loop     |
| wyoming-piper  | —     | `linux` | TTS backend for the voice loop            |
| oled-display   | —     | `display` | PyPortal screen service (sim backend when no `/dev/ttyACM*`) |
| switch         | :8081 | `full`, `single-box` | Managed switch control       |
| camera-discovery | —   | `full`, `single-box` | ONVIF/RTSP scanner           |
| email-indexer  | —     | `full` | Mailbox indexer for RAG                    |
| ollama         | 127.0.0.1:11434 | `single-box` | Local LLM inference on the single-box shape |
| openwrt        | 127.0.0.1:8181→80 | `single-box` | In-container OpenWrt (router UI/ubus) |
| pm-web / pm-api / pm-worker / pm-beat / pm-migrator / pm-health | — | `pm` | Embedded Plane PM stack (ADR-010), proxied at `/pm` |
| postgres-pm / redis-pm / pm-mq / pm-minio | — | `pm` | Plane's dedicated datastores (separate from db/cache, OQ1) |
| rag-eval       | —     | `eval` | RAG evaluation harness                     |
| ops-console    | —     | `ops`  | Operator console                           |

## Profiles (`COMPOSE_PROFILES`)

Profiles: `linux`, `display`, `full`, `single-box`, `pm`, `eval`, `ops`.
`setup.sh` writes `COMPOSE_PROFILES` into `.env`:

- **Linux:** `linux,display` — Frigate, the voice pipeline, and
  oled-display start with the default stack (PyPortal absence is a
  no-op via the sim backend).
- **macOS:** empty — the GPU/audio device mounts never trip.
- **Single-box shape (what ships):** setup auto-detects the hardware
  and merges `single-box` into `COMPOSE_PROFILES`
  (`scripts/lib/single-box.sh`), so **ollama, openwrt, switch, and
  camera-discovery are default-on** there (with
  `SWITCH_AUTOPROVISION=1`).
- **Other shapes:** switch + camera-discovery stay opt-in via the
  `full` profile (real hardware + operator-supplied credentials — a
  fresh install shouldn't scan the LAN or hit a missing switch).
  `full` also enables email-indexer.
- `pm` enables the embedded Plane stack, `eval` the RAG evaluation
  harness, `ops` the operator console.

## Updating `.env` on a running stack

`docker restart <container>` does **not** re-read the env_file. Containers
keep the env they were originally booted with. After editing `.env`, recreate
the affected services. This applies to resource-limit changes too — editing
`ORCHESTRATOR_MEM_LIMIT` in `.env` requires `--force-recreate orchestrator` to
take effect. See [`docs/ADR-021-container-resource-limits.md`](../../../docs/ADR-021-container-resource-limits.md)
for the per-service RAM budget and tuning guidance.

```bash
docker compose -f docker/docker-compose.yml --env-file .env up -d --force-recreate <service>
```

This caught us once on `FRIGATE_CAMERA_*_PASSWORD` — `.env` had the right
value but Frigate's container still had the stale one. `scripts/test-security.sh`
now also blocks URL-encoded camera passwords (Frigate ffmpeg doesn't decode
percent-escapes; store raw `Droplet123!`, not `Droplet123%21`).
