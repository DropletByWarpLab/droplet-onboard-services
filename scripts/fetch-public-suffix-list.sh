#!/usr/bin/env bash
# WARP-2487 — refresh the vendored Public Suffix List snapshot.
#
# scripts/check-egress-allowlist.py decides whether a dotted token in a string
# literal is a hostname by asking whether its last labels form a real public
# suffix. Before this it asked a hand-kept 15-entry TLD tuple, so a destination
# on `.sh`, `.app` or `.xyz` was invisible to the denial pass.
#
# The scanner itself NEVER goes to the network — it runs offline in CI and on
# the appliance. This script is the only fetcher, it is run by a human (or by
# a scheduled workflow, as scripts/fetch-oui.sh is), and the result is
# committed. The snapshot is kept BYTE-IDENTICAL to upstream so that its own
# `// VERSION: YYYY-MM-DD_...` line stays the authoritative date: the scanner's
# staleness check reads that line, so there is no second date to keep in sync
# and no way for a hand-edited header to claim a freshness the data does not
# have.
#
# Provenance of the current snapshot (recorded here, not in the data file, so
# the file stays byte-identical to upstream):
#   fetched      2026-08-28  (HTTP Date: Fri, 28 Aug 2026 10:43:19 GMT)
#   last-modified            Wed, 19 Aug 2026 19:18:59 GMT
#   etag                     "349b23716f099df6ac363318e1be2f5d"
#   sha256       14ef61b1c212f701f3636c1d01ab9254daf841f57eb6433bcbbef56c726ca656
#   // VERSION:  2026-08-19_19-18-48_UTC
#
# Usage: ./scripts/fetch-public-suffix-list.sh [--check]
#   (no args)  overwrite the snapshot with the current upstream list
#   --check    fetch to a temp file and report whether the snapshot is behind,
#              without writing (for a human; NOT wired into the PR gate, which
#              must stay offline)
set -euo pipefail

# Upstream is explicit that this is the only supported URL — see the list's
# own header. Registered as `ci-public-suffix-list` in the egress allowlist.
URL="https://publicsuffix.org/list/public_suffix_list.dat"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/data/public_suffix_list.dat"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "Fetching $URL..."
curl -fsSL -o "$TMP" "$URL"

# Sanity floor, same shape as scripts/fetch-oui.sh: a truncated or
# error-page download must not silently narrow the gate. A list that lost
# its ICANN section would make every bare host stop being a host.
SIZE=$(wc -c < "$TMP")
if [ "$SIZE" -lt 200000 ] || [ "$SIZE" -gt 2000000 ]; then
  echo "public suffix list size $SIZE out of [200KB, 2MB] range" >&2
  exit 1
fi
for marker in '// ===BEGIN ICANN DOMAINS===' '// ===END ICANN DOMAINS==='; do
  if ! grep -qxF "$marker" "$TMP"; then
    echo "downloaded list is missing '$marker' — refusing to install it" >&2
    exit 1
  fi
done
if ! grep -qE '^// VERSION: [0-9]{4}-[0-9]{2}-[0-9]{2}' "$TMP"; then
  echo "downloaded list has no '// VERSION: YYYY-MM-DD' line — the scanner's" >&2
  echo "staleness check reads that line, so a list without one cannot be" >&2
  echo "installed. Check the upstream format before overriding." >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  if cmp -s "$TMP" "$OUT"; then
    echo "snapshot is current ($(grep -m1 '^// VERSION:' "$OUT"))"
    exit 0
  fi
  echo "snapshot is BEHIND upstream:"
  echo "  vendored: $(grep -m1 '^// VERSION:' "$OUT")"
  echo "  upstream: $(grep -m1 '^// VERSION:' "$TMP")"
  echo "Run this script with no arguments to update it, then commit."
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
cp "$TMP" "$OUT"

echo "Wrote $OUT ($(wc -l < "$OUT") rules+comments, $(wc -c < "$OUT") bytes)"
grep -m1 '^// VERSION:' "$OUT"
echo "Remember: touching the snapshot changes what the egress gate treats as a"
echo "hostname, so the PR needs security review (assign Romain)."
