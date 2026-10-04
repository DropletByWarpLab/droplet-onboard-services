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
# WHAT IS SCANNED: every *.yml / *.yaml under .github/, and every action.yml /
# action.yaml anywhere in the tree (a local `./` composite action is a place an
# unpinned reference could be moved to), minus node_modules, .git, vendor and
# vendored directories.
#
# HOW IT FAILS CLOSED (parser differential): GitHub parses YAML, a grep does
# not, so anchoring on a line that STARTS with `uses:` would let `- { uses: x@v1 }`,
# `"uses": x@v1`, `uses : x@v1` or `{name: n, uses: x@v1}` through unseen.
# Instead step 1 collects EVERY non-comment line holding the token `uses` as a
# mapping key in any of those spellings, and step 2 requires each one to be
# exactly the plain block form `[- ]uses: <allowed value>[ # comment]`.
# Anything else is reported, so exotic syntax is rejected, not ignored. The
# cost is that prose which merely contains `uses:` in a non-comment line is
# reported too; reword it.
#
# ALLOWED VALUES: `owner/repo[/path]@<40 hex>`; `./local/path` (same commit as
# the workflow; no `..`); `docker://image@sha256:<64 hex>`. A `..` anywhere in
# a value is rejected. Quoted or templated values fail.
#
# Usage: bash scripts/check-actions-pinned.sh [root]   (default: repo root)
# Test:  bash tests/check-actions-pinned.test.sh
set -euo pipefail

root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

key_re='(^|[^A-Za-z0-9_-])["'"'"']?uses["'"'"']?[[:space:]]*:'
line_re='^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]+([^[:space:]]+)([[:space:]]+#.*)?[[:space:]]*$'
sha_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$'
dig_re='^docker://[^[:space:]@]+@sha256:[0-9a-f]{64}$'

files=$(
  {
    [ -d "$root/.github" ] && find "$root/.github" -type f \( -name '*.yml' -o -name '*.yaml' \)
    find "$root" \( -name node_modules -o -name .git -o -name vendor -o -name vendored \) -prune -o \
      -type f \( -name action.yml -o -name action.yaml \) -print
  } | sort -u
)

bad=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    text="${hit#*:}"
    ok=0
    if [[ "$text" =~ $line_re ]]; then
      val="${BASH_REMATCH[2]}"
      case "$val" in
        *..*) ;;
        ./*) ok=1 ;;
        *) if [[ "$val" =~ $sha_re || "$val" =~ $dig_re ]]; then ok=1; fi ;;
      esac
    fi
    [ "$ok" -eq 1 ] || bad+="${f#"$root"/}:${hit}"$'\n'
  done < <(grep -nE "$key_re" "$f" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
done <<<"$files"

if [ -n "$bad" ]; then
  echo "::error::'uses:' lines that are not a plain block mapping to a commit SHA, local ./ path or sha256 digest (WARP-3671):" >&2
  printf '%s' "$bad" >&2
  echo "Resolve the tag to its commit (gh api repos/<owner>/<repo>/git/ref/tags/<tag>, dereferencing annotated tags) and write 'uses: <action>@<sha> # <tag>'." >&2
  exit 1
fi
echo "ok: every 'uses:' is pinned to a commit SHA (or is a local or digest-pinned reference)"
