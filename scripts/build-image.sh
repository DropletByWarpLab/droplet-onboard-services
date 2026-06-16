#!/usr/bin/env bash
# scripts/build-image.sh — WARP-663 / ADR-020 appliance image build entry point.
#
# Thin dispatcher: parses --shape / --version and execs the real builder at
# scripts/image/build-iso.sh, which produces output/droplet-<shape>-<version>.iso
# from a pinned, SHA256-verified Ubuntu 24.04 live-server ISO with an embedded
# nocloud autoinstall seed that runs setup.sh --single-box --systemd on first
# boot.
#
# This replaces the historical pi-gen stub. Most operators should use the
# `droplet-image build` CLI (this script's caller); it is kept as a stable
# top-level path for CI + muscle memory.
#
# Usage:
#   ./scripts/build-image.sh [--shape single-box] [--version X.Y.Z]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ISO="$SCRIPT_DIR/image/build-iso.sh"

SHAPE="single-box"
VERSION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --shape)   SHAPE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./scripts/build-image.sh [--shape single-box] [--version X.Y.Z]

Builds the appliance autoinstall ISO (delegates to scripts/image/build-iso.sh).
Defaults: --shape single-box, --version from the root package.json.
See docs/IMAGE_PIPELINE.md for the full pipeline + the manual flash+boot gate.
EOF
      exit 0
      ;;
    *) echo "build-image: unexpected argument: $1" >&2; exit 64 ;;
  esac
done

[ -f "$BUILD_ISO" ] || { echo "build-image: builder not found: $BUILD_ISO" >&2; exit 1; }

exec bash "$BUILD_ISO" --shape "$SHAPE" ${VERSION:+--version "$VERSION"}
