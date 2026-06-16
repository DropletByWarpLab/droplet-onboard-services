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

# POST the shutdown frame. -m bounds the whole operation so a wedged socket
# can't hang teardown; --connect-timeout bounds the TCP connect specifically.
# Everything is best-effort: failures are intentionally ignored.
curl -fsS -m 5 --connect-timeout 2 \
  -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"reason":"system shutdown","phase":"stopping"}' \
  "$URL" >/dev/null 2>&1 || true

# Give the host->panel serial push a moment to land before the container dies.
sleep "$SETTLE" 2>/dev/null || true

exit 0
