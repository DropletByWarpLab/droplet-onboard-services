#!/usr/bin/env bash
# =============================================================================
# Flash the PyPortal Titano front-panel firmware (code.py + boot.py)
# =============================================================================
#
# Pushes this repo's services/oled-display/pyportal/{code.py,boot.py} to the
# connected board. The boot/shutdown lifecycle splash screens (WARP-624) live
# in code.py, so the board needs this to render them.
#
# Two methods, selectable:
#   1) DISK (default, preferred): on a stock CircuitPython board the host's
#      USB-MSC view of the CIRCUITPY drive is writable, so we just copy the
#      files (atomic temp+rename) and verify by hash. Simple and reversible;
#      CircuitPython auto-reloads code.py on change.
#   2) REPL (--repl): for boards whose boot.py remounts the filesystem
#      read-only-to-host (giving the running code the write lock), the disk is
#      read-only to the host and writes must go over the raw REPL on
#      /dev/ttyACM0 via services/oled-display/tools/repl_upload.py (pyserial
#      only; the appliance has no pip/mpremote).
#
# The oled-display container is stopped during the flash (it holds the data
# CDC /dev/ttyACM1 and polls the board ~1/s) and restarted afterwards.
#
# If the CIRCUITPY drive shows up READ-ONLY in disk mode, that is usually a
# transient/dirty-FAT state: reboot the board (or double-tap reset into the
# UF2 bootloader, then single-press reset to boot back) and re-run — the drive
# comes back writable.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FW="$REPO_ROOT/services/oled-display/pyportal"
TOOL="$REPO_ROOT/services/oled-display/tools/repl_upload.py"
CONTAINER=droplet-oled-display-1
MNT=/mnt/droplet-circuitpy

MODE=disk
PORT=/dev/ttyACM0
while [ $# -gt 0 ]; do
  case "$1" in
    --repl)    MODE=repl; shift ;;
    --port)    PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *)         echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -f "$FW/code.py" ] || { echo "flash-pyportal: missing firmware $FW/code.py" >&2; exit 1; }

stopped=0
stop_container() {
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
    echo "flash-pyportal: stopping $CONTAINER to free the board..."
    docker stop "$CONTAINER" >/dev/null && stopped=1
    sleep 2
  fi
}
cleanup() {
  mountpoint -q "$MNT" 2>/dev/null && sudo umount "$MNT" 2>/dev/null || true
  [ "$stopped" = 1 ] && docker start "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

flash_disk() {
  command -v blkid >/dev/null 2>&1 || { echo "flash-pyportal: blkid not found" >&2; exit 1; }
  if ! sudo blkid -L CIRCUITPY >/dev/null 2>&1; then
    echo "flash-pyportal: no CIRCUITPY drive — is the board in CircuitPython (not the UF2 bootloader)? Try --repl." >&2
    exit 1
  fi
  stop_container
  sudo mkdir -p "$MNT"
  sudo umount "$MNT" 2>/dev/null || true
  sudo mount -o rw -L CIRCUITPY "$MNT"
  if ! sudo touch "$MNT/.flash_wtest" 2>/dev/null; then
    sudo umount "$MNT" 2>/dev/null || true
    echo "flash-pyportal: CIRCUITPY is READ-ONLY. Reboot the board (or double-tap reset into the UF2 bootloader, then single-press reset to boot back) to clear a transient read-only state and re-run. If the board's boot.py remounts read-only-to-host, use --repl." >&2
    exit 1
  fi
  sudo rm -f "$MNT/.flash_wtest"
  local f
  for f in code.py boot.py; do
    sudo cp "$FW/$f" "$MNT/$f.new" && sudo sync && sudo mv -f "$MNT/$f.new" "$MNT/$f"
    echo "  wrote $f"
  done
  sudo sync
  sudo umount "$MNT"
  # Verify by hash (re-mount read-only).
  sudo mount -o ro -L CIRCUITPY "$MNT"
  local ok=1 bsum rsum
  for f in code.py boot.py; do
    bsum="$(sudo sha256sum "$MNT/$f" | awk '{print $1}')"
    rsum="$(sha256sum "$FW/$f" | awk '{print $1}')"
    if [ "$bsum" = "$rsum" ]; then echo "  verified $f"; else echo "  MISMATCH $f" >&2; ok=0; fi
  done
  sudo umount "$MNT"
  [ "$ok" = 1 ] || { echo "flash-pyportal: verification FAILED" >&2; exit 1; }
  echo "flash-pyportal: done (disk) — CircuitPython auto-reloads code.py on change."
}

flash_repl() {
  [ -e "$PORT" ] || { echo "flash-pyportal: $PORT not present" >&2; exit 1; }
  [ -f "$TOOL" ] || { echo "flash-pyportal: missing uploader $TOOL" >&2; exit 1; }
  stop_container
  echo "flash-pyportal: pushing code.py + boot.py over REPL $PORT ..."
  sudo python3 "$TOOL" --port "$PORT" --push "$FW/code.py:code.py" --push "$FW/boot.py:boot.py"
  echo "flash-pyportal: done (repl) — board soft-rebooted."
}

if [ "$MODE" = repl ]; then flash_repl; else flash_disk; fi
