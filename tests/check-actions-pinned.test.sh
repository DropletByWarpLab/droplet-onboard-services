#!/usr/bin/env bash
# =============================================================================
# WARP-3671 — scripts/check-actions-pinned.sh must reject every spelling of an
# unpinned `uses:` and accept the pinned forms.
# =============================================================================
#
# WHY: GitHub parses YAML; the gate greps. A gate that only looked at lines
# STARTING with `uses:` let a flow mapping, a quoted key, a spaced colon, or a
# reference moved into a composite action outside .github/ through unseen. One
# fixture per bypass form (and per accepted form), each in a throwaway tree,
# run against the REAL script. Needs no docker, no network, no root.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$REPO_ROOT/scripts/check-actions-pinned.sh"
SHA=3d3c42e5aac5ba805825da76410c181273ba90b1
DIG=sha256:9c629b0b9261ba04289275479f67f6bdaadd6ed18e90631e1ed451749ea69d18

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

[ -f "$GATE" ] || { printf 'FATAL: %s not found\n' "$GATE"; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# expect <pass|fail> <label> <path-in-tree> <yaml line(s)>
expect() {
  local want="$1" label="$2" rel="$3" body="$4" root rc
  root="$(mktemp -d "$tmp/case.XXXXXX")"
  mkdir -p "$root/$(dirname "$rel")"
  printf 'jobs:\n  a:\n    steps:\n%s\n' "$body" >"$root/$rel"
  bash "$GATE" "$root" >/dev/null 2>&1
  rc=$?
  if [ "$want" = pass ] && [ "$rc" -eq 0 ]; then ok "$label"
  elif [ "$want" = fail ] && [ "$rc" -ne 0 ]; then ok "$label"
  else bad "$label (wanted $want, exit $rc)"; fi
}

W=.github/workflows/w.yml
printf '\n=== WARP-3671: check-actions-pinned.sh fixtures ===\n\n'

# accepted
expect pass "40-hex SHA"                       $W "      - uses: actions/checkout@$SHA"
expect pass "40-hex SHA with trailing comment" $W "      - uses: actions/checkout@$SHA # v7"
expect pass "sub-path action at a SHA"         $W "      - uses: github/codeql-action/init@$SHA # v4"
expect pass "docker digest"                    $W "      - uses: docker://alpine@$DIG"
expect pass "local ./ action"                  $W "      - uses: ./.github/actions/x"
expect pass "a trailing comment naming uses: is only a comment" $W "      - uses: actions/checkout@$SHA # was uses: actions/checkout@v7"
expect pass "commented-out tag is ignored"     $W "      # - uses: actions/checkout@v7"
expect pass "no uses at all"                   $W "      - run: echo hi"

# rejected: unpinned refs
expect fail "tag"                              $W "      - uses: actions/checkout@v7"
expect fail "branch"                           $W "      - uses: actions/checkout@main"
expect fail "short SHA"                        $W "      - uses: actions/checkout@3d3c42e"
expect fail "39-hex SHA"                       $W "      - uses: actions/checkout@${SHA%?}"
expect fail "no ref at all"                    $W "      - uses: actions/checkout"
expect fail "tag with a SHA-looking comment"   $W "      - uses: actions/checkout@v7 # $SHA"
expect fail "docker image by tag"              $W "      - uses: docker://alpine:3"

# rejected: spellings a start-of-line grep never sees
expect fail "flow mapping"                     $W "      - { uses: actions/checkout@v7 }"
expect fail "flow mapping, uses after name"    $W "      - {name: x, uses: actions/checkout@v7}"
expect fail "flow mapping even with a SHA"     $W "      - { uses: actions/checkout@$SHA }"
expect fail "double-quoted key"                $W "      - \"uses\": actions/checkout@v7"
expect fail "single-quoted key"                $W "      - 'uses': actions/checkout@v7"
expect fail "space before the colon"           $W "      - uses : actions/checkout@v7"
expect fail "quoted value"                     $W "      - uses: \"actions/checkout@$SHA\""
expect fail "value on the next line"           $W $'      - uses:\n          actions/checkout@v7'
expect fail "second mapping after a comment-free pin" $W "      - { uses: actions/checkout@$SHA, uses: actions/cache@v4 }"

# rejected: local path escaping the repository
expect fail "./ with .."                       $W "      - uses: ./../other"
expect fail "./ with .. in the middle"         $W "      - uses: ./a/../../b"

# composite actions are scanned wherever they live
expect fail "unpinned in a composite action outside .github" tools/x/action.yml "      - uses: actions/checkout@v7"
expect fail "unpinned in action.yaml"          tools/x/action.yaml "      - uses: actions/checkout@v7"
expect pass "pinned in a composite action"     tools/x/action.yml "      - uses: actions/checkout@$SHA # v7"
expect fail "unpinned in a .github/actions composite" .github/actions/x/action.yml "      - uses: actions/checkout@v7"
expect pass "unpinned under node_modules is skipped" node_modules/p/action.yml "      - uses: actions/checkout@v7"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
