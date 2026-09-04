#!/usr/bin/env bash
#
# check-test-wiring.sh — fail if a tracked shell test suite is run by NO
# workflow step and has not been explicitly declared developer-only.
#
# WARP-2647. WHY THIS EXISTS:
#   `tests/factory-reset-volume-wipe.test.sh` and
#   `tests/factory-reset-purge-scope.test.sh` are regression guards written
#   after two real factory-reset incidents (the WARP-605 project-name bug that
#   left a stale `pgdata` behind a "successful" reset, and the
#   `docker system prune -af` that would have deleted the sibling inference
#   images). Both passed locally for months and ran in NO workflow at all —
#   discovered by accident during PR #1970. A third,
#   `apps/orchestrator/scripts/migrate-and-start.test.sh` (33 assertions over
#   the guarded migration entrypoint, WARP-573), was found by this script.
#
#   `scripts/check-ci-coverage.sh` cannot catch this class: it audits
#   service/app directories against `<name>-tests.yml`, so a loose shell suite
#   that no workflow names is invisible to it. Root CLAUDE.md §9: anything that
#   can silently diverge gets an explicit drift gate, not trust.
#
# WHAT IT ENFORCES
#   1. Every tracked `*.test.sh` is named by at least one workflow `run:` line
#      (directly, or by a glob in a loop such as
#      `for t in tests/openwrt-attach-*.test.sh`), OR carries a
#      `# ci: developer-only — <reason>` line in its header.
#   2. `scripts/test/pytest/` is executed by some workflow (it is run as a
#      directory, so individual files need no separate wiring).
#   3. The two copies of the storage suite list — ci.yml's `storage` leg and
#      storage-pool-tests.yml's `storage-pool-unit` job — name the same
#      suites, so the manual-dispatch copy cannot drift from the PR-blocking
#      one.
#
# A `paths:` entry does NOT count as a runner. That distinction is the whole
# point: `tests/mqtt-mtls.integration.test.sh` is listed in setup-tests.yml's
# `paths:` (it makes another suite's anti-drift grep re-run) while nothing has
# ever executed it.
#
# TO SILENCE A SUITE DELIBERATELY, put this in its header (first 30 lines):
#   # ci: developer-only — <why it cannot run on a runner>
# Use it for suites that need a live Docker daemon, root, real block devices,
# or minutes of image pulls. Everything else gets a named CI step.
#
# Exit 0 when every suite is accounted for, 1 on any gap.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail=0
note() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; fail=1; }
ok()   { printf '\033[32m  OK\033[0m %s\n' "$*"; }
dev()  { printf '\033[33m DEV\033[0m %s\n' "$*"; }

WF_DIR=".github/workflows"

# ---------------------------------------------------------------------------
# Executable mentions: every workflow line that could actually RUN something.
#
# Dropped, in order: full-line comments; trailing ` # …` comments (a shell
# comment inside a `run:` block, and a YAML one everywhere else); `- name:` /
# `- uses:` step headers; and bare YAML list items, which is what a `paths:` or
# dorny/paths-filter entry looks like. What survives is `run:` content.
# ---------------------------------------------------------------------------
mentions_file="$(mktemp)"
trap 'rm -f "$mentions_file"' EXIT

# shellcheck disable=SC2016  # the $ in the character class is literal, not a var
sed -E \
  -e 's/^[[:space:]]*#.*$//' \
  -e 's/[[:space:]]#[[:space:]].*$//' \
  "$WF_DIR"/*.yml \
  | grep -vE '^[[:space:]]*-?[[:space:]]*(name|uses):' \
  | grep -vE '^[[:space:]]*-[[:space:]]*"?[A-Za-z0-9_./*@{}$()-]+"?[[:space:]]*$' \
  | grep -F '.sh' > "$mentions_file" || true

# Glob patterns that appear in a runner position, e.g.
# `for t in tests/openwrt-attach-*.test.sh; do`.
glob_patterns=()
while IFS= read -r pat; do
  [ -n "$pat" ] && glob_patterns+=("$pat")
done < <(grep -oE '[A-Za-z0-9_./-]*\*[A-Za-z0-9_./*-]*\.test\.sh' "$mentions_file" | sort -u)

is_wired() {
  local suite="$1" pat
  grep -qF -- "$suite" "$mentions_file" && return 0
  for pat in ${glob_patterns+"${glob_patterns[@]}"}; do
    # shellcheck disable=SC2254  # $pat is a glob on purpose
    case "$suite" in
      $pat) return 0 ;;
    esac
  done
  return 1
}

is_developer_only() {
  head -n 30 "$1" | grep -qE '^#[[:space:]]*ci:[[:space:]]*developer-only'
}

echo "Test-wiring audit (WARP-2647)"
echo "============================="

# ---------------------------------------------------------------------------
# 1. Every tracked shell suite.
# ---------------------------------------------------------------------------
#
# The enumeration is itself fail-closed. `git ls-files` inside a process
# substitution cannot fail the script (its exit status is discarded), so a
# broken checkout would leave this loop with nothing to iterate and the gate
# would report "everything is wired" — the exact silent-pass this file exists
# to prevent. Materialise the list first and refuse to continue if it is empty.
suites_file="$(mktemp)"
trap 'rm -f "$mentions_file" "$suites_file"' EXIT
if ! git ls-files ':(glob)**/*.test.sh' | sort > "$suites_file"; then
  note "git ls-files failed — cannot enumerate test suites; refusing to pass"
  exit 1
fi
if [ ! -s "$suites_file" ]; then
  note "no *.test.sh files found — the enumeration is broken, not the tree"
  exit 1
fi

unwired=()
while IFS= read -r suite; do
  if is_wired "$suite"; then
    ok "$suite"
  elif is_developer_only "$suite"; then
    dev "$suite — declared developer-only"
  else
    unwired+=("$suite")
  fi
done < "$suites_file"

for suite in ${unwired+"${unwired[@]}"}; do
  note "$suite is run by no workflow step and is not declared developer-only"
done

# ---------------------------------------------------------------------------
# 2. The pytest directory is run as a whole, so its files need no per-file
#    wiring — but something must still run the directory.
# ---------------------------------------------------------------------------
if [ -d scripts/test/pytest ]; then
  if grep -qE 'pytest[[:space:]]+.*scripts/test/pytest' "$WF_DIR"/*.yml; then
    ok "scripts/test/pytest/ (run as a directory)"
  else
    note "scripts/test/pytest/ exists but no workflow runs it"
  fi
fi

# ---------------------------------------------------------------------------
# 3. ci.yml's `storage` leg and storage-pool-tests.yml must name the same
#    suites. Two hand-maintained copies of one list is exactly the drift this
#    script exists to stop; storage-pool-tests.yml is dispatch-only, so a
#    divergence there is invisible until someone runs it by hand.
# ---------------------------------------------------------------------------
storage_leg_suites() {
  awk '/^  storage:/{inblock=1} inblock && /^  [a-z][a-z0-9-]*:/ && !/^  storage:/{inblock=0} inblock' \
    "$WF_DIR/ci.yml" | grep -oE 'tests/[A-Za-z0-9_.-]+\.test\.sh' | sort -u
}
storage_pool_suites() {
  grep -oE 'tests/[A-Za-z0-9_.-]+\.test\.sh' "$WF_DIR/storage-pool-tests.yml" | sort -u
}

if [ -f "$WF_DIR/storage-pool-tests.yml" ]; then
  diff_out="$(diff <(storage_leg_suites) <(storage_pool_suites) || true)"
  if [ -n "$diff_out" ]; then
    note "ci.yml's storage leg and storage-pool-tests.yml name different suites"
    printf '%s\n' "$diff_out" | sed 's/^/     /' >&2
    printf '     (< only in ci.yml storage leg, > only in storage-pool-tests.yml)\n' >&2
  else
    ok "storage suite list is identical in ci.yml and storage-pool-tests.yml"
  fi
fi

echo ""
if [ "$fail" -ne 0 ]; then
  cat >&2 <<'EOF'
Test-wiring check FAILED.

Every tracked *.test.sh must either:
  1. be named by a workflow `run:` step — put it on the existing job whose
     `paths:`/`detect` filter already covers the scripts it exercises, so it
     costs seconds on a job that was going to run anyway; or
  2. carry `# ci: developer-only — <reason>` in its first 30 lines, for suites
     that need a live Docker daemon, root, real block devices, or minutes of
     image pulls.

Do NOT add a new workflow or a new `pull_request:` trigger to a per-service
`*-tests.yml` to satisfy this — CI spend is capped (docs/ci-cost-budget.md).
EOF
  exit 1
fi

echo "Every shell test suite has a runner or a developer-only declaration."
