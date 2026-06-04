#!/usr/bin/env bash
# =============================================================================
# scripts/lib/image.sh — WARP-663 / ADR-020 appliance image-pipeline handlers
# =============================================================================
#
# Sourced by scripts/droplet-image; do NOT execute directly. Defines the
# `image_<subcommand>` handlers behind the `droplet-image` CLI:
#
#   image_build     Build the appliance image for a --shape at a --version.
#   image_manifest  Add/refresh this build's entry in manifest.json.
#   image_sign      Detached ECDSA-P256 signature over manifest.json.
#   image_verify    Verify the signature (+ each asset sha256), fail-closed.
#   image_list      List versions from a local manifest.
#   image_publish   Push artifact + signed manifest to the releases repo.
#   image_flash     Verify, then write an image to a disk — behind the ADR-019
#                   destructive-op safety guard (typed confirm + disk probes).
#
# Signing primitive: OpenSSL ECDSA over P-256 ONLY (FIPS-approved; Ed25519 /
# minisign is forbidden per docs/security/fips-allowed-algorithms.md).
#
# Flash-safety hooks (so the pre-flight is unit-testable without root or a real
# disk — mirrors scripts/host/droplet-storage-pool.sh's DROPLET_POOL_* hooks):
#   DROPLET_IMAGE_DRY_RUN=1          print the dd command instead of running it
#   DROPLET_IMAGE_TEST_MOUNTED=dev   simulate `dev` being mounted
#   DROPLET_IMAGE_TEST_HASDATA=dev   simulate `dev` holding a populated fs
#   DROPLET_IMAGE_TEST_OSDISK=dev    simulate `dev` being/backing the OS disk
# In a real invocation these are empty and the script uses findmnt/lsblk/blkid.
# =============================================================================

# REPO_ROOT is exported by the droplet-image dispatcher. logging.sh (log_info,
# log_error, log_success, …) is sourced there too.

IMAGE_DIR="$REPO_ROOT/scripts/image"
OUTPUT_DIR="$REPO_ROOT/output"
SCHEMA_FILE="$IMAGE_DIR/manifest.schema.json"
MANIFEST_FILE="$IMAGE_DIR/manifest.json"
GEN_MANIFEST="$IMAGE_DIR/gen-manifest.py"
PUBKEY_FILE="$IMAGE_DIR/keys/droplet-release.pub"

img_err() { printf 'droplet-image: %s\n' "$*" >&2; }
img_die() { img_err "$*"; exit 1; }

# --- tiny flag parser --------------------------------------------------------
# Reads `--name value` pairs into shell vars FLAG_<NAME-UPPER-WITH-UNDERSCORES>.
# Unknown flags are an error so a typo never silently no-ops a destructive op.
_img_parse_flags() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --*)
        local key="${1#--}"
        key="${key//-/_}"
        key="$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]')"
        if [ "$#" -lt 2 ]; then img_die "flag --${1#--} needs a value"; fi
        printf -v "FLAG_${key}" '%s' "$2"
        shift 2
        ;;
      *) img_die "unexpected argument: $1" ;;
    esac
  done
}

# =============================================================================
# build
# =============================================================================
# Thin wrapper: parse --shape/--version, then exec the real builder. The heavy
# lifting (pinned ISO download, SHA256 verify, xorriso repack) lives in
# scripts/image/build-iso.sh so the builder stays mirror-able to openwrt/build.sh.
image_build() {
  local FLAG_SHAPE="" FLAG_VERSION=""
  _img_parse_flags "$@"
  local shape="${FLAG_SHAPE:-single-box}"
  local version="${FLAG_VERSION:-}"

  if [ "$shape" != "single-box" ]; then
    img_die "unsupported --shape '$shape' (Phase 1 builds single-box only)"
  fi

  local build_iso="$IMAGE_DIR/build-iso.sh"
  [ -f "$build_iso" ] || img_die "builder not found: $build_iso"

  log_info "Building appliance image: shape=$shape version=${version:-<from package.json>}"
  # Delegate. build-iso.sh reads --version (or falls back to package.json) and
  # emits output/droplet-${shape}-<version>.iso.
  exec bash "$build_iso" --shape "$shape" ${version:+--version "$version"}
}

# =============================================================================
# manifest
# =============================================================================
# Add/refresh this build's entry in manifest.json via gen-manifest.py, hashing
# the built artifact. Requires the artifact to exist in output/.
image_manifest() {
  local FLAG_SHAPE="" FLAG_VERSION="" FLAG_FILE="" FLAG_URL="" FLAG_MIN_DISK_GIB=""
  _img_parse_flags "$@"
  local shape="${FLAG_SHAPE:-single-box}"
  local version="${FLAG_VERSION:-}"
  [ -n "$version" ] || img_die "manifest requires --version"

  local file="${FLAG_FILE:-droplet-${shape}-${version}.iso}"
  local artifact="$OUTPUT_DIR/$file"
  [ -f "$artifact" ] || img_die "artifact not found: $artifact (run 'droplet-image build' first)"

  local url="${FLAG_URL:-https://github.com/DropletByWarpLab/releases/releases/download/v${version}/${file}}"
  local min_disk="${FLAG_MIN_DISK_GIB:-32}"
  local size git_sha
  size="$(_img_file_size "$artifact")"
  git_sha="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || printf '0%.0s' $(seq 40))"

  python3 "$GEN_MANIFEST" build \
    --schema "$SCHEMA_FILE" \
    --shape "$shape" --version "$version" --format iso \
    --file "$file" --url "$url" --size "$size" \
    --sha256-of "$artifact" \
    --git-sha "$git_sha" --min-disk-gib "$min_disk" \
    --merge-into "$MANIFEST_FILE" --out "$MANIFEST_FILE" \
    || img_die "gen-manifest build failed"
  log_success "Updated $MANIFEST_FILE for ${shape} ${version}"
}

_img_file_size() {
  # Portable byte size (GNU stat, BSD stat, then wc -c fallback).
  stat -c %s "$1" 2>/dev/null \
    || stat -f %z "$1" 2>/dev/null \
    || wc -c < "$1" | tr -d ' '
}

# =============================================================================
# sign
# =============================================================================
# Detached ECDSA-P256 signature over the manifest. Private key path comes from
# $DROPLET_RELEASE_SIGNING_KEY (never a flag, never committed).
image_sign() {
  local FLAG_MANIFEST="" FLAG_SIG=""
  _img_parse_flags "$@"
  local manifest="${FLAG_MANIFEST:-$MANIFEST_FILE}"
  local sig="${FLAG_SIG:-$manifest.sig}"

  [ -f "$manifest" ] || img_die "manifest not found: $manifest"
  local key="${DROPLET_RELEASE_SIGNING_KEY:-}"
  [ -n "$key" ] || img_die "set \$DROPLET_RELEASE_SIGNING_KEY to the private signing key path"
  [ -f "$key" ] || img_die "signing key not found: $key"

  # ECDSA over P-256: openssl picks ECDSA from the key type; -sha256 is the
  # digest. Output is a DER-encoded ECDSA signature.
  if openssl dgst -sha256 -sign "$key" -out "$sig" "$manifest" 2>/dev/null; then
    log_success "Signed $manifest -> $sig (ECDSA-P256)"
  else
    img_die "openssl signing failed (is \$DROPLET_RELEASE_SIGNING_KEY an EC P-256 key?)"
  fi
}

# =============================================================================
# verify  (fail-closed)
# =============================================================================
# Verify the manifest signature against the tracked (or --pubkey) public key,
# AND — when assets are present locally — each listed asset's sha256. Any
# failure exits non-zero with NO partial success.
image_verify() {
  local FLAG_MANIFEST="" FLAG_SIG="" FLAG_PUBKEY="" FLAG_ASSETS_DIR=""
  _img_parse_flags "$@"
  local manifest="${FLAG_MANIFEST:-$MANIFEST_FILE}"
  local sig="${FLAG_SIG:-$manifest.sig}"
  local pubkey="${FLAG_PUBKEY:-$PUBKEY_FILE}"
  local assets_dir="${FLAG_ASSETS_DIR:-$OUTPUT_DIR}"

  [ -f "$manifest" ] || img_die "manifest not found: $manifest"
  [ -f "$sig" ]      || img_die "signature not found: $sig"
  [ -f "$pubkey" ]   || img_die "public key not found: $pubkey"

  # 1. Signature over the manifest bytes. Fail-closed.
  if ! openssl dgst -sha256 -verify "$pubkey" -signature "$sig" "$manifest" >/dev/null 2>&1; then
    img_die "SIGNATURE VERIFY FAILED for $manifest — refusing (manifest tampered or wrong key)"
  fi

  # 2. Structural validity against the schema (a signed-but-malformed manifest
  #    is still untrustworthy).
  if [ -f "$GEN_MANIFEST" ] && [ -f "$SCHEMA_FILE" ]; then
    python3 "$GEN_MANIFEST" validate --schema "$SCHEMA_FILE" "$manifest" >/dev/null 2>&1 \
      || img_die "manifest signature OK but schema validation FAILED for $manifest"
  fi

  # 3. Each listed asset present locally must match its sha256. Missing assets
  #    are not an error here (verify can run before download); a PRESENT asset
  #    that mismatches IS fail-closed.
  local mismatches=0 checked=0
  while IFS=$'\t' read -r fname expected; do
    [ -n "$fname" ] || continue
    local path="$assets_dir/$fname"
    [ -f "$path" ] || continue
    local actual
    actual="$(_img_sha256 "$path")"
    checked=$((checked + 1))
    if [ "$actual" != "$expected" ]; then
      img_err "asset sha256 MISMATCH: $fname (manifest=$expected actual=$actual)"
      mismatches=$((mismatches + 1))
    fi
  done < <(_img_manifest_assets "$manifest")

  if [ "$mismatches" -gt 0 ]; then
    img_die "$mismatches asset(s) failed sha256 verification — refusing"
  fi

  log_success "verify OK: signature valid$([ "$checked" -gt 0 ] && printf ', %s asset sha256 match' "$checked")"
}

_img_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  fi
}

# Emit "<file>\t<sha256>" per image entry. Pure json.loads (never evals).
_img_manifest_assets() {
  MANIFEST_PATH="$1" python3 - <<'PY'
import json, os, sys
try:
    data = json.load(open(os.environ["MANIFEST_PATH"], encoding="utf-8"))
except Exception:
    sys.exit(0)
sys.stdout.reconfigure(newline="\n")
for img in data.get("images", []):
    f = img.get("file"); s = img.get("sha256")
    if f and s:
        sys.stdout.write(f"{f}\t{s}\n")
PY
}

# =============================================================================
# list
# =============================================================================
image_list() {
  local FLAG_MANIFEST=""
  _img_parse_flags "$@"
  local manifest="${FLAG_MANIFEST:-$MANIFEST_FILE}"
  [ -f "$manifest" ] || img_die "manifest not found: $manifest"

  MANIFEST_PATH="$manifest" python3 - <<'PY'
import json, os, sys
data = json.load(open(os.environ["MANIFEST_PATH"], encoding="utf-8"))
imgs = data.get("images", [])
if not imgs:
    print("(no images published yet)")
    sys.exit(0)
print(f"{'SHAPE':<12} {'VERSION':<10} {'FORMAT':<7} {'SIZE':>12}  FILE")
for img in imgs:
    print(f"{img.get('shape',''):<12} {img.get('version',''):<10} "
          f"{img.get('format',''):<7} {img.get('size',0):>12}  {img.get('file','')}")
PY
}

# =============================================================================
# publish  (guarded — never creates the repo / publishes in WARP-663)
# =============================================================================
# Push the artifact + signed manifest to DropletByWarpLab/releases via
# `gh release`. ADR-020 §D3: creating that repo, generating the keypair, and the
# first publish are confirmation-gated and OUT OF SCOPE here. So this fails with
# a clear message if the repo / asset / creds are absent — it never creates the
# repo and never performs a live publish on its own.
image_publish() {
  local FLAG_VERSION="" FLAG_SHAPE="" FLAG_FILE=""
  _img_parse_flags "$@"
  local version="${FLAG_VERSION:-}"
  [ -n "$version" ] || img_die "publish requires --version"
  local shape="${FLAG_SHAPE:-single-box}"
  local file="${FLAG_FILE:-droplet-${shape}-${version}.iso}"
  local artifact="$OUTPUT_DIR/$file"
  local releases_repo="DropletByWarpLab/releases"

  command -v gh >/dev/null 2>&1 \
    || img_die "gh CLI not found — publish needs the GitHub CLI"
  [ -f "$artifact" ] \
    || img_die "artifact not found: $artifact (build it first)"
  [ -f "$MANIFEST_FILE.sig" ] \
    || img_die "signed manifest not found: $MANIFEST_FILE.sig (run 'droplet-image sign' first)"

  # Auth + repo-existence guard. We REFUSE rather than create the repo.
  if ! gh auth status >/dev/null 2>&1; then
    img_die "gh is not authenticated — run 'gh auth login' (publish does not create credentials)"
  fi
  if ! gh repo view "$releases_repo" >/dev/null 2>&1; then
    img_die "releases repo '$releases_repo' not found or not accessible.
  Creating it + minting the signing keypair + the first publish are a deferred,
  confirmation-gated step (ADR-020 §D3). This command will NOT create the repo."
  fi

  log_info "Publishing $file + signed manifest to $releases_repo (tag v$version)…"
  gh release create "v$version" \
    --repo "$releases_repo" \
    --title "Droplet appliance $version" \
    --notes "Appliance image $shape $version. Verify: droplet-image verify." \
    "$artifact" "$MANIFEST_FILE" "$MANIFEST_FILE.sig" \
    || img_die "gh release create failed"
  log_success "Published v$version to $releases_repo"
}

# =============================================================================
# flash  (ADR-019 destructive-op safety guard)
# =============================================================================
# Writing an OS image to a block device is as destructive as mdadm --create.
# Pre-flight (the last line of defense — NEVER run blind):
#   1. A typed confirm-phrase MUST be present AND must name the target device.
#   2. Refuse a target that is mounted, holds a populated filesystem, or is /
#      backs the OS/boot disk.
# The DROPLET_IMAGE_TEST_* hooks make these refusals unit-testable without root.
image_flash() {
  local FLAG_IMAGE="" FLAG_DEVICE="" FLAG_CONFIRM=""
  _img_parse_flags "$@"
  local image="$FLAG_IMAGE"
  local device="$FLAG_DEVICE"
  local confirm="$FLAG_CONFIRM"
  local dry_run="${DROPLET_IMAGE_DRY_RUN:-}"

  [ -n "$image" ]  || img_die "flash requires --image <path>"
  [ -n "$device" ] || img_die "flash requires --device <path>"
  [ -f "$image" ]  || img_die "image not found: $image"

  # --- confirm-phrase gate: must be present AND name the target device ------
  [ -n "$confirm" ] || img_die "missing --confirm phrase — refusing to flash blind.
  Re-run with --confirm naming the target, e.g. --confirm \"ERASE $device\""

  local short
  short="$(basename "$device")"
  case "$confirm" in
    *"$device"*) ;;                       # names the full path
    *"$short"*)  ;;                       # or at least the short name
    *) img_die "--confirm must NAME the target device ($device). Refusing." ;;
  esac

  # --- disk safety probes (real: findmnt/lsblk/blkid; TEST_* hooks override) -
  if _img_is_mounted "$device"; then
    img_die "refusing: $device is mounted — unmount it first"
  fi
  if _img_is_os_disk "$device"; then
    img_die "refusing: $device is (or backs) the OS/boot/system disk"
  fi
  if _img_has_data "$device"; then
    img_die "refusing: $device holds a filesystem with data — erase it deliberately first"
  fi

  # --- verify the image before writing (best-effort: only if a sidecar
  #     sha256 or manifest entry exists; never flash an unverifiable image
  #     silently when a checksum IS available) --------------------------------
  if [ -f "$image.sha256" ]; then
    local want got
    want="$(cut -d' ' -f1 < "$image.sha256")"
    got="$(_img_sha256 "$image")"
    [ "$want" = "$got" ] || img_die "image sha256 mismatch vs $image.sha256 — refusing"
  fi

  # --- execute (or dry-run) -------------------------------------------------
  local cmd="dd if=$image of=$device bs=4M conv=fsync status=progress"
  if [ -n "$dry_run" ]; then
    img_err "dry-run: would execute: $cmd"
    printf '{"ok": true, "device": "%s", "image": "%s", "dry_run": true}\n' "$device" "$image"
    return 0
  fi

  log_info "Flashing $image -> $device …"
  dd if="$image" of="$device" bs=4M conv=fsync status=progress
  sync
  log_success "Flashed $image -> $device"
  printf '{"ok": true, "device": "%s", "image": "%s", "dry_run": false}\n' "$device" "$image"
}

# --- disk safety probes (mirrors droplet-storage-pool.sh) --------------------
_img_is_mounted() {
  local dev="$1"
  if [ -n "${DROPLET_IMAGE_TEST_MOUNTED:-}" ]; then
    [ "$dev" = "$DROPLET_IMAGE_TEST_MOUNTED" ] && return 0 || return 1
  fi
  findmnt -rn --source "$dev" >/dev/null 2>&1 && return 0
  lsblk -rno MOUNTPOINT "$dev" 2>/dev/null | grep -q . && return 0
  return 1
}

_img_has_data() {
  local dev="$1"
  if [ -n "${DROPLET_IMAGE_TEST_HASDATA:-}" ]; then
    [ "$dev" = "$DROPLET_IMAGE_TEST_HASDATA" ] && return 0 || return 1
  fi
  blkid -p -o value -s TYPE "$dev" 2>/dev/null | grep -q . && return 0
  return 1
}

_img_is_os_disk() {
  local dev="$1"
  if [ -n "${DROPLET_IMAGE_TEST_OSDISK:-}" ]; then
    [ "$dev" = "$DROPLET_IMAGE_TEST_OSDISK" ] && return 0 || return 1
  fi
  local this_disk
  this_disk="$(lsblk -ndo PKNAME "$dev" 2>/dev/null || true)"
  [ -n "$this_disk" ] || this_disk="$(basename "$dev")"
  local mp src parent
  for mp in / /boot /boot/efi; do
    src="$(findmnt -rn -o SOURCE --target "$mp" 2>/dev/null || true)"
    [ -n "$src" ] || continue
    parent="$(lsblk -ndo PKNAME "$src" 2>/dev/null || true)"
    [ -n "$parent" ] || parent="$(basename "$src")"
    [ "$parent" = "$this_disk" ] && return 0
  done
  return 1
}
