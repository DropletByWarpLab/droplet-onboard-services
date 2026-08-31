#!/usr/bin/env bash
# =============================================================================
# WARP-1002 — unit tests for scripts/host/droplet-watchdog.sh
#
# The unified on-box self-heal supervisor: one timer-driven script running
# pluggable checks (wifi wedge via the WARP-869 helper, XVF3800 voice-DSP
# wedge, docker daemon DNS, container crash-loops), writing an explicit
# per-check status enum to status.json and escalating after consecutive heal
# failures. These tests drive it against fake sysfs trees, a fake kernel log,
# and stub docker / xvf_host binaries — no root, no hardware, no docker
# daemon needed. Mirrors tests/wifi-watchdog.test.sh's harness conventions.
#
# Runtime: < 30 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
WATCHDOG="$REPO_ROOT_REAL/scripts/host/droplet-watchdog.sh"
WIFI_HELPER_REAL="$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-wifi-watchdog"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

# python for JSON validation/extraction (python3 on CI/box; python on some dev hosts)
PYBIN="$(command -v python3 || command -v python)"

echo ""
echo "  ================================================"
echo "  WARP-1002 — droplet-watchdog"
echo "  ================================================"
echo ""

if [ ! -f "$WATCHDOG" ]; then
  fail "scripts/host/droplet-watchdog.sh does not exist"
  echo ""
  echo "  1 of 1 tests FAILED"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- helpers -----------------------------------------------------------------

# Reset the per-scenario fixture tree (state survives only when a test wants it).
reset_work() {
  rm -rf "${WORK:?}/state" "${WORK:?}/pci" "${WORK:?}/usb" "${WORK:?}/bin" \
         "${WORK:?}/docker" "${WORK:?}/klog" "${WORK:?}/rescan" \
         "${WORK:?}/daemon.json" "${WORK:?}/host_units_exit" \
         "${WORK:?}/host_units_out" "${WORK:?}/host_units.log" \
         "${WORK:?}/relay_check_exit" "${WORK:?}/relay_check_exit2" \
         "${WORK:?}/relay_check_n" "${WORK:?}/relay_repair_exit" \
         "${WORK:?}/relay.log"
  mkdir -p "$WORK/bin" "$WORK/docker"
  : > "$WORK/klog"
}

# Fake PCI device factory (same layout the WARP-869 helper reads).
mk_pci_dev() { # <name> <class> [bound] [netdev|phy]
  local d="$WORK/pci/$1"
  mkdir -p "$d"
  printf '%s\n' "$2" > "$d/class"
  [ "${3:-}" = "bound" ] && ln -s /dev/null "$d/driver"
  if [ "${4:-}" = "netdev" ]; then mkdir -p "$d/net/wlan0"; fi
  if [ "${4:-}" = "phy" ]; then mkdir -p "$d/ieee80211/phy0"; fi
  return 0
}

# Fake USB device with an idVendor (XMOS is 20b1).
mk_usb_dev() { # <name> <vendor>
  mkdir -p "$WORK/usb/$1"
  printf '%s\n' "$2" > "$WORK/usb/$1/idVendor"
}

# xvf_host stub: logs invocations; exit code from $WORK/xvf_exit (default 0).
mk_xvf_stub() {
  cat > "$WORK/bin/xvf_host" <<EOF
#!/bin/sh
printf 'xvf_host %s\n' "\$*" >> "$WORK/xvf.log"
exit \$(cat "$WORK/xvf_exit" 2>/dev/null || echo 0)
EOF
  chmod +x "$WORK/bin/xvf_host"
}

# docker stub: dispatches on subcommand, reads fixtures, logs invocations.
#   $WORK/docker/running        docker ps           (one name per line)
#   $WORK/docker/all            docker ps -a        (one name per line)
#   $WORK/docker/restarts       "<name> <count>" per line (docker inspect)
#   $WORK/docker/dns_exit       exit code for docker exec (default 0)
#   $WORK/docker/logs           content emitted by docker logs
mk_docker_stub() {
  cat > "$WORK/bin/docker" <<EOF
#!/bin/sh
printf 'docker %s\n' "\$*" >> "$WORK/docker.log"
case "\$1" in
  ps)
    if echo "\$*" | grep -q -- '-a'; then cat "$WORK/docker/all" 2>/dev/null
    else cat "$WORK/docker/running" 2>/dev/null; fi
    exit 0 ;;
  inspect)
    # last arg is the container name
    for last in "\$@"; do :; done
    awk -v c="\$last" '\$1 == c { print \$2; found=1 } END { exit found ? 0 : 1 }' \
      "$WORK/docker/restarts" 2>/dev/null ;;
  exec)
    exit \$(cat "$WORK/docker/dns_exit" 2>/dev/null || echo 0) ;;
  logs)
    cat "$WORK/docker/logs" 2>/dev/null
    exit 0 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$WORK/bin/docker"
}

# Run the watchdog with the standard fixture env. Extra VAR=val pairs may be
# passed as leading args. Never let a non-zero exit kill the test harness.
run_wd() {
  env PATH="$WORK/bin:$PATH" \
      DROPLET_WATCHDOG_STATE_DIR="$WORK/state" \
      DROPLET_WATCHDOG_WIFI_HELPER="$WIFI_HELPER_REAL" \
      DROPLET_WIFI_SYS_PCI="$WORK/pci" \
      DROPLET_WIFI_RESCAN="$WORK/rescan" \
      DROPLET_WIFI_SETTLE_S=0 \
      DROPLET_WIFI_WAIT_S=0 \
      DROPLET_WIFI_AP_IN_CONTAINER=0 \
      DROPLET_WIFI_ATTACH_UNIT= \
      DROPLET_WATCHDOG_USB_SYS="$WORK/usb" \
      DROPLET_WATCHDOG_KLOG_FILE="$WORK/klog" \
      DROPLET_WATCHDOG_XVF_HOST="$WORK/bin/xvf_host" \
      DROPLET_WATCHDOG_XVF_COOLDOWN_S=0 \
      DROPLET_WATCHDOG_DOCKER_DAEMON_JSON="$WORK/daemon.json" \
      DROPLET_WATCHDOG_HOST_UNITS_BIN="$WORK/bin/droplet-host-units" \
      DROPLET_WATCHDOG_RELAY_DNS_BIN="$WORK/bin/droplet-relay-dns" \
      "$@" \
      bash "$WATCHDOG" 2>&1
}

# WARP-2189 droplet-relay-dns stub. Exit codes come from fixtures:
#   $WORK/relay_check_exit    exit for `check`   (default 0)
#   $WORK/relay_check_exit2   exit for the SECOND and later `check` calls —
#                             i.e. the independent re-check after a repair
#   $WORK/relay_repair_exit   exit for `repair`  (default 0)
mk_relay_dns_stub() {
  cat > "$WORK/bin/droplet-relay-dns" <<EOF
#!/bin/sh
printf 'droplet-relay-dns %s\n' "\$*" >> "$WORK/relay.log"
case "\$1" in
  check)
    n=\$(cat "$WORK/relay_check_n" 2>/dev/null || echo 0)
    n=\$((n + 1)); echo "\$n" > "$WORK/relay_check_n"
    echo "droplet-relay-dns: origin verdict"
    if [ "\$n" -ge 2 ] && [ -f "$WORK/relay_check_exit2" ]; then
      exit \$(cat "$WORK/relay_check_exit2")
    fi
    exit \$(cat "$WORK/relay_check_exit" 2>/dev/null || echo 0) ;;
  repair)
    echo "droplet-relay-dns: repair verdict"
    exit \$(cat "$WORK/relay_repair_exit" 2>/dev/null || echo 0) ;;
esac
exit 0
EOF
  chmod +x "$WORK/bin/droplet-relay-dns"
}

# WARP-1829 droplet-host-units stub: logs its invocation, prints
# $WORK/host_units_out, exits with $WORK/host_units_exit (default 0).
mk_host_units_stub() {
  cat > "$WORK/bin/droplet-host-units" <<EOF
#!/bin/sh
printf 'droplet-host-units %s\n' "\$*" >> "$WORK/host_units.log"
cat "$WORK/host_units_out" 2>/dev/null
exit \$(cat "$WORK/host_units_exit" 2>/dev/null || echo 0)
EOF
  chmod +x "$WORK/bin/droplet-host-units"
}

STATUS_JSON="$WORK/state/status.json"

# Extract .checks.<name>.<field> from status.json.
wd_field() { # <check> <field>
  "$PYBIN" -c '
import json, sys
doc = json.load(open(sys.argv[1]))
print(doc["checks"][sys.argv[2]][sys.argv[3]])
' "$STATUS_JSON" "$1" "$2"
}

wd_overall() {
  "$PYBIN" -c 'import json,sys; print(json.load(open(sys.argv[1]))["overall"])' "$STATUS_JSON"
}

# =============================================================================
# Phase 0: static checks
# =============================================================================
echo "--- Phase 0: static checks ---"

if bash -n "$WATCHDOG" 2>/dev/null; then
  pass "droplet-watchdog.sh passes bash -n"
else
  fail "droplet-watchdog.sh fails bash -n"
  exit 1
fi

# Install wiring: setup.sh's single-box host integration must install the
# supervisor + timer, and the legacy standalone wifi-watchdog timer must no
# longer be enabled by install-device-bridge.sh (the unified timer owns the
# schedule now — two independent schedulers could race a PCI heal).
if grep -q 'droplet-watchdog.timer' "$REPO_ROOT_REAL/scripts/lib/single-box.sh"; then
  pass "single-box.sh installs/enables droplet-watchdog.timer"
else
  fail "single-box.sh does not reference droplet-watchdog.timer"
fi
if grep -Eq 'systemctl enable --now droplet-wifi-watchdog.timer' \
     "$REPO_ROOT_REAL/scripts/install-device-bridge.sh"; then
  fail "install-device-bridge.sh still enables the standalone wifi-watchdog timer"
else
  pass "install-device-bridge.sh no longer enables the standalone wifi-watchdog timer"
fi
for unit in droplet-watchdog.service droplet-watchdog.timer; do
  if [ -f "$REPO_ROOT_REAL/scripts/host/etc-systemd-system/$unit" ]; then
    pass "unit file scripts/host/etc-systemd-system/$unit exists"
  else
    fail "unit file scripts/host/etc-systemd-system/$unit missing"
  fi
done

# =============================================================================
# Phase 1: status.json shape — every known check explicit, never absent
# =============================================================================
echo "--- Phase 1: status.json shape ---"

reset_work
# No docker stub, no wifi PCI device, no XMOS USB device → everything n/a.
run_wd DROPLET_WATCHDOG_CHECKS="voice_dsp" >/dev/null || true

if [ -f "$STATUS_JSON" ] && "$PYBIN" -m json.tool "$STATUS_JSON" >/dev/null 2>&1; then
  pass "status.json exists and is valid JSON"
else
  fail "status.json missing or invalid"
  cat "$STATUS_JSON" 2>/dev/null || true
  exit 1
fi

# The check list is read out of the script's own WD_ALL_CHECKS rather than
# hand-copied here: a hand-copied list silently stops covering the newest check,
# which is how host_artefacts (WARP-2574) and relay_dns went untested by this
# assertion for as long as they did.
ALL_CHECKS="$(grep -oE '^WD_ALL_CHECKS="[^"]+"' "$WATCHDOG" \
  | sed -e 's/^WD_ALL_CHECKS="//' -e 's/"$//')"
if [ -z "$ALL_CHECKS" ]; then
  fail "could not read WD_ALL_CHECKS from droplet-watchdog.sh — this assertion would cover nothing"
else
  all_present=1
  for c in $ALL_CHECKS; do
    s="$(wd_field "$c" status 2>/dev/null || echo MISSING)"
    case "$s" in
      ok|healed|heal_failed|escalated|not_applicable) : ;;
      *) all_present=0 ;;
    esac
  done
  if [ "$all_present" = 1 ]; then
    pass "every check in WD_ALL_CHECKS ($ALL_CHECKS) carries an explicit enum status"
  else
    fail "a check is missing or carries a non-enum status: $(cat "$STATUS_JSON")"
  fi
fi

# Checks not in DROPLET_WATCHDOG_CHECKS are explicitly not_applicable.
if [ "$(wd_field wifi status)" = "not_applicable" ] \
   && [ "$(wd_field docker_dns status)" = "not_applicable" ]; then
  pass "disabled checks are explicitly not_applicable"
else
  fail "disabled checks are not marked not_applicable"
fi

if [ ! -e "$STATUS_JSON.tmp" ] && ! ls "$WORK/state"/status.json.tmp.* >/dev/null 2>&1; then
  pass "no leftover temp file from the atomic status write"
else
  fail "atomic-write temp file left behind"
fi

# =============================================================================
# Phase 2: not_applicable gating (hardware / tooling absent)
# =============================================================================
echo "--- Phase 2: not_applicable gating ---"

reset_work
run_wd >/dev/null || true

[ "$(wd_field wifi status)" = "not_applicable" ] \
  && pass "wifi is not_applicable with no Wi-Fi-class PCI device" \
  || fail "wifi expected not_applicable, got $(wd_field wifi status)"

[ "$(wd_field voice_dsp status)" = "not_applicable" ] \
  && pass "voice_dsp is not_applicable with no XMOS USB device" \
  || fail "voice_dsp expected not_applicable, got $(wd_field voice_dsp status)"

# docker checks: PATH stub dir has no docker binary. The host running this
# test may have docker on PATH, so force the CLI lookup to miss via a PATH
# that still contains the essentials but not docker: we approximate by
# pointing the compose-project filter at a stub that returns nothing instead.
mk_docker_stub   # empty fixtures: no containers at all
run_wd >/dev/null || true
[ "$(wd_field docker_dns status)" = "not_applicable" ] \
  && pass "docker_dns is not_applicable with no running containers" \
  || fail "docker_dns expected not_applicable, got $(wd_field docker_dns status)"
[ "$(wd_field container_crashloop status)" = "not_applicable" ] \
  && pass "container_crashloop is not_applicable with no containers" \
  || fail "container_crashloop expected not_applicable, got $(wd_field container_crashloop status)"

[ "$(wd_overall)" = "ok" ] \
  && pass "overall is ok when every check is n/a or ok" \
  || fail "overall expected ok, got $(wd_overall)"

# =============================================================================
# Phase 3: voice_dsp — detection, heal, cooldown, escalation
# =============================================================================
echo "--- Phase 3: voice_dsp (XVF3800) ---"

reset_work
mk_xvf_stub
mk_usb_dev "1-3" "20b1"
# Two overruns < default threshold 3 → ok.
printf 'xhci_hcd 0000:00:14.0: WARN Event TRB Overrun\nxhci_hcd: isoc overrun\n' > "$WORK/klog"
run_wd >/dev/null || true
[ "$(wd_field voice_dsp status)" = "ok" ] \
  && pass "overrun count below threshold → ok" \
  || fail "expected ok below threshold, got $(wd_field voice_dsp status)"
[ ! -f "$WORK/xvf.log" ] \
  && pass "no DSP reboot issued below threshold" \
  || fail "xvf_host invoked below threshold: $(cat "$WORK/xvf.log")"

# Threshold hit → heal (xvf_host REBOOT 1) → healed.
printf 'xhci overrun\nxhci overrun\nxhci Overrun\n' > "$WORK/klog"
run_wd >/dev/null || true
[ "$(wd_field voice_dsp status)" = "healed" ] \
  && pass "wedge signature → healed" \
  || fail "expected healed, got $(wd_field voice_dsp status)"
grep -q 'REBOOT 1' "$WORK/xvf.log" 2>/dev/null \
  && pass "heal issued 'xvf_host REBOOT 1'" \
  || fail "xvf_host REBOOT 1 not issued: $(cat "$WORK/xvf.log" 2>/dev/null)"
if [ -f "$WORK/state/heal.log" ] \
   && grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z .*voice_dsp' "$WORK/state/heal.log"; then
  pass "heal action logged with a UTC timestamp"
else
  fail "heal.log missing or missing timestamped voice_dsp entry: $(cat "$WORK/state/heal.log" 2>/dev/null)"
fi

# Cooldown: immediately after a heal, the still-dirty log window must NOT
# trigger a second reboot.
run_wd DROPLET_WATCHDOG_XVF_COOLDOWN_S=3600 >/dev/null || true
[ "$(grep -c 'REBOOT 1' "$WORK/xvf.log")" = "1" ] \
  && pass "cooldown suppresses a back-to-back re-heal" \
  || fail "re-heal fired inside cooldown: $(cat "$WORK/xvf.log")"

# Persistent wedge after heal (cooldown expired) → heal_failed, then escalated
# after the second consecutive failure, with a CRITICAL log line.
reset_work
mk_xvf_stub
mk_usb_dev "1-3" "20b1"
printf 'xhci overrun\nxhci overrun\nxhci overrun\n' > "$WORK/klog"
run_wd >/dev/null || true          # heal #1 → healed, heal_pending set
run_wd >/dev/null || true          # still wedged after cooldown → heal_failed (1)
[ "$(wd_field voice_dsp status)" = "heal_failed" ] \
  && pass "wedge persisting after a heal → heal_failed" \
  || fail "expected heal_failed, got $(wd_field voice_dsp status)"
out="$(run_wd || true)"            # heal_failed (2) → escalated
[ "$(wd_field voice_dsp status)" = "escalated" ] \
  && pass "second consecutive heal failure → escalated" \
  || fail "expected escalated, got $(wd_field voice_dsp status)"
echo "$out" | grep -q 'CRITICAL' \
  && pass "escalation logs a CRITICAL line" \
  || fail "no CRITICAL log on escalation: $out"
[ "$(wd_overall)" = "escalated" ] \
  && pass "overall reflects the worst check status" \
  || fail "overall expected escalated, got $(wd_overall)"

# Suspension: while escalated, heals are NOT retried every run (no retry storm).
reboots_before="$(grep -c 'REBOOT 1' "$WORK/xvf.log")"
run_wd DROPLET_WATCHDOG_ESCALATED_RETRY_EVERY=100 >/dev/null || true
run_wd DROPLET_WATCHDOG_ESCALATED_RETRY_EVERY=100 >/dev/null || true
reboots_after="$(grep -c 'REBOOT 1' "$WORK/xvf.log")"
if [ "$reboots_before" = "$reboots_after" ] \
   && [ "$(wd_field voice_dsp status)" = "escalated" ]; then
  pass "escalated check suspends heal attempts (no retry storm)"
else
  fail "heal retried while escalated ($reboots_before → $reboots_after)"
fi

# Recovery: signature clears + a retry tick → back to ok, counter reset.
: > "$WORK/klog"
run_wd DROPLET_WATCHDOG_ESCALATED_RETRY_EVERY=1 >/dev/null || true
[ "$(wd_field voice_dsp status)" = "ok" ] \
  && pass "recovery resets an escalated check to ok" \
  || fail "expected ok after recovery, got $(wd_field voice_dsp status)"
[ "$(wd_field voice_dsp consecutive_heal_failures)" = "0" ] \
  && pass "consecutive failure counter reset on recovery" \
  || fail "counter not reset: $(wd_field voice_dsp consecutive_heal_failures)"

# Wedge present but xvf_host tool missing → heal_failed (never a crash).
reset_work
mk_usb_dev "1-3" "20b1"
printf 'xhci overrun\nxhci overrun\nxhci overrun\n' > "$WORK/klog"
run_wd DROPLET_WATCHDOG_XVF_HOST="$WORK/bin/nonexistent-xvf" >/dev/null || true
[ "$(wd_field voice_dsp status)" = "heal_failed" ] \
  && pass "wedge with missing xvf_host tool → heal_failed" \
  || fail "expected heal_failed with missing tool, got $(wd_field voice_dsp status)"

# WARP-1408: the shipped reSpeaker XVF3800 enumerates under Seeed VID 2886, not
# the raw XMOS 20b1. The presence gate must recognize it — otherwise voice_dsp is
# not_applicable forever on real hardware and never heals.
reset_work
mk_xvf_stub
mk_usb_dev "1-3" "2886"
printf 'xhci overrun\nxhci overrun\nxhci overrun\n' > "$WORK/klog"
run_wd >/dev/null || true
[ "$(wd_field voice_dsp status)" = "healed" ] \
  && pass "Seeed 2886 XVF3800 recognized → wedge healed (not not_applicable)" \
  || fail "expected healed for Seeed 2886, got $(wd_field voice_dsp status)"
grep -q 'REBOOT 1' "$WORK/xvf.log" 2>/dev/null \
  && pass "Seeed 2886 wedge issued 'xvf_host REBOOT 1'" \
  || fail "no REBOOT for Seeed 2886: $(cat "$WORK/xvf.log" 2>/dev/null)"

# A non-XVF USB vendor must NOT be mistaken for voice hardware (no false reboot).
# xvf.log accumulates across the suite, so assert on the REBOOT-count delta (the
# cooldown/suspension idiom above), not the file's absence.
reset_work
mk_xvf_stub
mk_usb_dev "1-3" "1234"
printf 'xhci overrun\nxhci overrun\nxhci overrun\n' > "$WORK/klog"
rb=0; [ -f "$WORK/xvf.log" ] && rb="$(grep -c 'REBOOT 1' "$WORK/xvf.log" || true)"
run_wd DROPLET_WATCHDOG_CHECKS="voice_dsp" >/dev/null || true
[ "$(wd_field voice_dsp status)" = "not_applicable" ] \
  && pass "unrelated USB vendor stays not_applicable" \
  || fail "expected not_applicable for vendor 1234, got $(wd_field voice_dsp status)"
ra=0; [ -f "$WORK/xvf.log" ] && ra="$(grep -c 'REBOOT 1' "$WORK/xvf.log" || true)"
[ "$rb" = "$ra" ] \
  && pass "no DSP reboot issued for a non-XVF device" \
  || fail "xvf_host wrongly invoked for vendor 1234 ($rb → $ra)"

# =============================================================================
# Phase 4: docker_dns — probe ok, probe fail, pin guidance, escalation
# =============================================================================
echo "--- Phase 4: docker_dns ---"

reset_work
mk_docker_stub
printf 'droplet-orchestrator-1\n' > "$WORK/docker/running"
printf 'droplet-orchestrator-1\n' > "$WORK/docker/all"
echo 0 > "$WORK/docker/dns_exit"
run_wd >/dev/null || true
[ "$(wd_field docker_dns status)" = "ok" ] \
  && pass "container DNS probe success → ok" \
  || fail "expected ok, got $(wd_field docker_dns status): $(wd_field docker_dns message)"
grep -q 'exec' "$WORK/docker.log" \
  && pass "probe ran via docker exec in an already-running container" \
  || fail "no docker exec probe recorded"

# Probe failure, no DNS pin in daemon.json → heal_failed with pin guidance.
echo 2 > "$WORK/docker/dns_exit"
printf '{}\n' > "$WORK/daemon.json"
run_wd >/dev/null || true
[ "$(wd_field docker_dns status)" = "heal_failed" ] \
  && pass "container DNS probe failure → heal_failed (detect-and-report, no auto-heal)" \
  || fail "expected heal_failed, got $(wd_field docker_dns status)"
wd_field docker_dns message | grep -q '1.1.1.1' \
  && pass "failure message documents the daemon.json DNS pin fix" \
  || fail "no pin guidance in message: $(wd_field docker_dns message)"

# Second consecutive failure → escalated.
out="$(run_wd || true)"
[ "$(wd_field docker_dns status)" = "escalated" ] \
  && pass "second consecutive DNS failure → escalated" \
  || fail "expected escalated, got $(wd_field docker_dns status)"
echo "$out" | grep -q 'CRITICAL' \
  && pass "DNS escalation logs CRITICAL" \
  || fail "no CRITICAL line on DNS escalation"

# Pin already present → message says pin exists but resolution still fails.
reset_work
mk_docker_stub
printf 'droplet-orchestrator-1\n' > "$WORK/docker/running"
echo 2 > "$WORK/docker/dns_exit"
printf '{ "dns": ["1.1.1.1", "8.8.8.8"] }\n' > "$WORK/daemon.json"
run_wd >/dev/null || true
wd_field docker_dns message | grep -qi 'pin.*present\|already' \
  && pass "message distinguishes pin-already-present" \
  || fail "pin-present not reflected: $(wd_field docker_dns message)"

# A transient docker-exec failure (container mid-restart / renamed / killed) is
# NOT a DNS NOTFOUND — only getent's own rc=2 (nslookup rc=1) proves DNS broken.
# Such codes (125 "No such container", 137 killed, generic 1) must report
# not_applicable and re-probe next run, never a false DNS heal_failed that would
# escalate to a spurious CRITICAL + misdirect the operator to the daemon.json pin.
for exec_rc in 1 125 137; do
  reset_work
  mk_docker_stub
  printf 'droplet-orchestrator-1\n' > "$WORK/docker/running"
  echo "$exec_rc" > "$WORK/docker/dns_exit"
  printf '{}\n' > "$WORK/daemon.json"
  run_wd >/dev/null || true
  [ "$(wd_field docker_dns status)" = "not_applicable" ] \
    && pass "transient docker exec rc=$exec_rc → not_applicable (not a false DNS heal_failed)" \
    || fail "exec rc=$exec_rc expected not_applicable, got $(wd_field docker_dns status): $(wd_field docker_dns message)"
done
# Two consecutive transient exec failures must NEVER escalate (no CRITICAL).
reset_work
mk_docker_stub
printf 'droplet-orchestrator-1\n' > "$WORK/docker/running"
echo 125 > "$WORK/docker/dns_exit"
printf '{}\n' > "$WORK/daemon.json"
run_wd >/dev/null || true
out="$(run_wd || true)"
echo "$out" | grep -q 'CRITICAL' \
  && fail "transient docker exec failures should never emit a CRITICAL escalation" \
  || pass "repeated transient docker exec failures never escalate (no spurious CRITICAL)"

# =============================================================================
# Phase 5: container_crashloop — baseline, detection, diagnostics, recovery
# =============================================================================
echo "--- Phase 5: container_crashloop ---"

reset_work
mk_docker_stub
printf 'droplet-mosquitto-1\ndroplet-routing-1\n' > "$WORK/docker/running"
printf 'droplet-mosquitto-1\ndroplet-routing-1\n' > "$WORK/docker/all"
printf 'droplet-mosquitto-1 47\ndroplet-routing-1 2\n' > "$WORK/docker/restarts"
echo 0 > "$WORK/docker/dns_exit"
printf 'mosquitto boot loop trace\n' > "$WORK/docker/logs"

# First sight of a container = baseline, even with a big historic RestartCount.
run_wd >/dev/null || true
[ "$(wd_field container_crashloop status)" = "ok" ] \
  && pass "first run baselines RestartCount (no false flag on historic count)" \
  || fail "expected ok on baseline run, got $(wd_field container_crashloop status)"

# +5 restarts in one window (> default threshold 3) → flagged + logs captured.
printf 'droplet-mosquitto-1 52\ndroplet-routing-1 2\n' > "$WORK/docker/restarts"
run_wd >/dev/null || true
[ "$(wd_field container_crashloop status)" = "heal_failed" ] \
  && pass "restart delta above threshold → heal_failed (crash-loop flagged)" \
  || fail "expected heal_failed, got $(wd_field container_crashloop status)"
wd_field container_crashloop message | grep -q 'droplet-mosquitto-1' \
  && pass "offending container named in the message" \
  || fail "offender not named: $(wd_field container_crashloop message)"
diag_count="$(find "$WORK/state/diagnostics" -name 'droplet-mosquitto-1-*.log' 2>/dev/null | wc -l)"
if [ "$diag_count" = "1" ] \
   && grep -q 'mosquitto boot loop trace' "$WORK/state/diagnostics/droplet-mosquitto-1-"*.log; then
  pass "docker logs tail captured to a diagnostics file on first detection"
else
  fail "diagnostics capture missing/wrong (count=$diag_count)"
fi

# Same loop continuing: flagged already → no duplicate capture on the next run.
printf 'droplet-mosquitto-1 57\ndroplet-routing-1 2\n' > "$WORK/docker/restarts"
run_wd >/dev/null || true
diag_count="$(find "$WORK/state/diagnostics" -name 'droplet-mosquitto-1-*.log' 2>/dev/null | wc -l)"
[ "$diag_count" = "1" ] \
  && pass "no duplicate diagnostics capture while the same episode continues" \
  || fail "diagnostics recaptured (count=$diag_count)"

# Loop stops → back to ok and the episode flag clears. The check escalated on
# the previous run (2 consecutive detections), so it is suspended until its
# retry tick — force the retry cadence to 1 to exercise the recovery path.
run_wd DROPLET_WATCHDOG_ESCALATED_RETRY_EVERY=1 >/dev/null || true
[ "$(wd_field container_crashloop status)" = "ok" ] \
  && pass "stable restart count → ok again (on the escalated retry tick)" \
  || fail "expected ok after loop stops, got $(wd_field container_crashloop status)"

# Stale-baseline recovery: a container escalates, KEEPS looping through the
# suspension window, then STOPS. The per-window baseline must be refreshed on
# suspended ticks (the check body is skipped there) so the retry tick measures
# delta=0 against the last-seen count — not the count frozen at escalation time,
# which would falsely re-flag a loop that already ended.
reset_work
mk_docker_stub
printf 'droplet-mosquitto-1\n' > "$WORK/docker/running"
printf 'droplet-mosquitto-1\n' > "$WORK/docker/all"
echo 0 > "$WORK/docker/dns_exit"
printf 'boot loop trace\n' > "$WORK/docker/logs"
printf 'droplet-mosquitto-1 20\n' > "$WORK/docker/restarts"; run_wd >/dev/null || true   # baseline 20
printf 'droplet-mosquitto-1 25\n' > "$WORK/docker/restarts"; run_wd >/dev/null || true   # +5 → heal_failed
printf 'droplet-mosquitto-1 30\n' > "$WORK/docker/restarts"; run_wd >/dev/null || true   # +5 → escalated (fails=2)
[ "$(wd_field container_crashloop status)" = "escalated" ] \
  && pass "sustained loop → escalated" \
  || fail "expected escalated, got $(wd_field container_crashloop status)"
# Loop continues to 40 during the suspension window (baseline must track it)…
printf 'droplet-mosquitto-1 35\n' > "$WORK/docker/restarts"; run_wd >/dev/null || true   # suspended tick, refresh → 35
printf 'droplet-mosquitto-1 40\n' > "$WORK/docker/restarts"; run_wd >/dev/null || true   # suspended tick, refresh → 40
# …then STOPS (stable at 40). The retry tick must NOT re-flag against a stale 30.
run_wd DROPLET_WATCHDOG_ESCALATED_RETRY_EVERY=1 >/dev/null || true
[ "$(wd_field container_crashloop status)" = "ok" ] \
  && pass "loop that ended during suspension recovers → ok (baseline refreshed on suspended ticks)" \
  || fail "stale baseline re-flagged an ended loop: got $(wd_field container_crashloop status)"

# =============================================================================
# Phase 6: wifi — via the real WARP-869 helper against a fake sysfs tree
# =============================================================================
echo "--- Phase 6: wifi (WARP-869 helper integration) ---"

reset_work
mk_docker_stub
mk_pci_dev "0000:0e:00.0" "0x028000" bound netdev
run_wd >/dev/null || true
[ "$(wd_field wifi status)" = "ok" ] \
  && pass "healthy Wi-Fi device → ok (helper silent)" \
  || fail "expected ok, got $(wd_field wifi status): $(wd_field wifi message)"

# Wedged device that never comes back → helper reports failure → heal_failed.
reset_work
mk_docker_stub
mk_pci_dev "0000:0e:00.0" "0x028000" bound
run_wd >/dev/null || true
[ "$(wd_field wifi status)" = "heal_failed" ] \
  && pass "unrecoverable wedge → heal_failed (helper 'did not come back')" \
  || fail "expected heal_failed, got $(wd_field wifi status): $(wd_field wifi message)"

# Helper output saying "revived" → healed (classification contract).
reset_work
mk_docker_stub
mk_pci_dev "0000:0e:00.0" "0x028000" bound
cat > "$WORK/bin/fake-wifi-helper" <<'EOF'
#!/bin/sh
echo "droplet-wifi-watchdog: revived 0000:0e:00.0 (wlan0)"
exit 0
EOF
chmod +x "$WORK/bin/fake-wifi-helper"
run_wd DROPLET_WATCHDOG_WIFI_HELPER="$WORK/bin/fake-wifi-helper" >/dev/null || true
[ "$(wd_field wifi status)" = "healed" ] \
  && pass "helper 'revived' output → healed" \
  || fail "expected healed, got $(wd_field wifi status)"
grep -q 'wifi' "$WORK/state/heal.log" 2>/dev/null \
  && pass "wifi heal recorded in heal.log" \
  || fail "wifi heal not in heal.log"

# The helper's "WARN: revived <addr> but <unit> not in systemd — AP interface
# not rebound" line contains "revived" but is a FAILURE (PCI function is back,
# AP is not). It must classify as heal_failed, not a false healed — failure/WARN
# patterns are matched before the bare 'revived' success signal. Single-radio,
# can fire on a shipping box when the attach unit is missing.
reset_work
mk_docker_stub
mk_pci_dev "0000:0e:00.0" "0x028000" bound
cat > "$WORK/bin/fake-wifi-helper" <<'EOF'
#!/bin/sh
echo "droplet-wifi-watchdog: WARN: revived 0000:0e:00.0 but droplet-openwrt-attach.service not in systemd — AP interface not rebound; run: systemctl daemon-reload && systemctl enable --now droplet-openwrt-attach.service"
exit 0
EOF
chmod +x "$WORK/bin/fake-wifi-helper"
run_wd DROPLET_WATCHDOG_WIFI_HELPER="$WORK/bin/fake-wifi-helper" >/dev/null || true
[ "$(wd_field wifi status)" = "heal_failed" ] \
  && pass "helper 'revived but not rebound' WARN → heal_failed (not a false healed)" \
  || fail "expected heal_failed for not-rebound WARN, got $(wd_field wifi status): $(wd_field wifi message)"

# Helper missing entirely → not_applicable (first-boot install ordering must
# not fabricate an escalation).
reset_work
mk_docker_stub
mk_pci_dev "0000:0e:00.0" "0x028000" bound netdev
run_wd DROPLET_WATCHDOG_WIFI_HELPER="$WORK/bin/nonexistent-helper" >/dev/null || true
[ "$(wd_field wifi status)" = "not_applicable" ] \
  && pass "missing helper → not_applicable (with install pointer)" \
  || fail "expected not_applicable, got $(wd_field wifi status)"

# =============================================================================
# Phase 7: JSON robustness — messages with quotes/newlines never break the file
# =============================================================================
echo "--- Phase 7: JSON robustness ---"

reset_work
mk_docker_stub
printf 'we"ird\\name\n' > "$WORK/docker/running"
printf 'we"ird\\name\n' > "$WORK/docker/all"
printf 'we"ird\\name 1\n' > "$WORK/docker/restarts"
echo 2 > "$WORK/docker/dns_exit"
run_wd >/dev/null || true
if "$PYBIN" -m json.tool "$STATUS_JSON" >/dev/null 2>&1; then
  pass "status.json stays valid JSON with quotes/backslashes in messages"
else
  fail "status.json broken by special characters: $(cat "$STATUS_JSON")"
fi

# =============================================================================
# Phase 8: host_unit_staleness (WARP-1829)
# =============================================================================
echo "--- Phase 8: host_unit_staleness ---"

# No detector installed on this box → explicitly not_applicable, with a
# pointer at how to get it. Never a silent absence.
reset_work
run_wd DROPLET_WATCHDOG_CHECKS="host_unit_staleness" \
       DROPLET_WATCHDOG_HOST_UNITS_BIN="$WORK/bin/absent" >/dev/null || true
if [ "$(wd_field host_unit_staleness status)" = "not_applicable" ]; then
  pass "host_unit_staleness: not_applicable when droplet-host-units is absent"
else
  fail "expected not_applicable, got $(wd_field host_unit_staleness status)"
fi

# Detector says everything is current.
reset_work
mk_host_units_stub
echo 0 > "$WORK/host_units_exit"
run_wd DROPLET_WATCHDOG_CHECKS="host_unit_staleness" >/dev/null || true
if [ "$(wd_field host_unit_staleness status)" = "ok" ]; then
  pass "host_unit_staleness: ok when every unit is at or ahead of its sources"
else
  fail "expected ok, got $(wd_field host_unit_staleness status)"
fi
if grep -q 'droplet-host-units check' "$WORK/host_units.log"; then
  pass "host_unit_staleness delegates to the detector in read-only check mode"
else
  fail "the check did not invoke the detector: $(cat "$WORK/host_units.log" 2>/dev/null)"
fi
if grep -q 'refresh' "$WORK/host_units.log"; then
  fail "the watchdog invoked refresh — restarting the panel feed on a 3-minute cadence"
else
  pass "the watchdog never invokes refresh (detect-and-report only)"
fi

# Detector found a stale unit → heal_failed, naming the unit and the fix.
reset_work
mk_host_units_stub
echo 1 > "$WORK/host_units_exit"
cat > "$WORK/host_units_out" <<'HOST_UNITS_FIXTURE'
  host units matched by droplet-*: 2
  STALE    droplet-device-bridge.service      started 2026-08-03T22:22:39Z  sources 2026-08-08T02:37:27Z
  ok       droplet-host-net.service           started 2026-08-09T10:00:00Z  sources 2026-08-08T00:00:00Z
HOST_UNITS_FIXTURE
run_wd DROPLET_WATCHDOG_CHECKS="host_unit_staleness" >/dev/null || true
if [ "$(wd_field host_unit_staleness status)" = "heal_failed" ]; then
  pass "host_unit_staleness: heal_failed when a unit runs code older than the tree"
else
  fail "expected heal_failed, got $(wd_field host_unit_staleness status)"
fi
hu_msg="$(wd_field host_unit_staleness message)"
case "$hu_msg" in
  *droplet-device-bridge.service*) pass "the message names the stale unit" ;;
  *) fail "message does not name the stale unit: $hu_msg" ;;
esac
case "$hu_msg" in
  *refresh*) pass "the message carries the one-line fix" ;;
  *) fail "message does not say how to fix it: $hu_msg" ;;
esac

# Two consecutive detections escalate — a CRITICAL line, not a quiet repeat.
hu_out="$(run_wd DROPLET_WATCHDOG_CHECKS="host_unit_staleness")"
if [ "$(wd_field host_unit_staleness status)" = "escalated" ] \
   && printf '%s\n' "$hu_out" | grep -q 'CRITICAL'; then
  pass "a persistently stale unit escalates to CRITICAL"
else
  fail "no escalation on the second detection: status=$(wd_field host_unit_staleness status)"
fi

# The detector itself failing is NOT evidence of staleness.
reset_work
mk_host_units_stub
echo 2 > "$WORK/host_units_exit"
run_wd DROPLET_WATCHDOG_CHECKS="host_unit_staleness" >/dev/null || true
if [ "$(wd_field host_unit_staleness status)" = "not_applicable" ]; then
  pass "a detector that cannot run reports not_applicable, not a fake verdict"
else
  fail "expected not_applicable for a broken detector, got $(wd_field host_unit_staleness status)"
fi

# =============================================================================
# Phase 8b: host_artefacts (WARP-2574)
# =============================================================================
# The blind spot behind Phase 8. host_unit_staleness enumerates units FROM
# SYSTEMD, so it can only report on artefacts that EXIST — an artefact that was
# never installed has no unit and no process, and reads as nothing at all.
# Measured 2026-08-31: droplet-power-restore (WARP-2190) and the hardware
# watchdog (WARP-2192) sat in the bench box's checkout for five days, installed
# on none of it, while Phase 8's check reported ok the entire time.
echo "--- Phase 8b: host_artefacts ---"

reset_work
run_wd DROPLET_WATCHDOG_CHECKS="host_artefacts" \
       DROPLET_WATCHDOG_HOST_UNITS_BIN="$WORK/bin/absent" >/dev/null || true
if [ "$(wd_field host_artefacts status)" = "not_applicable" ]; then
  pass "host_artefacts: not_applicable when droplet-host-units is absent"
else
  fail "expected not_applicable, got $(wd_field host_artefacts status)"
fi

# Everything the checkout declares is installed.
reset_work
mk_host_units_stub
echo 0 > "$WORK/host_units_exit"
run_wd DROPLET_WATCHDOG_CHECKS="host_artefacts" >/dev/null || true
if [ "$(wd_field host_artefacts status)" = "ok" ]; then
  pass "host_artefacts: ok when every declared artefact is installed"
else
  fail "expected ok, got $(wd_field host_artefacts status)"
fi
if grep -q 'droplet-host-units audit' "$WORK/host_units.log"; then
  pass "host_artefacts delegates to the detector's read-only audit mode"
else
  fail "the check did not invoke the auditor: $(cat "$WORK/host_units.log" 2>/dev/null)"
fi

# --- the 2026-08-31 bench box, as the auditor would report it ----------------
reset_work
mk_host_units_stub
echo 1 > "$WORK/host_units_exit"
cat > "$WORK/host_units_out" <<'AUDIT_FIXTURE'
  host artefacts declared by /home/droplet/edge-platform/scripts/host/MANIFEST: 60
  checkout: /home/droplet/edge-platform
  MISSING       /usr/local/sbin/droplet-power-restore                     declared in scripts/host/MANIFEST, absent from this box
  MISSING       /etc/systemd/system/droplet-power-restore.service         declared in scripts/host/MANIFEST, absent from this box
  MISSING       /etc/modules-load.d/droplet-watchdog-hw.conf              declared in scripts/host/MANIFEST, absent from this box
  NOT-ENABLED   droplet-power-restore.timer                               systemd has no such unit (is-enabled=not-found)
  DRIFT         /usr/local/sbin/droplet-watchdog                          installed copy differs from scripts/host/droplet-watchdog.sh
  ok            /usr/local/sbin/droplet-host-net                          matches scripts/host/usr-local-sbin/droplet-host-net
AUDIT_FIXTURE
run_wd DROPLET_WATCHDOG_CHECKS="host_artefacts" >/dev/null || true
if [ "$(wd_field host_artefacts status)" = "heal_failed" ]; then
  pass "host_artefacts: heal_failed when the box is missing what its checkout declares"
else
  fail "expected heal_failed, got $(wd_field host_artefacts status)"
fi
ha_msg="$(wd_field host_artefacts message)"
case "$ha_msg" in
  *droplet-power-restore*) pass "the message names the missing artefact" ;;
  *) fail "message does not name the missing artefact: $ha_msg" ;;
esac
case "$ha_msg" in
  *"3 missing"*) pass "the message counts the missing artefacts" ;;
  *) fail "message does not count what is missing: $ha_msg" ;;
esac
case "$ha_msg" in
  *"1 drifted"*) pass "the message counts drift separately from absence" ;;
  *) fail "message does not distinguish drift from absence: $ha_msg" ;;
esac
case "$ha_msg" in
  *"1 not enabled"*) pass "the message counts units that are not enabled" ;;
  *) fail "message does not count not-enabled units: $ha_msg" ;;
esac
case "$ha_msg" in
  *setup.sh*) pass "the message carries the one-line fix" ;;
  *) fail "message does not say how to fix it: $ha_msg" ;;
esac
# `ok` rows must never be counted as problems — a check that cries wolf on a
# healthy box is a check people learn to ignore.
case "$ha_msg" in
  *droplet-host-net*) fail "an ok row leaked into the failure message: $ha_msg" ;;
  *) pass "ok rows are not reported as problems" ;;
esac

# The fix here is a full setup.sh run — apt, unit rewrites, service restarts.
# A 3-minute timer must never start an unattended provision.
if grep -qE 'setup\.sh|refresh' "$WORK/host_units.log"; then
  fail "the watchdog tried to APPLY the fix: $(cat "$WORK/host_units.log")"
else
  pass "the watchdog never runs the installer (detect-and-report only)"
fi

# Two consecutive detections escalate — a CRITICAL line, not a quiet repeat.
ha_out="$(run_wd DROPLET_WATCHDOG_CHECKS="host_artefacts")"
if [ "$(wd_field host_artefacts status)" = "escalated" ] \
   && printf '%s\n' "$ha_out" | grep -q 'CRITICAL'; then
  pass "a box that stays un-provisioned escalates to CRITICAL"
else
  fail "no escalation on the second detection: status=$(wd_field host_artefacts status)"
fi

# --- a very broken box must not write a multi-kilobyte status.json ----------
reset_work
mk_host_units_stub
echo 1 > "$WORK/host_units_exit"
: > "$WORK/host_units_out"
for i in $(seq 1 40); do
  printf '  MISSING       /usr/local/sbin/droplet-artefact-%02d   absent\n' "$i" \
    >> "$WORK/host_units_out"
done
run_wd DROPLET_WATCHDOG_CHECKS="host_artefacts" >/dev/null || true
ha_msg="$(wd_field host_artefacts message)"
if [ "${#ha_msg}" -lt 700 ]; then
  pass "a box missing 40 artefacts still writes a readable status message (${#ha_msg} chars)"
else
  fail "the status message ballooned to ${#ha_msg} chars — status.json becomes unreadable"
fi
case "$ha_msg" in
  *"more)"*) pass "the truncated list says how many were elided" ;;
  *) fail "the message truncates without saying so: $ha_msg" ;;
esac

# 4 = "I could not look", which must never be reported as health.
reset_work
mk_host_units_stub
echo 4 > "$WORK/host_units_exit"
printf 'could not locate this box checkout\n' > "$WORK/host_units_out"
run_wd DROPLET_WATCHDOG_CHECKS="host_artefacts" >/dev/null || true
if [ "$(wd_field host_artefacts status)" = "not_applicable" ]; then
  pass "an unlocatable manifest reports not_applicable, never ok"
else
  fail "expected not_applicable for exit 4, got $(wd_field host_artefacts status)"
fi
case "$(wd_field host_artefacts message)" in
  *MANIFEST*) pass "the not_applicable message says what could not be found" ;;
  *) fail "the message does not explain why there is no verdict" ;;
esac

# An auditor that cannot run is not evidence the box is broken.
reset_work
mk_host_units_stub
echo 2 > "$WORK/host_units_exit"
run_wd DROPLET_WATCHDOG_CHECKS="host_artefacts" >/dev/null || true
if [ "$(wd_field host_artefacts status)" = "not_applicable" ]; then
  pass "an auditor that cannot run reports not_applicable, not a fake verdict"
else
  fail "expected not_applicable for a broken auditor, got $(wd_field host_artefacts status)"
fi

# =============================================================================
# Phase 9: relay_dns (WARP-2189)
# =============================================================================
echo "--- Phase 9: relay_dns ---"

RD_ONLY='DROPLET_WATCHDOG_CHECKS=relay_dns'

reset_work
run_wd "$RD_ONLY" >/dev/null || true
if [ "$(wd_field relay_dns status)" = "not_applicable" ]; then
  pass "relay_dns: not_applicable when droplet-relay-dns is absent"
else
  fail "expected not_applicable without the helper, got $(wd_field relay_dns status)"
fi

# Healthy origin: report ok and — the part that matters on a 3-minute timer —
# never invoke repair, so a healthy box never restarts its DNS plane.
reset_work
mk_relay_dns_stub
echo 0 > "$WORK/relay_check_exit"
run_wd "$RD_ONLY" >/dev/null || true
if [ "$(wd_field relay_dns status)" = "ok" ]; then
  pass "relay_dns: ok when the origin answers"
else
  fail "expected ok for a healthy origin, got $(wd_field relay_dns status)"
fi
if grep -q repair "$WORK/relay.log"; then
  fail "relay_dns invoked repair on a healthy origin"
else
  pass "relay_dns: never invokes repair when the origin is healthy"
fi

# No split-horizon FQDN / address not on this host — a shape fact, not a fault.
reset_work
mk_relay_dns_stub
echo 3 > "$WORK/relay_check_exit"
run_wd "$RD_ONLY" >/dev/null || true
if [ "$(wd_field relay_dns status)" = "not_applicable" ]; then
  pass "relay_dns: helper exit 3 → not_applicable (no FQDN to serve on this shape)"
else
  fail "expected not_applicable for helper exit 3, got $(wd_field relay_dns status)"
fi

# The heal path.
reset_work
mk_relay_dns_stub
echo 1 > "$WORK/relay_check_exit"
echo 0 > "$WORK/relay_check_exit2"
echo 0 > "$WORK/relay_repair_exit"
rd_out="$(run_wd "$RD_ONLY")"
if [ "$(wd_field relay_dns status)" = "healed" ]; then
  pass "relay_dns: broken origin is repaired → healed"
else
  fail "expected healed after a successful repair, got $(wd_field relay_dns status)"
fi
if grep -q 'repair' "$WORK/relay.log"; then
  pass "relay_dns: delegates the heal to droplet-relay-dns repair"
else
  fail "relay_dns did not invoke the helper's repair"
fi
if grep -q 'relay_dns' "$WORK/state/heal.log" 2>/dev/null; then
  pass "relay_dns: heal recorded in heal.log"
else
  fail "relay_dns heal not recorded in heal.log"
fi

# A repair that does not take must not be reported as healed.
reset_work
mk_relay_dns_stub
echo 1 > "$WORK/relay_check_exit"
echo 1 > "$WORK/relay_repair_exit"
run_wd "$RD_ONLY" >/dev/null || true
if [ "$(wd_field relay_dns status)" = "heal_failed" ]; then
  pass "relay_dns: failed repair → heal_failed"
else
  fail "expected heal_failed for a failed repair, got $(wd_field relay_dns status)"
fi
case "$(wd_field relay_dns message)" in
  *"off-site access"*) pass "relay_dns: the message says what the operator has lost" ;;
  *) fail "message does not explain the impact: $(wd_field relay_dns message)" ;;
esac

# A repair that CLAIMS success but leaves the origin dead is the dangerous
# case — the independent re-check is what catches it.
reset_work
mk_relay_dns_stub
echo 1 > "$WORK/relay_check_exit"
echo 1 > "$WORK/relay_check_exit2"
echo 0 > "$WORK/relay_repair_exit"
run_wd "$RD_ONLY" >/dev/null || true
if [ "$(wd_field relay_dns status)" = "heal_failed" ]; then
  pass "relay_dns: repair reporting success but leaving the origin dead → heal_failed"
else
  fail "a lying repair was accepted as $(wd_field relay_dns status)"
fi

# Persistent failure escalates rather than retry-storming a DNS restart.
rd_out="$(run_wd "$RD_ONLY")"
if [ "$(wd_field relay_dns status)" = "escalated" ] \
   && printf '%s\n' "$rd_out" | grep -q 'CRITICAL'; then
  pass "relay_dns: a persistently broken origin escalates to CRITICAL"
else
  fail "no escalation on the second failure: $(wd_field relay_dns status)"
fi

# An undocumented exit code is not a verdict.
reset_work
mk_relay_dns_stub
echo 2 > "$WORK/relay_check_exit"
run_wd "$RD_ONLY" >/dev/null || true
if [ "$(wd_field relay_dns status)" = "not_applicable" ]; then
  pass "relay_dns: a detector that cannot run reports not_applicable, not a fake verdict"
else
  fail "expected not_applicable for helper exit 2, got $(wd_field relay_dns status)"
fi

# Every known check must always be present in status.json.
reset_work
mk_relay_dns_stub
echo 0 > "$WORK/relay_check_exit"
run_wd DROPLET_WATCHDOG_CHECKS="wifi" >/dev/null || true
if [ "$(wd_field relay_dns status)" = "not_applicable" ]; then
  pass "relay_dns: reports not_applicable when disabled — never silently absent"
else
  fail "relay_dns missing/wrong when disabled: $(wd_field relay_dns status)"
fi

# =============================================================================
echo ""
echo "  ------------------------------------------------"
if [ "$FAILURES" -gt 0 ]; then
  echo "  $FAILURES of $TESTS tests FAILED"
  exit 1
fi
echo "  All $TESTS tests passed"
exit 0
