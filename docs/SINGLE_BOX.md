# Single-box deployment shape

The Droplet stack ships in three deployment shapes from the **same**
repo. Every shape is the production product — there is no "PoC". The
shapes differ only in hardware layout.

| Shape | Hardware | Activation |
|---|---|---|
| **`single-box`** | One x86 host with dGPU (Ollama) + iGPU (Frigate) + MT7922 Wi-Fi card (in-container OpenWrt AP) | `COMPOSE_PROFILES=single-box` in `.env` |
| **`multi-box`** | Separate Jetson Orin (Compute Brick) + Pi 5 OpenWrt router + Lantronix switch | Default — no extra env |
| **`v2-6`** (future) | Custom 9-PCB chassis from `pcb-claude-tool` | TBD as that hardware lands |

This doc covers the **single-box** shape. The other two have their own
deployment docs (or will, when they're up). All shapes share the same
orchestrator, MCP server, ai-gateway, dashboard, voice loop, etc. — the
profile flag just picks which optional services bundle into the host.

## Quick start

On a fresh Ubuntu 24.04 host with an AMD dGPU + iGPU + MT7922 Wi-Fi card:

```bash
git clone git@github.com:DropletByWarpLab/droplet-pi-platform.git
cd droplet-pi-platform
./scripts/setup.sh
```

That's it. The setup script's auto-detection sees the dGPU + iGPU + no
separate Jetson on the LAN, enables single-box mode automatically, and:

- generates per-device secrets in `.env` via `secrets.sh`
- appends the single-box knobs to `.env` (`COMPOSE_PROFILES=linux,single-box`,
  `FRIGATE_RENDER_NODE=/dev/dri/renderD129`, `OLLAMA_URL=http://ollama:11434`,
  `DROPLET_TPM_BACKEND=mock`, `OPENSSL_CONF=`, `DROPLET_FIPS_REQUIRED=false`,
  `LLM_MODEL=gpt-oss:20b`, `OPENWRT_HOST=127.0.0.1`, etc.)
- installs the captured host scripts (`/usr/local/sbin/droplet-openwrt-attach`,
  `/usr/local/sbin/droplet-poc-host-net`) and their systemd units
- auto-enables `droplet.service` so the compose stack starts on boot
- starts 22 containers including `droplet-ollama` and `droplet-openwrt`
- orchestrator's `model-readiness.service.ts` notices `gpt-oss:20b` isn't
  in Ollama yet and fires a background `/api/pull` (~20 min on 100 Mbit/s)

After the model pulls, the dashboard at `https://<host-ip>/` shows
`gpt-oss:20b` in the model list and chat works.

### Forcing the deployment shape

Auto-detection is conservative. Override with:

```bash
./scripts/setup.sh --single-box      # force on (skip detection)
./scripts/setup.sh --no-single-box   # force off (treat as multi-box)
```

Detection sources (in order — see `scripts/lib/single-box.sh::detect_single_box_mode`):

1. **Separate Jetson reachable** (`192.168.50.197:11434` answers
   `/api/version` OR `inference-engine.local:11434` answers) → multi-box,
   NOT single-box.
2. **2+ DRM render nodes + dGPU silicon present** → single-box.
3. **Anything else** → not single-box; setup.sh continues in standard mode.

## What the `single-box` profile activates

From `docker/docker-compose.yml`:

| Service | Image | Purpose |
|---|---|---|
| `ollama` (container_name `droplet-ollama`) | `ollama/ollama:rocm` | Local LLM inference on dGPU. ai-gateway reaches it via compose DNS at `http://ollama:11434`. |
| `openwrt` (container_name `droplet-openwrt`) | `openwrt/rootfs:x86_64-24.10.2` | Router-in-container — Wi-Fi AP (after host-side `droplet-openwrt-attach` moves the MT7922 PHY into the container netns) + WireGuard endpoint. routing service talks to it via `127.0.0.1:8181`. |

Plus 3 named volumes:
- `ollama-data` — model storage
- `openwrt-config` — UCI config
- `openwrt-overlay` — opkg installs persist here

All three are wiped by `./scripts/factory-reset.sh`.

## Always-on customer services (no profile gate)

Some services run on the orchestrator host regardless of deployment shape
(`single-box` AND `multi-box`). They share the host's RAM + SSD with the
profile-gated services above and the orchestrator stack itself.

### Embedded Plane PM stack (WARP-501 / ADR-007)

Spec OQ1 chose dedicated `postgres-pm` + `redis-pm` over sharing with the
orchestrator's main DB so backup granularity (WARP-514) is per-volume and
Plane's Django migrations are quarantined from Prisma's.

| Container | Image | Port | RAM (idle, ~) | RAM (busy P95) |
|---|---|---|---|---|
| `pm-web` | `makeplane/plane-frontend:v0.24.1` | 3000 (internal, Nginx /pm/) | ~120 MB | ~250 MB |
| `pm-api` | `makeplane/plane-backend:v0.24.1` | 8000 (internal) | ~180 MB | ~400 MB |
| `pm-worker` | `makeplane/plane-worker:v0.24.1` | — | ~140 MB | ~300 MB |
| `postgres-pm` | `postgres:15-alpine` | 5432 (internal) | ~30 MB | ~80 MB |
| `redis-pm` | `redis:7-alpine` | 6379 (internal) | ~10 MB | ~25 MB |
| `pm-health` (sidecar) | `services/pm/Dockerfile` | 8090 (internal) | ~25 MB | ~30 MB |

**Total Plane stack footprint at idle: ~500 MB RAM.** Acceptable on every
shipping deployment shape (x86 single-box has 32 GB; Pi-class single-box
has 8 GB minus other services). For Pi-class deployments operating near
RAM ceiling, monitor `pm-worker` first — Celery's per-task memory dominates.

**Storage budget (per spec OQ1 cascade):**
- `postgres-pm-data` — Plane DB. ~10 MB seed, ~50 MB per 1k issues with
  full comment history. Linear growth.
- `pm-attachments-data` — file uploads attached to issues. Operator-cap
  via Plane's per-workspace attachment limit; defaults to 5 MB per upload,
  no global cap. Document customer storage budget in their pilot doc.

**Backup:** Use `scripts/host/pm-backup.sh` (WARP-514). Restore via
`scripts/host/pm-restore.sh`. Both wipe + reload, not merge.

**Reverse-proxy:** Nginx serves Plane at `https://<gateway>/pm/` per
WARP-502. Websocket upgrade headers are forwarded; CSP `frame-ancestors`
(per spec OQ2 iframe decision) tracked in `services/pm/PATCHES.md`.

## Host-level integration (installed by `setup.sh` in single-box mode)

The single-box shape needs three host-level integrations that the compose
stack alone doesn't cover. `scripts/lib/single-box.sh::install_single_box_host_integration`
installs all three when single-box mode is active:

1. **MT7922 → OpenWrt netns attach** — moves the Wi-Fi PHY into the
   container so OpenWrt's hostapd can drive it as an AP.
   `/usr/local/sbin/droplet-openwrt-attach` + `droplet-openwrt-attach.service`.

2. **br-lan host DHCP + Lantronix route** — dedicated dnsmasq on the
   host's `br-lan` so the Lantronix switch + downstream cameras get IPs,
   plus a `/32` route to the switch's mgmt IP.
   `/usr/local/sbin/droplet-poc-host-net` + `droplet-poc-host-net.service`.

3. **Boot-time compose up** — `droplet.service` generated by
   `lib/systemd.sh::install_systemd_service` (auto-enabled in single-box
   mode).

### What gets installed (full path map)

| Target | Source in repo | Notes |
|---|---|---|
| `/usr/local/sbin/droplet-openwrt-attach` | `scripts/host/usr-local-sbin/droplet-openwrt-attach` | `install -m 0755` |
| `/usr/local/sbin/droplet-poc-host-net` | `scripts/host/usr-local-sbin/droplet-poc-host-net` | `install -m 0755` |
| `/etc/systemd/system/droplet-openwrt-attach.service` + `.d/override.conf` | `scripts/host/etc-systemd-system/*` | + `systemctl enable` |
| `/etc/systemd/system/droplet-poc-host-net.service` | same | + `systemctl enable` |
| `/etc/default/droplet-poc-host-net` | `scripts/host/etc-default/droplet-poc-host-net` | as-is |
| `/etc/default/droplet-openwrt-attach` | **Generated** from `scripts/host/etc-default/droplet-openwrt-attach.example` | `DROPLET_AP_PSK` from `.env` (placeholder if absent — setup wizard rotates). Mode 0600. Only written if missing — re-runs preserve a rotated PSK. |
| `/etc/droplet-poc-host-net/lan-dhcp.conf` | `scripts/host/etc-droplet-poc-host-net/lan-dhcp.conf` | as-is |
| `/etc/tmpfiles.d/droplet.conf` | `scripts/host/etc-tmpfiles.d/droplet.conf` | + `systemd-tmpfiles --create` |
| `/etc/avahi/services/droplet.service` | `scripts/host/etc-avahi/services/droplet.service` | mDNS advert (http + https) |
| `/etc/systemd/system/droplet.service` | **Generated** by `lib/systemd.sh::install_systemd_service` | `docker compose up -d` on boot |

> **Naming nit:** the captured scripts and configs still use the
> `droplet-poc-host-net` filename from when they were first written.
> These are tech debt — they ship as `/usr/local/sbin/droplet-poc-host-net`,
> which violates the production-bar rule (no "poc" naming in
> user-facing surfaces). A follow-up rename pass folds them into a
> `droplet-host-net` (or similar) name and updates the systemd unit +
> bind paths in lockstep. Until that lands, the filenames stay as-is
> to avoid breaking the captured-vs-installed parity check.

## Migrating an existing single-box host away from `docker-compose.override.yml`

Hosts that were built before this profile-based unification have a
per-host `docker/docker-compose.override.yml` declaring `ollama` +
`openwrt`. After this PR lands, migrate off the override file:

```bash
ssh droplet@<host-ip>
cd /home/droplet/edge-platform
git pull origin main
# Append single-box knobs to .env (see Quick Start above for the list)
# Then:
mv docker/docker-compose.override.yml docker/docker-compose.override.yml.pre-single-box
docker compose -f docker/docker-compose.yml --env-file .env up -d
# Verify ollama + openwrt still come up via the profile:
docker ps --format '{{.Names}}' | grep -E 'droplet-ollama|droplet-openwrt'
# Once verified, delete the .pre-single-box backup:
rm docker/docker-compose.override.yml.pre-single-box
```

## Why the deployment-shape framing matters

Three concrete reasons this exists as a doc instead of a "PoC mode":

1. **Every box is the shipping product.** The single-box host you're
   provisioning today goes to a customer. Code that ships to it ships
   to the customer. There's no "fix that later before launch" stage.

2. **`docker compose -f docker-compose.yml up -d` is what production
   runs.** No `-f docker-compose.override.yml`, no
   `COMPOSE_FILE=...:...`. The profile flag is the only knob; everything
   else lives in the main compose file.

3. **`factory-reset.sh` knows all the volumes.** Including the
   single-box-specific `ollama-data` / `openwrt-config` /
   `openwrt-overlay`. A clean rebuild produces the same state as a
   first install.

## Gotchas when running compose manually (dev workflow)

`./scripts/setup.sh` writes single-box overrides to `.env` before
starting compose — `FRIGATE_RENDER_NODE=/dev/dri/renderD129`,
`OLLAMA_URL=http://ollama:11434`, etc. If you start the stack
**without** going through `setup.sh` (e.g. `docker compose -f
docker/docker-compose.yml --env-file .env up -d` during iteration on
a host that already has `.env`), the compose defaults take effect for
any var not present in `.env`.

The one with teeth: `FRIGATE_RENDER_NODE` defaults to
`/dev/dri/renderD128` in `docker-compose.yml`. On a single-box host,
`renderD128` is the **dGPU** that Ollama is using. Frigate and Ollama
then fight for the same VAAPI device — Frigate falls back to CPU
decode silently, FPS drops, and `nvidia-smi` / `radeontop` shows
Ollama getting throttled. The visible symptom in the dashboard:
"AI slow" + "camera detection laggy", neither flagged with a clear
error.

If you see those symptoms on a manually-started stack:

```bash
grep -E '^FRIGATE_RENDER_NODE=' .env || \
  echo "FRIGATE_RENDER_NODE=/dev/dri/renderD129" >> .env
docker compose -f docker/docker-compose.yml --env-file .env up -d
```

Or just re-run `./scripts/setup.sh --single-box`, which appends the
single-box knobs idempotently.

A future Phase will add a runtime guard in the orchestrator's health
endpoint that warns when the wrong render node is wired given the
detected deployment shape.

## What's deferred to later phases

- **Phase 3c (cross-repo):** Add `ollama-manager` (from `droplet-local-LLM`)
  as a sidecar service in the single-box profile. Wire orchestrator's
  `model-readiness.service.ts` to prefer the manager's `/models/sync`
  (with VRAM gating + manifest awareness) over Ollama's raw `/api/pull`.
- **Phase 4:** ADR + merge `feat/poc-single-box-rebuild` → `main` and
  delete the branch. Reconciles the dashboard redesign + workspace +
  ADR-004/005 work that's still trapped on the feat branch.
- **Phase 5:** Validation rebuild — `factory-reset.sh` + `setup.sh`
  on a fresh box produces a working appliance with the model pulled,
  AP up, dashboard live, no manual steps.
- **Naming cleanup (separate small PRs):** rename `droplet-poc-host-net`
  → `droplet-host-net` in the captured scripts + systemd units + script
  contents. Rename the captured `scripts/host/docker-compose.poc.yml`
  → `scripts/host/docker-compose.single-box.yml.captured`. Rename
  `feat/poc-single-box-rebuild` branch → `feat/single-box`. Rename
  `droplet-poc-photo-studio` snapshot repo → something deployment-shape-named.
