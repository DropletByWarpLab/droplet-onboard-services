#!/usr/bin/env bash
# =============================================================================
# WARP-1947 — single-box must DERIVE the overlay home endpoint IP.
# =============================================================================
#
# THE INVARIANT:
#   configure_single_box_env writes WIREGUARD_HOME_ENDPOINT_HOST = the box's
#   default-route egress IPv4, so an approved overlay device's profile carries
#   a REACHABLE `lan` candidate.
#
# WHY (this shipped, and it is a silent remote-access outage):
#   WIREGUARD_HOME_ENDPOINT_HOST is a request-time fallback (vpn-home-endpoint.ts),
#   but on the single-box shape the host owns the uplink so the routing summary
#   has no WAN, the device-bridge /host/uplink-ip returns null, and the env
#   fallback is consulted BEFORE that probe — so a STALE pin shadows discovery.
#   The live box shipped WIREGUARD_HOME_ENDPOINT_HOST=192.168.1.87, a dead former
#   IP; every issued overlay profile pointed its only endpoint at a corpse
#   ⇒ no_usable_endpoint. Deriving it at provision time (overwrite every run)
#   keeps it correct across DHCP changes and a factory reset.
#
# Static + behavioral; needs no docker, no root, no network — the real `ip`
# command is stubbed so the derivation runs deterministically.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/single-box.sh"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-1947: single-box derives the overlay home endpoint ===\n\n'

[ -f "$LIB" ] || { printf 'FATAL: %s not found\n' "$LIB"; exit 1; }

# --- PART 1 (static): the derivation exists and is wired to the upsert --------

if grep -q 'WARP-1947' "$LIB"; then
  ok "single-box.sh carries the WARP-1947 marker"
else
  bad "single-box.sh has no WARP-1947 marker — the home endpoint is not derived"
fi

# The upsert must READ the derivation, not hardcode an IP (a hardcode is exactly
# the stale-pin bug this fixes).
if awk '/upsert_env WIREGUARD_HOME_ENDPOINT_HOST/' "$LIB" | grep -q '\$'; then
  ok "WIREGUARD_HOME_ENDPOINT_HOST is upserted from a variable, not a literal IP"
else
  bad "WIREGUARD_HOME_ENDPOINT_HOST is not upserted from the derived value"
fi

# The derivation must not be gated behind the routing summary / bridge (which
# both fail on this shape) — it reads the kernel route directly.
if awk '/^derive_single_box_home_endpoint\(\)/,/^}/' "$LIB" | grep -q 'ip route get'; then
  ok "derivation reads the kernel default route (ip route get)"
else
  bad "derivation does not read the kernel default route"
fi

# --- PART 2 (behavioral): run the REAL derivation with a stubbed `ip` ---------
#
# Extract the shipped function and eval it, so a revert of the fix fails the
# test rather than a private copy of the logic passing forever.

derive_with() {
  # $1 = the line `ip route get 1.1.1.1` should print (empty => command fails).
  local route_line="$1"
  local fn
  fn="$(awk '/^derive_single_box_home_endpoint\(\)/,/^}/' "$LIB")"
  (
    # Stub the external `ip` command. Empty route_line => exit 1 (no route).
    ip() {
      [ -n "$route_line" ] || return 1
      printf '%s\n' "$route_line"
    }
    eval "$fn"
    derive_single_box_home_endpoint
  )
}

# A normal single-box default route → the src address is returned.
got="$(derive_with '1.1.1.1 via 192.168.9.1 dev enp11s0 src 192.168.9.195 uid 1000')"
if [ "$got" = "192.168.9.195" ]; then
  ok "derives the src IP from a normal default route (got '$got')"
else
  bad "did not derive the src IP (got '$got', want 192.168.9.195)"
fi

# A different interface ordering / cache line shape still parses.
got="$(derive_with '1.1.1.1 dev wlp10s0 src 10.50.0.232 uid 1000 \n    cache')"
if [ "$got" = "10.50.0.232" ]; then
  ok "parses src regardless of field order (got '$got')"
else
  bad "failed on an alternate route shape (got '$got', want 10.50.0.232)"
fi

# No default route (headless first boot) → fail so the caller leaves the value.
if got="$(derive_with '')"; then
  bad "returned success with no route (got '$got') — would blank/keep a wrong value"
else
  ok "no default route → non-zero exit (caller leaves the existing value)"
fi

# Placeholder / self addresses are refused (mirrors isUsableHostIp).
for junk in '0.0.0.0' '127.0.0.1' '169.254.10.9'; do
  if got="$(derive_with "1.1.1.1 dev lo src $junk uid 0")"; then
    bad "accepted an unusable address $junk (got '$got')"
  else
    ok "refuses the unusable address $junk"
  fi
done

# A non-dotted-quad in the src slot must never leak into a conf.
if got="$(derive_with '1.1.1.1 dev eth0 src not-an-ip uid 0')"; then
  bad "accepted a non-IP src (got '$got')"
else
  ok "refuses a non-IP src token"
fi

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
