#!/usr/bin/env bash
#
# check-actions-pinned.sh — fail if a workflow or composite action references a
# third-party action by a tag or branch instead of a full commit SHA.
#
# WARP-3671. WHY: a tag (`@v4`) or branch is a pointer its owner can move, so
# a compromised or hijacked action repository changes what runs in OUR
# workflows, with OUR token and secrets, without any change in this repo. A
# 40-hex commit SHA cannot be moved. Dependabot (`github-actions` ecosystem)
# keeps the pinned SHAs current; write `uses: owner/repo@<sha> # <tag>` so a
# human can still read the version.
#
# Allowed: `./local/path` actions (same commit as the workflow), and
# `docker://image@sha256:<64 hex>`. Everything else must end in `@<40 hex>`.
# Fail-closed: a `uses:` value this script cannot parse (quoted, templated) is
# reported too, so the gate cannot be dodged by exotic syntax.
#
# Usage: bash scripts/check-actions-pinned.sh [root]   (default: repo root)
set -euo pipefail

root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

bad=$(
  grep -rnE --include='*.yml' --include='*.yaml' '^[[:space:]]*(-[[:space:]]+)?uses:' "$root/.github" \
    | grep -vE ':[0-9]+:[[:space:]]*#' \
    | grep -vE 'uses:[[:space:]]*(\./[^[:space:]]*|[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}|docker://[^[:space:]@]+@sha256:[0-9a-f]{64})([[:space:]]+#.*)?[[:space:]]*$' \
    || true
)

if [ -n "$bad" ]; then
  echo "::error::actions referenced by tag or branch instead of a 40-hex commit SHA (WARP-3671):" >&2
  echo "$bad" >&2
  echo "Resolve the tag to its commit (gh api repos/<owner>/<repo>/git/ref/tags/<tag>, dereferencing annotated tags) and write 'uses: <action>@<sha> # <tag>'." >&2
  exit 1
fi
echo "ok: every 'uses:' under .github is pinned to a commit SHA (or is a local or digest-pinned reference)"
