#!/usr/bin/env bash
# =============================================================================
# Unit tests for scripts/test-fips.sh
# =============================================================================
#
# Feeds synthetic fixtures through a sandbox copy of test-fips.sh and asserts
# the exit code. Covers:
#   - Known-bad source samples → non-zero exit
#   - Known-good samples → zero exit
#   - Known-bad-with-valid-allowlist-comment → zero exit
#   - Known-bad-with-broken-allowlist-reason-id → non-zero exit
#
# Each test sets up a temp repo with the fixtures laid out under
# `scripts/test-fips.sh`-compatible scan roots, then runs the real script
# against that root. Sandbox isolation keeps the actual repo source out
# of the assertions.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_SCRIPT="$REPO_ROOT/scripts/test-fips.sh"

if [ ! -x "$TEST_SCRIPT" ]; then
  echo "FAIL: $TEST_SCRIPT not executable" >&2
  exit 2
fi

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1" >&2; FAIL=$((FAIL + 1)); }

# Make a temp sandbox directory with a minimal repo layout and the real
# script symlinked in. Each `make_sandbox` call returns a fresh dir on
# stdout; the caller is responsible for `rm -rf` at the end.
make_sandbox() {
  local d
  d="$(mktemp -d -t fipslint.XXXXXX)"
  mkdir -p "$d/scripts" "$d/apps" "$d/services" "$d/packages" "$d/docker" \
           "$d/docs/security"
  # Symlink the real script into the sandbox so the script's
  # `REPO_ROOT` resolves to the sandbox.
  ln -s "$TEST_SCRIPT" "$d/scripts/test-fips.sh"
  echo "$d"
}

write_exceptions_doc() {
  local sandbox="$1"
  shift
  local ids="$*"
  {
    echo "---"
    echo "exceptions:"
    for id in $ids; do
      echo "  - id: $id"
      echo "    algorithm: md5"
      echo "    rationale: test fixture"
    done
    echo "---"
    echo
    echo "# FIPS Exceptions (test fixture)"
  } > "$sandbox/docs/security/fips-exceptions.md"
}

run_script_in_sandbox() {
  local sandbox="$1"
  ( cd "$sandbox" && bash scripts/test-fips.sh ) > "$sandbox/stdout.log" 2> "$sandbox/stderr.log"
  echo $?
}

# We need the candidate-file enumeration to find our fixture files. The
# real script prefers `git ls-files` if a git checkout is detected, else
# falls back to `find`. We want the find path. Make sure the sandbox is
# NOT a git checkout (no .git dir).

# -----------------------------------------------------------------------------
# Test 1: clean repo → exit 0
# -----------------------------------------------------------------------------
test_clean_passes() {
  local s; s="$(make_sandbox)"
  cat > "$s/services/clean.py" <<'EOF'
import hashlib

def fingerprint(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()
EOF
  write_exceptions_doc "$s"  # empty list
  local rc; rc="$(run_script_in_sandbox "$s")"
  if [ "$rc" = "0" ]; then
    pass "clean repo passes"
  else
    fail "clean repo should pass (rc=$rc)"
    cat "$s/stdout.log"; cat "$s/stderr.log"
  fi
  rm -rf "$s"
}

# -----------------------------------------------------------------------------
# Test 2: MD5 without escape → exit non-zero
# -----------------------------------------------------------------------------
test_md5_without_escape_fails() {
  local s; s="$(make_sandbox)"
  cat > "$s/services/bad.py" <<'EOF'
import hashlib

def fingerprint(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()
EOF
  write_exceptions_doc "$s"  # empty
  local rc; rc="$(run_script_in_sandbox "$s")"
  if [ "$rc" = "1" ]; then
    pass "md5 without escape fails"
  else
    fail "md5 without escape should fail (rc=$rc)"
    cat "$s/stdout.log"; cat "$s/stderr.log"
  fi
  rm -rf "$s"
}

# -----------------------------------------------------------------------------
# Test 3: MD5 with VALID escape → exit 0
# -----------------------------------------------------------------------------
test_md5_with_valid_escape_passes() {
  local s; s="$(make_sandbox)"
  cat > "$s/services/protocol.py" <<'EOF'
import hashlib

def rtsp_digest(user: str, realm: str, pw: str) -> str:
    # fips:allowed: rtsp-digest-rfc2617
    return hashlib.md5(f"{user}:{realm}:{pw}".encode()).hexdigest()
EOF
  write_exceptions_doc "$s" rtsp-digest-rfc2617
  local rc; rc="$(run_script_in_sandbox "$s")"
  if [ "$rc" = "0" ]; then
    pass "md5 with valid escape passes"
  else
    fail "md5 with valid escape should pass (rc=$rc)"
    cat "$s/stdout.log"; cat "$s/stderr.log"
  fi
  rm -rf "$s"
}

# -----------------------------------------------------------------------------
# Test 4: MD5 with BROKEN escape (unknown reason-id) → exit non-zero
# -----------------------------------------------------------------------------
test_md5_with_broken_escape_fails() {
  local s; s="$(make_sandbox)"
  cat > "$s/services/bad.py" <<'EOF'
import hashlib

def f(x: str) -> str:
    # fips:allowed: this-id-doesnt-exist
    return hashlib.md5(x.encode()).hexdigest()
EOF
  write_exceptions_doc "$s" rtsp-digest-rfc2617
  local rc; rc="$(run_script_in_sandbox "$s")"
  if [ "$rc" = "1" ]; then
    pass "md5 with unresolved escape fails"
  else
    fail "md5 with unresolved escape should fail (rc=$rc)"
    cat "$s/stdout.log"; cat "$s/stderr.log"
  fi
  rm -rf "$s"
}

# -----------------------------------------------------------------------------
# Test 5: SHA-1 without escape → exit non-zero
# -----------------------------------------------------------------------------
test_sha1_without_escape_fails() {
  local s; s="$(make_sandbox)"
  cat > "$s/apps/x.ts" <<'EOF'
import crypto from "node:crypto";
export function f(x: string): string {
  return crypto.createHash("sha1").update(x).digest("hex");
}
EOF
  write_exceptions_doc "$s"
  local rc; rc="$(run_script_in_sandbox "$s")"
  if [ "$rc" = "1" ]; then
    pass "sha1 without escape fails"
  else
    fail "sha1 without escape should fail (rc=$rc)"
    cat "$s/stdout.log"; cat "$s/stderr.log"
  fi
  rm -rf "$s"
}

# -----------------------------------------------------------------------------
# Test 6: Node createHash('md5') with escape → exit 0
# -----------------------------------------------------------------------------
test_node_md5_with_escape_passes() {
  local s; s="$(make_sandbox)"
  cat > "$s/apps/probe.ts" <<'EOF'
import crypto from "node:crypto";
export function probe(): string {
  // fips:allowed: legacy-checksum
  return crypto.createHash("md5").update("x").digest("hex");
}
EOF
  write_exceptions_doc "$s" legacy-checksum
  local rc; rc="$(run_script_in_sandbox "$s")"
  if [ "$rc" = "0" ]; then
    pass "node md5 with escape passes"
  else
    fail "node md5 with escape should pass (rc=$rc)"
    cat "$s/stdout.log"; cat "$s/stderr.log"
  fi
  rm -rf "$s"
}

# -----------------------------------------------------------------------------
# Test 7: Escape comment too far (>2 lines away) → still fails
# -----------------------------------------------------------------------------
test_escape_too_far_fails() {
  local s; s="$(make_sandbox)"
  cat > "$s/services/farcomment.py" <<'EOF'
import hashlib

# fips:allowed: rtsp-digest-rfc2617
# ----- many lines of unrelated code -----
def a(): return 1
def b(): return 2
def c(): return 3
def f(x: str) -> str:
    return hashlib.md5(x.encode()).hexdigest()
EOF
  write_exceptions_doc "$s" rtsp-digest-rfc2617
  local rc; rc="$(run_script_in_sandbox "$s")"
  if [ "$rc" = "1" ]; then
    pass "escape comment >2 lines away fails"
  else
    fail "escape comment >2 lines away should fail (rc=$rc)"
    cat "$s/stdout.log"; cat "$s/stderr.log"
  fi
  rm -rf "$s"
}

test_clean_passes
test_md5_without_escape_fails
test_md5_with_valid_escape_passes
test_md5_with_broken_escape_fails
test_sha1_without_escape_fails
test_node_md5_with_escape_passes
test_escape_too_far_fails

echo
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
