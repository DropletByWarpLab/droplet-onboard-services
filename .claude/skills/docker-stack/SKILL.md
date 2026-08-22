---
name: docker-stack
description: |
  Reference for the Docker Compose stack: per-service ports/profiles
  table (all 32 services), COMPOSE_PROFILES behavior per deployment
  shape, and the update-.env-on-a-running-stack procedure. Use when
  starting/restarting services, editing .env on a deployed stack,
  wondering which profile a service belongs to, why a service didn't
  start on macOS, or why a container ignores a changed env var.
---

# Docker stack reference

## Services (32 in `docker/docker-compose.yml`)

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
| samba          | :445 (host net) | `linux` | SMB network drive — the "Droplet" folder in Windows Explorer / macOS Finder (wsdd2 discovery; shares the `droplet-share` volume, also mounted in Nextcloud as `/Droplet`) |
| frigate        | —     | `linux` | NVR + AI detection (needs `/dev/dri/renderD128`) |
| voice-io       | —     | `linux` | Voice loop (wake → STT → orchestrator agent loop → TTS; needs `/dev/snd`) |
| wyoming-faster-whisper | — | `linux` | STT backend for the voice loop     |
| wyoming-piper  | —     | `linux` | TTS backend for the voice loop            |
| oled-display   | —     | `display` | PyPortal screen service (sim backend when no `/dev/ttyACM*`) |
| switch         | :8081 | `full`, `single-box` | Managed switch control       |
| camera-discovery | —   | `full`, `single-box` | ONVIF/RTSP scanner           |
| web-fetch      | —     | `web`  | Ambient-data fetcher (weather/rates) for LLM tools (WARP-1436) |
| erp-sql-bridge | —     | `erp`  | Direct-SQL Eaglesoft bridge (unixODBC + pyodbc); needs an operator-vendored SAP client (WARP-1106) |
| email-indexer  | —     | `full` | Mailbox indexer for RAG                    |
| ollama         | 127.0.0.1:11434 | `single-box` | Local LLM inference on the single-box shape |
| openwrt        | 127.0.0.1:8181→80 | `single-box` | In-container OpenWrt (router UI/ubus) |
| rag-eval       | —     | `eval` | RAG evaluation harness                     |
| ops-console    | —     | `ops`  | Operator console                           |

## Profiles (`COMPOSE_PROFILES`)

Profiles: `linux`, `display`, `full`, `single-box`, `eval`, `ops`, `erp`.
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
- `eval` enables the RAG evaluation harness, `ops` the operator console.

## Running the stack locally on macOS (override file)

The tracked `docker/docker-compose.yml` targets the Linux prototype —
real TPM (`/dev/tpm0`), USB automount, host paths. On macOS, Docker
Desktop errors on the TPM device mount instead of skipping it, so the
stack needs an **untracked** `docker/docker-compose.override.yml`:

- `devices: !reset []` for `device-identity-svc` (no `/dev/tpm0`);
  `.env` must pin `DROPLET_TPM_BACKEND=mock`.
- Remap host-path binds to named volumes: `/var/lib/droplet/tpm`,
  `/var/run/droplet` (shared with the orchestrator), and Nextcloud's
  `/mnt/droplet` USB-automount bind.
- Optional: enable the claim gate for local testing
  (`DROPLET_CLAIM_GATE_ENABLED=1` + a pinned claim code in the
  orchestrator's `environment:` — keep the code value out of tracked
  files).

Start with **both** files (plain `npm run dev:docker` passes only the
main file and fails on the TPM device):

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.override.yml --env-file .env up -d
```

(or run compose from `docker/`, where the override auto-loads).

Also required locally: `data/secrets/audit.key` — 32 raw bytes, mode
600 (WARP-456 audit signing; generated per
`scripts/lib/secrets.sh:sync_audit_signing_key`). Without it the
orchestrator crash-loops at boot. **Never delete or commit it** —
HMAC audit-chain continuity depends on it. Both the override and the
key are deliberately untracked; local fixes go in the override, never
in tracked files.

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

(On macOS include the override too — `-f docker/docker-compose.yml -f
docker/docker-compose.override.yml` — or the recreate strips the local
TPM/volume adaptations. See the macOS section above.)

This caught us once on `FRIGATE_CAMERA_*_PASSWORD` — `.env` had the right
value but Frigate's container still had the stale one. `scripts/test-security.sh`
now also blocks URL-encoded camera passwords (Frigate ffmpeg doesn't decode
percent-escapes; store raw `Droplet123!`, not `Droplet123%21`).
