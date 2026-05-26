#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — Ship Check regression tests
# =============================================================================
#
# Each test below proves that one ship-check check would have caught a real
# bug class that shipped to droplet-sys on 2026-05-25 (PRs #261, #263). The
# test harness pattern:
#
#   1. mktemp -d a synthetic worktree.
#   2. Selectively copy the files the check needs (minimal — full clones
#      blow disk + time).
#   3. Apply a synthetic regression that mirrors the original bug.
#   4. Point ship-check.sh at the synthetic worktree via REPO_ROOT=…
#      and assert the named check FAILS (exit 1 or check-result fail).
#   5. Restore the original file (no regression), run the check again,
#      assert it PASSES.
#
# Cleanup is via trap — every temp dir is rm -rf'd on EXIT, even on early
# abort. This keeps repeated test runs from accumulating /tmp cruft on
# CI runners.
#
# Convention: each test is wrapped in `_run_test "name" test_body` so its
# pass/fail surfaces in the summary regardless of `set -e` interactions
# with the test body.
#
# WARP-482.
# =============================================================================
set -uo pipefail
# Intentionally NOT `set -e` at the top level — we want individual test
# bodies to be able to assert exit codes from ship-check.sh without the
# harness itself aborting on the first non-zero. Each test function returns
# 0/1 explicitly.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHIP_CHECK="$SCRIPT_DIR/ship-check.sh"

# --- Colors ---
if [ -t 1 ]; then
  _GREEN='\033[0;32m'; _RED='\033[0;31m'; _YELLOW='\033[0;33m'; _BOLD='\033[1m'; _RESET='\033[0m'
else
  _GREEN=''; _RED=''; _YELLOW=''; _BOLD=''; _RESET=''
fi

TOTAL=0
PASSED=0
FAILED=0
FAILED_NAMES=()

_pass() { PASSED=$((PASSED + 1)); printf "  ${_GREEN}PASS${_RESET}  %s\n" "$1"; }
_fail() {
  FAILED=$((FAILED + 1)); FAILED_NAMES+=("$1")
  printf "  ${_RED}FAIL${_RESET}  %s\n" "$1"
  if [ "$#" -gt 1 ]; then
    shift
    printf "    %s\n" "$@" >&2
  fi
}

_run_test() {
  local name="$1"; shift
  TOTAL=$((TOTAL + 1))
  printf "\n${_BOLD}→ %s${_RESET}\n" "$name"
  if "$@"; then
    _pass "$name"
  else
    _fail "$name"
  fi
}

# Convenience: assert ship-check.sh CHECK_NAME exits non-zero when REPO_ROOT
# points at the synthetic worktree. Returns 0 on the expected fail, 1 on
# unexpected pass. Stderr/stdout is captured into the named buffer var so
# the calling test can inspect it.
_assert_check_fails() {
  local synthetic_root="$1" check_name="$2"
  local output rc
  output="$(REPO_ROOT="$synthetic_root" bash "$SHIP_CHECK" "$check_name" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf "    expected exit != 0, got 0\n" >&2
    printf '%s\n' "$output" | sed 's/^/    | /' >&2
    return 1
  fi
  return 0
}

_assert_check_passes() {
  local synthetic_root="$1" check_name="$2"
  local output rc
  output="$(REPO_ROOT="$synthetic_root" bash "$SHIP_CHECK" "$check_name" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf "    expected exit 0, got %d\n" "$rc" >&2
    printf '%s\n' "$output" | sed 's/^/    | /' >&2
    return 1
  fi
  return 0
}

# =============================================================================
# Test: tsc-full catches WARP-329 class (test fixture missing required fields)
# =============================================================================
#
# Original bug: 5 fixtures in chat-persistence.service.test.ts dropped
# `toolCalls: null, toolCallId: null` from their prisma.chatMessage.create
# inputs, but the `MockMessage` shape declared both as required. `npm run dev`
# skipped test compilation and missed it; `RUN npm run build` in the
# orchestrator Dockerfile caught it as TS2322 and failed the entire build,
# wedging the factory-reset at phase 5/7.
#
# Synthetic regression: remove `toolCalls: null` from the canonical "no tool
# call" fixture in the real test file inside a temp clone, then re-run.
# tsc-full should fail.
#
# This test requires `npm` and a previously-installed `node_modules` in the
# real REPO_ROOT (so we can copy the resolved dependency tree into the
# synthetic worktree). On hosts without node_modules it SKIPs gracefully.
test_tsc_full_catches_fixture_regression() {
  if [ ! -d "$REPO_ROOT_REAL/node_modules" ]; then
    printf "    ${_YELLOW}SKIP${_RESET}  REPO_ROOT_REAL has no node_modules — install first\n"
    return 0
  fi

  # We test in-place: mutate the fixture in the real worktree, run the check,
  # then restore via `git checkout --` so even a SIGKILL of this test leaves
  # the tree recoverable from git. The synthetic-worktree alternative was
  # rejected because (a) `tar -cf - .` of a 3 GB monorepo is multi-minute
  # and (b) symlinking node_modules into a tmpdir breaks Prisma's
  # platform-specific binary lookup on Windows hosts.
  #
  # Safety: ABORT before mutating if the fixture already has uncommitted
  # changes — we don't want to discard the developer's WIP via the restore.
  local fixture_rel="apps/orchestrator/src/services/chat-persistence.service.test.ts"
  local fixture="$REPO_ROOT_REAL/$fixture_rel"

  if [ ! -f "$fixture" ]; then
    printf "    fixture file missing: %s\n" "$fixture" >&2
    return 1
  fi
  if ! (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$fixture_rel" 2>/dev/null); then
    printf "    fixture %s already has uncommitted changes — refusing to mutate\n" "$fixture_rel" >&2
    printf "    stash or commit them first, then re-run\n" >&2
    return 1
  fi

  # shellcheck disable=SC2064  # capture path values at trap-set time
  trap "(cd '$REPO_ROOT_REAL' && git checkout -- '$fixture_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: tsc-full PASSES on the unmutated tree.
  if ! _assert_check_passes "$REPO_ROOT_REAL" tsc-full; then
    printf "    baseline tsc-full failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Apply regression — drop the first `toolCalls: null,` line. Mirrors
  #    PR #261's exact reverse.
  awk 'BEGIN{done=0} /toolCalls: null,/ && !done {done=1; next} {print}' \
       "$fixture" > "$fixture.tmp" && mv "$fixture.tmp" "$fixture"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$fixture_rel" 2>/dev/null); then
    printf "    regression mutation no-op — file unchanged\n" >&2
    return 1
  fi

  # 3. tsc-full should now FAIL.
  _assert_check_fails "$REPO_ROOT_REAL" tsc-full
}

# =============================================================================
# Test: compose-config catches YAML breakage in docker-compose.yml
# =============================================================================
#
# Original bug class: compose-time regressions where a service definition
# breaks YAML parsing or references an env var that .env.example doesn't
# declare. `docker compose config` is the canonical validator — it
# resolves env interpolation + schema-validates the merged tree.
#
# Synthetic regression: corrupt one line of docker-compose.yml (delete the
# colon after a key) and assert the check fails.
test_compose_config_catches_yaml_breakage() {
  if ! command -v docker >/dev/null 2>&1; then
    printf "    ${_YELLOW}SKIP${_RESET}  docker not on PATH — install Docker Desktop\n"
    return 0
  fi

  local compose_rel="docker/docker-compose.yml"
  local compose="$REPO_ROOT_REAL/$compose_rel"

  if [ ! -f "$compose" ]; then
    printf "    compose file missing: %s\n" "$compose" >&2
    return 1
  fi
  if ! (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$compose_rel" 2>/dev/null); then
    printf "    %s already dirty — refusing to mutate\n" "$compose_rel" >&2
    return 1
  fi

  # shellcheck disable=SC2064
  trap "(cd '$REPO_ROOT_REAL' && git checkout -- '$compose_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: passes on the unmutated tree.
  if ! _assert_check_passes "$REPO_ROOT_REAL" compose-config; then
    printf "    baseline compose-config failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Apply regression: drop the colon from the first `services:` key so
  #    YAML parsing errors with "could not find expected ':'".
  awk 'BEGIN{done=0} /^services:$/ && !done {done=1; sub(/:$/, "", $0)} {print}' \
       "$compose" > "$compose.tmp" && mv "$compose.tmp" "$compose"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$compose_rel" 2>/dev/null); then
    printf "    regression mutation no-op — compose file unchanged\n" >&2
    return 1
  fi

  # 3. compose-config should now FAIL.
  _assert_check_fails "$REPO_ROOT_REAL" compose-config
}

# =============================================================================
# Test: frigate-env-scan catches WARP-446 class (operator-specific env in
# committed config)
# =============================================================================
#
# Original bug: docker/frigate/config.yml had a live `front_door:` block
# whose RTSP URL referenced {FRIGATE_CAMERA_FRONT_DOOR_PASSWORD}. The
# secrets-generation heredoc in scripts/lib/secrets.sh doesn't write any
# per-camera password (those flow through dashboard discovery), so Frigate
# raised KeyError on first boot of a fresh `.env` and restart-looped the
# whole container.
#
# Synthetic regression: re-insert exactly that broken block into the
# committed config and assert the check fails.
test_frigate_env_scan_catches_unresolved_substitution() {
  local cfg_rel="docker/frigate/config.yml"
  local cfg="$REPO_ROOT_REAL/$cfg_rel"

  if [ ! -f "$cfg" ]; then
    printf "    config file missing: %s\n" "$cfg" >&2
    return 1
  fi
  if ! (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$cfg_rel" 2>/dev/null); then
    printf "    %s already dirty — refusing to mutate\n" "$cfg_rel" >&2
    return 1
  fi

  # shellcheck disable=SC2064
  trap "(cd '$REPO_ROOT_REAL' && git checkout -- '$cfg_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: passes on the unmutated tree (the live config uses only
  #    FRIGATE_MQTT_USER + FRIGATE_MQTT_PASSWORD, both seeded by
  #    secrets.sh).
  if ! _assert_check_passes "$REPO_ROOT_REAL" frigate-env-scan; then
    printf "    baseline frigate-env-scan failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Apply regression: replace the empty `cameras: {}` line with the
  #    exact `front_door:` block that PR #263 stripped out — using the
  #    operator-specific FRIGATE_CAMERA_FRONT_DOOR_PASSWORD env var that
  #    secrets.sh does NOT seed.
  awk '
    /^cameras: \{\}/ {
      print "cameras:"
      print "  front_door:"
      print "    ffmpeg:"
      print "      inputs:"
      print "        - path: \"rtsp://admin:{FRIGATE_CAMERA_FRONT_DOOR_PASSWORD}@192.168.100.219:554/profile2/media.smp\""
      print "          roles:"
      print "            - detect"
      print "            - record"
      next
    }
    { print }
  ' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$cfg_rel" 2>/dev/null); then
    printf "    regression mutation no-op — config unchanged\n" >&2
    return 1
  fi

  # 3. frigate-env-scan should now FAIL.
  _assert_check_fails "$REPO_ROOT_REAL" frigate-env-scan
}

# =============================================================================
# Test: shellcheck catches PR #263 class (static analysis flags real bash bugs
# in scripts/lib/*.sh)
# =============================================================================
#
# Original bug class: scripts/lib/local-dns.sh had a `set -u` interaction
# with a RETURN trap on an `local resp_file` that wasn't initialized, so the
# trap evaluation in some bash versions hit "unbound variable" and aborted
# setup.sh at phase 7/7. The fix in PR #263 added `local resp_file=""` plus
# `${resp_file:-}` in the trap body — exactly the pattern shellcheck would
# flag IF the regression class were static-analysis-detectable.
#
# Caveat: that specific runtime bug (set-u + RETURN trap on uninitialized
# `local`) is NOT one shellcheck catches today (we verified — it produces
# no diagnostic at warning or error severity). But the bug class
# represented by static analysis — declared variables outside functions,
# bad quoting, parse errors — is exactly what shellcheck is FOR, and we
# want ship-check to guard the same class of lib/ regressions.
#
# Synthetic regression: insert a `local foo="bar"` at the top level of
# scripts/lib/local-dns.sh (outside any function — SC2168 error). Assert
# the shellcheck check fails. Restore via `git checkout --` on RETURN.
test_shellcheck_catches_local_outside_function() {
  if ! command -v shellcheck >/dev/null 2>&1; then
    printf "    ${_YELLOW}SKIP${_RESET}  shellcheck not on PATH — install via apt/brew\n"
    return 0
  fi

  local target_rel="scripts/lib/local-dns.sh"
  local target="$REPO_ROOT_REAL/$target_rel"

  if [ ! -f "$target" ]; then
    printf "    target file missing: %s\n" "$target" >&2
    return 1
  fi
  if ! (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$target_rel" 2>/dev/null); then
    printf "    %s already dirty — refusing to mutate\n" "$target_rel" >&2
    return 1
  fi

  # shellcheck disable=SC2064
  trap "(cd '$REPO_ROOT_REAL' && git checkout -- '$target_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: passes on the unmutated tree.
  if ! _assert_check_passes "$REPO_ROOT_REAL" shellcheck; then
    printf "    baseline shellcheck failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Apply regression: prepend a `local foo="bar"` after the shebang.
  #    This violates SC2168 ("local is only valid in functions"), which is
  #    error-level — caught at any severity from `error` upward.
  awk '
    NR == 1 { print; print "local _shipcheck_test_violation=\"x\""; next }
    { print }
  ' "$target" > "$target.tmp" && mv "$target.tmp" "$target"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$target_rel" 2>/dev/null); then
    printf "    regression mutation no-op — file unchanged\n" >&2
    return 1
  fi

  # 3. shellcheck should now FAIL.
  _assert_check_fails "$REPO_ROOT_REAL" shellcheck
}

# =============================================================================
# Test: docker-build-smoke shim's allowlist rejects unknown docker subcommands
# =============================================================================
#
# Original bug class (CR #1 on PR #266): the docker shim that ship-check
# plants inside the Ubuntu smoke container originally had a fail-OPEN
# default — any docker subcommand not explicitly cased (`info` / `run`)
# returned `exit 0`. That meant a future setup.sh change adding e.g.
# `docker version`, `docker pull`, or `docker buildx ls` would silently
# pass the smoke test even though it would fail on a real host that
# actually executes the call.
#
# The fix: explicit allowlist (`info` → 0, `run` → 1, `compose` → 0),
# default case → `exit 1` (fail-CLOSED). Future docker subcommands
# introduced into the `--skip-docker --skip-build --skip-start
# --skip-drivers` codepath must be intentionally added to the allowlist
# or the smoke test fails loudly.
#
# Synthetic regression: inject a `docker buildx ls >/dev/null` call into
# setup.sh inside the SKIP_DOCKER block (which always runs in the smoke
# path). The shim's `*) exit 1` default makes that call return non-zero,
# setup.sh's `set -e` propagates the failure, the smoke check fails.
# Restore the real setup.sh via `git checkout --` on RETURN.
#
# Cost: this test spins up the full Ubuntu 24.04 container and runs
# setup.sh through phase 4 — ~5 minutes per run. Worth it: this is the
# only test that proves the shim isn't fail-open. We deliberately skip
# the unmutated-baseline pass (it's already exercised by
# `bash scripts/test/ship-check.sh --full`) to keep this test at one
# container run, not two.
test_docker_build_smoke_shim_rejects_unknown_subcommand() {
  if ! command -v docker >/dev/null 2>&1; then
    printf "    ${_YELLOW}SKIP${_RESET}  docker not on PATH — install Docker Desktop\n"
    return 0
  fi
  if ! docker info >/dev/null 2>&1; then
    printf "    ${_YELLOW}SKIP${_RESET}  docker daemon not reachable\n"
    return 0
  fi

  local target_rel="scripts/setup.sh"
  local target="$REPO_ROOT_REAL/$target_rel"

  if [ ! -f "$target" ]; then
    printf "    target file missing: %s\n" "$target" >&2
    return 1
  fi
  if ! (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$target_rel" 2>/dev/null); then
    printf "    %s already dirty — refusing to mutate\n" "$target_rel" >&2
    return 1
  fi

  # shellcheck disable=SC2064  # capture path values at trap-set time
  trap "(cd '$REPO_ROOT_REAL' && git checkout -- '$target_rel') 2>/dev/null || true" RETURN EXIT

  # Apply regression: inject `docker buildx ls >/dev/null` right after the
  # `Skipping Docker installation` log_info line. That line always runs
  # in the smoke configuration (`--skip-docker` is passed by ship-check),
  # and `buildx` is NOT in the shim's allowlist, so the default `exit 1`
  # fires, `set -e` in setup.sh propagates the failure, and the smoke
  # check ends with a non-zero rc.
  awk '
    /log_info "Skipping Docker installation \(--skip-docker\)"/ {
      print
      print "    docker buildx ls >/dev/null"
      next
    }
    { print }
  ' "$target" > "$target.tmp" && mv "$target.tmp" "$target"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$target_rel" 2>/dev/null); then
    printf "    regression mutation no-op — %s unchanged\n" "$target_rel" >&2
    return 1
  fi

  # docker-build-smoke should now FAIL because the shim refuses
  # `docker buildx ls` (exit 1 from the default case).
  _assert_check_fails "$REPO_ROOT_REAL" docker-build-smoke
}

# =============================================================================
# Test: exec-bits catches a chmod-stripped tracked script
# =============================================================================
#
# Original bug class (WARP-487): scripts/test/ship-check.sh +
# scripts/test/ship-check.test.sh shipped to main (PR #266) with index
# mode 100644 instead of 100755 — the executable bit never made it into
# the tree. `bash <path>` worked everywhere, so the regression went
# unnoticed, but `./scripts/test/ship-check.sh` (the canonical invocation
# in the script's own --help) is a no-op on a filesystem that respects
# the index mode bit. On Windows the working-tree bit is non-trackable;
# the git INDEX mode is the only canonical signal.
#
# Synthetic regression: strip the exec bit from a tracked script via
# `git update-index --chmod=-x` and assert the exec-bits check fails.
# Restore via `git update-index --chmod=+x` on RETURN — works even on
# Windows where filesystem chmod is a no-op.
#
# Why scripts/test/ship-check.sh (and not e.g. scripts/setup.sh)? Because
# the check's allowlist (see run_check_exec_bits in ship-check.sh)
# includes ship-check.sh itself by design — that's the file the original
# WARP-487 bug shipped on, so the regression should specifically guard
# THAT path. Mutating its index mode does NOT affect `bash <path>`
# invocation, so the test driver keeps working even mid-mutation.
test_exec_bits_catches_chmod_stripped() {
  local target_rel="scripts/test/ship-check.sh"
  local target="$REPO_ROOT_REAL/$target_rel"

  if [ ! -f "$target" ]; then
    printf "    target file missing: %s\n" "$target" >&2
    return 1
  fi

  # Index-mode dirty check: `git diff --cached --quiet` detects a staged
  # mode-only change even when the worktree file is byte-identical.
  # `git diff --quiet` (no --cached) does NOT catch a pure mode-only
  # difference on Windows hosts where the filesystem bit is unreliable.
  if ! (cd "$REPO_ROOT_REAL" && git diff --cached --quiet -- "$target_rel" 2>/dev/null); then
    printf "    %s already staged — refusing to mutate\n" "$target_rel" >&2
    return 1
  fi

  # shellcheck disable=SC2064  # capture path values at trap-set time
  trap "(cd '$REPO_ROOT_REAL' && git update-index --chmod=+x '$target_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: passes on the unmutated tree (100755 from commit 1 of WARP-487).
  if ! _assert_check_passes "$REPO_ROOT_REAL" exec-bits; then
    printf "    baseline exec-bits failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Apply regression: strip +x from the tracked script via the git
  #    index. Working-tree mode is left alone — the bug is index-side.
  if ! (cd "$REPO_ROOT_REAL" && git update-index --chmod=-x "$target_rel"); then
    printf "    git update-index --chmod=-x failed for %s\n" "$target_rel" >&2
    return 1
  fi

  # Confirm the mutation took. `--cached` is required (see dirty-check
  # comment above).
  if (cd "$REPO_ROOT_REAL" && git diff --cached --quiet -- "$target_rel" 2>/dev/null); then
    printf "    regression mutation no-op — index mode unchanged\n" >&2
    return 1
  fi

  # 3. exec-bits should now FAIL.
  _assert_check_fails "$REPO_ROOT_REAL" exec-bits
}

# =============================================================================
# Test: exec-bits catches a chmod-stripped tracked script in openwrt/scripts/
# =============================================================================
#
# Bug class extension (WARP-489): WARP-487's regression test proved the
# exec-bits check detects a stripped +x on `scripts/test/ship-check.sh` —
# the FIRST entry in the allowlist. The allowlist is PATH-keyed (full
# repo-relative path, not basename), and WARP-489 added a sibling sub-
# tree entry (`openwrt/scripts/upgrade-router.sh`) to prove the check
# scales beyond the top-level `scripts/` directory.
#
# This second test is explicit cross-subtree coverage: it specifically
# strips +x from the `openwrt/scripts/` entry and asserts the check
# fails. Without it, a future refactor that accidentally normalized
# allowlist entries to basenames (or that broke the loop's REPO_ROOT
# join) would still pass the WARP-487 test (which mutates a top-level
# entry) while silently letting the openwrt sub-tree drift back to
# 100644.
#
# Synthetic regression: identical mechanism to the WARP-487 test —
# `git update-index --chmod=-x <openwrt/scripts/upgrade-router.sh>`,
# assert the check fails, restore via `--chmod=+x` on RETURN. The
# script is OPERATOR-FACING (its --help documents `./scripts/upgrade-
# router.sh <firmware-image>` as the canonical invocation), so the
# canonical-invocation rationale from WARP-487 applies one-for-one.
test_exec_bits_catches_chmod_stripped_openwrt() {
  local target_rel="openwrt/scripts/upgrade-router.sh"
  local target="$REPO_ROOT_REAL/$target_rel"

  if [ ! -f "$target" ]; then
    printf "    target file missing: %s\n" "$target" >&2
    return 1
  fi

  # Same index-mode dirty check as the WARP-487 test. `--cached` is
  # mandatory; `git diff --quiet` alone misses pure-mode changes on
  # Windows hosts where the working-tree bit is unreliable.
  if ! (cd "$REPO_ROOT_REAL" && git diff --cached --quiet -- "$target_rel" 2>/dev/null); then
    printf "    %s already staged — refusing to mutate\n" "$target_rel" >&2
    return 1
  fi

  # shellcheck disable=SC2064  # capture path values at trap-set time
  trap "(cd '$REPO_ROOT_REAL' && git update-index --chmod=+x '$target_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: passes on the unmutated tree (100755 from commit 1 of WARP-489).
  if ! _assert_check_passes "$REPO_ROOT_REAL" exec-bits; then
    printf "    baseline exec-bits failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Apply regression: strip +x from the openwrt entry via the git
  #    index. The mutation is index-side only — the working-tree file
  #    is untouched.
  if ! (cd "$REPO_ROOT_REAL" && git update-index --chmod=-x "$target_rel"); then
    printf "    git update-index --chmod=-x failed for %s\n" "$target_rel" >&2
    return 1
  fi

  if (cd "$REPO_ROOT_REAL" && git diff --cached --quiet -- "$target_rel" 2>/dev/null); then
    printf "    regression mutation no-op — index mode unchanged\n" >&2
    return 1
  fi

  # 3. exec-bits should now FAIL — proves the path-keyed allowlist sees
  #    the openwrt sub-tree, not just top-level scripts/.
  _assert_check_fails "$REPO_ROOT_REAL" exec-bits
}

# =============================================================================
# Driver
# =============================================================================
printf "\n  ${_BOLD}Ship-check regression test suite${_RESET}\n"
printf "  Real repo: %s\n" "$REPO_ROOT_REAL"
printf "  ──────────────────────────────────\n"

_run_test "tsc-full catches WARP-329 fixture regression" \
  test_tsc_full_catches_fixture_regression

_run_test "compose-config catches YAML breakage in docker-compose.yml" \
  test_compose_config_catches_yaml_breakage

_run_test "frigate-env-scan catches unresolved {VAR} substitution" \
  test_frigate_env_scan_catches_unresolved_substitution

_run_test "shellcheck catches local-outside-function in scripts/lib" \
  test_shellcheck_catches_local_outside_function

_run_test "docker-build-smoke shim rejects unknown docker subcommand" \
  test_docker_build_smoke_shim_rejects_unknown_subcommand

_run_test "exec-bits catches chmod-stripped tracked script" \
  test_exec_bits_catches_chmod_stripped

_run_test "exec-bits catches chmod-stripped tracked script in openwrt/scripts/" \
  test_exec_bits_catches_chmod_stripped_openwrt

printf "\n  ──────────────────────────────────\n"
printf "  Results: %d/%d passed" "$PASSED" "$TOTAL"
if [ "$FAILED" -gt 0 ]; then
  printf "  ${_RED}(%d failed)${_RESET}" "$FAILED"
fi
printf "\n"
if [ "$FAILED" -gt 0 ]; then
  printf "  Failed:\n"
  for n in "${FAILED_NAMES[@]}"; do
    printf "    - %s\n" "$n"
  done
fi
printf "  ──────────────────────────────────\n\n"

exit "$FAILED"
