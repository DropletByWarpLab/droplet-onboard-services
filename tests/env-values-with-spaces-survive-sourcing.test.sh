#!/usr/bin/env bash
# =============================================================================
# WARP-1987 — a .env value containing whitespace must survive being sourced.
# =============================================================================
#
# THE INVARIANT:
#   Whatever upsert_env() writes into .env must read back IDENTICALLY when the
#   file is `.`-sourced by a shell, and sourcing must exit 0.
#
# WHY (this is a hard stop on the customer install, not a cosmetic bug):
#   .env is sourced as a shell script in four places — setup.sh:605,
#   verify.sh:33, lib/compose.sh:659, lib/secrets.sh:1103. bash parses a bare
#
#       KEY=a b c
#
#   as "assign KEY=a for the duration of the command `b`". So the variable
#   reads back EMPTY, and the shell exits 127 trying to run `b`.
#
#   The 127 is the damaging part, because it fails the ENCLOSING step. On the
#   2026-08-13 customer wipe, a space-separated DROPLET_TRUSTED_LAN_IPS aborted
#   install-device-bridge.sh before its
#
#       systemctl enable --now droplet-panel-claim.service
#
#   so the claim code was never drawn on the rack panel. ClaimStep is not
#   skippable, so the install stops dead at wizard step 2 of 5 — and the only
#   symptom was "front-panel host integration had issues (continuing)".
#
#   Note this is NOT a duplicate of WARP-1981: that fix correctly wrote
#   DISPLAY_BACKEND=fb and the geometry. The config half succeeded and the
#   ACTIVATION half was skipped, which is why every visible signal looked fine.
#
# Static + behavioral; needs no docker, no root, no framebuffer.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/single-box.sh"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-1987: .env values with whitespace survive sourcing ===\n\n'

[ -f "$LIB" ] || { printf 'FATAL: %s not found\n' "$LIB"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- PART 1 (behavioral): run the REAL upsert_env against a temp .env --------
#
# upsert_env() is nested inside configure_single_box_env(), so it cannot be
# sourced directly. Extract the function verbatim (brace-depth aware) and eval
# it — this exercises the shipped implementation, not a copy of it.

awk '
  /^  upsert_env\(\) \{/ { grab=1 }
  grab {
    print
    n = gsub(/\{/, "{"); m = gsub(/\}/, "}")
    depth += n - m
    if (depth == 0) exit
  }
' "$LIB" > "$TMP/fn.sh"

if [ ! -s "$TMP/fn.sh" ]; then
  bad "could not extract upsert_env() from single-box.sh — test cannot run"
  printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
  exit 1
fi

env_target="$TMP/.env"
: > "$env_target"
# shellcheck disable=SC1090
. "$TMP/fn.sh"

# The exact shape that broke the customer box, plus neighbours on both sides so
# a regression that eats adjacent lines is caught too.
upsert_env BEFORE_KEY               "sentinel-before"
upsert_env DROPLET_TRUSTED_LAN_IPS  "192.168.9.250 192.168.1.221 192.168.9.195"
upsert_env AFTER_KEY                "sentinel-after"

# Does sourcing it produce any diagnostic at all?
#
# NOTE: assert on STDERR, not on the exit code. `.` returns the status of the
# LAST command in the file, so a broken line in the middle is masked by any
# later successful assignment — the rc is 0 on unfixed code and the assertion
# would pass for the wrong reason. What actually fails the enclosing step is
# the 127 raised while the file is still being read, and its fingerprint is the
# stderr line.
src_err="$( bash -c ". '$env_target'" 2>&1 >/dev/null )"
if [ -z "$src_err" ]; then
  ok "sourcing .env is silent (no line is executed as a command)"
else
  bad "sourcing .env emitted diagnostics — a 127 here fails the enclosing setup step: ${src_err}"
fi

# Does the value round-trip intact?
got="$(bash -c ". '$env_target' >/dev/null 2>&1; printf '%s' \"\$DROPLET_TRUSTED_LAN_IPS\"")"
want="192.168.9.250 192.168.1.221 192.168.9.195"
if [ "$got" = "$want" ]; then
  ok "a space-separated value round-trips intact"
else
  bad "value did not round-trip — wrote [$want], sourced back [$got]"
fi

# Neighbours must be untouched.
for pair in "BEFORE_KEY:sentinel-before" "AFTER_KEY:sentinel-after"; do
  k="${pair%%:*}"; want_v="${pair##*:}"
  got_v="$(bash -c ". '$env_target' >/dev/null 2>&1; printf '%s' \"\$$k\"")"
  if [ "$got_v" = "$want_v" ]; then
    ok "$k is unaffected"
  else
    bad "$k corrupted — expected [$want_v], got [$got_v]"
  fi
done

# --- PART 2 (behavioral): values WITHOUT whitespace must not change shape ----
#
# 49 of the 50 call sites pass whitespace-free values. If the fix quoted those
# too, docker-compose's env_file consumers could see literal quotes. Assert the
# bytes are unchanged.

env_target="$TMP/.env2"
: > "$env_target"
upsert_env OPENWRT_HOST 192.168.9.1
upsert_env LLM_MODEL    docker.io/ai/gpt-oss:20B-F16

if grep -qx 'OPENWRT_HOST=192.168.9.1' "$env_target" \
&& grep -qx 'LLM_MODEL=docker.io/ai/gpt-oss:20B-F16' "$env_target"; then
  ok "whitespace-free values are written bare (no new quoting)"
else
  bad "whitespace-free values changed shape — env_file consumers may see literal quotes:
$(cat "$env_target")"
fi

# --- PART 3 (behavioral): a value must never be able to EXECUTE --------------

env_target="$TMP/.env3"
: > "$env_target"
upsert_env EVIL "a $(printf '\x60')touch $TMP/pwned$(printf '\x60') b"
bash -c ". '$env_target'" >/dev/null 2>&1 || true
if [ -e "$TMP/pwned" ]; then
  bad "a value with a command substitution EXECUTED when sourced"
else
  ok "a value cannot execute when sourced"
fi

printf '\n  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
