#!/usr/bin/env bash
# =============================================================================
# stage-lock.sh — stage every client installer clients.lock.json pins into a
# staging root (WARP-3174).
#
#   scripts/app-downloads/stage-lock.sh --lock <clients.lock.json> --dir <root>
#
# The image build calls this before its pre-flight audit, on the staging root
# it then carries in the ISO. It reuses the OTA release's verified path, so an
# image and an update can never disagree about which bytes are trusted:
#
#   1. scripts/release/fetch-client-apps.py validates the lock, downloads each
#      entry and refuses it unless its size and sha256 equal the lock's;
#   2. stage.mjs stages each verified file (replacing that platform's
#      directory) and regenerates + re-checks catalog.json.
#
# An empty lock stages nothing and needs no token. A lock that pins an entry
# needs a token that can read the source repo: GH_TOKEN, else
# DROPLET_CLIENT_APPS_TOKEN, else the builder's own `gh auth token`. Any
# failure exits non-zero with the reason; nothing is half-staged silently.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FETCH="$HERE/../release/fetch-client-apps.py"
STAGE_MJS="$HERE/stage.mjs"

LOCK=""
DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lock) LOCK="${2:-}"; shift 2 ;;
    --dir)  DIR="${2:-}"; shift 2 ;;
    *) echo "stage-lock: unexpected argument: $1" >&2; exit 64 ;;
  esac
done
[ -n "$LOCK" ] && [ -n "$DIR" ] || { echo "stage-lock: --lock and --dir are required" >&2; exit 64; }

# Validate first (no token, no network): a malformed lock fails here.
python3 "$FETCH" --lock "$LOCK" --check >&2

count="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["clients"]))' "$LOCK")"
if [ "$count" -eq 0 ]; then
  echo "stage-lock: $LOCK pins no client installer; nothing to stage"
  exit 0
fi
command -v node >/dev/null 2>&1 || { echo "stage-lock: node is required to stage the lock's installers" >&2; exit 1; }

if [ -z "${GH_TOKEN:-}" ]; then
  GH_TOKEN="${DROPLET_CLIENT_APPS_TOKEN:-$(gh auth token 2>/dev/null || true)}"
fi
export GH_TOKEN

FETCHED="$(mktemp -d)"
trap 'rm -rf "$FETCHED"' EXIT

if ! python3 "$FETCH" --lock "$LOCK" --out-dir "$FETCHED"; then
  echo "stage-lock: could not fetch the installers $LOCK pins (see above)." >&2
  echo "            Needs a token with contents:read on the source repo: GH_TOKEN," >&2
  echo "            DROPLET_CLIENT_APPS_TOKEN, or 'gh auth login' on this builder." >&2
  exit 1
fi

# clients.json holds only entries fetch-client-apps.py verified.
python3 -c '
import json, sys
for c in json.load(open(sys.argv[1])):
    print(c["platform"], c["version"], c["file"])
' "$FETCHED/clients.json" | while read -r platform version file; do
  node "$STAGE_MJS" --dir "$DIR" --platform "$platform" --version "$version" "$FETCHED/$file"
  echo "stage-lock: staged $platform $version ($file)"
done
