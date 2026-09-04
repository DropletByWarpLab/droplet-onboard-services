#!/usr/bin/env bash
# =============================================================================
# unit tests for the factory-reset LIVE-secrets wipe on /data (WARP-2629)
#   scripts/lib/secrets-wipe.sh  +  its call site in scripts/factory-reset.sh
#
# Defect being pinned: since the WARP-232 relocation the real .env lives at
# /data/droplet/env/.env and the audit / doc-KEK keys at /data/droplet/secrets/
# (scripts/lib/luks.sh:116), with symlinks left at <repo>/.env and
# <repo>/data/secrets. factory-reset.sh removed the SYMLINKS — `rm` on a
# symlink unlinks the link, never the target — so every generated device secret
# survived a "factory reset" on the /data volume. storage-wipe.sh never covered
# it either (bulk drives under /mnt/droplet only). On a 2-year hardware lease
# that is the previous tenant's keys shipped inside the box.
#
# These tests need NO root, NO Docker and NO /data. The whole path runs against
# a fixture tree through the library's documented seams (SECW_SUDO, SECW_OWNER,
# SECW_DIR_MODE, SECW_REPO_ROOT) — deliberately, because tests/factory-reset.
# test.sh shells out to `docker compose version` and cannot run on a box whose
# daemon is down, which is exactly a box a factory reset has to work on.
#
# Runtime: < 3 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="$REPO_ROOT_REAL/scripts/lib/secrets-wipe.sh"
RESET="$REPO_ROOT_REAL/scripts/factory-reset.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  factory-reset — live secrets on /data (WARP-2629)"
echo "  ================================================"
echo ""

# The value planted in every fixture secret. Obviously fake, and grepped for in
# the captured output at the end: rule 19 — a wipe must never print what it
# wiped.
FIXTURE_SECRET='DEVICE_SECRET_KEY=FAKE-fixture-warp2629-do-not-use'

# --- Phase 1: wiring -------------------------------------------------------
echo "--- Phase 1: the wipe is wired into the reset ---"

if [ -f "$LIB" ]; then
  pass "secrets-wipe library exists"
else
  fail "secrets-wipe library missing at $LIB"
  echo "FAILURES=$FAILURES"; exit 1
fi

# Every assertion below reads COMMENT-STRIPPED code. The comments in this
# region deliberately name both `rm`s and the wipe function to explain the
# ordering, so a whole-file grep would pass on prose alone.
CODE_NUM="$(grep -nvE '^[[:space:]]*#' "$RESET")"

if grep -qF 'lib/secrets-wipe.sh' <<<"$CODE_NUM"; then
  pass "factory-reset sources the secrets-wipe library"
else
  fail "factory-reset does not source scripts/lib/secrets-wipe.sh"
fi

if grep -qE '^[0-9]+:secw_wipe_live_secrets ' <<<"$CODE_NUM"; then
  pass "factory-reset calls secw_wipe_live_secrets"
else
  fail "factory-reset never calls secw_wipe_live_secrets — the live secrets survive the reset"
fi

# ORDERING IS THE FIX. The wipe has to run while the symlinks still resolve;
# once `rm -f "$REPO_ROOT/.env"` has unlinked the link, the target on /data is
# unreachable from this script and the secrets stay on the box forever.
WIPE_LINE="$(printf '%s\n' "$CODE_NUM" | grep -E '^[0-9]+:secw_wipe_live_secrets ' | head -n 1 | cut -d: -f1 || true)"
UNLINK_LINE="$(printf '%s\n' "$CODE_NUM" | grep -F 'rm -f "$REPO_ROOT/.env"' | head -n 1 | cut -d: -f1 || true)"
SECRETS_RM_LINE="$(printf '%s\n' "$CODE_NUM" | grep -F 'rm -rf "$REPO_ROOT/data/secrets"' | head -n 1 | cut -d: -f1 || true)"
if [ -n "$WIPE_LINE" ] && [ -n "$UNLINK_LINE" ] && [ "$WIPE_LINE" -lt "$UNLINK_LINE" ]; then
  pass "the wipe runs BEFORE the .env symlink is unlinked"
else
  fail "the wipe does not precede the .env unlink (wipe=$WIPE_LINE unlink=$UNLINK_LINE) — the target becomes unreachable"
fi
if [ -n "$WIPE_LINE" ] && [ -n "$SECRETS_RM_LINE" ] && [ "$WIPE_LINE" -lt "$SECRETS_RM_LINE" ]; then
  pass "the wipe runs BEFORE the data/secrets symlink is removed"
else
  fail "the wipe does not precede the data/secrets rm (wipe=$WIPE_LINE rm=$SECRETS_RM_LINE)"
fi

# A dangling symlink is not a regular file: without the -L arm the reset would
# leave <repo>/.env pointing into /data after the wipe shredded its target.
if grep -qF '[ -f "$REPO_ROOT/.env" ] || [ -L "$REPO_ROOT/.env" ]' "$RESET"; then
  pass "the .env unlink also catches a dangling symlink (-L)"
else
  fail "the .env unlink still tests -f only — a shredded target leaves the symlink behind"
fi

if "$RESET" --help 2>/dev/null | grep -qF 'encrypted /data'; then
  pass "--help states the live /data secrets are wiped"
else
  fail "--help does not mention the live /data secrets"
fi

# WARP-2638 — the post-wipe gate. The volume phase re-enumerates and refuses to
# finish while an owned volume survives; the secrets wipe only warned. Same
# treatment now, and the ORDERING matters twice over: the gate has to run after
# the link-side .env.* purge and after the data/secrets rm (otherwise it reds on
# files the reset is about to remove), and it has to run after the device-bridge
# cleanup (aborting earlier would leave MORE on the box, not less).
if grep -qE '^[0-9]+:if ! secw_verify_wipe ' <<<"$CODE_NUM"; then
  pass "factory-reset gates on secw_verify_wipe"
else
  fail "factory-reset never verifies the wipe — a survivor is only a warning"
fi

GATE_LINE="$(printf '%s\n' "$CODE_NUM" | grep -E '^[0-9]+:if ! secw_verify_wipe ' | head -n 1 | cut -d: -f1 || true)"
LINK_PURGE_LINE="$(printf '%s\n' "$CODE_NUM" | grep -F '"$_env_reset_target".upsert.*; do' | head -n 1 | cut -d: -f1 || true)"
BRIDGE_LINE="$(printf '%s\n' "$CODE_NUM" | grep -F '/var/log/droplet-device-bridge.log' | head -n 1 | cut -d: -f1 || true)"
if [ -n "$GATE_LINE" ] && [ -n "$SECRETS_RM_LINE" ] && [ -n "$LINK_PURGE_LINE" ] \
   && [ "$GATE_LINE" -gt "$SECRETS_RM_LINE" ] && [ "$GATE_LINE" -gt "$LINK_PURGE_LINE" ]; then
  pass "the gate runs AFTER the link-side purge and the data/secrets rm"
else
  fail "the gate runs too early (gate=$GATE_LINE link-purge=$LINK_PURGE_LINE secrets-rm=$SECRETS_RM_LINE) — it would red on files the reset still removes"
fi
if [ -n "$GATE_LINE" ] && [ -n "$BRIDGE_LINE" ] && [ "$GATE_LINE" -gt "$BRIDGE_LINE" ]; then
  pass "the gate runs AFTER the device-bridge cleanup (aborting earlier leaves more behind)"
else
  fail "the gate precedes the device-bridge cleanup (gate=$GATE_LINE bridge=$BRIDGE_LINE)"
fi

# A gate that does not abort is a log line. The volume gate exits 1; so does this.
if [ -n "$GATE_LINE" ] \
   && sed -n "${GATE_LINE},$((GATE_LINE + 12))p" "$RESET" | grep -qE '^[[:space:]]*exit 1$'; then
  pass "the gate ABORTS the reset (exit 1) rather than warning"
else
  fail "the gate does not exit non-zero — a surviving secret would still report a clean reset"
fi

# --- Fixture ----------------------------------------------------------------
# A box shaped like a relocated one: the repo holds SYMLINKS, the real files
# live under a fake /data mount.
make_fixture() {
  TMP="$(mktemp -d)"
  export TMP
  mkdir -p "$TMP/repo/data" "$TMP/data/droplet/env" "$TMP/data/droplet/secrets" "$TMP/bin"

  ENV_TARGET="$TMP/data/droplet/env/.env"
  SECRETS_TARGET="$TMP/data/droplet/secrets"

  printf '%s\n' "$FIXTURE_SECRET" > "$ENV_TARGET"
  # Every snapshot / staging sibling secrets.sh can leave beside the target
  # (WARP-2624's globs). Each is a COMPLETE copy of the same secrets.
  for suffix in bak.1756800000 torn.1756800001 tmp.4242 migrate.4242 upsert.4242; do
    printf '%s\n' "$FIXTURE_SECRET" > "$ENV_TARGET.$suffix"
  done
  printf '%s\n' "$FIXTURE_SECRET" > "$SECRETS_TARGET/audit.key"
  printf '%s\n' "$FIXTURE_SECRET" > "$SECRETS_TARGET/doc-kek.key"
  mkdir -p "$SECRETS_TARGET/nested"
  printf '%s\n' "$FIXTURE_SECRET" > "$SECRETS_TARGET/nested/extra.key"

  ln -s "$ENV_TARGET" "$TMP/repo/.env"
  ln -s "$SECRETS_TARGET" "$TMP/repo/data/secrets"

  SECW_SUDO=""
  SECW_OWNER=""
  SECW_REPO_ROOT="$TMP/repo"
  export SECW_SUDO SECW_OWNER SECW_REPO_ROOT
  # shellcheck disable=SC1090
  source "$LIB"
}

# resolve_env_target — the exact resolution factory-reset.sh performs, so the
# drill drives the library through the same value the reset would hand it.
resolve_env_target() {
  local p="$1"
  if [ -L "$p" ]; then
    p="$(readlink -f "$p" 2>/dev/null || readlink "$p")"
  fi
  printf '%s' "$p"
}

# --- Phase 2: the happy path ------------------------------------------------
echo ""
echo "--- Phase 2: a relocated box's live secrets are actually destroyed ---"

( make_fixture
  secw_wipe_live_secrets "$(resolve_env_target "$TMP/repo/.env")" \
                         "$(resolve_env_target "$TMP/repo/data/secrets")" >/dev/null 2>&1
  [ ! -e "$ENV_TARGET" ]
) && pass "the live .env at the resolved target is gone" \
  || fail "the live .env survived the wipe"

( make_fixture
  secw_wipe_live_secrets "$(resolve_env_target "$TMP/repo/.env")" \
                         "$(resolve_env_target "$TMP/repo/data/secrets")" >/dev/null 2>&1
  # shellcheck disable=SC2012
  [ "$(ls -1 "$TMP/data/droplet/env" | wc -l | tr -d ' ')" = "0" ]
) && pass "every snapshot/staging sibling beside the target is gone" \
  || fail "a .env.{bak,torn,tmp,migrate,upsert}.* copy survived on /data"

( make_fixture
  secw_wipe_live_secrets "$(resolve_env_target "$TMP/repo/.env")" \
                         "$(resolve_env_target "$TMP/repo/data/secrets")" >/dev/null 2>&1
  [ -d "$SECRETS_TARGET" ] && [ -z "$(find "$SECRETS_TARGET" -mindepth 1 -print -quit)" ]
) && pass "the secrets dir is emptied (audit.key, doc-kek.key, nested) and kept" \
  || fail "the secrets dir still has contents after the wipe"

( make_fixture
  secw_wipe_live_secrets "$(resolve_env_target "$TMP/repo/.env")" \
                         "$(resolve_env_target "$TMP/repo/data/secrets")" >/dev/null 2>&1
  # relocate_secrets_to_data's contract: install user, dirs 0750
  # (scripts/lib/luks.sh:109-114). Anything tighter locks the non-root
  # install user out of its own re-provision.
  m1="$(stat -c '%a' "$TMP/data/droplet/env" 2>/dev/null || stat -f '%Lp' "$TMP/data/droplet/env")"
  m2="$(stat -c '%a' "$SECRETS_TARGET" 2>/dev/null || stat -f '%Lp' "$SECRETS_TARGET")"
  [ "$m1" = "750" ] && [ "$m2" = "750" ]
) && pass "both containers are re-created 0750 (the mode setup.sh expects)" \
  || fail "the re-created /data containers do not carry mode 0750"

( make_fixture
  # NOTE: not `$(...)` — a command substitution would run the wipe in a
  # subshell and the SECW_* totals would never reach this shell.
  secw_wipe_live_secrets "$(resolve_env_target "$TMP/repo/.env")" \
                         "$(resolve_env_target "$TMP/repo/data/secrets")" >/dev/null 2>&1
  first="$SECW_WIPED_COUNT"
  secw_wipe_live_secrets "$ENV_TARGET" "$SECRETS_TARGET" >/dev/null 2>&1
  rc=$?
  [ "$first" = "9" ] && [ "$SECW_WIPED_COUNT" = "0" ] && [ "$SECW_FAILED_COUNT" = "0" ] \
    && [ "$rc" = "0" ]
) && pass "9 files wiped on the first run; the second run is a no-op, exit 0" \
  || fail "the wipe is not idempotent (second run must wipe nothing and exit 0)"

# --- Phase 3: it does not need Docker, root, or shred -----------------------
echo ""
echo "--- Phase 3: runs with Docker down, unprivileged, with or without shred ---"

# Static: the wipe must not reach for Docker at all. tests/factory-reset.test.sh
# cannot run on a box whose daemon is down (it shells to `docker compose
# version`) — which is exactly the box a factory reset has to work on, so this
# path stays Docker-free by construction, not by luck.
if grep -vE '^[[:space:]]*#' "$LIB" | grep -q 'docker'; then
  fail "the secrets-wipe library reaches for docker in executable code"
else
  pass "the library's executable code never mentions docker"
fi

( make_fixture
  # And a dead daemon really is survivable: a `docker` that fails for every
  # invocation, first on PATH.
  cat > "$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "Cannot connect to the Docker daemon" >&2
exit 1
STUB
  chmod +x "$TMP/bin/docker"
  PATH="$TMP/bin:$PATH"
  export PATH
  hash -r
  secw_wipe_live_secrets "$ENV_TARGET" "$SECRETS_TARGET" >/dev/null 2>&1
  [ ! -e "$ENV_TARGET" ] && [ -z "$(find "$SECRETS_TARGET" -mindepth 1 -print -quit)" ]
) && pass "the wipe completes with the Docker daemon down" \
  || fail "the wipe does not complete when docker fails"

( make_fixture
  # Force the fallback branch. macOS has no `shred` at all (so the appliance's
  # own dev machines always take this path); on Linux it exists, so shadow it
  # with a stub that refuses — same branch, and it also covers a real shred
  # that fails on the box. A stub `dd` records what it was asked to do.
  cat > "$TMP/bin/shred" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
  cat > "$TMP/bin/dd" <<'STUB'
#!/usr/bin/env bash
printf 'dd %s\n' "$*" >> "$TMP/calls"
exit 0
STUB
  chmod +x "$TMP/bin/shred" "$TMP/bin/dd"
  PATH="$TMP/bin:$PATH"
  export PATH
  hash -r
  secw_wipe_live_secrets "$ENV_TARGET" "$SECRETS_TARGET" >/dev/null 2>&1
  grep -qF "conv=notrunc" "$TMP/calls" \
    && grep -qF "of=$ENV_TARGET " "$TMP/calls" \
    && [ ! -e "$ENV_TARGET" ]
) && pass "with no usable shred it overwrites in place (dd conv=notrunc) then unlinks" \
  || fail "the fallback did not overwrite the file's own blocks before unlinking"

# --- Phase 4: rule 19 — nothing it wipes is ever printed --------------------
echo ""
echo "--- Phase 4: no secret value reaches any output line ---"

WIPE_OUT="$(
  make_fixture >/dev/null 2>&1
  secw_wipe_live_secrets "$(resolve_env_target "$TMP/repo/.env")" \
                         "$(resolve_env_target "$TMP/repo/data/secrets")" 2>&1 || true
  printf 'env=%s snapshots=%s secrets=%s failed=%s\n' \
    "$SECW_WIPED_ENV" "$SECW_WIPED_SNAPSHOTS" "$SECW_WIPED_SECRETS" "$SECW_FAILED_COUNT"
)"
if printf '%s' "$WIPE_OUT" | grep -qF 'FAKE-fixture-warp2629'; then
  fail "a fixture secret VALUE appeared in the wipe output (rule 19)"
else
  pass "no secret value in any output line (rule 19)"
fi
if printf '%s' "$WIPE_OUT" | grep -qF 'env=1 snapshots=5 secrets=3'; then
  pass "the wipe reports per-class counts for the reset's record"
else
  fail "the wipe does not report what it destroyed (got: $WIPE_OUT)"
fi

# --- Phase 5: a non-relocated box is unaffected -----------------------------
echo ""
echo "--- Phase 5: a plain (non-relocated) .env still works, and the repo is not touched ---"

( TMP="$(mktemp -d)"; export TMP
  mkdir -p "$TMP/repo/data/secrets"
  printf '%s\n' "$FIXTURE_SECRET" > "$TMP/repo/.env"
  printf '%s\n' "$FIXTURE_SECRET" > "$TMP/repo/.env.bak.1756800000"
  printf '%s\n' "$FIXTURE_SECRET" > "$TMP/repo/data/secrets/audit.key"
  SECW_SUDO=""; SECW_OWNER=""; SECW_REPO_ROOT="$TMP/repo"
  export SECW_SUDO SECW_OWNER SECW_REPO_ROOT
  # shellcheck disable=SC1090
  source "$LIB"
  secw_wipe_live_secrets "$TMP/repo/.env" "$TMP/repo/data/secrets" >/dev/null 2>&1
  [ ! -e "$TMP/repo/.env" ] && [ ! -e "$TMP/repo/.env.bak.1756800000" ] \
    && [ ! -e "$TMP/repo/data/secrets/audit.key" ]
) && pass "a plain repo-side .env + secrets dir are wiped too" \
  || fail "the non-relocated shape is not covered"

( TMP="$(mktemp -d)"; export TMP
  mkdir -p "$TMP/repo/data/secrets"
  printf '%s\n' "$FIXTURE_SECRET" > "$TMP/repo/.env"
  # Distinctive modes: if the re-create step ever treats a repo-side path as a
  # relocated container it chmods them to 0750 — and for the .env the container
  # is the repo ROOT itself, i.e. it would chmod the whole checkout.
  chmod 0755 "$TMP/repo"
  chmod 0700 "$TMP/repo/data/secrets"
  SECW_SUDO=""; SECW_OWNER=""; SECW_REPO_ROOT="$TMP/repo"
  export SECW_SUDO SECW_OWNER SECW_REPO_ROOT
  # shellcheck disable=SC1090
  source "$LIB"
  secw_wipe_live_secrets "$TMP/repo/.env" "$TMP/repo/data/secrets" >/dev/null 2>&1
  m1="$(stat -c '%a' "$TMP/repo" 2>/dev/null || stat -f '%Lp' "$TMP/repo")"
  m2="$(stat -c '%a' "$TMP/repo/data/secrets" 2>/dev/null || stat -f '%Lp' "$TMP/repo/data/secrets")"
  [ "$m1" = "755" ] && [ "$m2" = "700" ]
) && pass "repo-side paths are never re-created or chmodded (the checkout is untouched)" \
  || fail "the re-create step chmodded a path inside the repo checkout"

# --- Phase 6: the post-wipe verification gate (WARP-2638) -------------------
echo ""
echo "--- Phase 6: the gate re-scans the disk and reds on whatever survived ---"

# What factory-reset.sh does to the LINK side after the wipe (the .env unlink,
# the repo-side .env.* glob purge, the data/secrets rm). The drills below run it
# so the gate sees the state the gate is actually placed in — a fixture that
# skips it still holds a DANGLING <repo>/.env and every gate call would red on
# it, which would make the per-class assertions meaningless.
emulate_reset_link_purge() {
  rm -f "$TMP/repo/.env" 2>/dev/null || true
  rm -f "$TMP"/repo/.env.bak.* "$TMP"/repo/.env.torn.* "$TMP"/repo/.env.tmp.* \
        "$TMP"/repo/.env.migrate.* "$TMP"/repo/.env.upsert.* 2>/dev/null || true
  rm -rf "$TMP/repo/data/secrets" 2>/dev/null || true
}

full_wipe() {
  secw_wipe_live_secrets "$(resolve_env_target "$TMP/repo/.env")" \
                         "$(resolve_env_target "$TMP/repo/data/secrets")" >/dev/null 2>&1
  emulate_reset_link_purge
}

( make_fixture
  full_wipe
  secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo"
  rc=$?
  [ "$rc" = "0" ] && [ "$SECW_LEFTOVER_COUNT" = "0" ] && [ -z "$SECW_LEFTOVER_PATHS" ]
) && pass "a complete wipe passes the gate (exit 0, nothing named)" \
  || fail "the gate reds on a tree the wipe fully cleaned"

# Idempotence, end to end: the gate stays clean on a second pass, so a second
# factory reset is still a no-op that exits 0.
( make_fixture
  full_wipe
  secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo" || exit 1
  secw_wipe_live_secrets "$ENV_TARGET" "$SECRETS_TARGET" >/dev/null 2>&1
  secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo"
) && pass "a second wipe + gate is still clean (the reset stays idempotent)" \
  || fail "the gate reds on a second run — the reset is no longer idempotent"

# One drill per class the wipe owns. Planting the file back is EXACTLY the
# observable state a wipe that skipped that class would leave, and the gate must
# name that path and only that path.
#
# $2 is RELATIVE to the fixture root, because $TMP only exists inside the
# subshell that builds the fixture. $3 is how many paths the gate should name —
# 1 for every class except a nested secrets file, where the subdirectory it sits
# in is a leftover too (the wipe unlinks stray dirs, so a non-empty container is
# itself the finding).
gate_names_only() {
  local label="$1" rel="$2" want="${3:-1}"
  ( make_fixture
    full_wipe
    planted="$TMP/$rel"
    mkdir -p "$(dirname "$planted")"
    printf '%s\n' "$FIXTURE_SECRET" > "$planted"
    if secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo"; then
      exit 1   # gate stayed green with a secret on the box
    fi
    [ "$SECW_LEFTOVER_COUNT" = "$want" ] \
      && printf '%s' "$SECW_LEFTOVER_PATHS" | grep -qxF "$planted"
  ) && pass "gate reds naming exactly the leftover: $label" \
    || fail "the gate missed (or mis-named) a surviving $label"
}

gate_names_only "live .env on /data"                "data/droplet/env/.env"
gate_names_only "snapshot sibling beside it"        "data/droplet/env/.env.bak.1756800000"
gate_names_only "file under the secrets dir"        "data/droplet/secrets/audit.key"
gate_names_only "nested file under the secrets dir" "data/droplet/secrets/nested/extra.key" 2
gate_names_only "link-side copy on the boot disk"   "repo/.env.torn.1756800001"

# A dangling symlink is not a regular file — the `-L` arm is what catches the
# <repo>/.env left pointing into /data after its target was shredded.
( make_fixture
  secw_wipe_live_secrets "$(resolve_env_target "$TMP/repo/.env")" \
                         "$(resolve_env_target "$TMP/repo/data/secrets")" >/dev/null 2>&1
  # deliberately NOT running emulate_reset_link_purge: this is the state where
  # the reset forgot the unlink.
  if secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo"; then exit 1; fi
  printf '%s' "$SECW_LEFTOVER_PATHS" | grep -qxF "$TMP/repo/.env"
) && pass "a dangling <repo>/.env symlink is caught (-L, not just -f)" \
  || fail "the gate misses a dangling symlink left pointing into /data"

# The gate must re-scan the DISK. A gate that trusted the wipe's own counters
# would agree with the wiper by construction and prove nothing: here the
# counters say a clean 0 failures while a secret is still on the box.
( make_fixture
  full_wipe
  printf '%s\n' "$FIXTURE_SECRET" > "$ENV_TARGET"
  [ "$SECW_FAILED_COUNT" = "0" ] || exit 1     # the wiper thinks all is well
  if secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo"; then exit 1; fi
  [ "$SECW_LEFTOVER_COUNT" = "1" ]
) && pass "the gate re-scans the filesystem, not the wipe's own counters" \
  || fail "the gate is derived from SECW_FAILED_COUNT — it cannot catch a missed class"

# Rule 19 again, on the gate's own output: it names paths, never values.
GATE_OUT="$(
  make_fixture >/dev/null 2>&1
  full_wipe
  printf '%s\n' "$FIXTURE_SECRET" > "$ENV_TARGET"
  secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo" 2>&1 || true
  printf '%s\n' "$SECW_LEFTOVER_PATHS"
)"
if printf '%s' "$GATE_OUT" | grep -qF 'FAKE-fixture-warp2629'; then
  fail "the gate leaked a fixture secret VALUE while naming a leftover (rule 19)"
else
  pass "the gate names paths only, never a value (rule 19)"
fi

# The gate is part of the Docker-free path: it must work on a box whose daemon
# is down, which is exactly the box a factory reset runs on.
( make_fixture
  cat > "$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "Cannot connect to the Docker daemon" >&2
exit 1
STUB
  chmod +x "$TMP/bin/docker"
  PATH="$TMP/bin:$PATH"; export PATH; hash -r
  full_wipe
  secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo"
) && pass "the gate runs with the Docker daemon down" \
  || fail "the gate does not complete when docker fails"

# =============================================================================
# Phase 7: /data is NOT mounted (WARP-2621)
# =============================================================================
# THE DEFECT. TPM unlock fails, or a reset is run on a box whose LUKS volume is
# still locked. `/data` is then an EMPTY mountpoint on the ROOT filesystem and
# <repo>/.env is a DANGLING symlink into it. Every step downstream then agrees
# that nothing is wrong:
#
#   - `readlink -f` cannot canonicalise a path whose parent chain is missing, so
#     the `|| readlink` fallback in factory-reset.sh hands the library the RAW
#     link text — a path naming a directory that is not there;
#   - every wipe target is absent, so the wipe reports
#     `env=0 snapshots=0 secrets=0`, SECW_FAILED_COUNT stays 0, nothing errors;
#   - `_secw_recreate_dir` then `mkdir -p`s /data/droplet/env and
#     /data/droplet/secrets ON THE ROOT FILESYSTEM, underneath the unmounted
#     mountpoint — destroying the only structural evidence that the volume was
#     unreachable, under a path the next successful mount will SHADOW;
#   - `secw_verify_wipe` re-scans, finds nothing (there was never anything to
#     find) and returns PASS with SECW_LEFTOVER_COUNT=0.
#
# The transcript reads "Verified: no .env, snapshot or secrets-dir file
# remains" while every secret is intact on the locked volume. On a leased box
# that is exactly the tenant handover this stack exists to prevent, wearing a
# green verification.
#
# A re-scan AFTER the recreate step CANNOT tell "wiped" from "unreachable" —
# the two leave a byte-identical tree. So the reset has to refuse before it
# starts, the re-create step must never fabricate a container under an
# unmounted mountpoint, and the gate has to be TOLD the pre-wipe fact instead
# of re-deriving it.
echo ""
echo "--- Phase 7: an unmounted /data must ABORT, never verify clean ---"

# The same shape as make_fixture, minus the mount: $TMP/data is an EMPTY
# mountpoint, so $TMP/data/droplet does not exist and both repo-side links
# dangle into it.
make_unmounted_fixture() {
  TMP="$(mktemp -d)"
  export TMP
  mkdir -p "$TMP/repo/data" "$TMP/data"

  ENV_TARGET="$TMP/data/droplet/env/.env"
  SECRETS_TARGET="$TMP/data/droplet/secrets"

  ln -s "$ENV_TARGET" "$TMP/repo/.env"
  ln -s "$SECRETS_TARGET" "$TMP/repo/data/secrets"

  SECW_SUDO=""
  SECW_OWNER=""
  SECW_REPO_ROOT="$TMP/repo"
  export SECW_SUDO SECW_OWNER SECW_REPO_ROOT
  # shellcheck disable=SC1090
  source "$LIB"
}

unmounted_wipe() {
  secw_wipe_live_secrets "$(resolve_env_target "$TMP/repo/.env")" \
                         "$(resolve_env_target "$TMP/repo/data/secrets")" >/dev/null 2>&1
}

# The premise, asserted rather than assumed: this really is the shape the box is
# in, and the resolve really does fall back to the raw link text.
( make_unmounted_fixture
  [ -L "$TMP/repo/.env" ] && [ ! -e "$TMP/repo/.env" ] \
    && ! readlink -f "$TMP/repo/.env" >/dev/null 2>&1 \
    && [ "$(resolve_env_target "$TMP/repo/.env")" = "$ENV_TARGET" ] \
    && [ ! -d "$(dirname "$ENV_TARGET")" ]
) && pass "premise: the repo .env dangles, readlink -f fails, the container is absent" \
  || fail "the unmounted-/data fixture does not reproduce the dangling-link shape"

# The wipe genuinely cannot see anything — which is WHY its own counters can
# never be the evidence. Pinned so the honest-but-misleading zero stays honest.
( make_unmounted_fixture
  unmounted_wipe
  [ "$SECW_WIPED_COUNT" = "0" ] && [ "$SECW_FAILED_COUNT" = "0" ]
) && pass "premise: the wipe reports 0 wiped / 0 failed — it never saw the secrets" \
  || fail "the unmounted-/data wipe does not report the zero counts the defect rests on"

# --- (a) the reset refuses to start ----------------------------------------
( make_unmounted_fixture
  secw_volume_unreachable "$TMP/repo" "$(resolve_env_target "$TMP/repo/.env")"
) && pass "the volume-reachability predicate FIRES on an unmounted /data" \
  || fail "an unmounted /data is not detected — the reset would run and report clean"

# The other direction matters just as much: a predicate that always fires would
# brick every reset on every shipped box.
( make_fixture
  # `command -v` first: without it a MISSING function exits 127 and the `!`
  # would report a pass — a guard that cannot fail.
  command -v secw_volume_unreachable >/dev/null \n    && ! secw_volume_unreachable "$TMP/repo" "$(resolve_env_target "$TMP/repo/.env")"
) && pass "it does NOT fire on a normally-mounted relocated box" \
  || fail "the predicate fires on a healthy relocated box — every reset would abort"

( TMP="$(mktemp -d)"; export TMP
  mkdir -p "$TMP/repo/data/secrets"
  printf '%s\n' "$FIXTURE_SECRET" > "$TMP/repo/.env"
  SECW_SUDO=""; SECW_OWNER=""; SECW_REPO_ROOT="$TMP/repo"
  export SECW_SUDO SECW_OWNER SECW_REPO_ROOT
  # shellcheck disable=SC1090
  source "$LIB"
  command -v secw_volume_unreachable >/dev/null \n    && ! secw_volume_unreachable "$TMP/repo" "$TMP/repo/.env"
) && pass "it does NOT fire on a plain (never-relocated) box — .env is no symlink" \
  || fail "the predicate fires on a non-relocated box"

# The abort has to happen BEFORE the wipe. Once secw_wipe_live_secrets has run,
# the re-create step has already had its chance at the mountpoint and the
# transcript already claims a clean wipe.
UNREACHABLE_LINE="$(grep -E '^[0-9]+:if secw_volume_unreachable ' <<<"$CODE_NUM" | head -n 1 | cut -d: -f1 || true)"
if [ -n "$UNREACHABLE_LINE" ] && [ -n "$WIPE_LINE" ] && [ "$UNREACHABLE_LINE" -lt "$WIPE_LINE" ]; then
  pass "factory-reset checks volume reachability BEFORE it wipes"
else
  fail "factory-reset does not gate on secw_volume_unreachable before the wipe"
fi

if [ -n "$UNREACHABLE_LINE" ] \
   && sed -n "${UNREACHABLE_LINE},$((UNREACHABLE_LINE + 14))p" "$RESET" | grep -qE '^[[:space:]]*exit 1$'; then
  pass "the unreachable-volume branch ABORTS the reset (exit 1)"
else
  fail "an unmounted /data does not abort the reset — it would report a clean wipe"
fi

# The operator has to be able to act on it: name the volume, and say the keys
# are still sitting on it.
if [ -n "$UNREACHABLE_LINE" ] \
   && sed -n "${UNREACHABLE_LINE},$((UNREACHABLE_LINE + 14))p" "$RESET" | grep -qi 'unlock'; then
  pass "the abort tells the operator to unlock the volume and re-run"
else
  fail "the abort does not tell the operator what to do"
fi

# --- (b) the re-create step never fabricates a container --------------------
( make_unmounted_fixture
  unmounted_wipe
  # NOTHING may appear under the unmounted mountpoint. The moment
  # $TMP/data/droplet exists on the root filesystem the one piece of evidence
  # that the volume was never mounted is gone — and it is gone under a path the
  # next successful mount SHADOWS, so it is unfindable afterwards too.
  [ ! -e "$TMP/data/droplet" ] && [ -z "$(find "$TMP/data" -mindepth 1 -print -quit)" ]
) && pass "the wipe never fabricates the /data containers under an unmounted mountpoint" \
  || fail "the re-create step wrote into the unmounted mountpoint on the root filesystem"

# --- (c) the gate cannot report PASS ---------------------------------------
( make_unmounted_fixture
  unmounted_wipe
  emulate_reset_link_purge
  secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo"
) && fail "the gate PASSES an unmounted /data — a clean re-scan of an empty mountpoint proves nothing" \
  || pass "the gate REFUSES to pass when the volume was unreachable before the wipe"

( make_unmounted_fixture
  unmounted_wipe
  emulate_reset_link_purge
  secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo" || true
  # BLOCKED, not "leftovers found": no path SURVIVED, the volume was never
  # readable. Two different findings, and the transcript must not merge them.
  [ "$SECW_VERIFY_BLOCKED" = "1" ] && [ -n "$SECW_VERIFY_BLOCKED_REASON" ] \
    && [ "$SECW_LEFTOVER_COUNT" = "0" ]
) && pass "it reports BLOCKED with a reason, not a phantom leftover path" \
  || fail "the unreachable verdict is not distinguishable from a surviving-secret verdict"

# The pre-wipe fact has to be captured BEFORE step (4), not merely before the
# gate. These two are the only assertions that separate the recording from the
# hardening above: mutate the capture to run after _secw_recreate_dir and the
# rest of Phase 7 still passes, because the hardened re-create leaves the
# container absent and a late re-derivation happens to reach the same answer.
#
# The fixture that tells them apart is a box where the CONTAINER is missing but
# its PARENT is not — /data/droplet present, /data/droplet/env gone. That is a
# box a previous buggy reset already fabricated a tree on, and it is the one
# shape where the re-create step legitimately succeeds: capture the fact
# afterwards and it reads "the container is there", which is only true because
# this function just made it so.
make_orphaned_container_fixture() {
  TMP="$(mktemp -d)"
  export TMP
  mkdir -p "$TMP/repo/data" "$TMP/data/droplet"

  ENV_TARGET="$TMP/data/droplet/env/.env"
  SECRETS_TARGET="$TMP/data/droplet/secrets"

  ln -s "$ENV_TARGET" "$TMP/repo/.env"
  ln -s "$SECRETS_TARGET" "$TMP/repo/data/secrets"

  SECW_SUDO=""
  SECW_OWNER=""
  SECW_REPO_ROOT="$TMP/repo"
  export SECW_SUDO SECW_OWNER SECW_REPO_ROOT
  # shellcheck disable=SC1090
  source "$LIB"
}

( make_orphaned_container_fixture
  unmounted_wipe
  # The re-create step DID run here (the parent exists, so it is allowed to) —
  # and the recorded fact must still be the one from before it ran.
  [ -d "$(dirname "$ENV_TARGET")" ] && [ "$SECW_ENV_CONTAINER_MISSING" = "1" ]
) && pass "the pre-wipe fact survives a re-create step that legitimately succeeds" \
  || fail "the container fact is re-derived after the re-create step, so it reads the step's own output"

( make_orphaned_container_fixture
  unmounted_wipe
  emulate_reset_link_purge
  secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo"
) && fail "the gate passes a tree whose container only exists because the wipe re-created it" \
  || pass "the gate still refuses when only the re-create step made the container exist"

# The pre-wipe fact is an INPUT, not something the gate re-derives. That is the
# whole point: by the time the gate runs, the tree looks identical either way.
( make_fixture
  full_wipe
  ! secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo" 1
) && pass "a caller-supplied pre-wipe fact overrides a clean re-scan" \
  || fail "the gate talks itself out of the pre-wipe fact by re-scanning"

( make_fixture
  full_wipe
  secw_verify_wipe "$ENV_TARGET" "$SECRETS_TARGET" "$TMP/repo" 0
) && pass "and an explicit -container was there- still passes a clean tree" \
  || fail "the 4th argument breaks the happy path"

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ "$FAILURES" -gt 0 ]; then
  printf " (\033[31m%d failed\033[0m)" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit "$FAILURES"
