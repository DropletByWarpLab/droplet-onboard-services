#!/usr/bin/env bash
#
# check-dashboard-classes.sh — WARP-288.
#
# Greps the web-dashboard source tree for known-bad Tailwind utility class
# names that don't exist in `apps/web-dashboard/src/app/globals.css` or
# `apps/web-dashboard/tailwind.config.ts`. Tailwind drops unknown classes
# silently, so without this guard a single typo (`dp-button-primary`
# instead of `dp-btn-primary`) ships unstyled elements to production.
#
# The list of bad classes is kept in sync with the vitest guard at
# `apps/web-dashboard/src/__tests__/dashboard-classes-guard.test.ts` —
# both must agree, but each runs in its own pipeline (this script in CI
# pre-test, the vitest guard alongside the dashboard unit suite).
#
# Exit 0 when clean, 1 with a per-class summary when any hit is found.
#
# Excluded from the scan:
#   - `__tests__/` directories (tests carry the bad-class list verbatim
#     and intentionally name them as strings).
#   - any `*.md` files (the audit doc and ROADMAP reference the bad
#     classes by name).
#   - `node_modules/`, `.next/`, build output.
#
# Usage:
#   ./scripts/check-dashboard-classes.sh
# or
#   npm run lint:dashboard-classes  (cd apps/web-dashboard)

set -euo pipefail

# Resolve repo root from the script's own directory so the guard works
# from any cwd (matters for IDE pre-commit hooks).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SRC_ROOT="$REPO_ROOT/apps/web-dashboard/src"

if [ ! -d "$SRC_ROOT" ]; then
  echo "check-dashboard-classes: cannot find $SRC_ROOT" >&2
  exit 2
fi

# Each entry is a basic regex matching the bad class as a whole token.
# The leading/trailing `[^A-Za-z0-9_-]` (or start/end of line) anchors
# the match so `type-caption-1` / `type-caption-2` don't trip the bare
# `type-caption` rule.
#
# Keep in sync with `apps/web-dashboard/src/__tests__/dashboard-classes-guard.test.ts`.
BAD_CLASSES=(
  "dp-button-primary"
  "dp-button-secondary"
  "type-caption"
  "type-title"
  "border-separator-primary"
  "border-warning"
  "text-positive"
  "text-warning"
  "bg-warning"
)

exit_code=0
total_hits=0

for bad in "${BAD_CLASSES[@]}"; do
  # `\B` won't work portably for the trailing word boundary, so build
  # the regex with explicit non-word-char anchors. `grep -E` understands
  # this on both BSD and GNU grep.
  pattern="(^|[^A-Za-z0-9_-])${bad}([^A-Za-z0-9_-]|\$)"

  # `--include` filters by extension; `--exclude-dir` skips test/build
  # dirs; `-r` for recursion; `-E` for extended regex; `-n` for line
  # numbers.
  set +e
  hits="$(
    grep -rEn \
      --include='*.ts' \
      --include='*.tsx' \
      --include='*.css' \
      --exclude-dir='__tests__' \
      --exclude-dir='node_modules' \
      --exclude-dir='.next' \
      "$pattern" \
      "$SRC_ROOT"
  )"
  set -e

  if [ -n "$hits" ]; then
    count="$(printf '%s\n' "$hits" | wc -l | tr -d '[:space:]')"
    total_hits=$((total_hits + count))
    exit_code=1
    echo
    echo "✘ Bad class \`${bad}\` found in ${count} site(s):"
    printf '%s\n' "$hits" | sed 's/^/    /'
  fi
done

if [ "$exit_code" -ne 0 ]; then
  echo
  echo "check-dashboard-classes: ${total_hits} silently-dropped utility-class hit(s)."
  echo "Each class above does NOT exist in globals.css / tailwind.config.ts —"
  echo "Tailwind drops them silently, so elements render unstyled."
  echo "Fix sites or extend the design system. Refs: WARP-288."
  exit 1
fi

echo "check-dashboard-classes: OK (0 silently-dropped classes across $SRC_ROOT)"
