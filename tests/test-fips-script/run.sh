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
#   - Comment-only mentions stripped, code lines never (WARP-2480)
#
# Each test sets up a temp repo with the fixtures laid out under
# `scripts/test-fips.sh`-compatible scan roots, then runs the real script
# against that root. Sandbox isolation keeps the actual repo source out
# of the assertions.
#
# Two fixture styles live here, deliberately:
#   * heredocs, for one-liner algorithm/escape cases where the fixture IS the
#     assertion and inlining keeps it readable;
#   * files under `fixtures/`, for the WARP-2480 comment-stripping cases, whose
#     point is the *shape* of a whole file (JSDoc blocks, block-comment
#     terminators, indentation) and which are reviewed as source, not as a
#     quoted string.
# `fixtures/` is out of the lint's own scan roots (apps/services/packages/
# scripts/docker) and additionally matches the `/tests/test-fips-script`
# exclude fragment, so its deliberate MD5 call sites never trip the real run.
#
# Mutation harness hook: set `FIPS_LINT_SCRIPT=/path/to/mutated-copy.sh` to run
# this suite against a mutated copy of the lint instead of the tracked one.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_SCRIPT="${FIPS_LINT_SCRIPT:-$REPO_ROOT/scripts/test-fips.sh}"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"

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

# Copy a file from `fixtures/` into a sandbox scan root, keeping its name so
# the reported violation path is recognisable in a failure dump.
copy_fixture() {
  local sandbox="$1" fixture="$2" dest_dir="${3:-services}"
  cp "$FIXTURES_DIR/$fixture" "$sandbox/$dest_dir/$fixture"
}

# Number of violations the run reported, read off its own summary line
# (`FAIL  <n> FIPS violation(s); see above`). A clean run prints no such line,
# which is 0. Asserting the COUNT — not just the exit code — is what keeps the
# comment-stripping tests from passing for the wrong reason: a fixture pair
# that trades one violation for another still exits 1.
violation_count() {
  local sandbox="$1" n
  n="$(sed -nE 's/^FAIL[[:space:]]+([0-9]+) FIPS violation.*$/\1/p' "$sandbox/stderr.log" | head -n1)"
  [ -n "$n" ] || n=0
  printf '%s' "$n"
}

# Assert a substring appears in the run's stderr, so a test that expects a
# violation names WHICH line it expects rather than accepting any failure.
stderr_has() {
  local sandbox="$1" needle="$2"
  grep -qF -- "$needle" "$sandbox/stderr.log"
}

dump_logs() {
  local sandbox="$1"
  sed 's/^/      | /' "$sandbox/stdout.log" >&2
  sed 's/^/      | /' "$sandbox/stderr.log" >&2
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

# -----------------------------------------------------------------------------
# WARP-2480 — comment-only mentions are stripped before the escape check
# -----------------------------------------------------------------------------
#
# `scripts/test-fips.sh` has promised this since WARP-229 (its PATTERNS header:
# "Plain mentions in comments / docstrings are stripped from the candidate set
# before the escape-comment check"), but `_strip_comment_only_lines` did not
# exist, so a file could not document why it avoids a primitive without either
# an undeserved `fips:allowed:` escape or rewording the prose until the regex
# stopped matching. WARP-2460's Mailchimp docstring hit exactly that.
#
# Tests 8-9 are the new behaviour; tests 10-13 are the guard rails — the strip
# is line-scoped and must never reach a code line.
#
# Mutation (run with FIPS_LINT_SCRIPT pointed at the mutated copy): make
# `_strip_comment_only_lines` drop every hit rather than only comment-only
# ones. Tests 10-13 go red because the real call sites stop being reported.

test_comment_only_ts_mentions_pass() {
  local s; s="$(make_sandbox)"
  copy_fixture "$s" comment-only-mentions.ts
  write_exceptions_doc "$s"  # empty — the fixture must not need an escape
  local rc; rc="$(run_script_in_sandbox "$s")"
  local n; n="$(violation_count "$s")"
  if [ "$rc" = "0" ] && [ "$n" = "0" ]; then
    pass "comment-only mentions (//, /*, *, */) produce no violation"
  else
    fail "comment-only .ts mentions should be stripped (rc=$rc, violations=$n)"
    dump_logs "$s"
  fi
  rm -rf "$s"
}

test_comment_only_py_mentions_pass() {
  local s; s="$(make_sandbox)"
  copy_fixture "$s" comment-only-mentions.py
  write_exceptions_doc "$s"
  local rc; rc="$(run_script_in_sandbox "$s")"
  local n; n="$(violation_count "$s")"
  if [ "$rc" = "0" ] && [ "$n" = "0" ]; then
    pass "comment-only mentions (#) produce no violation"
  else
    fail "comment-only .py mentions should be stripped (rc=$rc, violations=$n)"
    dump_logs "$s"
  fi
  rm -rf "$s"
}

test_real_call_still_violates() {
  local s; s="$(make_sandbox)"
  copy_fixture "$s" real-call.ts
  write_exceptions_doc "$s"
  local rc; rc="$(run_script_in_sandbox "$s")"
  local n; n="$(violation_count "$s")"
  if [ "$rc" = "1" ] && [ "$n" = "1" ] && stderr_has "$s" "real-call.ts:7"; then
    pass "a real createHash(\"md5\") call is still a violation"
  else
    fail "real call should violate at line 7 (rc=$rc, violations=$n)"
    dump_logs "$s"
  fi
  rm -rf "$s"
}

test_real_call_with_unregistered_escape_still_violates() {
  local s; s="$(make_sandbox)"
  copy_fixture "$s" real-call-unregistered-escape.ts
  write_exceptions_doc "$s" rtsp-digest-rfc2617
  local rc; rc="$(run_script_in_sandbox "$s")"
  local n; n="$(violation_count "$s")"
  if [ "$rc" = "1" ] && [ "$n" = "1" ] \
     && stderr_has "$s" "real-call-unregistered-escape.ts:8" \
     && stderr_has "$s" "not-a-registered-reason-id is not registered"; then
    pass "a real call with an unregistered fips:allowed id is still a violation"
  else
    fail "unregistered escape should violate at line 8 (rc=$rc, violations=$n)"
    dump_logs "$s"
  fi
  rm -rf "$s"
}

test_comment_mention_does_not_excuse_call_in_same_file() {
  local s; s="$(make_sandbox)"
  copy_fixture "$s" mixed-comment-and-call.ts
  write_exceptions_doc "$s"
  local rc; rc="$(run_script_in_sandbox "$s")"
  local n; n="$(violation_count "$s")"
  if [ "$rc" = "1" ] && [ "$n" = "1" ] && stderr_has "$s" "mixed-comment-and-call.ts:14"; then
    pass "a prose mention does not exempt the real call below it"
  else
    fail "mixed fixture should report exactly line 14 (rc=$rc, violations=$n)"
    dump_logs "$s"
  fi
  rm -rf "$s"
}

test_hash_prefixed_code_line_is_not_a_comment() {
  local s; s="$(make_sandbox)"
  copy_fixture "$s" hash-prefixed-code.ts
  write_exceptions_doc "$s"
  local rc; rc="$(run_script_in_sandbox "$s")"
  local n; n="$(violation_count "$s")"
  if [ "$rc" = "1" ] && [ "$n" = "1" ] && stderr_has "$s" "hash-prefixed-code.ts:10"; then
    pass "a #private class field in .ts is code, not a comment"
  else
    fail "#private field should violate at line 10 (rc=$rc, violations=$n)"
    dump_logs "$s"
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
test_comment_only_ts_mentions_pass
test_comment_only_py_mentions_pass
test_real_call_still_violates
test_real_call_with_unregistered_escape_still_violates
test_comment_mention_does_not_excuse_call_in_same_file
test_hash_prefixed_code_line_is_not_a_comment

echo
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
