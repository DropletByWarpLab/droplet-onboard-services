#!/usr/bin/env bash
# =============================================================================
# WARP-1981 — a framebuffer rack panel must survive a factory reset.
# =============================================================================
#
# THE INVARIANT:
#   On a box with a framebuffer panel and no PyPortal, setup MUST leave
#   DISPLAY_BACKEND=fb (plus geometry) in .env. On a box without one, it must
#   leave the value alone so runtime `auto` probing is unchanged.
#
# WHY (this is a hard stop on the customer install, not a cosmetic bug):
#   display.py keeps "fb" EXPLICIT-ONLY on purpose — the promotion loop
#   re-probes USB every tick, so auto-selecting fb would lose the panel to a
#   PyPortal plugged in later. But nothing ever made the value explicit at
#   PROVISION time: no script wrote DISPLAY_BACKEND, .env.example ships
#   `auto`, and factory-reset.sh deletes .env.
#
#   The live box only had a working panel because DISPLAY_BACKEND=fb /
#   LCD_WIDTH / LCD_HEIGHT were hand-appended to .env. After a wipe it would
#   come back on `sim`, which renders to a PNG INSIDE the container. The setup
#   wizard's claim code lives on that panel and ClaimStep is not skippable, so
#   the install stops dead at step two.
#
# Static + behavioral; needs no docker, no root, no framebuffer.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/single-box.sh"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-1981: a framebuffer rack panel survives a factory reset ===\n\n'

[ -f "$LIB" ] || { printf 'FATAL: %s not found\n' "$LIB"; exit 1; }

# --- PART 1 (static) ---------------------------------------------------------

if grep -q 'WARP-1981' "$LIB"; then
  ok "single-box.sh carries the WARP-1981 panel guard"
else
  bad "single-box.sh has no WARP-1981 guard — a wipe leaves the panel on sim"
fi

# The whole point is that PROVISION writes the explicit value. If the fix ever
# migrates into display.py's auto path instead, the runtime PyPortal-promotion
# contract breaks — so assert the value is written here, in setup.
if awk '/WARP-1981/,/^  fi$/' "$LIB" | grep -q 'upsert_env DISPLAY_BACKEND fb'; then
  ok "setup writes the EXPLICIT DISPLAY_BACKEND=fb (auto is left untouched)"
else
  bad "setup does not write DISPLAY_BACKEND=fb"
fi

# --- PART 2 (behavioral): run the shipped block against fake devices ---------

run_block() {
  # $1 = existing DISPLAY_BACKEND ('' = absent)
  # $2 = "fb" to create a fake framebuffer, "" for none
  # $3 = virtual_size file contents ('' = unreadable/missing)
  # $4 = "usb" to simulate a PyPortal present
  local existing="$1" have_fb="$2" size="$3" have_usb="$4"
  local tmp; tmp="$(mktemp -d)"
  local env_target="$tmp/.env"
  : > "$env_target"
  [ -n "$existing" ] && printf 'DISPLAY_BACKEND=%s\n' "$existing" >> "$env_target"

  local fb_dev="$tmp/fb0" size_file="$tmp/virtual_size" usb_pfx="$tmp/tty"
  [ "$have_fb" = "fb" ] && : > "$fb_dev"
  [ -n "$size" ] && printf '%s\n' "$size" > "$size_file"
  [ "$have_usb" = "usb" ] && : > "${usb_pfx}ACM1"

  local block
  block="$(awk '/^  # Test\/dev hooks \(so the detection is unit-testable/,/^  fi$/' "$LIB")"

  (
    log_info() { :; }; log_warn() { :; }
    upsert_env() {
      local key="$1" val="$2" stage="${env_target}.u.$$"
      { grep -vE "^${key}=" "$env_target" 2>/dev/null || true; printf '%s=%s\n' "$key" "$val"; } > "$stage"
      mv "$stage" "$env_target"
    }
    DROPLET_FB_DEV="$fb_dev" DROPLET_FB_SIZE="$size_file" DROPLET_USB_TTY="$usb_pfx"
    export DROPLET_FB_DEV DROPLET_FB_SIZE DROPLET_USB_TTY
    eval "$block"
  ) >/dev/null 2>&1

  printf '%s|%s|%s' \
    "$(grep -E '^DISPLAY_BACKEND=' "$env_target" | tail -1 | cut -d= -f2-)" \
    "$(grep -E '^LCD_WIDTH='       "$env_target" | tail -1 | cut -d= -f2-)" \
    "$(grep -E '^LCD_HEIGHT='      "$env_target" | tail -1 | cut -d= -f2-)"
  rm -rf "$tmp"
}

# THE REGRESSION: a wiped rack-panel box (no .env at all).
got="$(run_block '' fb '1424,280' '')"
if [ "$got" = "fb|1424|280" ]; then
  ok "wiped rack-panel box provisions fb + geometry (got '$got')"
else
  bad "wiped rack-panel box did NOT get fb — claim screen would be dark (got '$got')"
fi

# .env.example ships `auto`; that must be treated as "not chosen", not as intent.
got="$(run_block 'auto' fb '1424,280' '')"
if [ "$got" = "fb|1424|280" ]; then
  ok "an explicit 'auto' is upgraded to fb when a panel exists (got '$got')"
else
  bad "'auto' blocked panel detection (got '$got')"
fi

# Geometry must track the hardware, not a baked-in 1424x280.
got="$(run_block '' fb '1920,1080' '')"
if [ "$got" = "fb|1920|1080" ]; then
  ok "geometry is read from the device, not hardcoded (got '$got')"
else
  bad "geometry did not follow the framebuffer (got '$got')"
fi

# A PyPortal box must be left alone so runtime auto-probing still wins.
got="$(run_block '' fb '1424,280' usb)"
case "$got" in
  '||') ok "PyPortal present: nothing written, auto probing preserved (got '$got')" ;;
  *)    bad "PyPortal box was forced to fb — the USB panel would be lost (got '$got')" ;;
esac

# No framebuffer at all (a dev laptop, a headless box) — must not write fb.
got="$(run_block '' '' '' '')"
case "$got" in
  '||') ok "no framebuffer: nothing written (got '$got')" ;;
  *)    bad "wrote a display backend with no panel present (got '$got')" ;;
esac

# An operator's deliberate choice must never be clobbered.
got="$(run_block 'sim' fb '1424,280' '')"
case "$got" in
  'sim|'*) ok "operator's explicit DISPLAY_BACKEND=sim preserved (got '$got')" ;;
  *)       bad "clobbered an operator's explicit choice (got '$got')" ;;
esac

# Unreadable geometry must still select fb (a panel on the wrong geometry beats
# no panel at all — the claim code is at least visible) but must NOT invent one.
got="$(run_block '' fb '' '')"
case "$got" in
  'fb||') ok "unreadable virtual_size: fb set, no invented geometry (got '$got')" ;;
  *)      bad "bad geometry handling (got '$got')" ;;
esac

# Garbage in sysfs must not become a geometry.
got="$(run_block '' fb 'not,anumber' '')"
case "$got" in
  'fb||') ok "garbage virtual_size rejected, no geometry written (got '$got')" ;;
  *)      bad "garbage virtual_size became a geometry (got '$got')" ;;
esac

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
