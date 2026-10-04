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
# THIS IS A DENY-BY-DEFAULT TEXT CHECK, NOT A YAML PARSER. GitHub parses YAML,
# a grep does not, so the gate does not try to understand YAML. It allows one
# plain spelling and rejects everything it cannot cheaply prove is that
# spelling. It is deliberately stricter than YAML: a legitimate file never
# needs the rejected constructs, and a false positive costs a reword.
#
# WHAT IS SCANNED (a worklist, so scope matches what is ALLOWED):
#   * every *.yml / *.yaml under .github/;
#   * every action.yml / action.yaml in the tree, minus node_modules, .git,
#     vendor and vendored (discovery only);
#   * every file a `uses: ./path` reference resolves to, regardless of that
#     pruning, and recursively the files THEY reference.
#
# WHAT IS ACCEPTED, per non-comment line holding `uses` as a mapping key:
#   exactly `[- ]uses: <value>[ # comment]`, where <value> is
#     owner/repo[/path]@<40 hex>
#     ./path   (no `..`; must resolve, with no symlink on the way and not
#               leaving the repository, to a directory holding action.yml or
#               action.yaml, or to a *.yml/*.yaml reusable workflow; that file
#               is then scanned too)
#     docker://image@sha256:<64 hex>
#
# WHAT IS REJECTED (reported with file:line), in every scanned file:
#   1. any `uses` key spelling other than the plain one above: flow mapping
#      (`{ uses: x }`, `{name: n, uses: x}`), quoted key (`"uses":`, `'uses':`),
#      a space before the colon, a value on the next line, a quoted or
#      templated value, a tag, branch, short or 39-hex ref;
#   2. a double-quoted mapping key containing a backslash (`"u\x73es":`);
#   3. the explicit complex-key form (a line whose first token is `?`);
#   4. YAML anchors, aliases and merge keys (`&name`, `*name`, `<<:`), through
#      which a step could inherit `uses`. One reviewed exception, listed in
#      `allowed_anchors` below: the two anchors in docker-build.yml's
#      `filters: |` block, which is a literal string handed to
#      dorny/paths-filter, not workflow structure;
#   5. a `./` reference that does not resolve, is not canonical, passes
#      through or is a symlink, or leaves the repository;
#   6. any symlink under .github/ and any symlinked action.yml / action.yaml.
# A trailing `# comment` is only a comment, and comment-only lines are ignored.
#
# Usage: bash scripts/check-actions-pinned.sh [root]   (default: repo root)
# Test:  bash tests/check-actions-pinned.test.sh
set -euo pipefail

root_arg="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
root="$(cd -P "$root_arg" && pwd -P)"

q="'"
key_re='(^|[^A-Za-z0-9_-])["'"$q"']?uses["'"$q"']?[[:space:]]*:'
line_re='^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]+([^[:space:]]+)([[:space:]]+#.*)?[[:space:]]*$'
sha_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$'
dig_re='^docker://[^[:space:]@]+@sha256:[0-9a-f]{64}$'
escaped_key_re='"[^"]*\\[^"]*"[[:space:]]*:'
complex_key_re='^[[:space:]]*(-[[:space:]]+)*\?([[:space:]]|$)'
merge_re='(^|[[:space:]{,])<<[[:space:]]*:'
anchor_re='^[[:space:]]*(-[[:space:]]+)*(["'"$q"'A-Za-z0-9_-]+[[:space:]]*:[[:space:]]+)?[&*][A-Za-z0-9_-]+([[:space:]]|$)'

# <file>:<name> pairs exempt from rule 4. Adding one is a reviewed decision.
allowed_anchors=".github/workflows/docker-build.yml:py-shared
.github/workflows/docker-build.yml:node-workspace"

queue="$(mktemp)"
trap 'rm -f "$queue"' EXIT
bad=""

rel() { printf '%s' "${1#"$root"/}"; }
report() { bad+="$1"$'\n'; }
add() { grep -qxF -- "$1" "$queue" || printf '%s\n' "$1" >>"$queue"; }

# Resolve a `./path` value to the file(s) it names and queue them for scanning.
# Reports (via `report`) anything that does not resolve cleanly.
resolve_local() { # <where> <value>
  local where="$1" val="$2" target real dir n found=0
  target="$root/${val#./}"
  target="${target%/}"
  if [ -L "$target" ]; then report "$where: '$val' is a symlink"; return 0; fi
  if [ -d "$target" ]; then
    real="$(cd -P "$target" 2>/dev/null && pwd -P)" || { report "$where: '$val' is unreadable"; return 0; }
    if [ "$real" != "$target" ]; then
      report "$where: '$val' is not its own real path (symlink on the way or non-canonical); resolves to $real"; return 0
    fi
    for n in action.yml action.yaml; do
      if [ -L "$target/$n" ]; then report "$where: '$val/$n' is a symlink"; return 0; fi
      if [ -f "$target/$n" ]; then add "$target/$n"; found=1; fi
    done
    [ "$found" -eq 1 ] || report "$where: '$val' has no action.yml or action.yaml"
    return 0
  fi
  if [ -f "$target" ]; then
    case "$target" in
      *.yml|*.yaml) ;;
      *) report "$where: '$val' is a file but not a YAML workflow or action"; return 0 ;;
    esac
    dir="$(cd -P "$(dirname "$target")" 2>/dev/null && pwd -P)" || { report "$where: '$val' is unreadable"; return 0; }
    if [ "$dir/$(basename "$target")" != "$target" ]; then
      report "$where: '$val' is not its own real path (symlink on the way or non-canonical)"; return 0
    fi
    add "$target"
    return 0
  fi
  report "$where: '$val' does not resolve to an action directory or a workflow file"
}

# --- seed the worklist ------------------------------------------------------
if [ -d "$root/.github" ]; then
  while IFS= read -r l; do
    [ -n "$l" ] && report "$(rel "$l"): symlink under .github"
  done < <(find "$root/.github" -type l)
  find "$root/.github" -type f \( -name '*.yml' -o -name '*.yaml' \) | sort >>"$queue"
fi
while IFS= read -r a; do
  [ -n "$a" ] || continue
  if [ -L "$a" ]; then report "$(rel "$a"): symlinked action file"; else add "$a"; fi
done < <(find "$root" \( -name node_modules -o -name .git -o -name vendor -o -name vendored \) -prune -o \
  \( -name action.yml -o -name action.yaml \) \( -type f -o -type l \) -print | sort)

# --- scan the worklist (it grows while we read it) --------------------------
i=1
while :; do
  f="$(sed -n "${i}p" "$queue")"
  [ -n "$f" ] || break
  i=$((i + 1))
  where_f="$(rel "$f")"

  # 1. every `uses` key must be the plain block form with an allowed value.
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    text="${hit#*:}"
    ok=0
    if [[ "$text" =~ $line_re ]]; then
      val="${BASH_REMATCH[2]}"
      case "$val" in
        *..*) ;;
        ./*) resolve_local "$where_f:${hit%%:*}" "$val"; ok=1 ;;
        *) if [[ "$val" =~ $sha_re || "$val" =~ $dig_re ]]; then ok=1; fi ;;
      esac
    fi
    [ "$ok" -eq 1 ] || report "$where_f:${hit}"
  done < <(grep -nE "$key_re" "$f" | grep -vE '^[0-9]+:[[:space:]]*#' || true)

  # 2 to 4. constructs that can hide or inherit a `uses` key.
  for rule in "escaped-key:$escaped_key_re" "complex-key:$complex_key_re" "merge-key:$merge_re" "anchor-or-alias:$anchor_re"; do
    label="${rule%%:*}"; re="${rule#*:}"
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      if [ "$label" = anchor-or-alias ]; then
        name="$(printf '%s' "${hit#*:}" | { grep -oE '[&*][A-Za-z0-9_-]+' || true; } | head -1 | cut -c2-)"
        if printf '%s\n' "$allowed_anchors" | grep -qxF -- "$where_f:$name"; then continue; fi
      fi
      report "$where_f:${hit} [$label]"
    done < <(grep -nE "$re" "$f" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
  done
done

if [ -n "$bad" ]; then
  echo "::error::action references the pin gate rejects (WARP-3671); rules are in the header of scripts/check-actions-pinned.sh:" >&2
  printf '%s' "$bad" >&2
  echo "Resolve a tag to its commit (gh api repos/<owner>/<repo>/git/ref/tags/<tag>, dereferencing annotated tags) and write 'uses: <action>@<sha> # <tag>'." >&2
  exit 1
fi
echo "ok: every 'uses:' is pinned to a commit SHA (or is a resolving local or digest-pinned reference)"
