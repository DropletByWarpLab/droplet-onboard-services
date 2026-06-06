#!/usr/bin/env bash
# =============================================================================
# WARP-826b — unit tests for the AP bring-up HARDENING in
# scripts/host/usr-local-sbin/droplet-openwrt-attach.
#
# Live root cause on the .87 single-box (2026-06-06): the droplet-openwrt
# container was missing hostapd + iw because the attach script's one-shot
# `opkg install` ran before the container had internet (first-boot race),
# failed, and was swallowed (attach still exited 0) — a silently-dead AP. The
# later `pgrep || hostapd -B` was fire-and-forget, so even a present-but-failing
# hostapd went unnoticed. Two new functions fix both:
#   * install_ap_pkgs — wait-for-feed + retry opkg + HARD-VERIFY hostapd landed
#                       (loud ERROR + non-zero return instead of silent success)
#   * start_hostapd   — start + VERIFY running + retry, loud ERROR if it will
#                       not stay up.
#
# Both are POSIX functions delimited by sentinel markers in the attach script;
# we extract each and run it against stub opkg/hostapd/pgrep — no Docker,
# OpenWrt container, or Wi-Fi card needed. Mirrors
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
echo "  WARP-826b — droplet-openwrt-attach AP bring-up hardening"
echo "  ================================================"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

extract() { # <start-mark> <end-mark> <outfile>
  sed -n "/$(printf '%s' "$1" | sed 's/[][\\.*^$/]/\\&/g')/,/$(printf '%s' "$2" | sed 's/[][\\.*^$/]/\\&/g')/p" \
    "$ATTACH" > "$3"
}

# --- Phase 1: structure ------------------------------------------------------
echo "--- Phase 1: hardening present, fragile patterns gone ---"
if [ -f "$ATTACH" ]; then pass "attach script exists"; else fail "attach script missing"; echo "FAILURES=$FAILURES"; exit 1; fi

for m in \
  "# >>> install_ap_pkgs (WARP-826b)" "# <<< install_ap_pkgs (WARP-826b)" \
  "# >>> start_hostapd (WARP-826b)" "# <<< start_hostapd (WARP-826b)"; do
  if grep -qF "$m" "$ATTACH"; then pass "sentinel present: $m"; else fail "sentinel missing: $m"; fi
done

if grep -qE "^[[:space:]]*install_ap_pkgs \|\| true" "$ATTACH"; then pass "install_ap_pkgs is invoked"; else fail "install_ap_pkgs not invoked"; fi
if grep -qE "^[[:space:]]*start_hostapd \|\| true" "$ATTACH"; then pass "start_hostapd is invoked"; else fail "start_hostapd not invoked"; fi

# The old silent fire-and-forget hostapd start must be gone.
if grep -qE 'pgrep -f "hostapd -B" >/dev/null \|\| hostapd -B' "$ATTACH"; then
  fail "old fire-and-forget 'pgrep || hostapd -B' still present"
else
  pass "old fire-and-forget hostapd start removed"
fi

# Apostrophes inside the added functions would close the outer single-quoted
# docker-exec heredoc early. Assert the extracted bodies are apostrophe-free.
extract "# >>> install_ap_pkgs (WARP-826b)" "# <<< install_ap_pkgs (WARP-826b)" "$WORK/inst.sh"
extract "# >>> start_hostapd (WARP-826b)" "# <<< start_hostapd (WARP-826b)" "$WORK/hap.sh"
if [ -s "$WORK/inst.sh" ] && [ -s "$WORK/hap.sh" ]; then
  pass "extracted both function bodies"
else
  fail "could not extract a function body"; echo "FAILURES=$FAILURES"; exit 1
fi
if grep -q "'" "$WORK/inst.sh" || grep -q "'" "$WORK/hap.sh"; then
  fail "apostrophe found in an added function (would break the single-quoted docker-exec body)"
else
  pass "added functions are apostrophe-free (safe inside the single-quoted exec body)"
fi

# --- Phase 2: install_ap_pkgs behavior ---------------------------------------
echo "--- Phase 2: install_ap_pkgs (opkg retry + hard verify) ---"

run_inst() {
  PATH="$WORK/bin:$PATH" \
  OPKG_FEED_TRIES=2 OPKG_INSTALL_TRIES=2 OPKG_RETRY_SLEEP=0 \
  bash -c "set -e; . '$WORK/inst.sh'; install_ap_pkgs && echo RC=0 || echo RC=\$?" 2>"$WORK/err"
}

# Case A: opkg works + hostapd present -> success (RC=0).
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/opkg"; chmod +x "$WORK/bin/opkg"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/hostapd"; chmod +x "$WORK/bin/hostapd"
OUT="$(run_inst || true)"
if printf '%s' "$OUT" | grep -qx 'RC=0'; then pass "opkg ok + hostapd present -> RC=0"; else fail "expected RC=0, got: $OUT"; fi

# Case B: opkg always fails AND hostapd never appears -> RC=1 + loud ERROR.
printf '#!/usr/bin/env bash\nexit 1\n' > "$WORK/bin/opkg"; chmod +x "$WORK/bin/opkg"
rm -f "$WORK/bin/hostapd"   # hostapd absent => command -v fails
OUT="$(run_inst || true)"
if printf '%s' "$OUT" | grep -qx 'RC=1' && grep -qi 'hostapd still missing' "$WORK/err"; then
  pass "opkg fails + hostapd absent -> RC=1 with loud ERROR (no silent success)"
else
  fail "expected RC=1 + ERROR, got rc:$OUT err:$(cat "$WORK/err")"
fi

# Case C: flaky feed (opkg update fails once, then succeeds), hostapd present -> RC=0.
cat > "$WORK/bin/opkg" <<EOF
#!/usr/bin/env bash
C="$WORK/upd.count"
if [ "\$1" = "update" ]; then
  n=\$(cat "\$C" 2>/dev/null || echo 0); n=\$((n + 1)); echo "\$n" > "\$C"
  [ "\$n" -ge 2 ] && exit 0 || exit 1
fi
exit 0
EOF
chmod +x "$WORK/bin/opkg"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/hostapd"; chmod +x "$WORK/bin/hostapd"
rm -f "$WORK/upd.count"
OUT="$(run_inst || true)"
if printf '%s' "$OUT" | grep -qx 'RC=0'; then pass "flaky feed (retry then ok) -> RC=0"; else fail "expected RC=0 on retry, got: $OUT"; fi

# --- Phase 3: start_hostapd behavior -----------------------------------------
echo "--- Phase 3: start_hostapd (start + verify + retry) ---"
rm -f "$WORK/bin/opkg"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/hostapd"; chmod +x "$WORK/bin/hostapd"

run_hap() { # <pgrep-exit-code>
  printf '#!/usr/bin/env bash\nexit %s\n' "$1" > "$WORK/bin/pgrep"; chmod +x "$WORK/bin/pgrep"
  PATH="$WORK/bin:$PATH" AP_IFACE=wlp14s0 HOSTAPD_START_TRIES=2 HOSTAPD_START_SLEEP=0 \
  bash -c "set -e; . '$WORK/hap.sh'; start_hostapd && echo RC=0 || echo RC=\$?" 2>"$WORK/err"
}

# Already running: pgrep finds it -> RC=0 (no-op).
OUT="$(run_hap 0 || true)"
if printf '%s' "$OUT" | grep -qx 'RC=0'; then pass "already-running -> RC=0 (no-op)"; else fail "already-running expected RC=0, got: $OUT"; fi

# Never starts: pgrep never finds it -> RC=1 + loud ERROR (the key fix vs fire-and-forget).
OUT="$(run_hap 1 || true)"
if printf '%s' "$OUT" | grep -qx 'RC=1' && grep -qi 'hostapd failed to start' "$WORK/err"; then
  pass "never-starts -> RC=1 with loud ERROR (vs old silent fire-and-forget)"
else
  fail "never-starts expected RC=1 + ERROR, got rc:$OUT err:$(cat "$WORK/err")"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
