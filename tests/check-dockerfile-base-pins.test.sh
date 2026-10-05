#!/usr/bin/env bash
# WARP-3670 -- self-test for scripts/check-dockerfile-base-pins.sh: the gate must
# pass pinned and stage-reference images and must fail every floating form.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/scripts/check-dockerfile-base-pins.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
D=sha256:0000000000000000000000000000000000000000000000000000000000000000
fails=0
expect() { # expect <pass|fail> <name> <dockerfile body>
  printf '%s\n' "$3" > "$TMP/Dockerfile"
  if bash "$CHECK" "$TMP/Dockerfile" >/dev/null 2>&1; then got=pass; else got=fail; fi
  if [ "$got" = "$1" ]; then echo "ok   - $2"; else echo "FAIL - $2 (wanted $1, got $got)"; fails=$((fails + 1)); fi
}

expect pass "digest-pinned FROM"            "FROM python:3.12-slim@$D"
expect pass "pinned FROM with AS + stage ref" $'FROM debian:bookworm-slim@'"$D"$' AS b\nFROM b'
expect pass "scratch"                       "FROM scratch"
expect pass "COPY --from earlier stage"     $'FROM debian:12-slim@'"$D"$' AS b\nFROM debian:12-slim@'"$D"$'\nCOPY --from=b /x /y'
expect pass "python heredoc line is not FROM" $'FROM debian:12-slim@'"$D"$'\nRUN python - <<PY\nfrom cryptography import x\nPY'
expect fail "bare tag"                      "FROM python:3.12-slim"
expect fail "untagged image"                "FROM debian"
expect fail "tag with short digest"         "FROM python:3.12-slim@sha256:abc"
expect fail "FROM with --platform, bare"    "FROM --platform=linux/amd64 node:22-bookworm-slim"
expect fail "FROM \${VAR}"                  $'ARG B=x\nFROM ${B}'
expect fail "second stage floating"         $'FROM debian:12-slim@'"$D"$'\nFROM nginx:1.27'
expect fail "COPY --from external, bare"    $'FROM debian:12-slim@'"$D"$'\nCOPY --from=ghcr.io/astral-sh/uv:0.4.27 /uv /uv'
expect pass "COPY --from external, pinned"  $'FROM debian:12-slim@'"$D"$'\nCOPY --from=ghcr.io/astral-sh/uv:0.4.27@'"$D"$' /uv /uv'

# the real tree must be clean
if bash "$CHECK" >/dev/null 2>&1; then echo "ok   - every tracked Dockerfile is pinned"; else echo "FAIL - tracked Dockerfiles have unpinned images"; fails=$((fails + 1)); fi
[ "$fails" -eq 0 ]
