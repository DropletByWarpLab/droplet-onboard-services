#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — Ship Check
# =============================================================================
#
# Canonical local validation gate. Run this BEFORE every push that touches:
#   - a Dockerfile or compose file
#   - any docker/frigate/*.yml
#   - any scripts/*.sh or scripts/lib/*.sh
#   - any apps/*/src or services/*/src TypeScript that ships in a container
#
# Each check independently passes or fails. The script exits non-zero if any
# check failed. Default mode runs five static checks in ~2 minutes. Adding
# `--full` runs an additional Ubuntu-container docker-build smoke test that
# takes ~10-15 minutes.
#
# Each check exists because a specific bug class shipped to a real device and
# wedged it during factory-reset. The check names map to the underlying class:
#
#   tsc-full              — WARP-329 class: tsc errors in test files or src
#                           that npm run dev silently skips but Docker build
#                           catches.
#   compose-config        — YAML breakage in docker/docker-compose.yml or
#                           missing env-var references.
#   frigate-env-scan      — WARP-446 class: committed docker/frigate/config.yml
#                           referencing operator-specific env vars (KeyError
#                           on first boot).
#   shellcheck            — local-dns.sh class: bash bugs caught by static
#                           analysis (parse errors, quoting, declared-but-
#                           unused vars).
#   matter-env-allowlist  — architecture-guard rule 11: MATTER_* env vars
#                           outside the allowlist crash matter.js controller
#                           init. Delegates to scripts/test-security.sh.
#   docker-build-smoke    — (--full only) End-to-end ./scripts/setup.sh
#                           --skip-docker in an Ubuntu 24.04 container.
#                           Catches WARP-456 (missing audit-key mount) and
#                           WARP-229 (missing FIPS opt-out env) which only
#                           manifest at container start.
#
# Exit codes:
#   0  all run checks passed
#   1  one or more checks failed
#   2  invalid CLI args or required tool missing
#   3  setup precondition failure (not in a git repo, etc.)
#
# WARP-482.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Honour REPO_ROOT if the caller (typically the test harness) has already
# pointed us at a synthetic worktree; otherwise resolve relative to this
# script. Exporting it lets sub-processes (npm, docker compose, etc.) see
# the same value.
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
export REPO_ROOT

# --- Colors ---
if [ -t 1 ]; then
  _GREEN='\033[0;32m'
  _RED='\033[0;31m'
  _YELLOW='\033[0;33m'
  _BOLD='\033[1m'
  _RESET='\033[0m'
else
  _GREEN=''; _RED=''; _YELLOW=''; _BOLD=''; _RESET=''
fi

# --- Check registry ---
# Order matters: cheapest first so the operator sees fast-fail signal early.
ALL_CHECKS=(
  tsc-full
  compose-config
  frigate-env-scan
  shellcheck
  matter-env-allowlist
)
FULL_ONLY_CHECKS=(
  docker-build-smoke
)

# Per-check result tracking. Keys = check name, values = "pass"/"fail"/"skip".
declare -A CHECK_RESULTS=()

usage() {
  cat <<'USAGE'
Usage: ./scripts/test/ship-check.sh [OPTIONS] [CHECK_NAME]

Canonical local validation gate. Catches the bug classes that shipped during
the May 2026 droplet-sys factory-reset (PRs #261, #263). Run BEFORE every
push that touches Dockerfile / compose / scripts / orchestrator TypeScript.

OPTIONS
  --full              Also run --full-only checks (docker-build-smoke, ~15min)
  -h, --help          Show this help and the full check list

SUBCOMMAND
  CHECK_NAME          Run only the named check. One of:
                        tsc-full, compose-config, frigate-env-scan,
                        shellcheck, matter-env-allowlist,
                        docker-build-smoke
                      Useful for iterating on a single failure.

EXAMPLES
  ./scripts/test/ship-check.sh             # five static checks (~2min)
  ./scripts/test/ship-check.sh --full      # static + ubuntu smoke (~15min)
  ./scripts/test/ship-check.sh tsc-full    # only the tsc check
  ./scripts/test/ship-check.sh shellcheck  # only the shellcheck check

CHECKS

  tsc-full              Run `npx tsc --noEmit` in every workspace that ships
                        a Dockerfile (orchestrator, web-dashboard, tools-core,
                        mcp-server, fips-selftest). Prisma generate runs first
                        so orchestrator's `@prisma/client` import resolves.
                        Prevents: WARP-329 class — test fixtures missing
                        required fields that `npm run dev` skips but the
                        Dockerfile's `npm run build` catches.

  compose-config        Run `docker compose config --quiet` against
                        docker/docker-compose.yml using .env.example (falls
                        back to .env). Catches YAML breakage, missing
                        required env var refs, and malformed service defs.

  frigate-env-scan      Parse docker/frigate/config.yml for every {VAR}
                        substitution outside comments and assert each one
                        resolves against .env.example, secrets.sh, or the
                        frigate service env block in docker-compose.yml.
                        Prevents: WARP-446 class — front_door: block
                        referencing FRIGATE_CAMERA_FRONT_DOOR_PASSWORD that
                        was never seeded, KeyError-crashing Frigate at boot.

  shellcheck            Run shellcheck on scripts/setup.sh,
                        scripts/factory-reset.sh, and scripts/lib/*.sh at
                        warning severity. Requires shellcheck on PATH; the
                        script FAILS (not skips) if it is missing — install
                        it before you ship.

  matter-env-allowlist  Delegate to scripts/test-security.sh, which already
                        enforces the architecture-guard rule 11 (MATTER_*
                        env vars outside the narrow allowlist collide with
                        matter.js's auto-imported VariableService and crash
                        controller init).

  docker-build-smoke    (--full only) Spin up an Ubuntu 24.04 container,
                        mount the repo read-only, run
                        ./scripts/setup.sh --skip-docker end-to-end. Asserts
                        exit 0. Catches the EVERY bug class above PLUS
                        WARP-456 (missing audit-key mount) and WARP-229
                        (missing FIPS opt-out env) because those manifest at
                        boot, not at build.

WHY THIS SCRIPT EXISTS

  Five distinct bugs shipped to droplet-sys (192.168.1.87) during a single
  factory-reset on 2026-05-25 because none of them surface under
  `npm run dev` / `vitest`:

    PR #261 (WARP-329)  tsc errors in chat-persistence.service.test.ts
                        fixtures — npm run dev skips test compilation.
    PR #263 (4 fixes)   missing audit-key mount + missing FIPS opt-out env
                        + Frigate KeyError on operator-specific env + bash
                        set -u RETURN trap on local-dns.sh.

  All five were admin-merged (bypassing harness). This script is the
  per-developer gate that should have failed BEFORE those PRs were drafted.
USAGE
}

# =============================================================================
# Check implementations (stubs — filled in by subsequent commits, WARP-482).
# =============================================================================

run_check_tsc_full() {
  # Mirror the orchestrator Dockerfile's exact build order. The relevant
  # bug class (WARP-329) was a TS2322 in a test fixture that only `tsc`
  # caught — `npm run dev` skips test compilation. Walking each workspace
  # with `tsc --noEmit` reproduces what `RUN npm run build` does inside
  # the container.
  #
  # Order matters: dependent workspaces (orchestrator, mcp-server) need
  # tools-core + fips-selftest BUILT (not just type-checked) so their
  # @droplet/* imports resolve. We emit dist/ for those leaf packages
  # and noEmit-check the consumers.
  local label="tsc-full"
  local rc=0
  local out

  # Phase 1: prisma generate (orchestrator's @prisma/client must reflect
  # the current schema or every Prisma-typed call site shows TS2305).
  if [ -d "$REPO_ROOT/apps/orchestrator/prisma" ]; then
    if ! out="$(cd "$REPO_ROOT/apps/orchestrator" && npx prisma generate 2>&1)"; then
      printf "  ${_RED}FAIL${_RESET}  %s — prisma generate failed\n" "$label"
      printf '%s\n' "$out" | sed 's/^/    | /' >&2
      CHECK_RESULTS[$label]=fail
      return 1
    fi
  fi

  # Phase 2: build leaf workspaces so their dist + .d.ts exist for
  # downstream type resolution. These are the same RUN steps the
  # orchestrator Dockerfile executes.
  local leaf_pkg
  for leaf_pkg in @droplet/tools-core @droplet/fips-selftest @droplet/mcp-server; do
    if ! out="$(cd "$REPO_ROOT" && npm run -w "$leaf_pkg" build 2>&1)"; then
      printf "  ${_RED}FAIL${_RESET}  %s — %s build failed\n" "$label" "$leaf_pkg"
      printf '%s\n' "$out" | tail -40 | sed 's/^/    | /' >&2
      CHECK_RESULTS[$label]=fail
      return 1
    fi
  done

  # Phase 3: noEmit-check every workspace with a tsconfig.json. Keeps the
  # check ~3x faster than `npm run build` everywhere (no .d.ts/.js write).
  local ws
  local failed_workspaces=()
  for ws in apps/orchestrator apps/web-dashboard packages/tools-core packages/fips-selftest services/mcp-server; do
    if [ ! -f "$REPO_ROOT/$ws/tsconfig.json" ]; then
      continue
    fi
    if ! out="$(cd "$REPO_ROOT/$ws" && npx tsc --noEmit 2>&1)"; then
      failed_workspaces+=("$ws")
      printf "  ${_RED}FAIL${_RESET}  %s — tsc errors in %s\n" "$label" "$ws"
      printf '%s\n' "$out" | head -20 | sed 's/^/    | /' >&2
      local extra
      extra=$(printf '%s\n' "$out" | wc -l)
      if [ "$extra" -gt 20 ]; then
        printf "    | (... %d more lines suppressed; cd %s && npx tsc --noEmit)\n" \
          "$((extra - 20))" "$ws" >&2
      fi
      rc=1
    fi
  done

  if [ "$rc" -ne 0 ]; then
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  printf "  ${_GREEN}PASS${_RESET}  %s (5 workspaces)\n" "$label"
  CHECK_RESULTS[$label]=pass
  return 0
}

run_check_compose_config() {
  local label="compose-config"
  local compose="$REPO_ROOT/docker/docker-compose.yml"

  if [ ! -f "$compose" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — %s not found\n" "$label" "$compose"
    CHECK_RESULTS[$label]=fail
    return 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    printf "  ${_RED}FAIL${_RESET}  %s — docker not on PATH (required for `compose config`)\n" "$label"
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  # Prefer .env.example (lives in the repo, no operator secrets). Fall back
  # to .env, which is .gitignored but present on a provisioned device.
  local env_file=""
  if [ -f "$REPO_ROOT/.env.example" ]; then
    env_file="$REPO_ROOT/.env.example"
  elif [ -f "$REPO_ROOT/.env" ]; then
    env_file="$REPO_ROOT/.env"
  else
    printf "  ${_RED}FAIL${_RESET}  %s — neither .env.example nor .env found at repo root\n" "$label"
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  local out
  if ! out="$(docker compose -f "$compose" --env-file "$env_file" config --quiet 2>&1)"; then
    printf "  ${_RED}FAIL${_RESET}  %s — `docker compose config` rejected the merged tree\n" "$label"
    printf '%s\n' "$out" | sed 's/^/    | /' >&2
    printf "    | (env-file used: %s)\n" "${env_file#$REPO_ROOT/}" >&2
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  printf "  ${_GREEN}PASS${_RESET}  %s (env-file: %s)\n" "$label" "${env_file#$REPO_ROOT/}"
  CHECK_RESULTS[$label]=pass
  return 0
}

run_check_frigate_env_scan() {
  # Walk docker/frigate/config.yml line by line, strip comments, then capture
  # every `{NAME}` Python-format substitution. Cross-reference each name
  # against three known-good sources:
  #
  #   1. .env.example keys           (canonical operator-facing env catalogue)
  #   2. scripts/lib/secrets.sh keys (boot-time heredoc; always written into
  #                                   .env by a fresh setup.sh run)
  #   3. The frigate service's `environment:` block in docker-compose.yml
  #      (covers static FRIGATE_MQTT_HOST/PORT and any compose-injected vars
  #      that never appear in .env.example)
  #
  # Any {NAME} that resolves nowhere is the WARP-446 class — Frigate's
  # str.format substitution at boot will KeyError and the container restart-
  # loops the whole stack.
  local label="frigate-env-scan"
  local cfg="$REPO_ROOT/docker/frigate/config.yml"
  local env_example="$REPO_ROOT/.env.example"
  local secrets_sh="$REPO_ROOT/scripts/lib/secrets.sh"
  local compose="$REPO_ROOT/docker/docker-compose.yml"

  if [ ! -f "$cfg" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — %s not found\n" "$label" "$cfg"
    CHECK_RESULTS[$label]=fail
    return 1
  fi
  if [ ! -f "$env_example" ] && [ ! -f "$REPO_ROOT/.env" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — neither .env.example nor .env found at repo root\n" "$label"
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  # Build the known-good set: union of env-file keys, secrets.sh keys, and
  # the frigate environment: block in docker-compose.yml. One name per line
  # so `grep -Fx` can match cleanly.
  #
  # Comment-stripping limitation: `sed 's/#.*$//'` correctly handles the
  # current frigate config (all # markers are leading or follow whitespace),
  # but would false-positive on hash chars inside a string value. Frigate
  # YAML for our use-case never quotes such strings — credentials come via
  # env, paths don't contain hashes. Documented for future maintainers.
  local known_names
  known_names="$(
    {
      # 1. .env.example (preferred — checked into repo).
      if [ -f "$env_example" ]; then
        sed 's/#.*$//' "$env_example" \
          | grep -oE '^[A-Z_][A-Z0-9_]*=' \
          | sed 's/=$//'
      fi
      # 2. scripts/lib/secrets.sh — the boot-time heredoc writes these
      #    into .env every fresh provisioning, so they're always present
      #    at Frigate start time on a real device.
      if [ -f "$secrets_sh" ]; then
        sed 's/#.*$//' "$secrets_sh" \
          | grep -oE '^[[:space:]]*[A-Z_][A-Z0-9_]*=' \
          | sed -E 's/^[[:space:]]+//; s/=$//'
      fi
      # 3. Frigate service `environment:` block in docker-compose.yml.
      #    Extracts the env keys from the lines between `frigate:` and
      #    the next top-level service. Captures both `KEY=value` and
      #    `KEY=${OTHER:-default}` forms.
      if [ -f "$compose" ]; then
        awk '
          /^  frigate:[[:space:]]*$/ { in_frigate=1; next }
          in_frigate && /^  [a-z]/    { in_frigate=0 }
          in_frigate && /^[[:space:]]+- [A-Z_][A-Z0-9_]*=/ {
            sub(/^[[:space:]]+-[[:space:]]+/, "")
            sub(/=.*$/, "")
            print
          }
        ' "$compose"
      fi
    } | sort -u
  )"

  # Extract every {NAME} reference outside comments. Each line gets its
  # comment portion stripped, then we grep-only the matches and dedupe.
  # We also keep file:line context so a violation report can point at the
  # exact offender.
  local matches
  matches="$(
    awk '
      {
        # Strip everything from the first `#` onward — handles leading
        # comments and inline comments alike.
        sub(/#.*$/, "")
        line=$0
        # Pull every {NAME} substring out, NAME-only (no braces).
        while (match(line, /\{[A-Z_][A-Z0-9_]*\}/)) {
          name = substr(line, RSTART+1, RLENGTH-2)
          printf "%d:%s\n", NR, name
          line = substr(line, RSTART + RLENGTH)
        }
      }
    ' "$cfg"
  )"

  if [ -z "$matches" ]; then
    printf "  ${_GREEN}PASS${_RESET}  %s (no {VAR} substitutions in config)\n" "$label"
    CHECK_RESULTS[$label]=pass
    return 0
  fi

  # Cross-reference each match against the known set. `grep -Fx` does an
  # exact full-line match so e.g. FRIGATE_MQTT_USER doesn't accidentally
  # match FRIGATE_MQTT_USERNAME.
  local violations=""
  local lineno name
  while IFS=: read -r lineno name; do
    [ -n "$name" ] || continue
    if ! printf '%s\n' "$known_names" | grep -Fxq "$name"; then
      violations+="    docker/frigate/config.yml:${lineno}: unresolved {${name}}"$'\n'
    fi
  done <<< "$matches"

  if [ -z "$violations" ]; then
    local ref_count
    ref_count="$(printf '%s\n' "$matches" | wc -l | tr -d ' ')"
    printf "  ${_GREEN}PASS${_RESET}  %s (%d reference(s) all resolved)\n" "$label" "$ref_count"
    CHECK_RESULTS[$label]=pass
    return 0
  fi

  printf "  ${_RED}FAIL${_RESET}  %s — frigate config references env vars no source seeds\n" "$label"
  printf '%s' "$violations" >&2
  printf "    | Frigate substitutes at boot via Python str.format — unresolved\n" >&2
  printf "    | refs raise KeyError and the container restart-loops the stack.\n" >&2
  printf "    | Either remove the offending block from docker/frigate/config.yml\n" >&2
  printf "    | or seed the variable in scripts/lib/secrets.sh / .env.example.\n" >&2
  CHECK_RESULTS[$label]=fail
  return 1
}

run_check_shellcheck() {
  # Run shellcheck across the three high-blast-radius script sets:
  #   - scripts/setup.sh           (single-entry-point installer)
  #   - scripts/factory-reset.sh   (wipe-and-restart path)
  #   - scripts/lib/*.sh           (sourced helpers — every check pulls
  #                                 these in transitively)
  #
  # Severity is `warning`, which includes the `error` band (SC2168
  # "local outside function" — the very class of bug that escaped review
  # in scripts/factory-reset.sh before WARP-482 fixed it).
  #
  # Excludes (apply ONLY to the pre-existing baseline; new code should
  # not earn an exclude without a follow-up ticket to remove it):
  #
  #   SC2034 — appears unused. Several lib scripts declare variables
  #            (SKIP_DOCKER_INSTALL, DOCKER_GROUP_ADDED,
  #            DI_DEFAULT_SEALING_PCRS) for sourcing scripts to read;
  #            shellcheck can't trace cross-file usage and flags them
  #            even though they're load-bearing.
  #   SC2024 — sudo doesn't affect redirects. local-dns.sh uses
  #            `sudo … >>"$LOG_FILE"` where LOG_FILE is operator-owned
  #            and writable; the redirect runs as the calling user,
  #            which is the intended behaviour (don't chown LOG_FILE
  #            to root just to silence shellcheck).
  #   SC2155 — declare and assign separately. Pre-existing in
  #            secrets.sh (two sites) and camera-drivers.sh. Genuine
  #            cleanup but out of scope for WARP-482; flagged for
  #            follow-up.
  #
  # If shellcheck is missing from PATH the check FAILs (NOT skips) —
  # the operator needs to install it before the gate is meaningful.
  local label="shellcheck"

  if ! command -v shellcheck >/dev/null 2>&1; then
    printf "  ${_RED}FAIL${_RESET}  %s — shellcheck not on PATH\n" "$label"
    printf "    | Install: \n" >&2
    printf "    |   macOS:        brew install shellcheck\n" >&2
    printf "    |   Debian/Ubuntu: sudo apt-get install -y shellcheck\n" >&2
    printf "    |   Arch:         sudo pacman -S shellcheck\n" >&2
    printf "    | This check FAILS (not skips) by design — the gate must\n" >&2
    printf "    | catch the local-dns.sh class of regressions, and that\n" >&2
    printf "    | requires shellcheck running.\n" >&2
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  # Build the target list. Glob expands lib/*.sh against the real tree;
  # if any of these files is missing it's a setup precondition issue and
  # shellcheck will surface it loudly.
  local targets=()
  local file
  for file in "$REPO_ROOT/scripts/setup.sh" "$REPO_ROOT/scripts/factory-reset.sh"; do
    if [ -f "$file" ]; then
      targets+=("$file")
    fi
  done
  if [ -d "$REPO_ROOT/scripts/lib" ]; then
    for file in "$REPO_ROOT"/scripts/lib/*.sh; do
      [ -f "$file" ] && targets+=("$file")
    done
  fi

  if [ "${#targets[@]}" -eq 0 ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — no target scripts found\n" "$label"
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  # SC2024 + SC2155 + SC2034 excluded per the docstring above. -x means
  # follow `source` directives so cross-file undeclared-var detection
  # works. --external-sources keeps it from bailing on dynamic-path
  # sources that we can't statically resolve (the `source "$libdir/x"`
  # pattern in setup.sh).
  local out rc
  out="$(shellcheck \
    --severity=warning \
    --exclude=SC2034,SC2024,SC2155 \
    --external-sources \
    "${targets[@]}" 2>&1)"
  rc=$?

  if [ "$rc" -eq 0 ]; then
    printf "  ${_GREEN}PASS${_RESET}  %s (%d script(s))\n" "$label" "${#targets[@]}"
    CHECK_RESULTS[$label]=pass
    return 0
  fi

  printf "  ${_RED}FAIL${_RESET}  %s — shellcheck flagged warning(s) in scripts\n" "$label"
  printf '%s\n' "$out" | head -40 | sed 's/^/    | /' >&2
  local total
  total=$(printf '%s\n' "$out" | wc -l)
  if [ "$total" -gt 40 ]; then
    printf "    | (... %d more lines suppressed; run shellcheck --severity=warning directly)\n" \
      "$((total - 40))" >&2
  fi
  CHECK_RESULTS[$label]=fail
  return 1
}

run_check_matter_env_allowlist() {
  printf "  ${_YELLOW}SKIP${_RESET}  matter-env-allowlist (not yet implemented)\n"
  CHECK_RESULTS[matter-env-allowlist]=skip
  return 0
}

run_check_docker_build_smoke() {
  printf "  ${_YELLOW}SKIP${_RESET}  docker-build-smoke (not yet implemented)\n"
  CHECK_RESULTS[docker-build-smoke]=skip
  return 0
}

# =============================================================================
# Dispatch
# =============================================================================

# Map a check name to its function. Returns 2 if the name is unknown so the
# subcommand path can exit cleanly with the documented invalid-args code.
_dispatch_check() {
  case "$1" in
    tsc-full)             run_check_tsc_full ;;
    compose-config)       run_check_compose_config ;;
    frigate-env-scan)     run_check_frigate_env_scan ;;
    shellcheck)           run_check_shellcheck ;;
    matter-env-allowlist) run_check_matter_env_allowlist ;;
    docker-build-smoke)   run_check_docker_build_smoke ;;
    *)
      printf "${_RED}error:${_RESET} unknown check '%s'\n" "$1" >&2
      printf "  Available: %s %s\n" "${ALL_CHECKS[*]}" "${FULL_ONLY_CHECKS[*]}" >&2
      return 2
      ;;
  esac
}

# Render the summary block. Exit code = number of FAIL results (capped at 1).
_summarize() {
  local pass=0 fail=0 skip=0 name result
  printf "\n"
  printf "  ──────────────────────────────────\n"
  for name in "${!CHECK_RESULTS[@]}"; do
    result="${CHECK_RESULTS[$name]}"
    case "$result" in
      pass) pass=$((pass + 1)) ;;
      fail) fail=$((fail + 1)) ;;
      skip) skip=$((skip + 1)) ;;
    esac
  done
  printf "  ${_GREEN}Passed: %d${_RESET}" "$pass"
  if [ "$fail" -gt 0 ]; then
    printf "  ${_RED}Failed: %d${_RESET}" "$fail"
  fi
  if [ "$skip" -gt 0 ]; then
    printf "  ${_YELLOW}Skipped: %d${_RESET}" "$skip"
  fi
  printf "\n"
  printf "  ──────────────────────────────────\n\n"

  if [ "$fail" -gt 0 ]; then
    printf "${_RED}FAILED${_RESET} checks:\n" >&2
    for name in "${!CHECK_RESULTS[@]}"; do
      if [ "${CHECK_RESULTS[$name]}" = "fail" ]; then
        printf "  - %s\n" "$name" >&2
      fi
    done
    return 1
  fi
  return 0
}

main() {
  # Parse args. Supports `--help`, `--full`, single subcommand, or nothing.
  local run_full=false
  local single_check=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        usage
        return 0
        ;;
      --full)
        run_full=true
        shift
        ;;
      --)
        shift
        ;;
      -*)
        printf "${_RED}error:${_RESET} unknown option '%s'\n" "$1" >&2
        usage >&2
        return 2
        ;;
      *)
        if [ -n "$single_check" ]; then
          printf "${_RED}error:${_RESET} only one CHECK_NAME may be passed\n" >&2
          return 2
        fi
        single_check="$1"
        shift
        ;;
    esac
  done

  # Precondition: we must be in a git repo so REPO_ROOT resolution is honest.
  if [ ! -d "$REPO_ROOT/.git" ] && [ ! -f "$REPO_ROOT/.git" ]; then
    printf "${_RED}error:${_RESET} %s is not a git repo\n" "$REPO_ROOT" >&2
    return 3
  fi

  printf "\n  ${_BOLD}Droplet ship-check${_RESET}  (repo: %s)\n" "$REPO_ROOT"
  printf "  ──────────────────────────────────\n"

  if [ -n "$single_check" ]; then
    _dispatch_check "$single_check"
    local rc=$?
    if [ "$rc" -eq 2 ]; then
      return 2
    fi
    _summarize
    return $?
  fi

  local name
  for name in "${ALL_CHECKS[@]}"; do
    _dispatch_check "$name" || true
  done
  if [ "$run_full" = "true" ]; then
    for name in "${FULL_ONLY_CHECKS[@]}"; do
      _dispatch_check "$name" || true
    done
  fi

  _summarize
}

main "$@"
