# Box snapshot — 2026-05-24

Live state of the single-box PoC at `192.168.1.87` (`droplet-sys`) at
the time of Phase 0 capture. This is the baseline Phase 1 designs against.

## Host

| | |
|---|---|
| Hostname | `droplet-sys` |
| OS | Ubuntu 24.04, kernel 6.17.0-23-generic (HWE) |
| Uptime | 3 days when captured |
| CPU | AMD Ryzen 7 7700X (8C/16T) |
| dGPU | AMD RDNA4 (PCI id `7590`) — Ollama (rocm) inference |
| iGPU | AMD Raphael — Frigate detector + display (`renderD129` remapped to `renderD128` in the container) |
| RAM | 32 GB |
| Boot disk | 100 GB ext4 LVM on NVMe (74% used) |
| Data drives | `/mnt/droplet/nvr` (sda1 400 GB), `/mnt/droplet/data` (sda2 1.4 TB), `/mnt/droplet/data2` (sdb1 1.8 TB) |
| Wi-Fi AP | MT7922 (mt7921e) on phy0 → wlp14s0 → moved into OpenWrt container netns |

## Repo state on box

- Path: `/home/droplet/edge-platform`
- Remote: `https://github.com/DropletByWarpLab/droplet-onboard-services.git`
  (redirects to `droplet-onboard-services`)
- Branch: `feat/poc-single-box-rebuild`
- HEAD: `acf4479` (`feat(ops-console): autonomous-proposals inbox UI + orchestrator service principal (WARP-399)`)
- Recent: `50bea81 feat(smart-port): plumb build_rtsp_url into accept_camera (WARP-400 §5)`, `9e47d5b fix(mcp-server): match orchestrator's FIPS gate posture (WARP-401)`
- Working tree dirty:
  - `M docker/frigate/config.yml` (stub camera entry — see `_uncommitted-on-box.md`)
  - `?? services/oled-display/tools/repl_upload.py` (CircuitPython REPL upload tool — see `_uncommitted-on-box.md`)

## Containers running (22 total)

Compose project: `droplet`. Config files loaded:
`docker-compose.yml` + `docker-compose.override.yml` (auto-loaded when
`docker compose` runs without `-f`).

| Name | Image | Notes |
|---|---|---|
| `droplet-gateway-1` | (built) | nginx, 80/443 on host |
| `droplet-web-dashboard-1` | (built) | Next.js, internal 3001 |
| `droplet-orchestrator-1` | (built) | Express + Prisma, internal 3000 |
| `droplet-db-1` | `pgvector/pgvector:pg16` | Postgres 16 |
| `droplet-cache-1` | `redis:7-alpine` | Redis 7 |
| `droplet-broker-1` | (mosquitto) | MQTT |
| `droplet-ai-gateway-1` | (built) | FastAPI + LiteLLM + gRPC |
| `droplet-mcp-server` | (built) | MCP, internal 9090 |
| `droplet-file-indexer-1` | (built) | Python watchdog + embedder |
| `droplet-camera-discovery-1` | (built) | ONVIF/RTSP discovery |
| `droplet-switch-1` | (built) | Lantronix driver, internal 8081 |
| `droplet-routing-1` | (built) | Talks to OpenWrt @ 127.0.0.1:8181 |
| `droplet-frigate-1` | `ghcr.io/blakeblackshear/frigate:stable` | NVR, iGPU detect, 0 cameras |
| `droplet-voice-io-1` | (built) | STT/TTS Wyoming client + LLM proxy |
| `droplet-wyoming-faster-whisper-1` | `rhasspy/wyoming-whisper` | STT |
| `droplet-wyoming-piper-1` | `rhasspy/wyoming-piper` | TTS |
| `droplet-oled-display-1` | (built) | OLED/PyPortal driver |
| `droplet-nextcloud-1` | `nextcloud:29-apache` | Nextcloud, internal 80 |
| `droplet-ops-console-1` | (built) | Warp Lab support port, loopback 8089 |
| `droplet-device-identity-svc` | (built) | TPM=mock on this PoC |
| **`droplet-ollama`** | **`ollama/ollama:rocm`** | **Declared in `docker-compose.override.yml` ONLY — not in repo's main compose** |
| **`droplet-openwrt`** | **`openwrt/rootfs:x86_64-24.10.2`** | **Same — override file only. WireGuard port 51820 on host** |

The bottom two are why a `docker compose -f docker-compose.yml ...`
command emits the orphan warning — they're invisible to the main compose
file and only managed when both compose files are loaded together.

## Compose volumes (named)

From `docker-compose.poc.yml`:
- `ollama-data` — model storage (currently 13 GB with `gpt-oss:20b`)
- `openwrt-config` — `/etc/config` (UCI)
- `openwrt-overlay` — `/overlay` (writable overlay for opkg installs)

From `docker-compose.yml` (assumed; factory-reset.sh wipes these):
- `pgdata`, `nextcloud-data`, `aikeys`, `nvrdata`, `matter-data`,
  `frigate-config`, `filedata`, `ops-audit`, `brain-memory-data`,
  `whisper-models`, `piper-voices`

## Data inventory (what would be lost on `factory-reset.sh`)

Live Postgres row counts via `pg_stat_user_tables` (top non-empty):

| Table | Rows |
|---|---|
| `ChatMessage` | 524 |
| `ChatSession` | 262 |
| `Device` | 8 |
| `CommandAuditLog` | 6 |
| `_prisma_migrations` | 1 |

Volume contents:
- `aikeys` — empty (no BYOK provider keys configured)
- `matter-data` — `droplet-controller/` populated (fabric/operational
  creds, NOCs, ACL, reboot counter) — wiping means re-pairing all
  Matter devices via QR scan
- `brain-memory-data` — empty (no notes saved)
- `/mnt/droplet/nvr` — 4 KB (Frigate has no cameras, no recordings)
- `/mnt/droplet/data` — 8 KB (Nextcloud has essentially nothing)

**Practical loss profile if factory-reset goes ahead today:**
- 524 chat messages, 262 sessions (exportable if mattering)
- 8 device pairings (re-pair from app/scan)
- 6 audit log entries (probably fine to lose)
- Matter fabric — costs ~10 min per device to re-pair physically
- Everything else: essentially zero

## Host systemd units enabled (3)

In `/etc/systemd/system/multi-user.target.wants/`:
- `droplet.service` — runs `docker compose up -d` on boot (without `-f`)
- `droplet-openwrt-attach.service` — runs `/usr/local/sbin/droplet-openwrt-attach` after docker
- `droplet-host-net.service` — runs `/usr/local/sbin/droplet-host-net`

## Host scripts (3 in `/usr/local/sbin/`)

- `droplet-openwrt-attach` (20 KB) — current; captured here as `usr-local-sbin/droplet-openwrt-attach`
- `droplet-openwrt-attach.bak` (13 KB) — earlier version kept on box; NOT captured (use git history of the new version instead)
- `droplet-host-net` (2.4 KB) — captured here as `usr-local-sbin/droplet-host-net`

## Host configs (outside compose)

- `/etc/default/droplet-openwrt-attach` → captured as `etc-default/droplet-openwrt-attach.example` (PSK redacted)
- `/etc/default/droplet-host-net` → captured as `etc-default/droplet-host-net`
- `/etc/droplet-host-net/lan-dhcp.conf` → captured as `etc-droplet-host-net/lan-dhcp.conf`
- `/etc/dnsmasq.d/droplet-ap.conf` + `.pre-bridge` → captured as `etc-dnsmasq.d/*` (LEGACY — superseded by `droplet-host-net.service` + `etc-droplet-host-net/lan-dhcp.conf`; system dnsmasq is disabled)
- `/etc/tmpfiles.d/droplet.conf` → captured as `etc-tmpfiles.d/droplet.conf`
- `/etc/avahi/services/droplet.service` → captured as `etc-avahi/services/droplet.service` (capture RETIRED, WARP-2576: `_write_avahi_service_file()` in `scripts/lib/local-dns.sh` later became the writer and overwrote the installed copy on every run, so the captured file is no longer in the tree)

## What this means for "rebuild from scratch"

A naive `factory-reset.sh + setup.sh` today produces a strictly LESS
functional state than the current box:

| Capability | Today | After naive rebuild |
|---|---|---|
| 22 compose services | ✅ | ✅ (20 — missing ollama, openwrt) |
| Ollama with rocm + dGPU | ✅ | ❌ (no `docker-compose.override.yml` in repo) |
| OpenWrt container + AP | ✅ | ❌ (same) |
| `gpt-oss:20b` model | ✅ | ❌ (no model pulled, manifest declares only `llama3.2:3b`) |
| Host AP wired (MT7922 in netns) | ✅ | ❌ (no host script installed) |
| br-lan DHCP for cameras | ✅ | ❌ (no host script installed) |
| /32 route to Lantronix switch | ✅ | ❌ (same) |
| `OLLAMA_URL` correct | ✅ (manually fixed; PR #247 also fixes the default) | After PR #247 merges: ✅ default; without: ❌ |
| Frigate iGPU remap (renderD129→128) | ✅ (in override) | ❌ |
| FIPS disabled for consumer Ryzen | ✅ (in override) | ❌ |
| TPM=mock | ✅ (in override) | ❌ |
| Boot-time `docker compose up` | ✅ (droplet.service) | ❌ (setup.sh has `--systemd` but installs a different unit shape) |

**Phase 0 captures every row in the "Today ✅" column** so Phase 1 can design how each one gets into the repo properly.
