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
# check failed. Default mode runs six static checks in ~2 minutes. Adding
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
#   exec-bits             — WARP-487 class: tracked shell scripts that
#                           shipped to main with 100644 in the git index
#                           when they need 100755. Canonical invocation
#                           silently no-ops on platforms that honour the
#                           index mode bit.
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
# WARP-482, WARP-487.
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
  exec-bits
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
                        shellcheck, matter-env-allowlist, exec-bits,
                        docker-build-smoke
                      Useful for iterating on a single failure.

EXAMPLES
  ./scripts/test/ship-check.sh             # six static checks (~2min)
  ./scripts/test/ship-check.sh --full      # static + ubuntu smoke (~15min)
  ./scripts/test/ship-check.sh tsc-full    # only the tsc check
  ./scripts/test/ship-check.sh shellcheck  # only the shellcheck check
  ./scripts/test/ship-check.sh exec-bits   # only the exec-bits check

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

  exec-bits             Verify that every shell script the operator is
                        expected to invoke directly (scripts/setup.sh,
                        scripts/factory-reset.sh, scripts/test/ship-check.sh,
                        scripts/test/ship-check.test.sh) has the +x bit
                        set in the git index (mode 100755, not 100644).
                        Prevents: WARP-487 class — scripts/test/ship-check.sh
                        shipped to main as 100644, so the canonical
                        `./scripts/test/ship-check.sh` invocation in its own
                        --help text was a no-op on filesystems that honour
                        the index bit. The check reads `git ls-files --stage`,
                        so it works regardless of the working-tree mode
                        (which Windows can't track anyway).

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
  # Delegate to scripts/test-security.sh, which already encodes the
  # architecture-guard rule 11 invariant: NO MATTER_* env vars outside the
  # narrow allowlist (MATTER_STORAGE_PATH). The rationale is the matter.js
  # `VariableService` collision documented in apps/orchestrator/src/config.ts
  # and in test-security.sh's Test 7 docstring.
  #
  # We don't run the entire test-security.sh — that script has its own
  # pre-existing failures (e.g. WARP-165 run_docker_compose --env-file
  # accounting) which are out of WARP-482 scope. Instead we grep its
  # output for the specific MATTER_* allowlist line:
  #
  #   PASS  no MATTER_* env vars outside allowlist { MATTER_STORAGE_PATH }
  #
  # If that line is PASS, the allowlist invariant holds. If FAIL or
  # missing, the check fails and we surface enough output for the
  # operator to find the violation.
  local label="matter-env-allowlist"
  local security_sh="$REPO_ROOT/scripts/test-security.sh"

  if [ ! -f "$security_sh" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — scripts/test-security.sh not found\n" "$label"
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  # test-security.sh uses `set -e` and exits non-zero on any fail. We
  # tolerate that here because we only care about the MATTER line; capture
  # stdout+stderr so the diagnostic from the matter test reaches the
  # operator even when other tests fail.
  local out
  out="$(bash "$security_sh" 2>&1 || true)"

  # Walk for the canonical MATTER_* line. Both PASS and FAIL variants are
  # printed by test-security.sh; grep for both with `-E`.
  local matter_line
  matter_line="$(printf '%s\n' "$out" | grep -E '(PASS|FAIL)[[:space:]]+(no MATTER_\*|MATTER_\* env var)' | head -1 || true)"

  if [ -z "$matter_line" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — MATTER_* allowlist line missing from test-security.sh output\n" "$label"
    printf "    | (Has Test 7 changed shape? Check scripts/test-security.sh.)\n" >&2
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  if printf '%s' "$matter_line" | grep -q 'PASS'; then
    printf "  ${_GREEN}PASS${_RESET}  %s (delegated to scripts/test-security.sh)\n" "$label"
    CHECK_RESULTS[$label]=pass
    return 0
  fi

  printf "  ${_RED}FAIL${_RESET}  %s — MATTER_* env var found outside allowlist\n" "$label"
  # Replay enough of test-security.sh's output for the operator to find
  # the violation. The matter section is the last grouped block; tail -25
  # captures it plus the summary footer reliably.
  printf '%s\n' "$out" | tail -25 | sed 's/^/    | /' >&2
  printf "    | (Use DROPLET_MATTER_* prefix for new env vars — see\n" >&2
  printf "    |  apps/orchestrator/src/config.ts for full rationale.)\n" >&2
  CHECK_RESULTS[$label]=fail
  return 1
}

run_check_exec_bits() {
  # Verify that every shell script an operator invokes via its path
  # (./scripts/setup.sh, ./scripts/factory-reset.sh, the two ship-check
  # scripts) has the +x bit set in the git index — mode 100755, not
  # 100644.
  #
  # Why the INDEX mode, not the working-tree mode? Because the working-
  # tree bit is unreliable cross-platform: Windows filesystems don't
  # track it at all (every checkout reports the same default mode), and
  # Linux/macOS hosts can lose the bit if a script was edited via a
  # tool that wrote a fresh file in place. The git index mode is the
  # canonical signal — it's what other clones will receive on checkout,
  # and it's what `core.fileMode=false` operators rely on.
  #
  # The allowlist is intentionally narrow: only the scripts the
  # documentation tells an operator to invoke as `./scripts/<name>.sh`
  # need to be executable. Anything `bash`-invoked (most scripts under
  # scripts/lib/, every test helper) works regardless of the bit and
  # would only generate noise here.
  #
  # When you add a NEW operator-facing script, add its path to the
  # required list below AND set its index mode with
  # `git update-index --chmod=+x <path>` before pushing.
  #
  # Bug class this catches: WARP-487 — scripts/test/ship-check.sh +
  # scripts/test/ship-check.test.sh shipped to main (PR #266) with
  # mode 100644. `bash <path>` invocation worked, but the canonical
  # `./<path>` form documented in --help became a silent no-op (or
  # fell through to /bin/sh on hosts that respect the index bit).
  local label="exec-bits"

  # Scripts that MUST be executable in the git index. Add to this list
  # when a new operator-facing entry point lands; pair with
  # `git update-index --chmod=+x <path>`.
  local required=(
    "scripts/setup.sh"
    "scripts/factory-reset.sh"
    "scripts/test/ship-check.sh"
    "scripts/test/ship-check.test.sh"
  )

  local violations=""
  local missing_files=""
  local path stage_line mode
  for path in "${required[@]}"; do
    if [ ! -f "$REPO_ROOT/$path" ]; then
      missing_files+="    ${path}: file not present in worktree"$'\n'
      continue
    fi

    # `git ls-files --stage <path>` emits one line per tracked file:
    #   <mode> SP <object> SP <stage> TAB <path>
    # The first whitespace-separated column is the mode (octal).
    stage_line="$(cd "$REPO_ROOT" && git ls-files --stage -- "$path" 2>/dev/null || true)"
    if [ -z "$stage_line" ]; then
      missing_files+="    ${path}: not tracked by git"$'\n'
      continue
    fi
    # Parse column 1 (mode). awk handles tab + space mix robustly.
    mode="$(printf '%s' "$stage_line" | awk '{print $1}')"

    if [ "$mode" != "100755" ]; then
      violations+="    ${path}: mode ${mode} (expected 100755) — fix with: git update-index --chmod=+x ${path}"$'\n'
    fi
  done

  if [ -n "$missing_files" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — required script(s) missing or untracked\n" "$label"
    printf '%s' "$missing_files" >&2
    printf "    | Either restore the file(s) or update the required[] array\n" >&2
    printf "    | in run_check_exec_bits if the script was intentionally removed.\n" >&2
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  if [ -n "$violations" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — operator-facing script(s) missing +x in git index\n" "$label"
    printf '%s' "$violations" >&2
    printf "    | The working-tree bit is unreliable cross-platform; the INDEX\n" >&2
    printf "    | mode is the canonical signal. Run the suggested\n" >&2
    printf "    | git update-index --chmod=+x command(s) and re-commit.\n" >&2
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  printf "  ${_GREEN}PASS${_RESET}  %s (%d script(s) all 100755 in index)\n" "$label" "${#required[@]}"
  CHECK_RESULTS[$label]=pass
  return 0
}

run_check_docker_build_smoke() {
  # `--full` only. Spins up an Ubuntu 24.04 container, copies the repo
  # into it (NOT mount — avoids mutating the operator's tree), installs
  # the host-side prerequisites setup.sh expects (openssl, git, curl,
  # docker.io client + plugin), then runs:
  #
  #   ./scripts/setup.sh --skip-docker --skip-build --skip-start --skip-drivers
  #
  # The four skips together exercise the BASH layer end-to-end on a
  # vanilla Ubuntu LTS — env generation, secret materialization, library
  # sourcing, hostname validation, the whole phase 1/4/5 of setup.sh —
  # without requiring docker-in-docker or running the actual container
  # build (which would take 30+ min in CI and need a writable Docker
  # socket).
  #
  # Bugs this WILL catch:
  #   - WARP-446 class: KeyError-equivalent at script execution time.
  #   - WARP-329 class is already covered by tsc-full.
  #   - PR #263 set-u/RETURN-trap class: setup.sh phase 7/7 fails
  #     before the OpenWrt round-trip on a fresh Ubuntu (this is the
  #     literal failure mode from droplet-sys 2026-05-25).
  #   - Bash-version drift: a script that works on bash 5.2 (macOS via
  #     brew) but breaks on bash 5.1 (Ubuntu 22.04) or 5.2.21
  #     (Ubuntu 24.04 LTS default).
  #
  # Bugs this WILL NOT catch:
  #   - WARP-456 missing audit-key mount (manifests at container start
  #     via `docker compose up`).
  #   - WARP-229 missing FIPS opt-out env (same).
  #   Catching those requires a real `docker compose up` smoke — that's
  #   a separate follow-up ticket; this check is the BASH-LAYER
  #   counterpart.
  #
  # Why an Ubuntu 24.04 LTS image (not Alpine, not the latest tag)?
  #   - 24.04 is the supported target host for production Droplet boxes.
  #   - Pinning to LTS means the smoke test catches drift specifically
  #     against what real boxes run, not a moving Latest target.
  local label="docker-build-smoke"

  if ! command -v docker >/dev/null 2>&1; then
    printf "  ${_RED}FAIL${_RESET}  %s — docker not on PATH\n" "$label"
    CHECK_RESULTS[$label]=fail
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    printf "  ${_RED}FAIL${_RESET}  %s — docker daemon not reachable\n" "$label"
    printf "    | On macOS: start Docker Desktop.\n" >&2
    printf "    | On Linux: ensure /var/run/docker.sock is accessible.\n" >&2
    CHECK_RESULTS[$label]=fail
    return 1
  fi

  local image="ubuntu:24.04"
  # A predictable container name lets the trap target it even if the
  # docker run is mid-flight when we get SIGTERM.
  local container_name="droplet-ship-check-$$"

  # shellcheck disable=SC2064
  trap "docker rm -f '$container_name' >/dev/null 2>&1 || true" RETURN

  printf "  running %s (this may take 5-10 minutes)...\n" "$label"

  # The inner script runs INSIDE the Ubuntu container. We pipe it via
  # stdin so we don't have to write a second file. -y on apt-get keeps
  # it non-interactive; DEBIAN_FRONTEND=noninteractive suppresses the
  # tzdata-style prompts that otherwise block a fresh Ubuntu install.
  #
  # We deliberately DO NOT install docker.io inside the container — the
  # `--skip-docker` flag tells setup.sh to bypass `install_docker()`,
  # and the only call site of `detect_docker_sudo()` runs UNCONDITIONALLY
  # at phase 2 (even with --skip-docker). To get past that without a
  # real docker daemon, we plant a `docker` shim on PATH that responds
  # to `docker info` with exit 0. The shim is enough to satisfy
  # detect_docker_sudo's preflight; nothing in the --skip-start /
  # --skip-build / --skip-drivers paths actually invokes docker
  # afterward.
  local inner_script
  inner_script=$(cat <<'INNER'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends \
  bash openssl git curl ca-certificates rsync sudo >/dev/null

# setup.sh refuses to run as root (preflight check), so we create a
# normal user with passwordless sudo and drop privileges before running
# the script. Mirrors the real-device path: an operator on Ubuntu does
# NOT run setup as root; they run as their own account with sudo.
useradd -m -s /bin/bash droplet-test
echo 'droplet-test ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/droplet-test
chmod 440 /etc/sudoers.d/droplet-test

# Plant a docker shim that satisfies setup.sh's detect_docker_sudo. The
# shim must be exec'able by droplet-test (not just root) — /usr/local/bin
# is on the default PATH for both users so a chmod 755 suffices.
#
# The shim is an EXPLICIT ALLOWLIST: only the docker subcommands that
# setup.sh's `--skip-docker --skip-build --skip-start --skip-drivers`
# path actually invokes are cased. Any other subcommand hits the
# default `exit 1` and fails the smoke. This is intentionally
# fail-CLOSED so a future setup.sh change that introduces e.g.
# `docker pull`, `docker version`, `docker buildx ls` etc. trips the
# smoke check loudly instead of silently passing on the shim. See
# CR #1 on PR #266 for the original fail-open bug rationale.
#
# When you add a real new docker call to setup.sh's --skip-* path,
# you MUST add a corresponding case here with a one-line comment
# explaining what return value setup.sh's caller expects.
cat > /usr/local/bin/docker <<'SHIM'
#!/bin/sh
# Allowlisted docker subcommands for the ship-check smoke path.
case "$1" in
  # `detect_docker_sudo` (scripts/lib/docker.sh) calls `docker info`
  # unconditionally even when --skip-docker is set. exit 0 lets it
  # conclude "daemon reachable, no sudo needed" and move on.
  info)
    exit 0
    ;;
  # `_generate_mosquitto_passwd` (scripts/lib/secrets.sh) does a
  # `docker run --rm eclipse-mosquitto:2 ...` to bcrypt-hash the MQTT
  # password. exit 1 forces the plaintext fallback branch, which is
  # the pre-Docker code path and the right thing for a no-real-daemon
  # smoke test (the success branch would crash on "file not written"
  # because the shim doesn't actually produce the output file).
  run)
    exit 1
    ;;
  # `_generate_tls_cert` (scripts/lib/secrets.sh) probes for a running
  # gateway via `docker compose -f … ps --services --filter status=running`
  # and then pipes to `grep -qx gateway`. Returning exit 0 with no
  # stdout makes the grep fail, the surrounding `if` short-circuits,
  # and `docker compose exec gateway nginx -s reload` never runs.
  # That's the desired behaviour for a fresh smoke container where
  # no gateway is up.
  compose)
    exit 0
    ;;
  # Fail-closed default. Any new docker subcommand setup.sh starts
  # invoking must be added to the allowlist above with an explicit
  # return-value rationale, or this smoke test will catch it.
  *)
    echo "ship-check docker shim: unhandled docker subcommand '$1' (add to allowlist if intentional)" >&2
    exit 1
    ;;
esac
SHIM
chmod 755 /usr/local/bin/docker

# /repo is the read-only host bind-mount. setup.sh writes .env, the
# secrets/ tree, and .data/.setup.lock — none of which can land on the
# operator's host tree. Copy into a writable workdir using rsync (skip
# node_modules + .git + .next to keep the copy under 30s even on slow
# disks). git-related setup.sh steps don't run with our --skip set, so
# we don't need .git for this smoke.
mkdir -p /work
rsync -a \
  --exclude '/node_modules' \
  --exclude '**/node_modules' \
  --exclude '/.git' \
  --exclude '/.next' \
  --exclude '/apps/*/.next' \
  --exclude '/.data' \
  /repo/ /work/
chown -R droplet-test:droplet-test /work

# Run setup.sh as droplet-test with every skip — we exercise the script
# LAYER (preflight + secrets + env materialization + hostname validation
# + sourcing) without touching docker, builds, or the LAN. ROUTING_MODE
# = disabled stops local-dns.sh from trying to register with a router
# that doesn't exist inside the container.
su - droplet-test -c '
  cd /work && \
  ROUTING_MODE=disabled \
  bash ./scripts/setup.sh \
    --skip-docker \
    --skip-build \
    --skip-start \
    --skip-drivers
'
INNER
)

  # Both-and cleanup: --rm on `docker run` is the SIGKILL safety net (the
  # RETURN trap above doesn't fire on SIGKILL or on a shell kill -9, so
  # without --rm a kill-9'd ship-check leaks the container until the next
  # `docker rm -f`); the named-container + RETURN-trap path is the
  # normal-exit cleanup that survives across re-runs and lets us target
  # the container by name if --rm somehow races on cleanup. Resolves
  # CR #2 on PR #266.
  #
  # MSYS_NO_PATHCONV=1 is necessary when this script runs under Git Bash
  # on Windows: MSYS auto-rewrites POSIX-looking paths in command args
  # into Windows form (`/repo` becomes `C:/Program Files/Git/repo`),
  # which mangles the `-v <src>:<dst>:<opts>` syntax. On Linux/macOS
  # the variable is unset and ignored. See
  #   https://github.com/moby/moby/issues/24029#issuecomment-292499324
  local out rc
  out="$(MSYS_NO_PATHCONV=1 docker run \
    --rm \
    --name "$container_name" \
    -v "$REPO_ROOT:/repo:ro" \
    "$image" \
    bash -c "$inner_script" 2>&1)"
  rc=$?

  if [ "$rc" -eq 0 ]; then
    printf "  ${_GREEN}PASS${_RESET}  %s (setup.sh ran clean on %s)\n" "$label" "$image"
    CHECK_RESULTS[$label]=pass
    return 0
  fi

  printf "  ${_RED}FAIL${_RESET}  %s — setup.sh failed inside %s (exit %d)\n" "$label" "$image" "$rc"
  # Tail the output (head 80 lines is enough to see the failure phase
  # and the immediate context; full output is reproducible by hand).
  printf '%s\n' "$out" | tail -80 | sed 's/^/    | /' >&2
  CHECK_RESULTS[$label]=fail
  return 1
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
    exec-bits)            run_check_exec_bits ;;
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
