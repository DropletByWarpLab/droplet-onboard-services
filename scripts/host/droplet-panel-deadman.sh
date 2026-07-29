#!/bin/sh
# =============================================================================
# Droplet — front-panel deadman (WARP-1639)
# =============================================================================
#
# Claiming the rack panel takes the physical console away from the operator.
# This is the safety net that makes that acceptable: if the display service
# stops answering while it owns the panel, we hand the console BACK, so a
# failure degrades into a usable login prompt instead of a frozen status
# screen with no way in.
#
# Run periodically by droplet-panel-deadman.timer. Two jobs:
#
#   1. WATCH   — display service owns the panel but has been unreachable for
#                FAIL_THRESHOLD consecutive checks  ->  release the console.
#   2. RECLAIM — an operator (or the deadman) released the console earlier, the
#                hold has since expired, and the display service is healthy
#                again  ->  claim the panel back, so a forgotten debug session
#                doesn't leave the rack showing a login prompt forever.
#
# Health is "does the display service answer its own /health on loopback".
# That covers container-down, crash-looping and wedged-process. It does NOT
# cover "process alive and answering but no longer blitting" — a frame-level
# heartbeat would be needed for that, and is deliberately out of scope here.
#
# Overridable via env (test harness; production uses the defaults):
#   DROPLET_PANEL_HEALTH_URL   default http://127.0.0.1:8082/health
#   DROPLET_PANEL_RUN_DIR      default /run/droplet
#   DROPLET_PANEL_FAIL_THRESHOLD  consecutive failures before release (default 2)
#   DROPLET_PANEL_FAULT_TTL    seconds the fault-release hold lasts (default 1800)
#   DROPLET_PANEL_CONSOLE_SH   path to droplet-panel-console.sh
#   DEVICE_BRIDGE_ENV          env file holding the bearer + TLS paths
# =============================================================================
set -u

RUN_DIR="${DROPLET_PANEL_RUN_DIR:-/run/droplet}"
URL="${DROPLET_PANEL_HEALTH_URL:-http://127.0.0.1:8082/health}"
THRESHOLD="${DROPLET_PANEL_FAIL_THRESHOLD:-2}"
FAULT_TTL="${DROPLET_PANEL_FAULT_TTL:-1800}"
CONSOLE_SH="${DROPLET_PANEL_CONSOLE_SH:-/usr/local/sbin/droplet-panel-console.sh}"
ENV_FILE="${DEVICE_BRIDGE_ENV:-/etc/droplet/device-bridge.env}"

FAILS="$RUN_DIR/panel-deadman.fails"
MARKER="$RUN_DIR/panel-released"

log() { printf '[panel-deadman] %s\n' "$*" >&2; }

mkdir -p "$RUN_DIR" 2>/dev/null || true

# --- Health probe ------------------------------------------------------------
# WARP-1061: the :8082 listener requires a client cert when internal mTLS is
# on. Read the flag + bundle paths the same way droplet-shutdown-screen.sh
# does — grep, never source, so a malformed line can't execute.
ITLS=""; CERT=""; KEY=""; CA=""
if [ -f "$ENV_FILE" ]; then
  ITLS=$(grep -E '^DROPLET_INTERNAL_TLS=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  CERT=$(grep -E '^DROPLET_TLS_CERT=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  KEY=$(grep -E '^DROPLET_TLS_KEY=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  CA=$(grep -E '^DROPLET_TLS_CA=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
fi
TLS_ARGS=""
if [ "${DROPLET_INTERNAL_TLS:-$ITLS}" = "1" ]; then
  URL=$(printf '%s' "$URL" | sed 's|^http://|https://|')
  TLS_ARGS="--cacert $CA --cert $CERT --key $KEY"
fi

# /health is unauthenticated on this service; no bearer needed.
# shellcheck disable=SC2086  # TLS_ARGS is a deliberate word-split arg list
if curl -fsS -m 4 --connect-timeout 2 $TLS_ARGS "$URL" >/dev/null 2>&1; then
  HEALTHY=1
else
  HEALTHY=0
fi

STATUS=$("$CONSOLE_SH" status 2>/dev/null || echo "")
owner=$(printf '%s' "$STATUS" | sed -n 's/.*owner=\([a-z]*\).*/\1/p')

if [ "$HEALTHY" = "1" ]; then
  # Reset the failure streak on any success — we only ever act on CONSECUTIVE
  # failures, so a single blip during a restart must not trip the release.
  rm -f "$FAILS" 2>/dev/null || true

  # RECLAIM: healthy service, console currently owns the panel, and the hold
  # has expired. `claim` re-checks the marker itself and refuses while it is
  # live, so this stays correct even if the marker expires between the two
  # calls. A still-live hold simply means we do nothing this tick.
  if [ "$owner" = "console" ]; then
    case "$STATUS" in
      *held=no*)
        [ -f "$MARKER" ] && log "hold expired and service is healthy — reclaiming the panel"
        "$CONSOLE_SH" claim >/dev/null 2>&1 || true
        ;;
    esac
  fi
  exit 0
fi

# --- Unhealthy ---------------------------------------------------------------
n=$(cat "$FAILS" 2>/dev/null || echo 0)
case "$n" in ''|*[!0-9]*) n=0 ;; esac
n=$(( n + 1 ))
printf '%s' "$n" > "$FAILS" 2>/dev/null || true

if [ "$owner" != "display" ]; then
  # Console already has the panel — the operator can already see something.
  exit 0
fi

if [ "$n" -ge "$THRESHOLD" ]; then
  log "display service unreachable for $n consecutive checks — releasing the console"
  # A LONG but finite hold, deliberately not 0/forever. Forever would mean a
  # single transient fault leaves the rack showing a login prompt until a human
  # intervenes. A long hold instead gives the operator a stable prompt to work
  # at, and returns the status screen on its own once the service has been
  # healthy again past the deadline. A service that keeps dying simply
  # re-releases — the hold length is the anti-flap.
  "$CONSOLE_SH" release "$FAULT_TTL" || log "release failed"
else
  log "display service unreachable ($n/$THRESHOLD)"
fi
exit 0
