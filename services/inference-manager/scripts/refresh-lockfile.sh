#!/usr/bin/env bash
# Regenerate the hash-locked requirements files for inference-manager.
#
# Run this whenever you edit `requirements.txt` or `requirements-dev.txt`.
# Both lockfiles MUST be committed alongside the source manifest in the
# same PR so CI / Dockerfile / dev installs all see the same dep tree.
#
# Why uv pip compile vs pip-tools:
#   * Single static binary, fast resolve, deterministic across Linux/macOS.
#   * Generated lockfiles are vanilla pip-installable with --require-hashes,
#     so the Dockerfile and CI don't depend on uv being present at install
#     time — only at *generation* time, which is right here.
#
# Usage:
#   ./scripts/refresh-lockfile.sh
#   ./scripts/refresh-lockfile.sh --upgrade   # also upgrade transitive pins
set -euo pipefail

UPGRADE_FLAG=""
if [ "${1:-}" = "--upgrade" ]; then
  UPGRADE_FLAG="--upgrade"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: 'uv' not found on PATH. Install via:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "or:" >&2
  echo "  brew install uv" >&2
  exit 1
fi

cd "$SVC_DIR"

echo "→ regenerating requirements.lock from requirements.txt..."
uv pip compile --generate-hashes $UPGRADE_FLAG \
  -o requirements.lock \
  requirements.txt

echo "→ regenerating requirements-dev.lock from requirements-dev.txt..."
uv pip compile --generate-hashes $UPGRADE_FLAG \
  -o requirements-dev.lock \
  requirements-dev.txt

echo ""
echo "Done. Commit both .lock files alongside the source .txt in the same PR:"
echo "  git add requirements.txt requirements-dev.txt requirements.lock requirements-dev.lock"
