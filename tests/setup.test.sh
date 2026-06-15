#!/usr/bin/env bash
# =============================================================================
# Unit tests for setup.sh: secret generation and compose.sh psql configuration.
#
# Does NOT require Docker or a running stack.
# Runtime: < 5 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  Setup Unit Tests"
echo "  ================================================"
echo ""

# =============================================================================
# Phase 1: Static analysis — compose.sh psql configuration
# =============================================================================
echo "--- Phase 1: compose.sh psql configuration ---"

COMPOSE_LIB="$REPO_ROOT_REAL/scripts/lib/compose.sh"

# PGPASSWORD must be forwarded via -e into docker compose exec so psql
# does not fall back to prompting interactively.
if grep -q "\-e PGPASSWORD" "$COMPOSE_LIB"; then
  pass "compose.sh passes PGPASSWORD via -e to docker compose exec"
else
  fail "compose.sh missing '-e PGPASSWORD' — psql will prompt for password interactively"
fi

# psql -w (--no-password) prevents interactive prompts even as a failsafe.
if grep "psql" "$COMPOSE_LIB" | grep -qE "\s-w\b|\s-w[a-z]|-[a-z]*w[a-z]*\b"; then
  pass "compose.sh psql uses -w (no-password flag)"
else
  fail "compose.sh psql missing -w flag — password prompt possible if PGPASSWORD unset"
fi

# =============================================================================
# Phase 2: generate_env unit tests (no Docker)
# =============================================================================
echo "--- Phase 2: generate_env ---"

# Set up an isolated temp repo root with a copy of .env.example
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

cp "$REPO_ROOT_REAL/.env.example" "$TMP_ROOT/.env.example"
mkdir -p "$TMP_ROOT/.data"

# Source logging (safe: only defines functions and color vars)
export REPO_ROOT="$TMP_ROOT"
LOG_FILE="$TMP_ROOT/.data/setup.log"
export LOG_FILE
# shellcheck source=../scripts/lib/logging.sh
source "$REPO_ROOT_REAL/scripts/lib/logging.sh"

# Stub out Docker/openssl-dependent helpers before sourcing secrets.sh
_generate_mosquitto_passwd() { return 0; }
_write_mosquitto_conf()       { return 0; }
_generate_tls_cert()          { return 0; }

# shellcheck source=../scripts/lib/secrets.sh
source "$REPO_ROOT_REAL/scripts/lib/secrets.sh"

# Re-stub after sourcing secrets.sh (it defines these functions — override them)
_generate_mosquitto_passwd() { return 0; }
_write_mosquitto_conf()       { return 0; }
_generate_tls_cert()          { return 0; }

# Run generate_env
if generate_env >/dev/null 2>&1; then
  pass "generate_env completed without error"
else
  fail "generate_env exited with an error"
  echo "  Cannot continue — generate_env failed"
  exit 1
fi

# .env was created
if [ -f "$TMP_ROOT/.env" ]; then
  pass ".env file created"
else
  fail ".env file not created"
  exit 1
fi

# No 'change-me' placeholders remain
if ! grep -q "change-me" "$TMP_ROOT/.env"; then
  pass "No 'change-me' placeholders in generated .env"
else
  fail "Generated .env still contains 'change-me' placeholders:"
  grep "change-me" "$TMP_ROOT/.env" | while IFS= read -r line; do
    printf "    %s\n" "$line"
  done
fi

# POSTGRES_PASSWORD is non-empty
PG_PASS=$(grep "^POSTGRES_PASSWORD=" "$TMP_ROOT/.env" | cut -d= -f2-)
if [ -n "$PG_PASS" ]; then
  pass "POSTGRES_PASSWORD is set (${PG_PASS:0:4}****)"
else
  fail "POSTGRES_PASSWORD is empty in generated .env"
fi

# DATABASE_URL contains the generated password
DB_URL=$(grep "^DATABASE_URL=" "$TMP_ROOT/.env" | cut -d= -f2-)
if echo "$DB_URL" | grep -qF "$PG_PASS"; then
  pass "DATABASE_URL contains the generated POSTGRES_PASSWORD"
else
  fail "DATABASE_URL does not match POSTGRES_PASSWORD (password mismatch)"
fi

# .env permissions are 600
PERMS=$(stat -c "%a" "$TMP_ROOT/.env" 2>/dev/null || stat -f "%OLp" "$TMP_ROOT/.env" 2>/dev/null || echo "unknown")
if [ "$PERMS" = "600" ]; then
  pass ".env has restricted permissions (600)"
else
  fail ".env permissions are $PERMS (expected 600)"
fi

# generate_env is idempotent — second call keeps existing secrets
PG_PASS_FIRST="$PG_PASS"
if generate_env >/dev/null 2>&1; then
  PG_PASS_SECOND=$(grep "^POSTGRES_PASSWORD=" "$TMP_ROOT/.env" | cut -d= -f2-)
  if [ "$PG_PASS_FIRST" = "$PG_PASS_SECOND" ]; then
    pass "generate_env is idempotent (second call keeps existing secrets)"
  else
    fail "generate_env regenerated secrets on second call (not idempotent)"
  fi
else
  fail "generate_env failed on second call"
fi

# --- OPENWRT_PASSWORD generation (WARP-834) -------------------------------
# generate_env must now mint a per-device OpenWrt rpcd/root password.
# sync_openwrt_password_secret() writes this value into
# docker/secrets/openwrt_password, which routing's _load_openwrt_password()
# reads for ubus auth AND droplet-openwrt-attach uses to set the container
# root pw. An empty value previously left the router root password unset.
OPENWRT_PASS=$( { grep "^OPENWRT_PASSWORD=" "$TMP_ROOT/.env" || true; } | cut -d= -f2-)
if [ -n "$OPENWRT_PASS" ]; then
  pass "OPENWRT_PASSWORD is set (${OPENWRT_PASS:0:4}****)"
else
  fail "OPENWRT_PASSWORD is empty in generated .env (router root pw stays unset)"
fi

# Strength: >= 20 chars, alphanumeric only (safe for passwd, the secret file,
# and the ubus login JSON string — no shell/JSON-hostile characters).
if [ "${#OPENWRT_PASS}" -ge 20 ] && printf '%s' "$OPENWRT_PASS" | grep -qE '^[A-Za-z0-9]+$'; then
  pass "OPENWRT_PASSWORD is strong (>= 20 chars, alphanumeric)"
else
  fail "OPENWRT_PASSWORD is weak (len=${#OPENWRT_PASS}, expected >= 20 alphanumeric chars)"
fi

# Idempotent — a second generate_env must not rotate OPENWRT_PASSWORD
# (mirrors the POSTGRES_PASSWORD idempotency check above).
OPENWRT_PASS_FIRST="$OPENWRT_PASS"
if generate_env >/dev/null 2>&1; then
  OPENWRT_PASS_SECOND=$( { grep "^OPENWRT_PASSWORD=" "$TMP_ROOT/.env" || true; } | cut -d= -f2-)
  if [ "$OPENWRT_PASS_FIRST" = "$OPENWRT_PASS_SECOND" ]; then
    pass "OPENWRT_PASSWORD is idempotent (second generate_env keeps existing value)"
  else
    fail "OPENWRT_PASSWORD rotated on second generate_env (not idempotent)"
  fi
else
  fail "generate_env failed on the OPENWRT_PASSWORD idempotency re-run"
fi

# migrate_env backfill — existing installs predate the per-box OpenWrt
# password. Strip the line from a generated .env, run migrate_env, and assert
# exactly one non-empty OPENWRT_PASSWORD line is restored.
sed -i.bak '/^OPENWRT_PASSWORD=/d' "$TMP_ROOT/.env" && rm -f "$TMP_ROOT/.env.bak"
migrate_env >/dev/null 2>&1 || true
OPENWRT_PASS_LINE_COUNT=$(grep -cE '^OPENWRT_PASSWORD=' "$TMP_ROOT/.env" || true)
OPENWRT_PASS_MIGRATED=$( { grep -E '^OPENWRT_PASSWORD=' "$TMP_ROOT/.env" || true; } | head -n 1 | cut -d= -f2-)
if [ "$OPENWRT_PASS_LINE_COUNT" = "1" ] && [ -n "$OPENWRT_PASS_MIGRATED" ]; then
  pass "migrate_env backfills exactly one non-empty OPENWRT_PASSWORD line"
else
  fail "migrate_env backfill wrong (lines=${OPENWRT_PASS_LINE_COUNT}, value='${OPENWRT_PASS_MIGRATED:0:4}…')"
fi

# =============================================================================
# Phase 3: single-box .env knobs — configure_single_box_env (WARP-654 follow-up)
# =============================================================================
echo "--- Phase 3: configure_single_box_env (single-box knobs) ---"

# lib/single-box.sh is a sourceable lib (functions only; no top-level run).
# logging.sh is already sourced above, and REPO_ROOT + a generated .env exist
# from Phase 2 — so configure_single_box_env has everything it needs.
# shellcheck source=../scripts/lib/single-box.sh
source "$REPO_ROOT_REAL/scripts/lib/single-box.sh"

# configure_single_box_env now derives the live droplet_default bridge gateway
# via `docker network inspect` to pin the host-net SERVICE_URLs (WARP-806). Stub
# `docker` on PATH for the whole of Phase 3 so the function is hermetic and runs
# without a Docker daemon (CI has none — see setup-tests.yml "no Docker"). The
# stub answers only the gateway inspection; everything else is a no-op success.
SB_FAKE_GW="10.99.0.1"
SB_STUB_BIN="$TMP_ROOT/sb-stub-bin"
mkdir -p "$SB_STUB_BIN"
cat > "$SB_STUB_BIN/docker" <<EOF
#!/usr/bin/env bash
# Minimal docker stub: answer the droplet_default gateway inspection only.
if [ "\$1" = "network" ] && [ "\$2" = "inspect" ]; then
  printf '%s\n' "$SB_FAKE_GW"
  exit 0
fi
exit 0
EOF
chmod +x "$SB_STUB_BIN/docker"
SB_OLD_PATH="$PATH"
PATH="$SB_STUB_BIN:$PATH"

if configure_single_box_env >/dev/null 2>&1; then
  pass "configure_single_box_env completed without error"
else
  fail "configure_single_box_env exited with an error"
fi

# The single-box shape runs the AP as a host hostapd (not a standalone UCI router),
# so the device-bridge must read pairing-QR creds in hostapd mode. The install
# records that as a .env knob; install-device-bridge.sh mirrors it into
# /etc/droplet/device-bridge.env, where device-bridge.py reads it (it defaults
# to uci otherwise — multi-box). WARP-654 / PR #471 follow-up.
AP_MODE_COUNT=$(grep -cE '^DROPLET_AP_MODE=hostapd$' "$TMP_ROOT/.env" || true)
if [ "$AP_MODE_COUNT" = "1" ]; then
  pass "configure_single_box_env sets DROPLET_AP_MODE=hostapd (single occurrence)"
else
  fail "expected exactly one 'DROPLET_AP_MODE=hostapd' in .env, found ${AP_MODE_COUNT}"
fi

# Sanity: the knob block ran (COMPOSE_PROFILES merged to include single-box).
if grep -E '^COMPOSE_PROFILES=' "$TMP_ROOT/.env" | tail -1 | grep -q 'single-box'; then
  pass "COMPOSE_PROFILES includes single-box"
else
  fail "COMPOSE_PROFILES does not include single-box after configure_single_box_env"
fi

# Idempotent — a second call must not duplicate the AP-mode knob.
configure_single_box_env >/dev/null 2>&1 || true
AP_MODE_COUNT2=$(grep -cE '^DROPLET_AP_MODE=hostapd$' "$TMP_ROOT/.env" || true)
if [ "$AP_MODE_COUNT2" = "1" ]; then
  pass "configure_single_box_env is idempotent for DROPLET_AP_MODE (no duplicate)"
else
  fail "DROPLET_AP_MODE duplicated/changed on second call (found ${AP_MODE_COUNT2})"
fi

# --- Shape-aware CAMERA_SUBNET (ADR-018 Decision 4 / T5) ------------------
# The compose default CAMERA_SUBNET is 192.168.100.0/24 — the multi-box
# OpenWrt camera VLAN (openwrt/files/etc/config/dhcp `cameras`). On the
# single-box shape the cameras live on the box's own LAN (br-lan,
# 192.168.20.0/24 per scripts/host/etc-droplet-poc-host-net/lan-dhcp.conf),
# NOT on a separate VLAN — so the multi-box default would scan an empty
# subnet and find nothing (the live "camera scan finds nothing" symptom).
# configure_single_box_env must pin CAMERA_SUBNET to the single-box camera
# network so camera-discovery scans where the cameras actually are.
# Two calls already ran above, so this also asserts idempotency.
CAM_SUBNET_COUNT=$(grep -cE '^CAMERA_SUBNET=192\.168\.20\.0/24$' "$TMP_ROOT/.env" || true)
if [ "$CAM_SUBNET_COUNT" = "1" ]; then
  pass "configure_single_box_env sets CAMERA_SUBNET=192.168.20.0/24 (single occurrence, idempotent)"
else
  fail "expected exactly one 'CAMERA_SUBNET=192.168.20.0/24' in .env, found ${CAM_SUBNET_COUNT}"
fi

# The last-wins CAMERA_SUBNET (what docker-compose env_file actually uses)
# must be the single-box network, not the inherited multi-box default. This
# guards against an append-without-strip regression that would leave the
# 192.168.100.0/24 default as the effective value.
CAM_SUBNET_EFFECTIVE=$( { grep -E '^CAMERA_SUBNET=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$CAM_SUBNET_EFFECTIVE" = "192.168.20.0/24" ]; then
  pass "effective (last-wins) CAMERA_SUBNET is the single-box network 192.168.20.0/24"
else
  fail "effective CAMERA_SUBNET is '${CAM_SUBNET_EFFECTIVE}' (expected 192.168.20.0/24)"
fi

# --- Shape-aware WireGuard LAN CIDR/DNS (WARP-839) ------------------------
# The orchestrator's WIREGUARD_LAN_CIDR/WIREGUARD_DNS defaults
# (192.168.50.0/24 + 192.168.50.1 in apps/orchestrator/src/config.ts) are the
# multi-box Pi LAN. The single-box LAN is br-lan 192.168.20.0/24 with the
# gateway + dnsmasq (droplet.local) at 192.168.20.1, so the rendered VPN peer
# .conf must advertise AllowedIPs/DNS on the box LAN or a remote client can't
# reach the dashboard or resolve *.lan. configure_single_box_env must pin both
# knobs to the single-box network. Two calls already ran above, so this also
# asserts idempotency + the effective last-wins value.
WG_CIDR_COUNT=$(grep -cE '^WIREGUARD_LAN_CIDR=192\.168\.20\.0/24$' "$TMP_ROOT/.env" || true)
if [ "$WG_CIDR_COUNT" = "1" ]; then
  pass "configure_single_box_env sets WIREGUARD_LAN_CIDR=192.168.20.0/24 (single occurrence, idempotent)"
else
  fail "expected exactly one 'WIREGUARD_LAN_CIDR=192.168.20.0/24' in .env, found ${WG_CIDR_COUNT}"
fi

# Effective (last-wins) WIREGUARD_LAN_CIDR must be the single-box network, not
# the inherited multi-box 192.168.50.0/24 default — guards an append-without-
# strip regression that would leave the wrong CIDR as the effective value.
WG_CIDR_EFFECTIVE=$( { grep -E '^WIREGUARD_LAN_CIDR=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$WG_CIDR_EFFECTIVE" = "192.168.20.0/24" ]; then
  pass "effective (last-wins) WIREGUARD_LAN_CIDR is the single-box network 192.168.20.0/24"
else
  fail "effective WIREGUARD_LAN_CIDR is '${WG_CIDR_EFFECTIVE}' (expected 192.168.20.0/24)"
fi

WG_DNS_COUNT=$(grep -cE '^WIREGUARD_DNS=192\.168\.20\.1$' "$TMP_ROOT/.env" || true)
if [ "$WG_DNS_COUNT" = "1" ]; then
  pass "configure_single_box_env sets WIREGUARD_DNS=192.168.20.1 (single occurrence, idempotent)"
else
  fail "expected exactly one 'WIREGUARD_DNS=192.168.20.1' in .env, found ${WG_DNS_COUNT}"
fi

# Effective (last-wins) WIREGUARD_DNS must be the single-box gateway/dnsmasq
# (192.168.20.1), not the inherited multi-box 192.168.50.1 default.
WG_DNS_EFFECTIVE=$( { grep -E '^WIREGUARD_DNS=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$WG_DNS_EFFECTIVE" = "192.168.20.1" ]; then
  pass "effective (last-wins) WIREGUARD_DNS is the single-box gateway 192.168.20.1"
else
  fail "effective WIREGUARD_DNS is '${WG_DNS_EFFECTIVE}' (expected 192.168.20.1)"
fi

# ADR-018 item 9: single-box enables switch bring-up auto-provisioning in the
# flat-lan profile (NOT segmented — single-box has no inter-VLAN routing yet,
# item 3). Assert both knobs are written exactly once and stay idempotent
# across the second call above (no duplicate, value unchanged).
SWITCH_AP_COUNT=$(grep -cE '^SWITCH_AUTOPROVISION=1$' "$TMP_ROOT/.env" || true)
if [ "$SWITCH_AP_COUNT" = "1" ]; then
  pass "configure_single_box_env sets SWITCH_AUTOPROVISION=1 (single, idempotent)"
else
  fail "expected exactly one 'SWITCH_AUTOPROVISION=1' in .env, found ${SWITCH_AP_COUNT}"
fi

SWITCH_PROFILE_COUNT=$(grep -cE '^SWITCH_VLAN_PROFILE=flat-lan$' "$TMP_ROOT/.env" || true)
if [ "$SWITCH_PROFILE_COUNT" = "1" ]; then
  pass "configure_single_box_env sets SWITCH_VLAN_PROFILE=flat-lan (single, idempotent)"
else
  fail "expected exactly one 'SWITCH_VLAN_PROFILE=flat-lan' in .env, found ${SWITCH_PROFILE_COUNT}"
fi

# Camera-safety guard: single-box must NEVER bake the segmented profile (it
# would isolate the camera VLAN and cut the working camera + Frigate off).
if grep -qE '^SWITCH_VLAN_PROFILE=segmented$' "$TMP_ROOT/.env"; then
  fail "single-box .env must not set SWITCH_VLAN_PROFILE=segmented (camera-isolation hazard)"
else
  pass "single-box .env does not enable segmented isolation (camera-safe)"
fi

# Rule 12: no host-specific default baked for the protected/uplink port.
if grep -qE '^SWITCH_PROTECTED_PORT=[1-9]' "$TMP_ROOT/.env"; then
  fail "single-box .env must not bake a host-specific SWITCH_PROTECTED_PORT value"
else
  pass "single-box .env does not bake a host-specific SWITCH_PROTECTED_PORT (rule 12)"
fi

# --- Host-net service URLs point at the live droplet_default gateway (WARP-806) -
# On the single-box, routing/switch/oled-display all run with network_mode: host
# and bind the host's :8080/:8081/:8082. The orchestrator runs on the
# droplet_default bridge (gateway 172.18.0.1); docker0 (172.17.0.1) is DOWN. The
# compose default ROUTING/SWITCH/DISPLAY_SERVICE_URL is `host.docker.internal`,
# which the orchestrator's `extra_hosts: host-gateway` resolves to docker0
# (172.17.0.1) — UNREACHABLE — so /api/network, /api/ddns, /api/vpn all fail with
# ECONNREFUSED 172.17.0.1:8080. configure_single_box_env must derive the LIVE
# droplet_default gateway (stubbed to $SB_FAKE_GW at the top of Phase 3) and pin
# these three URLs to it (NOT host.docker.internal, NOT the hardcoded
# 172.17.0.1/172.18.0.1). The two earlier calls above already ran under the stub,
# so these assertions also confirm the derived URLs are idempotent.

# (1) ROUTING_SERVICE_URL — effective value must be the derived bridge gateway.
ROUTING_URL_EFFECTIVE=$( { grep -E '^ROUTING_SERVICE_URL=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$ROUTING_URL_EFFECTIVE" = "http://${SB_FAKE_GW}:8080" ]; then
  pass "ROUTING_SERVICE_URL is the derived droplet_default gateway (http://${SB_FAKE_GW}:8080)"
else
  fail "ROUTING_SERVICE_URL is '${ROUTING_URL_EFFECTIVE}' (expected http://${SB_FAKE_GW}:8080)"
fi

# (2) SWITCH_SERVICE_URL — derived gateway, host port 8081.
SWITCH_URL_EFFECTIVE=$( { grep -E '^SWITCH_SERVICE_URL=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$SWITCH_URL_EFFECTIVE" = "http://${SB_FAKE_GW}:8081" ]; then
  pass "SWITCH_SERVICE_URL is the derived droplet_default gateway (http://${SB_FAKE_GW}:8081)"
else
  fail "SWITCH_SERVICE_URL is '${SWITCH_URL_EFFECTIVE}' (expected http://${SB_FAKE_GW}:8081)"
fi

# (3) DISPLAY_SERVICE_URL — derived gateway, host port 8082.
DISPLAY_URL_EFFECTIVE=$( { grep -E '^DISPLAY_SERVICE_URL=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$DISPLAY_URL_EFFECTIVE" = "http://${SB_FAKE_GW}:8082" ]; then
  pass "DISPLAY_SERVICE_URL is the derived droplet_default gateway (http://${SB_FAKE_GW}:8082)"
else
  fail "DISPLAY_SERVICE_URL is '${DISPLAY_URL_EFFECTIVE}' (expected http://${SB_FAKE_GW}:8082)"
fi

# (AC #2) None of the three may be left as host.docker.internal or docker0.
if { grep -E '^(ROUTING|SWITCH|DISPLAY)_SERVICE_URL=' "$TMP_ROOT/.env" || true; } \
     | grep -qE 'host\.docker\.internal|172\.17\.0\.1'; then
  fail "a host-net SERVICE_URL still points at host.docker.internal/172.17.0.1 (the unreachable docker0)"
else
  pass "no host-net SERVICE_URL points at host.docker.internal/172.17.0.1 (docker0 avoided)"
fi

# (AC #2) The gateway is DERIVED, never the hardcoded 172.18.0.1 literal — assert
# the stubbed gateway (10.99.0.1) won, proving the value came from the inspect
# call and not a baked-in constant.
if { grep -E '^ROUTING_SERVICE_URL=' "$TMP_ROOT/.env" || true; } | grep -qE '172\.18\.0\.1'; then
  fail "ROUTING_SERVICE_URL hardcodes 172.18.0.1 instead of deriving the live gateway"
else
  pass "ROUTING_SERVICE_URL is derived (not the hardcoded 172.18.0.1 literal)"
fi

# Idempotency: each derived URL appears exactly once (two calls already ran).
ROUTING_URL_COUNT=$(grep -cE "^ROUTING_SERVICE_URL=http://${SB_FAKE_GW}:8080$" "$TMP_ROOT/.env" || true)
if [ "$ROUTING_URL_COUNT" = "1" ]; then
  pass "ROUTING_SERVICE_URL written exactly once (idempotent upsert)"
else
  fail "expected exactly one derived ROUTING_SERVICE_URL line, found ${ROUTING_URL_COUNT}"
fi

# --- Wi-Fi scan radio device (WARP-815 K4) -------------------------------
# The orchestrator no longer hardcodes `wlan0` on the /wireless/scan call, so
# the routing service resolves the radio from DROPLET_WIFI_SCAN_DEVICE. The
# single-box AP radio is `wlp14s0` (phy0 inside the openwrt container). The
# value is SOURCED FROM DROPLET_AP_IFACE so it tracks the AP radio if an
# operator overrode it — defaulting to wlp14s0 when unset (matching the AP
# iface default in install_single_box_host_integration). Asserted once +
# idempotent (two configure calls already ran) + effective last-wins value.
WIFI_SCAN_COUNT=$(grep -cE '^DROPLET_WIFI_SCAN_DEVICE=wlp14s0$' "$TMP_ROOT/.env" || true)
if [ "$WIFI_SCAN_COUNT" = "1" ]; then
  pass "configure_single_box_env sets DROPLET_WIFI_SCAN_DEVICE=wlp14s0 (single, idempotent)"
else
  fail "expected exactly one 'DROPLET_WIFI_SCAN_DEVICE=wlp14s0' in .env, found ${WIFI_SCAN_COUNT}"
fi

WIFI_SCAN_EFFECTIVE=$( { grep -E '^DROPLET_WIFI_SCAN_DEVICE=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$WIFI_SCAN_EFFECTIVE" = "wlp14s0" ]; then
  pass "effective (last-wins) DROPLET_WIFI_SCAN_DEVICE is the single-box AP radio wlp14s0"
else
  fail "effective DROPLET_WIFI_SCAN_DEVICE is '${WIFI_SCAN_EFFECTIVE}' (expected wlp14s0)"
fi

# --- Single-box OpenWrt override is intact (WARP-815 K2 regression guard) ---
# K2 reconciles the *documented compose default* OPENWRT_HOST to 192.168.50.1
# (the multi-box router host), but the single-box talks to the in-container
# OpenWrt on 127.0.0.1:8181. configure_single_box_env owns that override and
# MUST keep writing it — this guards against the K2 doc change accidentally
# regressing the working single-box path. Asserted once + idempotent + the
# effective (last-wins) host must NOT be the multi-box 192.168.50.1 default.
OPENWRT_HOST_COUNT=$(grep -cE '^OPENWRT_HOST=127\.0\.0\.1$' "$TMP_ROOT/.env" || true)
if [ "$OPENWRT_HOST_COUNT" = "1" ]; then
  pass "configure_single_box_env keeps OPENWRT_HOST=127.0.0.1 override (single, idempotent)"
else
  fail "expected exactly one 'OPENWRT_HOST=127.0.0.1' in .env, found ${OPENWRT_HOST_COUNT}"
fi

OPENWRT_HOST_EFFECTIVE=$( { grep -E '^OPENWRT_HOST=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$OPENWRT_HOST_EFFECTIVE" = "127.0.0.1" ]; then
  pass "effective (last-wins) OPENWRT_HOST is the single-box in-container 127.0.0.1 (not the 192.168.50.1 multi-box default)"
else
  fail "effective OPENWRT_HOST is '${OPENWRT_HOST_EFFECTIVE}' (expected single-box 127.0.0.1)"
fi

OPENWRT_PORT_EFFECTIVE=$( { grep -E '^OPENWRT_PORT=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$OPENWRT_PORT_EFFECTIVE" = "8181" ]; then
  pass "effective (last-wins) OPENWRT_PORT is the single-box in-container 8181"
else
  fail "effective OPENWRT_PORT is '${OPENWRT_PORT_EFFECTIVE}' (expected single-box 8181)"
fi

OPENWRT_USER_EFFECTIVE=$( { grep -E '^OPENWRT_USERNAME=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$OPENWRT_USER_EFFECTIVE" = "root" ]; then
  pass "effective (last-wins) OPENWRT_USERNAME is the single-box in-container root"
else
  fail "effective OPENWRT_USERNAME is '${OPENWRT_USER_EFFECTIVE}' (expected single-box root)"
fi

# Fail-loud guard: with NO droplet_default network resolvable, the function must
# exit non-zero rather than silently leaving the unreachable host.docker.internal
# default in place. Stub a docker that returns an empty gateway and confirm.
cat > "$SB_STUB_BIN/docker" <<'EOF'
#!/usr/bin/env bash
# Empty-gateway stub: inspection returns nothing (network absent/misconfigured).
if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then
  printf '%s\n' ""
  exit 0
fi
exit 0
EOF
chmod +x "$SB_STUB_BIN/docker"
if configure_single_box_env >/dev/null 2>&1; then
  fail "configure_single_box_env must FAIL when the droplet_default gateway can't be derived (it returned success)"
else
  pass "configure_single_box_env fails loud when the droplet_default gateway can't be derived"
fi

# Restore PATH so Phase 4+ uses the real environment, not the docker stub.
PATH="$SB_OLD_PATH"

# =============================================================================
# Phase 4: install-device-bridge.sh provisions host pairing-QR deps (WARP-654)
# =============================================================================
echo "--- Phase 4: install-device-bridge.sh host deps + AP mode ---"

BRIDGE_INSTALL="$REPO_ROOT_REAL/scripts/install-device-bridge.sh"

# Privileged linear script — not executed in unit tests, but its syntax must
# be valid and its provisioning intent must be present (Phase-1-style static
# assertions; behavioural coverage of the env write lives in Phase 3 above).
if bash -n "$BRIDGE_INSTALL" 2>/dev/null; then
  pass "install-device-bridge.sh passes bash -n syntax check"
else
  fail "install-device-bridge.sh has a bash syntax error"
fi

# (1) The host /usr/bin/python3 that runs droplet-device-bridge.service must be
# able to import qrcode for the pairing-QR render (device-bridge.py imports it
# lazily in the /openwrt/qr path). The installer must provision python3-qrcode.
if grep -q 'python3-qrcode' "$BRIDGE_INSTALL"; then
  pass "install-device-bridge.sh provisions python3-qrcode for the host bridge"
else
  fail "install-device-bridge.sh does not provision python3-qrcode (GET /openwrt/qr -> 'No module named qrcode')"
fi

# (2) It must verify qrcode is importable by the bridge's python so a fresh box
# surfaces a clear failure instead of a silently broken QR endpoint.
if grep -qE 'import qrcode' "$BRIDGE_INSTALL"; then
  pass "install-device-bridge.sh verifies qrcode is importable"
else
  fail "install-device-bridge.sh does not verify qrcode importability"
fi

# (3) Single-box uses hostapd, not a UCI router. The installer must mirror
# DROPLET_AP_MODE from the repo .env into the bridge env via set_env_if_blank
# (never clobbering an operator override). Multi-box leaves it unset, so the
# bridge keeps its uci default.
if grep -qE 'set_env_if_blank "DROPLET_AP_MODE"' "$BRIDGE_INSTALL"; then
  pass "install-device-bridge.sh mirrors DROPLET_AP_MODE into the bridge env"
else
  fail "install-device-bridge.sh does not mirror DROPLET_AP_MODE from .env"
fi

# (4) The old 'no host pip deps to gate on' claim is untrue now that the
# pairing-QR render is a shipping feature with a host dep; the comment must not
# assert there are zero host deps (guard rule 12 — no untruthful docstrings).
if grep -q 'no host pip deps to gate on' "$BRIDGE_INSTALL"; then
  fail "install-device-bridge.sh still claims 'no host pip deps to gate on' (stale after WARP-654 QR feature)"
else
  pass "install-device-bridge.sh comment no longer claims zero host pip deps"
fi

# =============================================================================
# Phase 5: camera-discovery is part of the single-box shape (ADR-018 T5)
# =============================================================================
# Static assertion on docker/docker-compose.yml: the camera-discovery service
# must be reachable on the single-box deployment, which activates the
# COMPOSE_PROFILES set { linux, display, single-box } (see Phase 3 +
# scripts/lib/single-box.sh). The service was previously gated to `full`
# ONLY, which the single-box never activates — so no camera-discovery
# container ran and the camera scan found nothing (the live symptom #5 root
# cause). A compose service runs when ANY of its profiles is active, so the
# fix is to add `single-box` to the service's profile list (NOT to drop the
# profile guard, which would force it onto macOS dev installs).
echo "--- Phase 5: camera-discovery enabled on single-box (compose profile) ---"

COMPOSE_FILE_REAL="$REPO_ROOT_REAL/docker/docker-compose.yml"

# Extract the `profiles:` line that belongs to the camera-discovery service.
# The service block starts at `  camera-discovery:` and ends at the next
# top-level (2-space-indented) service key. awk captures the profiles line
# within that window.
CAM_PROFILES_LINE=$(awk '
  /^  camera-discovery:[[:space:]]*$/ { in_svc=1; next }
  in_svc && /^  [a-z]/               { in_svc=0 }
  in_svc && /^[[:space:]]+profiles:/ { print; exit }
' "$COMPOSE_FILE_REAL")

if printf '%s' "$CAM_PROFILES_LINE" | grep -q 'single-box'; then
  pass "camera-discovery profiles include single-box (runs on the single-box shape)"
else
  fail "camera-discovery profiles do NOT include single-box — orphaned on single-box (found: '${CAM_PROFILES_LINE}')"
fi

# Defence against scope-creep / regression: the service must STILL keep the
# `full` profile so the multi-box / explicit-full path is unchanged.
if printf '%s' "$CAM_PROFILES_LINE" | grep -q 'full'; then
  pass "camera-discovery still keeps the full profile (multi-box path unchanged)"
else
  fail "camera-discovery lost the full profile (regressed the multi-box/full path)"
fi

# =============================================================================
# Phase 6: USB/NVMe hot-plug auto-mount is installed by setup (single-box)
# =============================================================================
# The udev rule + droplet-automount@.service are what make a drive added or
# swapped at runtime auto-mount under /mnt/droplet and surface in the dashboard
# (the device-bridge merges the automount state with /proc/mounts). They ship
# under services/automount/ but only become active once installed — setup.sh
# must invoke services/automount/install.sh in the single-box host-integration
# block, or a fresh box never auto-mounts a hot-plugged drive.
echo "--- Phase 6: automount installed on setup + safe by default ---"

SETUP_SH_REAL="$REPO_ROOT_REAL/scripts/setup.sh"
AUTOMOUNT_INSTALL="$REPO_ROOT_REAL/services/automount/install.sh"
AUTOMOUNT_RULES="$REPO_ROOT_REAL/services/automount/99-droplet-automount.rules"

# (1) setup.sh must wire the automount installer in the single-box flow.
if grep -qE 'services/automount/install\.sh' "$SETUP_SH_REAL"; then
  pass "setup.sh installs the USB auto-mount service (services/automount/install.sh)"
else
  fail "setup.sh does NOT install services/automount/install.sh — hot-plug drives won't auto-mount on a fresh box"
fi

# (2) Privileged linear script — not executed here, but syntax must be valid
# (same posture as install-device-bridge.sh in Phase 4).
if bash -n "$AUTOMOUNT_INSTALL" 2>/dev/null; then
  pass "services/automount/install.sh passes bash -n syntax check"
else
  fail "services/automount/install.sh has a bash syntax error"
fi

# (3) Safety: the installer must NOT sweep/adopt already-attached drives at
# install time (a provisioning foot-gun — a stray drive plugged in during setup
# must not be silently mounted). First mount happens on the next hot-plug;
# deliberate wipe+adopt is the opt-in setup step, never install.
if grep -qE 'udevadm[[:space:]]+trigger' "$AUTOMOUNT_INSTALL"; then
  fail "services/automount/install.sh runs 'udevadm trigger' — sweeps attached drives at install (foot-gun)"
else
  pass "services/automount/install.sh does not sweep attached drives at install"
fi

# (4) Safety: the udev rule must never auto-mount the OS/boot disk — assert the
# EFI/BOOT system-partition label exclusions are present.
if grep -q 'ID_FS_LABEL}=="EFI"' "$AUTOMOUNT_RULES" \
   && grep -q 'ID_FS_LABEL}=="BOOT"' "$AUTOMOUNT_RULES"; then
  pass "automount udev rule excludes EFI/BOOT system partitions (never mounts the OS disk)"
else
  fail "automount udev rule is missing the EFI/BOOT system-partition exclusions"
fi

# =============================================================================
# Phase 7: setup.sh lock lifecycle (box-strand fix)
# =============================================================================
# Two failure modes stranded the box after an interrupted setup:
#   (a) the lock was released only on the happy path, so a non-zero exit (e.g.
#       the benign "seeder failed (exit 1)") left .setup.lock behind and the
#       next run aborted with "Another setup is running". Fix: release it from
#       an EXIT trap that runs on every exit path.
#   (b) even with the lock present, the staleness check was purely age-based
#       (1 h), so a SIGKILL'd / power-lost run blocked re-provisioning for an
#       hour. Fix: reclaim a lock whose recorded PID is no longer alive.
# Static assertions verify the wiring; behavioural assertions exercise the REAL
# _acquire_lock / _release_lock extracted from setup.sh (not a copy).
echo "--- Phase 7: setup.sh lock lifecycle ---"

SETUP_SH="$REPO_ROOT_REAL/scripts/setup.sh"

# (1) Static: the lock must be released from an EXIT trap, not just inline.
if grep -qE '^[[:space:]]*trap[[:space:]]+_release_lock[[:space:]]+EXIT' "$SETUP_SH"; then
  pass "setup.sh releases the lock from an EXIT trap (survives non-zero exits)"
else
  fail "setup.sh has no 'trap _release_lock EXIT' — a failed run strands .setup.lock"
fi

# (2) Static: the acquire path must be stale-aware (reclaim a dead PID's lock).
if grep -qE 'kill -0' "$SETUP_SH"; then
  pass "_acquire_lock is stale-aware (kill -0 liveness check on the recorded PID)"
else
  fail "_acquire_lock has no PID-liveness check — a crashed run blocks re-provision for ~1h"
fi

# --- Behavioural: extract the real lock functions and exercise them ----------
# Pull the exact function source out of setup.sh (start at the def line, stop at
# the first column-0 `}`) and eval it, so we test the shipping code, not a copy.
eval "$(awk '/^_acquire_lock\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SETUP_SH")"
eval "$(awk '/^_release_lock\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SETUP_SH")"

LOCK_FILE="$TMP_ROOT/.data/.setup.lock"   # consumed by the eval'd functions
mkdir -p "$(dirname "$LOCK_FILE")"

# (3) Empty/garbage lock file → reclaimed (acquire succeeds, writes a live PID).
: > "$LOCK_FILE"
if ( _acquire_lock ) >/dev/null 2>&1 && [ -s "$LOCK_FILE" ]; then
  pass "_acquire_lock reclaims an empty/garbage lock file"
else
  fail "_acquire_lock did not reclaim an empty lock file"
fi
rm -f "$LOCK_FILE"

# (4) Dead-PID lock → reclaimed. Spawn a process, reap it, reuse its dead PID.
sleep 0.1 & dead_pid=$!
wait "$dead_pid" 2>/dev/null || true
echo "$dead_pid" > "$LOCK_FILE"
if ( _acquire_lock ) >/dev/null 2>&1; then
  pass "_acquire_lock reclaims a lock whose recorded PID is dead (no 1h wait)"
else
  fail "_acquire_lock refused a dead-PID lock (box would stay stranded)"
fi
rm -f "$LOCK_FILE"

# (5) Live-PID, fresh lock → refused (the real concurrency guard still holds).
echo $$ > "$LOCK_FILE"   # our own PID: alive, just written (age ~0)
if ( _acquire_lock ) >/dev/null 2>&1; then
  fail "_acquire_lock granted a lock held by a live PID (concurrency guard broken)"
else
  pass "_acquire_lock still refuses a fresh lock held by a live process"
fi
rm -f "$LOCK_FILE"

# (6) _release_lock removes the lock file.
echo $$ > "$LOCK_FILE"
_release_lock
if [ ! -f "$LOCK_FILE" ]; then
  pass "_release_lock removes the lock file"
else
  fail "_release_lock left the lock file in place"
fi

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ $FAILURES -gt 0 ]; then
  printf " (\033[31m%d failed\033[0m)" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit $FAILURES
