#!/usr/bin/env bash
set -euo pipefail

OUT="apps/orchestrator/data/oui.csv"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

URL="https://standards-oui.ieee.org/oui/oui.csv"

echo "Fetching $URL..."
curl -fsSL -o "$TMP" "$URL"

SIZE=$(wc -c < "$TMP")
if [[ $SIZE -lt 2000000 || $SIZE -gt 10000000 ]]; then
  echo "OUI CSV size $SIZE out of [2MB, 10MB] range" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
# Normalize: keep header, uppercase assignment hex (col 2), preserve 4-col IEEE shape,
# sort data rows by assignment prefix.
awk -F, 'NR==1 { print; next } { $2 = toupper($2); print }' OFS=, "$TMP" \
  | (head -n1 && tail -n +2 | sort -t, -k2,2) > "$OUT"

echo "Wrote $OUT ($(wc -l < "$OUT") rows, $(wc -c < "$OUT") bytes)"
