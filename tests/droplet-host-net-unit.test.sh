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

# --- 6. WARP-3574: host input firewall PROPOSAL (disabled) ----------------------
#
# The proposal lives at scripts/host/proposed/*.nft.proposed and is wired into
# nothing. These checks keep it honest: (a) it stays disabled, (b) it has a
# default-drop shape that cannot lock the box out of its own loopback/containers,
# and (c) every host-network listener the repo defines has an inventory line, so
# a NEW 0.0.0.0 listener with no allow-or-internal decision fails here.

FW="$REPO_ROOT_REAL/scripts/host/proposed/droplet-host-input.nft.proposed"
echo "--- WARP-3574: host input firewall proposal ---"
if [ ! -f "$FW" ]; then
  fail "firewall proposal missing at scripts/host/proposed/droplet-host-input.nft.proposed"
else
  # (a) disabled: no installer, unit or setup path references it.
  if grep -rIl 'droplet-host-input' "$REPO_ROOT_REAL/scripts" "$REPO_ROOT_REAL/services" "$REPO_ROOT_REAL/docker" 2>/dev/null \
       | grep -v 'scripts/host/proposed/' | grep -q .; then
    fail "something under scripts/, services/ or docker/ references the firewall proposal - it must stay disabled until reviewed"
  else
    pass "firewall proposal is referenced by no installer or unit (disabled by default)"
  fi

  # (b) shape.
  fw_code="$(grep -vE '^[[:space:]]*#' "$FW")"
  chk() { printf '%s\n' "$fw_code" | grep -qE "$1" && pass "$2" || fail "$2 (missing: $1)"; }
  chk 'policy drop;'                         "input chain defaults to drop"
  chk 'ct state established,related accept'  "established/related accepted"
  chk 'iifname "lo" accept'                  "loopback accepted"
  chk 'iifname "docker0" accept'             "docker0 containers accepted"
  chk 'iifname "br-\*" ip saddr 172\.16\.0\.0/12 accept' "compose bridge accepted only with a Docker-pool source (br-lan does not match)"
  chk 'ip protocol icmp accept'              "ICMP accepted"
  chk 'ip6 nexthdr icmpv6 accept'            "ICMPv6 accepted (neighbour discovery)"
  chk 'log prefix "droplet-input-drop: "'    "fall-through is logged (observe mode)"

  # (c) every repo-defined host listener has an inventory line, and the
  #     lan/internal decision matches the accept rules.
  if command -v python3 >/dev/null 2>&1; then
    scan_py="$(mktemp)"
    cat > "$scan_py" <<'PY'
import re, sys, os
root, fw = sys.argv[1], sys.argv[2]
compose = open(os.path.join(root, "docker/docker-compose.yml")).read()

# {service: {ports}} for every service with `network_mode: host`.
host = {}
for m in re.finditer(r"^  ([a-z0-9-]+):\n(.*?)(?=^  [a-z0-9-]+:\n|\Z)", compose, re.S | re.M):
    name, body = m.group(1), m.group(2)
    if not re.search(r"^    network_mode: host\s*$", body, re.M):
        continue
    ports = set()
    df = re.search(r"dockerfile:\s*(\S+)", body)
    if df:
        p = os.path.join(root, df.group(1))
        if os.path.exists(p):
            ports |= set(re.findall(r"^EXPOSE\s+(\d+)", open(p).read(), re.M))
    ports |= set(re.findall(r"^\s+- PORT=(\d+)\s*$", body, re.M))
    host[name] = ports

# The device bridge: a host systemd unit binding 0.0.0.0.
unit = open(os.path.join(root, "services/oled-display/droplet-device-bridge.service")).read()
bp = re.search(r"^Environment=BRIDGE_PORT=(\d+)", unit, re.M)
if bp and re.search(r"^Environment=BRIDGE_BIND=0\.0\.0\.0", unit, re.M):
    host["device-bridge"] = {bp.group(1)}

inv = {}  # service -> (kind, ports)
text = open(fw).read()
for line in text.splitlines():
    m = re.match(r"#\s*host-listener:\s+(\S+)\s+(\S+)\s+(\S+)\s+(lan|internal|none)\s*$", line)
    if m:
        inv.setdefault(m.group(3), []).append((m.group(4), set(m.group(2).split(","))))
code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
accept_lines = [l for l in code.splitlines() if "dport" in l and "accept" in l]

def has_accept(port):
    return any(re.search(r"\b%s\b" % re.escape(port), l) for l in accept_lines)

bad = []
if len(host) < 6:
    bad.append("scan found only %d host listeners (%s): the guard has gone blind" % (len(host), sorted(host)))
for svc, ports in sorted(host.items()):
    if svc not in inv:
        bad.append("host listener '%s' (ports %s) has no 'host-listener:' line in the proposal" % (svc, sorted(ports) or "unknown"))
        continue
    for port in ports:
        kinds = [k for k, ps in inv[svc] if port in ps]
        if not kinds:
            bad.append("%s port %s is not listed in its inventory line" % (svc, port))
        elif kinds[0] == "lan" and not has_accept(port):
            bad.append("%s port %s is marked lan but has no accept rule" % (svc, port))
        elif kinds[0] == "internal" and has_accept(port):
            bad.append("%s port %s is marked internal but an accept rule opens it" % (svc, port))
for svc, entries in inv.items():
    for kind, ports in entries:
        if kind == "lan":
            for port in ports:
                if not has_accept(port):
                    bad.append("%s port %s is marked lan but has no accept rule" % (svc, port))
print("\n".join(bad))
PY
    fw_out="$(python3 "$scan_py" "$REPO_ROOT_REAL" "$FW")"

    if [ -z "$fw_out" ]; then
      pass "every host-network listener (and the bridge) has an inventory line matching the accept rules"
    else
      fail "firewall inventory out of step with the repo's host listeners:"
      printf '      %s\n' "$fw_out"
    fi
    # Mutation control: the same scan, run on a copy with one inventory line
    # removed, must report it - otherwise the check above cannot fail.
    mut="$(mktemp)"; grep -v 'host-listener: tcp 8085 camera-discovery' "$FW" > "$mut"
    if python3 "$scan_py" "$REPO_ROOT_REAL" "$mut" | grep -q 'camera-discovery'; then
      pass "mutation: a listener missing from the inventory is reported"
    else
      fail "mutation: dropping an inventory line was NOT reported - the guard cannot fail"
    fi
    rm -f "$mut" "$scan_py"
  else
    pass "python3 unavailable - listener inventory scan skipped"
  fi

  # Syntax: only when nft can check without prompting.
  if command -v nft >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    if sudo -n nft -c -f "$FW" >/dev/null 2>&1; then
      pass "nft accepts the proposal (nft -c)"
    else
      fail "nft -c rejected the proposal"
    fi
  else
    pass "nft/sudo unavailable - syntax check skipped"
  fi
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "  $TESTS of $TESTS tests passed"
  exit 0
fi
echo "  $FAILURES of $TESTS tests FAILED"
exit 1
