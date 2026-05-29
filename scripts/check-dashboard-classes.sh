#!/usr/bin/env bash
#
# check-dashboard-classes.sh — WARP-288 (classes) + WARP-291 (native dialogs).
#
# Two guards in one script:
#
# 1. Bad Tailwind utility class names that don't exist in
#    `apps/web-dashboard/src/app/globals.css` or
#    `apps/web-dashboard/tailwind.config.ts`. Tailwind drops unknown
#    classes silently — without this guard a single typo
#    (`dp-button-primary` instead of `dp-btn-primary`) ships unstyled
#    elements. Source of truth list kept in sync with the vitest guard
#    at `apps/web-dashboard/src/__tests__/dashboard-classes-guard.test.ts`.
#
# 2. Native browser dialogs (`window.confirm`, `window.alert`,
#    `window.prompt`, or the bare `confirm(`/`alert(`/`prompt(` global
#    invocations). These bypass our ARIA + focus + theming primitives
#    and break the design language. The WARP-291 `<ConfirmDialog>`
#    primitive is the replacement for confirms; for non-destructive
#    informational popups use `toast(...)` from `components/Toast.tsx`;
#    for free-text input use an inline form inside `<Dialog>`. See the
#    WARP-291 audit notes for migration patterns.
#
# Exit 0 when clean, 1 with a per-hit summary when any rule fires.
#
# Excluded from both scans:
#   - `__tests__/` directories (tests intentionally reference these
#     names as strings).
#   - any `*.md` files (audit doc + ROADMAP reference both by name).
#   - `node_modules/`, `.next/`, build output.
#   - The `<ConfirmDialog>` primitive's own doc-comment, which names
#     `window.confirm()` to describe what it replaces.
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

# ─────────────────────────────────────────────────────────────────────
# WARP-291: native-dialog guard.
#
# Block:
#   - `window.confirm(`, `window.alert(`, `window.prompt(`
#   - bare `confirm(`, `alert(`, `prompt(` at the start of an
#     identifier (i.e. not `.confirm(` / `.alert(` / `.prompt(`)
#
# The `(^|[^A-Za-z0-9_.])` prefix is key: it excludes member-access
# calls like `useNetwork.ts`'s `async function confirm(...)` definition
# (the leading `function ` keyword counts as non-word), but does match
# `confirm("…")` at the start of a statement.
#
# We allow the bare keyword in function declarations only — to keep the
# regex simple, we instead allowlist the one file where `confirm` is a
# function NAME (`useNetwork.ts`). Add to the allowlist below if new
# legitimate non-dialog uses appear (rare).
# ─────────────────────────────────────────────────────────────────────

NATIVE_DIALOG_REGEXES=(
  # Member-form calls: window.confirm("…") / window.alert("…") / etc.
  '(^|[^A-Za-z0-9_])window\.(confirm|alert|prompt)\s*\('
  # Bare calls. The leading anchor disallows `.confirm(` and `_confirm(`
  # but does match `confirm(`, `  confirm(`, `if (!confirm(` etc.
  '(^|[^A-Za-z0-9_.])(confirm|alert|prompt)\s*\('
)

# Files where these names legitimately appear (function declarations,
# string-only references, etc.). Keep this list short — when in doubt,
# rename the offending function rather than allowlisting.
NATIVE_DIALOG_ALLOWLIST_FILES=(
  # `async function confirm(token, operation, entityId)` — tier-2
  # confirm helper, NOT a native dialog call.
  "$SRC_ROOT/lib/hooks/useNetwork.ts"
  # `replaces every native window.confirm() callsite` — doc comment only.
  "$SRC_ROOT/components/ConfirmDialog.tsx"
)

dialog_exit_code=0
dialog_total_hits=0

for pattern in "${NATIVE_DIALOG_REGEXES[@]}"; do
  set +e
  raw_hits="$(
    grep -rEn \
      --include='*.ts' \
      --include='*.tsx' \
      --exclude-dir='__tests__' \
      --exclude-dir='node_modules' \
      --exclude-dir='.next' \
      "$pattern" \
      "$SRC_ROOT"
  )"
  set -e

  if [ -z "$raw_hits" ]; then
    continue
  fi

  # Strip allowlisted files from the hit list.
  hits="$raw_hits"
  for allow in "${NATIVE_DIALOG_ALLOWLIST_FILES[@]}"; do
    hits="$(printf '%s\n' "$hits" | grep -v "^${allow}:" || true)"
  done

  # Also strip pure-comment lines (`*`-prefixed JSDoc, `//` line
  # comments, JSX `{/* … */}` block comments) — the bare regex matches
  # doc-comment prose like "Replaces every native `window.confirm()`
  # callsite". Match the post-line-number column to detect comment
  # leaders.
  hits="$(printf '%s\n' "$hits" \
    | grep -vE ':[0-9]+:[[:space:]]*\*' \
    | grep -vE ':[0-9]+:[[:space:]]*//' \
    | grep -vE ':[0-9]+:[[:space:]]*\{/\*' \
    || true)"

  if [ -n "$hits" ]; then
    count="$(printf '%s\n' "$hits" | wc -l | tr -d '[:space:]')"
    dialog_total_hits=$((dialog_total_hits + count))
    dialog_exit_code=1
    echo
    echo "✘ Native dialog pattern \`${pattern}\` found in ${count} site(s):"
    printf '%s\n' "$hits" | sed 's/^/    /'
  fi
done

if [ "$dialog_exit_code" -ne 0 ]; then
  echo
  echo "check-native-dialogs: ${dialog_total_hits} native-dialog call(s) found."
  echo "Use the <ConfirmDialog> primitive (apps/web-dashboard/src/components/ConfirmDialog.tsx)"
  echo "for destructive confirmations, toast() for informational popups, or an inline"
  echo "form inside <Dialog> for free-text prompts. Refs: WARP-291."
  exit 1
fi

echo "check-native-dialogs: OK (0 native confirm/alert/prompt calls across $SRC_ROOT)"
