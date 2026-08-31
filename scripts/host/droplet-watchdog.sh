#!/usr/bin/env bash
# =============================================================================
# WARP-1002 — droplet-watchdog: unified on-box self-heal supervisor
# =============================================================================
#
# One timer-driven supervisor for the wedge states we have proven manual heals
# for (each diagnosed live on shipping boxes), replacing per-symptom one-off
# timers with a single pluggable check loop:
#
#   wifi                 Wi-Fi PCI function dies silently (driver bound, phy +
#                        netdev gone — WARP-869). Detection AND the heal (PCI
#                        remove + rescan, the ONLY network-touching heal this
#                        supervisor is allowed) are delegated to the proven
#                        helper /usr/local/sbin/droplet-wifi-watchdog; this
#                        script classifies its outcome. The helper's standalone
#                        timer is superseded by droplet-watchdog.timer so two
#                        schedulers can never race a PCI heal.
#   voice_dsp            ReSpeaker XVF3800 DSP wedge ("listening but never
#                        detecting"; xhci overrun spam in the kernel log).
#                        Heal: `xvf_host REBOOT 1` over USB. Skipped gracefully
#                        (not_applicable) when the XMOS USB device is absent.
#   docker_dns           Docker daemon DNS breaks intermittently. Cheap probe:
#                        `getent hosts` inside an ALREADY-RUNNING container (no
#                        heavy container spawns). Detect-and-report only — the
#                        durable fix (daemon.json dns pin 1.1.1.1/8.8.8.8)
#                        requires a dockerd restart that would take the whole
#                        stack down, so it is documented, never auto-applied.
#   container_crashloop  docker inspect RestartCount deltas between runs
#                        (persisted); any service restarting more than the
#                        threshold per window is flagged and its log tail is
#                        captured to a diagnostics file on first detection.
#                        Detect-and-report only (docker already restarts it).
#   host_unit_staleness  A host unit's running process is older than the
#                        sources it executes — i.e. a merged fix is sitting
#                        inert in a process that read the file days ago
#                        (WARP-1829). Delegates detection to
#                        /usr/local/sbin/droplet-host-units. Detect-and-report
#                        only: the heal (`droplet-host-units refresh`) belongs
#                        to the deploy path, not to a 3-minute timer — the
#                        device-bridge owns the panel feed and the console
#                        handback, so a supervisor able to restart it on its
#                        own cadence is the thundering herd, not the fix.
#   host_artefacts       A host artefact the checkout declares is NOT INSTALLED
#                        on this box at all — the blind spot the check above
#                        structurally cannot see, because it enumerates units
#                        from systemd and a never-installed artefact has no unit
#                        (WARP-2574). Measured 2026-08-31: droplet-power-restore
#                        (WARP-2190) and the hardware watchdog (WARP-2192) sat in
#                        the box's checkout for five days, installed on none of
#                        it, while host_unit_staleness reported ok. Delegates to
#                        `droplet-host-units audit`. Detect-and-report only, and
#                        not by preference: the fix is a full `setup.sh` run
#                        (apt, unit rewrites, service restarts) — an unattended
#                        provision is not something a 3-minute timer may start.
#   relay_dns            The ADR-025 cloudflared relay resolves the box's FQDN
#                        by dialling the box's OWN dnsmasq. dnsmasq binds only
#                        explicitly listed addresses and the shipped template
#                        lists one leg, so on a relayed box nothing answers
#                        where the tunnel dials — a healthy connector that
#                        cannot resolve the box, which from off-site is
#                        indistinguishable from a dead box (WARP-2189).
#                        Delegates detection AND heal to
#                        /usr/local/sbin/droplet-relay-dns. HEALS: the change
#                        is one generated conf block, `dnsmasq --test`ed before
#                        install, verified after, auto-rolled-back on failure.
#                        Also starts the connector container if it is stopped.
#
# Status contract (architecture-guard rule: explicit enums, never inferred
# from absence): every known check ALWAYS appears in
# $STATE_DIR/status.json with one of
#     ok | healed | heal_failed | escalated | not_applicable
# Detect-only checks report a failing condition as heal_failed with a message
# stating that no automatic heal exists and what the operator should do.
#
# Escalation: after DROPLET_WATCHDOG_ESCALATE_AFTER (default 2) consecutive
# heal failures on the same check the check goes `escalated` (CRITICAL log on
# the transition) and its heal attempts are SUSPENDED — it is re-tried only
# every DROPLET_WATCHDOG_ESCALATED_RETRY_EVERY runs (default 5 ≈ every 15 min
# at the 3-min timer cadence), so a persistent failure can never retry-storm.
# A passing re-try resets the check to ok/healed.
#
# Every heal action (attempted or successful) is logged with a UTC timestamp
# to stdout (journal) and appended to $STATE_DIR/heal.log.
#
# Scheduling: droplet-watchdog.timer (scripts/host/etc-systemd-system/),
# installed + enabled by setup.sh via scripts/lib/single-box.sh. No while-true
# loops — one pass per activation, always exits 0 (the status file and journal
# are the failure surface; a red oneshot would only add unit-state noise).
#
# Repo-tracked (architecture-guard rule 20): this file installs to
# /usr/local/sbin/droplet-watchdog via setup.sh — never hand-placed.
#
# Deployment-shape gating: DROPLET_WATCHDOG_CHECKS (space-separated) selects
# the checks for this box; everything else reports not_applicable. Checks
# also self-gate on hardware presence, so the default (all checks) is safe on
# any shape. Overridable via /etc/default/droplet-watchdog.
#
# Test hooks (tests/droplet-watchdog.test.sh — no root, hardware, or docker
# daemon needed):
#   DROPLET_WATCHDOG_STATE_DIR           state + status.json root
#   DROPLET_WATCHDOG_WIFI_HELPER         path to the WARP-869 helper
#   DROPLET_WATCHDOG_USB_SYS             fake /sys/bus/usb/devices
#   DROPLET_WATCHDOG_KLOG_FILE           file read instead of `journalctl -k`
#   DROPLET_WATCHDOG_XVF_HOST            xvf_host stub
#   DROPLET_WATCHDOG_DOCKER_DAEMON_JSON  daemon.json fixture
#   DROPLET_WATCHDOG_HOST_UNITS_BIN      droplet-host-units stub
#   (docker is resolved via PATH, so a stub earlier on PATH intercepts it)
# =============================================================================
# Deliberately NOT `set -e`: a supervisor must survive any single probe
# failing and still write status for every check. Errors are handled per call.
set -u

# --- configuration (no host-specific defaults; everything overridable) -------
WD_STATE_DIR="${DROPLET_WATCHDOG_STATE_DIR:-/var/lib/droplet/watchdog}"
WD_CHECKS_ENABLED="${DROPLET_WATCHDOG_CHECKS:-wifi voice_dsp docker_dns container_crashloop host_unit_staleness host_artefacts relay_dns}"
WD_ESCALATE_AFTER="${DROPLET_WATCHDOG_ESCALATE_AFTER:-2}"
WD_RETRY_EVERY="${DROPLET_WATCHDOG_ESCALATED_RETRY_EVERY:-5}"

WD_WIFI_HELPER="${DROPLET_WATCHDOG_WIFI_HELPER:-/usr/local/sbin/droplet-wifi-watchdog}"

WD_USB_SYS="${DROPLET_WATCHDOG_USB_SYS:-/sys/bus/usb/devices}"
# XVF3800 USB vendor id(s), space-separated allow-list. The board's XMOS DSP is
# XMOS VID 20b1, but the shipped reSpeaker XVF3800 4-Mic Array enumerates under
# Seeed's VID 2886 — match both so the presence gate recognizes real hardware
# instead of reporting not_applicable and never healing (WARP-1408).
WD_XVF_USB_VENDOR="${DROPLET_WATCHDOG_XVF_USB_VENDOR:-20b1 2886}"
WD_XVF_HOST="${DROPLET_WATCHDOG_XVF_HOST:-/usr/local/bin/xvf_host}"
WD_XVF_COOLDOWN_S="${DROPLET_WATCHDOG_XVF_COOLDOWN_S:-600}"
WD_KLOG_FILE="${DROPLET_WATCHDOG_KLOG_FILE:-}"
WD_KLOG_SINCE="${DROPLET_WATCHDOG_KLOG_SINCE:-10 minutes ago}"
WD_XHCI_PATTERN="${DROPLET_WATCHDOG_XHCI_PATTERN:-xhci.*overrun}"
WD_XHCI_THRESHOLD="${DROPLET_WATCHDOG_XHCI_THRESHOLD:-3}"

WD_DNS_PROBE="${DROPLET_WATCHDOG_DNS_PROBE:-registry-1.docker.io}"
WD_DNS_CONTAINER="${DROPLET_WATCHDOG_DNS_CONTAINER:-}"
WD_COMPOSE_PROJECT="${DROPLET_WATCHDOG_COMPOSE_PROJECT:-droplet}"
WD_DOCKER_DAEMON_JSON="${DROPLET_WATCHDOG_DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}"

WD_CRASHLOOP_THRESHOLD="${DROPLET_WATCHDOG_CRASHLOOP_THRESHOLD:-3}"
WD_LOG_TAIL="${DROPLET_WATCHDOG_LOG_TAIL:-200}"

# WARP-1829 / WARP-2574 — the standalone detector both host_unit_staleness
# (`check`) and host_artefacts (`audit`) delegate to. One binary, two questions:
# "is this running process older than its code" and "is this artefact installed
# at all". Installed by setup.sh (scripts/lib/single-box.sh); not_applicable
# when absent, so both checks are safe on any shape.
WD_HOST_UNITS_BIN="${DROPLET_WATCHDOG_HOST_UNITS_BIN:-/usr/local/sbin/droplet-host-units}"

# WARP-2189 — the relay's DNS origin. The check delegates detection AND heal to
# this helper (single owner of the managed listener block, shared with
# setup_local_dns); not_applicable when absent, so it is safe on any shape.
WD_RELAY_DNS_BIN="${DROPLET_WATCHDOG_RELAY_DNS_BIN:-/usr/local/sbin/droplet-relay-dns}"
WD_RELAY_CONTAINER="${DROPLET_WATCHDOG_RELAY_CONTAINER:-droplet-cloudflared}"

WD_ALL_CHECKS="wifi voice_dsp docker_dns container_crashloop host_unit_staleness host_artefacts relay_dns"
WD_STATUS_FILE="$WD_STATE_DIR/status.json"
WD_HEAL_LOG="$WD_STATE_DIR/heal.log"
WD_KV_DIR="$WD_STATE_DIR/state"
WD_DIAG_DIR="$WD_STATE_DIR/diagnostics"

# --- logging ------------------------------------------------------------------
wd_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
wd_log() { printf 'droplet-watchdog: %s\n' "$*"; }
wd_log_critical() { printf 'droplet-watchdog: CRITICAL: %s\n' "$*"; }
# Every heal action — attempted or successful — lands here with a timestamp.
wd_log_heal() { # <check> <action text>
  local line
  line="$(wd_now) [$1] $2"
  wd_log "heal: $line"
  printf '%s\n' "$line" >> "$WD_HEAL_LOG" 2>/dev/null || true
}

# --- tiny persisted key/value store (one file per key) ------------------------
wd_state_get() { # <key> <default>
  local f="$WD_KV_DIR/$1"
  if [ -f "$f" ]; then cat "$f"; else printf '%s' "$2"; fi
}
wd_state_set() { # <key> <value>
  printf '%s' "$2" > "$WD_KV_DIR/$1" 2>/dev/null || true
}

# --- JSON string escaping (pure bash — no jq/python dependency on the box) ----
wd_json_escape() { # <string> → escaped (no surrounding quotes)
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  # Drop any remaining control characters rather than hand-encoding them.
  printf '%s' "$s" | tr -d '\000-\037'
}

# --- per-run result accumulation ----------------------------------------------
# bash 4+ associative arrays (every Droplet host ships bash 5).
declare -A WD_RESULT_STATUS=()
declare -A WD_RESULT_MESSAGE=()
declare -A WD_RESULT_FAILS=()

wd_finalize() { # <check> <status> <message> <fails>
  WD_RESULT_STATUS[$1]="$2"
  WD_RESULT_MESSAGE[$1]="$3"
  WD_RESULT_FAILS[$1]="$4"
}

wd_status_rank() {
  case "$1" in
    escalated) echo 4 ;;
    heal_failed) echo 3 ;;
    healed) echo 2 ;;
    ok) echo 1 ;;
    *) echo 0 ;;  # not_applicable
  esac
}

wd_write_status() {
  local tmp="$WD_STATUS_FILE.tmp.$$"
  local check first=1 overall="ok" best=1 rank
  for check in $WD_ALL_CHECKS; do
    rank="$(wd_status_rank "${WD_RESULT_STATUS[$check]:-not_applicable}")"
    if [ "$rank" -gt "$best" ]; then
      best="$rank"
      overall="${WD_RESULT_STATUS[$check]}"
    fi
  done
  {
    printf '{\n'
    printf '  "schema": 1,\n'
    printf '  "generated_at": "%s",\n' "$(wd_now)"
    printf '  "overall": "%s",\n' "$overall"
    printf '  "checks": {\n'
    for check in $WD_ALL_CHECKS; do
      [ "$first" = 1 ] || printf ',\n'
      first=0
      printf '    "%s": {\n' "$check"
      printf '      "status": "%s",\n' "${WD_RESULT_STATUS[$check]:-not_applicable}"
      printf '      "message": "%s",\n' "$(wd_json_escape "${WD_RESULT_MESSAGE[$check]:-}")"
      printf '      "consecutive_heal_failures": %s\n' "${WD_RESULT_FAILS[$check]:-0}"
      printf '    }'
    done
    printf '\n  }\n}\n'
  } > "$tmp" && mv -f "$tmp" "$WD_STATUS_FILE"
  rm -f "$tmp" 2>/dev/null || true
}

# =============================================================================
# Checks. Each sets CHECK_OUTCOME (ok|healed|heal_failed|not_applicable) and
# CHECK_MESSAGE. The escalation machinery in wd_run_check maps outcomes to the
# final status enum and owns the consecutive-failure counters.
# =============================================================================
CHECK_OUTCOME=""
CHECK_MESSAGE=""

# --- wifi ----------------------------------------------------------------------
# Delegates detection + heal to the WARP-869 helper (single owner of the PCI
# remove/rescan logic, including the single-box "AP radio deliberately moved
# into the OpenWrt container netns" guard). We classify its log output — the
# strings below are the helper's stable log contract, covered by an
# integration test that runs the REAL helper against a fake sysfs tree.
wd_check_wifi() {
  local sys_pci="${DROPLET_WIFI_SYS_PCI:-/sys/bus/pci/devices}"
  if [ ! -d "$sys_pci" ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="no PCI sysfs at $sys_pci (non-Linux or namespaced host)"
    return 0
  fi
  local dev found=0
  for dev in "$sys_pci"/*; do
    [ -f "$dev/class" ] || continue
    if [ "$(cat "$dev/class" 2>/dev/null)" = "0x028000" ]; then found=1; break; fi
  done
  if [ "$found" != 1 ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="no Wi-Fi-class (0x028000) PCI device on this box"
    return 0
  fi
  if [ ! -f "$WD_WIFI_HELPER" ]; then
    # First-boot ordering: setup.sh installs this supervisor before
    # install-device-bridge.sh lands the helper — never fabricate an
    # escalation out of that window.
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="Wi-Fi wedge helper not installed at $WD_WIFI_HELPER (scripts/install-device-bridge.sh installs it)"
    return 0
  fi
  local out rc
  out="$(bash "$WD_WIFI_HELPER" 2>&1)"
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    CHECK_OUTCOME=heal_failed
    CHECK_MESSAGE="wifi helper exited $rc: $(printf '%s' "$out" | tail -n 1)"
    return 0
  fi
  # Failure/WARN patterns are matched BEFORE 'revived': the helper's
  # "WARN: revived <addr> but <unit> not in systemd — AP interface not rebound"
  # line contains the word "revived" but is a FAILURE (the PCI function came
  # back yet the AP was never rebound), so a bare 'revived' match would
  # misclassify a still-down AP as healed. This is single-radio and can fire on
  # a shipping box whenever the attach unit is missing or its restart is skipped.
  local wifi_fail_re='did not come back|could not remove|rescan write failed|not rebound|restart failed'
  if printf '%s' "$out" | grep -Eq "$wifi_fail_re"; then
    CHECK_OUTCOME=heal_failed
    CHECK_MESSAGE="$(printf '%s' "$out" | grep -E "$wifi_fail_re" | tail -n 1)"
    wd_log_heal wifi "PCI remove + rescan attempted but not fully recovered: $CHECK_MESSAGE"
    return 0
  fi
  if printf '%s' "$out" | grep -q 'revived'; then
    CHECK_OUTCOME=healed
    CHECK_MESSAGE="$(printf '%s' "$out" | grep 'revived' | tail -n 1)"
    wd_log_heal wifi "PCI remove + rescan revived the Wi-Fi function: $CHECK_MESSAGE"
    return 0
  fi
  CHECK_OUTCOME=ok
  CHECK_MESSAGE="no Wi-Fi wedge signature (helper silent)"
  return 0
}

# --- voice_dsp -------------------------------------------------------------------
wd_kernel_log() {
  if [ -n "$WD_KLOG_FILE" ]; then
    cat "$WD_KLOG_FILE" 2>/dev/null
    return 0
  fi
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -k --since "$WD_KLOG_SINCE" --no-pager 2>/dev/null && return 0
  fi
  dmesg 2>/dev/null || true
}

wd_xmos_present() {
  local d id v
  [ -d "$WD_USB_SYS" ] || return 1
  for d in "$WD_USB_SYS"/*/idVendor; do
    [ -f "$d" ] || continue
    id="$(cat "$d" 2>/dev/null)"
    # WD_XVF_USB_VENDOR is a space-separated allow-list (XMOS 20b1 + Seeed 2886);
    # the unquoted expansion below is the intentional split over that list.
    # shellcheck disable=SC2086
    for v in $WD_XVF_USB_VENDOR; do
      [ "$id" = "$v" ] && return 0
    done
  done
  return 1
}

wd_check_voice_dsp() {
  if ! wd_xmos_present; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="no XVF3800 (idVendor in: $WD_XVF_USB_VENDOR) USB device — voice hardware absent"
    return 0
  fi
  local overruns
  overruns="$(wd_kernel_log | grep -Eic "$WD_XHCI_PATTERN" || true)"
  if [ "${overruns:-0}" -lt "$WD_XHCI_THRESHOLD" ]; then
    wd_state_set voice_dsp.heal_pending 0
    CHECK_OUTCOME=ok
    CHECK_MESSAGE="xhci overrun count $overruns below threshold $WD_XHCI_THRESHOLD"
    return 0
  fi
  # Wedge signature present. The kernel-log window stays dirty for a while
  # after a successful DSP reboot, so a cooldown separates "heal issued,
  # waiting for the window to clear" from "heal did not stick".
  local now heal_pending last_heal
  now="$(date +%s)"
  heal_pending="$(wd_state_get voice_dsp.heal_pending 0)"
  last_heal="$(wd_state_get voice_dsp.last_heal_epoch 0)"
  if [ "$heal_pending" = 1 ] && [ $((now - last_heal)) -lt "$WD_XVF_COOLDOWN_S" ]; then
    CHECK_OUTCOME=ok
    CHECK_MESSAGE="wedge signature within ${WD_XVF_COOLDOWN_S}s cooldown after DSP reboot — suppressing re-heal"
    return 0
  fi
  if [ ! -x "$WD_XVF_HOST" ]; then
    CHECK_OUTCOME=heal_failed
    CHECK_MESSAGE="XVF3800 wedge detected ($overruns xhci overruns) but xvf_host not found at $WD_XVF_HOST — set DROPLET_WATCHDOG_XVF_HOST in /etc/default/droplet-watchdog"
    wd_log_heal voice_dsp "DSP reboot needed but tool missing: $CHECK_MESSAGE"
    return 0
  fi
  if [ "$heal_pending" = 1 ]; then
    # Cooldown expired and the signature never cleared: the previous reboot
    # did not stick. Re-issue once and report the failure honestly.
    if "$WD_XVF_HOST" REBOOT 1 >/dev/null 2>&1; then
      wd_state_set voice_dsp.last_heal_epoch "$now"
      wd_log_heal voice_dsp "re-issued 'xvf_host REBOOT 1' — previous DSP reboot did not clear xhci overruns"
      CHECK_OUTCOME=heal_failed
      CHECK_MESSAGE="DSP reboot did not clear xhci overruns ($overruns in window); re-issued REBOOT 1"
    else
      wd_log_heal voice_dsp "attempted 'xvf_host REBOOT 1' — command failed"
      CHECK_OUTCOME=heal_failed
      CHECK_MESSAGE="xvf_host REBOOT 1 failed (previous reboot also did not clear the wedge)"
    fi
    return 0
  fi
  if "$WD_XVF_HOST" REBOOT 1 >/dev/null 2>&1; then
    wd_state_set voice_dsp.heal_pending 1
    wd_state_set voice_dsp.last_heal_epoch "$now"
    wd_log_heal voice_dsp "issued 'xvf_host REBOOT 1' after $overruns xhci overruns in the log window"
    CHECK_OUTCOME=healed
    CHECK_MESSAGE="issued XVF3800 DSP reboot (xvf_host REBOOT 1) after $overruns xhci overruns"
  else
    wd_log_heal voice_dsp "attempted 'xvf_host REBOOT 1' — command failed"
    CHECK_OUTCOME=heal_failed
    CHECK_MESSAGE="xvf_host REBOOT 1 failed — check USB control path to the XVF3800"
  fi
  return 0
}

# --- docker_dns ------------------------------------------------------------------
wd_pick_probe_container() {
  if [ -n "$WD_DNS_CONTAINER" ]; then
    printf '%s' "$WD_DNS_CONTAINER"
    return 0
  fi
  local c
  c="$(docker ps --filter "label=com.docker.compose.project=$WD_COMPOSE_PROJECT" \
        --format '{{.Names}}' 2>/dev/null | head -n 1)"
  if [ -z "$c" ]; then
    c="$(docker ps --format '{{.Names}}' 2>/dev/null | head -n 1)"
  fi
  printf '%s' "$c"
}

wd_daemon_json_has_dns_pin() {
  [ -f "$WD_DOCKER_DAEMON_JSON" ] && grep -q '"dns"' "$WD_DOCKER_DAEMON_JSON" 2>/dev/null
}

wd_check_docker_dns() {
  if ! command -v docker >/dev/null 2>&1; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="docker CLI not present on this host"
    return 0
  fi
  if ! docker ps >/dev/null 2>&1; then
    CHECK_OUTCOME=heal_failed
    CHECK_MESSAGE="cannot probe container DNS: docker daemon unreachable — no automatic heal, inspect 'systemctl status docker'"
    return 0
  fi
  local container
  container="$(wd_pick_probe_container)"
  if [ -z "$container" ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="no running container to probe DNS from (project '$WD_COMPOSE_PROJECT' or any)"
    return 0
  fi
  # getent first (present in both musl and glibc images); nslookup fallback.
  # Exit-code contract (only the tool's OWN codes prove DNS state):
  #   getent hosts  -> 0 resolved, 2 NOTFOUND (the real DNS-broken signal),
  #                    126/127 binary missing (fall back to nslookup).
  #   nslookup      -> 0 resolved, 1 NOTFOUND, 126/127 binary missing.
  # ANY other exit (125 "No such container" on a mid-restart container, 137
  # killed, generic exec failure) is a transient DOCKER-EXEC failure, NOT DNS
  # breakage — classifying it as heal_failed would emit a spurious CRITICAL +
  # misdirect the operator with a daemon.json DNS-pin fix. Report those as
  # not_applicable so the check simply re-probes on the next run.
  local tool=getent rc=0
  docker exec "$container" getent hosts "$WD_DNS_PROBE" >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 126 ] || [ "$rc" = 127 ]; then
    tool=nslookup
    rc=0
    docker exec "$container" nslookup "$WD_DNS_PROBE" >/dev/null 2>&1 || rc=$?
    if [ "$rc" = 126 ] || [ "$rc" = 127 ]; then
      CHECK_OUTCOME=not_applicable
      CHECK_MESSAGE="no getent/nslookup inside container $container — set DROPLET_WATCHDOG_DNS_CONTAINER to a container that has one"
      return 0
    fi
  fi
  if [ "$rc" = 0 ]; then
    CHECK_OUTCOME=ok
    CHECK_MESSAGE="resolved $WD_DNS_PROBE from container $container"
    return 0
  fi
  # Only the tool's own NOTFOUND code (getent 2, nslookup 1) proves DNS is
  # actually broken. Everything else is a transient exec failure.
  local dns_notfound=2
  [ "$tool" = nslookup ] && dns_notfound=1
  if [ "$rc" != "$dns_notfound" ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="DNS probe on container $container returned a transient docker exec failure (rc=$rc, not a $tool NOTFOUND) — re-probing next run, not treating as DNS breakage"
    return 0
  fi
  # Detect-and-report only: the durable fix needs a dockerd restart, which
  # would take the entire stack down — an operator decision, not a watchdog's.
  CHECK_OUTCOME=heal_failed
  if wd_daemon_json_has_dns_pin; then
    CHECK_MESSAGE="container DNS probe failed ($WD_DNS_PROBE via $container) and a dns pin is already present in $WD_DOCKER_DAEMON_JSON — resolution still failing, check upstream DNS reachability (1.1.1.1/8.8.8.8)"
  else
    CHECK_MESSAGE="container DNS probe failed ($WD_DNS_PROBE via $container). Durable fix: pin \"dns\": [\"1.1.1.1\", \"8.8.8.8\"] in $WD_DOCKER_DAEMON_JSON and restart dockerd — NOT auto-applied (daemon restart takes the stack down)"
  fi
  return 0
}

# container_crashloop keeps an out-of-band per-window baseline (the last
# RestartCount seen for each container). Its "window" is "since the previous
# watchdog run", so the baseline is only correct if it is refreshed EVERY run.
# On a suspended (escalated) tick wd_check_container_crashloop is not called, so
# without this the baseline freezes at escalation time and the retry tick would
# measure a delta against a stale value — re-flagging a loop that already ended.
# This helper re-baselines the counts (no flagging, no diagnostics) so suspended
# ticks keep the window honest. Called from wd_run_check on the suspended path.
wd_refresh_container_crashloop_baseline() {
  command -v docker >/dev/null 2>&1 || return 0
  local containers
  containers="$(docker ps -a --filter "label=com.docker.compose.project=$WD_COMPOSE_PROJECT" \
        --format '{{.Names}}' 2>/dev/null)" || return 0
  [ -n "$containers" ] || containers="$(docker ps -a --format '{{.Names}}' 2>/dev/null)"
  [ -n "$containers" ] || return 0
  local counts_file="$WD_KV_DIR/docker-restart-counts"
  local new_counts="" c count
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    count="$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null)" || continue
    case "$count" in (*[!0-9]*|'') continue ;; esac
    new_counts="${new_counts}${c} ${count}
"
  done <<< "$containers"
  printf '%s' "$new_counts" > "$counts_file" 2>/dev/null || true
}

# --- container_crashloop -----------------------------------------------------------
wd_check_container_crashloop() {
  if ! command -v docker >/dev/null 2>&1; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="docker CLI not present on this host"
    return 0
  fi
  local containers
  if ! containers="$(docker ps -a --filter "label=com.docker.compose.project=$WD_COMPOSE_PROJECT" \
        --format '{{.Names}}' 2>/dev/null)"; then
    CHECK_OUTCOME=heal_failed
    CHECK_MESSAGE="cannot inspect containers: docker daemon unreachable — no automatic heal, inspect 'systemctl status docker'"
    return 0
  fi
  if [ -z "$containers" ]; then
    containers="$(docker ps -a --format '{{.Names}}' 2>/dev/null)"
  fi
  if [ -z "$containers" ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="no containers on this host"
    return 0
  fi

  local counts_file="$WD_KV_DIR/docker-restart-counts"
  local flagged_file="$WD_KV_DIR/docker-crashloop-flagged"
  local new_counts="" offenders="" still_flagged=""
  local c count prev delta
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    count="$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null)" || continue
    case "$count" in (*[!0-9]*|'') continue ;; esac
    # First sight of a container = baseline; a historic RestartCount must not
    # trigger a false flag (the window is "since the previous watchdog run").
    prev="$( { grep -F -- "$c " "$counts_file" 2>/dev/null || true; } | awk -v n="$c" '$1 == n { print $2; exit }')"
    [ -n "$prev" ] || prev="$count"
    delta=$((count - prev))
    new_counts="${new_counts}${c} ${count}
"
    if [ "$delta" -gt "$WD_CRASHLOOP_THRESHOLD" ]; then
      offenders="${offenders}${c}(+${delta}) "
      if ! grep -Fxq -- "$c" "$flagged_file" 2>/dev/null; then
        # First detection of this episode → capture the log tail once.
        local diag
        diag="$WD_DIAG_DIR/${c}-$(date -u +%Y%m%dT%H%M%SZ).log"
        docker logs --tail "$WD_LOG_TAIL" "$c" > "$diag" 2>&1 || true
        wd_log "crash-loop: captured last $WD_LOG_TAIL log lines of $c to $diag"
      fi
      still_flagged="${still_flagged}${c}
"
    fi
  done <<< "$containers"

  printf '%s' "$new_counts" > "$counts_file" 2>/dev/null || true
  printf '%s' "$still_flagged" > "$flagged_file" 2>/dev/null || true

  if [ -n "$offenders" ]; then
    CHECK_OUTCOME=heal_failed
    CHECK_MESSAGE="crash-looping containers: ${offenders% }(restart-count delta > $WD_CRASHLOOP_THRESHOLD per window) — no automatic heal (docker restart policy already retries); diagnostics in $WD_DIAG_DIR"
  else
    CHECK_OUTCOME=ok
    CHECK_MESSAGE="no container crash-loops"
  fi
  return 0
}

# --- host_unit_staleness -----------------------------------------------------
# WARP-1829. Host units execute their source out of the git working tree
# (droplet-device-bridge.service runs
# `/usr/bin/python3 <repo>/services/oled-display/device-bridge.py`), and the
# box's refresh restarts CONTAINERS only. Python reads source once at process
# start, so a merged fix can sit inert in a running process indefinitely while
# the repo, the file on disk and `systemctl status` all look correct. Measured
# live on 2026-08-09: the bridge had run 5d20h on a file 4 days newer than the
# process. Nothing reported it, and diagnosing it cost hours.
#
# DETECT-AND-REPORT ONLY, deliberately. The heal (restart the unit) exists and
# is proven — `droplet-host-units refresh` — but it belongs to the deploy
# path, not to a 3-minute timer: droplet-device-bridge owns the rack panel's
# data feed and the console-handback path (WARP-1639), and a supervisor that
# can restart it on its own cadence is precisely the thundering herd the
# design forbids. So the watchdog names the problem and the one-line fix; a
# human or the refresh flow applies it.
wd_check_host_unit_staleness() {
  if [ ! -x "$WD_HOST_UNITS_BIN" ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="droplet-host-units not installed at $WD_HOST_UNITS_BIN (re-run ./scripts/setup.sh)"
    return 0
  fi
  local out rc=0
  out="$("$WD_HOST_UNITS_BIN" check 2>&1)" || rc=$?
  if [ "$rc" = 0 ]; then
    CHECK_OUTCOME=ok
    CHECK_MESSAGE="every running host unit is at or ahead of its own sources"
    return 0
  fi
  if [ "$rc" != 1 ]; then
    # The detector itself failed (missing systemctl, unreadable state). That
    # is not evidence of staleness — say so instead of inventing a verdict.
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="droplet-host-units check could not run (exit $rc) — inspect '$WD_HOST_UNITS_BIN check'"
    return 0
  fi
  local units
  units="$(printf '%s\n' "$out" | awk '$1 == "STALE" || $1 == "FAILED" { print $2 }' | tr '\n' ' ')"
  CHECK_OUTCOME=heal_failed
  CHECK_MESSAGE="host units running code older than the tree: ${units:-<see detail>}— the process started before its own sources were last modified, so a merged fix is inert in it. Fix: sudo $WD_HOST_UNITS_BIN refresh (detail: $WD_HOST_UNITS_BIN check)"
  return 0
}

# --- host_artefacts ----------------------------------------------------------
# WARP-2574, and the reason host_unit_staleness above was not enough.
#
# That check enumerates units FROM SYSTEMD, so it can only report on artefacts
# that exist. A host artefact that was NEVER INSTALLED has no unit to enumerate
# and no process to compare — it is invisible to it, to `systemctl status`, and
# to /api/health (which reports containers only).
#
# Measured 2026-08-31 on the bench box: WARP-2190 (droplet-power-restore) and
# WARP-2192 (the hardware watchdog) merged 2026-08-26, the box's checkout
# contained both, and neither was installed. Both units read `not-found`,
# /dev/watchdog0 did not exist, and the AC-loss policy was still `always-off` —
# the box would have stayed dark after a power cut, five days after the fix
# shipped. host_unit_staleness reported ok throughout, correctly and uselessly.
#
# The cause is structural: the box refresh updates the checkout and restarts
# CONTAINERS, and nothing re-runs install_single_box_host_integration. So any
# host-unit feature can merge, be marked Done, and run on zero boxes. This check
# is what makes the box say so on its own.
#
# DETECT-AND-REPORT ONLY, and here that is not a judgement call: the "heal" is
# `sudo ./scripts/setup.sh`, which apt-installs packages, rewrites unit files,
# restarts host units and re-enables services. Running that from a 3-minute
# timer is not a self-heal, it is an unattended provision on a live appliance.
# The watchdog names the artefacts and the one-line fix; a human or the deploy
# path applies it.
#
# No deployment shape can be red here for merely being that shape:
# install_single_box_host_integration is the ONLY installer of
# /usr/local/sbin/droplet-watchdog, so this supervisor exists only on boxes
# that ran the very installer the manifest describes. A shape that skips the
# host integration skips the watchdog with it. Files the box legitimately
# rewrites at runtime (the install-once /etc/default tuning files,
# lan-dhcp.conf) are policy=presence in the manifest for the same reason — a
# check that cries wolf on a healthy box is a check people learn to ignore.
wd_check_host_artefacts() {
  if [ ! -x "$WD_HOST_UNITS_BIN" ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="droplet-host-units not installed at $WD_HOST_UNITS_BIN (re-run ./scripts/setup.sh)"
    return 0
  fi

  local out rc=0
  out="$("$WD_HOST_UNITS_BIN" audit 2>&1)" || rc=$?

  if [ "$rc" = 0 ]; then
    CHECK_OUTCOME=ok
    CHECK_MESSAGE="every host artefact the checkout declares is installed, current and enabled"
    return 0
  fi
  # 4 = the manifest could not be located, so there is no verdict. Saying
  # not_applicable here is the honest answer; inventing "ok" would recreate the
  # exact silence this check exists to end.
  if [ "$rc" = 4 ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="droplet-host-units could not locate the checkout's scripts/host/MANIFEST — no verdict; inspect '$WD_HOST_UNITS_BIN audit'"
    return 0
  fi
  if [ "$rc" != 1 ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="droplet-host-units audit could not run (exit $rc) — inspect '$WD_HOST_UNITS_BIN audit'"
    return 0
  fi

  # Column 1 of the audit's human report is a single whitespace-free label and
  # column 2 is the destination — a contract pinned by
  # tests/host-artefacts.test.sh, so this awk cannot silently read the wrong
  # field if the report is reformatted.
  local n_missing n_drift n_disabled n_unverif names extra parts
  n_missing="$(printf '%s\n' "$out" | awk '$1 == "MISSING" { n++ } END { print n + 0 }')"
  n_drift="$(printf '%s\n' "$out" | awk '$1 == "DRIFT" { n++ } END { print n + 0 }')"
  n_disabled="$(printf '%s\n' "$out" | awk '$1 == "NOT-ENABLED" { n++ } END { print n + 0 }')"
  n_unverif="$(printf '%s\n' "$out" | awk '$1 == "UNVERIFIABLE" { n++ } END { print n + 0 }')"

  parts=""
  [ "$n_missing" -gt 0 ]  && parts="$parts, $n_missing missing"
  [ "$n_drift" -gt 0 ]    && parts="$parts, $n_drift drifted"
  [ "$n_disabled" -gt 0 ] && parts="$parts, $n_disabled not enabled"
  [ "$n_unverif" -gt 0 ]  && parts="$parts, $n_unverif unverifiable"
  parts="${parts#, }"

  # Name the first few rather than all of them: this string goes into
  # status.json, and a box missing the whole integration would otherwise write a
  # multi-kilobyte value that nothing can read. The full list is one command away.
  names="$(printf '%s\n' "$out" \
    | awk '$1 == "MISSING" || $1 == "DRIFT" || $1 == "NOT-ENABLED" || $1 == "UNVERIFIABLE" { print $2 }' \
    | head -6 | tr '\n' ' ')"
  extra=$(( n_missing + n_drift + n_disabled + n_unverif - 6 ))
  if [ "$extra" -gt 0 ]; then
    names="${names}(+$extra more) "
  fi

  CHECK_OUTCOME=heal_failed
  CHECK_MESSAGE="this box is not running what its checkout declares — ${parts}: ${names}a host feature merged and was never installed here, so it is inert no matter what the repo says. Fix: sudo ./scripts/setup.sh (detail: $WD_HOST_UNITS_BIN audit)"
  return 0
}

# --- relay_dns -----------------------------------------------------------------
# WARP-2189. Off-site access rides the ADR-025 cloudflared relay, and every
# off-site lookup is a DNS query the connector dials at the box's own dnsmasq
# (DROPLET_PUBLIC_FQDN_IP:53, via the Cloudflare Local Domain Fallback). The
# host dnsmasq binds only explicitly listed addresses, and the shipped template
# lists one — the .20.1 LAN leg — so on a relayed box nothing answers where the
# tunnel dials and cloudflared loops "connection refused".
#
# This is the failure mode that reads as "the box is down" from outside while
# the box is entirely healthy: the connector stays up, TCP still answers, but
# the FQDN goes NXDOMAIN and the name-only certificate makes connecting by IP
# unvalidatable. It was diagnosed from scratch twice (2026-08-14, 2026-08-26),
# both times after the hand-applied listener was wiped by a setup.sh re-run.
#
# UNLIKE host_unit_staleness this check DOES heal on its own, because the heal
# is narrow and reversible where that one is broad: one generated conf block,
# validated with `dnsmasq --test` BEFORE install, one unit restart, verified
# after, and rolled back automatically if the unit does not come back. The
# restart momentarily interrupts host LAN DHCP/DNS, but leases are sticky
# (dhcp-leasefile lives outside /tmp) and the alternative is an invisible total
# loss of remote support. The helper no-ops when the listener is already bound,
# so a healthy box never restarts anything.
wd_check_relay_dns() {
  if [ ! -x "$WD_RELAY_DNS_BIN" ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="droplet-relay-dns not installed at $WD_RELAY_DNS_BIN (re-run ./scripts/setup.sh)"
    return 0
  fi

  local out rc=0
  out="$("$WD_RELAY_DNS_BIN" check 2>&1)" || rc=$?

  # 3 = no split-horizon FQDN on this box, or the address is not on this host.
  # Neither is a fault, and neither is repairable from here.
  if [ "$rc" = 3 ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="${out##*: }"
    return 0
  fi
  # Anything other than the documented 0/1/3 means the detector itself failed.
  # That is not evidence the origin is broken — say so rather than healing on a
  # verdict we do not have.
  if [ "$rc" != 0 ] && [ "$rc" != 1 ]; then
    CHECK_OUTCOME=not_applicable
    CHECK_MESSAGE="droplet-relay-dns check could not run (exit $rc) — inspect '$WD_RELAY_DNS_BIN check'"
    return 0
  fi

  if [ "$rc" = 1 ]; then
    wd_log_heal relay_dns "DNS origin broken (${out##*: }) — running droplet-relay-dns repair"
    local rout rrc=0
    rout="$("$WD_RELAY_DNS_BIN" repair 2>&1)" || rrc=$?
    if [ "$rrc" != 0 ]; then
      CHECK_OUTCOME=heal_failed
      CHECK_MESSAGE="the relay's DNS origin is not answering and the repair did not take (exit $rrc): ${rout##*: } — off-site access to this box is blind until this clears; inspect '$WD_RELAY_DNS_BIN check' and 'systemctl status droplet-host-net'"
      return 0
    fi
    # Trust the repair only after an independent re-check.
    rc=0
    "$WD_RELAY_DNS_BIN" check >/dev/null 2>&1 || rc=$?
    if [ "$rc" != 0 ]; then
      CHECK_OUTCOME=heal_failed
      CHECK_MESSAGE="droplet-relay-dns repair reported success but the origin still does not answer (re-check exit $rc) — inspect '$WD_RELAY_DNS_BIN check'"
      return 0
    fi
    wd_log_heal relay_dns "DNS origin restored: ${rout##*: }"
    CHECK_OUTCOME=healed
    CHECK_MESSAGE="restored the relay's DNS origin: ${rout##*: }"
    return 0
  fi

  # DNS origin is fine. The other half of "reachable from off-site" is the
  # connector itself. Compose already gives it restart: unless-stopped, so a
  # STOPPED container means Docker gave up or someone stopped it — start it.
  # A container that was never created means this box does not run the relay.
  if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
    local state
    state="$(docker inspect -f '{{.State.Status}}' "$WD_RELAY_CONTAINER" 2>/dev/null)"
    if [ -n "$state" ] && [ "$state" != running ] && [ "$state" != restarting ]; then
      wd_log_heal relay_dns "connector $WD_RELAY_CONTAINER is $state — starting it"
      if docker start "$WD_RELAY_CONTAINER" >/dev/null 2>&1; then
        CHECK_OUTCOME=healed
        CHECK_MESSAGE="DNS origin healthy; started the stopped relay connector $WD_RELAY_CONTAINER (was $state)"
        return 0
      fi
      CHECK_OUTCOME=heal_failed
      CHECK_MESSAGE="DNS origin healthy but the relay connector $WD_RELAY_CONTAINER is $state and would not start — off-site access is down; inspect 'docker logs $WD_RELAY_CONTAINER'"
      return 0
    fi
  fi

  CHECK_OUTCOME=ok
  CHECK_MESSAGE="${out##*: }"
  return 0
}

# =============================================================================
# Escalation state machine
# =============================================================================
wd_run_check() { # <name>
  local name="$1" fails ticks
  fails="$(wd_state_get "$name.fails" 0)"

  # Suspended state: after escalation, only re-try every Nth run — a
  # persistently failing heal must never retry-storm.
  if [ "$fails" -ge "$WD_ESCALATE_AFTER" ]; then
    ticks=$(( $(wd_state_get "$name.ticks" 0) + 1 ))
    wd_state_set "$name.ticks" "$ticks"
    if [ $((ticks % WD_RETRY_EVERY)) -ne 0 ]; then
      # A check may keep a per-window baseline that only stays honest if it is
      # refreshed every run; give it a chance to do so even while suspended, so
      # the retry tick does not measure against a baseline frozen at escalation.
      if declare -F "wd_refresh_${name}_baseline" >/dev/null 2>&1; then
        "wd_refresh_${name}_baseline"
      fi
      wd_finalize "$name" escalated \
        "heal suspended after $fails consecutive failures (re-trying every $WD_RETRY_EVERY runs): $(wd_state_get "$name.last_message" '')" \
        "$fails"
      return 0
    fi
    wd_log "check $name: escalated — re-trying suspended heal (tick $ticks)"
  fi

  CHECK_OUTCOME=""
  CHECK_MESSAGE=""
  "wd_check_$name"

  case "$CHECK_OUTCOME" in
    ok|healed|not_applicable)
      if [ "$fails" -ge "$WD_ESCALATE_AFTER" ]; then
        wd_log "check $name: recovered after escalation ($CHECK_OUTCOME)"
      fi
      wd_state_set "$name.fails" 0
      wd_state_set "$name.ticks" 0
      wd_finalize "$name" "$CHECK_OUTCOME" "$CHECK_MESSAGE" 0
      ;;
    heal_failed)
      fails=$((fails + 1))
      wd_state_set "$name.fails" "$fails"
      wd_state_set "$name.last_message" "$CHECK_MESSAGE"
      if [ "$fails" -ge "$WD_ESCALATE_AFTER" ]; then
        wd_log_critical "check $name escalated after $fails consecutive heal failures: $CHECK_MESSAGE"
        wd_finalize "$name" escalated "$CHECK_MESSAGE" "$fails"
      else
        wd_log "check $name: heal_failed ($fails/$WD_ESCALATE_AFTER before escalation): $CHECK_MESSAGE"
        wd_finalize "$name" heal_failed "$CHECK_MESSAGE" "$fails"
      fi
      ;;
    *)
      # A check that returns no outcome is a bug in the check — surface it,
      # never leave the status implicit.
      wd_log "check $name: returned no outcome — treating as heal_failed (check bug)"
      fails=$((fails + 1))
      wd_state_set "$name.fails" "$fails"
      wd_finalize "$name" heal_failed "internal: check returned no outcome" "$fails"
      ;;
  esac
  return 0
}

wd_check_enabled() { # <name>
  local c
  for c in $WD_CHECKS_ENABLED; do
    [ "$c" = "$1" ] && return 0
  done
  return 1
}

wd_main() {
  mkdir -p "$WD_STATE_DIR" "$WD_KV_DIR" "$WD_DIAG_DIR" 2>/dev/null || {
    wd_log "FATAL: cannot create state dir $WD_STATE_DIR"
    exit 1
  }
  local check
  for check in $WD_ALL_CHECKS; do
    if wd_check_enabled "$check"; then
      wd_run_check "$check"
    else
      wd_finalize "$check" not_applicable \
        "disabled for this deployment shape via DROPLET_WATCHDOG_CHECKS" 0
    fi
  done
  wd_write_status
  local summary=""
  for check in $WD_ALL_CHECKS; do
    summary="${summary}${check}=${WD_RESULT_STATUS[$check]} "
  done
  wd_log "run complete: ${summary% } (status: $WD_STATUS_FILE)"
  # Always 0: the status file + journal are the failure surface. A red
  # oneshot would only add noise for states the enum already reports.
  exit 0
}

# Source-able for tests (detection/state functions unit-testable in isolation).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  wd_main "$@"
fi
