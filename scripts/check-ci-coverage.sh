#!/usr/bin/env bash
#
# check-ci-coverage.sh — fail if any service/app lacks a CI test workflow.
#
# For every `services/<name>/` with a Dockerfile and every `apps/<name>/` with
# a package.json, require:
#   1. A workflow file at `.github/workflows/<name>-tests.yml`.
#   2. That workflow's `paths:` filter covers the service/app directory.
#   3. That workflow runs a recognised test command (pytest / vitest / jest /
#      npm test).
#   4. The service/app ships a test suite — a `tests/` directory with at
#      least one `test_*.py`, or any `*.test.ts(x)` / `*.spec.ts(x)` /
#      `__tests__/` layout.
#
# Intentional exemptions can be listed one-per-line in
# `.github/ci-coverage-exempt` (comments with `#` allowed). Exemption applies
# to paths relative to the repo root, e.g. `services/legacy-thing`.
#
# Exit 0 on full coverage, 1 on any gap.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail=0
note() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; fail=1; }
ok()   { printf '\033[32m  OK\033[0m %s\n' "$*"; }
skip() { printf '\033[33mSKIP\033[0m %s (exempt)\n' "$*"; }

exempt_file=".github/ci-coverage-exempt"
is_exempt() {
  local path="$1"
  [ -f "$exempt_file" ] || return 1
  grep -v '^[[:space:]]*#' "$exempt_file" \
    | grep -v '^[[:space:]]*$' \
    | grep -qxF "$path"
}

workflow_runs_tests() {
  local wf="$1"
  grep -qE '(\bpytest\b|\bvitest\b|\bjest\b|npm[[:space:]]+(run[[:space:]]+)?test)' "$wf"
}

has_test_suite() {
  local dir="$1"
  # Python: tests/test_*.py
  if ls "$dir"/tests/test_*.py >/dev/null 2>&1; then return 0; fi
  # JS/TS: *.test.ts(x), *.spec.ts(x), *.test.js
  if compgen -G "$dir/**/*.test.ts" >/dev/null 2>&1; then return 0; fi
  if compgen -G "$dir/**/*.test.tsx" >/dev/null 2>&1; then return 0; fi
  if compgen -G "$dir/**/*.spec.ts" >/dev/null 2>&1; then return 0; fi
  if compgen -G "$dir/**/*.test.js" >/dev/null 2>&1; then return 0; fi
  # Find fallback — compgen globstar is not universal.
  if find "$dir" -type f \
      \( -name "*.test.ts" -o -name "*.test.tsx" \
         -o -name "*.spec.ts" -o -name "*.test.js" \
         -o -name "test_*.py" \) \
      -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  # __tests__/ dirs
  if find "$dir" -type d -name "__tests__" -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

check_dir() {
  local dir="$1"       # e.g. services/switch
  local name="$2"      # e.g. switch
  local kind="$3"      # "service" or "app"

  if is_exempt "$dir"; then
    skip "$dir"
    return
  fi

  local wf=".github/workflows/${name}-tests.yml"
  if [ ! -f "$wf" ]; then
    note "$dir has no CI workflow. Expected: $wf"
    printf '     Add a pull_request-triggered workflow that runs tests on %s/**\n' "$dir" >&2
    return
  fi

  if ! grep -qE "\"?${dir}/\*\*\"?" "$wf"; then
    note "$wf exists but its \`paths:\` filter does not cover ${dir}/**"
  fi

  if ! workflow_runs_tests "$wf"; then
    note "$wf does not run a recognised test command (pytest/vitest/jest/npm test)"
  fi

  if ! has_test_suite "$dir"; then
    note "$dir has no test suite (looked for tests/test_*.py, *.test.ts(x), *.spec.ts, __tests__/)"
  fi

  if [ $fail -eq 0 ]; then
    ok "$dir ($kind) — workflow, paths, tests all present"
  fi
}

echo "CI coverage audit"
echo "================="

# --- services/ ---
for dir in services/*/; do
  dir="${dir%/}"
  name="${dir#services/}"
  [ -f "$dir/Dockerfile" ] || continue
  check_dir "$dir" "$name" "service"
done

# --- apps/ ---
for dir in apps/*/; do
  dir="${dir%/}"
  name="${dir#apps/}"
  [ -f "$dir/package.json" ] || continue
  check_dir "$dir" "$name" "app"
done

echo ""
if [ $fail -ne 0 ]; then
  cat >&2 <<'EOF'
CI coverage check FAILED.

Every service in `services/` and app in `apps/` must have:
  1. A workflow at `.github/workflows/<name>-tests.yml` whose `paths:` filter
     covers the directory, and that runs pytest/vitest/jest/npm test.
  2. A test suite (tests/test_*.py, *.test.ts(x), *.spec.ts, or __tests__/).

To intentionally exempt a path, add it one-per-line to
`.github/ci-coverage-exempt` (lines starting with `#` are comments).

Rationale: see docs in this script's header.
EOF
  exit 1
fi

echo "All services and apps have CI coverage."
