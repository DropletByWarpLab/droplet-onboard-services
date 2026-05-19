#!/usr/bin/env bash
# Deploy the redesigned front-panel TFT to the POC box.
#
# Run this ON the POC box (Jetson) after `git pull`-ing the redesign
# branch. It does three things:
#
#   1. Rebuilds + restarts the device-bridge + oled-display containers
#      so the new render code + ECC_H QR encoder are live.
#   2. Drops the redesigned firmware (boot.py + code.py) onto the
#      PyPortal's CIRCUITPY mount, which triggers an automatic reload
#      on the device. The new editorial-numeric layout appears on the
#      screen within ~5 s.
#   3. Tail-checks the oled-display container logs for "Using PyPortal"
#      so you know the host re-discovered the panel after the firmware
#      reboot.
#
# Run from anywhere; it cd's to the repo root.
#
# Override the CIRCUITPY path if it mounts elsewhere on your host:
#   CIRCUITPY=/media/droplet/CIRCUITPY ./deploy-to-poc.sh

set -euo pipefail

# Locate the repo root (we sit at services/oled-display/tools/).
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

CIRCUITPY="${CIRCUITPY:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker/docker-compose.yml}"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

cd "$REPO_ROOT"
bold ">>> Repo: $REPO_ROOT"
bold ">>> Branch: $(git rev-parse --abbrev-ref HEAD)  HEAD: $(git rev-parse --short HEAD)"
echo

# -------------------------------------------------------------------
# 1. Containers
# -------------------------------------------------------------------
bold ">>> Rebuilding oled-display + device-bridge"
docker compose -p docker -f "$COMPOSE_FILE" --profile full \
    up -d --build oled-display device-bridge
ok "Containers up"
echo

# -------------------------------------------------------------------
# 2. PyPortal firmware
# -------------------------------------------------------------------
if [[ -z "$CIRCUITPY" ]]; then
    # Try the usual mount points. /media/$USER/CIRCUITPY is the systemd
    # auto-mount; /run/media/$USER/CIRCUITPY is the alternative on some
    # distros.
    for cand in "/media/$USER/CIRCUITPY" "/run/media/$USER/CIRCUITPY" "/media/CIRCUITPY"; do
        if [[ -d "$cand" ]]; then
            CIRCUITPY="$cand"
            break
        fi
    done
fi

if [[ -z "$CIRCUITPY" || ! -d "$CIRCUITPY" ]]; then
    warn "CIRCUITPY mount not found — skipping firmware flash."
    warn "Plug the PyPortal in via USB, wait for the CIRCUITPY drive to"
    warn "appear, then re-run with CIRCUITPY=/path/to/mount."
else
    bold ">>> Flashing PyPortal firmware -> $CIRCUITPY"
    cp services/oled-display/pyportal/boot.py "$CIRCUITPY/boot.py"
    cp services/oled-display/pyportal/code.py "$CIRCUITPY/code.py"
    sync
    ok "boot.py + code.py copied — device will auto-reload"
fi
echo

# -------------------------------------------------------------------
# 3. Verify the host reconnected
# -------------------------------------------------------------------
bold ">>> Waiting 6 s for the host to re-probe the PyPortal..."
sleep 6
LOGS="$(docker compose -p docker -f "$COMPOSE_FILE" logs --tail 80 oled-display 2>&1 || true)"
if echo "$LOGS" | grep -q "TFT initialised via PyPortal"; then
    ok "host re-probed the PyPortal"
else
    warn "Did not see 'TFT initialised via PyPortal' in the last 80 log lines."
    warn "Check the panel — if it's showing the new design, you're good."
    warn "Full logs: docker compose -p docker -f $COMPOSE_FILE logs -f oled-display"
fi
echo

bold ">>> Quick sanity hits"
dim "  Preview PNG: docker compose -p docker -f $COMPOSE_FILE exec oled-display cat /tmp/tft_preview.png > /tmp/check.png"
dim "  Force idle:  curl -s -X POST http://127.0.0.1:8082/display/logo"
dim "  Force QR:    curl -s -X POST http://127.0.0.1:8082/display/message -H 'Content-Type: application/json' -d '{}'  # then swipe on-device"
dim "  Scan test:   open the QR screen on the panel and join Droplet-AI from your phone"
echo
ok "Deploy complete."
