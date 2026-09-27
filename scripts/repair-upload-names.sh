#!/usr/bin/env bash
# =============================================================================
# WARP-3057 — repair file names garbled by the old upload parser.
# =============================================================================
#
# Before WARP-3057 the box decoded a browser upload's file name as latin1, so
# a UTF-8 name was stored garbled: `Café.pdf` as `CafÃ©.pdf`, a macOS
# screenshot's "9.41.12 AM" as "9.41.12â¯AM". New uploads are fixed; this
# one-shot script repairs the names already stored.
#
# Ruling (WARP-3057): repair only on an admin's explicit run, dry run first,
# and only names that round-trip latin1 -> UTF-8 cleanly (every character in
# U+0000-U+00FF, at least one above U+007F, the bytes valid UTF-8). Nothing
# else is touched: a genuine latin1 name (`Café` as one 0xE9 byte) is not
# valid UTF-8 and stays; a repaired name that is already taken is skipped,
# never overwritten. The rename is Nextcloud's own `occ files:move`, so the
# file keeps its id, shares, tags and versions.
#
# Scope: people's own folders and the company Workspace (both live under a
# user's `files/`). Department folders (groupfolders) are not walked.
#
# Usage (as root, from the repo root on the box):
#   scripts/repair-upload-names.sh           # dry run: lists, changes nothing
#   scripts/repair-upload-names.sh --apply   # renames what the dry run listed
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$REPO_ROOT/docker/docker-compose.yml")

say() { printf '[repair-upload-names] %s\n' "$*" >&2; }

case "${1:-}" in
  "") apply=0 ;;
  --apply) apply=1 ;;
  *) say "usage: $0 [--apply]"; exit 2 ;;
esac

nc() { "${COMPOSE[@]}" exec -T -u www-data nextcloud "$@"; }

datadir="$(nc php occ config:system:get datadirectory | tr -d '\r\n')"
[ -n "$datadir" ] || { say "could not read Nextcloud's data directory"; exit 1; }

plan="$(mktemp)"
trap 'rm -f "$plan"' EXIT

# Every file and directory under each user's files/, as `f`/`d` + `user/files/…`,
# NUL-separated. Directories are listed so a repaired name that matches one is
# skipped rather than moved INTO it.
# shellcheck disable=SC2016 # $1 expands inside the container's shell
nc sh -c 'cd "$1" && for d in */files; do [ -d "$d" ] && find "$d" \( -type f -printf "f%p\0" \) -o \( -type d -printf "d%p\0" \); done' _ "$datadir" \
  | "${COMPOSE[@]}" exec -T orchestrator node dist/cli/upload-name-repair.js >"$plan"

count=0
failed=0
while IFS= read -r -d '' from && IFS= read -r -d '' to; do
  count=$((count + 1))
  printf '%s\n  -> %s\n' "$from" "$to"
  if [ "$apply" = 1 ]; then
    # Re-check at move time: anything (file or directory) that now sits at the
    # target is skipped, never replaced and never moved into.
    if nc test -e "$datadir/$to"; then
      failed=$((failed + 1))
      say "skipped, $to now exists: $from"
      continue
    fi
    # -n: never answer the "overwrite?" prompt, so a race with a new file of
    # the same name fails instead of replacing it.
    if ! nc php occ files:move -n "/$from" "/$to" </dev/null; then
      failed=$((failed + 1))
      say "not renamed: $from"
    fi
  fi
done <"$plan"

if [ "$apply" = 1 ]; then
  say "renamed $((count - failed)) of $count file(s); $failed not renamed"
else
  say "$count file(s) would be renamed. Nothing changed; rerun with --apply."
fi
[ "$failed" = 0 ]
