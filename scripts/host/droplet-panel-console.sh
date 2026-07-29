#!/bin/sh
# =============================================================================
# Droplet — front-panel console ownership (WARP-1639)
# =============================================================================
#
# The rack panel is a plain HDMI monitor on the box's iGPU, so exactly one
# thing at a time can own that framebuffer: either the kernel console (fbcon,
# i.e. a login prompt) or the droplet-oled-display service (the status
# screen). This script is the ONLY place that ownership is switched.
#
#   claim    fbcon lets go; the display service owns the panel.
#   release  fbcon takes over and we switch to a login VT — this is the
#            operator's way back in when something has gone wrong.
#   status   print current ownership (machine-readable).
#
# WHY THIS EXISTS AS A RECOVERY PATH
# ----------------------------------
# Claiming the panel takes the physical console away. If the display service
# then dies, wedges, or renders garbage, an operator standing at the rack would
# have no way in. So:
#   * droplet-panel-deadman.timer calls `release` automatically when the
#     display service stops answering — a failure degrades to a usable console
#     instead of a frozen image.
#   * the panel's own debug screen can call `release` on demand, via the
#     device-bridge, which polkit-starts droplet-panel-console.service.
#   * getty@tty1 is deliberately left ENABLED, so Ctrl+Alt+F2 keeps working
#     with a USB keyboard regardless of any of the above.
#
# ⚠ The panel's own touchscreen CANNOT type: all three of its USB interfaces
# are HID and decode to BTN_TOUCH / mouse buttons only — there are no keyboard
# keys. `release` gets you a login prompt ON the panel, but you still need a
# physical USB keyboard to use it. That is a property of the hardware, not a
# limitation of this script.
#
# RELEASE IS STICKY, WITH A DEADLINE. A release drops a marker file carrying an
# expiry. While the marker is live, `claim` refuses (so a healthy display
# service can't yank the console back out from under someone mid-debug). Once
# it expires, the deadman reclaims the panel automatically so a forgotten debug
# session doesn't leave the rack showing a login prompt forever.
#
# Overridable via env (the test harness uses these; production uses defaults):
#   DROPLET_VTCONSOLE_DIR   default /sys/class/vtconsole
#   DROPLET_PANEL_RUN_DIR   default /run/droplet
#   DROPLET_PANEL_CONSOLE_VT       VT to switch to on release (default 1)
#   DROPLET_PANEL_CONSOLE_TTL      seconds a release stays sticky (default 900)
#   DROPLET_CHVT                   chvt binary (default: chvt from PATH)
# =============================================================================
set -u

VTCON_DIR="${DROPLET_VTCONSOLE_DIR:-/sys/class/vtconsole}"
RUN_DIR="${DROPLET_PANEL_RUN_DIR:-/run/droplet}"
CONSOLE_VT="${DROPLET_PANEL_CONSOLE_VT:-1}"
CONSOLE_TTL="${DROPLET_PANEL_CONSOLE_TTL:-900}"
CHVT="${DROPLET_CHVT:-chvt}"

MARKER="$RUN_DIR/panel-released"

log() { printf '[panel-console] %s\n' "$*" >&2; }

now() { date +%s 2>/dev/null || echo 0; }

# --- Locate the framebuffer console ------------------------------------------
# vtcon0 is usually the dummy device and vtcon1 the framebuffer one, but that
# is not guaranteed — match on the name, never on the index.
fbcon_path() {
  for v in "$VTCON_DIR"/vtcon*; do
    [ -d "$v" ] || continue
    name=$(cat "$v/name" 2>/dev/null || echo "")
    case "$name" in
      *"frame buffer device"*) printf '%s' "$v"; return 0 ;;
    esac
  done
  return 1
}

# --- Release marker ----------------------------------------------------------
marker_expiry() {
  [ -f "$MARKER" ] || return 1
  exp=$(cat "$MARKER" 2>/dev/null || echo "")
  case "$exp" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s' "$exp"
}

marker_live() {
  exp=$(marker_expiry) || return 1
  # A 0 expiry means "sticky forever" (explicit operator hold).
  [ "$exp" = "0" ] && return 0
  [ "$(now)" -lt "$exp" ]
}

# --- Actions -----------------------------------------------------------------
do_claim() {
  fb=$(fbcon_path) || { log "no framebuffer console found — nothing to claim"; return 0; }

  if [ "${1:-}" != "--force" ] && marker_live; then
    log "release marker is live — refusing to claim (use --force or wait for expiry)"
    return 3
  fi
  rm -f "$MARKER" 2>/dev/null || true

  if [ "$(cat "$fb/bind" 2>/dev/null || echo 0)" = "0" ]; then
    log "already claimed ($fb bind=0)"
    return 0
  fi
  if printf '0' > "$fb/bind" 2>/dev/null; then
    log "claimed the panel ($fb bind=0) — fbcon released"
    return 0
  fi
  log "FAILED to unbind $fb (need root?)"
  return 1
}

do_release() {
  # Recovery must be as close to infallible as we can make it: every step is
  # best-effort and a failure in one does not skip the others.
  rc=0
  mkdir -p "$RUN_DIR" 2>/dev/null || true

  ttl="${1:-$CONSOLE_TTL}"
  case "$ttl" in
    ''|*[!0-9]*) ttl="$CONSOLE_TTL" ;;
  esac
  if [ "$ttl" = "0" ]; then
    printf '0' > "$MARKER" 2>/dev/null || true
  else
    printf '%s' "$(( $(now) + ttl ))" > "$MARKER" 2>/dev/null || true
  fi

  fb=$(fbcon_path) || { log "no framebuffer console found"; return 1; }
  if [ "$(cat "$fb/bind" 2>/dev/null || echo 1)" = "1" ]; then
    log "fbcon already bound ($fb)"
  elif printf '1' > "$fb/bind" 2>/dev/null; then
    log "released the panel ($fb bind=1) — fbcon painting again"
  else
    log "FAILED to bind $fb (need root?)"
    rc=1
  fi

  # Put a login VT in front so the operator gets a prompt, not a blank console.
  if command -v "$CHVT" >/dev/null 2>&1; then
    "$CHVT" "$CONSOLE_VT" 2>/dev/null || log "chvt $CONSOLE_VT failed (headless?)"
  fi
  return "$rc"
}

do_status() {
  fb=$(fbcon_path) || { echo "owner=unknown fbcon=absent"; return 0; }
  bind=$(cat "$fb/bind" 2>/dev/null || echo "?")
  if [ "$bind" = "0" ]; then owner=display; else owner=console; fi
  if marker_live; then
    exp=$(marker_expiry)
    if [ "$exp" = "0" ]; then held="held=forever"; else held="held=$(( exp - $(now) ))s"; fi
  else
    held="held=no"
  fi
  echo "owner=$owner fbcon_bind=$bind $held vtcon=$fb"
}

case "${1:-}" in
  claim)   shift; do_claim "$@" ;;
  release) shift; do_release "$@" ;;
  status)  do_status ;;
  *)
    echo "usage: $0 {claim [--force]|release [ttl_seconds]|status}" >&2
    exit 2
    ;;
esac
