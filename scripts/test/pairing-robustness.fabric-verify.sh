#!/usr/bin/env bash
# =============================================================================
# Droplet — ADR-071 pairing robustness, verified on a LIVE fabric (WARP-3883)
# =============================================================================
#
# The switch-service unit tests drive the reconnect tick with a fake driver.
# What they cannot show is that the box really recovers when the real devices
# misbehave: a switch that reboots and forgets our rpcd session, a switch that
# is unreachable while the box waits to pair, an AP or router that reboots.
# This script makes the devices do exactly that and asserts the box comes back
# on its own, with NO container restart.
#
# RUN IT FROM AN OPERATOR MACHINE on the fabric's LAN, with key SSH to root@ on
# the switch/AP/router and to the box as a docker-group user:
#
#     bash scripts/test/pairing-robustness.fabric-verify.sh A B C D E
#     SWITCH_HOST=10.0.0.2 BOX_HOST=10.0.0.5 bash scripts/test/pairing-robustness.fabric-verify.sh A
#
# Scenarios (each restores what it changes; run any subset, in any order):
#   A  switch unreachable while the box waits in SWITCH_AUTH  -> back to AUTH, then connected
#   B  switch unreachable when the switch container starts     -> connected once reachable
#   C  switch reboot while paired (rpcd forgets the session)    -> connected within seconds
#   D  AP reboot while paired (its DHCP address may change)     -> box follows it by MAC, radios up
#   E  router reboot while connected                            -> routing reconnects
#
# ── WHAT IT TOUCHES, AND HOW IT IS PUT BACK ─────────────────────────────────
# A changes the switch's droplet-ai rpcd password (the box then sees what a
# reflash looks like) after saving the shadow line to /root/da.shadow.bak on the
# switch. A and B add an nft table `droptest` on the switch that drops ONLY the
# box's tcp/80 (ubus); SSH and switching are untouched. An EXIT trap removes the
# table and restores the shadow line even on Ctrl-C or a failed assertion. If
# the operator machine dies mid-run: `nft delete table inet droptest` and put
# /root/da.shadow.bak back into /etc/shadow on the switch. A and B restart the
# switch container once (to start from a known state). C, D, E reboot devices:
# expect the LAN to drop for a few minutes on C (the switch carries it) and the
# uplink on E.
#
# Exit code: 0 when every assertion in the requested scenarios passed.
# =============================================================================
set -uo pipefail

BOX_HOST="${BOX_HOST:-192.168.9.195}"
BOX_USER="${BOX_USER:-support}"
SWITCH_HOST="${SWITCH_HOST:-192.168.9.2}"
AP_HOST="${AP_HOST:-}"   # default: ask the box (routing) where the AP currently is
ROUTER_HOST="${ROUTER_HOST:-192.168.9.1}"
SWITCH_CTR="${SWITCH_CTR:-droplet-switch-1}"
ROUTING_CTR="${ROUTING_CTR:-droplet-routing-1}"
SWITCH_PORT="${SWITCH_PORT:-8081}"
ROUTING_PORT="${ROUTING_PORT:-8080}"

O=(-o BatchMode=yes -o ConnectTimeout=6 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o LogLevel=ERROR)
dev() { local h="$1"; shift; ssh "${O[@]}" "root@$h" "$@"; }
box() { ssh -o BatchMode=yes -o ConnectTimeout=6 "$BOX_USER@$BOX_HOST" "$@"; }
ts()  { date +%T; }
FAILED=0
pass() { echo "$(ts) PASS: $*"; }
fail() { echo "$(ts) FAIL: $*"; FAILED=1; }

# The box reaches the fabric from its PRIMARY address, which need not be the one
# operators use (on the lab box: .250 primary, .195 secondary). Block both.
BOX_SRC="$(box "ip -4 route get $SWITCH_HOST" 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
BOX_ADDRS="${BOX_SRC:+$BOX_SRC, }$BOX_HOST"

# Switch-service /health, flattened: "<status> <connected> <error_code> <pairing.state> | <error>".
swh() {
  box "docker exec $SWITCH_CTR python3 -c 'import json,urllib.request as u; h=json.load(u.urlopen(\"http://127.0.0.1:$SWITCH_PORT/health\")); print(h[\"status\"], h[\"connected\"], h[\"error_code\"], (h.get(\"pairing\") or {}).get(\"state\"), \"|\", h[\"error\"])'" 2>/dev/null
}
# GET on the routing API with its own bearer token. The routing image has no
# curl/python on PATH; the switch container (host network) makes the call. The
# token goes container-to-container through `-e`, never through the terminal.
routing_get() {
  box "T=\$(docker exec $ROUTING_CTR printenv ROUTING_SERVICE_TOKEN); docker exec -e T=\"\$T\" $SWITCH_CTR python3 -c 'import os,urllib.request as u; r=u.Request(\"http://127.0.0.1:$ROUTING_PORT$1\", headers={\"Authorization\": \"Bearer \"+os.environ[\"T\"]}); print(u.urlopen(r, timeout=15).read().decode())'" 2>/dev/null
}
wait_swh() { # <ERE> <seconds> -> prints elapsed seconds; non-zero on timeout
  local re="$1" t="$2" s=$SECONDS h=""
  while (( SECONDS - s < t )); do h="$(swh)"; [[ "$h" =~ $re ]] && { echo "$((SECONDS - s))"; return 0; }; sleep 5; done
  echo "timeout; last: $h"; return 1
}
wait_ssh() { local s=$SECONDS; until dev "$1" true 2>/dev/null; do (( SECONDS - s > ${2:-480} )) && return 1; sleep 5; done; }
started() { box "docker inspect $1 --format '{{.State.StartedAt}}'"; }

block_box()   { dev "$SWITCH_HOST" "nft add table inet droptest && nft add chain inet droptest input '{ type filter hook input priority -10 ; }' && nft add rule inet droptest input ip saddr '{ $BOX_ADDRS }' tcp dport 80 drop"; }
unblock_box() { dev "$SWITCH_HOST" 'nft delete table inet droptest 2>/dev/null; true'; }
restore_pw()  { dev "$SWITCH_HOST" 'test -s /root/da.shadow.bak || exit 0; grep -v "^droplet-ai:" /etc/shadow > /tmp/s && cat /root/da.shadow.bak >> /tmp/s && cat /tmp/s > /etc/shadow && rm -f /tmp/s /root/da.shadow.bak'; }
cleanup() { unblock_box >/dev/null 2>&1; restore_pw >/dev/null 2>&1; }
trap cleanup EXIT

scenario_A() {
  echo "$(ts) == A: switch unreachable while the box waits in SWITCH_AUTH"
  dev "$SWITCH_HOST" 'grep "^droplet-ai:" /etc/shadow > /root/da.shadow.bak && test -s /root/da.shadow.bak' || { fail "could not save the shadow line"; return; }
  dev "$SWITCH_HOST" 'p=$(head -c 24 /dev/urandom | md5sum | cut -c1-24); printf "%s\n%s\n" "$p" "$p" | passwd droplet-ai >/dev/null 2>&1'
  [ "$(dev "$SWITCH_HOST" 'grep "^droplet-ai:" /etc/shadow | cmp -s - /root/da.shadow.bak && echo SAME || echo CHANGED')" = CHANGED ] \
    || { fail "the temporary password change did not take"; restore_pw; return; }
  box "docker restart $SWITCH_CTR >/dev/null"; local st; st="$(started "$SWITCH_CTR")"
  local e; e="$(wait_swh 'SWITCH_AUTH' 90)" && pass "box in SWITCH_AUTH after ${e}s" || fail "never reached SWITCH_AUTH ($e)"
  block_box && echo "$(ts) box ubus traffic ($BOX_ADDRS) dropped at the switch"
  sleep 75
  local h; h="$(swh)"; echo "$(ts) health while blocked: $h"
  [[ "$h" =~ ^disconnected\ False\ None\ (unknown|None) && "$h" =~ retrying ]] \
    && pass "truthful while unreachable: disconnected, retrying, no SWITCH_AUTH, no window" || fail "health while unreachable: $h"
  local n; n="$(box "docker logs --since 2m $SWITCH_CTR 2>&1 | grep -c 'disconnected, will retry'")"
  (( n >= 2 )) && pass "reconnect job kept firing while unreachable ($n retries)" || fail "only $n retries logged"
  box "docker logs --since 2m $SWITCH_CTR 2>&1 | grep -q 'Removed job switch-pairing-probe'" \
    && fail "reconnect job was removed while unreachable" || pass "reconnect job NOT removed while unreachable"
  unblock_box && echo "$(ts) unblocked"
  e="$(wait_swh 'SWITCH_AUTH' 90)" && pass "back to SWITCH_AUTH ${e}s after reachable again" || fail "did not return to SWITCH_AUTH ($e)"
  restore_pw && echo "$(ts) switch droplet-ai password restored"
  e="$(wait_swh '^ok True None' 120)" && pass "connected ${e}s after the credential matched again" || fail "did not reconnect ($e)"
  [ "$(started "$SWITCH_CTR")" = "$st" ] && pass "no container restart during recovery" || fail "container restarted"
}

scenario_B() {
  echo "$(ts) == B: switch unreachable when the switch container starts"
  block_box && echo "$(ts) box ubus traffic dropped"
  box "docker restart $SWITCH_CTR >/dev/null"; local st; st="$(started "$SWITCH_CTR")"
  sleep 40
  local h; h="$(swh)"; echo "$(ts) health at startup while blocked: $h"
  [[ "$h" =~ ^disconnected\ False && "$h" =~ retrying ]] && pass "startup-unreachable reported truthfully" || fail "startup health: $h"
  unblock_box && echo "$(ts) unblocked"
  local e; e="$(wait_swh '^ok True None' 120)" && pass "connected ${e}s after unblock" || fail "did not connect ($e)"
  [ "$(started "$SWITCH_CTR")" = "$st" ] && pass "no container restart" || fail "container restarted"
}

scenario_C() {
  echo "$(ts) == C: switch reboot while paired"
  local st; st="$(started "$SWITCH_CTR")"
  dev "$SWITCH_HOST" reboot; echo "$(ts) switch rebooting"
  sleep 60; wait_ssh "$SWITCH_HOST" || { fail "switch did not come back"; return; }
  echo "$(ts) switch answering SSH again"
  local e; e="$(wait_swh '^ok True None' 180)" && pass "connected ${e}s after the switch was back" || fail "did not reconnect ($e)"
  dev "$SWITCH_HOST" 'ubus call droplet.pair status' | tr -d '\n\t' | grep -q '"paired"' && pass "switch still paired" || fail "switch pairing lost"
  [ "$(started "$SWITCH_CTR")" = "$st" ] && pass "no container restart" || fail "container restarted"
}

scenario_D() {
  echo "$(ts) == D: AP reboot while paired"
  local mac; mac="${AP_MAC:-$(routing_get /aps/discovered | sed -n 's/.*"mac":"\([^"]*\)".*/\1/p' | head -1)}"
  [ -n "$mac" ] || { fail "no AP MAC (set AP_MAC)"; return; }
  local enc; enc="$(printf %s "$mac" | sed 's/:/%3A/g')"
  # An AP's address is a DHCP pool address and may change across a reboot, so the
  # box is asked where the AP is, before and after; nothing here pins an IP.
  local ip; ip="${AP_HOST:-$(routing_get "/aps/$enc/pairing" | sed -n 's/.*"host": *"\([^"]*\)".*/\1/p')}"
  [ -n "$ip" ] || { fail "the box does not know where AP $mac is"; return; }
  dev "$ip" reboot; echo "$(ts) AP $mac ($ip) rebooting"
  sleep 60
  local s=$SECONDS ok=0 w
  while (( SECONDS - s < 420 )); do
    w="$(routing_get "/aps/$enc/wireless")"
    (( $(grep -o '"up": *true' <<<"$w" | wc -l) >= 2 )) && { ok=1; break; }
    sleep 10
  done
  (( ok )) && pass "box reads both AP radios up again $((SECONDS - s + 60))s after the reboot" || fail "AP radios not reported up via the box"
  local p; p="$(routing_get "/aps/$enc/pairing")"
  [[ "$p" =~ \"state\":\ *\"paired\" ]] && pass "AP still paired (box view)" || fail "AP pairing not reported paired: ${p:0:200}"
  local now; now="$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' <<<"$p")"
  local disc; disc="$(routing_get /aps/discovered | grep -o "\"mac\":\"$mac\"[^}]*" | sed -n 's/.*"last_ip":"\([^"]*\)".*/\1/p')"
  [ -n "$now" ] && [ "$now" = "$disc" ] && pass "box dials and reports the same AP address ($now; was $ip)" \
    || fail "box dials ${now:-?} but reports ${disc:-?} to the orchestrator"
}

scenario_E() {
  echo "$(ts) == E: router reboot while connected"
  local st; st="$(started "$ROUTING_CTR")"
  dev "$ROUTER_HOST" reboot; echo "$(ts) router rebooting"
  sleep 45; wait_ssh "$ROUTER_HOST" || { fail "router did not come back"; return; }
  echo "$(ts) router answering SSH"
  local s=$SECONDS ok=0
  while (( SECONDS - s < 300 )); do routing_get /health | grep -q '"connected": *true' && { ok=1; break; }; sleep 5; done
  (( ok )) && pass "routing connected $((SECONDS - s))s after the router was back" || fail "routing did not reconnect"
  [ "$(started "$ROUTING_CTR")" = "$st" ] && pass "no routing container restart" || fail "routing container restarted"
}

[ $# -gt 0 ] || { echo "usage: $0 A|B|C|D|E ..."; exit 2; }
echo "$(ts) box $BOX_HOST (fabric source ${BOX_SRC:-unknown}), switch $SWITCH_HOST, AP ${AP_HOST:-<from the box>}, router $ROUTER_HOST"
for sc in "$@"; do
  case "$sc" in A|B|C|D|E) "scenario_$sc" ;; *) echo "unknown scenario: $sc"; exit 2 ;; esac
done
(( FAILED )) && echo "$(ts) RESULT: FAILED" || echo "$(ts) RESULT: all passed"
exit "$FAILED"
