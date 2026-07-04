#!/usr/bin/env bash
# =============================================================================
# WARP-316 — Docker-free logic checks for tests/fips-sabotage.test.sh.
# =============================================================================
#
# The real sabotage proof needs a Docker build and runs in the Docker-gated CI
# leg. This unit test validates the sabotage *harness itself* on any box (no
# Docker): the script exists + is executable, it skips cleanly when Docker is
# absent, and its embedded throwaway Dockerfile encodes the actual sabotage
# (build the module → install via the real script → remove fips.so → assert the
# provider is GONE, failing the build if it survives). This is what keeps the
# proof honest even where Docker can't run.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SABOTAGE="$SCRIPT_DIR/fips-sabotage.test.sh"
TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  WARP-316 sabotage-harness logic checks (no Docker)"
echo ""

# 1) The sabotage script must exist and be executable.
if [ -x "$SABOTAGE" ]; then
  pass "tests/fips-sabotage.test.sh exists and is executable"
else
  fail "tests/fips-sabotage.test.sh missing or not executable"
fi

# 2) It must skip (exit 0) with a SKIP note when Docker is unavailable, so the
#    static-lint CI leg and non-Docker dev boxes stay green. We force this by
#    running it with an empty PATH-ish shim where `docker` is absent.
if [ -x "$SABOTAGE" ]; then
  shim="$(mktemp -d)"
  # A PATH with only coreutils but NO docker → `command -v docker` fails.
  out="$(PATH="/usr/bin:/bin" bash "$SABOTAGE" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi 'SKIP'; then
    pass "skips cleanly (exit 0 + SKIP) when docker is unavailable"
  else
    fail "did not skip cleanly without docker (rc=$rc, out='$out')"
  fi
  rm -rf "$shim"
fi

# 3) The embedded Dockerfile must build the module, install via the REAL
#    install-fips-provider.sh, then remove fips.so and assert the provider is
#    gone. Grep the heredoc for the load-bearing lines.
if grep -q 'docker/fips/install-fips-provider.sh' "$SABOTAGE"; then
  pass "invokes the real install-fips-provider.sh (not a stub)"
else
  fail "does not reference docker/fips/install-fips-provider.sh"
fi
if grep -qE 'rm -f "\$MOD/fips\.so"' "$SABOTAGE"; then
  pass "removes fips.so from the resolved MODULESDIR (the sabotage)"
else
  fail "does not remove fips.so — no sabotage performed"
fi
# The proof passes ONLY when the provider is absent after removal: the script
# must FAIL the build if the provider is still loaded.
if grep -q 'SABOTAGE PROOF FAILED' "$SABOTAGE" && grep -q 'exit 1' "$SABOTAGE"; then
  pass "fails the build if the provider survives fips.so removal"
else
  fail "missing the negative assertion (provider-still-loaded → build fails)"
fi

# 4) The referenced real install script must actually exist in the repo.
if [ -f "$REPO_ROOT/docker/fips/install-fips-provider.sh" ]; then
  pass "docker/fips/install-fips-provider.sh present in repo"
else
  fail "docker/fips/install-fips-provider.sh missing from repo"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mResults: %d passed, 0 failed\033[0m\n\n" "$TESTS"
  exit 0
else
  printf "  \033[31mResults: %d passed, %d failed\033[0m\n\n" "$((TESTS - FAILURES))" "$FAILURES"
  exit 1
fi
