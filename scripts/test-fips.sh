#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — FIPS 140-3 Static Lint (WARP-229)
# =============================================================================
#
# Scans source for forbidden non-FIPS cryptographic algorithms (MD5, SHA-1,
# RC4/DES/3DES, RSA < 2048, TLS < 1.2). A match is allowed only if a
# `fips:allowed: <reason-id>` comment appears within ±2 lines AND the
# reason-id resolves to an entry in docs/security/fips-exceptions.md.
#
# Exit codes:
#   0 — no violations
#   1 — at least one unescaped match, or an unresolved/dead reason-id
#   2 — internal script error (missing exceptions doc, bad YAML, etc.)
#
# Companion CI workflow: .github/workflows/test-fips.yml
# Allowlist registry:    docs/security/fips-exceptions.md
# Allowed algorithms:    docs/security/fips-allowed-algorithms.md
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

EXCEPTIONS_DOC="$REPO_ROOT/docs/security/fips-exceptions.md"

# --- Colors ---
if [ -t 1 ]; then
  _GREEN='\033[0;32m'; _RED='\033[0;31m'; _YELLOW='\033[0;33m'; _BOLD='\033[1m'; _RESET='\033[0m'
else
  _GREEN=''; _RED=''; _YELLOW=''; _BOLD=''; _RESET=''
fi

VIOLATIONS=0
INFO=0

violation() {
  printf "${_RED}FAIL${_RESET}  %s\n" "$1" >&2
  VIOLATIONS=$((VIOLATIONS + 1))
}

ok() {
  printf "${_GREEN}OK${_RESET}    %s\n" "$1"
}

note() {
  printf "${_YELLOW}NOTE${_RESET}  %s\n" "$1"
  INFO=$((INFO + 1))
}

# =============================================================================
# Forbidden algorithm patterns
# =============================================================================
# Each entry: "label|extended-regex". The regex is fed to `grep -nE`.
# Patterns intentionally over-match raw strings; the escape comment check
# downstream allows protocol-mandated uses with a documented reason.
#
# We match on the *intent* of the call site, not just the algorithm name.
# Plain mentions in comments / docstrings are stripped from the candidate
# set before the escape-comment check (see _strip_comment_only_lines).
PATTERNS=(
  "md5 (Python hashlib.md5)|hashlib\\.md5\\("
  "md5 (Python hashlib.new('md5'))|hashlib\\.new\\(\\s*['\\\"]md5['\\\"]"
  "sha1 (Python hashlib.sha1)|hashlib\\.sha1\\("
  "sha1 (Python hashlib.new('sha1'))|hashlib\\.new\\(\\s*['\\\"]sha1['\\\"]"
  "md5 (Node createHash)|createHash\\s*\\(\\s*['\\\"]md5['\\\"]"
  "md5 (Node createHmac)|createHmac\\s*\\(\\s*['\\\"]md5['\\\"]"
  "sha1 (Node createHash)|createHash\\s*\\(\\s*['\\\"]sha1['\\\"]"
  "sha1 (Node createHmac)|createHmac\\s*\\(\\s*['\\\"]sha1['\\\"]"
  "DES/3DES (PyCryptodome)|Crypto\\.Cipher\\.(DES|DES3|ARC4)"
  "DES/3DES/RC4 (Node cipher)|createCipheriv\\s*\\(\\s*['\\\"](des|3des|des-ede3|rc4|arc4)"
  "RSA-1024 constant|crypto\\.constants\\.[A-Z_]*RSA[A-Z_]*1024"
  "TLS 1.0/1.1 (literal)|TLSv1\\.[01](\\b|[^.0-9])"
  "ssl_min_protocol < TLSv1.2|ssl_min_protocol_version\\s*=\\s*TLSv1[^.]"
)

# =============================================================================
# Scan scope
# =============================================================================
# Roots to scan and globs/dirs to exclude. Mirrors spec §Static lint → Scan
# scope. We deliberately exclude tests/fixtures/, vendored protobufs, and
# build outputs because they may legitimately contain forbidden bytes that
# aren't *new code introducing the algorithm*.
SCAN_ROOTS=(
  "$REPO_ROOT/apps"
  "$REPO_ROOT/services"
  "$REPO_ROOT/packages"
  "$REPO_ROOT/scripts"
  "$REPO_ROOT/docker"
)

# Path-fragment denylist. A candidate file is skipped if any of these is
# a substring of its path. Keep matches loose so renames don't accidentally
# re-include vendored / generated content. The git-ls-files candidate
# source (preferred) already skips gitignored paths (.venv/, node_modules/,
# dist/, .next/ etc.), so this list mostly covers in-tree exclusions and
# the find-based fallback.
EXCLUDE_FRAGMENTS=(
  "/node_modules/"
  "/__pycache__/"
  "/.venv/"
  "/venv/"
  "/dist/"
  "/build/"
  "/.next/"
  "/.git/"
  "/tests/fixtures/"
  "/test/fixtures/"
  "/grpc_generated/"
  "/proto/"
  # Exclude this script itself + its own test fixtures: it contains every
  # forbidden pattern literally as the regex source of truth.
  "/scripts/test-fips.sh"
  "/tests/test-fips-script"
  # The self-test helpers (Node + Python) deliberately negative-probe the
  # forbidden algorithms; the probe call is the helper's raison d'être.
  # Their own implementation is exempted; everywhere else that calls
  # `assertFipsAtBoot()` / `assert_fips_at_boot()` is in scope as normal.
  "/packages/fips-selftest/"
  "/services/_shared/fips_selftest.py"
  "/services/_shared/test_fips_selftest.py"
  # Allowed-algorithms / exceptions registry docs contain literal algorithm
  # names by design.
  "/docs/security/fips-allowed-algorithms.md"
  "/docs/security/fips-exceptions.md"
)

# File-extension allowlist. Files with extensions outside this set are
# skipped. This keeps the scan fast and prevents binary fixtures from
# burning runtime.
INCLUDE_EXTS_REGEX='\.(py|ts|tsx|js|mjs|cjs|cnf|conf|yml|yaml|sh|cfg)$'

# =============================================================================
# Exception registry — parse YAML front-matter of fips-exceptions.md
# =============================================================================
# Format expected:
#   ---
#   exceptions:
#     - id: rtsp-digest-rfc2617
#       algorithm: md5
#       review: annual
#       ...
#     - id: wireguard-x25519
#       ...
#   ---
ALLOWED_IDS=""

load_exception_ids() {
  if [ ! -f "$EXCEPTIONS_DOC" ]; then
    note "fips-exceptions.md not present at $EXCEPTIONS_DOC — every escape comment will be reported as unresolved."
    return 0
  fi
  # Extract the YAML between the first two `---` lines, then grep for
  # `  - id: <value>` lines (bash-only, no yq dependency).
  #
  # We disable pipefail for the duration of this command substitution so
  # the empty-front-matter case (no `- id:` lines yet) doesn't propagate
  # grep's exit code 1 to the outer `set -e`. Real failures inside any
  # of these tools (awk syntax error, sed crash) would still surface as
  # an empty result, which we treat the same as "no exceptions registered".
  ALLOWED_IDS="$(
    set +o pipefail
    awk 'BEGIN{in_fm=0; count=0}
         /^---[[:space:]]*$/ { count++; if (count==1) {in_fm=1; next}; if (count==2) {in_fm=0} }
         in_fm { print }' "$EXCEPTIONS_DOC" \
      | grep -E '^[[:space:]]*-[[:space:]]+id:[[:space:]]*' \
      | sed -E 's/^[[:space:]]*-[[:space:]]+id:[[:space:]]*//' \
      | sed -E 's/[[:space:]]*#.*$//' \
      | sed -E 's/^["'\'']//; s/["'\'']$//' \
      | tr '\n' ' '
  )"
}

is_allowed_id() {
  local id="$1"
  for known in $ALLOWED_IDS; do
    if [ "$known" = "$id" ]; then
      return 0
    fi
  done
  return 1
}

# =============================================================================
# Helpers
# =============================================================================

# Decide whether a path is in scope.
is_in_scope() {
  local path="$1"
  for frag in "${EXCLUDE_FRAGMENTS[@]}"; do
    case "$path" in
      *"$frag"*) return 1 ;;
    esac
  done
  echo "$path" | grep -qE "$INCLUDE_EXTS_REGEX"
}

# For a given file + line number, look at the ±2 surrounding lines for a
# `fips:allowed: <reason-id>` comment. Echo the resolved reason-id (or
# the literal token "MISSING" if no comment present, or "UNRESOLVED:<id>"
# if the comment references an unknown id).
resolve_escape() {
  local file="$1"
  local lineno="$2"
  local start=$((lineno - 2))
  [ "$start" -lt 1 ] && start=1
  local end=$((lineno + 2))
  local window
  window="$(sed -n "${start},${end}p" "$file" 2>/dev/null || true)"
  local match
  match="$(printf "%s" "$window" | grep -oE 'fips:allowed:[[:space:]]*[A-Za-z0-9_-]+' | head -n1 || true)"
  if [ -z "$match" ]; then
    echo "MISSING"
    return
  fi
  local id="${match##*fips:allowed:}"
  id="$(echo "$id" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  if is_allowed_id "$id"; then
    echo "$id"
  else
    echo "UNRESOLVED:$id"
  fi
}

# Build the candidate file list once.
#
# Preferred: `git ls-files` (tracked + cached, excludes gitignored content
# like .venv/, node_modules/, dist/ by definition). Fast and correct.
# Falls back to `find` when not running inside a git checkout (rare in CI).
list_candidate_files() {
  if [ -d "$REPO_ROOT/.git" ] || git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$REPO_ROOT" ls-files -- \
      "apps/**" \
      "services/**" \
      "packages/**" \
      "scripts/**" \
      "docker/**" 2>/dev/null \
      | while IFS= read -r rel; do
          local abs="$REPO_ROOT/$rel"
          if is_in_scope "$abs"; then
            echo "$abs"
          fi
        done
    return
  fi
  for root in "${SCAN_ROOTS[@]}"; do
    [ -d "$root" ] || continue
    find "$root" -type f 2>/dev/null
  done | while read -r f; do
    if is_in_scope "$f"; then
      echo "$f"
    fi
  done
}

# =============================================================================
# Main scan
# =============================================================================
printf "${_BOLD}Droplet FIPS 140-3 static lint${_RESET}\n"
printf "  Repo root:       %s\n" "$REPO_ROOT"
printf "  Exceptions doc:  %s\n" "$EXCEPTIONS_DOC"

load_exception_ids
if [ -n "$ALLOWED_IDS" ]; then
  printf "  Allowed reason-ids: %s\n" "$ALLOWED_IDS"
else
  printf "  Allowed reason-ids: (none registered)\n"
fi
echo

CANDIDATES="$(list_candidate_files)"
if [ -z "$CANDIDATES" ]; then
  note "No files in scope — nothing to scan."
  exit 0
fi

# For each pattern, grep across the candidate file list and check escapes.
for entry in "${PATTERNS[@]}"; do
  label="${entry%%|*}"
  regex="${entry#*|}"
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      lineno="${hit%%:*}"
      content="${hit#*:}"
      # Strip trailing whitespace on `lineno` defensively.
      lineno="$(echo "$lineno" | tr -d '[:space:]')"
      [ -z "$lineno" ] && continue
      resolution="$(resolve_escape "$file" "$lineno")"
      relpath="${file#$REPO_ROOT/}"
      case "$resolution" in
        MISSING)
          violation "$relpath:$lineno [$label] — no fips:allowed comment within ±2 lines: $(echo "$content" | sed -E 's/^[[:space:]]+//' | cut -c1-140)"
          ;;
        UNRESOLVED:*)
          bad_id="${resolution#UNRESOLVED:}"
          violation "$relpath:$lineno [$label] — fips:allowed: $bad_id is not registered in docs/security/fips-exceptions.md"
          ;;
        *)
          # Allowed. Surface as informational only.
          note "$relpath:$lineno [$label] — allowed via fips:allowed: $resolution"
          ;;
      esac
    done < <(grep -nE "$regex" "$file" 2>/dev/null || true)
  done <<< "$CANDIDATES"
done

echo
if [ "$VIOLATIONS" -eq 0 ]; then
  printf "${_GREEN}${_BOLD}PASS${_RESET}  no FIPS violations (notes: %d)\n" "$INFO"
  exit 0
else
  printf "${_RED}${_BOLD}FAIL${_RESET}  %d FIPS violation(s); see above\n" "$VIOLATIONS" >&2
  printf "      Resolve by either:\n" >&2
  printf "      - switching to a FIPS-approved algorithm (see docs/security/fips-allowed-algorithms.md), or\n" >&2
  printf "      - adding a 'fips:allowed: <reason-id>' comment within ±2 lines AND registering\n" >&2
  printf "        the reason-id in docs/security/fips-exceptions.md.\n" >&2
  exit 1
fi
