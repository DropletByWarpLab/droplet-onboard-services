#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — fresh-checkout bootstrap (WARP-2620)
# =============================================================================
#
#   npm run bootstrap         # do it
#   npm run bootstrap:check   # fail fast if it has not been done
#
# `npm ci` alone does NOT leave this monorepo in a state where `tsc`, `vitest`
# or a workspace `build` can run. Two things are missing afterwards, and BOTH
# report themselves as errors in product code rather than as an incomplete
# install — which is why the same fresh-checkout wall cost four separate
# implementers a debugging session on 2026-09-02 (PRs #1946, #1947, #1948,
# #1953):
#
#   1. `node_modules/.prisma/client` is Prisma's PLACEHOLDER until
#      `prisma generate` runs. The placeholder declares
#      `export declare const PrismaClient: any`, so `ctx.prisma.<model>` is
#      `any` and every destructure of a row becomes TS7031. Presenting as:
#
#        packages/tools-core/src/handlers/network/list-network-devices.ts(30,31):
#          error TS7031: Binding element 'lastAppliedBlocked' implicitly has an 'any' type.
#
#      That line is correct code. The install is what is incomplete.
#
#   2. Three of the five leaf workspaces resolve `main`/`types`/`exports`
#      through `dist/`, and `turbo.json`'s `test` task does NOT declare
#      `dependsOn: ["^build"]`, so nothing builds them implicitly. Presenting
#      as `Failed to resolve entry for package "@droplet/fips-selftest"` when
#      the orchestrator suite collects `fips.test.ts` /
#      `process-safety-net.test.ts`, as TS2305/TS2724 from
#      `@droplet/erp-connector` at `apps/orchestrator/src/services/
#      erp-provider.ts:56-62`, and as a missing `.d.ts` for
#      `@droplet/mcp-server`.
#
# A stale `dist/` is the third failure mode and the reason this script
# `rm -rf`s before building: `tsc` emits, it does not prune. A `dist/` built
# before `src/handlers/pm/pm-orch.test.ts` moved under `__tests__/` keeps its
# `dist/handlers/pm/pm-orch.test.js` forever, and the WARP-2515 guard
# (`packages/tools-core/__tests__/no-tests-in-dist.guard.test.ts`) reds on it
# even though `stage` is clean.
#
# Deliberately NOT a `postinstall` hook. `services/mcp-server/Dockerfile`
# runs `npm ci` at line 72 and only COPYs `apps/orchestrator/prisma` at line
# 88, so a `postinstall` that generates the Prisma client would run against a
# schema that is not in the image yet; and every CI leg that needs the client
# already runs `npm run -w @droplet/orchestrator db:generate` explicitly
# (`.github/workflows/ci.yml`), so a hook would only add duplicate work to
# every `npm ci` in the org's metered minutes. See docs/ci-cost-budget.md.
#
# This script is a LOCAL developer convenience. CI keeps its explicit,
# per-suite steps — do not replace them with this.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

if [ -t 1 ]; then
  _GREEN='\033[0;32m'; _RED='\033[0;31m'; _BOLD='\033[1m'; _RESET='\033[0m'
else
  _GREEN=''; _RED=''; _BOLD=''; _RESET=''
fi

# The five leaf workspaces a fresh checkout must build, in DEPENDENCY order
# (derived from each package.json's `@droplet/*` dependencies):
#
#   shared-types    (no @droplet deps)
#   fips-selftest   (no @droplet deps)
#   erp-connector   (no @droplet deps)
#   tools-core      -> shared-types
#   mcp-server      -> fips-selftest, tools-core
#
# Two parallel indexed arrays rather than one associative array: bash 3.2 is
# the floor on the primary dev Mac (see scripts/test/ship-check.sh's version
# floor, WARP-2449) and it has no `declare -A`.
#
# `@droplet/shared-types` and `@droplet/auth-policy` point `main`, `types` and
# `exports.import` at `./src/index.ts`, so TypeScript and Vitest resolve them
# from source. shared-types is on this list anyway because tools-core's
# EMITTED CommonJS resolves it through `exports.require` -> `dist/`
# (WARP-1874). auth-policy has no such consumer and is deliberately absent.
LEAF_PKGS=(
  "@droplet/shared-types"
  "@droplet/fips-selftest"
  "@droplet/erp-connector"
  "@droplet/tools-core"
  "@droplet/mcp-server"
)
LEAF_DIRS=(
  "packages/shared-types"
  "packages/fips-selftest"
  "services/erp-connector"
  "packages/tools-core"
  "services/mcp-server"
)

PRISMA_CLIENT_DTS="node_modules/.prisma/client/index.d.ts"

usage() {
  cat <<'USAGE'
Usage: npm run bootstrap [-- --check]
       bash scripts/bootstrap.sh [--check]

Make a fresh checkout buildable. Run once after `npm ci`, and again after any
merge or rebase that touches a leaf workspace or the Prisma schema.

  (no args)   prisma generate -> rm -rf the five leaf dist/ -> build them in
              dependency order.
  --check     Exit non-zero if the Prisma client is still Prisma's placeholder
              or any leaf dist/ is missing. Prints the one command that fixes
              it. Does not change anything.
  --help      This text.

Exit codes:
  0  bootstrapped (or, with --check, already bootstrapped)
  1  --check found an unbootstrapped tree, or a build/generate step failed
  2  invalid CLI args
USAGE
}

# True when node_modules/.prisma/client is still Prisma's placeholder rather
# than a client generated from apps/orchestrator/prisma/schema.prisma.
#
# Keyed on the placeholder's own marker line, not on file size or on any one
# model name: `prisma generate` emits `export class PrismaClient<...>` with a
# per-model delegate, while the shipped placeholder emits the `any` alias
# below. A missing file counts as a stub.
_prisma_client_is_stub() {
  [ -f "$REPO_ROOT/$PRISMA_CLIENT_DTS" ] || return 0
  grep -q '^export declare const PrismaClient: any' "$REPO_ROOT/$PRISMA_CLIENT_DTS"
}

# Emit one "    | <line>" per reason the tree is not bootstrapped. Empty
# output means it is.
_bootstrap_reasons() {
  local i
  if _prisma_client_is_stub; then
    printf '    | %s is still the Prisma placeholder (PrismaClient: any) —\n' "$PRISMA_CLIENT_DTS"
    printf '    |   every ctx.prisma.<model> call site type-checks as any/TS7031\n'
  fi
  for ((i = 0; i < ${#LEAF_DIRS[@]}; i++)); do
    if [ ! -d "$REPO_ROOT/${LEAF_DIRS[$i]}/dist" ]; then
      printf '    | %s/dist is missing — %s cannot resolve\n' \
        "${LEAF_DIRS[$i]}" "${LEAF_PKGS[$i]}"
    fi
  done
}

run_check() {
  local reasons
  reasons="$(_bootstrap_reasons)"
  if [ -z "$reasons" ]; then
    printf "  ${_GREEN}OK${_RESET}    workspace bootstrap (prisma client generated, %d leaf dist/ present)\n" \
      "${#LEAF_DIRS[@]}"
    return 0
  fi

  printf "  ${_RED}FAIL${_RESET}  workspace bootstrap — this checkout is not built\n" >&2
  printf '%s\n' "$reasons" >&2
  printf '    |\n' >&2
  printf "    | Fix with one command:  ${_BOLD}npm run bootstrap${_RESET}\n" >&2
  printf '    |\n' >&2
  printf '    | Until then tsc, vitest and the workspace builds report this as\n' >&2
  printf '    | errors in product code (TS7031 in tools-core, "Failed to resolve\n' >&2
  printf '    | entry for package @droplet/fips-selftest" in the orchestrator\n' >&2
  printf '    | suite). Those are symptoms of the install, not of the tree.\n' >&2
  return 1
}

run_bootstrap() {
  local i out

  printf "\n  ${_BOLD}Droplet bootstrap${_RESET}  (repo: %s)\n" "$REPO_ROOT"
  printf "  ──────────────────────────────────\n"

  # Step 1 — Prisma client.
  #
  # Pinned to the orchestrator workspace's `db:generate` script, NOT
  # `npx prisma generate` (WARP-492): npx silently fetches the LATEST
  # published prisma off the registry when no local binary is resolvable,
  # and prisma 7 rejects this schema with P1012 ("datasource property `url`
  # is no longer supported"). The `npm run -w` form fails loudly instead.
  if [ -d "$REPO_ROOT/apps/orchestrator/prisma" ]; then
    printf "  prisma generate (@droplet/orchestrator)\n"
    if ! out="$(cd "$REPO_ROOT" && npm run -w @droplet/orchestrator db:generate 2>&1)"; then
      printf "  ${_RED}FAIL${_RESET}  prisma generate failed\n" >&2
      printf '%s\n' "$out" | tail -30 | sed 's/^/    | /' >&2
      return 1
    fi
  fi

  # Step 2 — drop stale dist/ before building. `tsc` emits but never prunes,
  # so a file deleted or moved in `src/` survives in `dist/` indefinitely.
  for ((i = 0; i < ${#LEAF_DIRS[@]}; i++)); do
    rm -rf "$REPO_ROOT/${LEAF_DIRS[$i]}/dist"
  done
  printf "  cleaned %d leaf dist/\n" "${#LEAF_DIRS[@]}"

  # Step 3 — build the leaves in dependency order.
  for ((i = 0; i < ${#LEAF_PKGS[@]}; i++)); do
    printf "  build %s\n" "${LEAF_PKGS[$i]}"
    if ! out="$(cd "$REPO_ROOT" && npm run -w "${LEAF_PKGS[$i]}" build 2>&1)"; then
      printf "  ${_RED}FAIL${_RESET}  %s build failed\n" "${LEAF_PKGS[$i]}" >&2
      printf '%s\n' "$out" | tail -40 | sed 's/^/    | /' >&2
      return 1
    fi
  done

  printf "  ──────────────────────────────────\n"
  printf "  ${_GREEN}Bootstrapped.${_RESET}  tsc, vitest and the workspace builds can run.\n\n"
  return 0
}

main() {
  local mode="bootstrap"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help) usage; return 0 ;;
      --check)   mode="check"; shift ;;
      --)        shift ;;
      *)
        printf "error: unknown argument '%s'\n" "$1" >&2
        usage >&2
        return 2
        ;;
    esac
  done

  if [ "$mode" = "check" ]; then
    run_check
  else
    run_bootstrap
  fi
}

main "$@"
