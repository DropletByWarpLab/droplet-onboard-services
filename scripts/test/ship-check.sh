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
# check failed. Default mode runs the static checks (see ALL_CHECKS) in
# ~2 minutes. Adding
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
#   stale-repo-names      — WARP-494 class: user-facing surfaces (README,
#                           service READMEs, TESTING.md, code comments,
#                           top-level scripts/*.sh, docker-compose.yml)
#                           accumulating references to the LEGACY repo
#                           names `inference-engine` / `droplet-jetson-ai`
#                           after both renamed on the canonical remote.
#                           Allowlists `inference-engine.local` (mDNS
#                           hostname) and the docker-compose project-name
#                           explanation block.
#   lifecycle-naming      — ADR-018 / architecture-guard rule 17: every
#                           Droplet box is the SHIPPING PRODUCT, so NO
#                           `poc`/`prototype`/`-dev`/`-test` framing in
#                           user-facing surfaces (compose profile names,
#                           env-var names, CLI flags, service/file names,
#                           log strings). Repo-wide net (docker-compose.yml,
#                           .env.example, scripts/*.sh, scripts/lib/*.sh).
#                           Grandfathers ONLY the legacy identifier the
#                           WARP-445 on-box migration cleanup must keep
#                           naming (scripts/lib/single-box.sh) — fails on
#                           any NEW occurrence.
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
#   4  the harness itself COULD NOT RUN (interpreter too old). Deliberately
#      distinct from 1 so no caller can read "never executed" as "executed
#      and passed" -- see the bash version floor below (WARP-2449).
#
# WARP-482, WARP-487, WARP-494.
# =============================================================================
set -euo pipefail

# --- Bash version floor (WARP-2449) ------------------------------------------
# This script is written to the feature set of bash 3.2 -- the version macOS has
# shipped since 2007 and, for GPLv3 licensing reasons, will never update. That
# is a deliberate constraint, not an accident: this script IS the pre-PR gate
# that .claude/skills/preflight/SKILL.md and docs/integrations/ADD-A-PROVIDER.md
# mandate, so it has to be runnable on the primary dev Mac. For months it was
# not: associative arrays (the bash-4-only `-A` option to `declare`) made it die
# at line 115 with a raw `declare: -A: invalid option`, so the documented gate
# was silently skipped by everyone who followed the docs exactly.
#
# The floor is ASSERTED rather than assumed, so the next edit that reaches for a
# newer builtin fails with an actionable sentence instead of a builtin error. If
# you introduce a dependency on a newer bash, raise MIN_BASH_MAJOR/MIN_BASH_MINOR
# in the SAME commit -- never leave the floor lying about what the script needs.
EXIT_CANNOT_RUN=4
MIN_BASH_MAJOR=3
MIN_BASH_MINOR=2
_bash_major="${BASH_VERSINFO[0]:-0}"
_bash_minor="${BASH_VERSINFO[1]:-0}"
if [ "$_bash_major" -lt "$MIN_BASH_MAJOR" ] ||
   { [ "$_bash_major" -eq "$MIN_BASH_MAJOR" ] && [ "$_bash_minor" -lt "$MIN_BASH_MINOR" ]; }; then
  printf 'error: ship-check.sh COULD NOT RUN -- it requires bash %s.%s or newer.\n' \
    "$MIN_BASH_MAJOR" "$MIN_BASH_MINOR" >&2
  printf '       Interpreter in use: %s\n' "${BASH_VERSION:-not bash}" >&2
  printf '       macOS ships bash 3.2.57 as /bin/bash and cannot upgrade it in place.\n' >&2
  printf '       Install a current bash and put it ahead of /bin on PATH:\n' >&2
  printf '\n' >&2
  printf '         brew install bash\n' >&2
  printf '\n' >&2
  printf '       Exit code %s means COULD NOT RUN. It is deliberately different from\n' "$EXIT_CANNOT_RUN" >&2
  printf '       exit 1 ("ran, a check failed"), so this can never be mistaken for a\n' >&2
  printf '       gate that passed.\n' >&2
  exit "$EXIT_CANNOT_RUN"
fi

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
  compose-env-shadow
  frigate-env-scan
  shellcheck
  matter-env-allowlist
  exec-bits
  stale-repo-names
  lifecycle-naming
  image-pipeline
  tls-invariants
)
FULL_ONLY_CHECKS=(
  docker-build-smoke
)

# Per-check result tracking. Two parallel indexed arrays rather than one
# associative array: bash 3.2 (the stock macOS interpreter, see the version
# floor above) has no associative arrays, and this script has to run there.
# CHECK_RESULT_NAMES[i] is the check name, CHECK_RESULT_VALUES[i] its
# "pass"/"fail"/"skip". Iteration order is therefore insertion order, which is
# ALL_CHECKS order -- deterministic, unlike an associative array's hash order.
CHECK_RESULT_NAMES=()
CHECK_RESULT_VALUES=()

# Upsert one check's result. Linear scan: the registry is a dozen entries and
# each check records exactly once, so the cost is noise next to running tsc.
_record_result() {
  local name="$1" value="$2" i
  for ((i = 0; i < ${#CHECK_RESULT_NAMES[@]}; i++)); do
    if [ "${CHECK_RESULT_NAMES[$i]}" = "$name" ]; then
      CHECK_RESULT_VALUES[$i]="$value"
      return 0
    fi
  done
  CHECK_RESULT_NAMES+=("$name")
  CHECK_RESULT_VALUES+=("$value")
}

# Membership test for the small per-line allowlists further down. $1 is the
# key, $2 a newline-delimited list of keys. Whole-line, literal match (the key
# is quoted inside the case pattern, so glob metacharacters in a path cannot
# widen it), and an empty list correctly matches nothing.
_allowlisted() {
  local key="$1" list="$2"
  case $'\n'"$list" in
    *$'\n'"$key"$'\n'*) return 0 ;;
  esac
  return 1
}

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
                        stale-repo-names, lifecycle-naming,
                        image-pipeline, tls-invariants, docker-build-smoke
                      Useful for iterating on a single failure.

EXAMPLES
  ./scripts/test/ship-check.sh             # all static checks (~2min)
  ./scripts/test/ship-check.sh --full      # static + ubuntu smoke (~15min)
  ./scripts/test/ship-check.sh tsc-full    # only the tsc check
  ./scripts/test/ship-check.sh shellcheck  # only the shellcheck check
  ./scripts/test/ship-check.sh exec-bits   # only the exec-bits check
  ./scripts/test/ship-check.sh stale-repo-names  # only the repo-name sweep

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
                        scripts/factory-reset.sh, scripts/camera-drivers.sh,
                        scripts/install-device-bridge.sh,
                        scripts/test/ship-check.sh,
                        scripts/test/ship-check.test.sh,
                        openwrt/scripts/upgrade-router.sh) has the +x bit
                        set in the git index (mode 100755, not 100644).
                        The rule: any script whose docs tell operators to
                        run it as `./<path>/<name>.sh` (or
                        `sudo ./<path>/<name>.sh`) belongs on this list,
                        regardless of which sub-tree it lives under
                        (top-level `scripts/`, `scripts/test/`, or
                        `openwrt/scripts/`).
                        Prevents: WARP-487 class — scripts/test/ship-check.sh
                        shipped to main as 100644, so the canonical
                        `./scripts/test/ship-check.sh` invocation in its own
                        --help text was a no-op on filesystems that honour
                        the index bit. WARP-489 extended the sweep to
                        openwrt/scripts/upgrade-router.sh (same bug class,
                        different sub-tree). The check reads
                        `git ls-files --stage`, so it works regardless of
                        the working-tree mode (which Windows can't track
                        anyway).

  stale-repo-names      Walk a curated set of user-facing surfaces
                        (README.md, services/*/README.md,
                        services/*/TESTING.md, scripts/*.sh,
                        apps/orchestrator/src/**/*.ts,
                        services/ai-gateway/**/*.py,
                        services/voice-io/**/*.py,
                        docker/docker-compose.yml) and FAIL on any
                        reference to the LEGACY repo names
                        `inference-engine` or `droplet-jetson-ai`.
                        Both were renamed on the canonical
                        DropletByWarpLab remote to `droplet-local-LLM`;
                        the GitHub redirect keeps the old URLs alive
                        but every stale doc/comment ref drifts the
                        codebase further from the canonical name.
                        Allowlist: the mDNS hostname
                        `inference-engine.local` (lives in
                        scripts/lib/secrets.sh — real DNS, not a repo
                        name), the docker-compose.yml project-name
                        explanation block (lines 6-10), the
                        `droplet-*` compose container-name
                        labels referenced by `docker exec` in
                        scripts/verify.sh + services/voice-io/TESTING.md
                        and the
                        `com.docker.compose.project=droplet`
                        label in services/ops-console/README.md — all
                        of those are tied to the live compose project
                        name (`droplet`). docs/ + ADRs + specs + plans + CLAUDE.md
                        are exempt by design (historical record /
                        intentional dual-name documentation).
                        Prevents: WARP-494 class — a developer adding a
                        "see related repo" note and reaching for the
                        old name out of habit, silently re-introducing
                        a stale reference that ships to a customer.

  lifecycle-naming      Walk the user-facing surfaces (docker-compose.yml,
                        .env.example, top-level scripts/*.sh, scripts/lib/*.sh)
                        and FAIL on any NEW `poc`/`prototype` token (whole
                        word, case-insensitive) or `-dev`/`-test`/`-prototype`
                        framing used as a compose profile entry,
                        COMPOSE_PROFILES= value, or --flag. Every Droplet box
                        is the shipping product (architecture-guard rule 17 +
                        ADR-018), so surfaces are named by what the deployment
                        IS, not its lifecycle stage. Grandfathers ONE tracked
                        exception (NOT silent): the legacy
                        `droplet-poc-host-net` identifier, which the WARP-445
                        on-box migration cleanup in scripts/lib/single-box.sh
                        must keep naming until no pre-rename box remains
                        (matched as a substring so it survives line moves).
                        Prevents: ADR-018 §13 class — a new `profiles: [poc]`,
                        `COMPOSE_PROFILES=poc`, `setup.sh --poc`, or
                        `droplet-poc-*` service shipping to a customer box.

  image-pipeline        WARP-663 / ADR-020 appliance image pipeline. Asserts
                        scripts/build-image.sh is NOT the historical TODO stub
                        (it must dispatch to scripts/image/build-iso.sh),
                        scripts/image/manifest.schema.json is valid JSON, the
                        tracked sample scripts/image/manifest.json validates
                        against it (via gen-manifest.py's stdlib validator),
                        and shellcheck passes on the new pipeline scripts
                        (build-image.sh, droplet-image, build-iso.sh,
                        lib/image.sh). Does NOT run a real ISO build or flash —
                        those are the documented manual Linux/hardware gate.

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
  #
  # Pinned to the orchestrator workspace's `db:generate` script (WARP-492).
  # The script body is `prisma generate`; npm resolves it through the
  # workspace's `node_modules/.bin/prisma`, which is the `^5.14.0` pin
  # declared in apps/orchestrator/package.json. The earlier form
  # (`npx prisma generate`) silently fetched the LATEST published prisma
  # (7.x at time of writing) off the npm registry whenever no local
  # node_modules tree was present — and prisma 7 rejects this schema with
  # P1012 ("datasource property `url` is no longer supported"), wedging
  # ship-check on a fresh worktree. The `npm run -w` form fails LOUDLY
  # ("prisma is not recognized" / "Missing script") when node_modules is
  # missing instead of misleading the operator with a phantom P1012.
  if [ -d "$REPO_ROOT/apps/orchestrator/prisma" ]; then
    if ! out="$(cd "$REPO_ROOT" && npm run -w @droplet/orchestrator db:generate 2>&1)"; then
      printf "  ${_RED}FAIL${_RESET}  %s — prisma generate failed\n" "$label"
      printf '%s\n' "$out" | sed 's/^/    | /' >&2
      _record_result "$label" fail
      return 1
    fi
  fi

  # Phase 2: build leaf workspaces so their dist + .d.ts exist for
  # downstream type resolution. These are the same RUN steps the
  # orchestrator Dockerfile executes.
  local leaf_pkg
  for leaf_pkg in @droplet/erp-connector @droplet/tools-core @droplet/fips-selftest @droplet/mcp-server; do
    if ! out="$(cd "$REPO_ROOT" && npm run -w "$leaf_pkg" build 2>&1)"; then
      printf "  ${_RED}FAIL${_RESET}  %s — %s build failed\n" "$label" "$leaf_pkg"
      printf '%s\n' "$out" | tail -40 | sed 's/^/    | /' >&2
      _record_result "$label" fail
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
    _record_result "$label" fail
    return 1
  fi

  printf "  ${_GREEN}PASS${_RESET}  %s (5 workspaces)\n" "$label"
  _record_result "$label" pass
  return 0
}

run_check_compose_config() {
  local label="compose-config"
  local compose="$REPO_ROOT/docker/docker-compose.yml"

  if [ ! -f "$compose" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — %s not found\n" "$label" "$compose"
    _record_result "$label" fail
    return 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    printf "  ${_RED}FAIL${_RESET}  %s — docker not on PATH (required for `compose config`)\n" "$label"
    _record_result "$label" fail
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
    _record_result "$label" fail
    return 1
  fi

  local out
  if ! out="$(docker compose -f "$compose" --env-file "$env_file" config --quiet 2>&1)"; then
    printf "  ${_RED}FAIL${_RESET}  %s — `docker compose config` rejected the merged tree\n" "$label"
    printf '%s\n' "$out" | sed 's/^/    | /' >&2
    printf "    | (env-file used: %s)\n" "${env_file#$REPO_ROOT/}" >&2
    _record_result "$label" fail
    return 1
  fi

  printf "  ${_GREEN}PASS${_RESET}  %s (env-file: %s)\n" "$label" "${env_file#$REPO_ROOT/}"
  _record_result "$label" pass
  return 0
}

run_check_compose_env_shadow() {
  # WARP-1863 — a credential re-declared as `- X=${X:-}` in a service that ALSO
  # has `env_file:` is a self-shadow, and it can only ever SUBTRACT.
  #
  # compose resolves `${...}` against the project .env beside the compose file
  # (or whatever `--env-file` names), which is NOT the same file as `env_file:`.
  # When that substitution source lacks the key it yields "", and because
  # `environment:` outranks `env_file:` the empty string overwrites a perfectly
  # good value compose had already loaded. WARP-1860 was exactly this: the
  # rag-eval bearer went blank on both ends and 15 consecutive nightly evals
  # 401'd on every query while reporting success.
  #
  # Scoped deliberately:
  #   - CREDENTIALS only. Non-secrets with real defaults (${TZ:-UTC},
  #     ${LOG_LEVEL:-INFO}) are intentional; there are ~200 self-shadows in
  #     total and failing on all of them would be noise, not a gate.
  #   - EMPTY default only (`:-}`). A non-empty default is a deliberate choice.
  #   - Services WITH env_file only. Services without one (routing, switch,
  #     matter-controller, ops-console — the host-network services) have NO
  #     other delivery path, so for them the substitution is required, not a
  #     bug. Removing it there breaks them outright.
  local label="compose-env-shadow"
  local compose="$REPO_ROOT/docker/docker-compose.yml"

  if [ ! -f "$compose" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — %s not found\n" "$label" "$compose"
    _record_result "$label" fail
    return 1
  fi

  # Walk with a service cursor: the same line can be legitimate in one service
  # and a defect in another, so a repo-wide grep cannot decide this.
  local offenders
  offenders="$(awk '
    /^  [a-z0-9_-]+:[[:space:]]*$/ { svc=$1; sub(/:$/,"",svc); has_ef=0; next }
    /^    env_file:/               { has_ef=1; next }
    {
      line=$0
      gsub(/^[[:space:]]+|[[:space:]]+$/,"",line)
      if (has_ef && line ~ /^- [A-Z_][A-Z0-9_]*=\$\{[A-Z_][A-Z0-9_]*:-\}$/) {
        k=line; sub(/^- /,"",k); sub(/=.*/,"",k)
        v=line; sub(/^.*\$\{/,"",v); sub(/:-\}$/,"",v)
        if (k == v && (k ~ /^SERVICE_TOKEN_/ || k ~ /_TOKEN$/ || k ~ /_SECRET$/ || k ~ /_PASSWORD$/ || k ~ /_KEY$/))
          printf "    %s: %s\n", svc, k
      }
    }
  ' "$compose")"

  if [ -n "$offenders" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — credential self-shadow(s) that env_file already delivers:\n" "$label"
    printf '%s\n' "$offenders"
    printf "        Each resolves against the project .env, NOT the env_file above it.\n"
    printf "        If that file lacks the key the value becomes \"\" and OVERWRITES the\n"
    printf "        real one (WARP-1860). Delete the line — env_file already carries it.\n"
    _record_result "$label" fail
    return 1
  fi

  printf "  ${_GREEN}PASS${_RESET}  %s — no credential is shadowed by an empty substitution\n" "$label"
  _record_result "$label" pass
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
    _record_result "$label" fail
    return 1
  fi
  if [ ! -f "$env_example" ] && [ ! -f "$REPO_ROOT/.env" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — neither .env.example nor .env found at repo root\n" "$label"
    _record_result "$label" fail
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
      #    into .env every fresh provisioning, so they are always present
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
    _record_result "$label" pass
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
    _record_result "$label" pass
    return 0
  fi

  printf "  ${_RED}FAIL${_RESET}  %s — frigate config references env vars no source seeds\n" "$label"
  printf '%s' "$violations" >&2
  printf "    | Frigate substitutes at boot via Python str.format — unresolved\n" >&2
  printf "    | refs raise KeyError and the container restart-loops the stack.\n" >&2
  printf "    | Either remove the offending block from docker/frigate/config.yml\n" >&2
  printf "    | or seed the variable in scripts/lib/secrets.sh / .env.example.\n" >&2
  _record_result "$label" fail
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
  # NO GLOBAL EXCLUDES. Every waiver lives as a per-line
  # `# shellcheck disable=SCxxxx` directive inline at the offending
  # site, with a one-line comment explaining WHY the warning is wrong
  # for THAT specific line. Audit trail: WARP-486 converted the legacy
  # global --exclude=SC2034,SC2024,SC2155 blanket (which masked NEW
  # violations of those codes in NEW lib code as well as the original
  # baseline) into per-line directives. The convention is now: any
  # waiver must be explicit, reviewable, and localized.
  #
  # If you need to add a NEW disable: put it on the line immediately
  # above the offender, with a one-line comment explaining the
  # rationale. If the same code triggers on 4+ sites in one file with
  # uniform rationale, a single file-level disable at the top of the
  # file (below the shebang) is acceptable — but most cases warrant
  # per-line for localization.
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
    _record_result "$label" fail
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
    _record_result "$label" fail
    return 1
  fi

  # No global --exclude flags (see WARP-486 — every waiver is a per-line
  # directive inline at the offending site). --external-sources follows
  # `source` directives so cross-file undeclared-var detection works AND
  # so the analyzer doesn't bail on dynamic-path sources we can't
  # statically resolve (the `source "$libdir/x"` pattern in setup.sh).
  local out rc
  out="$(shellcheck \
    --severity=warning \
    --external-sources \
    "${targets[@]}" 2>&1)"
  rc=$?

  if [ "$rc" -eq 0 ]; then
    printf "  ${_GREEN}PASS${_RESET}  %s (%d script(s))\n" "$label" "${#targets[@]}"
    _record_result "$label" pass
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
  _record_result "$label" fail
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
    _record_result "$label" fail
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
    _record_result "$label" fail
    return 1
  fi

  if printf '%s' "$matter_line" | grep -q 'PASS'; then
    printf "  ${_GREEN}PASS${_RESET}  %s (delegated to scripts/test-security.sh)\n" "$label"
    _record_result "$label" pass
    return 0
  fi

  printf "  ${_RED}FAIL${_RESET}  %s — MATTER_* env var found outside allowlist\n" "$label"
  # Replay enough of test-security.sh's output for the operator to find
  # the violation. The matter section is the last grouped block; tail -25
  # captures it plus the summary footer reliably.
  printf '%s\n' "$out" | tail -25 | sed 's/^/    | /' >&2
  printf "    | (Use DROPLET_MATTER_* prefix for new env vars — see\n" >&2
  printf "    |  apps/orchestrator/src/config.ts for full rationale.)\n" >&2
  _record_result "$label" fail
  return 1
}

run_check_exec_bits() {
  # Verify that every shell script an operator invokes via its path
  # (./scripts/setup.sh, ./scripts/factory-reset.sh,
  # ./scripts/camera-drivers.sh, ./scripts/install-device-bridge.sh,
  # the two ship-check scripts, openwrt/scripts/upgrade-router.sh) has
  # the +x bit set in the git index — mode 100755, not 100644.
  #
  # Why the INDEX mode, not the working-tree mode? Because the working-
  # tree bit is unreliable cross-platform: Windows filesystems don't
  # track it at all (every checkout reports the same default mode), and
  # Linux/macOS hosts can lose the bit if a script was edited via a
  # tool that wrote a fresh file in place. The git index mode is the
  # canonical signal — it's what other clones will receive on checkout,
  # and it's what `core.fileMode=false` operators rely on.
  #
  # The allowlist is intentionally narrow but covers EVERY operator-
  # facing entry point: the rule is that any script whose documentation
  # tells an operator to invoke it as `./<path>/<name>.sh` (or
  # `sudo ./<path>/<name>.sh`) must be on the list — regardless of which
  # sub-tree it lives under (top-level `scripts/`, `scripts/test/`, or
  # `openwrt/scripts/`). Anything `bash`-invoked (most scripts under
  # scripts/lib/, every test helper) works regardless of the bit and
  # would only generate noise here.
  #
  # When you add a NEW operator-facing script, add its path to the
  # required list below AND set its index mode with
  # `git update-index --chmod=+x <path>` before pushing. When you add
  # a `./<path>/<name>.sh` invocation to documentation (README,
  # docs/*.md, a service README), audit whether that script is already
  # on the list — same bug class, same fix.
  #
  # Bug class this catches: WARP-487 — scripts/test/ship-check.sh +
  # scripts/test/ship-check.test.sh shipped to main (PR #266) with
  # mode 100644. `bash <path>` invocation worked, but the canonical
  # `./<path>` form documented in --help became a silent no-op (or
  # fell through to /bin/sh on hosts that respect the index bit).
  # QA on that same PR uncovered scripts/camera-drivers.sh and
  # scripts/install-device-bridge.sh shipped with the same 100644 bug;
  # both are now on the allowlist below. WARP-489 extended the same
  # sweep to openwrt/scripts/upgrade-router.sh — proving the allowlist
  # is path-keyed (not basename-keyed) and works across sub-trees.
  local label="exec-bits"

  # Scripts that MUST be executable in the git index. Add to this list
  # when a new operator-facing entry point lands; pair with
  # `git update-index --chmod=+x <path>`.
  local required=(
    "scripts/setup.sh"
    "scripts/factory-reset.sh"
    "scripts/camera-drivers.sh"
    "scripts/install-device-bridge.sh"
    "scripts/test/ship-check.sh"
    "scripts/test/ship-check.test.sh"
    "openwrt/scripts/upgrade-router.sh"
    # WARP-663 / ADR-020 — operator-facing appliance-image entry points.
    # `droplet-image` is the CLI dispatcher; build-image.sh / build-iso.sh /
    # gen-manifest.py are invoked as `./<path>` per docs/IMAGE_PIPELINE.md.
    "scripts/droplet-image"
    "scripts/build-image.sh"
    "scripts/image/build-iso.sh"
    "scripts/image/gen-manifest.py"
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
    _record_result "$label" fail
    return 1
  fi

  if [ -n "$violations" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — operator-facing script(s) missing +x in git index\n" "$label"
    printf '%s' "$violations" >&2
    printf "    | The working-tree bit is unreliable cross-platform; the INDEX\n" >&2
    printf "    | mode is the canonical signal. Run the suggested\n" >&2
    printf "    | git update-index --chmod=+x command(s) and re-commit.\n" >&2
    _record_result "$label" fail
    return 1
  fi

  printf "  ${_GREEN}PASS${_RESET}  %s (%d script(s) all 100755 in index)\n" "$label" "${#required[@]}"
  _record_result "$label" pass
  return 0
}

run_check_stale_repo_names() {
  # Walk a curated set of user-facing surfaces and FAIL on any reference
  # to the LEGACY repo names `inference-engine` or `droplet-jetson-ai`.
  # Both were renamed on the canonical DropletByWarpLab remote — the
  # canonical names are `droplet-local-LLM` (inference) and
  # `droplet-onboard-services` (intelligence / this repo). The GitHub
  # URL redirect still serves the old names, but every stale ref drifts
  # documentation further from the canonical name and eventually has to
  # be cleaned up by an audit pass. WARP-494 turns that audit into a
  # static gate.
  #
  # COVERED SURFACES (curated — not the whole tree):
  #   README.md
  #   services/*/README.md
  #   services/*/TESTING.md
  #   scripts/*.sh                  (top-level scripts/, NOT scripts/lib/)
  #   apps/orchestrator/src/**/*.ts
  #   services/ai-gateway/**/*.py
  #   services/voice-io/**/*.py
  #   docker/docker-compose.yml
  #
  # NOT covered (intentional exemptions):
  #   docs/                — historical record (ADRs, specs, plans,
  #                          superpowers, agentic-workflows.md). Stale
  #                          refs are an accurate record of what the doc
  #                          said when it was written.
  #   CLAUDE.md            — intentionally documents BOTH names so the
  #                          architecture-guard skill can teach the
  #                          rename to fresh assistants.
  #   scripts/lib/         — secrets.sh:83,124 reference the mDNS
  #                          hostname `inference-engine.local`, which is
  #                          a hostname (not a repo name) — also covered
  #                          by the inference-engine.local allowlist
  #                          below for the cases where the same string
  #                          appears in a covered surface.
  #   package.json /       — workspace identifiers; not user-facing
  #     package-lock.json     surface.
  #   node_modules/ /      — transient, never tracked.
  #     dist/ / .next/
  #
  # PER-LINE ALLOWLIST (file:line — exempt the literal occurrence):
  #   docker/docker-compose.yml:7,10
  #       The project-name explanation comment ("Explicit project name so
  #       containers don't collide with the sibling `droplet-jetson-ai`
  #       repo...") AND the `name: droplet` directive. The
  #       directive itself is load-bearing — every running container's
  #       name is prefixed `droplet-*`, and changing it would
  #       orphan every existing operator's data volumes + restart
  #       loops.
  #   scripts/verify.sh:161,164
  #       `docker exec droplet-voice-io-1 …` — container
  #       name is compose-derived (project-name + service + replica), so
  #       tied to the docker-compose.yml `name:` directive above.
  #   services/voice-io/TESTING.md:171
  #       Same `docker exec droplet-voice-io-1 …` pattern as
  #       verify.sh.
  #   services/ops-console/README.md:58
  #       `com.docker.compose.project=droplet` Docker label —
  #       same compose-project-name tie.
  #
  # PATTERN: bare `inference-engine` (whole word) and bare
  # `droplet-jetson-ai` (whole word). The mDNS hostname
  # `inference-engine.local` is filtered out at match time — its trailing
  # `.local` disqualifies it as a repo-name reference.
  local label="stale-repo-names"

  # Surface walk — build the file list. Each entry is a repo-relative path
  # that grep -nE can ingest. We resolve recursive trees with find rather
  # than relying on bash globstar (which is opt-in via `shopt -s globstar`
  # and not guaranteed across operator shells).
  local files=()
  local f

  # Top-level README + the compose file.
  for f in "README.md" "docker/docker-compose.yml"; do
    [ -f "$REPO_ROOT/$f" ] && files+=("$f")
  done

  # services/*/README.md and services/*/TESTING.md (immediate children only).
  if [ -d "$REPO_ROOT/services" ]; then
    while IFS= read -r f; do
      files+=("${f#$REPO_ROOT/}")
    done < <(find "$REPO_ROOT/services" -mindepth 2 -maxdepth 2 -type f \
             \( -name 'README.md' -o -name 'TESTING.md' \) 2>/dev/null | sort)
  fi

  # Top-level scripts/*.sh (NOT scripts/lib/ — that's intentionally
  # exempt for the mDNS hostname allowlist).
  if [ -d "$REPO_ROOT/scripts" ]; then
    while IFS= read -r f; do
      files+=("${f#$REPO_ROOT/}")
    done < <(find "$REPO_ROOT/scripts" -mindepth 1 -maxdepth 1 -type f -name '*.sh' 2>/dev/null | sort)
  fi

  # apps/orchestrator/src/**/*.ts (recursive, but NOT *.test.ts — those
  # are test-only and not user-facing). All .ts files are in scope per
  # the ticket; we include .test.ts deliberately because the canonical
  # name should reach test fixtures too.
  if [ -d "$REPO_ROOT/apps/orchestrator/src" ]; then
    while IFS= read -r f; do
      files+=("${f#$REPO_ROOT/}")
    done < <(find "$REPO_ROOT/apps/orchestrator/src" -type f -name '*.ts' 2>/dev/null | sort)
  fi

  # services/ai-gateway/**/*.py and services/voice-io/**/*.py.
  local svc
  for svc in services/ai-gateway services/voice-io; do
    if [ -d "$REPO_ROOT/$svc" ]; then
      while IFS= read -r f; do
        files+=("${f#$REPO_ROOT/}")
      done < <(find "$REPO_ROOT/$svc" -type f -name '*.py' 2>/dev/null | sort)
    fi
  done

  if [ "${#files[@]}" -eq 0 ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — no covered surfaces found in tree (REPO_ROOT layout drift?)\n" "$label"
    _record_result "$label" fail
    return 1
  fi

  # Per-line allowlist. Entries are "<repo-relative-path>:<lineno>"; each is
  # documented above next to the corresponding rationale. Held as a
  # newline-delimited list and matched by _allowlisted -- bash 3.2 has no
  # associative arrays (see the version floor at the top of this file). Only
  # lines that already matched the stale-name grep reach the lookup, so the
  # linear scan over six entries costs nothing.
  local allowlist=""
  allowlist+="docker/docker-compose.yml:7"$'\n'
  allowlist+="docker/docker-compose.yml:10"$'\n'
  allowlist+="scripts/verify.sh:161"$'\n'
  allowlist+="scripts/verify.sh:164"$'\n'
  allowlist+="services/voice-io/TESTING.md:171"$'\n'
  allowlist+="services/ops-console/README.md:58"$'\n'

  # Run grep -nE per file, post-filter for the .local exemption and the
  # per-line allowlist, collect violations.
  local violations=""
  local line lineno content
  for f in "${files[@]}"; do
    # Match either bare repo name. grep -nE returns "<lineno>:<text>".
    # We don't anchor the pattern (the repo names can appear inside
    # markdown links, code blocks, etc.); the .local post-filter handles
    # the only ambiguous overlap.
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      lineno="${line%%:*}"
      content="${line#*:}"

      # Post-filter 1: if the line's only stale-name occurrence is
      # `inference-engine.local` (the mDNS hostname), skip it. We do
      # this by removing every `.local` suffix occurrence and re-grepping
      # the residual for either bare pattern.
      local residual
      residual="$(printf '%s' "$content" | sed 's/inference-engine\.local//g')"
      if ! printf '%s' "$residual" | grep -qE 'inference-engine|droplet-jetson-ai'; then
        continue
      fi

      # Post-filter 2: per-line allowlist.
      if _allowlisted "$f:$lineno" "$allowlist"; then
        continue
      fi

      violations+="    ${f}:${lineno}: ${content}"$'\n'
    done < <(grep -nE 'inference-engine|droplet-jetson-ai' "$REPO_ROOT/$f" 2>/dev/null || true)
  done

  if [ -z "$violations" ]; then
    printf "  ${_GREEN}PASS${_RESET}  %s (%d surface(s) scanned, no stale refs)\n" "$label" "${#files[@]}"
    _record_result "$label" pass
    return 0
  fi

  printf "  ${_RED}FAIL${_RESET}  %s — legacy repo-name reference(s) in user-facing surface(s)\n" "$label"
  printf '%s' "$violations" >&2
  printf "    | Canonical names on the DropletByWarpLab remote:\n" >&2
  printf "    |   inference-engine     → droplet-local-LLM\n" >&2
  printf "    |   droplet-jetson-ai    → droplet-local-LLM\n" >&2
  printf "    |   droplet-pi-platform  → droplet-onboard-services (this repo)\n" >&2
  printf "    | Use the canonical name in new/updated user-facing copy. The\n" >&2
  printf "    | mDNS hostname inference-engine.local IS allowed (it's a\n" >&2
  printf "    | hostname, not a repo name) — but it must literally appear\n" >&2
  printf "    | as inference-engine.local, not bare inference-engine.\n" >&2
  printf "    | If your reference belongs in the allowlist (compose project\n" >&2
  printf "    | name / container labels / etc.), add it to the per-line\n" >&2
  printf "    | allowlist in run_check_stale_repo_names with rationale.\n" >&2
  _record_result "$label" fail
  return 1
}

run_check_lifecycle_naming() {
  # ADR-018 action item 8 + architecture-guard rule 17: every Droplet box is
  # the SHIPPING PRODUCT, so user-facing surfaces must be named by what the
  # deployment IS, not by its lifecycle stage. No `poc` / `prototype` /
  # `-dev` / `-test` framing in compose profile names, env-var names, CLI
  # flags, service/file names, or operator-facing log strings. The canonical
  # replacements: `profiles: ["poc"]` → `profiles: ["single-box"]`,
  # `setup.sh --poc` → `setup.sh --single-box`, `COMPOSE_PROFILES=poc` →
  # `COMPOSE_PROFILES=single-box`.
  #
  # This check is the REPO-WIDE net for rule 17 across the broad user-facing
  # surface set below. It carries ONE tracked grandfather exception — the
  # legacy host-net identifier the WARP-445 migration cleanup still names
  # (see the Tier 1 note below).
  #
  # COVERED SURFACES (curated — mirrors stale-repo-names' surface philosophy):
  #   docker/docker-compose.yml   (profile names, service names, env, comments)
  #   .env.example                (env-var names + the operator-facing catalogue)
  #   scripts/*.sh                (top-level operator entry points — CLI flags,
  #                                log strings; NOT scripts/lib/, NOT scripts/test/,
  #                                NOT scripts/host/)
  #   scripts/lib/*.sh            (sourced helpers — service/file names + logs)
  #
  # NOT covered (intentional exemptions):
  #   docs/ + ADRs + specs        Historical record; ADR-018 itself names the
  #                               `poc-host-net` debt to retire it — flagging
  #                               the doc that schedules the cleanup is noise.
  #   scripts/test/               This check's own regex + the regression test's
  #                               synthetic `poc` mutation strings live here;
  #                               scanning them would self-trip the gate.
  #   scripts/host/               The captured droplet-sys host artifacts are a
  #                               point-in-time CAPTURE of what shipped to the
  #                               box (rule 20 / ADR-018 §13). The host-net set
  #                               was de-poc renamed in place (PR #676), but the
  #                               capture still holds e.g. docker-compose.poc.yml
  #                               — tracked debt scheduled by ADR-018/SINGLE_BOX
  #                               naming-cleanup notes, not a new leak.
  #   CLAUDE.md / package.json    Not operator-facing product surfaces.
  #
  # GRANDFATHERED LEGACY DEBT (tracked, NOT a silent exception — every entry
  # below is real tech debt with a retirement owner):
  #
  #   Tier 1 — the legacy host-net identifier (a SUBSTRING grandfather, robust
  #   to line moves). The de-poc rename itself landed (PR #676): every live
  #   surface uses `droplet-host-net`. What legitimately still names the OLD
  #   identifier is the WARP-445 on-box migration cleanup in
  #   scripts/lib/single-box.sh::install_single_box_host_integration — it must
  #   spell out the pre-rename unit/file/path names to disable + remove them
  #   from boxes provisioned before the rename. We strip the known token and
  #   only flag a RESIDUAL lifecycle token on the same line (same technique
  #   stale-repo-names uses for inference-engine.local). Retirement owner:
  #   delete the migration block + this grandfather once the fleet has no
  #   pre-rename boxes left.
  #
  #   Tier 2 — RETIRED (WARP-850). The six free-text "PoC" comment mentions
  #   that used to live here (docker-compose.yml ×2, .env.example ×1,
  #   scripts/lib/secrets.sh ×3) were line-number-pinned, which broke the
  #   moment WARP-850's compose/secrets insertions shifted them. Instead of
  #   re-pinning, the prose itself was de-PoC'd ("single-box" framing), so
  #   the allowlist is empty. Add new entries ONLY with a retirement owner.
  #
  # TOKEN PATTERN: whole-word `poc` / `prototype` (case-insensitive — catches
  # `poc`, `POC`, `PoC`, `prototype`) PLUS structural `-dev` / `-test` /
  # `_dev` / `_test` framing where it is a compose `profiles:` entry, a
  # `COMPOSE_PROFILES=` value, or a `--flag`. We deliberately do NOT match bare
  # `-test` / `-dev` everywhere (it would false-positive on *.test.ts,
  # scripts/test/, `npm test`, `latest`, `device`) — the ticket scopes the
  # dev/test framing to lifecycle naming of profiles/env/flags, so we match it
  # only in those structural positions.
  local label="lifecycle-naming"

  # --- Build the surface file list (find, not globstar — portable). --------
  local files=()
  local f

  for f in "docker/docker-compose.yml" ".env.example"; do
    [ -f "$REPO_ROOT/$f" ] && files+=("$f")
  done

  # Top-level scripts/*.sh only (NOT scripts/lib, scripts/test, scripts/host).
  if [ -d "$REPO_ROOT/scripts" ]; then
    while IFS= read -r f; do
      files+=("${f#$REPO_ROOT/}")
    done < <(find "$REPO_ROOT/scripts" -mindepth 1 -maxdepth 1 -type f -name '*.sh' 2>/dev/null | sort)
  fi

  # scripts/lib/*.sh (sourced helpers).
  if [ -d "$REPO_ROOT/scripts/lib" ]; then
    while IFS= read -r f; do
      files+=("${f#$REPO_ROOT/}")
    done < <(find "$REPO_ROOT/scripts/lib" -mindepth 1 -maxdepth 1 -type f -name '*.sh' 2>/dev/null | sort)
  fi

  if [ "${#files[@]}" -eq 0 ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — no covered surfaces found in tree (REPO_ROOT layout drift?)\n" "$label"
    _record_result "$label" fail
    return 1
  fi

  # --- Tier 2 per-line allowlist (file:line → 1). Documented above. --------
  # Empty since WARP-850 retired the grandfathered prose mentions. The
  # declaration stays so the lookup below keeps working when a future
  # (owner-tracked) entry is added.
  # Newline-delimited rather than an associative array because bash 3.2 has
  # none (see the version floor at the top of this file). Append a future
  # entry with:  allowlist+="path/to/file.sh:123"$'\n'
  local allowlist=""

  # Tier 1 grandfathered legacy identifiers — stripped from each line BEFORE
  # the token re-scan, so they're allowed wherever they appear (robust to
  # line moves). Sole remaining entry: the pre-rename host-net identifier the
  # WARP-445 on-box migration cleanup (scripts/lib/single-box.sh) must keep
  # naming to remove it from already-provisioned boxes. Retirement owner:
  # delete alongside that migration block once no pre-rename box remains.
  # (`droplet-poc-lan` was dropped from this list in the WARP-445 sweep — no
  # covered surface references it anymore.)
  local -a grandfathered_tokens=(
    "droplet-poc-host-net"
  )

  # --- Scan. -----------------------------------------------------------------
  # Primary token: whole-word poc|prototype, case-insensitive. grep -nE gives
  # "<lineno>:<text>". We post-filter each hit through the grandfather tiers.
  local violations=""
  local line lineno content residual t
  for f in "${files[@]}"; do
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      lineno="${line%%:*}"
      content="${line#*:}"

      # Tier 1: strip every grandfathered legacy identifier, then re-test the
      # residual for a lifecycle token. If nothing remains, this line's only
      # hit was the known debt → allow.
      residual="$content"
      for t in "${grandfathered_tokens[@]}"; do
        residual="${residual//$t/}"
      done
      if ! printf '%s' "$residual" | grep -qiwE '(poc|prototype)'; then
        continue
      fi

      # Tier 2: explicit per-line comment allowlist.
      if _allowlisted "$f:$lineno" "$allowlist"; then
        continue
      fi

      violations+="    ${f}:${lineno}: ${content}"$'\n'
    done < <(grep -niwE '(poc|prototype)' "$REPO_ROOT/$f" 2>/dev/null || true)
  done

  # Structural dev/test framing: only in compose profile entries, a
  # COMPOSE_PROFILES= value, or a --flag. No grandfather entries exist for
  # this class today, so any hit is a violation.
  for f in "${files[@]}"; do
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      lineno="${line%%:*}"
      content="${line#*:}"
      violations+="    ${f}:${lineno}: ${content}"$'\n'
    done < <({ grep -nE '(profiles:[[:space:]]*\[[^]]*|COMPOSE_PROFILES=[^[:space:]]*|--[a-z0-9-]*)(-|_)(dev|test|prototype)\b' "$REPO_ROOT/$f" 2>/dev/null; grep -nE 'profiles:[[:space:]]*\[[^]]*"(dev|test|prototype)"|COMPOSE_PROFILES=([^[:space:]]*,)?(dev|test|prototype)\b' "$REPO_ROOT/$f" 2>/dev/null; } | sort -t: -k1,1n -u || true)
  done

  if [ -z "$violations" ]; then
    printf "  ${_GREEN}PASS${_RESET}  %s (%d surface(s) scanned, no NEW lifecycle-stage naming)\n" "$label" "${#files[@]}"
    _record_result "$label" pass
    return 0
  fi

  printf "  ${_RED}FAIL${_RESET}  %s — NEW lifecycle-stage naming in user-facing surface(s)\n" "$label"
  printf '%s' "$violations" >&2
  printf "    | Every Droplet box is the SHIPPING PRODUCT (architecture-guard\n" >&2
  printf "    | rule 17 + ADR-018). Name things by what the deployment IS, not\n" >&2
  printf "    | by its lifecycle stage:\n" >&2
  printf "    |   profiles: [\"poc\"]      → profiles: [\"single-box\"]\n" >&2
  printf "    |   COMPOSE_PROFILES=poc    → COMPOSE_PROFILES=single-box\n" >&2
  printf "    |   setup.sh --poc          → setup.sh --single-box\n" >&2
  printf "    |   droplet-poc-* service   → name it by its role (e.g. -host-net)\n" >&2
  printf "    | If your reference is the droplet-poc-host-net migration cleanup\n" >&2
  printf "    | (WARP-445 — scripts/lib/single-box.sh removes the pre-rename unit\n" >&2
  printf "    | from old boxes) or another tracked exception, add it to the\n" >&2
  printf "    | grandfather allowlist in run_check_lifecycle_naming WITH a\n" >&2
  printf "    | retirement owner — never as a silent exception.\n" >&2
  _record_result "$label" fail
  return 1
}

run_check_tls_invariants() {
  # ADR-023 (C2/C3): invariants the public-CA per-device TLS work must hold so
  # the box never ships certless and the LE cert installs without an nginx
  # config change. Three static asserts:
  #   1. _generate_tls_cert adds the per-device FQDN (DROPLET_PUBLIC_FQDN) to the
  #      bootstrap self-signed SAN — so the box serves a name-matching cert for
  #      the FQDN even before the first LE issuance / offline.
  #   2. nginx.conf still references droplet.crt + droplet.key on the :443 server
  #      block — the LE fullchain overwrites droplet.crt, so a rename of those
  #      paths would silently break the zero-config handoff.
  #   3. factory-reset.sh deregisters the FQDN (DELETE /dhcp/hostnames/<fqdn>).
  #   4. factory-reset.sh sends the SIGNED HQ deregistration via the
  #      tls-deregister CLI (ADR-023 PR-3) — NOT a bodyless `curl -X DELETE
  #      …/api/issuance/registration`, which the deployed HQ Worker 422s (it
  #      requires a TPM-PoP body). Regression: if anyone reverts to the bodyless
  #      curl, this FAILs.
  local label="tls-invariants"
  local secrets_sh="$REPO_ROOT/scripts/lib/secrets.sh"
  local nginx_conf="$REPO_ROOT/docker/nginx/nginx.conf"
  local factory_reset="$REPO_ROOT/scripts/factory-reset.sh"
  local failures=0

  # 1. Bootstrap SAN includes the per-device FQDN.
  if [ -f "$secrets_sh" ]; then
    if ! grep -qE 'DNS:\$public_fqdn|DNS:\$\{DROPLET_PUBLIC_FQDN' "$secrets_sh" \
       && ! grep -qE 'DROPLET_PUBLIC_FQDN.*san|san.*public_fqdn' "$secrets_sh"; then
      printf "  ${_RED}FAIL${_RESET}  %s — _generate_tls_cert does not add the FQDN to the bootstrap SAN\n" "$label"
      printf "    | (ADR-023 C2: add DNS:\$public_fqdn near the hostname SAN in secrets.sh.)\n" >&2
      failures=$((failures + 1))
    fi
  else
    printf "  ${_RED}FAIL${_RESET}  %s — scripts/lib/secrets.sh not found\n" "$label"
    failures=$((failures + 1))
  fi

  # 2. nginx references droplet.crt + droplet.key on the :443 server block.
  if [ -f "$nginx_conf" ]; then
    local crt_refs key_refs
    crt_refs="$(grep -cE 'ssl_certificate[[:space:]].*droplet\.crt' "$nginx_conf" 2>/dev/null || echo 0)"
    key_refs="$(grep -cE 'ssl_certificate_key[[:space:]].*droplet\.key' "$nginx_conf" 2>/dev/null || echo 0)"
    if [ "$crt_refs" -lt 1 ] || [ "$key_refs" -lt 1 ]; then
      printf "  ${_RED}FAIL${_RESET}  %s — nginx.conf must reference droplet.crt/.key on the :443 server (found crt=%s key=%s)\n" "$label" "$crt_refs" "$key_refs"
      printf "    | (ADR-023 C2: the LE fullchain overwrites droplet.crt — do not rename these paths.)\n" >&2
      failures=$((failures + 1))
    fi
  else
    printf "  ${_RED}FAIL${_RESET}  %s — docker/nginx/nginx.conf not found\n" "$label"
    failures=$((failures + 1))
  fi

  # 3. factory-reset deregisters the FQDN host-record. The curl uses `-X DELETE`
  #    with the URL on the following line, so assert on BOTH parts independently:
  #    a DELETE verb AND the /dhcp/hostnames/<fqdn> path.
  if [ -f "$factory_reset" ]; then
    if ! grep -qE '\-X[[:space:]]+DELETE' "$factory_reset" \
       || ! grep -qE '\/dhcp\/hostnames\/\$\{?_?DEREGISTER_FQDN' "$factory_reset"; then
      printf "  ${_RED}FAIL${_RESET}  %s — factory-reset.sh does not deregister the FQDN (DELETE /dhcp/hostnames/<fqdn>)\n" "$label"
      printf "    | (ADR-023 C3: drop the split-horizon host-record on reset.)\n" >&2
      failures=$((failures + 1))
    fi

    # 4. SIGNED HQ reset via the tls-release / tls-deregister CLIs (WARP-980,
    #    AMENDS ADR-023 PR-3). The DEFAULT reset path RELEASES the HQ name
    #    (`tls-release`, device stays registered + self-heals); --decommission
    #    does the full deregister (`tls-deregister`). BOTH CLIs must be wired
    #    (factory-reset selects between them by the flag), and neither may have
    #    regressed to a bodyless `curl -X DELETE …/api/issuance/registration`
    #    (which HQ 422s). Both CLI names appear in factory-reset's command
    #    selection; assert both are present so a revert to only-deregister (losing
    #    the self-heal) OR dropping the deregister path is caught.
    if ! grep -qE 'tls-release' "$factory_reset"; then
      printf "  ${_RED}FAIL${_RESET}  %s — factory-reset.sh does not wire the DEFAULT tls-release CLI\n" "$label"
      printf "    | (WARP-980: reset must RELEASE the HQ name by default — the device stays registered + self-heals.)\n" >&2
      failures=$((failures + 1))
    fi
    if ! grep -qE 'tls-deregister' "$factory_reset"; then
      printf "  ${_RED}FAIL${_RESET}  %s — factory-reset.sh does not wire the --decommission tls-deregister CLI\n" "$label"
      printf "    | (ADR-023 PR-3: --decommission must fully deregister via the signed CLI while the stack is up.)\n" >&2
      failures=$((failures + 1))
    fi
    # Strip comment lines before grepping so a future explanatory comment like
    # `# was: curl -X DELETE …/api/issuance/registration` can't trip a false FAIL.
    if grep -v '^[[:space:]]*#' "$factory_reset" | grep -qE 'curl.*api/issuance/registration'; then
      printf "  ${_RED}FAIL${_RESET}  %s — factory-reset.sh still uses a bodyless curl to /api/issuance/registration\n" "$label"
      printf "    | (ADR-023 PR-3 regression: the deployed HQ Worker 422s a DELETE with no TPM-PoP body — use the tls-deregister CLI.)\n" >&2
      failures=$((failures + 1))
    fi
  else
    printf "  ${_RED}FAIL${_RESET}  %s — scripts/factory-reset.sh not found\n" "$label"
    failures=$((failures + 1))
  fi

  if [ "$failures" -eq 0 ]; then
    printf "  ${_GREEN}PASS${_RESET}  %s (FQDN SAN + nginx cert paths + factory-reset FQDN + signed HQ release/deregister)\n" "$label"
    _record_result "$label" pass
    return 0
  fi
  _record_result "$label" fail
  return 1
}

run_check_image_pipeline() {
  # WARP-663 / ADR-020: the appliance image pipeline (`droplet-image
  # build|manifest|sign|verify|list|publish|flash`) ships a versioned, signed
  # ISO artifact. This static check guards the three regressions that would
  # ship green otherwise:
  #
  #   1. scripts/build-image.sh reverting to (or never leaving) its historical
  #      five-line stub (`echo "TODO: Implement Pi image build (pi-gen)"`), so
  #      `droplet-image build` becomes a no-op that produces no ISO.
  #   2. scripts/image/manifest.schema.json drifting to invalid JSON, or the
  #      tracked sample scripts/image/manifest.json no longer validating against
  #      it — which would let `verify` accept a malformed manifest and break the
  #      M3.4 OTA substrate that consumes this contract.
  #   3. a shellcheck regression in the new pipeline scripts (build-image.sh,
  #      droplet-image, scripts/image/build-iso.sh, scripts/lib/image.sh) — the
  #      same bash bug class the `shellcheck` check guards for setup.sh + lib/,
  #      but those targets don't include the image scripts.
  #
  # We do NOT run a real ISO build or a real flash here — both require a Linux
  # host with xorriso + a writable Docker socket + real hardware (the documented
  # manual flash+boot acceptance gate in docs/IMAGE_PIPELINE.md). This check is
  # the static counterpart: structure + schema + shellcheck.
  local label="image-pipeline"
  local failures=0

  local build_image="$REPO_ROOT/scripts/build-image.sh"
  local droplet_image="$REPO_ROOT/scripts/droplet-image"
  local image_lib="$REPO_ROOT/scripts/lib/image.sh"
  local build_iso="$REPO_ROOT/scripts/image/build-iso.sh"
  local schema="$REPO_ROOT/scripts/image/manifest.schema.json"
  local sample_manifest="$REPO_ROOT/scripts/image/manifest.json"
  local gen_manifest="$REPO_ROOT/scripts/image/gen-manifest.py"

  # ----- Presence: every pipeline file must exist -------------------------
  local required_files=(
    "$build_image" "$droplet_image" "$image_lib"
    "$build_iso" "$schema" "$sample_manifest" "$gen_manifest"
  )
  local missing=""
  local file
  for file in "${required_files[@]}"; do
    [ -f "$file" ] || missing+="    ${file#$REPO_ROOT/}: not present\n"
  done
  if [ -n "$missing" ]; then
    printf "  ${_RED}FAIL${_RESET}  %s — pipeline file(s) missing\n" "$label"
    printf '%b' "$missing" >&2
    _record_result "$label" fail
    return 1
  fi

  # ----- build-image.sh must NOT be a stub --------------------------------
  # The historical stub was a 5-line script whose only action was an echo of
  # "TODO: Implement Pi image build". Treat as a stub if it (a) still contains
  # that TODO line, OR (b) never execs the real builder (scripts/image/build-iso.sh).
  if grep -qE 'TODO: Implement Pi image build' "$build_image"; then
    printf "  ${_RED}FAIL${_RESET}  %s — scripts/build-image.sh is still the TODO stub\n" "$label" >&2
    printf "    | It must dispatch to scripts/image/build-iso.sh, not echo a TODO.\n" >&2
    failures=$((failures + 1))
  elif ! grep -qE 'build-iso\.sh' "$build_image"; then
    printf "  ${_RED}FAIL${_RESET}  %s — scripts/build-image.sh does not exec scripts/image/build-iso.sh\n" "$label" >&2
    failures=$((failures + 1))
  fi

  # ----- manifest.schema.json must be valid JSON --------------------------
  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$schema" 2>/dev/null; then
    printf "  ${_RED}FAIL${_RESET}  %s — scripts/image/manifest.schema.json is not valid JSON\n" "$label" >&2
    failures=$((failures + 1))
  fi

  # ----- tracked manifest.json must validate against the schema -----------
  # gen-manifest.py exposes a `validate` subcommand (pure-stdlib draft-07
  # subset) that exits 0 on a valid manifest, non-zero otherwise. Reusing it
  # keeps one validation implementation, not two.
  local vout
  if ! vout="$(python3 "$gen_manifest" validate --schema "$schema" "$sample_manifest" 2>&1)"; then
    printf "  ${_RED}FAIL${_RESET}  %s — tracked manifest.json does not validate against the schema\n" "$label" >&2
    printf '%s\n' "$vout" | sed 's/^/    | /' >&2
    failures=$((failures + 1))
  fi

  # ----- the schema must ACCEPT a fully-populated entry -------------------
  # The tracked seed is intentionally an empty catalogue (no image is published
  # in Phase 1 — first publish is the deferred, confirmation-gated step). So we
  # separately prove the schema + validator accept a well-formed populated entry
  # by round-tripping one through `gen-manifest.py build` (which validates before
  # writing) to stdout. Guards against a schema that's vacuously satisfiable.
  local bout
  if ! bout="$(python3 "$gen_manifest" build \
        --schema "$schema" --shape single-box --version 0.0.0 --format iso \
        --file droplet-single-box-0.0.0.iso \
        --url 'https://example.com/droplet-single-box-0.0.0.iso' \
        --size 1 --sha256 "$(printf '' | python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')" \
        --git-sha 0000000000000000000000000000000000000000 \
        --build-date 2026-01-01T00:00:00Z --min-disk-gib 32 --out - 2>&1)"; then
    printf "  ${_RED}FAIL${_RESET}  %s — schema rejects a well-formed populated manifest entry\n" "$label" >&2
    printf '%s\n' "$bout" | sed 's/^/    | /' >&2
    failures=$((failures + 1))
  fi

  # ----- shellcheck the new pipeline scripts ------------------------------
  # Same severity + no-global-exclude policy as run_check_shellcheck. These
  # scripts are NOT in that check's target set, so they're covered here.
  if command -v shellcheck >/dev/null 2>&1; then
    local sc_out sc_rc
    sc_out="$(shellcheck --severity=warning --external-sources \
      "$build_image" "$droplet_image" "$image_lib" "$build_iso" 2>&1)" && sc_rc=0 || sc_rc=$?
    if [ "$sc_rc" -ne 0 ]; then
      printf "  ${_RED}FAIL${_RESET}  %s — shellcheck flagged the pipeline scripts\n" "$label" >&2
      printf '%s\n' "$sc_out" | head -40 | sed 's/^/    | /' >&2
      failures=$((failures + 1))
    fi
  else
    printf "  ${_RED}FAIL${_RESET}  %s — shellcheck not on PATH (required to lint pipeline scripts)\n" "$label" >&2
    failures=$((failures + 1))
  fi

  if [ "$failures" -gt 0 ]; then
    _record_result "$label" fail
    return 1
  fi

  printf "  ${_GREEN}PASS${_RESET}  %s (build-image non-stub; schema + sample manifest valid; scripts clean)\n" "$label"
  _record_result "$label" pass
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
    _record_result "$label" fail
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    printf "  ${_RED}FAIL${_RESET}  %s — docker daemon not reachable\n" "$label"
    printf "    | On macOS: start Docker Desktop.\n" >&2
    printf "    | On Linux: ensure /var/run/docker.sock is accessible.\n" >&2
    _record_result "$label" fail
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
  # Read the heredoc straight into the variable instead of capturing `cat` in a
  # command substitution: bash 3.2 cannot parse a `case` statement inside a
  # command substitution -- not even one that is only heredoc text -- and the
  # docker shim below is a `case`. macOS ships bash 3.2 and this script has to
  # run there (WARP-2449). `read -d ''` consumes to EOF and returns 1 when it
  # gets there, hence the `|| true` under `set -e`. Unlike `$()` it keeps the
  # trailing newline; harmless, the value is only ever passed to `bash -c`.
  IFS= read -r -d '' inner_script <<'INNER' || true
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
  # Any `docker run` in the smoke path must fail cleanly so callers take
  # their no-daemon fallback branches. (Historically this forced
  # _generate_mosquitto_passwd's plaintext fallback; that generator was
  # retired by WARP-235 — MQTT identity is the client cert CN now — but the
  # fail-closed shim behavior stays right for any future docker-run caller.)
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
    _record_result "$label" pass
    return 0
  fi

  printf "  ${_RED}FAIL${_RESET}  %s — setup.sh failed inside %s (exit %d)\n" "$label" "$image" "$rc"
  # Tail the output (head 80 lines is enough to see the failure phase
  # and the immediate context; full output is reproducible by hand).
  printf '%s\n' "$out" | tail -80 | sed 's/^/    | /' >&2
  _record_result "$label" fail
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
    compose-env-shadow)   run_check_compose_env_shadow ;;
    frigate-env-scan)     run_check_frigate_env_scan ;;
    shellcheck)           run_check_shellcheck ;;
    matter-env-allowlist) run_check_matter_env_allowlist ;;
    exec-bits)            run_check_exec_bits ;;
    stale-repo-names)     run_check_stale_repo_names ;;
    lifecycle-naming)     run_check_lifecycle_naming ;;
    image-pipeline)       run_check_image_pipeline ;;
    tls-invariants)       run_check_tls_invariants ;;
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
  local pass=0 fail=0 skip=0 result i
  printf "\n"
  printf "  ──────────────────────────────────\n"
  for ((i = 0; i < ${#CHECK_RESULT_VALUES[@]}; i++)); do
    result="${CHECK_RESULT_VALUES[$i]}"
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
    for ((i = 0; i < ${#CHECK_RESULT_VALUES[@]}; i++)); do
      if [ "${CHECK_RESULT_VALUES[$i]}" = "fail" ]; then
        printf "  - %s\n" "${CHECK_RESULT_NAMES[$i]}" >&2
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
