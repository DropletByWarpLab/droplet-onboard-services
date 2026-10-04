#!/usr/bin/env bash
# pin-seed.sh - WARP-3599. Render the autoinstall seed with the platform
# release baked in, so first boot installs exactly one known commit instead of
# whatever the default branch is that day.
#
# Usage: pin-seed.sh --ref <release-tag | 40-hex-commit> --out <dir>
#
# - --ref is REQUIRED. No ref, a branch name or an unknown tag is refused: the
#   image build must not produce an unpinned image.
# - The ref is resolved to a full commit against THIS checkout; the commit is
#   substituted for the __DROPLET_COMMIT__ placeholder in the seed
#   (user-data fetches that exact commit and fails the install on mismatch;
#   droplet-firstboot-verify re-checks it before setup.sh runs).
# - <dir> receives a copy of scripts/image/autoinstall/ with no placeholder left.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SEED="$HERE/autoinstall"

REF=""; OUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    *) echo "pin-seed: unexpected argument: $1" >&2; exit 64 ;;
  esac
done

if [ -z "$REF" ]; then
  echo "pin-seed: refusing to build an unpinned image: pass --ref <release-tag|commit-sha>." >&2
  exit 64
fi
[ -n "$OUT" ] || { echo "pin-seed: --out <dir> is required" >&2; exit 64; }

if printf '%s' "$REF" | grep -Eq '^[0-9a-f]{40}$'; then
  commit="$(git -C "$REPO_ROOT" rev-parse --verify -q "${REF}^{commit}")" \
    || { echo "pin-seed: commit $REF is not in this checkout" >&2; exit 1; }
else
  commit="$(git -C "$REPO_ROOT" rev-parse --verify -q "refs/tags/${REF}^{commit}")" \
    || { echo "pin-seed: '$REF' is not a tag in this checkout (branch names are refused: they move)." >&2; exit 1; }
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$SEED/." "$OUT/"
for f in "$OUT/user-data" "$OUT/droplet-firstboot-verify"; do
  sed "s/__DROPLET_COMMIT__/${commit}/g" "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
done
chmod 0755 "$OUT/droplet-firstboot-verify"

if grep -rl '__DROPLET_' "$OUT" >/dev/null 2>&1; then
  echo "pin-seed: unrendered placeholder left in the seed:" >&2
  grep -rn '__DROPLET_' "$OUT" >&2
  exit 1
fi
echo "pin-seed: ${REF} -> ${commit}" >&2
