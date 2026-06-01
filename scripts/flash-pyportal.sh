#!/usr/bin/env bash
# =============================================================================
# Flash the PyPortal Titano front-panel firmware (code.py + boot.py)
# =============================================================================
#
# Pushes this repo's services/oled-display/pyportal/{code.py,boot.py} to the
# connected board over the CircuitPython REPL (/dev/ttyACM0), using the
# dependency-light services/oled-display/tools/repl_upload.py (pyserial only —
# the appliance has no pip/mpremote). The boot/shutdown lifecycle splash
# screens (WARP-624) live in code.py, so the board needs this to render them.
#
# The oled-display container is briefly stopped so the board is quiescent
# during the write (it otherwise holds the data CDC and polls ~1/s), then
# restarted.
#
# IMPORTANT — write-locked boards: CircuitPython refuses code/REPL writes while
# the CIRCUITPY drive is "visible via USB" (RuntimeError: Cannot remount '/'
# when visible via USB), and presents the USB-MSC view read-only when its own
# code holds the write lock. A board in that state CANNOT be flashed remotely
# by either path — it needs a physical double-tap reset into the UF2 bootloader
# (drag-drop the files) or safe-mode entry at the appliance. This script fails
# fast with the board's error in that case; do the physical flash and re-run.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FW="$REPO_ROOT/services/oled-display/pyportal"
TOOL="$REPO_ROOT/services/oled-display/tools/repl_upload.py"
PORT="${1:-/dev/ttyACM0}"

[ -e "$PORT" ] || { echo "flash-pyportal: $PORT not present — is the PyPortal connected?"; exit 1; }
[ -f "$TOOL" ] || { echo "flash-pyportal: missing uploader $TOOL"; exit 1; }
[ -f "$FW/code.py" ] || { echo "flash-pyportal: missing firmware $FW/code.py"; exit 1; }

# Free the board: stop the oled-display service so its data-CDC polling does
# not contend with the REPL. Restart it on exit (success or failure).
stopped=0
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'droplet-oled-display-1'; then
  echo "flash-pyportal: stopping droplet-oled-display-1 to free the board..."
  docker stop droplet-oled-display-1 >/dev/null && stopped=1
  sleep 2
fi
restart_container() { if [ "$stopped" = 1 ]; then docker start droplet-oled-display-1 >/dev/null 2>&1 || true; fi; }
trap restart_container EXIT

echo "flash-pyportal: pushing code.py + boot.py to $PORT ..."
sudo python3 "$TOOL" --port "$PORT" \
  --push "$FW/code.py:code.py" \
  --push "$FW/boot.py:boot.py"
echo "flash-pyportal: done — board soft-rebooted into the new firmware."
