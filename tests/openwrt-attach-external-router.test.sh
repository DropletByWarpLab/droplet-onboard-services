#!/usr/bin/env bash
# =============================================================================
# WARP-3839 — droplet-openwrt-attach on a box behind an EXTERNAL edge router.
#
# docker/secrets/openwrt_password holds the external router's droplet-ai
# password there (WARP-3738); the attach unit must never set it as the bundled
# container's root password (one device's credential on another), and its
# failure lines must say the bundled container is irrelevant to the Network tab.
# Static + behavioral (sentinel blocks extracted and run); no root/docker.
# =============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ATTACH="$REPO_ROOT/scripts/host/usr-local-sbin/droplet-openwrt-attach"

TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

block() { sed -n "/^# >>> $1 (WARP-3839)\$/,/^# <<< $1 (WARP-3839)\$/p" "$ATTACH"; }
block external_router_creds > "$WORK/ext.sh"
block root_pw > "$WORK/pw.sh"
if [ -s "$WORK/ext.sh" ] && [ -s "$WORK/pw.sh" ]; then
  pass "sentinel blocks external_router_creds + root_pw present"
else
  fail "sentinel blocks missing from droplet-openwrt-attach"
  exit 1
fi

# run_pw <OPENWRT_HOST> <.env body> -> prints "<ROUTER_EXTERNAL>|<ROOT_PW>|<NOTE>"
SECRET_VALUE="EXTERNAL-ROUTER-PASSWORD"
printf '%s\n' "$SECRET_VALUE" > "$WORK/openwrt_password"
run_pw() {
  printf '%s' "$2" > "$WORK/.env"
  env -u OPENWRT_PASSWORD OPENWRT_HOST="$1" \
    REPO_ENV_FILE="$WORK/.env" OPENWRT_PASSWORD_FILE="$WORK/openwrt_password" \
    bash -c '. "$1"; . "$2" >/dev/null; printf "%s|%s|%s" "$ROUTER_EXTERNAL" "$OPENWRT_ROOT_PW" "$EXT_NOTE"' _ "$WORK/ext.sh" "$WORK/pw.sh"
}

ENVBODY=$'OPENWRT_HOST=192.168.9.1\nOPENWRT_PASSWORD=box-owned-pw\n'

out="$(run_pw 192.168.9.1 "$ENVBODY")"
case "$out" in
  "1|box-owned-pw|"*) pass "external host: container root pw comes from box-owned OPENWRT_PASSWORD" ;;
  *) fail "external host: unexpected result '$out'" ;;
esac
case "$out" in
  *"$SECRET_VALUE"*) fail "external host: the secret file value leaked into the root pw" ;;
  *) pass "external host: the secret file (router credential) is never used" ;;
esac
case "$out" in
  *"192.168.9.1"*"Network tab"*) pass "external host: failure prefix names the router and the Network tab" ;;
  *) fail "external host: failure prefix missing/incomplete: '$out'" ;;
esac

# .env fallback for the host itself (OPENWRT_HOST unset in the environment).
out="$(env -u OPENWRT_HOST -u OPENWRT_PASSWORD REPO_ENV_FILE="$WORK/.env" OPENWRT_PASSWORD_FILE="$WORK/openwrt_password" \
  bash -c '. "$1"; . "$2" >/dev/null; printf "%s|%s" "$ROUTER_EXTERNAL" "$OPENWRT_ROOT_PW"' _ "$WORK/ext.sh" "$WORK/pw.sh")"
[ "$out" = "1|box-owned-pw" ] && pass "external host read from the repo .env (whitelisted key, not sourced)" \
  || fail "external host from .env: got '$out'"

# External but no OPENWRT_PASSWORD: stays empty, still never the secret file.
out="$(run_pw 192.168.9.1 $'OPENWRT_HOST=192.168.9.1\n')"
case "$out" in
  "1||"*) pass "external host without OPENWRT_PASSWORD: root pw stays empty (no fallback to the secret file)" ;;
  *) fail "external host without OPENWRT_PASSWORD: got '$out'" ;;
esac

# Bundled container shapes keep the old behavior: secret file wins, no prefix.
for h in "" 127.0.0.1 localhost ::1; do
  out="$(run_pw "$h" $'OPENWRT_PASSWORD=box-owned-pw\n')"
  if [ "$out" = "0|$SECRET_VALUE|" ]; then
    pass "bundled shape (OPENWRT_HOST='${h}'): secret file used, no failure prefix"
  else
    fail "bundled shape (OPENWRT_HOST='${h}'): got '$out'"
  fi
done

# Every failure line of the OUTER script (before the single-quoted docker-exec
# body) that precedes an `exit 1`, or reports the failed unit, carries the note.
outer_end="$(grep -n "droplet-openwrt sh -c '" "$ATTACH" | head -1 | cut -d: -f1)"
bad=0
while IFS=: read -r n _; do
  if ! sed -n "$((n-1)),${n}p" "$ATTACH" | grep -q 'EXT_NOTE'; then
    bad=$((bad + 1)); echo "    unprefixed exit 1 at line $n"
  fi
done < <(head -n "$outer_end" "$ATTACH" | grep -n 'exit 1' | grep -v '^[0-9]*:[[:space:]]*#')
[ "$bad" -eq 0 ] && pass "every outer 'exit 1' failure line carries the external-router note" \
  || fail "$bad outer 'exit 1' failure line(s) lack the external-router note"
for pat in 'EXT_NOTE}droplet-openwrt-attach: WARN: container bring-up' 'EXT_NOTE}droplet-openwrt-attach: ERROR: rpcd restart' \
           'EXT_NOTE}droplet-openwrt-attach: ERROR: rpcd ACL copy'; do
  grep -q "$pat" "$ATTACH" && pass "unit-failing line prefixed: $pat" || fail "unit-failing line not prefixed: $pat"
done

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
[ "$FAILURES" -eq 0 ] || { echo "  RESULT: FAIL"; exit 1; }
echo "  RESULT: PASS"
