#!/usr/bin/env bash
#
# check-dashboard-classes.sh — WARP-288 (classes) + WARP-291 (native
# dialogs) + the DESIGN.md design-token ratchet.
#
# Five guards in one script. 1 and 2 are clean-tree guards on things that
# DON'T EXIST; 3–5 are a shrink-only ratchet on things that DO exist and
# still shouldn't be used — see the block above them for the full design.
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
# Excluded from the guard-1 and guard-2 scans (guards 3–5 exclude more,
# see EXCLUDED_PATHS_REGEX):
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

# ─────────────────────────────────────────────────────────────────────
# Guards 3–5: the design-token ratchet.
#
# Guards 1 and 2 above catch things that DON'T EXIST. These three catch
# things that DO exist and still shouldn't be used:
#
#   3. legacy-token    — pre-DESIGN.md tokens (`dp-card`, `bg-surface-*`,
#                        `text-label-*`, …). All valid CSS, which is
#                        exactly why 1k+ occurrences sailed through
#                        review. New code must use the ratified system.
#   4. accent-alpha    — `-accent/NN` alpha utilities. `accent` is
#                        declared as `var(--color-accent)` in
#                        tailwind.config.ts with no `<alpha-value>`
#                        placeholder, and `--color-accent` is a hex, so
#                        Tailwind silently drops EVERY `-accent/NN`
#                        utility. `focus-visible:ring-accent/40` renders
#                        no ring at all — DESIGN.md requires "3px accent
#                        focus rings, everywhere, without exception".
#   5. white-on-accent — `text-white`/`bg-white`/`#fff` on the same
#                        className as an accent fill. DESIGN.md: "Don't
#                        hardcode `#fff` on the accent" — On-Accent flips
#                        to near-black (#1d1d1f) in dark mode, so white
#                        is a contrast failure there (shipped twice,
#                        caught by hand at 2.98:1).
#
# This is a SHRINK-ONLY RATCHET, not a clean-tree guard. Today's debt is
# grandfathered in `scripts/dashboard-token-allowlist.txt`; anything not
# on that list fails. The allowlist may only ever get shorter — an entry
# whose file no longer matches is a hard failure, because a stale entry
# is how a ratchet quietly stops ratcheting.
#
# Scope carve-outs (see EXCLUDED_PATHS_REGEX): the setup wizard and the
# auth routes are a deliberately separate visual identity (WARP-1078),
# and co-located `*.test.ts(x)` files reference these tokens on purpose
# (WARP-288 negative guards, plus contrast-pinning assertions).
#
# Refs: DESIGN.md + .impeccable/design.json (umbrella repo root).
# ─────────────────────────────────────────────────────────────────────

ALLOWLIST_FILE="$REPO_ROOT/scripts/dashboard-token-allowlist.txt"

if [ ! -f "$ALLOWLIST_FILE" ]; then
  echo "check-dashboard-tokens: cannot find $ALLOWLIST_FILE" >&2
  exit 2
fi

# Paths (relative to SRC_ROOT) that the ratchet does not police at all.
#   - app/{login,setup,change-password,invite,tour} + components/setup:
#     the onboarding + auth identity, deliberately its own look
#     (WARP-1078).
#   - The components those routes solely own. PasswordRulesChecklist is
#     NOT here: /settings and /users consume it too, so it is in scope.
#   - Co-located `*.test.ts(x)`. `__tests__/` is already dropped by
#     --exclude-dir; these are the same thing in a different place.
EXCLUDED_PATHS_REGEX='^(app/(login|setup|change-password|invite|tour)/|components/setup/|components/tour/ProductTour\.tsx:|components/auth/(SignInForm|AuthLayout|WelcomeFlourish|AuroraPanel)\.tsx:|[^:]*\.test\.(ts|tsx):)'

# Whole-token match, same anchoring style as BAD_CLASSES above.
LEGACY_TOKEN_REGEX='(^|[^A-Za-z0-9_-])(dp-card|dp-btn[A-Za-z0-9_-]*|dp-input|bg-surface-[A-Za-z0-9_-]+|text-label-[A-Za-z0-9_-]+|text-accent|bg-accent|border-separator|bg-separator|bg-label-[A-Za-z0-9_-]+|ring-accent|--color-accent[A-Za-z0-9_-]*)([^A-Za-z0-9_-]|$)'

# Any `<utility>-accent/<number>`: ring-accent/40, bg-accent/10, …
ACCENT_ALPHA_REGEX='(^|[^A-Za-z0-9_-])[a-z-]*-accent/[0-9]+'

# An accent fill. Paired with a white-literal grep below to approximate
# "white sitting on the accent". Deliberately same-line only — see the
# note on false negatives in the failure message.
ACCENT_FILL_REGEX='(^|[^A-Za-z0-9_-])(bg-accent|bg-brand|bg-\[var\(--brand\)\])([^A-Za-z0-9_-]|$)'
WHITE_LITERAL_REGEX='(text-white|bg-white|#fff)'

# Emit `relpath:line:content` for every non-excluded match of $1.
# Pure-comment lines are dropped the same way the dialog guard drops
# them: doc comments legitimately name these tokens (`lib/brand.ts`
# documents `--color-accent`) and commented-out code never ships.
scan_src() {
  set +e
  grep -rEn \
    --include='*.ts' \
    --include='*.tsx' \
    --include='*.css' \
    --exclude-dir='__tests__' \
    --exclude-dir='node_modules' \
    --exclude-dir='.next' \
    "$1" \
    "$SRC_ROOT" \
    | sed "s|^${SRC_ROOT}/||" \
    | grep -vE "$EXCLUDED_PATHS_REGEX" \
    | grep -vE ':[0-9]+:[[:space:]]*\*' \
    | grep -vE ':[0-9]+:[[:space:]]*//' \
    | grep -vE ':[0-9]+:[[:space:]]*\{/\*'
  set -e
}

# Allowlisted paths for rule $1, in file order.
allowlist_for() {
  grep -E "^$1[[:space:]]" "$ALLOWLIST_FILE" | awk '{print $2}' || true
}

ratchet_exit_code=0

# Compare one rule's hits against its allowlist.
#   $1 rule name   $2 hit lines (`relpath:line:content`)   $3 explanation
#
# Paths are compared as exact strings via awk, never as regexes: Next.js
# dynamic segments (`app/cameras/[name]/page.tsx`) are character classes
# to grep and would silently never match their own allowlist entry.
check_ratchet_rule() {
  rule="$1"
  hits="$(printf '%s\n' "$2" | grep -v '^$' || true)"
  explanation="$3"

  allowed="$(allowlist_for "$rule" | grep -v '^$' || true)"

  # New violations: hits in files that are not allowlisted.
  new_hits="$(awk '
    NR == FNR { ok[$0] = 1; next }
    NF { p = $0; sub(/:.*/, "", p); if (!(p in ok)) print }
  ' <(printf '%s\n' "$allowed") <(printf '%s\n' "$hits"))"

  if [ -n "$new_hits" ]; then
    count="$(printf '%s\n' "$new_hits" | wc -l | tr -d '[:space:]')"
    ratchet_exit_code=1
    echo
    echo "✘ [${rule}] ${count} new violation(s) — ${explanation}"
    printf '%s\n' "$new_hits" | sed 's/^/    /'
  fi

  # Stale entries: allowlisted files that no longer match.
  stale="$(awk '
    NR == FNR { p = $0; sub(/:.*/, "", p); if (p != "") seen[p] = 1; next }
    NF && !($0 in seen)
  ' <(printf '%s\n' "$hits") <(printf '%s\n' "$allowed"))"

  if [ -n "$stale" ]; then
    ratchet_exit_code=1
    echo
    echo "✘ [${rule}] allowlist entries that no longer match — delete them:"
    printf '%s\n' "$stale" | sed 's/^/    /'
  fi
}

check_ratchet_rule "legacy-token" "$(scan_src "$LEGACY_TOKEN_REGEX")" \
  "pre-DESIGN.md token in a file that is not grandfathered"

check_ratchet_rule "accent-alpha" "$(scan_src "$ACCENT_ALPHA_REGEX")" \
  "silently-dropped \`-accent/NN\` utility (no <alpha-value> on the accent token)"

check_ratchet_rule "white-on-accent" \
  "$(scan_src "$ACCENT_FILL_REGEX" | grep -E "$WHITE_LITERAL_REGEX" || true)" \
  "hardcoded white on an accent fill (On-Accent is #1d1d1f in dark mode)"

if [ "$ratchet_exit_code" -ne 0 ]; then
  cat <<'EOF'

check-dashboard-tokens: the design-token ratchet fired.

New violations: use the ratified system instead of the legacy token.
  See DESIGN.md + .impeccable/design.json at the umbrella repo root.
  - legacy-token    → the DESIGN.md surface/label/separator tokens.
  - accent-alpha    → drop the `/NN`, or use an explicit
                      color-mix()/rgba value. `-accent/NN` compiles to
                      nothing at all today.
  - white-on-accent → use the on-accent token (`--on-brand` /
                      `text-accent-foreground`), never `text-white`.
                      Note this rule only sees a white literal and an
                      accent fill on the SAME line; splitting them
                      across lines is a known blind spot, not a
                      loophole to use.

Stale allowlist entries: a file was cleaned but its grandfather line was
  left behind. Delete the line from scripts/dashboard-token-allowlist.txt
  in the same PR — the allowlist is only allowed to shrink, and an entry
  nobody removes is how the ratchet silently stops ratcheting.

Never add a line to the allowlist to make this pass.
EOF
  exit 1
fi

echo "check-dashboard-tokens: OK (0 new legacy-token / accent-alpha / white-on-accent sites)"
