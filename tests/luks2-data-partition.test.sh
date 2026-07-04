#!/usr/bin/env bash
# =============================================================================
# Integration test: LUKS2 + Argon2id data partition, TPM2-sealed unlock
# (WARP-232)
#
# 1. Static-gates scripts/host/droplet-luks-provision.sh + the shared
#    droplet-tpm-lib.sh + the scripts/lib/luks.sh install wiring + the
#    crypto-shred script.
# 2. Hermetic drill: runs `provision` against PATH-stubbed lvcreate / vgs /
#    cryptsetup / systemd-cryptenroll / systemd-cryptsetup / mkfs.ext4 / mount
#    / blkid / findmnt (each logging "$0 $*" to $CMD_LOG — the
#    test_automount_script.py technique). Asserts the LUKS2/Argon2id format,
#    the PCR-bound TPM keyslot, the recovery keyslot, temp-keyslot removal,
#    crypttab/fstab/docker-drop-in writes, idempotency, and the fail-closed
#    no-TPM refusal.
# 3. Pins the WARP-254 restic derivation + the .env-inside-LUKS linkage
#    (Task 232.6) and the crypto-shred script (Task 232.7).
#
# No Docker, no root, no /dev/tpm0, no real block devices. Runtime: < 5s.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TPM_LIB="$REPO_ROOT/scripts/host/droplet-tpm-lib.sh"
LUKS_SCRIPT="$REPO_ROOT/scripts/host/droplet-luks-provision.sh"
INSTALL_LIB="$REPO_ROOT/scripts/lib/luks.sh"
SHRED="$REPO_ROOT/scripts/host/droplet-crypto-shred.sh"

FAILURES=0; TESTS=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }
info() { printf "  \033[2m..\033[0m %s\n" "$1"; }
skip() { printf "  \033[33m○\033[0m %s (skipped)\n" "$1"; }

echo ""
echo "  ================================================"
echo "  LUKS2 + Argon2id data partition, TPM-sealed (WARP-232)"
echo "  ================================================"
echo ""

echo "--- Static checks: shared TPM lib ---"
if [ -f "$TPM_LIB" ]; then pass "droplet-tpm-lib.sh exists"; else fail "droplet-tpm-lib.sh missing"; fi
bash -n "$TPM_LIB" 2>/dev/null && pass "droplet-tpm-lib.sh parses" || fail "droplet-tpm-lib.sh syntax error"
pcrs="$(bash -c "source '$TPM_LIB' && droplet_tpm_pcrs" 2>/dev/null || true)"
[ "$pcrs" = "0+2+4+7" ] && pass "default PCR bind is 0+2+4+7 (device-identity parity)" \
  || fail "default PCR bind is '$pcrs', want 0+2+4+7"

echo ""
echo "--- Static checks: droplet-luks-provision.sh ---"
[ -f "$LUKS_SCRIPT" ] && pass "script exists" || fail "script missing"
if [ -f "$LUKS_SCRIPT" ]; then
  bash -n "$LUKS_SCRIPT" && pass "parses" || fail "syntax error"
  [ -x "$LUKS_SCRIPT" ] && pass "executable" || fail "not executable"
  grep -qE 'set -euo pipefail' "$LUKS_SCRIPT" && pass "strict mode" || fail "no strict mode"
  grep -q 'droplet-tpm-lib.sh' "$LUKS_SCRIPT" && pass "sources shared TPM lib" || fail "no shared TPM lib"
  grep -q -- '--pbkdf argon2id' "$LUKS_SCRIPT" && pass "LUKS2 keyslots use Argon2id" || fail "no Argon2id pbkdf"
  grep -q -- '--type luks2' "$LUKS_SCRIPT" && pass "explicit LUKS2 format" || fail "not explicitly LUKS2"
  grep -q -- '--tpm2-pcrs=' "$LUKS_SCRIPT" && pass "TPM enroll is PCR-bound" || fail "TPM enroll not PCR-bound"
  grep -q -- '--recovery-key' "$LUKS_SCRIPT" && pass "recovery keyslot enrolled" || fail "no recovery keyslot"
  grep -q 'luksRemoveKey' "$LUKS_SCRIPT" && pass "temp install keyslot destroyed" || fail "temp keyslot never removed"
  grep -q 'RequiresMountsFor=/data' "$LUKS_SCRIPT" && pass "docker gated on /data (fail closed)" || fail "no docker RequiresMountsFor gate"
  grep -q 'tpm2-device=auto' "$LUKS_SCRIPT" && pass "crypttab auto-unlock via TPM token" || fail "no tpm2-device=auto crypttab entry"
fi

# =============================================================================
# Hermetic drill
# =============================================================================
if [ -x "$LUKS_SCRIPT" ]; then
echo ""
echo "--- Hermetic drill: provision (stubbed lvcreate/cryptsetup/cryptenroll) ---"

WORK="$(mktemp -d -t luksdrill-XXXXXXXX)"
trap 'rm -rf "$WORK"' EXIT
STUB_BIN="$WORK/bin"; ETC="$WORK/etc"; RUNTIME="$WORK/run"
mkdir -p "$STUB_BIN" "$ETC" "$RUNTIME"
CMD_LOG="$WORK/cmd.log"; : > "$CMD_LOG"

# One generic logger stub for the tools we only need to observe + succeed.
for t in lvcreate mkfs.ext4 mount blkid findmnt vgs cryptsetup systemd-cryptenroll systemd-cryptsetup; do
  cat > "$STUB_BIN/$t" <<STUB
#!/usr/bin/env bash
printf '%s %s\n' "$t" "\$*" >> "$CMD_LOG"
STUB
  chmod +x "$STUB_BIN/$t"
done

# vgs: report free extents so the provision proceeds (unless STUB_NO_FREE=1).
cat > "$STUB_BIN/vgs" <<'STUB'
#!/usr/bin/env bash
printf 'vgs %s\n' "$*" >> "$CMD_LOG"
if [ "${STUB_NO_FREE:-0}" = "1" ]; then printf '0\n'; else printf '512\n'; fi
STUB
chmod +x "$STUB_BIN/vgs"

# findmnt: /data mapper is "active" only when STUB_MAPPER_ACTIVE=1 (idempotency).
cat > "$STUB_BIN/findmnt" <<'STUB'
#!/usr/bin/env bash
printf 'findmnt %s\n' "$*" >> "$CMD_LOG"
last=; for a in "$@"; do last="$a"; done
if [ "$last" = "/data" ] && [ "${STUB_MAPPER_ACTIVE:-0}" = "1" ]; then
  printf '/dev/mapper/droplet-data-crypt\n'; exit 0
fi
exit 1
STUB
chmod +x "$STUB_BIN/findmnt"

# blkid: report the mapper has no fs until formatted (so mkfs runs).
cat > "$STUB_BIN/blkid" <<'STUB'
#!/usr/bin/env bash
printf 'blkid %s\n' "$*" >> "$CMD_LOG"
exit 2
STUB
chmod +x "$STUB_BIN/blkid"

# systemd-cryptenroll: emit a fake recovery key when --recovery-key is asked.
cat > "$STUB_BIN/systemd-cryptenroll" <<'STUB'
#!/usr/bin/env bash
printf 'systemd-cryptenroll %s\n' "$*" >> "$CMD_LOG"
for a in "$@"; do
  if [ "$a" = "--recovery-key" ]; then
    printf 'aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff-ggggg-hhhhh\n'
    exit 0
  fi
done
exit 0
STUB
chmod +x "$STUB_BIN/systemd-cryptenroll"

luks_env=(
  "PATH=$STUB_BIN:$PATH"
  DROPLET_LUKS_SKIP_OS_GATE=1
  DROPLET_LUKS_VG=ubuntu-vg
  DROPLET_LUKS_LV=droplet-data
  DROPLET_LUKS_MAPPER=droplet-data-crypt
  DROPLET_DATA_MOUNT=/data
  DROPLET_ETC_DIR="$ETC"
  DROPLET_LUKS_RUNTIME_DIR="$RUNTIME"
  DROPLET_TPM_DEVICE="$STUB_BIN/cryptsetup"   # any existing path = "TPM present"
  DROPLET_LVCREATE_BIN="$STUB_BIN/lvcreate"
  DROPLET_VGS_BIN="$STUB_BIN/vgs"
  DROPLET_MKFS_BIN="$STUB_BIN/mkfs.ext4"
  DROPLET_MOUNT_BIN="$STUB_BIN/mount"
  DROPLET_CRYPTSETUP_BIN="$STUB_BIN/cryptsetup"
  DROPLET_CRYPTENROLL_BIN="$STUB_BIN/systemd-cryptenroll"
  DROPLET_SYSTEMD_CRYPTSETUP_BIN="$STUB_BIN/systemd-cryptsetup"
  CMD_LOG="$CMD_LOG"
)

: > "$CMD_LOG"
if env "${luks_env[@]}" "$LUKS_SCRIPT" provision >/dev/null 2>&1; then
  pass "provision succeeds with a TPM + free extents"
else
  fail "provision failed under the happy path"
fi
grep -q 'lvcreate -l 100%FREE -n droplet-data ubuntu-vg' "$CMD_LOG" && pass "creates the data LV from free extents" || fail "no lvcreate"
grep -qE 'cryptsetup luksFormat --type luks2 --pbkdf argon2id' "$CMD_LOG" && pass "formats LUKS2/Argon2id" || fail "bad luksFormat"
grep -qE 'systemd-cryptenroll .*--tpm2-pcrs=0\+2\+4\+7' "$CMD_LOG" && pass "TPM keyslot bound to 0+2+4+7" || fail "wrong PCR bind"
grep -qE 'systemd-cryptenroll .*--recovery-key' "$CMD_LOG" && pass "recovery key enrolled" || fail "no recovery enroll"
grep -q 'cryptsetup luksRemoveKey' "$CMD_LOG" && pass "temp keyslot removed" || fail "temp keyslot kept"
grep -q 'droplet-data-crypt' "$ETC/crypttab" 2>/dev/null && grep -q 'tpm2-device=auto' "$ETC/crypttab" 2>/dev/null \
  && pass "crypttab entry written" || fail "crypttab wrong"
grep -q '/dev/mapper/droplet-data-crypt /data ext4' "$ETC/fstab" 2>/dev/null && pass "fstab entry written" || fail "fstab wrong"
grep -q 'RequiresMountsFor=/data' "$ETC/systemd/system/docker.service.d/droplet-data.conf" 2>/dev/null \
  && pass "docker drop-in written" || fail "docker drop-in missing"
[ -z "$(ls -A "$RUNTIME" 2>/dev/null)" ] && pass "no temp keyfile left behind" || fail "keyfile residue in runtime dir"

# idempotency: second run with the mapper "active" exits 0 with no lvcreate.
: > "$CMD_LOG"
env "${luks_env[@]}" STUB_MAPPER_ACTIVE=1 "$LUKS_SCRIPT" provision >/dev/null 2>&1 \
  && pass "re-run is a no-op when already provisioned" || fail "re-run not idempotent"
grep -q 'lvcreate' "$CMD_LOG" && fail "re-run re-created the LV" || pass "re-run performed no destructive calls"

# no TPM + no override = refuse loudly (exit 2), create NOTHING.
: > "$CMD_LOG"
if env "${luks_env[@]}" DROPLET_TPM_DEVICE=/nonexistent "$LUKS_SCRIPT" provision >/dev/null 2>&1; then
  fail "provision proceeded without a TPM"
else
  rc=$?
  [ "$rc" -eq 2 ] && pass "refuses without a TPM (exit 2)" || fail "wrong exit code without TPM ($rc)"
fi
grep -q 'lvcreate' "$CMD_LOG" && fail "TPM-less run still touched LVM" || pass "TPM-less run touched nothing"

# status surface is stable JSON.
st="$(env "${luks_env[@]}" STUB_MAPPER_ACTIVE=1 "$LUKS_SCRIPT" status 2>/dev/null || true)"
printf '%s' "$st" | grep -q '"mounted":true' && pass "status reports mounted:true when mapper active" || fail "status wrong: $st"
fi

# =============================================================================
# Task 232.3 — install wiring + secrets relocation (static)
# =============================================================================
echo ""
echo "--- Static checks: install wiring + secrets relocation ---"
[ -f "$INSTALL_LIB" ] && pass "scripts/lib/luks.sh exists" || fail "install lib missing"
if [ -f "$INSTALL_LIB" ]; then
  bash -n "$INSTALL_LIB" && pass "install lib parses" || fail "install lib syntax error"
  grep -q 'install_luks_data_partition' "$INSTALL_LIB" && pass "defines install_luks_data_partition" || fail "no installer fn"
  grep -q 'droplet-luks-provision.sh' "$INSTALL_LIB" && pass "installer installs the provision script" || fail "provision script not installed"
  grep -q 'relocate_secrets_to_data' "$INSTALL_LIB" && pass "defines relocate_secrets_to_data" || fail "no secrets relocation"
  grep -qE 'ln -s' "$INSTALL_LIB" && pass "relocation leaves symlinks (consumer-transparent)" || fail "no symlinks"
fi
SETUP="$REPO_ROOT/scripts/setup.sh"
grep -q 'lib/luks.sh' "$SETUP" && pass "setup.sh sources lib/luks.sh" || fail "setup.sh missing source"
grep -q 'install_luks_data_partition' "$SETUP" && pass "setup.sh calls install_luks_data_partition" || fail "setup.sh never calls installer"
setup_flat="$(grep -vE '^[[:space:]]*#' "$SETUP")"
luks_line="$(printf '%s\n' "$setup_flat" | grep -n 'install_luks_data_partition' | head -1 | cut -d: -f1)"
docker_line="$(printf '%s\n' "$setup_flat" | grep -n 'install_docker' | head -1 | cut -d: -f1)"
if [ -n "$luks_line" ] && [ -n "$docker_line" ] && [ "$luks_line" -lt "$docker_line" ]; then
  pass "LUKS provision ordered before Docker install (data-root lands first)"
else
  fail "LUKS provision not ordered before Docker install"
fi
grep -q 'relocate_secrets_to_data' "$SETUP" && pass "setup.sh relocates secrets after Phase 4" || fail "secrets never relocated"

# =============================================================================
# Task 232.6 — restic per-customer key linkage (WARP-254 derivation, unchanged)
# =============================================================================
echo ""
echo "--- WARP-232: restic per-customer key linkage (WARP-254 derivation, unchanged) ---"
BKLIB="$REPO_ROOT/scripts/host/droplet-backup-lib.sh"
grep -q "droplet-restic-v1" "$BKLIB" && pass "restic derivation salt untouched (droplet-restic-v1)" \
  || fail "restic derivation salt CHANGED — this bricks every shipped repo"
grep -q 'DEVICE_SECRET_KEY' "$BKLIB" && pass "restic password still derives from the per-device master key" \
  || fail "restic password no longer device-derived"
if [ -f "$INSTALL_LIB" ]; then
  grep -q 'relocate_secrets_to_data' "$INSTALL_LIB" \
    && pass ".env relocation keeps the restic key material inside the LUKS boundary" \
    || fail ".env not inside the encryption boundary"
fi

# =============================================================================
# Task 232.7 — crypto-shred script + runbooks (static)
# =============================================================================
echo ""
echo "--- Static checks: crypto-shred ---"
[ -f "$SHRED" ] && pass "droplet-crypto-shred.sh exists" || fail "missing"
if [ -f "$SHRED" ]; then
  bash -n "$SHRED" && pass "parses" || fail "syntax error"
  grep -q 'luksErase' "$SHRED" && pass "erases every LUKS keyslot" || fail "no luksErase"
  grep -qE 'tpm2_clear|systemd-cryptenroll --wipe-slot' "$SHRED" && pass "clears the TPM sealing hierarchy" || fail "TPM never cleared"
  grep -qE 'CONFIRM|--yes-destroy-everything' "$SHRED" && pass "double-confirmation gate" || fail "no confirmation gate"
  grep -q 'factory-reset' "$SHRED" && pass "chains to factory-reset for the app-level purge" || fail "no factory-reset chaining"
fi
[ -f "$REPO_ROOT/docs/security/crypto-shred.md" ] && pass "crypto-shred runbook exists" || fail "runbook missing"
[ -f "$REPO_ROOT/docs/security/at-rest-encryption.md" ] && pass "at-rest-encryption doc exists" || fail "doc missing"

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
