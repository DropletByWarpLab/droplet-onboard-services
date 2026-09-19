#!/usr/bin/env bash
#
# check-ci-coverage.sh — fail if any service/app lacks a CI test workflow.
#
# For every `services/<name>/` with a Dockerfile and every `apps/<name>/` with
# a package.json, require:
#   1. A workflow that covers the directory. Resolved in two steps:
#      a. the convention, `.github/workflows/<name>-tests.yml`; failing that,
#      b. any workflow whose `on:` triggers path-filter on `<dir>/**` and that
#         runs a recognised test command.
#   2. That workflow's `paths:` filter covers the service/app directory.
#   3. That workflow runs a recognised test command (pytest / vitest / jest /
#      npm test).
#   4. The service/app ships a test suite — a `tests/` directory with at
#      least one `test_*.py`, or any `*.test.ts(x)` / `*.spec.ts(x)` /
#      `__tests__/` layout.
#
# WARP-2685 — WHY (1b) EXISTS. This gate used to resolve a workflow by
# FILENAME ALONE. `services/oled-display` is covered by
# `.github/workflows/oled-display-panel-tests.yml` — the whole tests/ directory,
# 850+ tests, on every PR touching the service, since WARP-1640/1641 — but the
# lookup wanted `oled-display-tests.yml` and could not see the `-panel-` infix.
# So the service had to sit in `.github/ci-coverage-exempt`, publishing the
# false claim that it had no CI, for the gate's benefit rather than the
# reader's. A gate whose notion of "covered" is a filename reports on naming,
# not on coverage. It now asserts what it claims to.
#
# The convention stays the FAST PATH — `<name>-tests.yml` is still how a new
# service should be wired, and how a reader finds a service's suite. (1b) is
# the escape hatch for a workflow that legitimately owns a narrower or wider
# scope than its directory's name.
#
# (1b) IS DELIBERATELY SCOPED TO THE `on:` BLOCK. Several workflows carry
# `services/<x>/**` globs inside `dorny/paths-filter` `filters:` under `jobs:`
# for services they do not own — ci.yml lists a dozen, test-fips.yml lists
# device-identity-svc. Matching those would let ci.yml "cover" almost every
# service and gut the gate. Only path globs in a workflow's own trigger filters
# count. Do not relax this to a whole-file grep.
#
# Note this gate does NOT require a `pull_request:` trigger: the 13 mirrored
# per-service workflows are push-to-main canaries on purpose (docs/ci-cost-
# budget.md), with PR-time coverage supplied by ci.yml's legs.
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

# Print a workflow's `on:` block — from the top-level `on:` key up to the next
# top-level key. Everything under `jobs:` is excluded by construction, which is
# the whole point (see the WARP-2685 note above).
workflow_on_block() {
  awk '
    /^["'"'"']?on["'"'"']?[[:space:]]*:/ { inblock = 1; next }
    inblock && /^[^[:space:]#]/          { exit }
    inblock                              { print }
  ' "$1"
}

# True if the workflow's own trigger filters path-match `<dir>/**`.
workflow_paths_cover() {
  local wf="$1" dir="$2"
  workflow_on_block "$wf" \
    | grep -qE "^[[:space:]]*-[[:space:]]*\"?${dir}/\*\*\"?[[:space:]]*$"
}

# Echo the workflow covering "$dir", or return 1. Convention first.
resolve_workflow() {
  local dir="$1" name="$2"
  local conventional=".github/workflows/${name}-tests.yml"
  if [ -f "$conventional" ]; then
    printf '%s\n' "$conventional"
    return 0
  fi
  local wf
  for wf in .github/workflows/*.yml .github/workflows/*.yaml; do
    [ -f "$wf" ] || continue
    workflow_paths_cover "$wf" "$dir" || continue
    workflow_runs_tests "$wf" || continue
    printf '%s\n' "$wf"
    return 0
  done
  return 1
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

  # Per-directory, NOT the global `fail`. This used to read `[ $fail -eq 0 ]`,
  # so one red directory silently suppressed the OK line of every directory
  # after it — the audit stopped reporting what it had actually verified at
  # precisely the moment someone needed to read it.
  local dir_ok=1

  local wf
  if ! wf="$(resolve_workflow "$dir" "$name")"; then
    note "$dir has no CI workflow. Expected: .github/workflows/${name}-tests.yml"
    printf '     Add a workflow that runs tests on %s/**, or point the trigger\n' "$dir" >&2
    printf '     paths filter of an existing workflow at it.\n' >&2
    return
  fi

  if ! workflow_paths_cover "$wf" "$dir"; then
    note "$wf exists but its \`paths:\` filter does not cover ${dir}/**"
    dir_ok=0
  fi

  if ! workflow_runs_tests "$wf"; then
    note "$wf does not run a recognised test command (pytest/vitest/jest/npm test)"
    dir_ok=0
  fi

  if ! has_test_suite "$dir"; then
    note "$dir has no test suite (looked for tests/test_*.py, *.test.ts(x), *.spec.ts, __tests__/)"
    dir_ok=0
  fi

  if [ "$dir_ok" -eq 1 ]; then
    ok "$dir ($kind) — covered by $wf"
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
  1. A workflow whose `paths:` filter covers the directory and that runs
     pytest/vitest/jest/npm test. Name it `.github/workflows/<name>-tests.yml`
     — that is the convention and the fast path. A workflow under any other
     name is accepted only if its own `on:` triggers path-filter on the
     directory (globs inside a job's dorny/paths-filter do NOT count).
  2. A test suite (tests/test_*.py, *.test.ts(x), *.spec.ts, or __tests__/).

To intentionally exempt a path, add it one-per-line to
`.github/ci-coverage-exempt` (lines starting with `#` are comments).

Rationale: see docs in this script's header.
EOF
  exit 1
fi

echo "All services and apps have CI coverage."
