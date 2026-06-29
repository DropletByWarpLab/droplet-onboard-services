#!/usr/bin/env bash
# =============================================================================
# KAN-9 (UPnP / NAT-PMP sub-item) — miniupnpd must ship in the single-box image
# so the UpnpCard lights up.
#
# The whole UPnP software stack already exists end-to-end:
#   * routing SDK  — FirewallApi.upnp_status() reads the real uci state and
#     degrades a MISSING /etc/config/upnpd to {available:false}; set_upnp()
#     writes enable_upnp/enable_natpmp + uci.apply (services/routing).
#   * REST + orchestrator + dashboard UpnpCard are all wired.
# The ONLY thing gating the card today is that miniupnpd (and therefore its
# /etc/config/upnpd) never ships in openwrt/singlebox-image/Dockerfile, so
# upnp_status() always sees "config missing" → available:false → the card shows
# the read-only "Not available" line. There is NO code-level supported flag to
# flip — it is purely a runtime presence check (case a).
#
# Static drift guards (no Docker needed, < 1s):
#   1. the singlebox image BAKES miniupnpd into the opkg install list;
#   2. the image seeds a DISABLED-by-default /etc/config/upnpd via uci-defaults
#      so the config EXISTS (available:true) but opens nothing until the owner
#      toggles it — the privacy-first default the card copy promises;
#   3. the seed sets enable_upnp/enable_natpmp to 0 (the read source-of-truth
#      upnp_status() inspects) — not the stock package default of 1, which would
#      misreport "enabled" on a box whose daemon hasn't been asked to open ports;
#   4. the attach script's runtime install list (the safety net for containers
#      created from pre-bake images) ALSO installs miniupnpd, mirroring the
#      Dockerfile the same way it mirrors hostapd/umdns/ddns.
# Reflash-on-.87 remains the real proof that miniupnpd actually comes up and
# upnp_status() reads it — these guards only lock the image contract.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOCKERFILE="$REPO_ROOT/openwrt/singlebox-image/Dockerfile"
UPNP_SEED="$REPO_ROOT/openwrt/singlebox-image/uci-defaults/61-droplet-upnp-default"
ATTACH="$REPO_ROOT/scripts/host/usr-local-sbin/droplet-openwrt-attach"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }

# 1. The image bakes miniupnpd into the opkg install list.
if grep -Eq '(^|[[:space:]])miniupnpd([[:space:]]|\\|$)' "$DOCKERFILE"; then
  ok "Dockerfile installs miniupnpd"
else
  bad "Dockerfile does not install miniupnpd"
fi

# 2. The image COPYs the UPnP-default uci-defaults seed.
if grep -Eq '^COPY +singlebox-image/uci-defaults/61-droplet-upnp-default +/etc/uci-defaults/61-droplet-upnp-default' "$DOCKERFILE"; then
  ok "Dockerfile bakes the 61-droplet-upnp-default uci-default"
else
  bad "Dockerfile does not COPY the 61-droplet-upnp-default uci-default"
fi

# 3. The seed exists, is executable, and disables UPnP/NAT-PMP by default while
#    leaving the upnpd config present (available:true, enabled:false).
if [ -x "$UPNP_SEED" ]; then
  ok "61-droplet-upnp-default is present and executable"
else
  bad "61-droplet-upnp-default is missing or not executable"
fi

if grep -q "enable_upnp='0'" "$UPNP_SEED" && grep -q "enable_natpmp='0'" "$UPNP_SEED"; then
  ok "seed sets enable_upnp + enable_natpmp off by default (privacy-first)"
else
  bad "seed does not set enable_upnp/enable_natpmp to 0"
fi

# 3b. The seed creates the upnpd 'config' section so upnp_status() reads it
#     rather than 500-ing / degrading to available:false.
if grep -q "uci set upnpd.config='upnpd'" "$UPNP_SEED"; then
  ok "seed ensures the upnpd 'config' section exists (available:true)"
else
  bad "seed does not ensure the upnpd 'config' section exists"
fi

# 3c. Idempotent: re-running the seed (uci-defaults can re-run on attach for
#     pre-bake containers) must not stack sections — it uses `uci set` on a
#     named section, not `uci add`.
if grep -q "uci add upnpd" "$UPNP_SEED"; then
  bad "seed uses 'uci add' (would stack a new section on re-run) — use named 'uci set'"
else
  ok "seed is idempotent (named uci set, no anonymous uci add)"
fi

# 4. The attach safety-net install list (pre-bake containers) also installs
#    miniupnpd, mirroring the Dockerfile.
ATTACH_INSTALL="$(sed -n '/opkg install \\/,/2>&1)"/p' "$ATTACH")"
if printf '%s' "$ATTACH_INSTALL" | grep -Eq '(^|[[:space:]])miniupnpd([[:space:]]|\\|$)'; then
  ok "attach script's runtime install list includes miniupnpd"
else
  bad "attach script does not install miniupnpd for pre-bake containers"
fi

echo
echo "openwrt-attach-singlebox-upnp: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
