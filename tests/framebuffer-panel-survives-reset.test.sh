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
  # $5 = existing "LCD_WIDTH,LCD_HEIGHT" already in .env ('' = absent)
  local existing="$1" have_fb="$2" size="$3" have_usb="$4" prev_geom="${5:-}"
  local tmp; tmp="$(mktemp -d)"
  local env_target="$tmp/.env"
  : > "$env_target"
  [ -n "$existing" ] && printf 'DISPLAY_BACKEND=%s\n' "$existing" >> "$env_target"
  if [ -n "$prev_geom" ]; then
    printf 'LCD_WIDTH=%s\n'  "${prev_geom%%,*}" >> "$env_target"
    printf 'LCD_HEIGHT=%s\n' "${prev_geom##*,}" >> "$env_target"
  fi

  local fb_dev="$tmp/fb0" size_file="$tmp/virtual_size" usb_pfx="$tmp/tty"
  [ "$have_fb" = "fb" ] && : > "$fb_dev"
  [ -n "$size" ] && printf '%s\n' "$size" > "$size_file"
  [ "$have_usb" = "usb" ] && : > "${usb_pfx}ACM1"

  # Ends at the end-of-block sentinel, not the first `fi` — the backend decision
  # and the geometry re-read are two separate `if` blocks now.
  local block
  block="$(awk '/^  # Test\/dev hooks \(so the detection is unit-testable/,/^  # --- end display detection/' "$LIB")"

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

# --- PART 3 (WARP-2128): geometry tracks the ATTACHED panel, not the .env ---
#
# THE INVARIANT: DISPLAY_BACKEND is an operator choice and survives a re-run;
# the GEOMETRY is a property of the hardware plugged in right now and must be
# re-detected EVERY run. Conflating them meant that once DISPLAY_BACKEND=fb was
# in .env, the "leave the operator's choice alone" branch won and virtual_size
# was never read again.
#
# THE FIELD SEQUENCE: bench HDMI monitor at setup (1920x1080) -> swap in the
# real rack bar (1424x280) -> re-run setup.sh. The stale 1920x1080 stuck,
# display.py rendered 1920x1080 into a 1424x280 framebuffer, and fb.py cropped
# to the top-left, which reads as a broken screen rather than a wrong setting.

# THE REGRESSION: a re-run after a panel swap must pick up the new geometry.
got="$(run_block 'fb' fb '1424,280' '' '1920,1080')"
if [ "$got" = "fb|1424|280" ]; then
  ok "panel swap re-detected on re-run: 1920x1080 -> 1424x280 (got '$got')"
else
  bad "STALE GEOMETRY: bench monitor's 1920x1080 survived a swap to the 1424x280 rack bar (got '$got')"
fi

# The other shipping panel, to prove nothing is special-cased to 1424x280.
got="$(run_block 'fb' fb '1280,400' '' '1920,1080')"
if [ "$got" = "fb|1280|400" ]; then
  ok "panel swap re-detected for the 1280x400 panel too (got '$got')"
else
  bad "stale geometry survived a swap to the 1280x400 panel (got '$got')"
fi

# Re-running with the SAME panel must be a no-op, not a flip-flop.
got="$(run_block 'fb' fb '1424,280' '' '1424,280')"
if [ "$got" = "fb|1424|280" ]; then
  ok "re-run with an unchanged panel is idempotent (got '$got')"
else
  bad "idempotent re-run changed the geometry (got '$got')"
fi

# The backend is STILL an operator choice — re-detection must not resurrect fb
# on a box the operator deliberately pinned to sim, and must not write a
# geometry for it either (sim renders to a PNG at whatever size was chosen).
got="$(run_block 'sim' fb '1424,280' '' '480,320')"
if [ "$got" = "sim|480|320" ]; then
  ok "operator's sim choice keeps BOTH its backend and its geometry (got '$got')"
else
  bad "geometry re-detection leaked into a non-fb backend (got '$got')"
fi

# Unreadable virtual_size on a re-run must LEAVE the existing geometry alone.
# Blanking it here would turn a stale-but-working panel into a dark one.
got="$(run_block 'fb' fb '' '' '1424,280')"
if [ "$got" = "fb|1424|280" ]; then
  ok "unreadable virtual_size leaves the existing geometry intact (got '$got')"
else
  bad "unreadable virtual_size clobbered a working geometry (got '$got')"
fi

# Same for garbage — never overwrite a good geometry with a bad parse.
got="$(run_block 'fb' fb 'not,anumber' '' '1424,280')"
if [ "$got" = "fb|1424|280" ]; then
  ok "garbage virtual_size leaves the existing geometry intact (got '$got')"
else
  bad "garbage virtual_size clobbered a working geometry (got '$got')"
fi

# DISPLAY_BACKEND=fb but the framebuffer is GONE (panel unplugged, headless
# re-run). Must not blank the geometry the panel will need when it returns.
got="$(run_block 'fb' '' '' '' '1424,280')"
if [ "$got" = "fb|1424|280" ]; then
  ok "no framebuffer present: existing geometry preserved (got '$got')"
else
  bad "a headless re-run destroyed the panel geometry (got '$got')"
fi

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
