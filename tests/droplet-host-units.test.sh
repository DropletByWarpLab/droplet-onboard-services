#!/usr/bin/env bash
# =============================================================================
# WARP-1829 — unit tests for scripts/host/droplet-host-units.sh
#
# Host systemd units execute their source straight out of the git working
# tree (droplet-device-bridge.service: ExecStart=/usr/bin/python3
# <repo>/services/oled-display/device-bridge.py). Python reads source once at
# process start, so a `git pull` that fixes the file changes NOTHING about the
# running process — and the failure is silent by construction: the code on
# disk is correct, `systemctl status` says active (running), only the process
# disagrees. Verified live on 2026-08-09: the bridge had run 5d20h on a file
# whose mtime was 2026-08-08.
#
# These tests drive the detector + refresher against a PATH-stubbed systemctl
# and a fixture tree with controlled mtimes — no root, no systemd, no box.
#
# Runtime: < 20 seconds.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_UNITS="$REPO_ROOT_REAL/scripts/host/droplet-host-units.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

PYBIN="$(command -v python3 || command -v python)"

echo ""
echo "  ================================================"
echo "  WARP-1829 — droplet-host-units"
echo "  ================================================"
echo ""

if [ ! -f "$HOST_UNITS" ]; then
  fail "scripts/host/droplet-host-units.sh does not exist"
  echo ""
  echo "  1 of 1 tests FAILED"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Epochs used across the fixtures. The two headline values are the ones
# measured live on the box on 2026-08-09.
BRIDGE_START_EPOCH=$(date -u -d "2026-08-03 22:22:39 UTC" +%s)   # PID 5602
BRIDGE_SRC_EPOCH=$(date -u -d "2026-08-08 02:37:27 UTC" +%s)     # device-bridge.py mtime
FRESH_SRC_EPOCH=$(date -u -d "2026-08-01 00:00:00 UTC" +%s)
FRESH_START_EPOCH=$(date -u -d "2026-08-02 00:00:00 UTC" +%s)

# --- fixture builders --------------------------------------------------------

reset_work() {
  rm -rf "${WORK:?}/repo" "${WORK:?}/sbin" "${WORK:?}/lib" "${WORK:?}/units" \
         "${WORK:?}/show" "${WORK:?}/bin" "${WORK:?}/state" "${WORK:?}/log"
  mkdir -p "$WORK/repo/services/oled-display" "$WORK/repo/scripts/host" \
           "$WORK/repo/.git" "$WORK/sbin" "$WORK/lib" "$WORK/show" \
           "$WORK/bin" "$WORK/state" "$WORK/log"
  : > "$WORK/units"
  : > "$WORK/log/actions.log"
  : > "$WORK/restart_fail"
}

# systemctl stub. Reads unit properties from $WORK/show/<unit>, logs every
# state-changing verb to $WORK/log/actions.log, and fails `restart` for any
# unit listed in $WORK/restart_fail (which also flips that unit's fixture to
# inactive so the post-restart verification sees a unit that did NOT come back).
mk_systemctl_stub() {
  cat > "$WORK/bin/systemctl" <<EOF
#!/usr/bin/env bash
log="$WORK/log/actions.log"
showdir="$WORK/show"
units="$WORK/units"
failfile="$WORK/restart_fail"

# The verb is the first non-flag argument; the unit is always the LAST
# argument (real systemctl takes it that way, and \`show -p A -p B <unit>\`
# would otherwise make "A" look like the target).
verb=""
for a in "\$@"; do
  case "\$a" in
    -*) ;;
    *) [ -z "\$verb" ] && verb="\$a" ;;
  esac
done
target=""
for a in "\$@"; do target="\$a"; done
case "\$target" in -*) target="" ;; esac
[ "\$target" = "\$verb" ] && target=""

case "\$verb" in
  list-units)
    # Mimic \`systemctl list-units --no-legend --plain\`: UNIT LOAD ACTIVE SUB DESC
    while IFS= read -r u; do
      [ -n "\$u" ] || continue
      active="\$(grep -m1 '^ActiveState=' "\$showdir/\$u" 2>/dev/null | cut -d= -f2)"
      sub="\$(grep -m1 '^SubState=' "\$showdir/\$u" 2>/dev/null | cut -d= -f2)"
      printf '%s loaded %s %s fixture unit\n' "\$u" "\${active:-inactive}" "\${sub:-dead}"
    done < "\$units"
    exit 0 ;;
  show)
    [ -f "\$showdir/\$target" ] || exit 0
    cat "\$showdir/\$target"
    exit 0 ;;
  daemon-reload)
    printf 'daemon-reload\n' >> "\$log"
    exit 0 ;;
  restart)
    printf 'restart %s\n' "\$target" >> "\$log"
    if grep -qxF "\$target" "\$failfile" 2>/dev/null; then
      # Did not come back: flip the fixture to a dead unit.
      sed -i -e 's/^ActiveState=.*/ActiveState=failed/' \\
             -e 's/^SubState=.*/SubState=failed/' \\
             -e 's/^MainPID=.*/MainPID=0/' "\$showdir/\$target"
      exit 1
    fi
    # Came back: new main process, started now.
    sed -i -e 's/^ActiveState=.*/ActiveState=active/' \\
           -e 's/^SubState=.*/SubState=running/' \\
           -e 's/^MainPID=.*/MainPID=99999/' \\
           -e "s/^ExecMainStartTimestamp=.*/ExecMainStartTimestamp=@\$(date -u +%s)/" \\
           "\$showdir/\$target"
    exit 0 ;;
  *)
    printf '%s %s\n' "\$verb" "\$target" >> "\$log"
    exit 0 ;;
esac
EOF
  chmod +x "$WORK/bin/systemctl"
}

# Write a unit fixture.
#   mk_unit <unit> <type> <remain> <activestate> <mainpid> <start-epoch> <argv...>
mk_unit() {
  local unit="$1" type="$2" remain="$3" active="$4" mainpid="$5" start="$6"
  shift 6
  local argv="$*"
  local frag="$WORK/units.d/$unit"
  mkdir -p "$WORK/units.d"
  printf '[Unit]\nDescription=fixture %s\n' "$unit" > "$frag"
  touch -d "@$FRESH_SRC_EPOCH" "$frag"
  cat > "$WORK/show/$unit" <<EOF
Id=$unit
Type=$type
RemainAfterExit=$remain
ActiveState=$active
SubState=running
MainPID=$mainpid
FragmentPath=$frag
DropInPaths=
ExecMainStartTimestamp=@$start
ExecStart={ path=$1 ; argv[]=$argv ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=$mainpid ; code=(null) ; status=0/0 }
EOF
  echo "$unit" >> "$WORK/units"
}

# The live-verified fixture: bridge started 2026-08-03, sources 2026-08-08.
mk_stale_bridge() {
  local entry="$WORK/repo/services/oled-display/device-bridge.py"
  printf 'print("bridge")\n' > "$entry"
  printf 'print("display")\n' > "$WORK/repo/services/oled-display/display.py"
  touch -d "@$BRIDGE_SRC_EPOCH" "$entry" \
           "$WORK/repo/services/oled-display/display.py"
  mk_unit droplet-device-bridge.service simple no active 5602 "$BRIDGE_START_EPOCH" \
    /usr/bin/python3 "$entry"
}

# A long-running unit that IS current: source older than the process.
mk_current_host_net() {
  printf '#!/bin/bash\nexec /usr/sbin/dnsmasq -k\n' > "$WORK/sbin/droplet-host-net"
  chmod +x "$WORK/sbin/droplet-host-net"
  touch -d "@$FRESH_SRC_EPOCH" "$WORK/sbin/droplet-host-net"
  mk_unit droplet-host-net.service simple no active 4242 "$FRESH_START_EPOCH" \
    "$WORK/sbin/droplet-host-net"
}

# oneshot: re-executes its source on every activation — never a candidate.
mk_oneshot_watchdog() {
  printf '#!/bin/bash\nexit 0\n' > "$WORK/sbin/droplet-watchdog"
  chmod +x "$WORK/sbin/droplet-watchdog"
  touch -d "@$BRIDGE_SRC_EPOCH" "$WORK/sbin/droplet-watchdog"
  mk_unit droplet-watchdog.service oneshot no inactive 0 "$BRIDGE_START_EPOCH" \
    "$WORK/sbin/droplet-watchdog"
}

# The whole container stack. RemainAfterExit oneshot — restarting it would
# `compose down` the box. Must NEVER be a candidate.
mk_stack_unit() {
  mk_unit droplet.service oneshot yes active 0 "$BRIDGE_START_EPOCH" \
    /usr/bin/docker compose -f "$WORK/repo/docker/docker-compose.yml" up -d
}

# Shell launcher whose real payload lives in an installed lib dir — the
# argv-only view would miss a change to collector.py entirely.
mk_egress_audit() {
  mkdir -p "$WORK/lib/droplet-egress-audit"
  printf 'print("collector")\n' > "$WORK/lib/droplet-egress-audit/collector.py"
  printf 'print("sink")\n' > "$WORK/lib/droplet-egress-audit/sink.py"
  cat > "$WORK/sbin/droplet-egress-audit" <<EOF
#!/bin/bash
exec /usr/bin/python3 $WORK/lib/droplet-egress-audit/collector.py
EOF
  chmod +x "$WORK/sbin/droplet-egress-audit"
  touch -d "@$FRESH_SRC_EPOCH" "$WORK/sbin/droplet-egress-audit" \
           "$WORK/lib/droplet-egress-audit/collector.py" \
           "$WORK/lib/droplet-egress-audit/sink.py"
  mk_unit droplet-egress-audit.service exec no active 4343 "$FRESH_START_EPOCH" \
    "$WORK/sbin/droplet-egress-audit"
}

# --- runner ------------------------------------------------------------------

run_hu() { # <extra VAR=val ...> -- <args>
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  env PATH="$WORK/bin:$PATH" \
      DROPLET_HOST_UNITS_STATE_DIR="$WORK/state" \
      DROPLET_HOST_UNITS_PAYLOAD_ROOTS="$WORK/lib" \
      DROPLET_HOST_UNITS_REPO_ROOT="$WORK/repo" \
      DROPLET_HOST_UNITS_SETTLE_SECONDS=0 \
      ${envs[@]+"${envs[@]}"} \
      bash "$HOST_UNITS" "$@" 2>&1
}

actions() { cat "$WORK/log/actions.log"; }

json_get() { # <json-file> <python-expr on doc>
  "$PYBIN" -c '
import json, sys
doc = json.load(open(sys.argv[1]))
print(eval(sys.argv[2], {"doc": doc}))
' "$1" "$2"
}

unit_state() { # <json-file> <unit>
  "$PYBIN" -c '
import json, sys
doc = json.load(open(sys.argv[1]))
for u in doc["units"]:
    if u["unit"] == sys.argv[2]:
        print(u["state"]); break
else:
    print("ABSENT")
' "$1" "$2"
}

unit_field() { # <json-file> <unit> <field>
  "$PYBIN" -c '
import json, sys
doc = json.load(open(sys.argv[1]))
for u in doc["units"]:
    if u["unit"] == sys.argv[2]:
        print(u.get(sys.argv[3], "MISSING")); break
else:
    print("ABSENT")
' "$1" "$2" "$3"
}

# =============================================================================
# Phase 0: static
# =============================================================================
echo "--- Phase 0: static checks ---"

if bash -n "$HOST_UNITS" 2>/dev/null; then
  pass "droplet-host-units.sh passes bash -n"
else
  fail "droplet-host-units.sh fails bash -n"
  exit 1
fi

if grep -qE 'while[[:space:]]+true|while[[:space:]]*:' "$HOST_UNITS"; then
  fail "droplet-host-units.sh contains a while-true loop (architecture-guard rule 9)"
else
  pass "no while-true scheduler (architecture-guard rule 9)"
fi

# Repo-tracked host script, installed by setup.sh — never hand-placed (rule 20).
if grep -q 'droplet-host-units' "$REPO_ROOT_REAL/scripts/lib/single-box.sh"; then
  pass "single-box.sh installs droplet-host-units"
else
  fail "single-box.sh does not install droplet-host-units (rule 20: no hand-placed box scripts)"
fi
if grep -q 'droplet-host-units' "$REPO_ROOT_REAL/scripts/setup.sh"; then
  pass "setup.sh runs the host-unit refresh after the checkout is installed"
else
  fail "setup.sh never invokes droplet-host-units"
fi
if [ -f "$REPO_ROOT_REAL/scripts/host/etc-systemd-system/droplet-host-units.service" ]; then
  pass "unit file scripts/host/etc-systemd-system/droplet-host-units.service exists"
else
  fail "unit file scripts/host/etc-systemd-system/droplet-host-units.service missing"
fi
# The detection check must also ride the existing supervisor's timer — no new
# scheduler (rule 9), and the box reports staleness on its own.
if grep -q 'host_unit_staleness' "$REPO_ROOT_REAL/scripts/host/droplet-watchdog.sh"; then
  pass "droplet-watchdog.sh carries the host_unit_staleness check"
else
  fail "droplet-watchdog.sh has no host_unit_staleness check"
fi

# =============================================================================
# Phase 1: detection — the live-verified stale fixture
# =============================================================================
echo "--- Phase 1: detection ---"

reset_work
mk_systemctl_stub
mk_stale_bridge
mk_current_host_net

out="$(run_hu -- check)"
rc=$?
if [ "$rc" -eq 1 ]; then
  pass "check exits 1 when a unit is older than its own code"
else
  fail "check exit code: expected 1 (stale found), got $rc"
  printf '%s\n' "$out" | sed 's/^/      /'
fi
if printf '%s\n' "$out" | grep -q 'droplet-device-bridge.service'; then
  pass "check names the stale unit"
else
  fail "check output does not name droplet-device-bridge.service"
fi
if printf '%s\n' "$out" | grep -qi 'stale'; then
  pass "check output says STALE"
else
  fail "check output never says stale"
fi
# Nothing may be restarted by a detection run — it stands on its own (AC4).
if [ ! -s "$WORK/log/actions.log" ]; then
  pass "check is read-only — no restart, no daemon-reload"
else
  fail "check mutated systemd state:"
  actions | sed 's/^/      /'
fi

run_hu -- check --json > "$WORK/check.json" 2>/dev/null
if "$PYBIN" -m json.tool "$WORK/check.json" >/dev/null 2>&1; then
  pass "check --json emits valid JSON"
else
  fail "check --json is not valid JSON"
  cat "$WORK/check.json" | sed 's/^/      /'
fi
if [ "$(unit_state "$WORK/check.json" droplet-device-bridge.service)" = "stale" ]; then
  pass "json: droplet-device-bridge.service state=stale"
else
  fail "json: droplet-device-bridge.service state=$(unit_state "$WORK/check.json" droplet-device-bridge.service)"
fi
if [ "$(unit_state "$WORK/check.json" droplet-host-net.service)" = "current" ]; then
  pass "json: droplet-host-net.service state=current (source older than the process)"
else
  fail "json: droplet-host-net.service state=$(unit_state "$WORK/check.json" droplet-host-net.service)"
fi
if [ "$(json_get "$WORK/check.json" 'doc["stale_count"]')" = "1" ]; then
  pass "json: stale_count=1"
else
  fail "json: stale_count=$(json_get "$WORK/check.json" 'doc["stale_count"]')"
fi
# The whole point of the check is a ONE-LINE answer: which file, when.
if [ "$(unit_field "$WORK/check.json" droplet-device-bridge.service newest_source)" \
      = "$WORK/repo/services/oled-display/device-bridge.py" ]; then
  pass "json: names the newest source file"
else
  fail "json: newest_source=$(unit_field "$WORK/check.json" droplet-device-bridge.service newest_source)"
fi

# =============================================================================
# Phase 2: source resolution — imports, unit files, installed payloads
# =============================================================================
echo "--- Phase 2: source resolution ---"

# A change to an IMPORTED module is just as stale-making as a change to the
# entry point: device-bridge.py is untouched, display.py moved.
reset_work; mk_systemctl_stub
printf 'print("bridge")\n' > "$WORK/repo/services/oled-display/device-bridge.py"
printf 'print("display")\n' > "$WORK/repo/services/oled-display/display.py"
touch -d "@$FRESH_SRC_EPOCH" "$WORK/repo/services/oled-display/device-bridge.py"
touch -d "@$BRIDGE_SRC_EPOCH" "$WORK/repo/services/oled-display/display.py"
mk_unit droplet-device-bridge.service simple no active 5602 "$FRESH_START_EPOCH" \
  /usr/bin/python3 "$WORK/repo/services/oled-display/device-bridge.py"
run_hu -- check --json > "$WORK/c2.json" 2>/dev/null
if [ "$(unit_state "$WORK/c2.json" droplet-device-bridge.service)" = "stale" ]; then
  pass "a changed IMPORTED module marks the unit stale"
else
  fail "imported-module change missed: state=$(unit_state "$WORK/c2.json" droplet-device-bridge.service)"
fi
if [ "$(unit_field "$WORK/c2.json" droplet-device-bridge.service newest_source)" \
      = "$WORK/repo/services/oled-display/display.py" ]; then
  pass "the imported module is named as the newest source"
else
  fail "newest_source=$(unit_field "$WORK/c2.json" droplet-device-bridge.service newest_source)"
fi

# A shell launcher's real payload (installed lib dir) counts as source.
reset_work; mk_systemctl_stub
mk_egress_audit
touch -d "@$BRIDGE_SRC_EPOCH" "$WORK/lib/droplet-egress-audit/collector.py"
run_hu -- check --json > "$WORK/c3.json" 2>/dev/null
if [ "$(unit_state "$WORK/c3.json" droplet-egress-audit.service)" = "stale" ]; then
  pass "a changed installed payload behind a shell launcher marks the unit stale"
else
  fail "payload change missed: state=$(unit_state "$WORK/c3.json" droplet-egress-audit.service)"
fi

# A changed UNIT FILE means systemd's loaded ExecStart may differ from disk.
reset_work; mk_systemctl_stub
mk_current_host_net
touch -d "@$BRIDGE_SRC_EPOCH" "$WORK/units.d/droplet-host-net.service"
run_hu -- check --json > "$WORK/c4.json" 2>/dev/null
if [ "$(unit_state "$WORK/c4.json" droplet-host-net.service)" = "stale" ]; then
  pass "a changed unit file marks the unit stale"
else
  fail "unit-file change missed: state=$(unit_state "$WORK/c4.json" droplet-host-net.service)"
fi

# EnvironmentFile must NOT be a source: the bridge WRITES its own
# /var/lib/droplet-bridge/openwrt-attach.env, so counting it would make the
# unit restart itself forever.
reset_work; mk_systemctl_stub
mk_current_host_net
printf 'SECRET=1\n' > "$WORK/state/some.env"
touch -d "@$BRIDGE_SRC_EPOCH" "$WORK/state/some.env"
printf 'EnvironmentFiles=%s\n' "$WORK/state/some.env" >> "$WORK/show/droplet-host-net.service"
run_hu -- check --json > "$WORK/c5.json" 2>/dev/null
if [ "$(unit_state "$WORK/c5.json" droplet-host-net.service)" = "current" ]; then
  pass "EnvironmentFile changes are NOT sources (self-write restart loop hazard)"
else
  fail "EnvironmentFile leaked into the source set: state=$(unit_state "$WORK/c5.json" droplet-host-net.service)"
fi

# =============================================================================
# Phase 3: scope — what is never a candidate
# =============================================================================
echo "--- Phase 3: scope ---"

reset_work; mk_systemctl_stub
mk_stale_bridge
mk_oneshot_watchdog
mk_stack_unit
run_hu -- check --json > "$WORK/c6.json" 2>/dev/null

if [ "$(unit_state "$WORK/c6.json" droplet-watchdog.service)" = "skipped" ]; then
  pass "oneshot units are skipped (they re-execute their source every activation)"
else
  fail "oneshot not skipped: state=$(unit_state "$WORK/c6.json" droplet-watchdog.service)"
fi
if [ "$(unit_state "$WORK/c6.json" droplet.service)" = "skipped" ]; then
  pass "droplet.service (RemainAfterExit oneshot, the whole stack) is skipped"
else
  fail "droplet.service not skipped: state=$(unit_state "$WORK/c6.json" droplet.service)"
fi

out="$(run_hu -- refresh)"
if actions | grep -q '^restart droplet.service$'; then
  fail "refresh restarted droplet.service — that is a compose down of the whole box"
else
  pass "refresh never restarts droplet.service"
fi
if actions | grep -q '^restart droplet-watchdog.service$'; then
  fail "refresh restarted a oneshot unit"
else
  pass "refresh never restarts a oneshot unit"
fi
if actions | grep -q '^restart droplet-host-units.service$'; then
  fail "refresh restarted its own unit"
else
  pass "refresh never restarts its own unit"
fi

# =============================================================================
# Phase 4: refresh — only the stale ones, deliberately ordered
# =============================================================================
echo "--- Phase 4: refresh ---"

reset_work; mk_systemctl_stub
mk_stale_bridge
mk_current_host_net
out="$(run_hu -- refresh)"
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "refresh exits 0 when every restart comes back"
else
  fail "refresh exit code: expected 0, got $rc"
  printf '%s\n' "$out" | sed 's/^/      /'
fi
if [ "$(grep -c '^restart ' "$WORK/log/actions.log")" = "1" ] \
   && actions | grep -q '^restart droplet-device-bridge.service$'; then
  pass "refresh restarts ONLY the stale unit"
else
  fail "refresh restart set wrong:"
  actions | sed 's/^/      /'
fi

# Second run right after: nothing is stale any more — no restart storm.
: > "$WORK/log/actions.log"
run_hu -- refresh >/dev/null 2>&1
if [ ! -s "$WORK/log/actions.log" ]; then
  pass "a second refresh is a no-op (self-terminating, no restart loop)"
else
  fail "second refresh restarted something again:"
  actions | sed 's/^/      /'
fi

# Ordering: the panel's data feed + console-handback path goes LAST, so a
# failure there happens with every other unit already known-good.
reset_work; mk_systemctl_stub
mk_stale_bridge
printf '#!/bin/bash\nexec /usr/sbin/dnsmasq -k\n' > "$WORK/sbin/droplet-host-net"
chmod +x "$WORK/sbin/droplet-host-net"
touch -d "@$BRIDGE_SRC_EPOCH" "$WORK/sbin/droplet-host-net"
mk_unit droplet-host-net.service simple no active 4242 "$BRIDGE_START_EPOCH" \
  "$WORK/sbin/droplet-host-net"
run_hu -- refresh >/dev/null 2>&1
order="$(grep '^restart ' "$WORK/log/actions.log" | sed 's/^restart //' | tr '\n' ' ')"
if [ "$order" = "droplet-host-net.service droplet-device-bridge.service " ]; then
  pass "restart order puts droplet-device-bridge last (panel feed + console handback)"
else
  fail "restart order wrong: [$order]"
fi

# A changed unit FILE needs a daemon-reload before the restart, or systemd
# restarts the unit it still has loaded.
reset_work; mk_systemctl_stub
mk_current_host_net
touch -d "@$BRIDGE_SRC_EPOCH" "$WORK/units.d/droplet-host-net.service"
run_hu -- refresh >/dev/null 2>&1
if [ "$(head -1 "$WORK/log/actions.log")" = "daemon-reload" ]; then
  pass "daemon-reload runs before the restart when a unit file changed"
else
  fail "no daemon-reload before restart:"
  actions | sed 's/^/      /'
fi

# No daemon-reload when only code changed — the unit definition is untouched.
reset_work; mk_systemctl_stub
mk_stale_bridge
run_hu -- refresh >/dev/null 2>&1
if actions | grep -q '^daemon-reload$'; then
  fail "daemon-reload issued for a pure code change"
else
  pass "no daemon-reload for a pure code change"
fi

# =============================================================================
# Phase 5: bounded failure — loud, and never a retry storm
# =============================================================================
echo "--- Phase 5: bounded failure ---"

reset_work; mk_systemctl_stub
mk_stale_bridge
echo "droplet-device-bridge.service" > "$WORK/restart_fail"
out="$(run_hu -- refresh)"
rc=$?
if [ "$rc" -ne 0 ]; then
  pass "refresh exits non-zero when a unit does not come back"
else
  fail "refresh exited 0 despite a unit that never came back"
fi
if printf '%s\n' "$out" | grep -q 'CRITICAL'; then
  pass "a unit that fails to come back is surfaced loudly (CRITICAL)"
else
  fail "no CRITICAL line for a unit that never came back:"
  printf '%s\n' "$out" | sed 's/^/      /'
fi
if [ "$(grep -c '^restart droplet-device-bridge.service$' "$WORK/log/actions.log")" = "1" ]; then
  pass "exactly one restart attempt per unit per invocation"
else
  fail "restart attempted $(grep -c '^restart droplet-device-bridge.service$' "$WORK/log/actions.log") times in one run"
fi

# Next invocation must NOT hammer the same broken unit.
: > "$WORK/log/actions.log"
out="$(run_hu -- refresh)"
if actions | grep -q '^restart droplet-device-bridge.service$'; then
  fail "a unit that failed its last restart was retried without --force"
else
  pass "a unit that failed its last restart is not retried (no restart storm)"
fi
if printf '%s\n' "$out" | grep -q 'CRITICAL'; then
  pass "the suspended unit keeps being surfaced loudly"
else
  fail "suspended unit went quiet:"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

# --force overrides the suspension (operator escape hatch).
: > "$WORK/log/actions.log"
run_hu -- refresh --force >/dev/null 2>&1
if actions | grep -q '^restart droplet-device-bridge.service$'; then
  pass "--force retries a suspended unit"
else
  fail "--force did not retry the suspended unit"
fi

# NEW code lands → the suspension lifts on its own (the fix may be the fix).
: > "$WORK/log/actions.log"
: > "$WORK/restart_fail"
touch -d "@$(date -u +%s)" "$WORK/repo/services/oled-display/device-bridge.py"
run_hu -- refresh >/dev/null 2>&1
if actions | grep -q '^restart droplet-device-bridge.service$'; then
  pass "a suspended unit is retried once its sources change again"
else
  fail "suspended unit stayed suspended after its sources changed"
fi

# =============================================================================
# Phase 6: install drift — report-only, never a failing exit
# =============================================================================
echo "--- Phase 6: install drift ---"

reset_work; mk_systemctl_stub
mk_current_host_net
# Repo source of the installed copy, with different content and a newer mtime:
# the box pulled but never re-ran setup.sh.
mkdir -p "$WORK/repo/scripts/host/usr-local-sbin"
printf '#!/bin/bash\nexec /usr/sbin/dnsmasq -k --new-flag\n' \
  > "$WORK/repo/scripts/host/usr-local-sbin/droplet-host-net"
touch -d "@$BRIDGE_SRC_EPOCH" "$WORK/repo/scripts/host/usr-local-sbin/droplet-host-net"
run_hu -- check --json > "$WORK/c7.json" 2>/dev/null
rc=$?
if [ "$(unit_field "$WORK/c7.json" droplet-host-net.service install_drift)" = "True" ]; then
  pass "install drift is detected (installed copy != repo source)"
else
  fail "install drift missed: install_drift=$(unit_field "$WORK/c7.json" droplet-host-net.service install_drift)"
fi
if [ "$rc" -eq 0 ]; then
  pass "install drift alone does not fail the check (expected between pull and setup.sh)"
else
  fail "install drift set a failing exit code ($rc) — alarm fatigue"
fi
: > "$WORK/log/actions.log"
run_hu -- refresh >/dev/null 2>&1
if actions | grep -q '^restart '; then
  fail "refresh restarted a unit for install drift alone (a restart cannot fix it)"
else
  pass "refresh does not restart on install drift alone"
fi

# =============================================================================
# Phase 7: usage
# =============================================================================
echo "--- Phase 7: usage ---"

run_hu -- --help >/dev/null 2>&1
if [ $? -eq 0 ]; then pass "--help exits 0"; else fail "--help did not exit 0"; fi
run_hu -- bogus >/dev/null 2>&1
if [ $? -eq 2 ]; then pass "an unknown subcommand exits 2"; else fail "unknown subcommand did not exit 2"; fi

# =============================================================================
echo ""
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mAll %d tests passed\033[0m\n\n" "$TESTS"
  exit 0
fi
printf "  \033[31m%d of %d tests FAILED\033[0m\n\n" "$FAILURES" "$TESTS"
exit 1
