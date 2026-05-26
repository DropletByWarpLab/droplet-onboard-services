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
# Driver
# =============================================================================
printf "\n  ${_BOLD}Ship-check regression test suite${_RESET}\n"
printf "  Real repo: %s\n" "$REPO_ROOT_REAL"
printf "  ──────────────────────────────────\n"

_run_test "tsc-full catches WARP-329 fixture regression" \
  test_tsc_full_catches_fixture_regression

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
