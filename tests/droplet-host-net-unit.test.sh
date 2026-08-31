#!/usr/bin/env bash
# =============================================================================
# WARP-2575 — unit-file invariants for droplet-host-net.service
#
# The bug: setup.sh (scripts/lib/single-box.sh) unconditionally `enable`s
# droplet-host-net, whose ExecStart is `set -euo pipefail` and whose FIRST
# command is `ip addr replace ... dev br-lan`. Nothing in this repo creates
# br-lan — the only definition is scripts/host/etc-netplan/70-eth.yaml.example,
# which setup.sh never installs — so on a stock single-box the unit fails
# instantly, every time. Measured on the bench box 2026-08-31: NRestarts=7251
# across 10 h 30 m of uptime (5.21 s apart), 3445 of 5725 journal lines in one
# hour, 60% of everything the box logged.
#
# It looped unbounded because systemd's DEFAULT start limiter cannot fire at
# this unit's RestartSec. Defaults are StartLimitIntervalSec=10s and
# StartLimitBurst=5; restarts land RestartSec apart, so tripping the limit
# needs the (burst+1)-th start to fall inside the window:
#
#       StartLimitBurst * RestartSec  <  StartLimitIntervalSec
#
# At the shipped 5 * 5s = 25s vs a 10s window, that is false — the guard is
# present in name and unreachable in fact.
#
# These tests assert the ARITHMETIC, not the literals. Bumping RestartSec to
# 30s while leaving the window at 120s re-breaks the guard (5 * 30 = 150 > 120)
# and must fail here, which grepping for `StartLimitIntervalSec=120` would not
# catch. Test 4 sabotages a copy of the unit to prove the check can fail at all
# (a guard that cannot fail is the defect this repo keeps re-finding).
#
# No root, no systemd, no box — pure text parsing of the tracked unit file.
# Runtime: < 1 second.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT="$REPO_ROOT_REAL/scripts/host/etc-systemd-system/droplet-host-net.service"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-2575 — droplet-host-net.service invariants"
echo "  ================================================"
echo ""

if [ ! -f "$UNIT" ]; then
  fail "$UNIT does not exist"
  echo ""
  echo "  1 of 1 tests FAILED"
  exit 1
fi

# --- helpers -----------------------------------------------------------------

# Last assignment of a directive wins in systemd, so tail -1 mirrors real
# parsing. The `^[[:space:]]*` anchor is load-bearing, not decoration: the
# unit's own rationale block quotes `# StartLimitIntervalSec=10s ...` while
# explaining the bug, and `#` is not whitespace, so a commented directive can
# never satisfy an assertion. The trailing `=` likewise keeps `Restart=` from
# matching `RestartSec=`.
directive() {
  local key="$1" file="${2:-$UNIT}"
  grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]'
}

# systemd time span -> seconds. Covers the forms this unit uses (bare integer =
# seconds, Ns, Nmin, Nms); anything else returns empty so the caller fails loudly
# rather than silently comparing against a zero.
to_seconds() {
  local v="$1"
  case "$v" in
    *ms) echo $(( ${v%ms} / 1000 )) ;;
    *min) echo $(( ${v%min} * 60 )) ;;
    *s) echo "${v%s}" ;;
    ''|*[!0-9]*) echo "" ;;
    *) echo "$v" ;;
  esac
}

# --- 1. the condition that stops the loop ------------------------------------

cond="$(directive ConditionPathExists)"
if [ "$cond" = "/sys/class/net/br-lan" ]; then
  pass "ConditionPathExists=/sys/class/net/br-lan — unit is skipped, not looped, where br-lan is absent"
else
  fail "ConditionPathExists must be /sys/class/net/br-lan (got: '${cond:-<unset>}')"
fi

# --- 2. Restart= is still what makes the limiter relevant --------------------

restart="$(directive Restart)"
if [ "$restart" = "on-failure" ]; then
  pass "Restart=on-failure (the setting the start limit has to bound)"
else
  fail "Restart expected on-failure (got: '${restart:-<unset>}') — revisit the start-limit arithmetic below"
fi

# --- 3. THE INVARIANT: burst * RestartSec < interval -------------------------

burst="$(directive StartLimitBurst)"
interval_raw="$(directive StartLimitIntervalSec)"
restartsec_raw="$(directive RestartSec)"

interval="$(to_seconds "$interval_raw")"
restartsec="$(to_seconds "$restartsec_raw")"

if [ -z "$burst" ] || [ -z "$interval" ] || [ -z "$restartsec" ]; then
  fail "need parseable StartLimitBurst / StartLimitIntervalSec / RestartSec (got: '${burst:-<unset>}' / '${interval_raw:-<unset>}' / '${restartsec_raw:-<unset>}')"
else
  span=$(( burst * restartsec ))
  if [ "$span" -lt "$interval" ]; then
    pass "start limiter is reachable: burst(${burst}) * RestartSec(${restartsec}s) = ${span}s < window ${interval}s"
  else
    fail "start limiter UNREACHABLE: burst(${burst}) * RestartSec(${restartsec}s) = ${span}s >= window ${interval}s — the unit would retry forever (this is the WARP-2575 defect)"
  fi
fi

# --- 4. mutation check: prove the invariant test can actually fail -----------
#
# Rebuilds the systemd defaults that shipped the bug (10s window) on a scratch
# copy and re-runs the same arithmetic. If this "passes", assertion 3 is
# decorative and every green run above is meaningless.

MUT="$(mktemp)"
trap 'rm -f "$MUT"' EXIT
sed -E 's/^([[:space:]]*)StartLimitIntervalSec=.*/\1StartLimitIntervalSec=10/' "$UNIT" > "$MUT"

mut_burst="$(directive StartLimitBurst "$MUT")"
mut_interval="$(to_seconds "$(directive StartLimitIntervalSec "$MUT")")"
mut_restartsec="$(to_seconds "$(directive RestartSec "$MUT")")"

if [ -n "$mut_burst" ] && [ -n "$mut_interval" ] && [ -n "$mut_restartsec" ] \
   && [ $(( mut_burst * mut_restartsec )) -ge "$mut_interval" ]; then
  pass "mutation: restoring systemd's 10s default window is correctly rejected"
else
  fail "mutation: a 10s window was NOT rejected — assertion 3 cannot fail and proves nothing"
fi

# --- 5. the comment must keep naming the ticket ------------------------------
#
# The condition looks removable to anyone who does not know br-lan is absent by
# construction on a stock box. The WARP-2575 breadcrumb is what stops the next
# person from "cleaning it up".

if grep -q 'WARP-2575' "$UNIT"; then
  pass "unit carries the WARP-2575 rationale breadcrumb"
else
  fail "unit lost its WARP-2575 breadcrumb — the condition reads as removable without it"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "  $TESTS of $TESTS tests passed"
  exit 0
fi
echo "  $FAILURES of $TESTS tests FAILED"
exit 1
