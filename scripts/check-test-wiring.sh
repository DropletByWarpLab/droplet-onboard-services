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
#   1. Every tracked shell test suite is EXECUTED by at least one workflow
#      `run:` step — `bash <suite>`, `./<suite>`, or a `for … in <list>` whose
#      loop variable the same block then runs — OR carries a
#      `# ci: developer-only — <reason>` line in its header.
#   2. `scripts/test/pytest/` is executed by some workflow (it is run as a
#      directory, so individual files need no separate wiring).
#   3. The two copies of the storage suite list — ci.yml's `storage` leg and
#      storage-pool-tests.yml's `storage-pool-unit` job — name the same
#      suites, so the manual-dispatch copy cannot drift from the PR-blocking
#      one.
#
# BEING NAMED IS NOT BEING RUN. Two ways a suite can be mentioned all over
# .github/workflows/ and still never execute an assertion, both of which this
# gate rejects:
#   * a `paths:` entry. `tests/mqtt-mtls.integration.test.sh` is listed in
#     setup-tests.yml's `paths:` (it makes another suite's anti-drift grep
#     re-run) while nothing has ever executed it.
#   * a lint pass — `shellcheck <suite>`, `bash -n <suite>`. Those steps are
#     real and worth having; this repo runs several of them beside the runner
#     steps. They just are not runs, and a gate that accepted them would go
#     green the day someone replaced the `bash` line with the `shellcheck`
#     one.
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
# Runner targets: the paths a workflow step actually EXECUTES.
#
# Naming a suite is not running it. `shellcheck tests/x.test.sh` and
# `bash -n tests/x.test.sh` both name the file and neither runs one assertion
# in it — and this repo has real lint-only steps sitting right beside real
# runner steps (droplet-watchdog-tests.yml shellchecks
# scripts/host/usr-local-sbin/droplet-net-selfheal two lines above the step
# that runs that backstop's suite). Under a plain substring match the runner
# line could be swapped for the lint line and this gate would stay green, so
# the audit is driven off a parse instead: walk every `run:` block and keep
# only paths that appear as the target of an interpreter (bash/sh/dash/zsh/
# ksh, minus `-n` and `-c`, neither of which executes a named file) or as a
# `./…` / `/…` invocation.
#
# Loop lists get the same treatment, and only the same treatment: the items
# of `for t in <list>; do` count when — and only when — the same block goes
# on to execute "$t". `for f in <list>; do shellcheck "$f"; done` harvests
# nothing. That arm is what made this gate trivially widenable before: glob
# patterns were scraped from the whole mentions file and applied to every
# suite, so one well-meant lint line anywhere under .github/workflows/ could
# mark every suite in a directory as wired.
#
# A `paths:` entry has never counted and still does not — it is not a `run:`
# block. `tests/mqtt-mtls.integration.test.sh` is listed in setup-tests.yml's
# `paths:` (it makes another suite's anti-drift grep re-run) while nothing
# has ever executed it.
# ---------------------------------------------------------------------------
runners_file="$(mktemp)"
trap 'rm -f "$runners_file"' EXIT

unquote() {
  local s="$1"
  s="${s#\"}"; s="${s%\"}"
  s="${s#\'}"; s="${s%\'}"
  printf '%s' "$s"
}

# One command between `;`, `&&`, `||`, `|` or `&`. Prints the path it runs,
# if it runs one; records loop variables that get executed.
handle_segment() {
  local seg="$1"
  local -a tok=()
  read -r -a tok <<<"$seg" || true
  [ "${#tok[@]}" -gt 0 ] || return 0

  # Skip the words that can precede a command without being one.
  local i=0
  while [ "$i" -lt "${#tok[@]}" ]; do
    case "${tok[$i]}" in
      if|then|elif|else|while|until|do|sudo|time|command|exec|eval|'!'|'{'|'(')
        i=$((i + 1)) ;;
      [A-Za-z_]*=*) i=$((i + 1)) ;;   # a leading VAR=value assignment
      *) break ;;
    esac
  done
  [ "$i" -lt "${#tok[@]}" ] || return 0

  local cmd="${tok[$i]}"
  case "${cmd##*/}" in
    for)
      # `for VAR in ITEM …` — remembered, emitted later only if "$VAR" runs.
      [ "${tok[$((i + 2))]:-}" = "in" ] || return 0
      local var list="" j=$((i + 3))
      var="${tok[$((i + 1))]}"
      while [ "$j" -lt "${#tok[@]}" ]; do
        [ "${tok[$j]}" = "do" ] && break
        list="$list $(unquote "${tok[$j]}")"
        j=$((j + 1))
      done
      loop_names+=("$var")
      loop_lists+=("$list")
      ;;
    bash|sh|dash|zsh|ksh)
      local target="" noexec=0 j=$((i + 1))
      while [ "$j" -lt "${#tok[@]}" ]; do
        case "${tok[$j]}" in
          --) target="${tok[$((j + 1))]:-}"; break ;;
          --*) : ;;                     # long options take no script argument
          -*[nc]*) noexec=1 ;;          # -n syntax-checks, -c runs a string
          -*) : ;;
          *) target="${tok[$j]}"; break ;;
        esac
        j=$((j + 1))
      done
      [ "$noexec" -eq 0 ] || return 0
      [ -n "$target" ] || return 0
      target="$(unquote "$target")"
      case "$target" in
        '$'*)
          target="${target#\$}"; target="${target#\{}"; target="${target%\}}"
          exec_vars="$exec_vars$target " ;;
        *) printf '%s\n' "$target" ;;
      esac
      ;;
    *)
      case "$cmd" in
        ./*|/*) case "$cmd" in *.sh) printf '%s\n' "$(unquote "$cmd")" ;; esac ;;
      esac
      ;;
  esac
}

# One `run:` block, its physical lines in block_lines.
emit_block() {
  local -a loop_names=() loop_lists=() logical=() segs=()
  local exec_vars=" " joined="" line seg item i
  [ "${#block_lines[@]}" -gt 0 ] || return 0

  # Fold backslash continuations, so a multi-line `for t in … \` list is one
  # logical command.
  for line in "${block_lines[@]}"; do
    line="${line%"${line##*[![:space:]]}"}"
    if [ "${line: -1}" = '\' ]; then
      joined="$joined${line%\\} "
      continue
    fi
    logical+=("$joined$line")
    joined=""
  done
  [ -z "$joined" ] || logical+=("$joined")

  for line in ${logical+"${logical[@]}"}; do
    IFS=';&|' read -r -a segs <<<"$line" || true
    for seg in ${segs+"${segs[@]}"}; do
      handle_segment "$seg"
    done
  done

  i=0
  while [ "$i" -lt "${#loop_names[@]}" ]; do
    case "$exec_vars" in
      *" ${loop_names[$i]} "*)
        for item in ${loop_lists[$i]}; do
          printf '%s\n' "$item"
        done ;;
    esac
    i=$((i + 1))
  done
}

harvest_runner_targets() {
  local f raw rest ws in_block key_col
  # A YAML block scalar header: |, |-, |+, >, >-, >+, |2 …
  local block_scalar_re='^[|>][0-9]*[-+]?$'
  for f in "$WF_DIR"/*.yml; do
    in_block=0
    key_col=0
    block_lines=()
    # Same comment stripping as everywhere else here: a whole-line `#` (YAML
    # or shell) and a trailing ` # …`.
    while IFS= read -r raw; do
      if [ "$in_block" -eq 1 ]; then
        if [ -z "${raw//[[:space:]]/}" ]; then continue; fi
        ws="${raw%%[![:space:]]*}"
        if [ "${#ws}" -gt "$key_col" ]; then
          block_lines+=("$raw")
          continue
        fi
        in_block=0
        emit_block
      fi
      if [[ "$raw" =~ ^([[:space:]]*(-[[:space:]]+)?)run:[[:space:]]*(.*)$ ]]; then
        key_col="${#BASH_REMATCH[1]}"
        rest="${BASH_REMATCH[3]}"
        rest="${rest%"${rest##*[![:space:]]}"}"
        block_lines=()
        if [ -z "$rest" ] || [[ "$rest" =~ $block_scalar_re ]]; then
          in_block=1
        else
          block_lines=("$rest")
          emit_block
        fi
      fi
    done < <(sed -E -e 's/^[[:space:]]*#.*$//' -e 's/[[:space:]]#[[:space:]].*$//' "$f")
    if [ "$in_block" -eq 1 ]; then emit_block; fi
  done
}

block_lines=()
harvest_runner_targets | sort -u > "$runners_file"

if [ ! -s "$runners_file" ]; then
  note "no executed script found in $WF_DIR — the harvest is broken, not the tree"
  exit 1
fi

is_wired() {
  local suite="$1" target
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    [ "$target" = "$suite" ] && return 0
    case "$target" in
      *'*'*)
        # shellcheck disable=SC2254  # $target is a glob on purpose
        case "$suite" in
          $target) return 0 ;;
        esac ;;
    esac
  done < "$runners_file"
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
trap 'rm -f "$runners_file" "$suites_file"' EXIT
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

Every tracked shell test suite must either:
  1. be EXECUTED by a workflow `run:` step — `bash <suite>`, `./<suite>`, or a
     `for … in <list>` whose loop variable the block runs. Put it on the
     existing job whose `paths:`/`detect` filter already covers the scripts it
     exercises, so it costs seconds on a job that was going to run anyway.
     A `shellcheck` or `bash -n` pass over the file does NOT count: neither
     runs an assertion, so neither can hold the guard up. Nor does a `paths:`
     entry; or
  2. carry `# ci: developer-only — <reason>` in its first 30 lines, for suites
     that need a live Docker daemon, root, real block devices, or minutes of
     image pulls.

Do NOT add a new workflow or a new `pull_request:` trigger to a per-service
`*-tests.yml` to satisfy this — CI spend is capped (docs/ci-cost-budget.md).
EOF
  exit 1
fi

echo "Every shell test suite has a runner or a developer-only declaration."
