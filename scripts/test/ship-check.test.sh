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

# --- Isolated git index (WARP-2479) ------------------------------------------
#
# The `exec-bits` tests mutate a REAL tracked file's index mode with
# `git update-index --chmod=…`. That command does not edit a mode bit in
# place: it rewrites the whole index entry from the CURRENT WORKING-TREE
# CONTENT. So if the caller has an unstaged edit to the target file, the
# mutation silently STAGES that edit, and the `--chmod=+x` restore only puts
# the mode back — the staged content stays. Measured on 2026-08-28:
#
#   $ printf '…\n' >> scripts/test/ship-check.sh   # unstaged edit
#   $ git diff --cached --quiet -- scripts/test/ship-check.sh; echo $?
#   0                                              # dirty-guard below says OK
#   $ bash scripts/test/ship-check.test.sh         # 14/15
#   $ git diff --cached --stat
#    scripts/test/ship-check.sh | 2 ++             # staged by nobody
#
# Two consequences, both bad. The next run trips the "already staged —
# refusing to mutate" guard and reports a spurious red (measured: 13/15,
# `exec-bits catches chmod-stripped tracked script`). And any `git commit -a`
# afterwards commits a half-finished edit the author never staged — which is
# exactly the situation an agent editing ship-check.sh is in when it runs the
# harness. The dirty-guard cannot catch this: it compares INDEX to HEAD, and
# an unstaged edit leaves those identical.
#
# Fix: point every git command in the test — and the ship-check.sh child it
# spawns, which reads the index via `git ls-files --stage` — at a THROWAWAY
# COPY of the index via GIT_INDEX_FILE. The caller's index is then never
# opened for writing, so there is nothing to restore and nothing to leak.
# `git worktree add` would also work but checks out the whole monorepo; a
# 100 KB index copy is the cheap equivalent. `git stash` is not an option —
# the stash stack is shared across every worktree of this repo.
_ISOLATED_INDEX_FILE=""

# Redirect git to a disposable copy of the caller's index. Returns non-zero
# (without exporting anything) if the copy could not be made, so a caller
# that checks the return value never proceeds to mutate the real index.
_isolated_index_begin() {
  local real_index
  # --git-path resolves the per-worktree index for LINKED worktrees
  # (.git/worktrees/<name>/index), not just .git/index.
  real_index="$(cd "$REPO_ROOT_REAL" && git rev-parse --git-path index 2>/dev/null)" || return 1
  [ -n "$real_index" ] || return 1
  case "$real_index" in
    /*) ;;
    *) real_index="$REPO_ROOT_REAL/$real_index" ;;
  esac
  [ -f "$real_index" ] || return 1

  _ISOLATED_INDEX_FILE="$(mktemp "${TMPDIR:-/tmp}/ship-check-index.XXXXXX")" || return 1
  cp "$real_index" "$_ISOLATED_INDEX_FILE" || return 1
  export GIT_INDEX_FILE="$_ISOLATED_INDEX_FILE"
  return 0
}

# Drop the disposable index and put git back on the caller's. Safe to call
# when _isolated_index_begin was never run or failed.
_isolated_index_end() {
  unset GIT_INDEX_FILE
  if [ -n "$_ISOLATED_INDEX_FILE" ]; then
    rm -f "$_ISOLATED_INDEX_FILE"
    _ISOLATED_INDEX_FILE=""
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

  # 1. Sanity: passes on the unmutated tree (since WARP-235 the live config
  #    has NO {VAR} substitutions — MQTT auth is the client cert, with static
  #    tls_* paths — so the baseline hits the no-substitution PASS branch).
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
# Test: shellcheck catches new SC2034 violation in scripts/lib (WARP-486)
# =============================================================================
#
# Bug class this guards (WARP-486 → ADR-style): before WARP-486, the shellcheck
# ship-check ran with a global `--exclude=SC2034,SC2024,SC2155`
# blanket. That muted the pre-existing baseline (load-bearing-but-unused
# vars in device-identity.sh / docker.sh / preflight.sh, sudo+redirect in
# local-dns.sh, declare+assign in secrets.sh / camera-drivers.sh), but it
# ALSO masked any NEW violation of those three codes that appeared in lib
# code after the original waiver. A new dead `local foo=$(bar)` could ship
# to main with no signal.
#
# The WARP-486 fix moves every existing waiver to a per-line
# `# shellcheck disable=SCxxxx` directive with rationale, and DROPS the
# global excludes. After the fix, any NEW SC2034 / SC2024 / SC2155 hit in
# lib/* surfaces immediately.
#
# Synthetic regression: inject an SC2034 ("unused variable") violation
# into scripts/lib/local-dns.sh — a fresh top-level `WARP_486_TEST_UNUSED="x"`
# line (all-caps; the inline comment in the test body explains why a
# leading underscore would NOT trigger SC2034). With the global SC2034
# exclude in place the check would (incorrectly) PASS; once the exclude
# is removed the check correctly FAILS. Restore via `git checkout --`
# on RETURN.
#
# Note on test target: we deliberately re-use scripts/lib/local-dns.sh
# (already exercised by test_shellcheck_catches_local_outside_function).
# These two tests run sequentially against the same file and rely on the
# per-test RETURN trap (`git checkout -- "$target_rel"`) to restore
# scripts/lib/local-dns.sh between runs. If the first test's trap fails
# to fire (signal interrupt, git lock contention, etc.) the second
# test's `refusing to mutate` guard will trip and the test will fail
# loudly rather than silently re-mutate a dirty file — but the coupling
# is real. Future SC2024 / SC2155 regression tests SHOULD target a
# distinct file in scripts/lib/ to avoid this dependency entirely.
test_shellcheck_catches_new_sc2034_violation() {
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

  # shellcheck disable=SC2064  # capture path values at trap-set time
  trap "(cd '$REPO_ROOT_REAL' && git checkout -- '$target_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: passes on the unmutated tree.
  if ! _assert_check_passes "$REPO_ROOT_REAL" shellcheck; then
    printf "    baseline shellcheck failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Apply regression: prepend an unused top-level variable after the
  #    shebang. SC2034 ("X appears unused. Verify use (or export if used
  #    externally)") fires at warning severity. With WARP-486's per-file
  #    convention in place (no global SC2034 exclude), this MUST surface.
  #
  # Important: shellcheck silently exempts variable names starting with
  # `_` from SC2034 (the underscore-prefix-means-intentional-unused
  # convention). Use a non-underscore name so the diagnostic actually
  # fires. `WARP_486_TEST_UNUSED` mirrors the all-caps style of the
  # pre-existing waiver sites (DOCKER_GROUP_ADDED, SKIP_DOCKER_INSTALL)
  # without colliding with any real variable name in the lib tree.
  awk '
    NR == 1 { print; print "WARP_486_TEST_UNUSED=\"x\""; next }
    { print }
  ' "$target" > "$target.tmp" && mv "$target.tmp" "$target"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$target_rel" 2>/dev/null); then
    printf "    regression mutation no-op — file unchanged\n" >&2
    return 1
  fi

  # 3. shellcheck should now FAIL because the global SC2034 exclude is gone.
  _assert_check_fails "$REPO_ROOT_REAL" shellcheck
}

# =============================================================================
# Test: shellcheck lints the gate itself, and a directive-shaped prose
#       comment is caught rather than silently truncating the lint (WARP-2477)
# =============================================================================
#
# Bug class this guards (WARP-2477). ShellCheck treats ANY comment whose
# first word is the bare token `shellcheck` as a DIRECTIVE. Prose that merely
# begins with the tool's name — `#   shellcheck  — local-dns.sh class: …` —
# therefore parses as a malformed directive and raises SC1073/SC1072. Both
# are `error` severity, so `--severity=warning` cannot suppress them, and
# both are PARSE errors, so ShellCheck stops there and lints NOTHING after
# that line.
#
# `scripts/test/ship-check.sh` carried exactly that at line 29, and a second
# instance further down. Measured at the branch point (907e40ca): planting a
# violation at line 1000 and running ShellCheck reported only the line-29
# parse error — the plant was never seen. After rewording, the same plant is
# reported at line 1000. So ~28 of 1,900 lines were being linted, and the
# file looked clean because nothing was reading it.
#
# It went unnoticed because run_check_shellcheck did not lint the gate or its
# harness at all — the one pair of shell files in the repo that the gate
# never pointed at itself. WARP-2477 added both to the target list, which is
# what makes this test possible: the mutation below is planted in
# ship-check.sh itself.
#
# Synthetic regression: insert a directive-shaped prose comment into
# scripts/test/ship-check.sh and assert the shellcheck check goes red. The
# comment is inert to bash — it is a comment — so ship-check.sh stays
# executable throughout and the test driver keeps working mid-mutation.
# Restore via `git checkout --` on RETURN.
#
# Mutation that turns this test red: revert the line-29 rewording (drop the
# backticks around `shellcheck`). Then the baseline assertion in step 1
# fails, because the gate is red before this test plants anything.
test_shellcheck_lints_the_gate_and_catches_directive_shaped_comment() {
  if ! command -v shellcheck >/dev/null 2>&1; then
    printf "    ${_YELLOW}SKIP${_RESET}  shellcheck not on PATH — install via apt/brew\n"
    return 0
  fi

  local target_rel="scripts/test/ship-check.sh"
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

  # 1. Sanity: the gate passes on the unmutated tree. This is the assertion
  #    that goes red if either directive-shaped comment is ever reintroduced.
  if ! _assert_check_passes "$REPO_ROOT_REAL" shellcheck; then
    printf "    baseline shellcheck failed against unmodified real repo —\n" >&2
    printf "    a directive-shaped comment may have been reintroduced\n" >&2
    return 1
  fi

  # 2. Apply regression: a prose comment opening with the bare token
  #    `shellcheck`, inserted after the shebang — SC1073/SC1072, error
  #    severity. Verified that all three spacings ('#shellcheck …',
  #    '# shellcheck …', '#   shellcheck …') trigger it, so the leading
  #    whitespace here is not load-bearing.
  awk -v bad='# shellcheck is a static analysis tool for shell scripts' '
    NR == 1 { print; print bad; next }
    { print }
  ' "$target" > "$target.tmp" && mv "$target.tmp" "$target"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$target_rel" 2>/dev/null); then
    printf "    regression mutation no-op — file unchanged\n" >&2
    return 1
  fi

  # 3. shellcheck should now FAIL — proving both that the gate lints itself
  #    and that a directive-shaped comment is a hard error, not a silent
  #    truncation of the lint.
  _assert_check_fails "$REPO_ROOT_REAL" shellcheck
}

# =============================================================================
# Test: the shellcheck check REPORTS its findings, not just a non-zero exit
# =============================================================================
#
# Bug class this guards (WARP-2492). `ship-check.sh` runs `set -euo pipefail`.
# `run_check_shellcheck` captured findings with a BARE assignment:
#
#     out="$(shellcheck … )"
#     rc=$?
#
# ShellCheck exits non-zero exactly when it has something to report, so under
# `set -e` that assignment killed the script AT THAT LINE — before the FAIL
# banner and before the captured findings were printed. The operator got exit
# 1 and a bare header, and never learned which file or which code. Measured on
# the parent commit with a directive-shaped comment planted in scripts/lib:
# stdout was three lines of header, stderr empty, rc 1; `bash -x` showed
# execution stopping immediately after `out='…'` with the SC1073/SC1072 text
# captured and never emitted.
#
# Especially bad after WARP-2477, which made the gate lint itself and its own
# harness: a lint that now reads 3.3k more lines of bash would have reported
# nothing it found.
#
# The fix is the `&& rc=0 || rc=$?` tail — an AND-OR list is exempt from
# `set -e` — which is the shape the image-pipeline check already used.
#
# This case asserts the TWO PROPERTIES SEPARATELY, because the bug moved only
# one of them: the exit code was always correct, it was the OUTPUT that
# vanished. A test that only checked `rc != 0` (as _assert_check_fails does)
# passed happily throughout the entire defect — which is why neither of the
# two existing shellcheck cases ever caught it.
#
#   1. non-zero exit          — was ALREADY true before the fix
#   2. finding text on stdout — was FALSE before the fix
#
# Mutation: restore the bare capture. Assertion 2 goes red while assertion 1
# stays green.
#
# The plant is a throwaway file in scripts/lib/ (which the check globs), never
# git-added, removed on RETURN — and the whole case runs under the disposable
# index from WARP-2479, so nothing it does can reach the caller's real index.
test_shellcheck_reports_findings_not_just_exit_code() {
  if ! command -v shellcheck >/dev/null 2>&1; then
    printf "    ${_YELLOW}SKIP${_RESET}  shellcheck not on PATH — install via apt/brew\n"
    return 0
  fi

  local plant_rel="scripts/lib/zzz-warp-2492-fixture.sh"
  local plant="$REPO_ROOT_REAL/$plant_rel"

  if [ -e "$plant" ]; then
    printf "    fixture path already exists: %s\n" "$plant_rel" >&2
    return 1
  fi

  if ! _isolated_index_begin; then
    printf "    could not create an isolated git index — refusing to proceed\n" >&2
    return 1
  fi
  # shellcheck disable=SC2064  # capture the path value at trap-set time
  trap "rm -f '$plant'; _isolated_index_end" RETURN EXIT

  # 1. Sanity: the gate is green before we plant anything.
  if ! _assert_check_passes "$REPO_ROOT_REAL" shellcheck; then
    printf "    baseline shellcheck failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Plant a file the scripts/lib/*.sh glob picks up, carrying a comment
  #    whose first word is the bare token `shellcheck` — SC1073/SC1072, error
  #    severity. Assembled at runtime so this harness file does not itself
  #    contain a directive-shaped comment.
  {
    printf '#!/bin/bash\n'
    printf '# %s is a static analysis tool for shell scripts\n' "shellcheck"
    printf 'echo warp-2492-fixture\n'
  } > "$plant"

  if [ ! -s "$plant" ]; then
    printf "    fixture plant no-op — %s is empty or missing\n" "$plant_rel" >&2
    return 1
  fi

  local output rc
  output="$(REPO_ROOT="$REPO_ROOT_REAL" bash "$SHIP_CHECK" shellcheck 2>&1)" && rc=0 || rc=$?

  # ASSERTION 1 — non-zero exit. True both before and after the fix.
  if [ "$rc" -eq 0 ]; then
    printf "    expected non-zero exit from the shellcheck check, got 0\n" >&2
    printf '%s\n' "$output" | sed 's/^/    | /' >&2
    return 1
  fi

  # ASSERTION 2 — the findings actually reach the operator. This is the one
  # the bare capture broke: the check died before printing anything.
  if ! printf '%s' "$output" | grep -q 'SC1073'; then
    printf "    the check exited %d but never reported its findings —\n" "$rc" >&2
    printf "    no SC1073 in the output. A capture under 'set -e' is\n" >&2
    printf "    swallowing the reporting path (WARP-2492).\n" >&2
    printf "    captured output was:\n" >&2
    printf '%s\n' "$output" | sed 's/^/    | /' >&2
    return 1
  fi

  # And the FAIL banner itself, so a bare stack trace cannot satisfy the above.
  if ! printf '%s' "$output" | grep -q 'FAIL.*shellcheck'; then
    printf "    findings present but the FAIL banner is missing from the output\n" >&2
    printf '%s\n' "$output" | sed 's/^/    | /' >&2
    return 1
  fi

  return 0
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
# The mutation lands on a DISPOSABLE COPY of the index (GIT_INDEX_FILE,
# see _isolated_index_begin) which is deleted on RETURN, so there is no
# restore step and the caller's index is never written (WARP-2479). The
# index — not the filesystem bit — is the canonical signal, so this works
# on Windows where chmod is a no-op.
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

  # Every git command below — and the ship-check.sh child, which reads the
  # index through `git ls-files --stage` — now writes to a disposable copy.
  # The caller's index is never opened for writing (WARP-2479).
  if ! _isolated_index_begin; then
    printf "    could not create an isolated git index — refusing to mutate the real one\n" >&2
    return 1
  fi
  trap '_isolated_index_end' RETURN EXIT

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
# `git update-index --chmod=-x <openwrt/scripts/upgrade-router.sh>` on a
# disposable index copy, assert the check fails, drop the copy on RETURN. The
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

  # Same disposable-index isolation as the WARP-487 test (WARP-2479).
  if ! _isolated_index_begin; then
    printf "    could not create an isolated git index — refusing to mutate the real one\n" >&2
    return 1
  fi
  trap '_isolated_index_end' RETURN EXIT

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
# Test: tsc-full uses orchestrator's workspace-pinned prisma binary (WARP-492)
# =============================================================================
#
# Bug class this guards (WARP-492): before WARP-492, `run_check_tsc_full`
# invoked `npx prisma generate` directly inside apps/orchestrator. `npx`
# without `--no-install` (and without a resolvable local `node_modules/
# .bin/prisma`) silently fetches the LATEST published prisma off the npm
# registry — at the time of the bug, that was 7.8.0. The orchestrator's
# `prisma/schema.prisma` is authored for the workspace's pinned `^5.14.0`;
# Prisma 7 rejects the schema with `P1012` ("datasource property `url`
# is no longer supported"), so ship-check tsc-full fails on a fresh
# worktree even though `npm install` + Docker build would succeed.
#
# The WARP-492 fix pins phase 1 to the orchestrator's `db:generate`
# script: `npm run -w @droplet/orchestrator db:generate`. The script's
# command (`prisma generate`) runs via npm-injected PATH which resolves
# to `node_modules/.bin/prisma` — the workspace's pinned binary — so the
# npm registry is never consulted.
#
# Synthetic regression: remove the `db:generate` script line from
# apps/orchestrator/package.json. With the fix in place, the workspace
# no longer exposes the script, `npm run -w` returns "Missing script:
# db:generate", and tsc-full fails. With the pre-WARP-492 code
# (`npx prisma generate`), removing `db:generate` has zero effect — the
# check passes (or hits a different unrelated failure mode). Therefore
# this test specifically proves the implementation routes through the
# workspace's pinned script.
#
# Pre-condition: this test requires `node_modules` to be installed in
# the real REPO_ROOT — otherwise BOTH the pre-WARP-492 code (which
# would fetch 7.x off the registry) AND the WARP-492 fix (which would
# fail "prisma not recognized") fail, so the mutation can't distinguish
# them. On hosts without node_modules the test SKIPs gracefully.
test_tsc_full_uses_workspace_pinned_prisma() {
  if [ ! -d "$REPO_ROOT_REAL/node_modules" ]; then
    printf "    ${_YELLOW}SKIP${_RESET}  REPO_ROOT_REAL has no node_modules — install first\n"
    return 0
  fi

  local pkg_rel="apps/orchestrator/package.json"
  local pkg="$REPO_ROOT_REAL/$pkg_rel"

  if [ ! -f "$pkg" ]; then
    printf "    package.json missing: %s\n" "$pkg" >&2
    return 1
  fi
  if ! (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$pkg_rel" 2>/dev/null); then
    printf "    %s already dirty — refusing to mutate\n" "$pkg_rel" >&2
    return 1
  fi

  # shellcheck disable=SC2064  # capture path values at trap-set time
  trap "(cd '$REPO_ROOT_REAL' && git checkout -- '$pkg_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: tsc-full PASSES on the unmutated tree.
  if ! _assert_check_passes "$REPO_ROOT_REAL" tsc-full; then
    printf "    baseline tsc-full failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Apply regression — drop the `"db:generate": "prisma generate",` line.
  #    The WARP-492 fix calls this script by name; with the script removed,
  #    `npm run -w @droplet/orchestrator db:generate` exits non-zero ("Missing
  #    script") and phase 1 of run_check_tsc_full fails. The pre-WARP-492
  #    code (`npx prisma generate`) ignores apps/orchestrator's package.json
  #    scripts entirely, so removing the line is a no-op against the old
  #    implementation — which is what makes this mutation a discriminating
  #    test for the fix.
  awk '!/^    "db:generate": "prisma generate",$/' \
       "$pkg" > "$pkg.tmp" && mv "$pkg.tmp" "$pkg"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$pkg_rel" 2>/dev/null); then
    printf "    regression mutation no-op — file unchanged\n" >&2
    return 1
  fi

  # 3. tsc-full should now FAIL.
  _assert_check_fails "$REPO_ROOT_REAL" tsc-full
}

# =============================================================================
# Test: stale-repo-names catches a re-introduced legacy repo name (WARP-494)
# =============================================================================
#
# Bug class this guards (WARP-494): user-facing surfaces (README, service
# READMEs, TESTING.md files, code comments, top-level scripts/*.sh) keep
# accumulating references to the LEGACY GitHub repo names
# `inference-engine` and `droplet-jetson-ai` — both renamed to
# `droplet-local-LLM` on the canonical remote. The redirects still work,
# but every stale ref drifts the documentation away from the canonical
# name we put on a customer-facing doc surface, so a code-comment audit
# eventually has to swing through and clean them up. WARP-494 makes that
# a static check that fails the gate on re-introduction.
#
# Note: this check covers the LEGACY sibling-repo names only
# (`inference-engine`, `droplet-jetson-ai`). The compose project is now
# `droplet` and this repo is `droplet-onboard-services`; container names
# are `droplet-*` (WARP-605). No hardware-specific project/container
# identifiers remain in the covered surfaces.
#
# Synthetic regression: inject `inference-engine` into README.md (a
# covered surface that the unmutated tree has already been swept clean
# of), assert the stale-repo-names check FAILS, restore via
# `git checkout --` on RETURN. The injection point is the architecture-
# note line which already mentions related repos, so the regression
# reads like the real bug class (a developer adding a "see related
# repo" reference and reaching for the old name out of habit).
test_stale_repo_names_catches_inference_engine_reintro() {
  local readme_rel="README.md"
  local readme="$REPO_ROOT_REAL/$readme_rel"

  if [ ! -f "$readme" ]; then
    printf "    README missing: %s\n" "$readme" >&2
    return 1
  fi
  if ! (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$readme_rel" 2>/dev/null); then
    printf "    %s already dirty — refusing to mutate\n" "$readme_rel" >&2
    return 1
  fi

  # shellcheck disable=SC2064  # capture path values at trap-set time
  trap "(cd '$REPO_ROOT_REAL' && git checkout -- '$readme_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: passes on the unmutated tree (commit 3 of WARP-494 sweeps
  #    the 9 active-bug refs out of README + the rest of the covered
  #    surfaces). If this baseline fails, the sweep regressed.
  if ! _assert_check_passes "$REPO_ROOT_REAL" stale-repo-names; then
    printf "    baseline stale-repo-names failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Apply regression: append a fresh `inference-engine` reference at
  #    the bottom of README. Newline-prefixed so we don't fuse with the
  #    trailing line.
  printf '\n<!-- WARP-494 test mutation: do not commit. inference-engine -->\n' >> "$readme"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$readme_rel" 2>/dev/null); then
    printf "    regression mutation no-op — README unchanged\n" >&2
    return 1
  fi

  # 3. stale-repo-names should now FAIL — the surface walk + grep should
  #    catch the injected `inference-engine` token against the allowlist.
  _assert_check_fails "$REPO_ROOT_REAL" stale-repo-names
}

# =============================================================================
# Test: lifecycle-naming catches a NEW poc-style token in a user-facing
# surface (ADR-018 action item 8, architecture-guard rule 17)
# =============================================================================
#
# Bug class this guards (ADR-018 §13 / architecture-guard rule 17): every
# Droplet box is the shipping product, so user-facing surfaces — compose
# profile names, env-var names, CLI flags, service/file names, log strings —
# must be named by what the deployment IS, not by its lifecycle stage. A new
# `profiles: ["poc"]`, `COMPOSE_PROFILES=poc`, `setup.sh --poc`, or a
# `droplet-poc-*` service that ships to a customer is the exact drift rule 17
# exists to stop. One legacy identifier legitimately remains in the tree: the
# WARP-445 on-box migration cleanup (scripts/lib/single-box.sh) must name the
# pre-rename `droplet-poc-host-net` unit/files to remove them from boxes
# provisioned before the rename. The lifecycle-naming check grandfathers that
# explicit token and FAILS only on NEW occurrences.
#
# This is the repo-wide net for rule 17: lifecycle-naming scans
# docker-compose.yml + .env.example + top-level scripts/*.sh + scripts/lib/*.sh.
#
# Synthetic regression: inject a NEW `profiles: ["poc"]` line into
# docker/docker-compose.yml (a covered surface) — the precise AC demonstration
# from the ticket: a new poc-named compose profile. The injected line is NOT
# in the grandfather allowlist, so lifecycle-naming must FAIL. Restore via
# `git checkout --` on RETURN.
test_lifecycle_naming_catches_new_poc_token() {
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

  # shellcheck disable=SC2064  # capture path values at trap-set time
  trap "(cd '$REPO_ROOT_REAL' && git checkout -- '$compose_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: lifecycle-naming PASSES on the unmutated tree (the WARP-445
  #    migration-cleanup references in scripts/lib/single-box.sh are
  #    grandfathered).
  if ! _assert_check_passes "$REPO_ROOT_REAL" lifecycle-naming; then
    printf "    baseline lifecycle-naming failed against unmodified real repo\n" >&2
    printf "    (the grandfather allowlist is out of sync with the tree — update it)\n" >&2
    return 1
  fi

  # 2. Apply regression: append a NEW poc-named compose profile at EOF. This
  #    is the exact lifecycle-stage leak rule 17 forbids — `profiles: ["poc"]`
  #    instead of `profiles: ["single-box"]`. The line+token pair is not in
  #    the allowlist, so it is a NEW occurrence.
  printf '\n# ADR-018 test mutation: do not commit.\n  profiles: ["poc"]\n' >> "$compose"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$compose_rel" 2>/dev/null); then
    printf "    regression mutation no-op — compose file unchanged\n" >&2
    return 1
  fi

  # 3. lifecycle-naming should now FAIL — the new poc token is beyond the
  #    grandfather allowlist.
  _assert_check_fails "$REPO_ROOT_REAL" lifecycle-naming
}

# =============================================================================
# Test: lifecycle-naming catches STRUCTURAL dev/test framing, and still
#       honours the Tier 1 grandfather (WARP-2478)
# =============================================================================
#
# The test above covers the primary token class (`poc` / `prototype`). The
# check has a SECOND, independent scan for structural lifecycle framing —
# `profiles: ["dev"]`, `COMPOSE_PROFILES=test`, `--some-flag-dev` — which had
# no regression coverage at all. WARP-2478 rewrote both scans from a per-file
# `while read < <(grep …)` loop (the shape that SIGTRAPs bash 3.2 at scale,
# see WARP-2456) into single multi-file passes, and in doing so folded the
# structural scan's TWO greps into one ERE alternation. An error in that
# union would silently drop a whole violation class while every existing
# test stayed green — so this test pins it.
#
# It is two-sided in both directions that matter:
#   * a grandfathered legacy identifier alone must still PASS (proving the
#     Tier 1 strip-then-rescan survived the rewrite of the parse), and
#   * a structural dev-profile entry must FAIL.
#
# Mutations that turn this red:
#   * drop the `profiles:…"(dev|test|prototype)"` half of the structural
#     alternation  -> step 3 goes green.
#   * drop the grandfathered_tokens strip -> step 2 goes red.
test_lifecycle_naming_structural_and_grandfather() {
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

  # shellcheck disable=SC2064  # capture path values at trap-set time
  trap "(cd '$REPO_ROOT_REAL' && git checkout -- '$compose_rel') 2>/dev/null || true" RETURN EXIT

  # 1. Sanity: passes on the unmutated tree.
  if ! _assert_check_passes "$REPO_ROOT_REAL" lifecycle-naming; then
    printf "    baseline lifecycle-naming failed against unmodified real repo\n" >&2
    return 1
  fi

  # 2. Grandfather side: a line whose ONLY lifecycle token is the legacy
  #    host-net identifier must still pass. Tier 1 strips the known token and
  #    re-scans the residual; `droplet--host-net` carries no lifecycle token,
  #    so there is nothing left to flag.
  printf '\n# WARP-2478 test mutation: do not commit. droplet-poc-host-net\n' >> "$compose"

  if (cd "$REPO_ROOT_REAL" && git diff --quiet -- "$compose_rel" 2>/dev/null); then
    printf "    grandfather mutation no-op — compose file unchanged\n" >&2
    return 1
  fi

  if ! _assert_check_passes "$REPO_ROOT_REAL" lifecycle-naming; then
    printf "    grandfathered droplet-poc-host-net was flagged as a violation —\n" >&2
    printf "    the Tier 1 strip-then-rescan is not working\n" >&2
    return 1
  fi

  # 3. Structural side: a dev-named compose profile. Not a `poc`/`prototype`
  #    token at all, so ONLY the structural scan can catch it.
  printf '  profiles: ["dev"]\n' >> "$compose"

  _assert_check_fails "$REPO_ROOT_REAL" lifecycle-naming
}

# =============================================================================
# Test: image-pipeline catches a stubbed scripts/build-image.sh (WARP-663)
# =============================================================================
#
# Bug class this guards (WARP-663 / ADR-020): the appliance image pipeline
# ships as a versioned, signed artifact (`droplet-image build|manifest|sign|
# verify|...`). The single most likely regression is `scripts/build-image.sh`
# silently reverting to (or never leaving) its historical five-line stub
# (`echo "TODO: Implement Pi image build (pi-gen)"`) — which would make
# `droplet-image build` a no-op that produces no ISO while every other check
# stays green. The `image-pipeline` check fails when build-image.sh is a stub,
# so this regression proves it.
#
# Synthetic-worktree pattern (not in-place): the `image-pipeline` check reads a
# small, fixed set of files (scripts/build-image.sh, scripts/droplet-image,
# scripts/image/*, scripts/lib/image.sh). We copy exactly those into a mktemp
# worktree, plus a `.git` marker so ship-check's git-repo precondition holds,
# then (1) assert the check PASSES on the faithfully-copied tree and (2) clobber
# build-image.sh with the legacy stub and assert it FAILS. No real-tree mutation,
# so a SIGKILL mid-test can't leave the repo dirty.
test_image_pipeline_catches_stubbed_build_image() {
  if ! command -v shellcheck >/dev/null 2>&1; then
    printf "    ${_YELLOW}SKIP${_RESET}  shellcheck not on PATH — install via apt/brew\n"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    printf "    ${_YELLOW}SKIP${_RESET}  python3 not on PATH — required for manifest schema validation\n"
    return 0
  fi

  # Required source files must exist in the real tree (they land across the
  # WARP-663 GREEN steps). If any is missing this test fails loudly rather
  # than skipping — the check cannot be exercised without them.
  local needed=(
    "scripts/build-image.sh"
    "scripts/droplet-image"
    "scripts/lib/image.sh"
    "scripts/image/manifest.schema.json"
    "scripts/image/manifest.json"
    "scripts/image/gen-manifest.py"
    "scripts/image/build-iso.sh"
  )
  local rel
  for rel in "${needed[@]}"; do
    if [ ! -f "$REPO_ROOT_REAL/$rel" ]; then
      printf "    required file missing from tree: %s\n" "$rel" >&2
      return 1
    fi
  done

  local synth
  synth="$(mktemp -d)"
  # shellcheck disable=SC2064  # capture $synth at trap-set time
  trap "rm -rf '$synth'" RETURN

  # ship-check's main() requires a .git marker (dir or file) at REPO_ROOT.
  mkdir -p "$synth/.git"

  # Copy exactly the surface the check inspects, preserving paths.
  mkdir -p "$synth/scripts/image"
  cp "$REPO_ROOT_REAL/scripts/build-image.sh"             "$synth/scripts/build-image.sh"
  cp "$REPO_ROOT_REAL/scripts/droplet-image"             "$synth/scripts/droplet-image"
  mkdir -p "$synth/scripts/lib"
  cp "$REPO_ROOT_REAL/scripts/lib/image.sh"              "$synth/scripts/lib/image.sh"
  cp "$REPO_ROOT_REAL/scripts/lib/logging.sh"            "$synth/scripts/lib/logging.sh"
  cp "$REPO_ROOT_REAL/scripts/image/manifest.schema.json" "$synth/scripts/image/manifest.schema.json"
  cp "$REPO_ROOT_REAL/scripts/image/manifest.json"        "$synth/scripts/image/manifest.json"
  cp "$REPO_ROOT_REAL/scripts/image/gen-manifest.py"      "$synth/scripts/image/gen-manifest.py"
  cp "$REPO_ROOT_REAL/scripts/image/build-iso.sh"         "$synth/scripts/image/build-iso.sh"

  # 1. Faithful copy → check PASSES.
  if ! _assert_check_passes "$synth" image-pipeline; then
    printf "    baseline image-pipeline failed against a faithful copy of the tree\n" >&2
    return 1
  fi

  # 2. Regression: clobber build-image.sh with the historical stub. The check
  #    must FAIL — a stub builder produces no ISO.
  cat > "$synth/scripts/build-image.sh" <<'STUB'
#!/usr/bin/env bash
# Builds the full Pi SD card image using pi-gen or similar tooling.
set -euo pipefail

echo "TODO: Implement Pi image build (pi-gen)"
STUB

  _assert_check_fails "$synth" image-pipeline
}

# =============================================================================
# Test: tls-invariants catches a factory-reset HQ-deregister regression
# (ADR-023 PR-3)
# =============================================================================
#
# Original bug: factory-reset.sh Phase 0b sent a BODYLESS `curl -X DELETE
# …/api/issuance/registration`, which the deployed HQ Worker 422s (it requires
# a signed TPM-PoP body), so HQ never unbound the device. The fix runs a signed
# HQ CLI while the stack is still up.
#
# WARP-980: the DEFAULT reset now RELEASES the HQ name (`tls-release` — the
# device stays registered + self-heals); --decommission does the full deregister
# (`tls-deregister`). BOTH CLIs must be wired.
#
# This test builds a synthetic worktree with the real secrets.sh + nginx.conf +
# factory-reset.sh, asserts the check PASSES, then applies regressions and
# asserts each FAILS:
#   (a) drop the DEFAULT `tls-release` wiring,
#   (a2) drop the `tls-deregister` (--decommission) wiring,
#   (b) re-introduce a bodyless curl to /api/issuance/registration.
test_tls_invariants_catches_deregister_regression() {
  local needed=(
    "scripts/lib/secrets.sh"
    "docker/nginx/nginx.conf"
    "scripts/factory-reset.sh"
    "scripts/lib/logging.sh"
  )
  local rel
  for rel in "${needed[@]}"; do
    if [ ! -f "$REPO_ROOT_REAL/$rel" ]; then
      printf "    required file missing from tree: %s\n" "$rel" >&2
      return 1
    fi
  done

  local synth
  synth="$(mktemp -d)"
  # shellcheck disable=SC2064  # capture $synth at trap-set time
  trap "rm -rf '$synth'" RETURN

  mkdir -p "$synth/.git"
  mkdir -p "$synth/scripts/lib" "$synth/docker/nginx"
  cp "$REPO_ROOT_REAL/scripts/lib/secrets.sh"   "$synth/scripts/lib/secrets.sh"
  cp "$REPO_ROOT_REAL/scripts/lib/logging.sh"   "$synth/scripts/lib/logging.sh"
  cp "$REPO_ROOT_REAL/docker/nginx/nginx.conf"  "$synth/docker/nginx/nginx.conf"
  cp "$REPO_ROOT_REAL/scripts/factory-reset.sh" "$synth/scripts/factory-reset.sh"

  # 1. Faithful copy → check PASSES.
  if ! _assert_check_passes "$synth" tls-invariants; then
    printf "    baseline tls-invariants failed against a faithful copy of the tree\n" >&2
    return 1
  fi

  # 2a. Regression: strip the DEFAULT tls-release wiring. The check must FAIL
  #     (factory-reset no longer releases the HQ name by default — the self-heal
  #     is gone).
  local stripped
  stripped="$(grep -v 'tls-release' "$synth/scripts/factory-reset.sh")"
  printf '%s\n' "$stripped" > "$synth/scripts/factory-reset.sh"
  if ! _assert_check_fails "$synth" tls-invariants; then
    printf "    expected tls-invariants to FAIL after dropping the tls-release CLI\n" >&2
    return 1
  fi

  # 2a2. Regression: strip the --decommission tls-deregister wiring. The check
  #      must FAIL (no way to fully retire a box).
  cp "$REPO_ROOT_REAL/scripts/factory-reset.sh" "$synth/scripts/factory-reset.sh"
  stripped="$(grep -v 'tls-deregister' "$synth/scripts/factory-reset.sh")"
  printf '%s\n' "$stripped" > "$synth/scripts/factory-reset.sh"
  if ! _assert_check_fails "$synth" tls-invariants; then
    printf "    expected tls-invariants to FAIL after dropping the tls-deregister CLI\n" >&2
    return 1
  fi

  # 2b. Regression: restore the CLI line AND re-introduce the bodyless curl to
  #     /api/issuance/registration (the original 422 bug). The check must FAIL.
  cp "$REPO_ROOT_REAL/scripts/factory-reset.sh" "$synth/scripts/factory-reset.sh"
  cat >> "$synth/scripts/factory-reset.sh" <<'BODYLESS'
# Synthetic regression for the ship-check self-test: the bodyless DELETE the
# deployed HQ Worker 422s. tls-invariants must catch this.
curl -sS -X DELETE "${HQ_ISSUANCE_URL%/}/api/issuance/registration?device_id=${DEV}" || true
BODYLESS
  if ! _assert_check_fails "$synth" tls-invariants; then
    printf "    expected tls-invariants to FAIL after re-introducing a bodyless curl\n" >&2
    return 1
  fi

  # 2c. A purely EXPLANATORY comment that mentions the old curl must NOT trip a
  #     false FAIL — the grep strips comment lines first. Restore the faithful
  #     copy + append only a comment referencing the bodyless curl; PASS again.
  cp "$REPO_ROOT_REAL/scripts/factory-reset.sh" "$synth/scripts/factory-reset.sh"
  cat >> "$synth/scripts/factory-reset.sh" <<'COMMENTONLY'
# was: curl -X DELETE "${HQ_ISSUANCE_URL%/}/api/issuance/registration" (replaced
# by the signed tls-deregister CLI; HQ 422'd the bodyless DELETE).
COMMENTONLY
  if ! _assert_check_passes "$synth" tls-invariants; then
    printf "    tls-invariants false-FAILed on a comment that only MENTIONS the old curl\n" >&2
    return 1
  fi
}

# =============================================================================
# Test: the bash version floor says COULD NOT RUN, not "a check failed"
# =============================================================================
#
# Bug class this guards (WARP-2449): ship-check.sh IS the pre-PR gate that
# .claude/skills/preflight/SKILL.md and docs/integrations/ADD-A-PROVIDER.md
# mandate, and for months it could not run on the primary dev Mac at all --
# associative arrays need bash 4, macOS ships 3.2.57, and the script died with a
# raw `declare: -A: invalid option`. Everybody who followed the documented
# preflight exactly either noticed and skipped the gate or believed they had run
# it. `lifecycle-naming` has no other runner, so a diff violating it was caught
# by nothing before review.
#
# Two things had to become true. The script must run on bash 3.2 (the next test
# owns that). And if a future edit legitimately raises the floor, the failure
# must be an actionable sentence carrying an exit code that CANNOT be mistaken
# for a gate that passed -- exit 4, never exit 1.
#
# Synthetic-copy pattern (no real-tree mutation): copy ship-check.sh, raise its
# floor above every bash in existence so the guard fires whatever the host runs
# -- 3.2 on the dev Mac, 5.x on ubuntu-latest -- and assert the code and the
# message. Then MUTATE by deleting the guard and assert both disappear; without
# that half, the test could be passing for some other reason.
test_bash_version_guard_reports_could_not_run() {
  local tmp
  tmp="$(mktemp -d)" || return 1
  # shellcheck disable=SC2064  # capture the path at trap-set time
  trap "rm -rf '$tmp'" RETURN

  local guarded="$tmp/guarded.sh"
  local unguarded="$tmp/unguarded.sh"

  sed 's/^MIN_BASH_MAJOR=3$/MIN_BASH_MAJOR=99/' "$SHIP_CHECK" > "$guarded"
  if ! grep -q '^MIN_BASH_MAJOR=99$' "$guarded"; then
    printf "    could not raise MIN_BASH_MAJOR — has the floor been renamed?\n" >&2
    return 1
  fi

  local out rc
  out="$(bash "$guarded" --help 2>&1)"
  rc=$?

  # 1. The reserved could-not-run code, and specifically NOT 1. Conflating the
  #    two is the defect: a caller must never read "never executed" as "ran and
  #    passed".
  if [ "$rc" -ne 4 ]; then
    printf "    expected exit 4 (could-not-run), got %d\n" "$rc" >&2
    printf '%s\n' "$out" | sed 's/^/    | /' >&2
    return 1
  fi

  # 2. The message names the requirement and how to satisfy it.
  if ! printf '%s' "$out" | grep -q 'requires bash 99\.2 or newer'; then
    printf "    message does not name the required bash version:\n" >&2
    printf '%s\n' "$out" | sed 's/^/    | /' >&2
    return 1
  fi
  if ! printf '%s' "$out" | grep -q 'brew install bash'; then
    printf "    message does not state the remedy (brew install bash):\n" >&2
    printf '%s\n' "$out" | sed 's/^/    | /' >&2
    return 1
  fi

  # 3. And it is not the raw builtin error this ticket was filed about.
  if printf '%s' "$out" | grep -q 'invalid option'; then
    printf "    raw builtin error leaked past the guard:\n" >&2
    printf '%s\n' "$out" | sed 's/^/    | /' >&2
    return 1
  fi

  # 4. MUTATION: delete the guard block, keep the raised floor. Both the exit
  #    code and the message must vanish. If either survives, this test is
  #    measuring something other than the guard.
  awk '
    /^# --- Bash version floor \(WARP-2449\)/ { skip = 1 }
    skip && /^fi$/                            { skip = 0; next }
    !skip                                     { print }
  ' "$guarded" > "$unguarded"

  if grep -q '^MIN_BASH_MAJOR=' "$unguarded"; then
    printf "    mutation did not remove the guard\n" >&2
    return 1
  fi

  local mout mrc
  mout="$(bash "$unguarded" --help 2>&1)"
  mrc=$?
  if [ "$mrc" -eq 4 ]; then
    printf "    guard removed but exit 4 persists — test is not measuring the guard\n" >&2
    return 1
  fi
  if printf '%s' "$mout" | grep -q 'brew install bash'; then
    printf "    guard removed but its message persists\n" >&2
    return 1
  fi
  return 0
}

# =============================================================================
# Test: ship-check.sh stays runnable on stock macOS bash 3.2 (WARP-2449)
# =============================================================================
#
# The original defect was one `declare -A` on line 115, and nothing in CI would
# ever have caught it: every workflow runs on ubuntu-latest with bash 5, where
# the script is green, while the machine the docs tell you to run it on could
# not execute a single line of it.
#
# This test is therefore deliberately STATIC as well as dynamic. The static scan
# fails on the bash 5 runner too, where an execution test cannot possibly notice
# the problem; the dynamic half only runs where an old bash exists and catches
# what a grep cannot see (bash 3.2 also cannot parse a `case` inside `$( )`, or
# an apostrophe in a comment inside `$( )` — both of which this script contained
# and both of which are fixed).
_scan_bash4_only() {
  # Associative arrays, mapfile/readarray, and ${x^^} / ${x,,} case conversion
  # are all bash 4+.
  grep -nE 'declare[[:space:]]+-A|local[[:space:]]+-A|mapfile|readarray|\$\{[A-Za-z_][A-Za-z0-9_]*(\^\^|,,)' "$1" || true
}

test_ship_check_is_runnable_on_bash_3_2() {
  local found
  found="$(_scan_bash4_only "$SHIP_CHECK")"
  if [ -n "$found" ]; then
    printf "    bash-4-only syntax in ship-check.sh (macOS ships bash 3.2.57):\n" >&2
    printf '%s\n' "$found" | sed 's/^/    | /' >&2
    return 1
  fi

  # MUTATION: reintroduce an associative array into a copy. Without this the
  # assertion above could be vacuously green.
  local tmp
  tmp="$(mktemp -d)" || return 1
  # shellcheck disable=SC2064  # capture the path at trap-set time
  trap "rm -rf '$tmp'" RETURN
  cp "$SHIP_CHECK" "$tmp/mutated.sh"
  printf 'declare -A REINTRODUCED=()\n' >> "$tmp/mutated.sh"
  if [ -z "$(_scan_bash4_only "$tmp/mutated.sh")" ]; then
    printf "    scan failed to flag a reintroduced associative array\n" >&2
    return 1
  fi

  # Dynamic half: where a pre-4 bash exists, prove the real script parses and
  # runs under it. Skipped (not failed) on a runner that only has bash 5 —
  # the static scan above is the part that guards CI.
  local old_bash_major
  if [ ! -x /bin/bash ]; then
    return 0
  fi
  old_bash_major="$(/bin/bash -c 'echo "${BASH_VERSINFO[0]}"' 2>/dev/null || echo 9)"
  if [ "$old_bash_major" -ge 4 ]; then
    printf "    (skip dynamic half: /bin/bash is %s, need <4 to exercise it)\n" \
      "$(/bin/bash -c 'echo "$BASH_VERSION"')" >&2
    return 0
  fi

  local out rc
  out="$(/bin/bash "$SHIP_CHECK" --help 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf "    ship-check.sh --help failed under /bin/bash %s (exit %d):\n" \
      "$(/bin/bash -c 'echo "$BASH_VERSION"')" "$rc" >&2
    printf '%s\n' "$out" | sed 's/^/    | /' >&2
    return 1
  fi
  return 0
}

# =============================================================================
# Test: the suite leaves the caller's git index exactly as it found it
# =============================================================================
#
# WARP-2479. The `exec-bits` cases mutate index modes with
# `git update-index`, which rewrites the entry from current working-tree
# content — so before the GIT_INDEX_FILE isolation above, running the suite
# with an unstaged edit in the tree STAGED that edit and left it staged.
# Measured on the pre-fix harness: run 1 → 14/15 and
# `git diff --cached --stat` reporting `scripts/test/ship-check.sh | 2 ++`;
# run 2 → 13/15, the extra red being the harness's own "already staged —
# refusing to mutate" guard. The danger is not the spurious red, it is a
# subsequent `git commit -a` shipping content the author never staged.
#
# This test compares the FULL index listing captured before the first case
# ran against the listing now. `git ls-files -s` prints `<mode> <object>
# <stage>\t<path>` for every entry, so it catches a changed mode, a changed
# blob, an added path and a removed path alike. It is deliberately a
# BEFORE/AFTER comparison rather than a bare `git diff --cached --quiet`,
# which asks a different question — "is the index clean?" — and would go red
# for a developer who legitimately had staged work before invoking the suite,
# even though the suite touched nothing. The ticket's literal
# `git diff --cached --quiet` is asserted too, but only when the index was
# in fact clean on entry, where the two questions coincide.
#
# Mutation: drop the `_isolated_index_begin` call from either exec-bits case
# and run the suite with any unstaged edit in the tree → red here.
test_harness_leaves_caller_index_untouched() {
  if [ ! -f "$_INDEX_SNAPSHOT_AT_START" ]; then
    printf "    no index snapshot captured at suite start\n" >&2
    return 1
  fi

  local now rc
  now="$(mktemp "${TMPDIR:-/tmp}/ship-check-index-after.XXXXXX")" || return 1
  (cd "$REPO_ROOT_REAL" && git ls-files -s) > "$now" 2>/dev/null

  if ! diff -u "$_INDEX_SNAPSHOT_AT_START" "$now" > "$now.diff" 2>&1; then
    printf "    the suite modified the caller's git index:\n" >&2
    head -20 "$now.diff" | sed 's/^/    | /' >&2
    rm -f "$now" "$now.diff"
    return 1
  fi
  rm -f "$now" "$now.diff"

  # The ticket's literal assertion. Only meaningful when the caller handed
  # us a clean index — otherwise their own staged work would fail it.
  if [ "$_INDEX_CLEAN_AT_START" = "true" ]; then
    (cd "$REPO_ROOT_REAL" && git diff --cached --quiet 2>/dev/null)
    rc=$?
    if [ "$rc" -ne 0 ]; then
      printf "    index was clean at suite start but 'git diff --cached --quiet' now exits %d\n" "$rc" >&2
      (cd "$REPO_ROOT_REAL" && git diff --cached --stat) | sed 's/^/    | /' >&2
      return 1
    fi
  fi
  return 0
}

# =============================================================================
# Driver
# =============================================================================
printf "\n  ${_BOLD}Ship-check regression test suite${_RESET}\n"
printf "  Real repo: %s\n" "$REPO_ROOT_REAL"
printf "  ──────────────────────────────────\n"

# Snapshot the caller's index BEFORE any case runs, so the final test can
# prove the suite gave it back unchanged (WARP-2479). Captured here rather
# than inside the test so it records the true pre-suite state. Removed at
# the foot of the driver rather than via an EXIT trap, because several test
# bodies set their own `trap … RETURN EXIT` and would clobber it.
_INDEX_SNAPSHOT_AT_START="$(mktemp "${TMPDIR:-/tmp}/ship-check-index-before.XXXXXX")"
(cd "$REPO_ROOT_REAL" && git ls-files -s) > "$_INDEX_SNAPSHOT_AT_START" 2>/dev/null
if (cd "$REPO_ROOT_REAL" && git diff --cached --quiet 2>/dev/null); then
  _INDEX_CLEAN_AT_START=true
else
  _INDEX_CLEAN_AT_START=false
fi

_run_test "tsc-full catches WARP-329 fixture regression" \
  test_tsc_full_catches_fixture_regression

_run_test "tsc-full uses workspace-pinned prisma (WARP-492)" \
  test_tsc_full_uses_workspace_pinned_prisma

_run_test "compose-config catches YAML breakage in docker-compose.yml" \
  test_compose_config_catches_yaml_breakage

_run_test "frigate-env-scan catches unresolved {VAR} substitution" \
  test_frigate_env_scan_catches_unresolved_substitution

_run_test "shellcheck catches local-outside-function in scripts/lib" \
  test_shellcheck_catches_local_outside_function

_run_test "shellcheck catches new SC2034 violation in scripts/lib (WARP-486)" \
  test_shellcheck_catches_new_sc2034_violation

_run_test "shellcheck lints the gate itself and catches a directive-shaped comment (WARP-2477)" \
  test_shellcheck_lints_the_gate_and_catches_directive_shaped_comment

_run_test "shellcheck check reports its findings, not just a non-zero exit (WARP-2492)" \
  test_shellcheck_reports_findings_not_just_exit_code

_run_test "docker-build-smoke shim rejects unknown docker subcommand" \
  test_docker_build_smoke_shim_rejects_unknown_subcommand

_run_test "exec-bits catches chmod-stripped tracked script" \
  test_exec_bits_catches_chmod_stripped

_run_test "exec-bits catches chmod-stripped tracked script in openwrt/scripts/" \
  test_exec_bits_catches_chmod_stripped_openwrt

_run_test "stale-repo-names catches inference-engine re-introduction (WARP-494)" \
  test_stale_repo_names_catches_inference_engine_reintro

_run_test "lifecycle-naming catches new poc token in user-facing surface (ADR-018)" \
  test_lifecycle_naming_catches_new_poc_token

_run_test "lifecycle-naming catches structural dev/test framing and honours the grandfather (WARP-2478)" \
  test_lifecycle_naming_structural_and_grandfather

_run_test "image-pipeline catches a stubbed scripts/build-image.sh (WARP-663)" \
  test_image_pipeline_catches_stubbed_build_image

_run_test "tls-invariants catches a factory-reset HQ-deregister regression (ADR-023 PR-3)" \
  test_tls_invariants_catches_deregister_regression

_run_test "bash version floor reports COULD NOT RUN with its own exit code (WARP-2449)" \
  test_bash_version_guard_reports_could_not_run

_run_test "ship-check.sh is runnable on stock macOS bash 3.2 (WARP-2449)" \
  test_ship_check_is_runnable_on_bash_3_2

# MUST stay last: it asserts every case above gave the caller's index back
# untouched (WARP-2479).
_run_test "suite leaves the caller's git index untouched (WARP-2479)" \
  test_harness_leaves_caller_index_untouched

rm -f "$_INDEX_SNAPSHOT_AT_START"

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
