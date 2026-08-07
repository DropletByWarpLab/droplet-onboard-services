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

# Stub out artifact-writing helpers before sourcing secrets.sh
# (_generate_mosquitto_passwd was retired by WARP-235 — MQTT is mTLS-only)
_write_mosquitto_conf()       { return 0; }
_write_mosquitto_acl()        { return 0; }
_generate_tls_cert()          { return 0; }

# shellcheck source=../scripts/lib/secrets.sh
source "$REPO_ROOT_REAL/scripts/lib/secrets.sh"

# Re-stub after sourcing secrets.sh (it defines these functions — override them)
_write_mosquitto_conf()       { return 0; }
_write_mosquitto_acl()        { return 0; }
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

# --- DROPLET_TPM_BACKEND scaffold guard (IDX-002) -------------------------
# The 'real' (tpm2-pytss) device-identity backend is an UNFINISHED scaffold:
# device-identity-svc (services/device-identity-svc/backends/__init__.py)
# fails closed on it unless DROPLET_TPM_ALLOW_SCAFFOLD is set. generate_env
# must therefore never auto-select 'real' — even on a TPM host it would
# crash-loop the sidecar. Default to 'mock' until the tss2 path lands.
DI_BACKEND=$( { grep -E '^DROPLET_TPM_BACKEND=' "$TMP_ROOT/.env" || true; } | head -n1 | cut -d= -f2- )
if [ "$DI_BACKEND" = "mock" ]; then
  pass "generate_env selects DROPLET_TPM_BACKEND=mock (never the fail-closed scaffold)"
else
  fail "generate_env set DROPLET_TPM_BACKEND=$DI_BACKEND (expected mock; 'real' crash-loops the sidecar)"
fi

# migrate_env must flip a pre-existing auto-selected 'real' (no scaffold
# opt-in) back to 'mock' so an upgraded TPM box stops crash-looping.
sed -i.bak -E 's|^DROPLET_TPM_BACKEND=.*$|DROPLET_TPM_BACKEND=real|' "$TMP_ROOT/.env" && rm -f "$TMP_ROOT/.env.bak"
migrate_env >/dev/null 2>&1 || true
DI_BACKEND_AFTER=$( { grep -E '^DROPLET_TPM_BACKEND=' "$TMP_ROOT/.env" || true; } | head -n1 | cut -d= -f2- )
if [ "$DI_BACKEND_AFTER" = "mock" ]; then
  pass "migrate_env flips auto-selected DROPLET_TPM_BACKEND real→mock (no scaffold opt-in)"
else
  fail "migrate_env left DROPLET_TPM_BACKEND=$DI_BACKEND_AFTER (expected mock — upgraded TPM box crash-loops)"
fi

# migrate_env must PRESERVE a knowing scaffold opt-in (real + ALLOW_SCAFFOLD).
sed -i.bak -E 's|^DROPLET_TPM_BACKEND=.*$|DROPLET_TPM_BACKEND=real|' "$TMP_ROOT/.env" && rm -f "$TMP_ROOT/.env.bak"
printf 'DROPLET_TPM_ALLOW_SCAFFOLD=1\n' >> "$TMP_ROOT/.env"
migrate_env >/dev/null 2>&1 || true
DI_BACKEND_OPTIN=$( { grep -E '^DROPLET_TPM_BACKEND=' "$TMP_ROOT/.env" || true; } | head -n1 | cut -d= -f2- )
if [ "$DI_BACKEND_OPTIN" = "real" ]; then
  pass "migrate_env preserves a knowing scaffold opt-in (real + DROPLET_TPM_ALLOW_SCAFFOLD)"
else
  fail "migrate_env changed an opted-in DROPLET_TPM_BACKEND to $DI_BACKEND_OPTIN (should stay real)"
fi
# Clean the opt-in back out so later phases see the default posture.
sed -i.bak -E '/^DROPLET_TPM_ALLOW_SCAFFOLD=/d' "$TMP_ROOT/.env" && rm -f "$TMP_ROOT/.env.bak"

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
# 192.168.20.0/24 per scripts/host/etc-droplet-host-net/lan-dhcp.conf),
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

# --- WARP-444: single-box knobs block — surgical replace + dedupe ----------
# configure_single_box_env's descriptive comment block used to be appended
# blindly (then skipped-when-present), so setup retries left duplicate stale
# blocks in .env forever — the live box accumulated three. The block is now
# surgically REPLACED on every run: every existing copy (marker line + its
# enclosing comment fences + one blank spacer) is stripped and exactly one
# fresh copy appended. Only comment/blank lines are removed, so KEY=value
# lines interleaved between stale blocks must survive.
SB_BLOCK_MARKER='Single-box deployment knobs (managed by scripts/lib/single-box.sh'

# (1) Two configure calls already ran above → exactly ONE block (the WARP-444
# acceptance: running twice produces one block, not two).
SB_BLOCK_COUNT=$(grep -cF "$SB_BLOCK_MARKER" "$TMP_ROOT/.env" || true)
if [ "$SB_BLOCK_COUNT" = "1" ]; then
  pass "knobs block appears exactly once after two configure calls (replace, not append)"
else
  fail "expected exactly one single-box knobs block marker in .env, found ${SB_BLOCK_COUNT}"
fi

# (2) Pre-existing duplicates — the live-host state this ticket came from —
# must collapse to one on the next run. Seed two stale copies shaped like the
# real block (fence + marker + prose + fence), with a KEY=value line BETWEEN
# them so the strip is proven surgical (comments only, keys survive).
{
  printf '\n# ============================================================================\n'
  printf '# Single-box deployment knobs (managed by scripts/lib/single-box.sh —\n'
  printf '#   WARP-444 test seed: STALE COPY ONE, must be deduped on the next run.\n'
  printf '# ============================================================================\n'
  printf 'SB_DEDUPE_CANARY=survives\n'
  printf '\n# ============================================================================\n'
  printf '# Single-box deployment knobs (managed by scripts/lib/single-box.sh —\n'
  printf '#   WARP-444 test seed: STALE COPY TWO, must be deduped on the next run.\n'
  printf '# ============================================================================\n'
} >> "$TMP_ROOT/.env"

SB_BLOCK_COUNT_SEEDED=$(grep -cF "$SB_BLOCK_MARKER" "$TMP_ROOT/.env" || true)
if [ "$SB_BLOCK_COUNT_SEEDED" = "3" ]; then
  pass "duplicate-block seed applied (3 block markers in .env)"
else
  fail "duplicate-block seed wrong (expected 3 markers, found ${SB_BLOCK_COUNT_SEEDED})"
fi

SB_REPLACE_OUT=$(configure_single_box_env 2>&1 || true)

SB_BLOCK_COUNT_AFTER=$(grep -cF "$SB_BLOCK_MARKER" "$TMP_ROOT/.env" || true)
if [ "$SB_BLOCK_COUNT_AFTER" = "1" ]; then
  pass "configure_single_box_env dedupes pre-existing duplicate blocks to exactly one"
else
  fail "expected exactly one block marker after dedupe run, found ${SB_BLOCK_COUNT_AFTER}"
fi

# The stale copies are gone in full (prose included), not just their markers.
if grep -q 'STALE COPY' "$TMP_ROOT/.env"; then
  fail "stale block prose still present after dedupe run (strip was not block-wide)"
else
  pass "stale block prose fully removed (marker + fences + comment lines)"
fi

# Surgical: the KEY=value line seeded BETWEEN the stale blocks survived.
if grep -qE '^SB_DEDUPE_CANARY=survives$' "$TMP_ROOT/.env"; then
  pass "KEY=value line between stale blocks survives the strip (comments-only removal)"
else
  fail "SB_DEDUPE_CANARY lost — block strip removed a non-comment line"
fi

# Live-stack secrets written by generate_env are untouched by the rewrite.
if grep -qE '^POSTGRES_PASSWORD=.+' "$TMP_ROOT/.env"; then
  pass "unrelated secrets (POSTGRES_PASSWORD) survive the block replace"
else
  fail "POSTGRES_PASSWORD missing after block replace — rewrite ate live keys"
fi

# The replace announces itself (the operator debugging a retry loop must see
# that the block was refreshed, not silently skipped).
if printf '%s' "$SB_REPLACE_OUT" | grep -qF 'Replaced existing single-box block in .env'; then
  pass "replace run logs 'Replaced existing single-box block in .env'"
else
  fail "missing 'Replaced existing single-box block in .env' log line on a replace run"
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
# Phase 8: Nextcloud post-install hook reconcile on bring-up (WARP-990)
# =============================================================================
# docker/nextcloud-init.sh (household group + "Household" group folder +
# document-engine connector) is mounted as the official image's before-starting
# hook (WARP-1694). It used to be the post-installation hook, which fires ONLY
# on the single boot that auto-installs into an EMPTY nextcloud-data volume: a
# volume-preserving reset/reflash never re-enters that window, so a reflashed
# box came up with a bare Nextcloud (occ group:list → only "admin") and the
# setup wizard's account creation 500'd (WARP-989); and a no-wipe deploy never
# reconciled at all. start_stack must additionally wait for `php occ status` to report
# installed (bounded retry) and re-exec the SAME mounted hook — idempotent,
# single source of truth — on every bring-up, loudly surfacing but never
# fataling on a hook failure. Static wiring asserts + behavioural runs of the
# sentinel-delimited functions against a stubbed run_docker_compose (mirrors
# tests/single-box-openwrt-readiness.test.sh).
echo "--- Phase 8: Nextcloud post-install hook reconcile (WARP-990) ---"

NC_HOOK_PATH="/docker-entrypoint-hooks.d/before-starting/init-droplet.sh"

# (1) Both reconcile functions are present and sentinel-delimited (the markers
# are the extraction contract for the behavioural asserts below).
if grep -qF "# >>> wait_for_nextcloud_installed (WARP-990)" "$COMPOSE_LIB" \
   && grep -qF "# <<< wait_for_nextcloud_installed (WARP-990)" "$COMPOSE_LIB"; then
  pass "wait_for_nextcloud_installed sentinel markers present in compose.sh"
else
  fail "wait_for_nextcloud_installed sentinel markers missing from compose.sh"
fi

if grep -qF "# >>> run_nextcloud_post_install_hook (WARP-990)" "$COMPOSE_LIB" \
   && grep -qF "# <<< run_nextcloud_post_install_hook (WARP-990)" "$COMPOSE_LIB"; then
  pass "run_nextcloud_post_install_hook sentinel markers present in compose.sh"
else
  fail "run_nextcloud_post_install_hook sentinel markers missing from compose.sh"
fi

# (2) start_stack invokes the reconcile — hooked where the stack is brought up
# (fresh install, re-provision, factory-reset --reinstall, and the reflash
# recipes all re-run setup.sh → start_stack), not in a one-off installer.
START_STACK_BODY="$(awk '/^start_stack\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$COMPOSE_LIB")"
if printf '%s' "$START_STACK_BODY" | grep -q 'run_nextcloud_post_install_hook'; then
  pass "start_stack invokes run_nextcloud_post_install_hook (every bring-up path reconciles)"
else
  fail "start_stack does not invoke run_nextcloud_post_install_hook — a reflashed box stays unprovisioned (WARP-990)"
fi

# (3) The readiness gate is `php occ status` inside the container (the honest
# installed signal), not only the curl-based status.php wait.
if grep -q 'php occ status' "$COMPOSE_LIB"; then
  pass "compose.sh gates the reconcile on 'php occ status' (installed signal)"
else
  fail "compose.sh does not probe 'php occ status' before the reconcile"
fi

# (4) Single source of truth: compose.sh execs the MOUNTED hook path…
if grep -qF "$NC_HOOK_PATH" "$COMPOSE_LIB"; then
  pass "compose.sh execs the mounted hook path ($NC_HOOK_PATH)"
else
  fail "compose.sh does not reference the mounted hook path — reconcile must exec $NC_HOOK_PATH"
fi

# …which docker-compose.yml actually mounts docker/nextcloud-init.sh at…
if grep -qE '\./nextcloud-init\.sh:/docker-entrypoint-hooks\.d/before-starting/init-droplet\.sh' "$COMPOSE_FILE_REAL"; then
  pass "docker-compose.yml mounts nextcloud-init.sh at the exec'd hook path (paths agree)"
else
  fail "docker-compose.yml no longer mounts nextcloud-init.sh at $NC_HOOK_PATH — the reconcile exec would 404"
fi

# WARP-1694 — and specifically NOT back in post-installation. That slot fires
# only on the boot that auto-installs, so a box that is already installed never
# re-runs the hook: a no-wipe deploy (`docker compose up -d`, no setup.sh, so no
# start_stack reconcile) silently does not converge. Found live on .250 when a
# DOCS_ENGINE change did not take. This assertion is the regression guard —
# `before-starting` runs on EVERY container start.
if grep -qE '\./nextcloud-init\.sh:/docker-entrypoint-hooks\.d/post-installation/' "$COMPOSE_FILE_REAL"; then
  fail "docker-compose.yml mounts nextcloud-init.sh at post-installation — that fires only on the install boot, so an installed box never reconciles (WARP-1694)"
else
  pass "nextcloud-init.sh is not mounted at post-installation (every-boot reconcile preserved — WARP-1694)"
fi

# …and compose.sh never reimplements the hook's occ steps (the script stays
# the ONLY implementation).
if grep -qE 'group:add|groupfolders:|app:install' "$COMPOSE_LIB"; then
  fail "compose.sh duplicates nextcloud-init.sh provisioning logic (group:add/groupfolders/app:install) — single-source-of-truth violated"
else
  pass "compose.sh does not duplicate nextcloud-init.sh logic (hook stays the single implementation)"
fi

# (5) Both execs run as uid 33 (www-data) — occ refuses any user other than
# the config.php owner (the root-context foot-gun the hook itself documents).
NC_UID33_COUNT=$(grep -cE 'exec -T -u 33 nextcloud' "$COMPOSE_LIB" || true)
if [ "$NC_UID33_COUNT" -ge 2 ]; then
  pass "occ probe + hook exec both run as uid 33 (www-data, config.php owner)"
else
  fail "expected >= 2 'exec -T -u 33 nextcloud' calls in compose.sh, found ${NC_UID33_COUNT} (occ owner check would trip)"
fi

# (6) WARP-1064: the auto-install recovery is present and wired into the
# wait-failure path (a stuck volume reports installed:false forever — waiting
# longer can never fix it, so the reconcile must attempt `occ
# maintenance:install` before giving up).
if grep -qF "# >>> recover_nextcloud_autoinstall (WARP-1064)" "$COMPOSE_LIB" \
   && grep -qF "# <<< recover_nextcloud_autoinstall (WARP-1064)" "$COMPOSE_LIB"; then
  pass "recover_nextcloud_autoinstall sentinel markers present in compose.sh"
else
  fail "recover_nextcloud_autoinstall sentinel markers missing from compose.sh"
fi
NC_RUNNER_BODY="$(awk '/^run_nextcloud_post_install_hook\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$COMPOSE_LIB")"
if printf '%s' "$NC_RUNNER_BODY" | grep -q 'recover_nextcloud_autoinstall'; then
  pass "run_nextcloud_post_install_hook attempts the WARP-1064 recovery when the wait expires"
else
  fail "run_nextcloud_post_install_hook does not invoke recover_nextcloud_autoinstall — a never-auto-installed box stays degraded forever"
fi
# The stale-DB recreate must stay scoped to the `nextcloud` database only —
# a regression here could nuke the orchestrator's `droplet` database.
if grep -qF 'DROP DATABASE IF EXISTS nextcloud WITH (FORCE)' "$COMPOSE_LIB" \
   && ! grep -qF 'DROP DATABASE IF EXISTS droplet' "$COMPOSE_LIB"; then
  pass "recovery's stale-DB recreate is scoped to the nextcloud database"
else
  fail "recovery's stale-DB recreate is missing or not scoped to the nextcloud database"
fi

# --- Behavioural: extract the shipping functions, stub run_docker_compose ----
NC_WORK="$TMP_ROOT/nc-hook"
mkdir -p "$NC_WORK"

sed -n '/# >>> wait_for_nextcloud_installed (WARP-990)/,/# <<< wait_for_nextcloud_installed (WARP-990)/p' \
  "$COMPOSE_LIB" > "$NC_WORK/funcs.sh"
sed -n '/# >>> recover_nextcloud_autoinstall (WARP-1064)/,/# <<< recover_nextcloud_autoinstall (WARP-1064)/p' \
  "$COMPOSE_LIB" >> "$NC_WORK/funcs.sh"
sed -n '/# >>> run_nextcloud_post_install_hook (WARP-990)/,/# <<< run_nextcloud_post_install_hook (WARP-990)/p' \
  "$COMPOSE_LIB" >> "$NC_WORK/funcs.sh"
sed -n '/# >>> apply_file_indexer_nc_grants (WARP-1328)/,/# <<< apply_file_indexer_nc_grants (WARP-1328)/p' \
  "$COMPOSE_LIB" >> "$NC_WORK/funcs.sh"

if grep -q 'wait_for_nextcloud_installed()' "$NC_WORK/funcs.sh" \
   && grep -q 'recover_nextcloud_autoinstall()' "$NC_WORK/funcs.sh" \
   && grep -q 'run_nextcloud_post_install_hook()' "$NC_WORK/funcs.sh" \
   && grep -q 'apply_file_indexer_nc_grants()' "$NC_WORK/funcs.sh"; then
  pass "extracted the WARP-990 + WARP-1064 function bodies from compose.sh"
else
  fail "could not extract the WARP-990/WARP-1064 function bodies — skipping behavioural asserts"
fi

# Shims + a scriptable run_docker_compose. `php occ status` flips to installed
# once the call count reaches $NC_STUB_STATE/installed_after; the hook exec
# records its argv and exits with $NC_STUB_STATE/hook_rc.
cat > "$NC_WORK/stub.sh" <<'NCSTUB'
log_info()    { :; }
log_warn()    { :; }
log_success() { :; }
log_error()   { printf 'error %s\n' "$*" >&2; }
sleep()       { :; }

run_docker_compose() {
  local sd="${NC_STUB_STATE:?NC_STUB_STATE unset}" n
  case "$*" in
    *"php occ status"*)
      n=$(( $(cat "$sd/occ_calls" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$sd/occ_calls"
      if [ "$n" -ge "$(cat "$sd/installed_after")" ]; then
        printf '{"installed":true,"versionstring":"29.0.0"}\n'
      else
        printf '{"installed":false}\n'
      fi
      return 0
      ;;
    *"init-droplet.sh"*)
      n=$(( $(cat "$sd/hook_calls" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$sd/hook_calls"
      printf '%s' "$*" > "$sd/hook_argv"
      echo "[droplet] stub hook transcript"
      return "$(cat "$sd/hook_rc" 2>/dev/null || echo 0)"
      ;;
    # WARP-1064: the recovery's `occ maintenance:install` exec. On stub
    # success (recovery_rc=0) the NEXT occ status probe reports installed —
    # mirror that by lowering installed_after to the current call count.
    *"maintenance:install"*)
      n=$(( $(cat "$sd/recovery_calls" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$sd/recovery_calls"
      printf '%s' "$*" > "$sd/recovery_argv"
      if [ "$(cat "$sd/recovery_rc" 2>/dev/null || echo 1)" = "0" ]; then
        cat "$sd/occ_calls" 2>/dev/null > "$sd/installed_after" || echo 0 > "$sd/installed_after"
        return 0
      fi
      return 1
      ;;
    # WARP-1328: the file-indexer oc_* read-grant exec. Records argv; exit
    # scriptable via $NC_STUB_STATE/grants_rc (default 0). MUST precede the
    # generic psql arm below.
    *"GRANT CONNECT"*)
      n=$(( $(cat "$sd/grants_calls" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$sd/grants_calls"
      printf '%s' "$*" > "$sd/grants_argv"
      return "$(cat "$sd/grants_rc" 2>/dev/null || echo 0)"
      ;;
    # WARP-1064: the recovery's stale-DB probe/recreate (psql in the db
    # service). Report "no stale schema" (empty stdout, rc 0).
    *" db psql"*|*"psql -U"*)
      return 0
      ;;
    # WARP-1064: the entrypoint-initializing probe (apache2 /proc scan).
    # Prints "initializing" until the call count reaches ep_serving_after,
    # then "serving" (default 1 = serving on the first probe, no hold-off).
    *"/proc/"*)
      n=$(( $(cat "$sd/ep_probe_calls" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$sd/ep_probe_calls"
      if [ "$n" -ge "$(cat "$sd/ep_serving_after" 2>/dev/null || echo 1)" ]; then
        echo "serving"
      else
        echo "initializing"
      fi
      return 0
      ;;
  esac
  return 0
}
NCSTUB

# Run one extracted entrypoint against the stub. State survives the call so
# assertions can read $NC_WORK/state afterwards. Tunables: NC_TRIES (poll
# budget, default 8); NC_RECOVERY_RC (WARP-1064 recovery-install stub exit,
# default 1 = recovery fails, preserving the pre-recovery semantics of the
# never-installed cases); NC_EP_SERVING_AFTER (probe count at which the
# entrypoint-initializing scan flips to "serving", default 1 = no hold-off);
# intervals are zeroed and sleep is shimmed, so the loop never burns
# wall-clock time.
run_nc_case() {
  local installed_after="$1" hook_rc="$2" entry="$3"
  local sd="$NC_WORK/state"
  rm -rf "$sd"; mkdir -p "$sd"
  printf '%s' "$installed_after" > "$sd/installed_after"
  printf '%s' "$hook_rc" > "$sd/hook_rc"
  printf '%s' "${NC_RECOVERY_RC:-1}" > "$sd/recovery_rc"
  printf '%s' "${NC_GRANTS_RC:-0}" > "$sd/grants_rc"
  printf '%s' "${NC_EP_SERVING_AFTER:-1}" > "$sd/ep_serving_after"
  NC_STUB_STATE="$sd" \
  NEXTCLOUD_OCC_READY_TRIES="${NC_TRIES:-8}" \
  NEXTCLOUD_OCC_READY_INTERVAL=0 \
  NEXTCLOUD_ENTRYPOINT_WAIT_TRIES=10 \
  NEXTCLOUD_ENTRYPOINT_WAIT_INTERVAL=0 \
  COMPOSE_FILE=/dev/null \
  COMPOSE_ENV_FILE=/dev/null \
  LOG_FILE="$sd/setup.log" \
  bash -c "
    set -euo pipefail
    . '$NC_WORK/stub.sh'
    . '$NC_WORK/funcs.sh'
    $entry
  "
}

# (B1) Installed on the first probe → wait succeeds immediately.
if run_nc_case 1 0 wait_for_nextcloud_installed >/dev/null 2>&1; then
  pass "wait_for_nextcloud_installed succeeds when occ reports installed"
else
  fail "wait_for_nextcloud_installed failed for an immediately-installed Nextcloud"
fi

# (B2) Installed only on the 3rd probe → bounded retry keeps polling (the
# first-boot install-in-progress window), then succeeds.
if run_nc_case 3 0 wait_for_nextcloud_installed >/dev/null 2>&1 \
   && [ "$(cat "$NC_WORK/state/occ_calls" 2>/dev/null || echo 0)" = "3" ]; then
  pass "wait_for_nextcloud_installed retries past 'not installed yet' and succeeds (bounded poll)"
else
  fail "wait_for_nextcloud_installed did not poll through an install-in-progress window"
fi

# (B3) Never installed → gives up non-zero within the budget (no hang).
if NC_TRIES=4 run_nc_case 9999 0 wait_for_nextcloud_installed >/dev/null 2>&1; then
  fail "wait_for_nextcloud_installed returned success for a never-installed Nextcloud"
else
  pass "wait_for_nextcloud_installed gives up cleanly (non-zero) when installed never arrives"
fi

# (B4) Happy path: installed + hook exit 0 → runner succeeds and execs the
# mounted hook exactly once, as uid 33, in the nextcloud service.
if run_nc_case 1 0 run_nextcloud_post_install_hook >/dev/null 2>&1; then
  pass "run_nextcloud_post_install_hook returns 0 on a clean reconcile"
else
  fail "run_nextcloud_post_install_hook failed on the happy path"
fi
NC_HOOK_CALLS="$(cat "$NC_WORK/state/hook_calls" 2>/dev/null || echo 0)"
NC_HOOK_ARGV="$(cat "$NC_WORK/state/hook_argv" 2>/dev/null || echo '')"
if [ "$NC_HOOK_CALLS" = "1" ]; then
  pass "hook exec'd exactly once per bring-up"
else
  fail "hook exec'd ${NC_HOOK_CALLS} times (expected exactly 1)"
fi
if printf '%s' "$NC_HOOK_ARGV" | grep -qF -- "-u 33" \
   && printf '%s' "$NC_HOOK_ARGV" | grep -qF "nextcloud bash $NC_HOOK_PATH"; then
  pass "hook exec targets the nextcloud service as uid 33 at the mounted path"
else
  fail "hook exec argv wrong (got: '${NC_HOOK_ARGV}')"
fi

# WARP-1328: the same bring-up must apply the file-indexer oc_* read grants.
NC_GRANTS_CALLS="$(cat "$NC_WORK/state/grants_calls" 2>/dev/null || echo 0)"
NC_GRANTS_ARGV="$(cat "$NC_WORK/state/grants_argv" 2>/dev/null || echo '')"
if [ "$NC_GRANTS_CALLS" = "1" ]; then
  pass "file-indexer oc_* grants applied exactly once per bring-up (WARP-1328)"
else
  fail "file-indexer oc_* grants exec'd ${NC_GRANTS_CALLS} times (expected exactly 1) — WARP-1328"
fi
if printf '%s' "$NC_GRANTS_ARGV" | grep -qF -- "-d nextcloud" \
   && printf '%s' "$NC_GRANTS_ARGV" | grep -qF "GRANT USAGE ON SCHEMA public" \
   && printf '%s' "$NC_GRANTS_ARGV" | grep -qF "GRANT SELECT ON public.oc_storages, public.oc_filecache"; then
  pass "grants exec targets the nextcloud DB with schema USAGE + oc_* SELECT (WARP-1328)"
else
  fail "grants exec argv wrong (got: '${NC_GRANTS_ARGV}')"
fi

# WARP-1328: a failing grant exec must be loud-but-non-fatal, like the hook.
if NC_GRANTS_RC=1 run_nc_case 1 0 run_nextcloud_post_install_hook >/dev/null 2>&1; then
  pass "grant failure is non-fatal to setup (WARP-1328)"
else
  fail "grant failure aborted the runner — must be non-fatal to setup (WARP-1328)"
fi

# (B5) Hook fails (exit 7) → NON-FATAL to setup (runner still exits 0) but
# LOUD: the exit code is surfaced on stderr with the manual recovery command.
NC_ERR="$NC_WORK/hook-fail.stderr"
if run_nc_case 1 7 run_nextcloud_post_install_hook >/dev/null 2>"$NC_ERR"; then
  pass "hook failure is non-fatal to setup (runner exits 0)"
else
  fail "hook failure aborted the runner — must be non-fatal to setup"
fi
if grep -q 'exit 7' "$NC_ERR"; then
  pass "hook failure surfaces the exit code loudly (exit 7 on stderr)"
else
  fail "hook failure did not surface the exit code (stderr: $(head -3 "$NC_ERR" 2>/dev/null))"
fi

# (B6) Nextcloud never installed → the hook is NOT exec'd (no blind fire),
# the runner stays non-fatal, and the skip is loud (WARP-990 on stderr).
NC_ERR2="$NC_WORK/never-installed.stderr"
if NC_TRIES=3 run_nc_case 9999 0 run_nextcloud_post_install_hook >/dev/null 2>"$NC_ERR2"; then
  pass "never-installed Nextcloud keeps the runner non-fatal (exits 0)"
else
  fail "never-installed Nextcloud aborted the runner — must be non-fatal to setup"
fi
if [ ! -f "$NC_WORK/state/hook_calls" ]; then
  pass "hook is not exec'd when Nextcloud never reports installed (no blind fire)"
else
  fail "hook was exec'd against a not-installed Nextcloud"
fi
if grep -q 'WARP-990' "$NC_ERR2"; then
  pass "skipped reconcile is loud (WARP-990 called out on stderr)"
else
  fail "skipped reconcile is silent — must be loud on stderr"
fi
if [ "$(cat "$NC_WORK/state/recovery_calls" 2>/dev/null || echo 0)" = "1" ]; then
  pass "WARP-1064 recovery install was attempted before declaring the box degraded"
else
  fail "WARP-1064 recovery install was not attempted on a never-installed Nextcloud"
fi

# (B7) WARP-1064: never installed by the wait, but the recovery install
# SUCCEEDS → the reconcile converges: hook exec'd once, runner exits 0.
# (Reproduces the stuck-volume state — installed:false forever — that the
# recovery exists for; live-verified against a real stuck instance too.)
if NC_TRIES=3 NC_RECOVERY_RC=0 run_nc_case 9999 0 run_nextcloud_post_install_hook >/dev/null 2>&1; then
  pass "recovered install keeps the runner green (exit 0)"
else
  fail "runner failed even though the WARP-1064 recovery succeeded"
fi
if [ "$(cat "$NC_WORK/state/recovery_calls" 2>/dev/null || echo 0)" = "1" ] \
   && [ "$(cat "$NC_WORK/state/hook_calls" 2>/dev/null || echo 0)" = "1" ]; then
  pass "successful recovery is followed by the WARP-990 hook reconcile (hook exec'd once)"
else
  fail "expected recovery x1 + hook x1 after a successful WARP-1064 recovery (got recovery=$(cat "$NC_WORK/state/recovery_calls" 2>/dev/null || echo 0), hook=$(cat "$NC_WORK/state/hook_calls" 2>/dev/null || echo 0))"
fi
NC_RECOVERY_ARGV="$(cat "$NC_WORK/state/recovery_argv" 2>/dev/null || echo '')"
if printf '%s' "$NC_RECOVERY_ARGV" | grep -qF -- "-u 33" \
   && printf '%s' "$NC_RECOVERY_ARGV" | grep -qF "maintenance:install"; then
  pass "recovery install runs occ maintenance:install as uid 33 in the nextcloud service"
else
  fail "recovery install argv wrong (got: '${NC_RECOVERY_ARGV}')"
fi

# (B8) WARP-1064: slow-but-HEALTHY first boot — the wait expires while the
# entrypoint is still initializing (apache2 not up: rsync/install/hooks in
# flight). The recovery must HOLD, not race a second maintenance:install;
# once the entrypoint finishes (probe flips to "serving" on call 2) the
# verdict is installed:true and the hook reconciles with ZERO recovery
# installs. installed_after=4: the 3 wait polls miss, the post-hold verdict
# probe (occ call 4) sees installed.
if NC_TRIES=3 NC_EP_SERVING_AFTER=2 run_nc_case 4 0 run_nextcloud_post_install_hook >/dev/null 2>&1; then
  pass "slow-healthy first boot converges through the entrypoint hold-off (runner exits 0)"
else
  fail "runner failed on a slow-but-healthy first boot (entrypoint hold-off broken)"
fi
if [ ! -f "$NC_WORK/state/recovery_calls" ] \
   && [ "$(cat "$NC_WORK/state/hook_calls" 2>/dev/null || echo 0)" = "1" ] \
   && [ "$(cat "$NC_WORK/state/ep_probe_calls" 2>/dev/null || echo 0)" = "2" ]; then
  pass "hold-off waited out the in-flight install — no second maintenance:install was raced"
else
  fail "expected 0 recovery installs + 1 hook + 2 entrypoint probes (got recovery=$(cat "$NC_WORK/state/recovery_calls" 2>/dev/null || echo 0), hook=$(cat "$NC_WORK/state/hook_calls" 2>/dev/null || echo 0), probes=$(cat "$NC_WORK/state/ep_probe_calls" 2>/dev/null || echo 0))"
fi

# (B9) WARP-1064: genuinely stuck box behind a busy entrypoint window — the
# probe reports initializing twice, then serving; the verdict is STILL
# installed:false, so the recovery install must fire exactly once.
if NC_TRIES=3 NC_RECOVERY_RC=0 NC_EP_SERVING_AFTER=3 run_nc_case 9999 0 run_nextcloud_post_install_hook >/dev/null 2>&1; then
  pass "stuck box is still recovered after the entrypoint hold-off (runner exits 0)"
else
  fail "runner failed on a stuck box behind the entrypoint hold-off"
fi
if [ "$(cat "$NC_WORK/state/ep_probe_calls" 2>/dev/null || echo 0)" = "3" ] \
   && [ "$(cat "$NC_WORK/state/recovery_calls" 2>/dev/null || echo 0)" = "1" ]; then
  pass "hold-off ended on 'serving' and the recovery install fired exactly once"
else
  fail "expected 3 entrypoint probes + 1 recovery install (got probes=$(cat "$NC_WORK/state/ep_probe_calls" 2>/dev/null || echo 0), recovery=$(cat "$NC_WORK/state/recovery_calls" 2>/dev/null || echo 0))"
fi

# (B10) WARP-1064: the hold-off budget expires while the entrypoint is STILL
# initializing → the recovery must BAIL (no second install raced against the
# in-flight one — observed live 2026-07-11: both installers fight over the
# same DB), staying non-fatal + loud. The harness pins the hold budget to 10
# probes; "serving" never arrives.
NC_ERR3="$NC_WORK/still-initializing.stderr"
if NC_TRIES=3 NC_RECOVERY_RC=0 NC_EP_SERVING_AFTER=999 run_nc_case 9999 0 run_nextcloud_post_install_hook >/dev/null 2>"$NC_ERR3"; then
  pass "still-initializing entrypoint keeps the runner non-fatal (exits 0)"
else
  fail "still-initializing entrypoint aborted the runner — must be non-fatal to setup"
fi
if [ ! -f "$NC_WORK/state/recovery_calls" ] \
   && [ "$(cat "$NC_WORK/state/ep_probe_calls" 2>/dev/null || echo 0)" = "10" ]; then
  pass "budget-exhausted hold-off bails without racing a second maintenance:install"
else
  fail "expected 10 probes + 0 recovery installs on budget exhaustion (got probes=$(cat "$NC_WORK/state/ep_probe_calls" 2>/dev/null || echo 0), recovery=$(cat "$NC_WORK/state/recovery_calls" 2>/dev/null || echo 0))"
fi
if grep -q 'WARP-990' "$NC_ERR3"; then
  pass "bailed hold-off still surfaces the loud degraded-path breadcrumb"
else
  fail "bailed hold-off is silent — the WARP-990 skip message must reach stderr"
fi

# =============================================================================
# Phase 9: public-FQDN write-back under the bridge sandbox (WARP-985)
# =============================================================================
# The TLS boot-tick issued the cert, then the bridge-exec'd
# droplet-set-public-fqdn.sh died with mktemp EROFS: the bridge unit's
# ProtectSystem=strict + ProtectHome=read-only had no writable carve-out for
# the repo dir where .env lives. Two side gaps rode along: the bridge env
# never carried ROUTING_SERVICE_TOKEN (routing-DNS leg 401'd), and
# _write_host_dnsmasq_record's sudo failed silently under NoNewPrivileges.
# Static assertions verify the wiring; behavioural assertions exercise the
# REAL host script via its DROPLET_PUBLIC_FQDN_ENV_FILE/SKIP_DNS test hooks.
echo "--- Phase 9: bridge sandbox FQDN write-back (WARP-985) ---"

FQDN_SCRIPT="$REPO_ROOT_REAL/scripts/host/droplet-set-public-fqdn.sh"
LOCAL_DNS_LIB="$REPO_ROOT_REAL/scripts/lib/local-dns.sh"
BRIDGE_UNIT="$REPO_ROOT_REAL/services/oled-display/droplet-device-bridge.service"

# (1) Syntax: both touched scripts must pass bash -n.
if bash -n "$FQDN_SCRIPT" 2>/dev/null; then
  pass "droplet-set-public-fqdn.sh passes bash -n syntax check"
else
  fail "droplet-set-public-fqdn.sh has a bash syntax error"
fi
if bash -n "$LOCAL_DNS_LIB" 2>/dev/null; then
  pass "local-dns.sh passes bash -n syntax check"
else
  fail "local-dns.sh has a bash syntax error"
fi

# (2) Static: the bridge unit must carve the repo dir out of the read-only
# sandbox (`-` prefix so a moved checkout doesn't fail unit start). The
# @REPO_ROOT@ placeholder is substituted by install-device-bridge.sh, same as
# ExecStart.
if grep -qxF 'ReadWritePaths=-@REPO_ROOT@' "$BRIDGE_UNIT"; then
  pass "bridge unit carves the repo dir out of the sandbox (ReadWritePaths=-@REPO_ROOT@)"
else
  fail "bridge unit has no ReadWritePaths=-@REPO_ROOT@ — the .env write-back dies with mktemp EROFS"
fi

# ...without losing the per-unit log carve-out that append:/var/log needs.
if grep -qxF 'ReadWritePaths=/var/log/droplet-device-bridge.log' "$BRIDGE_UNIT"; then
  pass "bridge unit keeps the log-file ReadWritePaths carve-out"
else
  fail "bridge unit lost ReadWritePaths=/var/log/droplet-device-bridge.log (append: logging breaks)"
fi

# (3) Static: the installer must mirror ROUTING_SERVICE_TOKEN into the bridge
# env (same set_env_if_blank mechanism as BRIDGE_AUTH_TOKEN) so the host
# script's routing-DNS leg authenticates instead of 401ing.
if grep -qE 'set_env_if_blank "ROUTING_SERVICE_TOKEN"' "$BRIDGE_INSTALL"; then
  pass "install-device-bridge.sh mirrors ROUTING_SERVICE_TOKEN into the bridge env"
else
  fail "install-device-bridge.sh does not mirror ROUTING_SERVICE_TOKEN — POST /dhcp/hostnames 401s from the bridge"
fi

# (4) Static: _write_host_dnsmasq_record must probe non-interactive sudo before
# using it (NoNewPrivileges blocks sudo silently under the bridge sandbox).
if grep -qE 'sudo -n true' "$LOCAL_DNS_LIB"; then
  pass "local-dns.sh probes non-interactive sudo before the host dnsmasq write"
else
  fail "local-dns.sh has no 'sudo -n true' probe — the dnsmasq write fails silently under the bridge sandbox"
fi

# --- Behavioural: the real host script via its test hooks ---------------------
FQDN_ENV="$TMP_ROOT/fqdn.env"
rm -f "$FQDN_ENV"

# (5) Fresh file: a valid opaque per-device FQDN is upserted.
if DROPLET_PUBLIC_FQDN_ENV_FILE="$FQDN_ENV" DROPLET_PUBLIC_FQDN_SKIP_DNS=1 \
     bash "$FQDN_SCRIPT" 'd-b5839920cb1b0d09.droplet-us.com' >/dev/null 2>&1 \
   && grep -qxF 'DROPLET_PUBLIC_FQDN=d-b5839920cb1b0d09.droplet-us.com' "$FQDN_ENV"; then
  pass "droplet-set-public-fqdn.sh writes DROPLET_PUBLIC_FQDN to a fresh .env"
else
  fail "droplet-set-public-fqdn.sh did not write DROPLET_PUBLIC_FQDN (got: $(cat "$FQDN_ENV" 2>/dev/null || echo '<missing>'))"
fi

# (6) Idempotent: a re-run with the same name leaves the file byte-identical.
FQDN_ENV_BEFORE="$(cat "$FQDN_ENV" 2>/dev/null || true)"
if DROPLET_PUBLIC_FQDN_ENV_FILE="$FQDN_ENV" DROPLET_PUBLIC_FQDN_SKIP_DNS=1 \
     bash "$FQDN_SCRIPT" 'd-b5839920cb1b0d09.droplet-us.com' >/dev/null 2>&1 \
   && [ "$(cat "$FQDN_ENV")" = "$FQDN_ENV_BEFORE" ]; then
  pass "droplet-set-public-fqdn.sh re-run is byte-identical (idempotent upsert)"
else
  fail "droplet-set-public-fqdn.sh re-run changed the .env (not idempotent)"
fi

# (7) Replace-in-place: an existing commented/stale line is replaced, and no
# duplicate key is appended.
printf '# DROPLET_PUBLIC_FQDN=\nOTHER_KEY=keepme\n' > "$FQDN_ENV"
if DROPLET_PUBLIC_FQDN_ENV_FILE="$FQDN_ENV" DROPLET_PUBLIC_FQDN_SKIP_DNS=1 \
     bash "$FQDN_SCRIPT" 'd-b5839920cb1b0d09.droplet-us.com' >/dev/null 2>&1 \
   && grep -qxF 'DROPLET_PUBLIC_FQDN=d-b5839920cb1b0d09.droplet-us.com' "$FQDN_ENV" \
   && grep -qxF 'OTHER_KEY=keepme' "$FQDN_ENV" \
   && [ "$(grep -c 'DROPLET_PUBLIC_FQDN=' "$FQDN_ENV")" -eq 1 ]; then
  pass "droplet-set-public-fqdn.sh replaces a commented line in place (no dup, keeps other keys)"
else
  fail "droplet-set-public-fqdn.sh mishandled an existing commented line (got: $(cat "$FQDN_ENV" 2>/dev/null))"
fi

# (8) Validation: a metacharacter-bearing name is refused BEFORE any write.
FQDN_ENV_BEFORE="$(cat "$FQDN_ENV")"
if DROPLET_PUBLIC_FQDN_ENV_FILE="$FQDN_ENV" DROPLET_PUBLIC_FQDN_SKIP_DNS=1 \
     bash "$FQDN_SCRIPT" 'evil;rm -rf.example.com' >/dev/null 2>&1; then
  fail "droplet-set-public-fqdn.sh accepted an fqdn with shell metacharacters"
else
  if [ "$(cat "$FQDN_ENV")" = "$FQDN_ENV_BEFORE" ]; then
    pass "droplet-set-public-fqdn.sh refuses a bad fqdn and writes nothing"
  else
    fail "droplet-set-public-fqdn.sh refused the bad fqdn but still modified the .env"
  fi
fi

# (9) Validation: a newline-bearing name is refused BEFORE any write. grep is
# LINE-based, so 'ok.example.com<LF>INJECTED=1' passed the old `printf|grep -Eq`
# check on its first line and appended a second .env assignment; the [[ =~ ]]
# whole-string match must refuse it outright.
FQDN_ENV_BEFORE="$(cat "$FQDN_ENV")"
if DROPLET_PUBLIC_FQDN_ENV_FILE="$FQDN_ENV" DROPLET_PUBLIC_FQDN_SKIP_DNS=1 \
     bash "$FQDN_SCRIPT" $'ok.example.com\nINJECTED=1' >/dev/null 2>&1; then
  fail "droplet-set-public-fqdn.sh accepted an fqdn with an embedded newline (env injection)"
else
  if [ "$(cat "$FQDN_ENV")" = "$FQDN_ENV_BEFORE" ] \
     && ! grep -qxF 'INJECTED=1' "$FQDN_ENV"; then
    pass "droplet-set-public-fqdn.sh refuses a newline-bearing fqdn and writes nothing"
  else
    fail "droplet-set-public-fqdn.sh let a newline-bearing fqdn touch the .env (got: $(cat "$FQDN_ENV" 2>/dev/null))"
  fi
fi

# --- Behavioural: the sudo guard defers instead of failing silently -----------
# Source the REAL library, point its host-dnsmasq conf at a fixture, and put a
# stub `sudo` (always exits 1, so `sudo -n true` fails) first on PATH — the
# same environment the bridge sandbox presents. The write must return 0, warn
# about the deferral, and leave the conf untouched.
# shellcheck source=../scripts/lib/local-dns.sh
source "$LOCAL_DNS_LIB"

_HOST_DNSMASQ_CONF="$TMP_ROOT/lan-dhcp.conf"
printf 'dhcp-range=192.168.20.50,192.168.20.150,12h\n' > "$_HOST_DNSMASQ_CONF"
DNSMASQ_CONF_BEFORE="$(cat "$_HOST_DNSMASQ_CONF")"
DROPLET_PUBLIC_FQDN='d-b5839920cb1b0d09.droplet-us.com'
DROPLET_PUBLIC_FQDN_IP='192.168.20.1'

SUDO_STUB_BIN="$TMP_ROOT/no-sudo-bin"
mkdir -p "$SUDO_STUB_BIN"
printf '#!/usr/bin/env bash\nexit 1\n' > "$SUDO_STUB_BIN/sudo"
chmod +x "$SUDO_STUB_BIN/sudo"

WARN_CAPTURE="$TMP_ROOT/dnsmasq-warn.txt"
if ( PATH="$SUDO_STUB_BIN:$PATH" _write_host_dnsmasq_record ) \
     >/dev/null 2>"$WARN_CAPTURE"; then
  pass "_write_host_dnsmasq_record returns 0 when non-interactive sudo is unavailable"
else
  fail "_write_host_dnsmasq_record returned non-zero without sudo (breaks the best-effort contract)"
fi

if grep -q 'deferred to the next boot/setup run' "$WARN_CAPTURE"; then
  pass "_write_host_dnsmasq_record warns that the host-record is deferred (no silent no-op)"
else
  fail "_write_host_dnsmasq_record did not warn about the deferral (got: $(cat "$WARN_CAPTURE" 2>/dev/null))"
fi

if [ "$(cat "$_HOST_DNSMASQ_CONF")" = "$DNSMASQ_CONF_BEFORE" ]; then
  pass "_write_host_dnsmasq_record left the dnsmasq conf untouched without sudo"
else
  fail "_write_host_dnsmasq_record modified the dnsmasq conf despite sudo being unavailable"
fi

# =============================================================================
# Phase 10: droplet-set-public-fqdn.sh AP-resolver propagation (WARP-986)
# =============================================================================
# Live gap on the .87 single-box (2026-07-01): the script's two DNS legs never
# reach the dnsmasq-ap instance inside the droplet-openwrt container — the ONLY
# resolver AP (Wi-Fi) clients use — so the learned public FQDN stayed
# unresolvable on AP Wi-Fi until the next boot. The fix adds a best-effort
# _propagate_ap_resolver leg: when passwordless sudo is available, re-run
# droplet-openwrt-attach.service (which now emits the FQDN into
# /etc/dnsmasq-ap.conf); otherwise log and stay non-fatal. Static assertions
# verify the wiring; behavioural assertions exercise the REAL function
# extracted from the script (mirrors the Phase 7 lock-function extraction).
echo "--- Phase 10: droplet-set-public-fqdn.sh AP-resolver propagation ---"

SET_FQDN_SH="$REPO_ROOT_REAL/scripts/host/droplet-set-public-fqdn.sh"

# (1) Static: privileged host script — syntax must be valid (same posture as
# install-device-bridge.sh in Phase 4).
if bash -n "$SET_FQDN_SH" 2>/dev/null; then
  pass "droplet-set-public-fqdn.sh passes bash -n syntax check"
else
  fail "droplet-set-public-fqdn.sh has a bash syntax error"
fi

# (2) Static: the propagation leg exists, gates on passwordless sudo, and
# restarts the attach unit (never a hand-rolled dnsmasq poke).
if grep -qE 'sudo -n true' "$SET_FQDN_SH" \
   && grep -qE 'systemctl restart droplet-openwrt-attach\.service' "$SET_FQDN_SH"; then
  pass "propagation leg gates on 'sudo -n true' and restarts droplet-openwrt-attach.service"
else
  fail "propagation leg missing the sudo gate or the attach-unit restart (WARP-986)"
fi

if grep -qE '^_propagate_ap_resolver$' "$SET_FQDN_SH"; then
  pass "_propagate_ap_resolver is invoked"
else
  fail "_propagate_ap_resolver is not invoked"
fi

# --- Behavioural: extract the real function and exercise it ------------------
eval "$(awk '/^_propagate_ap_resolver\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SET_FQDN_SH")"

PF_WORK="$TMP_ROOT/pf"
PF_STUB_BIN="$PF_WORK/bin"
mkdir -p "$PF_STUB_BIN"

# sudo stub: '-n true' answers per the sudo-ok flag; '-n systemctl restart <u>'
# records the unit and answers per the restart-ok flag. systemctl stub exists
# only so the function's `command -v systemctl` probe succeeds.
cat > "$PF_STUB_BIN/sudo" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "-n" ] && [ "\$2" = "true" ]; then
  [ -f "$PF_WORK/sudo-ok" ] && exit 0 || exit 1
fi
if [ "\$1" = "-n" ] && [ "\$2" = "systemctl" ] && [ "\$3" = "restart" ]; then
  printf '%s\n' "\$4" >> "$PF_WORK/restarts"
  [ -f "$PF_WORK/restart-ok" ] && exit 0 || exit 1
fi
exit 0
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$PF_STUB_BIN/systemctl"
chmod +x "$PF_STUB_BIN/sudo" "$PF_STUB_BIN/systemctl"

PF_OLD_PATH="$PATH"
PATH="$PF_STUB_BIN:$PATH"
FQDN="d-0123456789abcdef.droplet-us.com"
err() { printf 'droplet-set-public-fqdn: %s\n' "$*" >> "$PF_WORK/err.log"; }

# (3) sudo ok + restart ok -> the attach unit is restarted and success is logged.
: > "$PF_WORK/restarts"; : > "$PF_WORK/err.log"
touch "$PF_WORK/sudo-ok" "$PF_WORK/restart-ok"
PF_OUT="$( (_propagate_ap_resolver) 2>/dev/null || true)"
if printf '%s' "$PF_OUT" | grep -q 'AP resolver refreshed' \
   && grep -qx 'droplet-openwrt-attach.service' "$PF_WORK/restarts"; then
  pass "passwordless sudo -> restarts droplet-openwrt-attach.service (FQDN live for AP clients now)"
else
  fail "expected attach-unit restart + success log, got out='$PF_OUT' restarts='$(cat "$PF_WORK/restarts" 2>/dev/null)'"
fi

# (4) No passwordless sudo (the device-bridge shape) -> non-fatal skip, no
# restart attempted, next-boot breadcrumb logged.
: > "$PF_WORK/restarts"; : > "$PF_WORK/err.log"
rm -f "$PF_WORK/sudo-ok"
if (_propagate_ap_resolver) >/dev/null 2>&1 \
   && [ ! -s "$PF_WORK/restarts" ] \
   && grep -q 'no passwordless sudo' "$PF_WORK/err.log"; then
  pass "no passwordless sudo -> returns 0, no restart, next-boot breadcrumb logged"
else
  fail "sudo-less path wrong (rc/restarts/log): restarts='$(cat "$PF_WORK/restarts" 2>/dev/null)' log='$(cat "$PF_WORK/err.log" 2>/dev/null)'"
fi

# (5) Restart fails -> still non-fatal (returns 0) with a loud breadcrumb —
# the .env write-back above it must never be failed by this leg.
: > "$PF_WORK/restarts"; : > "$PF_WORK/err.log"
touch "$PF_WORK/sudo-ok"; rm -f "$PF_WORK/restart-ok"
if (_propagate_ap_resolver) >/dev/null 2>&1 \
   && grep -q 'restart failed' "$PF_WORK/err.log"; then
  pass "attach restart failure stays non-fatal (rc 0) with a breadcrumb"
else
  fail "restart-failure path wrong: log='$(cat "$PF_WORK/err.log" 2>/dev/null)'"
fi

# (6) Full-script run with the SKIP_DNS hook: .env upsert happens, exit 0, and
# the propagation leg is NOT reached (the hook means "write .env only").
PF_ENV="$PF_WORK/dotenv"
rm -f "$PF_ENV"; : > "$PF_WORK/restarts"
touch "$PF_WORK/sudo-ok" "$PF_WORK/restart-ok"
if DROPLET_PUBLIC_FQDN_SKIP_DNS=1 DROPLET_PUBLIC_FQDN_ENV_FILE="$PF_ENV" \
     bash "$SET_FQDN_SH" "$FQDN" >/dev/null 2>&1 \
   && grep -qxF "DROPLET_PUBLIC_FQDN=$FQDN" "$PF_ENV" \
   && [ ! -s "$PF_WORK/restarts" ]; then
  pass "SKIP_DNS hook: .env upserted, exit 0, propagation leg not reached"
else
  fail "SKIP_DNS run wrong (env='$(cat "$PF_ENV" 2>/dev/null)' restarts='$(cat "$PF_WORK/restarts" 2>/dev/null)')"
fi

# Restore PATH and drop the test-local err() shadow.
PATH="$PF_OLD_PATH"
unset -f err _propagate_ap_resolver


# =============================================================================
# Phase 11: interrupted re-run convergence (WARP-595)
# =============================================================================
# Re-running setup.sh is the only field-update path; an interruption (power
# loss, SSH drop, ctrl-C) mid-write must never leave state a re-run can't
# converge from. Behavioural asserts exercise the torn-.env recovery and the
# append hygiene; static asserts pin the stage-then-rename write patterns that
# close the interruption windows themselves (a partial write can't be
# simulated portably, but the atomic-rename pattern makes it structurally
# impossible to observe a prefix of the file).
echo "--- Phase 11: interrupted re-run convergence (WARP-595) ---"

SECRETS_LIB="$REPO_ROOT_REAL/scripts/lib/secrets.sh"
SINGLE_BOX_LIB="$REPO_ROOT_REAL/scripts/lib/single-box.sh"
CAMERA_LIB="$REPO_ROOT_REAL/scripts/lib/camera-drivers.sh"

# (1) Torn .env + a complete backup → RESTORED from the backup, not skipped.
# Interruption scenario: `--regenerate-env` backed up the old .env, then the
# heredoc write was cut by a power loss. The truncated file has the generated
# header but is missing core keys; the old behaviour said ".env already exists
# — skipping" and left the box with a half-.env whose data-store passwords no
# longer match the running volumes.
T9A="$TMP_ROOT/warp595-restore"
mkdir -p "$T9A"
( export REPO_ROOT="$T9A"; generate_env ) >/dev/null 2>&1
cp "$T9A/.env" "$T9A/.env.bak.1750000000"
head -n 8 "$T9A/.env" > "$T9A/.env.head" && mv "$T9A/.env.head" "$T9A/.env"
( export REPO_ROOT="$T9A"; generate_env ) >/dev/null 2>&1 || true
if cmp -s "$T9A/.env" "$T9A/.env.bak.1750000000"; then
  pass "torn .env with a complete .bak backup is restored from the backup"
else
  fail "torn .env was not restored from its backup (re-run must converge, not skip)"
fi
T9A_PERMS=$(stat -c "%a" "$T9A/.env" 2>/dev/null || stat -f "%OLp" "$T9A/.env" 2>/dev/null || echo "unknown")
if [ "$T9A_PERMS" = "600" ]; then
  pass "restored .env keeps 600 permissions"
else
  fail "restored .env permissions are $T9A_PERMS (expected 600)"
fi
# The .env.torn.* copy carries the same leading secrets block as .env, and in
# exactly the target scenario its SOURCE is a legacy torn file sitting at
# umask-default 644 (the pre-atomic writer died BEFORE its chmod). `cp` alone
# preserves that world-readable mode, so the recovery copy must be forced 600.
T9A_TORN_FILE=$(ls "$T9A"/.env.torn.* 2>/dev/null | head -n 1 || true)
T9A_TORN_PERMS=$(stat -c "%a" "$T9A_TORN_FILE" 2>/dev/null || stat -f "%OLp" "$T9A_TORN_FILE" 2>/dev/null || echo "missing")
if [ "$T9A_TORN_PERMS" = "600" ]; then
  pass ".env.torn.* recovery copy is chmod 600 (source was a 644 legacy torn file)"
else
  fail ".env.torn.* recovery copy perms are $T9A_TORN_PERMS (expected 600 — world-readable secrets sibling)"
fi

# (2) Torn .env with NO backup → fresh full regeneration (stack never ran with
# the truncated secrets on a first-install interruption, so fresh secrets are
# the correct convergence).
T9B="$TMP_ROOT/warp595-regen"
mkdir -p "$T9B"
( export REPO_ROOT="$T9B"; generate_env ) >/dev/null 2>&1
head -n 8 "$T9B/.env" > "$T9B/.env.head" && mv "$T9B/.env.head" "$T9B/.env"
( export REPO_ROOT="$T9B"; generate_env ) >/dev/null 2>&1 || true
if grep -qE '^DEVICE_SECRET_KEY=.' "$T9B/.env" \
   && grep -qE '^COMPOSE_PROFILES=' "$T9B/.env" \
   && grep -qE '^POSTGRES_PASSWORD=.' "$T9B/.env"; then
  pass "torn .env with no backup is fully regenerated on re-run"
else
  fail "torn .env with no backup was not regenerated (missing core/tail keys after re-run)"
fi
# Same 644-source hazard as the .env.torn.* copy above: on this path the torn
# file is preserved via the pre-regeneration backup block (`cp` → .env.bak.*),
# which would otherwise inherit the legacy file's world-readable mode.
T9B_BAK_FILE=$(ls "$T9B"/.env.bak.* 2>/dev/null | head -n 1 || true)
T9B_BAK_PERMS=$(stat -c "%a" "$T9B_BAK_FILE" 2>/dev/null || stat -f "%OLp" "$T9B_BAK_FILE" 2>/dev/null || echo "missing")
if [ "$T9B_BAK_PERMS" = "600" ]; then
  pass ".env.bak.* pre-regeneration backup is chmod 600 (source was a 644 legacy torn file)"
else
  fail ".env.bak.* pre-regeneration backup perms are $T9B_BAK_PERMS (expected 600 — world-readable secrets sibling)"
fi

# (3) Operator-authored .env (no generated header) is NEVER touched by the
# torn-file recovery — the detector must key on our own heredoc header.
T9C="$TMP_ROOT/warp595-operator"
mkdir -p "$T9C"
printf 'FOO=bar\n' > "$T9C/.env"
( export REPO_ROOT="$T9C"; generate_env ) >/dev/null 2>&1 || true
if [ "$(cat "$T9C/.env")" = "FOO=bar" ]; then
  pass "operator-authored .env (no generated header) is left untouched"
else
  fail "operator-authored .env was modified by generate_env (torn-detector false positive)"
fi

# (4) migrate_env on a .env whose last line has NO trailing newline (a torn
# write or hand edit) must not glue the first backfilled key onto the last
# existing line. Pre-fix: `COMPOSE_PROFILES=evalROUTING_MODE=real` corrupted
# BOTH keys.
T9D="$TMP_ROOT/warp595-newline"
mkdir -p "$T9D"
( export REPO_ROOT="$T9D"; generate_env ) >/dev/null 2>&1
printf '%s' "$(cat "$T9D/.env")" > "$T9D/.env"   # strip trailing newline
( export REPO_ROOT="$T9D"; migrate_env ) >/dev/null 2>&1 || true
if grep -qE '^ROUTING_MODE=(real|mock)$' "$T9D/.env"; then
  pass "migrate_env backfills onto its own line when .env lacks a trailing newline"
else
  fail "migrate_env glued the backfilled key onto the last line (no trailing-newline guard)"
fi
if grep -qE '^COMPOSE_PROFILES=(eval|linux,display,eval)$' "$T9D/.env"; then
  pass "the pre-existing last line survives a no-trailing-newline append"
else
  fail "the pre-existing last line was corrupted by the append (COMPOSE_PROFILES mangled)"
fi

# (5) Static: generate_env must STAGE the heredoc and rename into place —
# writing the live .env directly means an interruption leaves a prefix of the
# file that a re-run mistakes for a complete .env.
if grep -qE 'cat > "\$env_file" <<' "$SECRETS_LIB"; then
  fail "secrets.sh writes the live .env directly from the heredoc (non-atomic; torn on interruption)"
else
  pass "secrets.sh does not write the live .env directly from the heredoc"
fi

# (6) Static: single-box upsert_env must not truncate-rewrite the live .env.
# The old `cat "\${env_file}.tmp" > "\$env_file"` opened .env with O_TRUNC and
# re-copied it — an interruption mid-copy left a PREFIX of .env (up to and
# including an empty file), losing live-stack secrets like POSTGRES_PASSWORD.
if grep -qF 'cat "${env_file}.tmp" > "$env_file"' "$SINGLE_BOX_LIB"; then
  fail "single-box.sh upsert_env truncate-rewrites the live .env (torn on interruption)"
else
  pass "single-box.sh upsert_env does not truncate-rewrite the live .env"
fi

# (7) Behavioural: the Phase-3 sandbox .env (written via the upsert path) must
# still be 600 after configure_single_box_env — a rename-into-place rewrite
# must not silently widen the permissions of the secrets-bearing file.
T9_UPSERT_PERMS=$(stat -c "%a" "$TMP_ROOT/.env" 2>/dev/null || stat -f "%OLp" "$TMP_ROOT/.env" 2>/dev/null || echo "unknown")
if [ "$T9_UPSERT_PERMS" = "600" ]; then
  pass ".env stays 600 after configure_single_box_env upserts"
else
  fail ".env permissions are $T9_UPSERT_PERMS after configure_single_box_env (expected 600)"
fi
if ls "$TMP_ROOT"/.env.upsert.* >/dev/null 2>&1 || ls "$TMP_ROOT"/.env.tmp* >/dev/null 2>&1; then
  fail "configure_single_box_env left staging files behind (.env.upsert.*/.env.tmp*)"
else
  pass "configure_single_box_env leaves no staging files behind"
fi

# (8) Static: /etc/default/droplet-openwrt-attach is guarded by an existence
# check ("exists — keeping rotated value"), so its write MUST be staged +
# renamed — otherwise a partial file from an interrupted run is kept forever
# and the AP config (SSID/PSK lines) never converges.
if grep -qF 'droplet-openwrt-attach.tmp' "$SINGLE_BOX_LIB" \
   && grep -qF 'sudo mv /etc/default/droplet-openwrt-attach.tmp /etc/default/droplet-openwrt-attach' "$SINGLE_BOX_LIB"; then
  pass "/etc/default/droplet-openwrt-attach is staged + renamed (guard can't see a partial file)"
else
  fail "/etc/default/droplet-openwrt-attach is written in place behind an existence guard (partial file kept forever)"
fi

# (9) Static: the two existence-guarded camera-driver files
# (/etc/modules-load.d/droplet-cameras.conf + the udev rules) must be staged +
# renamed for the same reason as (8).
if grep -qF '"$conf.tmp"' "$CAMERA_LIB" && grep -qF 'sudo mv "$conf.tmp" "$conf"' "$CAMERA_LIB"; then
  pass "persist_camera_modules stages + renames droplet-cameras.conf"
else
  fail "persist_camera_modules writes droplet-cameras.conf in place behind an existence guard"
fi
if grep -qF '"$rules.tmp"' "$CAMERA_LIB" && grep -qF 'sudo mv "$rules.tmp" "$rules"' "$CAMERA_LIB"; then
  pass "setup_udev_rules stages + renames 99-droplet-cameras.rules"
else
  fail "setup_udev_rules writes 99-droplet-cameras.rules in place behind an existence guard"
fi

# (10) Behavioural: a stale .env.upsert.* sibling left by an interrupted
# previous run (the process died between creating the stage and the mv) is
# cleaned up by the next configure_single_box_env run — it is secrets-bearing
# litter that would otherwise accumulate forever. Reuses the Phase-3 docker
# stub machinery (REPO_ROOT is still the Phase-3 sandbox).
T9_STALE="$TMP_ROOT/.env.upsert.424242"
printf 'SECRET=leftover\n' > "$T9_STALE"
cat > "$SB_STUB_BIN/docker" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "network" ] && [ "\$2" = "inspect" ]; then
  printf '%s\n' "$SB_FAKE_GW"
  exit 0
fi
exit 0
EOF
chmod +x "$SB_STUB_BIN/docker"
PATH="$SB_STUB_BIN:$PATH"
configure_single_box_env >/dev/null 2>&1 || true
PATH="$SB_OLD_PATH"
if [ ! -f "$T9_STALE" ]; then
  pass "configure_single_box_env removes stale .env.upsert.* siblings from an interrupted run"
else
  fail "stale .env.upsert.* sibling survives configure_single_box_env (secrets-bearing litter accumulates)"
fi

# (11) Static: factory-reset.sh's generated-file wipe must also remove the
# WARP-595 staging/torn siblings (.env.torn.*, .env.tmp.*, .env.migrate.*,
# .env.upsert.*) — they carry the same secrets as .env and previously
# survived a factory reset.
FACTORY_RESET_SH="$REPO_ROOT_REAL/scripts/factory-reset.sh"
T9_WIPE_OK=true
for T9_PAT in '.env.torn.' '.env.tmp.' '.env.migrate.' '.env.upsert.'; do
  grep -qF "$T9_PAT" "$FACTORY_RESET_SH" || T9_WIPE_OK=false
done
if [ "$T9_WIPE_OK" = "true" ]; then
  pass "factory-reset.sh wipes the .env staging/torn siblings (secrets-bearing)"
else
  fail "factory-reset.sh does not wipe all .env staging/torn siblings (.env.{torn,tmp,migrate,upsert}.*)"
fi

# (12) BLOCKING (rjouffret WARP-1309 review): the end-of-run "leave nothing
# stale" sweep in setup.sh runs under `set -euo pipefail`. `rm -f` swallows a
# missing file but a REAL removal failure (e.g. a root-owned .env.bak.* an
# earlier privileged run left that a later non-root run cannot unlink) still
# returns non-zero. As a standalone statement — not in an && / || chain — that
# non-zero triggers `set -e` and aborts the whole script AFTER a good provision
# but BEFORE the "Setup Complete" banner, flipping a green provision to a
# reported failure: the exact inverse of what WARP-1309 guarantees. Every
# `rm -f "$_stale"` in the sweep must therefore be abort-guarded (`|| true`).
SETUP_SH="$REPO_ROOT_REAL/scripts/setup.sh"
T12_SWEEP="$(awk '/Leave nothing stale on the box/{f=1} /--- Done ---/{f=0} f' "$SETUP_SH")"
T12_TOTAL=$(printf '%s\n' "$T12_SWEEP" | grep -c 'rm -f "\$_stale"' || true)
T12_GUARDED=$(printf '%s\n' "$T12_SWEEP" | grep 'rm -f "\$_stale"' | grep -c '|| true' || true)
if [ "$T12_TOTAL" -ge 2 ] && [ "$T12_TOTAL" = "$T12_GUARDED" ]; then
  pass "setup.sh stale-sweep rm -f calls are abort-guarded (|| true) under set -e"
else
  fail "setup.sh stale-sweep has $T12_TOTAL rm -f but only $T12_GUARDED guarded — a failed cleanup rm aborts AFTER provision, before 'Setup Complete'"
fi

# (13) Regression lock for the sweep's pattern coverage (rjouffret WARP-1309
# finding #2). Every .env staging pattern the sweep removes carries the SAME
# device secrets as .env, so each must have a real writer AND must stay covered
# — a future "simplify" pass must not trim a pattern that an interrupted run
# can actually strand. Writers (all stage to a `.$$`/`.<epoch>` sibling then
# rename, leaving the sibling on interruption):
#   .env.torn.*    -> secrets.sh generate_env torn-quarantine  (cp "$env_file.torn.$(date +%s)")
#   .env.tmp.*     -> secrets.sh atomic .env write             ("$env_write_target.tmp.$$")
#   .env.migrate.* -> secrets.sh migrate_env stage             ("$env_file.migrate.$$")
#   .env.upsert.*  -> secrets.sh _upsert_env_kv / single-box.sh configure_single_box_env ("$target.upsert.$$")
SECRETS_SH="$REPO_ROOT_REAL/scripts/lib/secrets.sh"
SINGLEBOX_SH="$REPO_ROOT_REAL/scripts/lib/single-box.sh"
T13_OK=true
# pattern -> the literal writer idiom that stages onto a "$var<idiom>" sibling
# (writers prefix with $env_file/$target/$env_write_target, so the ".env." form
# never appears at the write site — match the distinctive suffix instead).
T13_check() {
  local pat="$1" idiom="$2"
  # (a) the end-of-run sweep removes this secrets-bearing pattern
  printf '%s\n' "$T12_SWEEP" | grep -qF "$pat" || { T13_OK=false; T13_MISS="$pat (not swept)"; }
  # (b) a real writer that can strand it exists in secrets.sh or single-box.sh
  grep -qF "$idiom" "$SECRETS_SH" || grep -qF "$idiom" "$SINGLEBOX_SH" \
    || { T13_OK=false; T13_MISS="$pat (no writer producing $idiom)"; }
}
T13_check '.env.torn.'    '.torn.$(date'
T13_check '.env.tmp.'     '.tmp.$$'
T13_check '.env.migrate.' '.migrate.$$'
T13_check '.env.upsert.'  '.upsert.$$'
if [ "$T13_OK" = "true" ]; then
  pass "setup.sh sweep covers every staging pattern that has a real writer (.env.{torn,tmp,migrate,upsert}.*)"
else
  fail "setup.sh sweep / writer mismatch for ${T13_MISS:-?} — either an uncovered secrets-bearing stray or a dead pattern"
fi

# =============================================================================
# Phase 12: prepare_and_build build-list parity with docker-compose.yml
# =============================================================================
# The build_services list in scripts/lib/compose.sh is hardcoded (jq is not a
# guaranteed device dependency, so the honest enumeration can't run on every
# box) and it drifted: mcp-server, device-identity-svc and email-indexer all
# gained build: sections in docker/docker-compose.yml without landing in the
# list, so fresh provisions built them lazily at first `up` instead of during
# setup's build phase. Two layers pin the fix: (a) static parity between the
# list and the compose file's build: sections (modulo documented exclusions),
# (b) the runtime drift guard (compute_build_list_drift) that makes the NEXT
# drift fail setup-e2e in CI.
echo ""
echo "--- Phase 12: prepare_and_build build-list parity with docker-compose.yml ---"

# Keep in sync with the exclusion rationale beside the drift guard in
# scripts/lib/compose.sh: rag-eval / web-fetch are appended at runtime only
# when their profile (eval / web) is active; openwrt (single-box), ops-console
# (ops) and fleet-agent (telemetry) are profile-gated services no default
# provision pre-builds.
BUILD_LIST_EXCLUSIONS="rag-eval,web-fetch,erp-sql-bridge,openwrt,ops-console,fleet-agent"

# (1) Daemon-free enumeration of every compose service with a build: section
# (2-space service keys, 4-space build: — the file's committed style).
COMPOSE_BUILDABLE="$(awk '
  /^  [a-zA-Z0-9_-]+:[[:space:]]*$/ { svc=$1; sub(/:$/, "", svc) }
  /^    build:/ { if (svc != "") print svc }
' "$COMPOSE_FILE_REAL" | sort)"
if [ -n "$COMPOSE_BUILDABLE" ]; then
  pass "enumerated compose build: services without a docker daemon"
else
  fail "could not enumerate build: services from docker-compose.yml (indentation style changed?)"
fi

# (2) Parity: every buildable compose service is either in build_services or
# a documented exclusion.
BUILD_LIST_BLOCK="$(awk '/^  local build_services=\(/{f=1} f{print} f&&/^  \)/{exit}' "$COMPOSE_LIB")"
PARITY_MISSING=""
while IFS= read -r P12_SVC; do
  [ -z "$P12_SVC" ] && continue
  case ",${BUILD_LIST_EXCLUSIONS}," in *",${P12_SVC},"*) continue ;; esac
  if ! printf '%s\n' "$BUILD_LIST_BLOCK" | grep -qE "^[[:space:]]+${P12_SVC}([[:space:]]|$)"; then
    PARITY_MISSING="${PARITY_MISSING:+${PARITY_MISSING} }${P12_SVC}"
  fi
done <<<"$COMPOSE_BUILDABLE"
if [ -z "$PARITY_MISSING" ]; then
  pass "build_services covers every compose build: service (exclusions: ${BUILD_LIST_EXCLUSIONS})"
else
  fail "build_services is missing buildable compose services: ${PARITY_MISSING} (add them, or document the exclusion beside the drift guard)"
fi

# (3) The reverse: no build_services entry without a build: section in the
# compose file (a renamed/removed service would fail every provision).
STALE_ENTRIES=""
while IFS= read -r P12_LINE; do
  P12_ENTRY="$(printf '%s' "$P12_LINE" | sed -E 's/^[[:space:]]+//; s/[[:space:]]*(#.*)?$//')"
  case "$P12_ENTRY" in ''|'#'*|'local'*|')') continue ;; esac
  printf '%s\n' "$COMPOSE_BUILDABLE" | grep -qx "$P12_ENTRY" \
    || STALE_ENTRIES="${STALE_ENTRIES:+${STALE_ENTRIES} }${P12_ENTRY}"
done <<<"$BUILD_LIST_BLOCK"
if [ -z "$STALE_ENTRIES" ]; then
  pass "every build_services entry has a build: section in docker-compose.yml"
else
  fail "build_services entries with no build: section in docker-compose.yml: ${STALE_ENTRIES}"
fi

# (4) Sentinel markers (the extraction contract for the behavioural asserts).
if grep -qF "# >>> compute_build_list_drift" "$COMPOSE_LIB" \
   && grep -qF "# <<< compute_build_list_drift" "$COMPOSE_LIB"; then
  pass "compute_build_list_drift sentinel markers present in compose.sh"
else
  fail "compute_build_list_drift sentinel markers missing from compose.sh"
fi

# (5) Behavioural: extract the shipping guard function and exercise it.
eval "$(awk '/^compute_build_list_drift\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$COMPOSE_LIB")"
if declare -F compute_build_list_drift >/dev/null; then
  P12_OUT="$(printf 'a\nb\n' | compute_build_list_drift 'a,b,c')"
  if [ -z "$P12_OUT" ]; then
    pass "no drift reported when every enumerated service is accounted for"
  else
    fail "false-positive drift for fully-accounted services: '$P12_OUT'"
  fi
  P12_OUT="$(printf 'a\nshiny-new-svc\n' | compute_build_list_drift 'a,b')"
  if [ "$P12_OUT" = "shiny-new-svc" ]; then
    pass "unaccounted compose service is reported as drift"
  else
    fail "expected drift 'shiny-new-svc', got '$P12_OUT'"
  fi
  P12_OUT="$(printf '' | compute_build_list_drift 'a')"
  if [ -z "$P12_OUT" ]; then
    pass "empty enumeration (no jq / config failed) reports no drift — guard stays best-effort"
  else
    fail "empty enumeration should report no drift, got '$P12_OUT'"
  fi
else
  fail "compute_build_list_drift not extractable from compose.sh (skipping behavioural asserts)"
  TESTS=$((TESTS + 3)); FAILURES=$((FAILURES + 3))
fi

# (6) Wiring: prepare_and_build actually runs the guard, and only CI runs
# hard-fail on drift (a fleet box mid-provision must warn and continue).
P12_BUILD_BODY="$(awk '/^prepare_and_build\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$COMPOSE_LIB")"
if printf '%s' "$P12_BUILD_BODY" | grep -q 'compute_build_list_drift'; then
  pass "prepare_and_build invokes the drift guard"
else
  fail "prepare_and_build never calls compute_build_list_drift — the list can drift silently again"
fi
if printf '%s' "$P12_BUILD_BODY" | grep -qF '${CI:-}'; then
  pass "drift hard-fail is gated on CI (devices warn and continue provisioning)"
else
  fail "drift guard has no CI gate — either devices hard-fail on drift or CI never does"
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
