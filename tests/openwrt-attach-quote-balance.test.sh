#!/usr/bin/env bash
# =============================================================================
# Regression guard — droplet-openwrt-attach container-bootstrap quote balance
# =============================================================================
#
# The container bootstrap runs as one big `docker exec ... sh -c '<BODY>'`
# string. The BODY must contain ZERO apostrophes: a single stray one (a
# `'$var'` in an echo, or "phone's"/"can't" in a comment) closes the quote
# early, so everything after it — ap_firewall_zone (the AP forward+NAT rules),
# the `iw phy set netns` move into the container, the hostapd/dnsmasq setup —
# leaks into the HOST shell and runs mangled. The AP then comes up host-side
# with NO forwarding: Wi-Fi clients get a DHCP lease but no internet (and
# `unbridge_eth0`/`bootstrap_net` log "command not found").
#
# `bash -n` does NOT catch this — the quotes net-balance, so it's a SEMANTIC
# break, not a syntax error. This regression has shipped twice. This test fails
# the build the moment an apostrophe reappears inside the body.
#
# Runtime: < 1 second. No root/PCI/docker needed — pure static scan.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATTACH="${DROPLET_ATTACH_SCRIPT:-$SCRIPT_DIR/../scripts/host/usr-local-sbin/droplet-openwrt-attach}"
TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  droplet-openwrt-attach — docker-exec quote balance"
echo "  ================================================"
echo ""

[ -r "$ATTACH" ] || { echo "cannot read $ATTACH"; exit 1; }

# Opening line: the body starts at the line ending in `sh -c '`.
open=$(grep -nE "sh -c '$" "$ATTACH" | head -1 | cut -d: -f1)
# Closing line: the first lone-apostrophe line after the opener.
close=$(awk -v o="$open" 'NR>o && $0 ~ /^[[:space:]]*\x27[[:space:]]*$/ {print NR; exit}' "$ATTACH")

if [ -z "$open" ]; then
  fail "located the 'sh -c' body opener"
elif [ -z "$close" ]; then
  fail "located the body closer (lone apostrophe line after the opener)"
else
  pass "located docker-exec body (lines ${open}..${close})"
  stray=$(awk -v o="$open" -v c="$close" \
    'NR>o && NR<c && index($0, "\x27")>0 {print "      line "NR": "$0}' "$ATTACH")
  if [ -z "$stray" ]; then
    pass "no stray apostrophe inside the single-quoted body"
  else
    fail "stray apostrophe(s) inside the body — breaks the quote, AP loses forwarding:"
    printf '%s\n' "$stray"
  fi
fi

echo ""
echo "  ------------------------------------------------"
if [ "$FAILURES" -gt 0 ]; then
  echo "  $FAILURES of $TESTS tests FAILED"
  exit 1
fi
echo "  All $TESTS tests passed"
exit 0
