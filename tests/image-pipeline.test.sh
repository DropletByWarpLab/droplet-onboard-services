#!/usr/bin/env bash
# =============================================================================
# WARP-663 / ADR-020 — appliance image pipeline unit tests
# =============================================================================
#
# Exercises the `droplet-image` CLI + the manifest tooling WITHOUT building a
# real ISO or touching a real block device:
#
#   (a) `droplet-image help` lists all 7 subcommands.
#   (b) manifest sign <-> verify round-trip with a THROWAWAY ECDSA-P256 keypair
#       generated in mktemp: sign + verify OK; flip one byte of the manifest ->
#       verify FAILS (fail-closed tamper detection).
#   (c) gen-manifest.py accepts a valid manifest and rejects a bad one (missing
#       sha256; wrong field type).
#   (d) `droplet-image flash` pre-flight REFUSES under each of
#       DROPLET_IMAGE_TEST_{MOUNTED,OSDISK,HASDATA}, and on a missing / wrong
#       confirm-phrase — all under DROPLET_IMAGE_DRY_RUN=1, no real device.
#
# Signing is OpenSSL ECDSA-P256 ONLY (FIPS-approved; Ed25519/minisign is
# forbidden per docs/security/fips-allowed-algorithms.md).
#
# Does NOT require Docker, root, or a real disk. Runtime: < 5 seconds.
# =============================================================================
set -uo pipefail
# Not `set -e`: individual assertions report and continue so a single failure
# doesn't mask the rest of the suite.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
DROPLET_IMAGE="$REPO_ROOT_REAL/scripts/droplet-image"
GEN_MANIFEST="$REPO_ROOT_REAL/scripts/image/gen-manifest.py"
SCHEMA="$REPO_ROOT_REAL/scripts/image/manifest.schema.json"

FAILURES=0
TESTS=0

# --- Colors ---
if [ -t 1 ]; then
  _GREEN='\033[0;32m'; _RED='\033[0;31m'; _YELLOW='\033[0;33m'; _RESET='\033[0m'
else
  _GREEN=''; _RED=''; _YELLOW=''; _RESET=''
fi

pass() { TESTS=$((TESTS + 1)); printf "  ${_GREEN}✓${_RESET} %s\n" "$1"; }
fail() {
  TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1))
  printf "  ${_RED}✗${_RESET} %s\n" "$1"
  if [ "$#" -gt 1 ]; then shift; printf "      %s\n" "$@" >&2; fi
}

echo ""
echo "  ================================================"
echo "  Appliance image-pipeline unit tests (WARP-663)"
echo "  ================================================"
echo ""

# Hard preconditions — these tools are required, not optional.
for tool in openssl python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf "  ${_RED}FATAL${_RESET}  %s not on PATH — required for the pipeline tests\n" "$tool" >&2
    exit 2
  fi
done
if [ ! -f "$DROPLET_IMAGE" ]; then
  printf "  ${_RED}FATAL${_RESET}  %s not found\n" "$DROPLET_IMAGE" >&2
  exit 2
fi

# Throwaway working dir — keys, manifests, signatures. Never the real keys.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# =============================================================================
# (a) help lists all 7 subcommands
# =============================================================================
echo "--- (a) droplet-image help lists all 7 subcommands ---"

HELP_OUT="$(bash "$DROPLET_IMAGE" help 2>&1)"
for sub in build manifest sign verify list publish flash; do
  if printf '%s\n' "$HELP_OUT" | grep -qE "(^|[^a-z])${sub}([^a-z]|$)"; then
    pass "help lists '$sub'"
  else
    fail "help does not list '$sub'" "help output:" "$HELP_OUT"
  fi
done

# `droplet-image` with no args should also print help and exit 0 (operator
# convenience — mirrors droplet-admin).
if bash "$DROPLET_IMAGE" >/dev/null 2>&1; then
  pass "bare 'droplet-image' (no args) exits 0 with help"
else
  fail "bare 'droplet-image' did not exit 0"
fi

# Unknown subcommand exits 64 (EX_USAGE), mirroring droplet-admin.
bash "$DROPLET_IMAGE" definitely-not-a-subcommand >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 64 ]; then
  pass "unknown subcommand exits 64 (EX_USAGE)"
else
  fail "unknown subcommand exit was $rc (expected 64)"
fi

# =============================================================================
# (b) manifest sign <-> verify round-trip (throwaway ECDSA-P256 keypair)
# =============================================================================
echo "--- (b) sign/verify round-trip with a throwaway ECDSA-P256 keypair ---"

PRIV="$WORK/release-test.key"
PUB="$WORK/release-test.pub"

# Generate a throwaway P-256 keypair (ECDSA, FIPS-approved). genpkey form
# matches the repo's existing openssl usage in scripts/lib/secrets.sh.
if openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
     -out "$PRIV" 2>/dev/null \
   && openssl pkey -in "$PRIV" -pubout -out "$PUB" 2>/dev/null; then
  pass "generated a throwaway ECDSA-P256 keypair"
else
  fail "could not generate a throwaway ECDSA-P256 keypair — cannot test sign/verify"
fi

# Build a minimal but valid manifest to sign. gen-manifest.py is the canonical
# constructor; if it isn't present yet (RED phase) fall back to a hand-written
# one so the round-trip is still exercised once droplet-image lands.
MANIFEST="$WORK/manifest.json"
if [ -f "$GEN_MANIFEST" ]; then
  python3 "$GEN_MANIFEST" build \
    --schema "$SCHEMA" \
    --shape single-box \
    --version 0.2.0 \
    --file "droplet-single-box-0.2.0.iso" \
    --url "https://github.com/DropletByWarpLab/releases/releases/download/v0.2.0/droplet-single-box-0.2.0.iso" \
    --sha256 "$(printf 'test-iso-bytes' | openssl dgst -sha256 -r | cut -d' ' -f1)" \
    --size 3000000000 \
    --git-sha "0000000000000000000000000000000000000000" \
    --min-disk-gib 32 \
    --out "$MANIFEST" >/dev/null 2>&1
fi
if [ ! -s "$MANIFEST" ]; then
  cat > "$MANIFEST" <<'JSON'
{
  "schemaVersion": 1,
  "images": [
    {
      "shape": "single-box",
      "version": "0.2.0",
      "format": "iso",
      "file": "droplet-single-box-0.2.0.iso",
      "url": "https://example.invalid/droplet-single-box-0.2.0.iso",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "size": 3000000000,
      "gitSha": "0000000000000000000000000000000000000000",
      "buildDate": "2026-06-04T00:00:00Z",
      "minDiskGiB": 32
    }
  ]
}
JSON
fi

SIG="$MANIFEST.sig"

# Sign via the CLI (it must shell out to `openssl dgst -sha256 -sign`).
if DROPLET_RELEASE_SIGNING_KEY="$PRIV" \
   bash "$DROPLET_IMAGE" sign --manifest "$MANIFEST" --sig "$SIG" >/dev/null 2>&1 \
   && [ -s "$SIG" ]; then
  pass "sign produced a detached signature over the manifest"
else
  fail "sign did not produce a signature (DROPLET_RELEASE_SIGNING_KEY=$PRIV)"
fi

# Verify the untampered manifest against the throwaway public key. Point at a
# dedicated EMPTY assets dir so the run is hermetic — verify defaults assets_dir
# to OUTPUT_DIR (output/), which holds the real multi-GB ISO after a `build`,
# and that asset's sha256 would (correctly) mismatch this throwaway manifest.
# We exercise the per-asset path explicitly in (b2) below; here we isolate the
# signature path. (review #501)
EMPTY_ASSETS="$WORK/empty-assets"
mkdir -p "$EMPTY_ASSETS"
if bash "$DROPLET_IMAGE" verify \
     --manifest "$MANIFEST" --sig "$SIG" --pubkey "$PUB" --assets-dir "$EMPTY_ASSETS" >/dev/null 2>&1; then
  pass "verify accepts the untampered manifest"
else
  fail "verify rejected the untampered manifest (false negative)"
fi

# Tamper: flip one byte of the manifest, re-verify — MUST fail (fail-closed).
TAMPERED="$WORK/manifest.tampered.json"
cp "$MANIFEST" "$TAMPERED"
# Append a byte (changes the digest without breaking the file for openssl).
printf ' ' >> "$TAMPERED"
if bash "$DROPLET_IMAGE" verify \
     --manifest "$TAMPERED" --sig "$SIG" --pubkey "$PUB" --assets-dir "$EMPTY_ASSETS" >/dev/null 2>&1; then
  fail "verify ACCEPTED a tampered manifest (fail-OPEN — security bug)"
else
  pass "verify rejects a tampered manifest (fail-closed)"
fi

# Sanity: signing must use ECDSA-P256, not Ed25519. The detached signature of
# an EC P-256 key is DER-encoded ECDSA (SEQUENCE of two INTEGERs, ~70-72 bytes);
# an Ed25519 sig is a fixed 64 raw bytes. We assert the public key is EC P-256.
if openssl pkey -pubin -in "$PUB" -text -noout 2>/dev/null \
     | grep -qiE 'prime256v1|P-256|id-ecPublicKey|ASN1 OID: prime256v1'; then
  pass "signing key is ECDSA P-256 (FIPS-approved; not Ed25519)"
else
  fail "signing key is not ECDSA P-256 — FIPS policy violation"
fi

# =============================================================================
# (b2) per-asset sha256 verification — a PRESENT asset must match the manifest
#      sha256, and a swapped/corrupt asset under an otherwise-valid signature
#      MUST fail closed. This is the primary supply-chain guard before a
#      destructive flash; previously only the signature path was asserted, so a
#      tampered ISO that kept the manifest+sig intact slipped through. (review #501)
# =============================================================================
echo "--- (b2) verify checks per-asset sha256, fail-closed on a swapped asset ---"
ASSETS_DIR="$WORK/assets"
mkdir -p "$ASSETS_DIR"
# Follow whatever the signed manifest above declares (filename + sha256) rather
# than hard-coding shape details — keeps this test honest if the manifest
# constructor changes.
ASSET_NAME="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["images"][0]["file"])' "$MANIFEST" 2>/dev/null)"
ASSET_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["images"][0]["sha256"])' "$MANIFEST" 2>/dev/null)"
EXPECT_SHA="$(printf 'test-iso-bytes' | openssl dgst -sha256 -r | cut -d' ' -f1)"

if [ -n "$ASSET_NAME" ] && [ "$ASSET_SHA" = "$EXPECT_SHA" ]; then
  # Positive: a present asset whose bytes hash to the manifest sha256 -> verify OK.
  printf 'test-iso-bytes' > "$ASSETS_DIR/$ASSET_NAME"
  if bash "$DROPLET_IMAGE" verify \
       --manifest "$MANIFEST" --sig "$SIG" --pubkey "$PUB" --assets-dir "$ASSETS_DIR" >/dev/null 2>&1; then
    pass "verify accepts a present asset whose sha256 matches the manifest"
  else
    fail "verify rejected a correct present asset (false negative on the sha256 path)"
  fi

  # Negative: corrupt one byte of the asset. The manifest + signature are
  # untouched, so the signature check still passes — only the per-asset sha256
  # check can catch this, and it MUST fail closed (the supply-chain guard).
  printf 'X' >> "$ASSETS_DIR/$ASSET_NAME"
  if bash "$DROPLET_IMAGE" verify \
       --manifest "$MANIFEST" --sig "$SIG" --pubkey "$PUB" --assets-dir "$ASSETS_DIR" >/dev/null 2>&1; then
    fail "verify ACCEPTED a tampered asset under a valid manifest signature (fail-OPEN — supply-chain bug)"
  else
    pass "verify rejects a present asset whose sha256 != manifest (fail-closed)"
  fi
else
  fail "could not derive asset file/sha256 from the manifest — asset sha256 path left UNTESTED" \
       "ASSET_NAME='$ASSET_NAME' ASSET_SHA='$ASSET_SHA' EXPECT='$EXPECT_SHA'"
fi

# =============================================================================
# (c) gen-manifest.py accepts a valid manifest and rejects bad ones
# =============================================================================
echo "--- (c) gen-manifest.py validate accepts good, rejects bad ---"

if [ ! -f "$GEN_MANIFEST" ]; then
  fail "scripts/image/gen-manifest.py not present"
else
  # Valid manifest validates.
  if python3 "$GEN_MANIFEST" validate --schema "$SCHEMA" "$MANIFEST" >/dev/null 2>&1; then
    pass "validate accepts a well-formed manifest"
  else
    fail "validate rejected a well-formed manifest (false negative)"
  fi

  # Bad #1: an image entry missing the required `sha256` field.
  BAD_NO_SHA="$WORK/bad-no-sha.json"
  python3 - "$MANIFEST" "$BAD_NO_SHA" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
m["images"][0].pop("sha256", None)
json.dump(m, open(sys.argv[2], "w"))
PY
  if python3 "$GEN_MANIFEST" validate --schema "$SCHEMA" "$BAD_NO_SHA" >/dev/null 2>&1; then
    fail "validate ACCEPTED a manifest missing sha256 (should reject)"
  else
    pass "validate rejects a manifest missing the required sha256"
  fi

  # Bad #2: `size` is the wrong type (string instead of integer).
  BAD_TYPE="$WORK/bad-type.json"
  python3 - "$MANIFEST" "$BAD_TYPE" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
m["images"][0]["size"] = "not-an-integer"
json.dump(m, open(sys.argv[2], "w"))
PY
  if python3 "$GEN_MANIFEST" validate --schema "$SCHEMA" "$BAD_TYPE" >/dev/null 2>&1; then
    fail "validate ACCEPTED a manifest with a wrong-typed size (should reject)"
  else
    pass "validate rejects a manifest with a wrong-typed field"
  fi

  # Bad #3: not even valid JSON.
  BAD_JSON="$WORK/bad.json"
  printf '{ this is not json ' > "$BAD_JSON"
  if python3 "$GEN_MANIFEST" validate --schema "$SCHEMA" "$BAD_JSON" >/dev/null 2>&1; then
    fail "validate ACCEPTED non-JSON input (should reject)"
  else
    pass "validate rejects non-JSON input"
  fi
fi

# =============================================================================
# (d) flash pre-flight refuses dangerous targets + bad confirm-phrase
# =============================================================================
echo "--- (d) flash pre-flight refuses (dry-run, no real device) ---"

# A confirm-phrase that names the target device is required. We model an ISO
# we just create + a fake target device path.
FAKE_IMG="$WORK/droplet-single-box-0.2.0.iso"
printf 'fake-iso-bytes' > "$FAKE_IMG"
TARGET="/dev/sdX"          # never a real device on this host
GOOD_PHRASE="ERASE /dev/sdX"

# Helper: run flash in DRY_RUN with a given env override + confirm phrase,
# expect a NON-zero exit (refusal). $1 = description, rest = extra env=val.
_expect_flash_refusal() {
  local desc="$1"; shift
  local out rc
  out="$(env DROPLET_IMAGE_DRY_RUN=1 "$@" \
    bash "$DROPLET_IMAGE" flash \
      --image "$FAKE_IMG" --device "$TARGET" --confirm "$GOOD_PHRASE" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "flash refuses: $desc"
  else
    fail "flash did NOT refuse: $desc" "output:" "$out"
  fi
}

_expect_flash_refusal "target is mounted (DROPLET_IMAGE_TEST_MOUNTED)" \
  "DROPLET_IMAGE_TEST_MOUNTED=$TARGET"
_expect_flash_refusal "target is/backs the OS disk (DROPLET_IMAGE_TEST_OSDISK)" \
  "DROPLET_IMAGE_TEST_OSDISK=$TARGET"
_expect_flash_refusal "target holds a filesystem with data (DROPLET_IMAGE_TEST_HASDATA)" \
  "DROPLET_IMAGE_TEST_HASDATA=$TARGET"

# Missing confirm-phrase → refuse.
out="$(DROPLET_IMAGE_DRY_RUN=1 bash "$DROPLET_IMAGE" flash \
        --image "$FAKE_IMG" --device "$TARGET" 2>&1)"
if [ $? -ne 0 ]; then
  pass "flash refuses a missing confirm-phrase"
else
  fail "flash did NOT refuse a missing confirm-phrase" "output:" "$out"
fi

# Wrong confirm-phrase (does NOT name the device) → refuse.
out="$(DROPLET_IMAGE_DRY_RUN=1 bash "$DROPLET_IMAGE" flash \
        --image "$FAKE_IMG" --device "$TARGET" --confirm "ERASE /dev/sdZ" 2>&1)"
if [ $? -ne 0 ]; then
  pass "flash refuses a confirm-phrase that names the wrong device"
else
  fail "flash did NOT refuse a wrong-device confirm-phrase" "output:" "$out"
fi

# Positive control: with NO dangerous flags + a correct confirm-phrase, the
# pre-flight passes and DRY_RUN reports the dd it WOULD run (exit 0). This
# proves the refusals above are real gates, not a flash that always fails.
out="$(DROPLET_IMAGE_DRY_RUN=1 bash "$DROPLET_IMAGE" flash \
        --image "$FAKE_IMG" --device "$TARGET" --confirm "$GOOD_PHRASE" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qiE 'dry.?run|would (write|dd|flash)'; then
  pass "flash dry-run SUCCEEDS with a correct confirm-phrase + safe target"
else
  fail "flash dry-run did not succeed on the safe/positive path (rc=$rc)" "output:" "$out"
fi

# =============================================================================
# (e) autoinstall seed: the firstboot NOPASSWD grant must not outlive
#     provisioning (ADR-020 §D6 — a blanket grant that persists past first
#     boot turns the account password into a remote root credential over SSH)
# =============================================================================
echo "--- (e) autoinstall sudoers grant is provisioning-window only ---"

USER_DATA="$REPO_ROOT_REAL/scripts/image/autoinstall/user-data"
if [ ! -f "$USER_DATA" ]; then
  fail "scripts/image/autoinstall/user-data not present"
else
  # The unattended firstboot unit needs the grant to run setup.sh at all.
  if grep -q 'NOPASSWD: ALL" > /etc/sudoers.d/droplet-firstboot' "$USER_DATA"; then
    pass "seed writes the droplet-firstboot drop-in for the unattended setup.sh run"
  else
    fail "seed no longer writes /etc/sudoers.d/droplet-firstboot — firstboot setup.sh would fail its sudo preflight"
  fi

  # ...and the firstboot unit must remove it on success, AFTER stamping the
  # .firstboot-done marker (rm first would kill the unit's own sudo before the
  # marker lands, re-running setup on every boot).
  post_line="$(grep 'ExecStartPost=' "$USER_DATA" || true)"
  case "$post_line" in
    *".firstboot-done"*"rm -f /etc/sudoers.d/droplet-firstboot"*)
      pass "firstboot ExecStartPost removes the drop-in after the .firstboot-done marker"
      ;;
    *)
      fail "firstboot ExecStartPost does not remove /etc/sudoers.d/droplet-firstboot after the marker" \
           "ExecStartPost line: ${post_line:-<missing>}"
      ;;
  esac

  # No NOPASSWD grant outside the self-removing firstboot drop-in
  # (comment lines don't grant anything — skip them).
  stray="$(grep 'NOPASSWD' "$USER_DATA" | grep -vE '^[[:space:]]*#' | grep -v 'droplet-firstboot' || true)"
  if [ -z "$stray" ]; then
    pass "no NOPASSWD grant outside the firstboot drop-in"
  else
    fail "seed contains a NOPASSWD grant outside droplet-firstboot:" "$stray"
  fi
fi

# =============================================================================
# (f) WARP-2142 — install-mode SSH window. The seed must plant an epoch-stamped
#     marker in the installed target and enable ssh there, and — critically —
#     the marker path must MATCH what droplet-ssh-access-boot-reset checks. A
#     path typo between the two files would mean a window that silently never
#     opens (or never closes); it must be a test failure here, not a field
#     surprise.
# =============================================================================
echo "--- (f) WARP-2142 install-mode marker + first-boot ssh window ---"

UD2="$REPO_ROOT_REAL/scripts/image/autoinstall/user-data"
BOOT_RESET="$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-ssh-access-boot-reset"
SINGLE_BOX_LIB="$REPO_ROOT_REAL/scripts/lib/single-box.sh"

if [ ! -f "$UD2" ] || [ ! -f "$BOOT_RESET" ]; then
  fail "user-data or droplet-ssh-access-boot-reset missing — WARP-2142 checks cannot run"
else
  # The seed plants an epoch-stamped marker in the target.
  if grep -qE 'date \+%s > /var/lib/[a-z-]+/install-mode' "$UD2"; then
    pass "seed plants an epoch-stamped install-mode marker in the target"
  else
    fail "seed does not plant the install-mode marker (expected: date +%s > .../install-mode)"
  fi

  # ...and enables ssh in the target: on boot 1 none of the WARP-1984
  # machinery exists yet (setup.sh installs it mid-provision), so standing
  # enablement is the only thing that can open the window on the very first
  # boot.
  if grep -q 'systemctl enable ssh.service' "$UD2"; then
    pass "seed enables ssh in the installed target (boot 1 is reachable)"
  else
    fail "seed does not enable ssh in the target — the very first boot would be unreachable"
  fi

  # THE CROSS-FILE CONTRACT: extract the marker path from BOTH files and
  # compare. An extraction failure (either side renamed or reworded past the
  # patterns here) is a failure too — never a silent skip.
  ud_marker="$(grep -oE '/var/lib/[a-z-]+/install-mode' "$UD2" | sort -u)"
  ud_marker_count="$(printf '%s\n' "$ud_marker" | grep -c . || true)"
  br_dir="$(sed -n 's/.*DROPLET_SSH_ACCESS_DIR:-\([^}]*\)}.*/\1/p' "$BOOT_RESET" | head -1)"
  br_base="$(sed -n 's/^INSTALL_MODE_FILE="\$STATE_DIR\/\([a-z-]*\)".*/\1/p' "$BOOT_RESET" | head -1)"
  br_marker="${br_dir}/${br_base}"
  if [ "$ud_marker_count" = "1" ] && [ -n "$br_dir" ] && [ -n "$br_base" ] \
     && [ "$ud_marker" = "$br_marker" ]; then
    pass "marker path agrees between user-data and boot-reset ($br_marker)"
  else
    fail "install-mode marker path MISMATCH or extraction failure" \
         "user-data:  [${ud_marker:-<none>}] (unique paths: $ud_marker_count)" \
         "boot-reset: [${br_marker}]"
  fi

  # The completion hook (single-box.sh, called from setup.sh's success tail)
  # must remove the SAME path — a third spelling of it is a third chance for
  # a typo, so pin it against the boot-reset-derived one.
  if [ -n "$br_dir" ] && [ -n "$br_base" ] && [ -f "$SINGLE_BOX_LIB" ] \
     && grep -q "$br_marker" "$SINGLE_BOX_LIB"; then
    pass "completion hook (single-box.sh) removes the same marker path"
  else
    fail "single-box.sh completion hook does not reference $br_marker"
  fi
fi

echo "--- WARP-232: autoinstall storage layout leaves VG space for the encrypted data LV ---"
UD="$REPO_ROOT_REAL/scripts/image/autoinstall/user-data"
if [ ! -f "$UD" ]; then
  fail "scripts/image/autoinstall/user-data not present (WARP-232 storage checks)"
else
  grep -q 'name: lvm' "$UD" \
    && fail "user-data still uses the implicit lvm layout (root LV swallows the disk)" \
    || pass "implicit lvm layout removed"
  grep -q 'ubuntu-vg' "$UD" && pass "explicit VG ubuntu-vg declared" || fail "no explicit VG"
  grep -qE 'name: ubuntu-lv' "$UD" && pass "bounded root LV declared" || fail "no explicit root LV"
  if grep -q 'droplet-data' "$UD"; then
    fail "user-data must NOT pre-create droplet-data (first boot owns it)"
  else
    pass "data LV deliberately absent from autoinstall (setup.sh owns it)"
  fi
  if python3 -c "import yaml,sys; yaml.safe_load(open('$UD'))" 2>/dev/null; then
    pass "user-data is valid YAML"
  else
    fail "user-data YAML broken"
  fi
fi

echo "--- WARP-2143: boot-order assertion — installed disk boots first, stick can stay in ---"
UD2143="$REPO_ROOT_REAL/scripts/image/autoinstall/user-data"
if [ ! -f "$UD2143" ]; then
  fail "scripts/image/autoinstall/user-data not present (WARP-2143 boot-order checks)"
else
  # efibootmgr must be guaranteed on the target: grub-efi-amd64 pulls it in on
  # a UEFI install, but the late-command's skip logic must be driven by EFI-vars
  # presence, never by a missing binary — so the seed declares it explicitly.
  if grep -qE '^[[:space:]]*-[[:space:]]*efibootmgr[[:space:]]*$' "$UD2143"; then
    pass "efibootmgr declared in the autoinstall packages list"
  else
    fail "efibootmgr not in the autoinstall packages list — boot-order step depends on grub side-effects"
  fi

  # The late-command itself: must read the EFI boot entries and APPLY a new
  # BootOrder (efibootmgr -o), not just print one.
  if grep -q 'efibootmgr -o' "$UD2143" && grep -q 'BootOrder' "$UD2143"; then
    pass "late-command asserts BootOrder via efibootmgr -o"
  else
    fail "no late-command applies a BootOrder with efibootmgr -o — reboot still lands on the stick"
  fi

  # Graceful degradation (deliberately NON-fatal, unlike the clone step): a
  # BIOS/CSM boot has no EFI vars — the block must detect /sys/firmware/efi
  # and log a SKIP rather than fail the install.
  if grep -q '/sys/firmware/efi' "$UD2143" \
     && grep -q 'SKIP: no EFI firmware interface' "$UD2143"; then
    pass "BIOS/CSM boot skips gracefully with a logged note (never fails the install)"
  else
    fail "no logged BIOS/CSM skip path — a legacy-boot install would fail or skip silently"
  fi

  # Entry-not-found must also log + skip, never fail.
  if grep -qE 'SKIP: no .?ubuntu.? boot entry' "$UD2143"; then
    pass "missing ubuntu boot entry skips with a logged note"
  else
    fail "no logged skip for a missing ubuntu boot entry"
  fi

  # Idempotence: when the ubuntu entry is already first, the block must say so
  # and exit without rewriting EFI vars (harmless on re-install).
  if grep -q 'already first' "$UD2143"; then
    pass "idempotent: logs and exits early when the ubuntu entry is already first"
  else
    fail "no already-first early exit — block rewrites EFI vars on every install"
  fi

  # review-#501 discipline: the step is non-fatal BY DESIGN, but every swallow
  # must log. The outer guard must be a logged warning, and no bare '|| true'
  # may appear outside comments anywhere in the seed.
  if grep -q 'droplet-boot-order: WARNING' "$UD2143"; then
    pass "outer failure guard logs a warning instead of swallowing silently"
  else
    fail "boot-order block has no logged outer failure guard (silent swallow or fatal-by-accident)"
  fi
  stray_true="$(grep -n '|| true' "$UD2143" | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
  if [ -z "$stray_true" ]; then
    pass "no bare '|| true' outside comments in the autoinstall seed"
  else
    fail "bare '|| true' swallows a failure in the seed (review #501):" "$stray_true"
  fi
fi

# =============================================================================
# WARP-2100: the firstboot unit must be BOUNDED and PROMPT-PROOF. With
# TimeoutStartSec=0 (= infinity for Type=oneshot) a provisioning step that
# blocks — the cryptsetup ask-password hang — wedges first boot FOREVER with
# no error surfaced. The bound must be generous (first boot legitimately pulls
# images for many minutes) but finite; and StandardInput=null so no child
# inherits a console stdin it could sit reading a passphrase from.
# =============================================================================
echo "--- WARP-2100: firstboot unit is bounded + prompt-proof ---"
if [ ! -f "$UD" ]; then
  fail "scripts/image/autoinstall/user-data not present (WARP-2100 firstboot checks)"
else
  if grep -qE '^[[:space:]]*TimeoutStartSec=0[[:space:]]*$' "$UD"; then
    fail "firstboot unit has TimeoutStartSec=0 (unbounded — the WARP-2100 forever-hang)"
  else
    pass "firstboot unit no longer disables its start timeout"
  fi
  if grep -qE '^[[:space:]]*TimeoutStartSec=[1-9][0-9]*(s|min|h)?[[:space:]]*$' "$UD"; then
    pass "firstboot unit carries a finite TimeoutStartSec bound"
  else
    fail "firstboot unit has no finite TimeoutStartSec:" "$(grep 'TimeoutStartSec' "$UD" || echo '<missing>')"
  fi
  if grep -qE '^[[:space:]]*StandardInput=null[[:space:]]*$' "$UD"; then
    pass "firstboot unit runs with StandardInput=null"
  else
    fail "firstboot unit lacks StandardInput=null (children inherit a promptable stdin)"
  fi
fi

echo "--- WARP-2101: autoinstall seed ships the TPM2 userspace (tss2 libs) ---"
if [ ! -f "$UD" ]; then
  fail "scripts/image/autoinstall/user-data not present (WARP-2101 seed checks)"
else
  # systemd-cryptenroll dlopens all three tss2 libraries at runtime; without
  # them a box with HEALTHY TPM hardware reports "TPM2 support is not
  # installed" and the first-boot LUKS provisioning cannot seal the data LV
  # (WARP-2101). setup.sh installs Docker but never these — they must ship in
  # the seed.
  for pkg in libtss2-esys-3.0.2-0t64 libtss2-mu-4.0.1-0t64 libtss2-rc0t64; do
    if grep -qF -- "- $pkg" "$UD"; then
      pass "seed packages include $pkg"
    else
      fail "seed packages missing $pkg — cryptenroll dies 'TPM2 support is not installed' on healthy TPM hardware (WARP-2101)"
    fi
  done
fi

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ "$FAILURES" -gt 0 ]; then
  printf " (${_RED}%d failed${_RESET})" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit "$FAILURES"
