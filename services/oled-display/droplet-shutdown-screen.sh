#!/bin/sh
# =============================================================================
# Droplet — push the shutdown screen to the front panel at teardown
# =============================================================================
#
# Invoked by droplet-shutdown-screen.service's ExecStop. systemd stops that
# oneshot BEFORE the docker stack on shutdown (reverse of start order), so the
# oled-display container is still alive to receive this when we run.
#
# Reads the bearer token from the device-bridge env file and POSTs the
# shutdown screen to the local oled-display service, then sleeps briefly so
# the serial frame lands on the panel before the container is torn down.
#
# Hard requirement: this must NEVER block or fail shutdown. The curl is time-
# bounded, every error is swallowed, and the script always exits 0.
#
# Overridable via env (used by the test harness; production uses the defaults):
#   DEVICE_BRIDGE_ENV     path to the env file holding BRIDGE_AUTH_TOKEN
#   SHUTDOWN_SCREEN_URL   the POST target
#   SHUTDOWN_SCREEN_SLEEP seconds to pause after the POST (frame settle time)
# =============================================================================
set -u

ENV_FILE="${DEVICE_BRIDGE_ENV:-/etc/droplet/device-bridge.env}"
URL="${SHUTDOWN_SCREEN_URL:-http://127.0.0.1:8082/display/shutdown}"
SETTLE="${SHUTDOWN_SCREEN_SLEEP:-1.5}"

# Pull the bearer token. Prefer BRIDGE_AUTH_TOKEN (what install-device-bridge.sh
# seeds), then SERVICE_SECRET / DEVICE_SECRET_KEY as fallbacks. We grep the
# file rather than sourcing it so a malformed line can't execute.
TOKEN=""
if [ -f "$ENV_FILE" ]; then
  for key in BRIDGE_AUTH_TOKEN SERVICE_SECRET DEVICE_SECRET_KEY; do
    val=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
    if [ -n "$val" ]; then
      TOKEN="$val"
      break
    fi
  done
fi

# WARP-1061 — internal mTLS. The oled-display :8082 listener requires a
# CA-signed client cert when DROPLET_INTERNAL_TLS=1; read the flag + the
# host-issued `device-bridge` bundle paths from the same env file as the
# bearer (install-device-bridge.sh mirrors them from the repo .env). Flag
# off/absent keeps the plain-HTTP curl byte-identical to before. grep, not
# source — a malformed line must not execute (same rationale as TOKEN).
ITLS=""
CERT=""; KEY=""; CA=""
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

# POST the shutdown frame. -m bounds the whole operation so a wedged socket
# can't hang teardown; --connect-timeout bounds the TCP connect specifically.
# Everything is best-effort: failures are intentionally ignored.
# shellcheck disable=SC2086  # TLS_ARGS is a deliberate word-split arg list
curl -fsS -m 5 --connect-timeout 2 $TLS_ARGS \
  -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"reason":"system shutdown","phase":"stopping"}' \
  "$URL" >/dev/null 2>&1 || true

# Give the host->panel serial push a moment to land before the container dies.
sleep "$SETTLE" 2>/dev/null || true

exit 0
