#!/usr/bin/env bash
# =============================================================================
# Droplet appliance autoinstall-ISO builder — single-box (x86_64)  [WARP-663]
# =============================================================================
#
# Mirrors the shape of openwrt/build.sh (the router image builder): pinned
# config -> download upstream -> VERIFY SHA256 -> unpack -> inject overlay ->
# (re)build -> collect to output/ -> print flash instructions. The "overlay"
# here is the embedded nocloud autoinstall seed (user-data + meta-data) plus a
# GRUB menu that boots the unattended install. On first boot the installed
# system clones this repo and runs scripts/setup.sh --single-box --systemd
# (ADR-020 §D1 — setup.sh stays the single source of provisioning truth).
#
# This is Phase 1 (ISO). The preinstalled golden raw .img is Phase 2 (a second
# --format raw path), out of scope for WARP-663.
#
# Requirements (Linux host):
#   - docker (the xorriso repack runs in a container so no host xorriso needed)
#   - curl, openssl, sha256sum
#   - ~10 GB free disk (upstream ISO ~3 GB + repack working copy)
#
# Output:
#   output/droplet-single-box-<version>.iso
#
# NOTE: This builder is validated structurally + by shellcheck in CI; the real
# docker xorriso repack runs ONLY on a Linux host (the documented build gate).
# It is never executed on the Windows control host or in the static ship-check.
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers (defined before first use)
# ---------------------------------------------------------------------------
_sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  fi
}

# ---------------------------------------------------------------------------
# Configuration — pinned upstream Ubuntu live-server ISO
# ---------------------------------------------------------------------------
# Pinned to the current 24.04 LTS point release. SHA256 is the REAL checksum
# from https://releases.ubuntu.com/24.04/SHA256SUMS (fetched 2026-06-04).
#
# REFRESH PROCEDURE when Ubuntu rotates the point release (the pinned URL 404s):
#   1. curl -s https://releases.ubuntu.com/24.04/SHA256SUMS \
#        | grep live-server-amd64.iso
#   2. Update UBUNTU_VERSION + UBUNTU_ISO_SHA256 below to the new line.
#   3. Re-run this builder on a Linux host and re-validate the boot gate.
# The build FAILS LOUDLY (sha256 mismatch) rather than shipping an unverified
# base image if the pin drifts — by design (ADR-020 Consequences).
UBUNTU_VERSION="24.04.4"
UBUNTU_ISO="ubuntu-${UBUNTU_VERSION}-live-server-amd64.iso"
UBUNTU_ISO_URL="https://releases.ubuntu.com/24.04/${UBUNTU_ISO}"
UBUNTU_ISO_SHA256="e907d92eeec9df64163a7e454cbc8d7755e8ddc7ed42f99dbc80c40f1a138433"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"            # scripts/image
REPO_ROOT="$(cd "$BUILD_DIR/../.." && pwd)"
OUTPUT_DIR="${REPO_ROOT}/output"
WORK_DIR="${BUILD_DIR}/.build"                                       # transient
AUTOINSTALL_DIR="${BUILD_DIR}/autoinstall"
GRUB_CFG="${BUILD_DIR}/grub-autoinstall.cfg"

# ---------------------------------------------------------------------------
# Flags: --shape (default single-box), --version (default package.json version)
# ---------------------------------------------------------------------------
SHAPE="single-box"
VERSION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --shape)   SHAPE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    *) echo "build-iso: unexpected argument: $1" >&2; exit 64 ;;
  esac
done

if [ "$SHAPE" != "single-box" ]; then
  echo "build-iso: unsupported --shape '$SHAPE' (Phase 1 builds single-box only)" >&2
  exit 64
fi

# Single source of version truth: root package.json (ADR-020 §D4).
if [ -z "$VERSION" ]; then
  VERSION="$(
    python3 - "$REPO_ROOT/package.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["version"])
PY
  )"
fi

OUT_ISO="${OUTPUT_DIR}/droplet-${SHAPE}-${VERSION}.iso"

echo "============================================="
echo " Droplet appliance ISO builder"
echo " Shape:   ${SHAPE}"
echo " Version: ${VERSION}"
echo " Base:    ${UBUNTU_ISO}"
echo "============================================="
echo ""

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
for tool in docker curl openssl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' not on PATH." >&2
    exit 1
  fi
done

# Validate the autoinstall overlay exists (mirrors openwrt/build.sh step 2).
REQUIRED_OVERLAY=(
  "${AUTOINSTALL_DIR}/user-data"
  "${AUTOINSTALL_DIR}/meta-data"
  "${GRUB_CFG}"
)
echo "[1/5] Validating autoinstall overlay..."
missing=0
for f in "${REQUIRED_OVERLAY[@]}"; do
  if [ ! -f "$f" ]; then
    echo "  MISSING: ${f#"$REPO_ROOT"/}"
    missing=1
  else
    echo "  OK: ${f#"$REPO_ROOT"/}"
  fi
done
if [ "$missing" -eq 1 ]; then
  echo "ERROR: missing autoinstall overlay file(s). Aborting." >&2
  exit 1
fi
echo ""

mkdir -p "$OUTPUT_DIR" "$WORK_DIR"

# ---------------------------------------------------------------------------
# Step 2: download the pinned upstream ISO (skip if already present + verified)
# ---------------------------------------------------------------------------
SRC_ISO="${WORK_DIR}/${UBUNTU_ISO}"
echo "[2/5] Fetching pinned Ubuntu ${UBUNTU_VERSION} live-server ISO..."
if [ ! -f "$SRC_ISO" ]; then
  curl -fSL --retry 3 -o "$SRC_ISO" "$UBUNTU_ISO_URL"
else
  echo "  Already downloaded: ${SRC_ISO#"$REPO_ROOT"/}"
fi

# ---------------------------------------------------------------------------
# Step 3: VERIFY SHA256 (fail-closed — never repack an unverified base image)
# ---------------------------------------------------------------------------
echo "[3/5] Verifying SHA256 of the base ISO..."
actual_sha="$(_sha256_of "$SRC_ISO")"
if [ "$actual_sha" != "$UBUNTU_ISO_SHA256" ]; then
  echo "ERROR: SHA256 mismatch on ${UBUNTU_ISO}" >&2
  echo "  expected: ${UBUNTU_ISO_SHA256}" >&2
  echo "  actual:   ${actual_sha}" >&2
  echo "  The Ubuntu point release likely rotated — refresh the pin (see the" >&2
  echo "  REFRESH PROCEDURE block at the top of this script). Aborting." >&2
  exit 1
fi
echo "  SHA256 OK (${UBUNTU_ISO_SHA256})"
echo ""

# ---------------------------------------------------------------------------
# Step 4: repack with the embedded autoinstall seed (dockerized xorriso)
# ---------------------------------------------------------------------------
# We do the unpack -> inject -> xorriso repack INSIDE an Ubuntu container so the
# host needs no xorriso/rsync. The seed goes to /server/{user-data,meta-data};
# the GRUB menu is replaced so the default entry boots `autoinstall
# ds=nocloud;s=/cdrom/server/`.
echo "[4/5] Repacking ISO with the autoinstall seed (dockerized xorriso)..."

# The inner script runs as root in the container. /src is the build dir
# (read-only), /out is output/. We extract the ISO, drop the seed in, rewrite
# grub.cfg, then xorriso-rebuild an EFI+BIOS bootable ISO.
docker run --rm \
  -v "${WORK_DIR}:/work" \
  -v "${AUTOINSTALL_DIR}:/seed:ro" \
  -v "${GRUB_CFG}:/grub-autoinstall.cfg:ro" \
  -v "${OUTPUT_DIR}:/out" \
  -e "UBUNTU_ISO=${UBUNTU_ISO}" \
  -e "OUT_ISO_NAME=$(basename "$OUT_ISO")" \
  ubuntu:24.04 \
  bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends xorriso rsync >/dev/null

    mkdir -p /work/extract
    # Extract the source ISO contents.
    xorriso -osirrox on -indev "/work/${UBUNTU_ISO}" -extract / /work/extract
    chmod -R u+w /work/extract

    # Inject the nocloud seed at /server/ and replace the GRUB menu.
    mkdir -p /work/extract/server
    cp /seed/user-data /work/extract/server/user-data
    cp /seed/meta-data /work/extract/server/meta-data
    cp /grub-autoinstall.cfg /work/extract/boot/grub/grub.cfg

    # Repack a hybrid EFI/BIOS bootable ISO. The El Torito + GPT-appended-
    # partition flags below are the canonical recipe for a modern Ubuntu
    # live-server repack (efi.img is the appended EFI system partition).
    xorriso -as mkisofs \
      -r -V "DROPLET_${OUT_ISO_NAME}" \
      -o "/out/${OUT_ISO_NAME}" \
      --grub2-mbr /work/extract/boot/grub/i386-pc/boot_hybrid.img \
      -partition_offset 16 \
      --mbr-force-bootable \
      -append_partition 2 0xEF /work/extract/EFI/boot/efi.img \
      -appended_part_as_gpt \
      -c /boot.catalog \
      -b /boot/grub/i386-pc/eltorito.img \
        -no-emul-boot -boot-load-size 4 -boot-info-table --grub2-boot-info \
      -eltorito-alt-boot \
      -e --interval:appended_partition_2:all:: -no-emul-boot \
      /work/extract
    echo "repack complete: /out/${OUT_ISO_NAME}"
  '
echo ""

# ---------------------------------------------------------------------------
# Step 5: collect + print flash instructions (mirrors openwrt/build.sh step 4)
# ---------------------------------------------------------------------------
echo "[5/5] Build complete."
echo ""
echo "============================================="
echo " BUILD COMPLETE"
echo "============================================="
echo ""
if [ -f "$OUT_ISO" ]; then
  ls -lh "$OUT_ISO"
  # Emit a sidecar sha256 so `droplet-image flash` can verify before writing.
  _sha256_of "$OUT_ISO" > "${OUT_ISO}.sha256"
  echo " sha256: $(cut -d' ' -f1 < "${OUT_ISO}.sha256")"
else
  echo " WARNING: expected output not found: ${OUT_ISO#"$REPO_ROOT"/}"
fi
echo ""
echo " Catalogue + sign the release:"
echo "   ./scripts/droplet-image manifest --version ${VERSION}"
echo "   DROPLET_RELEASE_SIGNING_KEY=<key> ./scripts/droplet-image sign"
echo ""
echo " Flash to a disk (NAMES the target in the confirm phrase):"
echo "   ./scripts/droplet-image flash \\"
echo "       --image ${OUT_ISO#"$REPO_ROOT"/} \\"
echo "       --device /dev/sdX \\"
echo "       --confirm \"ERASE /dev/sdX\""
echo ""
echo " The flashed box installs Ubuntu unattended, clones this repo to"
echo " /home/droplet/edge-platform, and runs setup.sh --single-box --systemd"
echo " on first boot. See docs/IMAGE_PIPELINE.md for the manual boot gate."
echo ""
