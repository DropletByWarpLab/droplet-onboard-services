# PoC mode — single-box appliance

The Droplet stack supports two deployment shapes from the **same** repo:

| Mode | Hardware | Activation |
|---|---|---|
| **Production multi-box** | Jetson Orin (Compute Brick) + Pi 5 OpenWrt router + Lantronix switch | Default — no extra env |
| **Single-box PoC** | x86 host with dGPU (Ollama) + iGPU (Frigate) + MT7922 Wi-Fi card | `COMPOSE_PROFILES=poc` (+ `linux`) in `.env` |

The PoC mode runs Ollama and OpenWrt as bundled containers on the same
host as the rest of the control plane, instead of as separate boxes.
Everything else stays the same: the dashboard, orchestrator, MCP server,
ai-gateway, voice loop, file-indexer, etc. all run identically.

## Quick start (single-box PoC)

On a fresh Ubuntu 24.04 host with an AMD dGPU + MT7922 Wi-Fi card:

```bash
git clone git@github.com:DropletByWarpLab/droplet-pi-platform.git
cd droplet-pi-platform

# Tell setup.sh to provision for PoC mode. (Auto-detection planned for Phase 2.)
cat > /tmp/poc.env <<'EOF'
COMPOSE_PROFILES=linux,poc
FRIGATE_RENDER_NODE=/dev/dri/renderD129
JETSON_OLLAMA_URL=http://ollama:11434
DROPLET_TPM_BACKEND=mock
OPENSSL_CONF=
DROPLET_FIPS_REQUIRED=false
OPENWRT_HOST=127.0.0.1
OPENWRT_PORT=8181
OPENWRT_USERNAME=root
EOF
JETSON_OLLAMA_URL=http://ollama:11434 ./scripts/setup.sh

# Setup.sh writes per-device secrets + COMPOSE_PROFILES + the rest of .env.
# Append the PoC knobs (until Phase 2 wires this into setup.sh automatically):
cat /tmp/poc.env >> .env

# Then bring the stack up:
docker compose -f docker/docker-compose.yml --env-file .env up -d
```

22 containers should come up, including `droplet-ollama` and
`droplet-openwrt`. The dashboard is at `https://<host-ip>/` over LAN.

## What the `poc` profile activates

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

## Host-level pieces (NOT yet in setup.sh — Phase 2)

The PoC also needs three host-level integrations that the captured
override file doesn't cover:

1. **MT7922 → OpenWrt netns attach** — moves the Wi-Fi PHY into the
   container so OpenWrt's hostapd can drive it as an AP. Captured as
   `scripts/host/usr-local-sbin/droplet-openwrt-attach` + the systemd
   unit in `scripts/host/etc-systemd-system/droplet-openwrt-attach.service`.

2. **br-lan host DHCP + Lantronix route** — dedicated dnsmasq on the
   host's `br-lan` so the Lantronix switch + downstream cameras get IPs,
   plus a `/32` route to the switch's mgmt IP. Captured as
   `scripts/host/usr-local-sbin/droplet-poc-host-net` + service.

3. **Boot-time compose up** — `scripts/host/etc-systemd-system/droplet.service`
   runs `docker compose up -d` at boot.

Phase 2 (`setup.sh --poc`) will install these from the captured copies.
Until then, install manually on a fresh PoC box:

```bash
sudo cp scripts/host/usr-local-sbin/* /usr/local/sbin/
sudo chmod +x /usr/local/sbin/droplet-openwrt-attach /usr/local/sbin/droplet-poc-host-net
sudo cp scripts/host/etc-systemd-system/*.service /etc/systemd/system/
sudo cp -r scripts/host/etc-systemd-system/droplet-openwrt-attach.service.d /etc/systemd/system/
sudo cp scripts/host/etc-default/droplet-poc-host-net /etc/default/
sudo cp scripts/host/etc-default/droplet-openwrt-attach.example /etc/default/droplet-openwrt-attach
# Edit /etc/default/droplet-openwrt-attach to set the real DROPLET_AP_PSK
sudo mkdir -p /etc/droplet-poc-host-net
sudo cp scripts/host/etc-droplet-poc-host-net/lan-dhcp.conf /etc/droplet-poc-host-net/
sudo cp scripts/host/etc-tmpfiles.d/droplet.conf /etc/tmpfiles.d/
sudo cp scripts/host/etc-avahi/services/droplet.service /etc/avahi/services/
sudo systemctl daemon-reload
sudo systemctl enable --now droplet.service droplet-openwrt-attach.service droplet-poc-host-net.service
```

## Migrating an existing PoC box from `docker-compose.override.yml` to the profile

The current PoC at `192.168.1.87` runs from a per-host
`docker/docker-compose.override.yml` (gitignored). After this Phase 1
PR merges, migrate it onto the `poc` profile to drop the override file:

```bash
ssh droplet@192.168.1.87
cd /home/droplet/edge-platform
git pull origin main
# Append POC knobs to .env (see Quick Start above for the list)
# Then:
mv docker/docker-compose.override.yml docker/docker-compose.override.yml.pre-phase1
docker compose -f docker/docker-compose.yml --env-file .env up -d
# Verify ollama + openwrt still come up:
docker ps --format '{{.Names}}' | grep -E 'droplet-ollama|droplet-openwrt'
# Once verified, delete the .pre-phase1 backup:
rm docker/docker-compose.override.yml.pre-phase1
```

## What's deferred to later phases

- **Phase 2:** Auto-detect PoC mode in setup.sh; install host scripts +
  systemd units when `--poc` is passed; write the right POC knobs to .env.
- **Phase 3:** First-boot orchestrator service queries `ollama-manager`
  (sidecar deployed from `droplet-jetson-ai`) and pulls the manifest
  model automatically — no manual `docker exec ... ollama pull`.
- **Phase 4:** ADR + merge `feat/poc-single-box-rebuild` → `main` once
  the branch divergence is fully resolved by Phases 1-3.
- **Phase 5:** Validation rebuild — `factory-reset.sh + setup.sh --poc`
  on a fresh box produces a working appliance with the model pulled,
  AP up, dashboard live, no manual steps.

## Why not just keep the override file?

The captured `scripts/host/docker-compose.poc.yml` does the same thing,
but as a per-host gitignored file that diverges silently from the repo.
Three concrete problems that drove this Phase 1 unification:

1. **`docker compose -f docker-compose.yml ...` ignored the override**
   (it's auto-loaded only when no `-f` is given). The `droplet.service`
   systemd unit uses `-f`, so on every boot the PoC services would have
   been treated as orphans — they only survived because `restart:
   unless-stopped` kept them alive between recreates.

2. **Repo drift was invisible.** No one reading the repo could see that
   the PoC adds ollama + openwrt. Phase 0 (`scripts/host/`) captured the
   override as documentation; Phase 1 promotes it to canonical config.

3. **`factory-reset.sh` didn't wipe the PoC volumes** (`ollama-data`,
   `openwrt-config`, `openwrt-overlay`). Now it does.
