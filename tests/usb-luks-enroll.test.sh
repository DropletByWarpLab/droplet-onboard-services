#!/usr/bin/env bash
# =============================================================================
# Integration test: USB LUKS2 encrypt-and-format + derived recovery passphrase
# (WARP-232)
#
# 1. Static-gates scripts/host/droplet-usb-enroll.sh.
# 2. Derivation KAT: the per-drive recovery passphrase is HKDF-SHA256 over
#    DEVICE_SECRET_KEY with a NEW versioned salt (droplet-usb-luks-v1, disjoint
#    from the restic salt droplet-restic-v1), pinned by a known-answer test
#    computed independently in python3 — a stability contract: drift bricks
#    every enrolled drive's recovery slot.
# 3. Hermetic enroll drill: PATH-stubbed cryptsetup / systemd-cryptenroll /
#    blkid / lsblk / findmnt / mkfs.ext4 / wipefs assert the enroll sequence
#    and the rootfs-device refusal.
#
# No root, no real block devices, no /dev/tpm0. Runtime: < 5s.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
USB_SCRIPT="$REPO_ROOT/scripts/host/droplet-usb-enroll.sh"
TPM_LIB="$REPO_ROOT/scripts/host/droplet-tpm-lib.sh"

FAILURES=0; TESTS=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }
skip() { printf "  \033[33m○\033[0m %s (skipped)\n" "$1"; }

echo ""
echo "  ================================================"
echo "  USB LUKS2 enroll + recovery-passphrase derivation (WARP-232)"
echo "  ================================================"
echo ""

echo "--- Static checks: droplet-usb-enroll.sh ---"
[ -f "$USB_SCRIPT" ] && pass "script exists" || fail "script missing"
if [ -f "$USB_SCRIPT" ]; then
  bash -n "$USB_SCRIPT" && pass "parses" || fail "syntax error"
  [ -x "$USB_SCRIPT" ] && pass "executable" || fail "not executable"
  grep -qE 'set -euo pipefail' "$USB_SCRIPT" && pass "strict mode" || fail "no strict mode"
  grep -q 'droplet-tpm-lib.sh' "$USB_SCRIPT" && pass "sources shared TPM lib" || fail "no shared TPM lib"
  grep -q -- '--pbkdf argon2id' "$USB_SCRIPT" && pass "LUKS2 keyslots use Argon2id" || fail "no Argon2id pbkdf"
  grep -q -- '--type luks2' "$USB_SCRIPT" && pass "explicit LUKS2 format" || fail "not explicitly LUKS2"
  grep -q -- '--tpm2-pcrs=' "$USB_SCRIPT" && pass "TPM enroll is PCR-bound" || fail "TPM enroll not PCR-bound"
  grep -qE 'force|--force' "$USB_SCRIPT" && pass "destructive enroll has a confirm/--force gate" || fail "no confirm gate"
  grep -q 'droplet-usb-luks-v1' "$USB_SCRIPT" && pass "uses the versioned USB derivation salt" || fail "wrong/missing salt"
  # Must never enroll the boot device (same findmnt-rootfs guard as automount).
  grep -q 'findmnt' "$USB_SCRIPT" && pass "guards the rootfs device (findmnt)" || fail "no rootfs guard"
fi

# =============================================================================
# Derivation KAT (HKDF-SHA256 stability contract)
# =============================================================================
if [ -f "$USB_SCRIPT" ]; then
echo ""
echo "--- USB recovery-passphrase derivation (HKDF-SHA256 stability contract) ---"
KAT_KEY="kat-device-secret-key-DO-NOT-CHANGE"
KAT_UUID="0f7ee62f-9d51-4a99-84a2-6b0b4bcd0c11"
derived="$(DEVICE_SECRET_KEY="$KAT_KEY" bash -c "source '$USB_SCRIPT' --lib && droplet_usb_derive_passphrase '$KAT_UUID'" 2>/dev/null || true)"
printf '%s' "$derived" | grep -qE '^[0-9a-f]{64}$' && pass "derived passphrase is 64 hex chars" || fail "malformed: '$derived'"
expected="$(python3 - "$KAT_KEY" "$KAT_UUID" <<'PYEOF'
import hmac, hashlib, sys
ikm, uuid = sys.argv[1].encode(), sys.argv[2].encode()
prk = hmac.new(b"droplet-usb-luks-v1", ikm, hashlib.sha256).digest()
print(hmac.new(prk, b"droplet-usb-luks-recovery:" + uuid + b"\x01", hashlib.sha256).hexdigest())
PYEOF
)"
[ "$derived" = "$expected" ] && pass "KAT matches independent python3 HKDF" \
  || fail "KAT mismatch (bash=$derived python=$expected) — drift bricks every enrolled drive's recovery slot"
d2="$(DEVICE_SECRET_KEY="$KAT_KEY" bash -c "source '$USB_SCRIPT' --lib && droplet_usb_derive_passphrase 'other-uuid'" 2>/dev/null || true)"
[ "$derived" != "$d2" ] && pass "distinct drives derive distinct passphrases" || fail "uuid not bound into derivation"
if DEVICE_SECRET_KEY="" DROPLET_ENV_FILE=/nonexistent bash -c "source '$USB_SCRIPT' --lib && droplet_usb_derive_passphrase '$KAT_UUID'" >/dev/null 2>&1; then
  fail "empty DEVICE_SECRET_KEY (and no .env) accepted"
else
  pass "empty DEVICE_SECRET_KEY refused when no .env fallback exists"
fi

# WARP-232 finding 4: production `sudo droplet-usb-enroll.sh` runs with a
# SCRUBBED env (empty DEVICE_SECRET_KEY). Derive MUST fall back to the on-disk
# DEVICE_SECRET_KEY from .env — mirroring droplet-backup-lib.sh — or every
# enroll/derive/automount-recovery path is dead in production. This RUNS the
# derivation with an empty env but a real .env, and asserts it matches the KAT.
ENVDIR="$(mktemp -d -t usbenvfallback-XXXXXXXX)"
printf 'POSTGRES_PASSWORD=pg\nDEVICE_SECRET_KEY=%s\nREDIS_PASSWORD=r\n' "$KAT_KEY" > "$ENVDIR/.env"
derived_env="$(DEVICE_SECRET_KEY="" DROPLET_ENV_FILE="$ENVDIR/.env" \
  bash -c "source '$USB_SCRIPT' --lib && droplet_usb_derive_passphrase '$KAT_UUID'" 2>/dev/null || true)"
[ "$derived_env" = "$expected" ] \
  && pass "derive falls back to DEVICE_SECRET_KEY from .env when env is empty [finding 4]" \
  || fail "no .env fallback (finding 4): sudo enroll/derive would fail in production (got '$derived_env')"
# DROPLET_REPO_ROOT precedence resolves .env under the repo root too.
derived_root="$(DEVICE_SECRET_KEY="" DROPLET_REPO_ROOT="$ENVDIR" \
  bash -c "source '$USB_SCRIPT' --lib && droplet_usb_derive_passphrase '$KAT_UUID'" 2>/dev/null || true)"
[ "$derived_root" = "$expected" ] \
  && pass "derive resolves .env via DROPLET_REPO_ROOT precedence" \
  || fail "DROPLET_REPO_ROOT .env resolution failed (got '$derived_root')"
rm -rf "$ENVDIR"
fi

# =============================================================================
# Hermetic enroll drill
# =============================================================================
if [ -x "$USB_SCRIPT" ]; then
echo ""
echo "--- Hermetic drill: enroll --force /dev/sdz1 (stubbed cryptsetup/cryptenroll) ---"
WORK="$(mktemp -d -t usbdrill-XXXXXXXX)"
trap 'rm -rf "$WORK"' EXIT
STUB_BIN="$WORK/bin"; RUNTIME="$WORK/run"; STATE="$WORK/state"
mkdir -p "$STUB_BIN" "$RUNTIME" "$STATE"
CMD_LOG="$WORK/cmd.log"; : > "$CMD_LOG"

for t in cryptsetup systemd-cryptenroll mkfs.ext4 wipefs mount umount; do
  cat > "$STUB_BIN/$t" <<STUB
#!/usr/bin/env bash
printf '%s %s\n' "$t" "\$*" >> "$CMD_LOG"
STUB
  chmod +x "$STUB_BIN/$t"
done
# blkid: report a LUKS uuid for the enrolled device.
cat > "$STUB_BIN/blkid" <<'STUB'
#!/usr/bin/env bash
printf 'blkid %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" -s UUID "*) printf 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n' ;;
  *" -s TYPE "*) printf 'crypto_LUKS\n' ;;
esac
exit 0
STUB
chmod +x "$STUB_BIN/blkid"
# lsblk PKNAME: the target /dev/sdz1 is NOT related to the boot device.
cat > "$STUB_BIN/lsblk" <<'STUB'
#!/usr/bin/env bash
printf 'lsblk %s\n' "$*" >> "$CMD_LOG"
exit 0
STUB
chmod +x "$STUB_BIN/lsblk"
# findmnt: root fs lives on /dev/nvme0n1p2 (STUB_ROOT_DEV overrides for the guard test).
cat > "$STUB_BIN/findmnt" <<'STUB'
#!/usr/bin/env bash
printf 'findmnt %s\n' "$*" >> "$CMD_LOG"
last=; for a in "$@"; do last="$a"; done
if [ "$last" = "/" ]; then printf '%s\n' "${STUB_ROOT_DEV:-/dev/nvme0n1p2}"; exit 0; fi
exit 1
STUB
chmod +x "$STUB_BIN/findmnt"

usb_env=(
  "PATH=$STUB_BIN:$PATH"
  DEVICE_SECRET_KEY="kat-device-secret-key-DO-NOT-CHANGE"
  DROPLET_TPM_DEVICE="$STUB_BIN/cryptsetup"
  DROPLET_CRYPTSETUP_BIN="$STUB_BIN/cryptsetup"
  DROPLET_CRYPTENROLL_BIN="$STUB_BIN/systemd-cryptenroll"
  DROPLET_AUTOMOUNT_STATE_DIR="$STATE"
  DROPLET_USB_RUNTIME_DIR="$RUNTIME"
  CMD_LOG="$CMD_LOG"
)

: > "$CMD_LOG"
if env "${usb_env[@]}" "$USB_SCRIPT" enroll --force /dev/sdz1 >/dev/null 2>&1; then
  pass "enroll --force succeeds"
else
  fail "enroll --force failed"
fi
grep -q 'wipefs' "$CMD_LOG" && pass "wipes the drive before format" || fail "no wipefs"
grep -qE 'cryptsetup luksFormat --type luks2 --pbkdf argon2id' "$CMD_LOG" && pass "formats LUKS2/Argon2id" || fail "bad luksFormat"
grep -qE 'systemd-cryptenroll .*--tpm2-pcrs=0\+2\+4\+7' "$CMD_LOG" && pass "TPM keyslot bound to 0+2+4+7" || fail "wrong PCR bind"
grep -qE 'cryptsetup luksAddKey' "$CMD_LOG" && pass "derived recovery passphrase added as a keyslot" || fail "no recovery keyslot add"
[ -z "$(ls -A "$RUNTIME" 2>/dev/null)" ] && pass "no keyfile residue in the runtime dir" || fail "keyfile residue"

# WARP-232 finding 4 (ordering): the DURABLE recovery keyslot (luksAddKey) must
# be enrolled BEFORE the TPM keyslot (cryptenroll --tpm2-device), so an
# interruption between the two still leaves a re-derivable (recoverable) drive
# rather than a TPM-only brick.
addkey_line="$(grep -n 'cryptsetup luksAddKey' "$CMD_LOG" | head -1 | cut -d: -f1)"
tpm_line="$(grep -n 'systemd-cryptenroll .*--tpm2-device' "$CMD_LOG" | head -1 | cut -d: -f1)"
if [ -n "$addkey_line" ] && [ -n "$tpm_line" ] && [ "$addkey_line" -lt "$tpm_line" ]; then
  pass "recovery keyslot enrolled BEFORE the TPM keyslot (interrupt-safe order) [finding 4]"
else
  fail "TPM keyslot enrolled before the recovery slot (addkey@$addkey_line tpm@$tpm_line) [finding 4]"
fi

# WARP-232 finding 4 (fail-fast): with NO DEVICE_SECRET_KEY (env AND .env), enroll
# must REFUSE before wiping/formatting the drive — never leave a TPM-only drive.
: > "$CMD_LOG"
if env "${usb_env[@]}" DEVICE_SECRET_KEY="" DROPLET_ENV_FILE=/nonexistent \
     "$USB_SCRIPT" enroll --force /dev/sdz1 >/dev/null 2>&1; then
  fail "enroll proceeded with no derivable recovery key (finding 4)"
else
  rc=$?
  [ "$rc" -eq 2 ] && pass "enroll fails fast when the recovery key is underivable (exit 2) [finding 4]" \
    || fail "wrong exit code when key underivable ($rc)"
fi
grep -qE 'wipefs|luksFormat' "$CMD_LOG" && fail "underivable-key run still wiped/formatted the drive (finding 4)" \
  || pass "underivable-key run left the drive untouched (no wipefs/luksFormat) [finding 4]"

# enroll on the rootfs-backing device must refuse (exit 2, no destructive calls).
: > "$CMD_LOG"
if env "${usb_env[@]}" STUB_ROOT_DEV=/dev/sdz1 "$USB_SCRIPT" enroll --force /dev/sdz1 >/dev/null 2>&1; then
  fail "enroll proceeded on the rootfs device"
else
  rc=$?
  [ "$rc" -eq 2 ] && pass "refuses to enroll the rootfs device (exit 2)" || fail "wrong exit code on rootfs device ($rc)"
fi
grep -qE 'wipefs|luksFormat' "$CMD_LOG" && fail "rootfs-device run still touched the disk" || pass "rootfs-device run touched nothing"

# trust <uuid> appends to the trusted list.
env "${usb_env[@]}" "$USB_SCRIPT" trust "cafef00d-9360" >/dev/null 2>&1 \
  && pass "trust records a plain-drive uuid" || fail "trust failed"
grep -q 'cafef00d-9360' "$STATE/trusted.list" 2>/dev/null && pass "trusted.list updated" || fail "trusted.list not written"
fi

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ "$FAILURES" -gt 0 ]; then
  printf " (\033[31m%d failed\033[0m)" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit "$FAILURES"
