#!/usr/bin/env bash
# =============================================================================
# WARP-3740 — `droplet-host-units install` copies changed MANIFEST `track` files
#
# The deploy path ran `refresh` (restart stale units) but never copied the repo's
# unit files/scripts to their targets; only `setup.sh --single-box` did, so a
# host-unit fix merged to stage never reached a provisioned box. No root, no
# systemd: a tmpdir stands in for `/` (DROPLET_HOST_UNITS_ROOT_PREFIX) and a
# PATH-stubbed systemctl records calls.
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HU="$HERE/../scripts/host/droplet-host-units.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILURES=0; TESTS=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
mode()  { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

REPO="$WORK/repo"; ROOT="$WORK/root"; CALLS="$WORK/calls"
mkdir -p "$REPO/scripts/host" "$WORK/bin" \
  "$ROOT/usr/local/sbin" "$ROOT/etc/systemd/system" "$ROOT/etc/default" "$ROOT/etc/evil"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\n' "$CALLS" > "$WORK/bin/systemctl"
chmod +x "$WORK/bin/systemctl"

echo new-sbin   > "$REPO/scripts/host/tool";      echo new-unit > "$REPO/scripts/host/a.service"
echo same-unit  > "$REPO/scripts/host/same.service"
echo repo-pres  > "$REPO/scripts/host/pres";      echo repo-gen > "$REPO/scripts/host/gen"
echo evil       > "$REPO/scripts/host/evil"
cat > "$REPO/scripts/host/MANIFEST" <<'M'
file scripts/host/tool         /usr/local/sbin/tool            0755 track
file scripts/host/a.service    /etc/systemd/system/a.service   0644 track
file scripts/host/same.service /etc/systemd/system/same.service 0644 track
file scripts/host/pres         /etc/default/pres               0644 presence  per-box
file scripts/host/gen          /etc/default/gen                0644 generated per-box
skip - /etc/default/secret - generated holds PSK
M
echo old-sbin > "$ROOT/usr/local/sbin/tool"; chmod 0644 "$ROOT/usr/local/sbin/tool"
echo old-unit > "$ROOT/etc/systemd/system/a.service"
echo same-unit > "$ROOT/etc/systemd/system/same.service"; chmod 0644 "$ROOT/etc/systemd/system/same.service"
echo mine > "$ROOT/etc/default/pres"; echo psk > "$ROOT/etc/default/secret"
touch -t 200001010000 "$ROOT/etc/systemd/system/same.service"
same_before="$(mtime "$ROOT/etc/systemd/system/same.service")"

run() { env PATH="$WORK/bin:$PATH" DROPLET_HOST_UNITS_REPO_ROOT="$REPO" \
  DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" bash "$HU" install "$@" 2>&1; }

# dry-run writes nothing
run --dry-run >"$WORK/dry.out"
if grep -q old-sbin "$ROOT/usr/local/sbin/tool" && [ ! -e "$CALLS" ] && grep -q 'would install.*tool' "$WORK/dry.out"; then
  pass "--dry-run lists the change and writes nothing"; else fail "--dry-run wrote or missed a change"; fi

run >"$WORK/out"; rc=$?
[ "$rc" -eq 0 ] && pass "install exits 0" || fail "install exit $rc"
if grep -q new-sbin "$ROOT/usr/local/sbin/tool" && [ "$(mode "$ROOT/usr/local/sbin/tool")" = 755 ]; then
  pass "1. changed track file installed with MANIFEST mode (0755)"; else fail "1. tool not installed with 0755"; fi
grep -q new-unit "$ROOT/etc/systemd/system/a.service" && pass "1. changed unit installed" || fail "1. unit not installed"
[ "$(mtime "$ROOT/etc/systemd/system/same.service")" = "$same_before" ] \
  && pass "2. identical file left untouched (mtime unchanged)" || fail "2. identical file rewritten"
if grep -qx mine "$ROOT/etc/default/pres" && [ ! -e "$ROOT/etc/default/gen" ] && grep -qx psk "$ROOT/etc/default/secret"; then
  pass "3. presence/generated/skip rows never written"; else fail "3. a non-track row was written"; fi
[ "$(grep -c '^daemon-reload$' "$CALLS")" = 1 ] && pass "5. daemon-reload requested exactly once after a unit changed" \
  || fail "5. daemon-reload count: $(grep -c '^daemon-reload$' "$CALLS" 2>/dev/null)"
if ls "$ROOT/usr/local/sbin" "$ROOT/etc/systemd/system" | grep -q '\.[A-Za-z0-9]\{6\}$'; then
  fail "temp file left behind"; else pass "no temp files left behind"; fi

# second run: nothing changed -> no reload
rm -f "$CALLS"; run >/dev/null
[ ! -e "$CALLS" ] && pass "5. no daemon-reload when nothing changed" || fail "5. daemon-reload on a no-op run"

# only a non-unit file changes -> no reload
echo newer > "$REPO/scripts/host/tool"; rm -f "$CALLS"; run >/dev/null
if grep -q newer "$ROOT/usr/local/sbin/tool" && [ ! -e "$CALLS" ]; then
  pass "5. no daemon-reload when only a script changed"; else fail "5. reload for a script-only change"; fi

# 4. outside the allowed roots: refused, nothing written (also via ..)
cat >> "$REPO/scripts/host/MANIFEST" <<'M'
file scripts/host/evil /etc/evil/x 0644 track
file scripts/host/evil /etc/systemd/system/../evil/y 0644 track
file ../outside /usr/local/sbin/z 0755 track
M
echo secret > "$WORK/outside"
run >"$WORK/out"; rc=$?
if [ "$rc" -eq 1 ] && [ -z "$(ls "$ROOT/etc/evil")" ] && [ ! -e "$ROOT/usr/local/sbin/z" ] \
   && [ "$(grep -c REFUSED "$WORK/out")" -ge 3 ]; then
  pass "4. out-of-roots target, '..' target and escaping source refused; nothing written, exit 1"
else fail "4. refusal failed (rc=$rc): $(cat "$WORK/out")"; fi

echo ""
[ "$FAILURES" -eq 0 ] && { printf "  \033[32mAll %d tests passed\033[0m\n\n" "$TESTS"; exit 0; }
printf "  \033[31m%d of %d tests FAILED\033[0m\n\n" "$FAILURES" "$TESTS"; exit 1
