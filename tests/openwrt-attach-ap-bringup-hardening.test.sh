#!/usr/bin/env bash
# =============================================================================
# WARP-826b (live-test follow-up, deltas) — additional unit coverage for the AP
# bring-up hardening in scripts/host/usr-local-sbin/droplet-openwrt-attach.
#
# The base hardening (commit 99dfce8: install_ap_pkgs + start_hostapd, retry +
# verify, live-verified on the .87 box) is solid but left four behaviors the
# WARP-826 follow-up brief explicitly requires, which this file drives + locks:
#
#   D1. The opkg HARD-FAIL path must SURFACE the captured opkg error to stderr
#       (the brief: "Do NOT swallow opkg output on the failure path"), and must
#       verify BOTH critical AP binaries — hostapd AND iw.
#   D2. A hard-fail inside the single-quoted docker-exec body must PROPAGATE to
#       the OUTER script exit status so the oneshot systemd unit reports FAILED
#       instead of masking a silent no-AP (the brief: "make the attach exit
#       NON-ZERO ... the oneshot unit must report failed"). i.e. the invocations
#       must NOT be `... || true`; the body must `exit` non-zero on hard-fail and
#       the outer script must capture that rc (EXEC_RC) and exit non-zero.
#   D3. start_hostapd must verify the AP iface is actually in AP mode
#       (`iw dev "$AP_IFACE" info` -> `type AP`), not merely that a hostapd
#       process exists, and must capture hostapd stderr for the loud error.
#   D4. A lightweight durable RESPAWN must exist (the attach is a oneshot) so a
#       later hostapd crash self-heals — an in-container keepalive loop modeled
#       on the existing eth0-keepalive watchdog.
#
# These tests do NOT require Docker, a running OpenWrt container, or a Wi-Fi
# card. Logic is extracted by sentinel markers and run against PATH-stubbed
# opkg/hostapd/iw/pgrep. Mirrors tests/openwrt-attach-ap-bringup.test.sh and
# tests/openwrt-attach-iface-detect.test.sh.
#
# Runtime: < 5 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
ATTACH="$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-openwrt-attach"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-826b — AP bring-up hardening DELTAS (no-swallow + propagate + AP-mode + respawn)"
echo "  ================================================"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

extract() { # <start-mark> <end-mark> <outfile>
  sed -n "/$(printf '%s' "$1" | sed 's/[][\\.*^$/]/\\&/g')/,/$(printf '%s' "$2" | sed 's/[][\\.*^$/]/\\&/g')/p" \
    "$ATTACH" > "$3"
}

if [ -f "$ATTACH" ]; then pass "attach script exists"; else fail "attach script missing"; echo "FAILURES=$FAILURES"; exit 1; fi

# --- D2: hard-fail propagates to the outer script exit status -----------------
echo "--- D2: hard-fail propagates to the oneshot unit (no '|| true' masking) ---"

# The invocations must NOT swallow the non-zero with `|| true` — that defeats the
# whole "unit shows failed" requirement. They must instead propagate (the body
# exits non-zero on hard-fail).
if grep -qE "^[[:space:]]*install_ap_pkgs[[:space:]]*\|\|[[:space:]]*true[[:space:]]*$" "$ATTACH"; then
  fail "install_ap_pkgs is invoked with '|| true' — a hard-fail would be masked (unit reports success on no-AP)"
else
  pass "install_ap_pkgs invocation does not mask its failure with '|| true'"
fi
if grep -qE "^[[:space:]]*start_hostapd[[:space:]]*\|\|[[:space:]]*true[[:space:]]*$" "$ATTACH"; then
  fail "start_hostapd is invoked with '|| true' — a dead AP would be masked (unit reports success)"
else
  pass "start_hostapd invocation does not mask its failure with '|| true'"
fi

# The body must exit non-zero on hard-fail, and the outer script must capture the
# docker-exec rc and exit on it, so systemd sees the failure.
if grep -qE 'EXEC_RC=' "$ATTACH" && grep -qE 'exit[[:space:]]+"?\$\{?EXEC_RC' "$ATTACH"; then
  pass "outer script captures docker-exec rc (EXEC_RC) and exits non-zero on it (unit reports failed)"
else
  fail "docker-exec rc is not captured + propagated — a container hard-fail cannot surface to systemd"
fi

# --- D1: opkg hard-fail surfaces the captured error + verifies hostapd AND iw -
echo "--- D1: opkg hard-fail surfaces captured error + verifies hostapd AND iw ---"

extract "# >>> install_ap_pkgs (WARP-826b)" "# <<< install_ap_pkgs (WARP-826b)" "$WORK/inst.sh"
if [ -s "$WORK/inst.sh" ]; then pass "extracted install_ap_pkgs body"; else fail "could not extract install_ap_pkgs body"; echo "FAILURES=$FAILURES"; exit 1; fi

# Apostrophe-free (single-quoted docker-exec body).
if grep -q "'" "$WORK/inst.sh"; then
  fail "apostrophe found in install_ap_pkgs (would break the single-quoted exec body)"
else
  pass "install_ap_pkgs is apostrophe-free"
fi

# Stub opkg that ALWAYS fails update+install with a DISTINCTIVE error on stderr,
# and never provides binaries. The hard-fail must echo that captured error, not
# swallow it behind a generic line.
cat > "$WORK/bin/opkg" <<'OPKG'
#!/usr/bin/env bash
echo "opkg: SIGIL_NO_ROUTE wget returned 4 — download failed" >&2
exit 1
OPKG
chmod +x "$WORK/bin/opkg"
rm -f "$WORK/bin/hostapd" "$WORK/bin/iw"

INST_RC=0
PATH="$WORK/bin:/usr/bin:/bin" \
OPKG_FEED_TRIES=2 OPKG_INSTALL_TRIES=2 OPKG_RETRY_SLEEP=0 \
bash -c "set +e; . '$WORK/inst.sh'; install_ap_pkgs" >"$WORK/inst.out" 2>"$WORK/inst.err" || INST_RC=$?

if [ "$INST_RC" != "0" ]; then
  pass "opkg never reachable + binaries absent -> install_ap_pkgs returns non-zero (hard-fail)"
else
  fail "install_ap_pkgs returned 0 despite no binaries — silent no-AP not caught"
fi
# The CAPTURED opkg error (our distinctive sigil) must appear on stderr.
if grep -q 'SIGIL_NO_ROUTE' "$WORK/inst.err"; then
  pass "captured opkg error is surfaced to stderr (not swallowed on the failure path)"
else
  fail "opkg error was swallowed — stderr lacks the captured opkg output; got: $(cat "$WORK/inst.err")"
fi
# Verify covers iw too: install succeeds (exit 0) but provides ONLY hostapd, not
# iw -> must still hard-fail (iw is an AP prerequisite for nl80211 control).
cat > "$WORK/bin/opkg" <<OPKG2
#!/usr/bin/env bash
if [ "\$1" = "update" ]; then exit 0; fi
if [ "\$1" = "install" ]; then
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/hostapd"; chmod +x "$WORK/bin/hostapd"
  exit 0
fi
exit 0
OPKG2
chmod +x "$WORK/bin/opkg"
rm -f "$WORK/bin/hostapd" "$WORK/bin/iw"
INST_RC2=0
PATH="$WORK/bin:/usr/bin:/bin" \
OPKG_FEED_TRIES=2 OPKG_INSTALL_TRIES=2 OPKG_RETRY_SLEEP=0 \
bash -c "set +e; . '$WORK/inst.sh'; install_ap_pkgs" >"$WORK/inst.out" 2>"$WORK/inst.err" || INST_RC2=$?
if [ "$INST_RC2" != "0" ]; then
  pass "hostapd present but iw absent -> still hard-fails (iw verified as an AP prerequisite)"
else
  fail "install_ap_pkgs returned 0 with iw absent — iw is not being verified"
fi

# --- D3: start_hostapd verifies iface AP mode + captures hostapd stderr -------
echo "--- D3: start_hostapd verifies type AP (not just pgrep) + captures stderr ---"

extract "# >>> start_hostapd (WARP-826b)" "# <<< start_hostapd (WARP-826b)" "$WORK/hap.sh"
if [ -s "$WORK/hap.sh" ]; then pass "extracted start_hostapd body"; else fail "could not extract start_hostapd body"; echo "FAILURES=$FAILURES"; exit 1; fi
if grep -q "'" "$WORK/hap.sh"; then
  fail "apostrophe found in start_hostapd (would break the single-quoted exec body)"
else
  pass "start_hostapd is apostrophe-free"
fi

# Stubs: hostapd launch increments a counter and writes its up-state; pgrep +
# iw read that state. KEY case: a hostapd PROCESS exists (pgrep finds it) but the
# iface is NOT in AP mode -> the old pgrep-only check would FALSE-PASS; the
# hardened check must FAIL because `iw dev info` never shows `type AP`.
make_hap_stubs() { # <iface-ap? 0|1> <hostapd-stderr-sigil>
  local apmode="$1" sigil="$2"
  cat > "$WORK/bin/pgrep" <<PGREP
#!/usr/bin/env bash
# hostapd "process" is considered present once it has been launched at least once.
printf '%s ' "\$@" | grep -q hostapd || exit 1
[ -f "$WORK/hap.launched" ] && exit 0
exit 1
PGREP
  chmod +x "$WORK/bin/pgrep"
  cat > "$WORK/bin/iw" <<IW
#!/usr/bin/env bash
if [ "\$1" = "dev" ] && [ "\$3" = "info" ]; then
  echo "Interface \$2"
  if [ "$apmode" = "1" ] && [ -f "$WORK/hap.launched" ]; then echo "	type AP"; else echo "	type managed"; fi
  exit 0
fi
exit 0
IW
  chmod +x "$WORK/bin/iw"
  cat > "$WORK/bin/hostapd" <<HAP
#!/usr/bin/env bash
touch "$WORK/hap.launched"
echo "hostapd: $sigil" >&2
exit 0
HAP
  chmod +x "$WORK/bin/hostapd"
}

run_hap() { # uses current stubs
  rm -f "$WORK/hap.launched"
  PATH="$WORK/bin:/usr/bin:/bin" AP_IFACE=wlp14s0 \
  HOSTAPD_START_TRIES=2 HOSTAPD_START_SLEEP=0 \
  bash -c "set +e; . '$WORK/hap.sh'; start_hostapd" >"$WORK/hap.out" 2>"$WORK/hap.err"
  echo $?
}

# Case: process comes up AND iface reaches AP mode -> success.
make_hap_stubs 1 "ok"
RC_UP="$(run_hap)"
if [ "$RC_UP" = "0" ]; then
  pass "hostapd up + iface type AP -> start_hostapd returns success"
else
  fail "healthy hostapd returned rc=$RC_UP; err: $(cat "$WORK/hap.err")"
fi

# Case: process exists but iface NEVER reaches AP mode -> must FAIL (the bind-fail
# trap the pgrep-only check would miss) + surface hostapd stderr.
make_hap_stubs 0 "SIGIL_BIND_FAILED nl80211 could not configure driver"
RC_NOAP="$(run_hap)"
if [ "$RC_NOAP" != "0" ]; then
  pass "hostapd process present but iface NOT type AP -> hard-fails (verifies AP mode, not just pgrep)"
else
  fail "start_hostapd returned 0 with a non-AP iface — it is only checking pgrep, not AP mode"
fi
if grep -q 'SIGIL_BIND_FAILED' "$WORK/hap.err"; then
  pass "start_hostapd captures + surfaces hostapd stderr on failure"
else
  fail "hostapd stderr was swallowed; err lacks the captured message: $(cat "$WORK/hap.err")"
fi

# --- D4: durable respawn watchdog exists -------------------------------------
echo "--- D4: lightweight durable respawn (hostapd keepalive) present ---"

# A respawn mechanism must exist so a later crash self-heals (the attach is a
# oneshot). Accept the in-container keepalive-loop shape (modeled on the existing
# eth0-keepalive watchdog) OR a systemd .timer that re-asserts hostapd.
if grep -qiE 'hostapd-keepalive|hostapd[_-]respawn|hostapd[_-]watchdog' "$ATTACH" \
   || ls "$REPO_ROOT_REAL"/scripts/host/**/*hostapd*.timer >/dev/null 2>&1; then
  pass "a durable hostapd respawn mechanism is present (keepalive loop or timer)"
else
  fail "no durable hostapd respawn — a later crash leaves the AP down until reboot (oneshot attach)"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
