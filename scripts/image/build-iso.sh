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
ALLOW_BLANK_DOWNLOADS=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --shape)   SHAPE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    # WARP-2666. Build an image whose /downloads page will be empty for one or
    # more platforms. Requires that every such platform is declared `blocked`
    # WITH a ticket in data/app-downloads/EXPECTED — this flag waives a
    # DECLARED gap, never an undeclared one. The flag and the full blocked list
    # are echoed into the build log so the decision is on the record.
    --allow-blank-downloads) ALLOW_BLANK_DOWNLOADS=true; shift ;;
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

# ---------------------------------------------------------------------------
# Step 0: client-app pre-flight (WARP-2666)
# ---------------------------------------------------------------------------
# Every appliance ISO ever built shipped a /downloads page with nothing on it.
# Nothing caught it because an empty catalog is a legitimate, HTTP-200 state:
# there is no failing signal to notice, only a missing success. This is the
# last moment a human can still decide, so the builder asks before it repacks
# 3 GB.
#
# Placed BEFORE the ISO download deliberately: refusing after a multi-gigabyte
# fetch teaches people to pass the override reflexively.
echo "[0/5] Client-app pre-flight (data/app-downloads/EXPECTED)..."
AUDIT_SH="${REPO_ROOT}/scripts/app-downloads/audit.sh"
if [ ! -r "$AUDIT_SH" ]; then
  echo "ERROR: $AUDIT_SH is missing — cannot tell what this release should carry." >&2
  echo "       Refusing to build rather than guessing. (WARP-2666)" >&2
  exit 1
fi
audit_rc=0
# `set -e` would abort on the non-zero exits this pre-flight is here to READ.
bash "$AUDIT_SH" --dir "${REPO_ROOT}/data/app-downloads" || audit_rc=$?
case "$audit_rc" in
  0)
    echo "  OK: every platform EXPECTED declares is staged and verified."
    ;;
  3)
    if [ "$ALLOW_BLANK_DOWNLOADS" = true ]; then
      echo ""
      echo "  ***************************************************************"
      echo "  * BUILDING WITH --allow-blank-downloads                        *"
      echo "  * The platforms listed above are declared blocked and will     *"
      echo "  * have NOTHING to download on this image. A customer opening   *"
      echo "  * 'Get the app' gets no app for them.                          *"
      echo "  ***************************************************************"
      echo ""
    else
      echo "" >&2
      echo "ERROR: this image would ship a /downloads page with nothing on it" >&2
      echo "       for the platforms listed above." >&2
      echo "" >&2
      echo "       Stage the installers first:" >&2
      echo "         ./scripts/app-downloads/stage.sh <installer> [...]" >&2
      echo "" >&2
      echo "       Or, if shipping without them is the decision, say so:" >&2
      echo "         $0 --allow-blank-downloads" >&2
      echo "" >&2
      exit 1
    fi
    ;;
  4)
    echo "ERROR: the client-app audit reached NO VERDICT (exit 4)." >&2
    echo "       'I could not check' is not 'it is fine' — fix the audit input" >&2
    echo "       (EXPECTED, the staging root, or python3) and re-run." >&2
    echo "       --allow-blank-downloads does NOT waive this: it waives a" >&2
    echo "       DECLARED gap, and there is no declaration to read." >&2
    exit 1
    ;;
  *)
    echo "ERROR: client-app audit reports this release does not carry what" >&2
    echo "       data/app-downloads/EXPECTED declares (exit $audit_rc)." >&2
    echo "       A declared installer is missing or its bytes no longer match" >&2
    echo "       the catalog. --allow-blank-downloads does NOT waive this." >&2
    exit 1
    ;;
esac
echo ""

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
  # Write with a bare filename from inside WORK_DIR. A native curl on a
  # Git-Bash/Windows host can't open an MSYS-style absolute path ("/c/…");
  # a bare name in the CWD is portable across Linux and Git-Bash alike.
  ( cd "$WORK_DIR" && curl -fSL --retry 3 -o "$UBUNTU_ISO" "$UBUNTU_ISO_URL" )
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
# Step 4: inject the autoinstall seed into the ISO (dockerized xorriso)
# ---------------------------------------------------------------------------
# We modify the ISO IN PLACE rather than extract + mkisofs-rebuild: load the
# upstream ISO, add the nocloud seed at /server/, swap in our GRUB menu, and
# write a new ISO. `-boot_image any replay` re-creates BOTH boot images (the
# BIOS El-Torito image AND the UEFI GPT-appended ESP) at the new, correct
# offsets. This matters because Ubuntu stores the hybrid boot blobs OUTSIDE the
# ISO9660 tree — a plain extract loses them and a hand-rolled mkisofs recipe is
# fragile; replay reads them from the loaded image and reproduces them exactly.
# xorriso runs in a container so the host needs no xorriso.
echo "[4/5] Injecting the autoinstall seed (dockerized xorriso, boot replay)..."

# MSYS_NO_PATHCONV stops Git-Bash from rewriting the container-side mount
# targets (/work, /seed, /out, …) into Windows paths. No-op on a Linux host.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "${WORK_DIR}:/work" \
  -v "${AUTOINSTALL_DIR}:/seed:ro" \
  -v "${GRUB_CFG}:/grub-autoinstall.cfg:ro" \
  -v "${OUTPUT_DIR}:/out" \
  -e "UBUNTU_ISO=${UBUNTU_ISO}" \
  -e "OUT_ISO_NAME=$(basename "$OUT_ISO")" \
  -e "DROPLET_VERSION=${VERSION}" \
  ubuntu:24.04 \
  bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends xorriso >/dev/null

    rm -f "/out/${OUT_ISO_NAME}"
    # ISO9660 volume id: strict d-characters only (A-Z 0-9 _), <= 32 chars, so
    # dots in the version become underscores (DROPLET_0_2_0).
    volid="DROPLET_${DROPLET_VERSION//./_}"

    # In-place modify: replay the upstream boot setup, add the nocloud seed at
    # /server/, and replace the GRUB menu (-overwrite on lets the map replace
    # the existing grub.cfg). No extract, no fragile boot-image reconstruction.
    xorriso \
      -indev "/work/${UBUNTU_ISO}" \
      -outdev "/out/${OUT_ISO_NAME}" \
      -boot_image any replay \
      -volid "$volid" \
      -compliance no_emul_toc \
      -overwrite on \
      -map /seed/user-data /server/user-data \
      -map /seed/meta-data /server/meta-data \
      -map /grub-autoinstall.cfg /boot/grub/grub.cfg \
      -commit -end
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
