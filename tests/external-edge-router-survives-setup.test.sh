#!/usr/bin/env bash
# =============================================================================
# WARP-1980 — a setup re-run must not re-point a box off its real edge router.
# =============================================================================
#
# THE INVARIANT:
#   When OPENWRT_HOST names an EXTERNAL host, the values setup writes MUST keep
#   naming it. Only loopback/unset may be (re)written to the bundled container.
#
# WHY (this is the shipping customer shape, and the failure is silent):
#   `single-box` describes the INFERENCE topology — detect_single_box_mode()
#   reads DRM render nodes and probes for a separate Ollama host. It never looks
#   at the router. But configure_single_box_env() unconditionally wrote
#   OPENWRT_HOST=127.0.0.1 / PORT=8181 / USERNAME=root, so a single-box
#   appliance behind a real RB5009 lost its router pointer on every re-run.
#
#   Nothing errors when that happens: the bundled droplet-openwrt container is
#   running and answers, so the routing service just starts describing a router
#   nobody is on. Recovery needs both .env files rewritten AND the droplet-ai
#   credential re-enrolled.
#
# Static + behavioral; needs no docker, no root, no network.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/single-box.sh"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-1980: an external edge router survives a setup re-run ===\n\n'

[ -f "$LIB" ] || { printf 'FATAL: %s not found\n' "$LIB"; exit 1; }

# --- PART 1 (static) ---------------------------------------------------------

if grep -q 'WARP-1980' "$LIB"; then
  ok "single-box.sh carries the WARP-1980 guard"
else
  bad "single-box.sh has no WARP-1980 guard — a re-run re-points the box at the bundled container"
fi

# The guard must be decided by the CURRENT OPENWRT_HOST. Keying off anything
# else (the profile list, a shape flag) cannot tell a hand-wired box from a
# flat one, which is the whole distinction.
if awk '/WARP-1980/,/^  esac$/' "$LIB" | grep -q '_current_openwrt_host'; then
  ok "the guard reads the configured OPENWRT_HOST"
else
  bad "the guard does not read the configured OPENWRT_HOST"
fi

# --- PART 2 (behavioral): run the shipped block, not a copy of it ------------

host_after() {
  # $1 = OPENWRT_HOST already in .env ('' = key absent). Echoes host|port|user.
  local existing="$1"
  local tmp; tmp="$(mktemp -d)"
  local env_target="$tmp/.env"
  : > "$env_target"
  [ -n "$existing" ] && printf 'OPENWRT_HOST=%s\n' "$existing" >> "$env_target"
  # Seed the companions so "preserved" is distinguishable from "never written".
  printf 'OPENWRT_PORT=80\nOPENWRT_USERNAME=droplet-ai\n' >> "$env_target"

  local block
  block="$(awk '/^  # WARP-1980/,/^  esac$/' "$LIB")"

  (
    log_info() { :; }
    upsert_env() {
      local key="$1" val="$2" stage="${env_target}.upsert.$$"
      { grep -vE "^${key}=" "$env_target" 2>/dev/null || true; printf '%s=%s\n' "$key" "$val"; } > "$stage"
      mv "$stage" "$env_target"
    }
    eval "$block"
  ) >/dev/null 2>&1

  printf '%s|%s|%s' \
    "$(grep -E '^OPENWRT_HOST='     "$env_target" | tail -1 | cut -d= -f2-)" \
    "$(grep -E '^OPENWRT_PORT='     "$env_target" | tail -1 | cut -d= -f2-)" \
    "$(grep -E '^OPENWRT_USERNAME=' "$env_target" | tail -1 | cut -d= -f2-)"
  rm -rf "$tmp"
}

# The regression: the live lab/customer shape.
got="$(host_after '192.168.9.1')"
if [ "$got" = "192.168.9.1|80|droplet-ai" ]; then
  ok "external router preserved intact (got '$got')"
else
  bad "external router CLOBBERED — routing would talk to the bundled container (got '$got')"
fi

# A different subnet must work too — nothing may hardcode the lab's 192.168.9.0/24.
got="$(host_after '10.20.30.1')"
case "$got" in
  '10.20.30.1|'*) ok "external router on another subnet preserved (got '$got')" ;;
  *)              bad "external router on another subnet clobbered (got '$got')" ;;
esac

# A hostname, not just a dotted quad.
got="$(host_after 'droplet-edge.lan')"
case "$got" in
  'droplet-edge.lan|'*) ok "external router by hostname preserved (got '$got')" ;;
  *)                    bad "external router by hostname clobbered (got '$got')" ;;
esac

# The DEFAULT must survive: a fresh provision has no key and must get the
# bundled container, or a flat single-box ships with no router at all.
got="$(host_after '')"
if [ "$got" = "127.0.0.1|8181|root" ]; then
  ok "fresh provision still gets the bundled container (got '$got')"
else
  bad "fresh provision did NOT get the bundled defaults (got '$got')"
fi

# An already-flat box must be rewritten to the full bundled triple, not left
# with a stale port/user from an earlier external wiring.
got="$(host_after '127.0.0.1')"
if [ "$got" = "127.0.0.1|8181|root" ]; then
  ok "loopback box rewritten to the full bundled triple (got '$got')"
else
  bad "loopback box left with stale port/user (got '$got')"
fi

got="$(host_after 'localhost')"
if [ "$got" = "127.0.0.1|8181|root" ]; then
  ok "localhost treated as bundled (got '$got')"
else
  bad "localhost not normalised to the bundled container (got '$got')"
fi

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
