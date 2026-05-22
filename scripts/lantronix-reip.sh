#!/usr/bin/env bash
# WARP-400 §4 — Lantronix SM8TAT2SA management re-IP runbook.
#
# Moves the switch's management address off the home-router subnet
# (192.168.1.77) and onto the Droplet's LAN VLAN (192.168.20.2/24).
# Once this lands, pulling the home router doesn't take the switch
# offline.
#
# ⚠️ READ BEFORE RUNNING ⚠️
# -------------------------
# This script disconnects the switch's management plane mid-run.
# If you execute it from a host that reaches the switch THROUGH the
# home router (because your workstation got a 192.168.1.x lease from
# the home router's DHCP rather than the Droplet's LAN), you will
# lock yourself out the moment step 4 lands. The pre-checks below
# hard-fail in that case — do NOT remove or bypass them.
#
# Physical recovery: SM8TAT2SA front-panel mini-USB console, default
# baud 115200 8N1; password reset via the boot-loader menu. Plan to
# be physically at the box before you run this.
#
# Usage:
#   SWITCH_OLD_IP=192.168.1.77 \
#   SWITCH_NEW_IP=192.168.20.2 \
#   SWITCH_GATEWAY=192.168.20.1 \
#   SWITCH_NETMASK=255.255.255.0 \
#   SWITCH_USERNAME=admin \
#   SWITCH_PASSWORD='...' \
#   ./scripts/lantronix-reip.sh
#
# Or accept the defaults (matching the POC box) and just pass the password:
#   SWITCH_PASSWORD='...' ./scripts/lantronix-reip.sh

set -euo pipefail

SWITCH_OLD_IP="${SWITCH_OLD_IP:-192.168.1.77}"
SWITCH_NEW_IP="${SWITCH_NEW_IP:-192.168.20.2}"
SWITCH_GATEWAY="${SWITCH_GATEWAY:-192.168.20.1}"
SWITCH_NETMASK="${SWITCH_NETMASK:-255.255.255.0}"
SWITCH_USERNAME="${SWITCH_USERNAME:-admin}"
SWITCH_PASSWORD="${SWITCH_PASSWORD:-}"
SWITCH_VLAN_MGMT="${SWITCH_VLAN_MGMT:-1}"

if [[ -z "$SWITCH_PASSWORD" ]]; then
  echo "ERROR: SWITCH_PASSWORD is required. Set it in env or pass inline." >&2
  exit 2
fi

# Allow the operator to skip the pre-check loop ONLY with explicit override.
# Defaults are paranoid by design — we'd rather refuse-then-explain than
# silently brick the management plane.
SKIP_PRECHECKS="${SKIP_PRECHECKS:-0}"

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required." >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (apt install jq)." >&2
  exit 2
fi
if ! command -v ip >/dev/null 2>&1 && [[ "$SKIP_PRECHECKS" != "1" ]]; then
  echo "ERROR: 'ip' command not found and pre-checks not skipped." >&2
  exit 2
fi

LANTRONIX_LOGIN_URL_OLD="https://$SWITCH_OLD_IP/config/login"
LANTRONIX_LOGIN_URL_NEW="https://$SWITCH_NEW_IP/config/login"

COOKIE_JAR=$(mktemp -t lantronix-reip-XXXXXX.cookies)
trap 'rm -f "$COOKIE_JAR"' EXIT

say() { printf '\033[1;36m[reip]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[reip]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[reip]\033[0m %s\n' "$*" >&2; exit 1; }

login_at() {
  local url="$1"
  curl -sk -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -X POST "$url" \
    -d "username=$SWITCH_USERNAME&password=$SWITCH_PASSWORD" \
    -o /dev/null
}

get_at() {
  local base="$1"
  local path="$2"
  curl -sk -c "$COOKIE_JAR" -b "$COOKIE_JAR" "https://$base$path"
}

post_at() {
  local base="$1"
  local path="$2"
  local body="$3"
  curl -sk -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -X POST "https://$base$path" \
    -H "Content-Type: application/json" \
    -d "$body"
}

# --- pre-checks ------------------------------------------------------------

if [[ "$SKIP_PRECHECKS" != "1" ]]; then
  say "Pre-check 1 — operator workstation has an IP on the new subnet ($SWITCH_NEW_IP/24)"
  expected_subnet="${SWITCH_NEW_IP%.*}."
  if ! ip -4 addr show | grep -q " inet $expected_subnet"; then
    die "No interface in subnet ${expected_subnet}0/24 on this host. \
You are NOT plugged into the Droplet's LAN VLAN. \
Aborting before step 4 disconnects the switch."
  fi
  ok "   workstation has a $expected_subnet* address"

  say "Pre-check 2 — gateway $SWITCH_GATEWAY responds to ping (OpenWRT router is up)"
  if ! ping -c 1 -W 2 "$SWITCH_GATEWAY" >/dev/null 2>&1; then
    die "Cannot ping $SWITCH_GATEWAY. The OpenWRT router is not up on this subnet."
  fi
  ok "   gateway reachable"

  say "Pre-check 3 — switch currently reachable at old IP $SWITCH_OLD_IP"
  if ! login_at "$LANTRONIX_LOGIN_URL_OLD"; then
    die "Login POST to $LANTRONIX_LOGIN_URL_OLD failed — wrong password, or switch already moved?"
  fi
  if ! get_at "$SWITCH_OLD_IP" "/stat/sysinfo" | jq -e '.' >/dev/null 2>&1; then
    die "/stat/sysinfo on $SWITCH_OLD_IP returned non-JSON — login probably 401'd silently."
  fi
  ok "   switch is reachable and accepts our credentials"
else
  say "Pre-checks SKIPPED (SKIP_PRECHECKS=1). You're on your own."
  login_at "$LANTRONIX_LOGIN_URL_OLD" \
    || die "Login to $LANTRONIX_LOGIN_URL_OLD failed."
fi

# --- step 4 — flip the IP --------------------------------------------------

say "Step 4 — re-IP switch management to $SWITCH_NEW_IP/$SWITCH_NETMASK gw=$SWITCH_GATEWAY (VLAN $SWITCH_VLAN_MGMT)"
say "         the switch will drop off $SWITCH_OLD_IP IMMEDIATELY"

REIP_BODY=$(jq -nc \
  --arg ip "$SWITCH_NEW_IP" \
  --arg mask "$SWITCH_NETMASK" \
  --arg gw "$SWITCH_GATEWAY" \
  --argjson vlan "$SWITCH_VLAN_MGMT" \
  '{ip: $ip, mask: $mask, gateway: $gw, vlan: $vlan}')

# Fire-and-forget — the switch will TCP-RST mid-response when it
# tears down the old IP. We discard the exit code; the proof is
# reaching it on the new IP in step 6.
curl -sk -m 5 -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -X POST "https://$SWITCH_OLD_IP/config/ip" \
  -H "Content-Type: application/json" \
  -d "$REIP_BODY" \
  -o /dev/null || true

say "Step 5 — waiting 5s for the switch to bring up $SWITCH_NEW_IP"
sleep 5

# --- step 6 — verify new IP reachability ----------------------------------

say "Step 6 — verifying $SWITCH_NEW_IP is alive"
if ! login_at "$LANTRONIX_LOGIN_URL_NEW"; then
  die "Login on the NEW IP $SWITCH_NEW_IP failed. The switch may not have applied — \
power-cycle it and try the OLD IP first; if old IP is back, the re-IP rolled back \
correctly. If neither IP works, you need the front-panel console (see header)."
fi
if ! get_at "$SWITCH_NEW_IP" "/stat/sysinfo" | jq -e '.firmware_version // .firmware // .Firmware' >/dev/null 2>&1; then
  die "/stat/sysinfo on $SWITCH_NEW_IP returned non-JSON. Re-IP may have only half-landed."
fi
ok "   switch responds on $SWITCH_NEW_IP/sysinfo"

# --- step 7 — persist the change ------------------------------------------

say "Step 7 — POST /config/conf_save to persist across reboot"
SAVE_RESP=$(post_at "$SWITCH_NEW_IP" "/config/conf_save" "{}")
echo "         response: $SAVE_RESP"
ok "Done. Update LANTRONIX_HOST in /home/droplet/edge-platform/.env from $SWITCH_OLD_IP \
to $SWITCH_NEW_IP and restart the switch container:"
ok "  docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.override.yml restart switch"
