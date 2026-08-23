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
# WARP-2100: the attach must run headless (never queue an ask-password agent
# prompt — the agent protocol is socket-based, so closing stdin alone cannot
# stop it) and with a single try; the boot-time crypttab unlock likewise.
grep -qE 'systemd-cryptsetup attach .*headless=true' "$CMD_LOG" \
  && pass "attach passes headless=true (no ask-password prompt queued) [WARP-2100]" \
  || fail "attach not headless (WARP-2100) — a failed TPM unseal queues a prompt that blocks first boot"
grep -qE 'systemd-cryptsetup attach .*tries=1' "$CMD_LOG" \
  && pass "attach passes tries=1 [WARP-2100]" || fail "attach missing tries=1 (WARP-2100)"
grep -qE 'droplet-data-crypt .*headless=true' "$ETC/crypttab" 2>/dev/null \
  && pass "written crypttab entry carries headless=true [WARP-2100]" \
  || fail "crypttab entry missing headless=true (WARP-2100): $(grep droplet-data-crypt "$ETC/crypttab" 2>/dev/null)"
grep -q '/dev/mapper/droplet-data-crypt /data ext4' "$ETC/fstab" 2>/dev/null && pass "fstab entry written" || fail "fstab wrong"
grep -q 'RequiresMountsFor=/data' "$ETC/systemd/system/docker.service.d/droplet-data.conf" 2>/dev/null \
  && pass "docker drop-in written" || fail "docker drop-in missing"
[ -z "$(ls -A "$RUNTIME" 2>/dev/null)" ] && pass "no temp keyfile left behind" || fail "keyfile residue in runtime dir"

# WARP-2102: the freshly-written daemon.json must pin the containerd image
# store OFF. Docker >= 28's containerd store roots at /var/lib/containerd and
# IGNORES data-root — without the pin every image lands on the plain root LV
# (the bench box's 63G root hit 92%) while /data/docker sits empty.
DJ="$ETC/docker/daemon.json"
[ -f "$DJ" ] && pass "daemon.json written on fresh provision" || fail "no daemon.json written"
grep -q '"data-root": "/data/docker"' "$DJ" 2>/dev/null \
  && pass "daemon.json data-root=/data/docker" || fail "daemon.json missing data-root=/data/docker"
grep -q '"containerd-snapshotter": false' "$DJ" 2>/dev/null \
  && pass "daemon.json pins containerd-snapshotter=false [WARP-2102]" \
  || fail "daemon.json missing the containerd-snapshotter pin (WARP-2102) — images land on the plain root LV"
PYBIN="$(command -v python3 || command -v python || true)"
if [ -n "$PYBIN" ]; then
  "$PYBIN" -c 'import json,sys; cfg=json.load(open(sys.argv[1])); assert cfg["data-root"]=="/data/docker" and cfg["features"]["containerd-snapshotter"] is False' "$DJ" 2>/dev/null \
    && pass "daemon.json is valid JSON carrying both keys" || fail "daemon.json invalid JSON or wrong shape"
fi

# idempotency: second run with the mapper "active" exits 0 with no lvcreate.
: > "$CMD_LOG"
env "${luks_env[@]}" STUB_MAPPER_ACTIVE=1 "$LUKS_SCRIPT" provision >/dev/null 2>&1 \
  && pass "re-run is a no-op when already provisioned" || fail "re-run not idempotent"
grep -q 'lvcreate' "$CMD_LOG" && fail "re-run re-created the LV" || pass "re-run performed no destructive calls"
grep -q '"containerd-snapshotter": false' "$DJ" 2>/dev/null \
  && pass "re-run keeps the already-pinned daemon.json intact" || fail "re-run mangled daemon.json"

# WARP-2102 merge drills: an EXISTING daemon.json (shipped box) must RECEIVE
# the snapshotter pin on a provision re-run — the old early-return ("leaving
# docker data-root alone") left the fleet unfixable here. The merge adds ONLY
# the features key, preserves everything else, backs the file up, and never
# corrupts what dockerd boots from.
if [ -n "$PYBIN" ]; then
  printf '{\n  "data-root": "/data/docker",\n  "dns": ["1.1.1.1"]\n}\n' > "$DJ"
  rm -f "$DJ.warp2102-bak"
  env "${luks_env[@]}" STUB_MAPPER_ACTIVE=1 "$LUKS_SCRIPT" provision >/dev/null 2>&1 \
    && pass "provision re-run succeeds over a pre-existing daemon.json" \
    || fail "re-run errored on an existing daemon.json"
  grep -q '"containerd-snapshotter": false' "$DJ" \
    && pass "re-run MERGED the pin into the existing daemon.json [WARP-2102]" \
    || fail "existing daemon.json never received the pin (WARP-2102 regression)"
  grep -q '"dns"' "$DJ" && grep -q '"data-root": "/data/docker"' "$DJ" \
    && pass "merge preserved the existing daemon.json keys" || fail "merge dropped existing keys"
  "$PYBIN" -c 'import json,sys; json.load(open(sys.argv[1]))' "$DJ" 2>/dev/null \
    && pass "merged daemon.json still parses" || fail "merge produced invalid JSON"
  [ -f "$DJ.warp2102-bak" ] && pass "merge left a backup of the pre-merge file" || fail "no pre-merge backup written"

  # An UNPARSEABLE daemon.json must be left EXACTLY as it was — a corrupted
  # daemon.json takes dockerd down entirely.
  printf 'this is not json {' > "$DJ"
  env "${luks_env[@]}" STUB_MAPPER_ACTIVE=1 "$LUKS_SCRIPT" provision >/dev/null 2>&1 \
    && pass "re-run survives an unparseable daemon.json" || fail "re-run died on bad JSON"
  [ "$(cat "$DJ")" = "this is not json {" ] \
    && pass "unparseable daemon.json left byte-identical (never corrupted)" \
    || fail "merge corrupted an unparseable daemon.json"

  # An explicit operator containerd-snapshotter value is respected, not overridden.
  printf '{\n  "features": { "containerd-snapshotter": true }\n}\n' > "$DJ"
  env "${luks_env[@]}" STUB_MAPPER_ACTIVE=1 "$LUKS_SCRIPT" provision >/dev/null 2>&1 || true
  grep -q '"containerd-snapshotter": true' "$DJ" \
    && pass "explicit operator snapshotter=true respected (warned, not overridden)" \
    || fail "merge overrode an explicit operator choice"
  # restore the canonical file for the drills that follow
  printf '{\n  "data-root": "/data/docker",\n  "features": {\n    "containerd-snapshotter": false\n  }\n}\n' > "$DJ"
else
  skip "WARP-2102 merge drills (no python on harness PATH)"
fi

# no TPM + no override = refuse loudly (exit 2), create NOTHING.
: > "$CMD_LOG"
if env "${luks_env[@]}" DROPLET_TPM_DEVICE=/nonexistent "$LUKS_SCRIPT" provision >/dev/null 2>&1; then
  fail "provision proceeded without a TPM"
else
  rc=$?
  [ "$rc" -eq 2 ] && pass "refuses without a TPM (exit 2)" || fail "wrong exit code without TPM ($rc)"
fi
grep -q 'lvcreate' "$CMD_LOG" && fail "TPM-less run still touched LVM" || pass "TPM-less run touched nothing"

# WARP-232 finding 6: no TPM BUT DROPLET_LUKS_ALLOW_NO_TPM=1 (dev override) →
# provision PROCEEDS, SKIPS the TPM2 keyslot enroll (it would fail hard with no
# TPM), and STILL enrolls the durable recovery keyslot (so the dev box has a
# working unlock path). Old bug: the TPM enroll ran unconditionally → died under
# set -e before the recovery slot, AND the flag was never forwarded through sudo.
: > "$CMD_LOG"
if env "${luks_env[@]}" DROPLET_TPM_DEVICE=/nonexistent DROPLET_LUKS_ALLOW_NO_TPM=1 \
     "$LUKS_SCRIPT" provision >/dev/null 2>&1; then
  pass "ALLOW_NO_TPM=1 lets provision proceed on a TPM-less box [finding 6]"
else
  fail "ALLOW_NO_TPM=1 did not let provision proceed (finding 6)"
fi
# The TPM2 keyslot enroll must be SKIPPED (no --tpm2-device cryptenroll call)...
if grep -qE 'systemd-cryptenroll .*--tpm2-device' "$CMD_LOG"; then
  fail "TPM enroll still attempted under ALLOW_NO_TPM (finding 6) — fails hard with no TPM"
else
  pass "TPM2 keyslot enroll SKIPPED under ALLOW_NO_TPM=1 [finding 6]"
fi
# ...but the recovery keyslot MUST still be enrolled (durable unlock path).
grep -qE 'systemd-cryptenroll .*--recovery-key' "$CMD_LOG" \
  && pass "recovery keyslot STILL enrolled under ALLOW_NO_TPM=1 (dev box stays unlockable) [finding 6]" \
  || fail "no recovery keyslot under ALLOW_NO_TPM (finding 6) — dev box would be unrecoverable"

# WARP-232 finding 6 (forwarding): the install lib must forward the flag across
# the sudo boundary. Static-assert scripts/lib/luks.sh passes it into the sudo
# invocation as an env assignment (sudo scrubs env, so an un-forwarded flag is
# inert end to end). Match the assignment form the sudo command uses.
grep -qE 'DROPLET_LUKS_ALLOW_NO_TPM="\$\{DROPLET_LUKS_ALLOW_NO_TPM' "$INSTALL_LIB" \
  && pass "install lib forwards DROPLET_LUKS_ALLOW_NO_TPM through sudo [finding 6]" \
  || fail "install lib does not forward DROPLET_LUKS_ALLOW_NO_TPM (finding 6) — flag inert"

# WARP-2100: the unlock-timeout seam must also cross the sudo boundary, or an
# operator-tuned DROPLET_LUKS_UNLOCK_TIMEOUT is silently dropped by sudo's
# env scrub (same failure shape as finding 6).
grep -qE 'DROPLET_LUKS_UNLOCK_TIMEOUT="\$\{DROPLET_LUKS_UNLOCK_TIMEOUT' "$INSTALL_LIB" \
  && pass "install lib forwards DROPLET_LUKS_UNLOCK_TIMEOUT through sudo [WARP-2100]" \
  || fail "install lib does not forward DROPLET_LUKS_UNLOCK_TIMEOUT (WARP-2100) — seam inert under sudo"

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
# EXECUTING drill: secrets relocation (WARP-232 review — findings 1, 2, 8)
#
# The static grep above only proves relocate_secrets_to_data / _relocate_one
# EXIST. This section RUNS them against a tmp filesystem with stubbed sudo +
# findmnt (DROPLET_LUKS_SKIP_OS_GATE bypasses the Linux-only guard), so the
# real copy/symlink/perms logic is exercised — the bug class the six-finding
# review flagged (green suite, never-executed logic).
# =============================================================================
echo ""
echo "--- EXECUTING drill: secrets relocation onto the encrypted /data ---"
RWORK="$(mktemp -d -t relocdrill-XXXXXXXX)"
trap 'rm -rf "${WORK:-}" "${RWORK:-}" "${PWORK:-}" "${SWORK:-}" "${HWORK:-}" "${UWORK:-}"' EXIT
RSTUB="$RWORK/bin"; RREPO="$RWORK/repo"; RDATA="$RWORK/data"
mkdir -p "$RSTUB" "$RREPO/data/secrets" "$RDATA"
# sudo stub: strip leading VAR=val assignments, exec the rest as the test user.
cat > "$RSTUB/sudo" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in *=*) shift ;; *) break ;; esac; done
exec "$@"
STUB
# findmnt stub: /data is the encrypted mapper so relocation proceeds.
cat > "$RSTUB/findmnt" <<'STUB'
#!/usr/bin/env bash
printf '/dev/mapper/droplet-data-crypt\n'
STUB
chmod +x "$RSTUB/sudo" "$RSTUB/findmnt"

printf 'DEVICE_SECRET_KEY=drill-device-secret\nPOSTGRES_PASSWORD=pg\n' > "$RREPO/.env"
printf 'AUDIT_KEY_BYTES_DRILL\n' > "$RREPO/data/secrets/audit.key"
chmod 600 "$RREPO/.env" "$RREPO/data/secrets/audit.key"

reloc_run() {
  PATH="$RSTUB:$PATH" \
  DROPLET_LUKS_SKIP_OS_GATE=1 \
  REPO_ROOT="$RREPO" \
  DROPLET_DATA_MOUNT="$RDATA" \
  DROPLET_LUKS_MAPPER=droplet-data-crypt \
  DROPLET_RELOCATE_OWNER="$(id -un):$(id -gn)" \
  bash -c '
    log_info(){ :; }; log_warn(){ printf "WARN: %s\n" "$*"; }; log_success(){ :; }
    source "'"$INSTALL_LIB"'"
    relocate_secrets_to_data
  '
}
reloc_run >/dev/null 2>&1 && pass "relocate_secrets_to_data runs to completion" || fail "relocation drill errored"

# Finding 1: audit.key lands at .../secrets/audit.key, NOT .../secrets/secrets/…
if [ -f "$RDATA/droplet/secrets/audit.key" ] && [ ! -e "$RDATA/droplet/secrets/secrets" ]; then
  pass "secrets dir lands at the RIGHT level (no secrets/secrets nesting) [finding 1]"
else
  fail "secrets relocation nested one level too deep (finding 1 regression): $(find "$RDATA" -name audit.key)"
fi

# The .env + audit.key symlinks RESOLVE to the real files (not dangling).
[ -L "$RREPO/.env" ] && [ -e "$RREPO/.env" ] && pass ".env is a symlink that resolves" || fail ".env symlink missing/dangling"
[ -L "$RREPO/data/secrets" ] && [ -e "$RREPO/data/secrets/audit.key" ] \
  && pass "data/secrets symlink resolves to real audit.key" || fail "data/secrets symlink broken"
[ "$(cat "$RREPO/data/secrets/audit.key" 2>/dev/null)" = "AUDIT_KEY_BYTES_DRILL" ] \
  && pass "audit.key content survives relocation (loadAuditKeyFromDisk would succeed)" \
  || fail "audit.key content lost/unreadable through the symlink"
grep -q '^DEVICE_SECRET_KEY=drill-device-secret' "$RREPO/.env" \
  && pass ".env content (DEVICE_SECRET_KEY) resolves through the symlink" || fail ".env content lost"

# Finding 2 (perms): a NON-ROOT reader can traverse the container dirs + read
# the relocated files. We already run as the (non-root) test user, so a plain
# read that succeeds IS the assertion — with the old root:root 0700 dirs the
# open() would EACCES. Guard: skip the strict check if the harness is root.
if [ "$(id -u)" -ne 0 ]; then
  if cat "$RREPO/.env" >/dev/null 2>&1 && cat "$RREPO/data/secrets/audit.key" >/dev/null 2>&1; then
    pass "non-root reader can read the relocated .env + secrets [finding 2]"
  else
    fail "non-root reader cannot read relocated secrets (finding 2 perms regression)"
  fi
  # Container dirs must be traversable (owner-executable) by the install user.
  # `ls -ld` perm string is portable across GNU (Linux CI) and BSD (macOS) —
  # unlike stat, whose -c/-f flags mean opposite things on the two platforms.
  dperm="$(ls -ld "$RDATA/droplet/env" 2>/dev/null | awk '{print $1}')"
  case "$dperm" in
    ?rwx*) pass "container dir /data/droplet/env is owner-traversable (rwx) [finding 2]" ;;
    *)     fail "container dir not owner-traversable: $dperm" ;;
  esac
else
  skip "non-root readability (harness is root)"
fi

# Finding 8: the plaintext original is GONE from the repo root after relocation
# (shred -u, or rm fallback where shred is absent) — not left as a readable copy.
[ ! -e "$RREPO/data/secrets/audit.key" ] || [ -L "$RREPO/data/secrets" ] \
  && pass "plaintext original removed from root-fs after relocation [finding 8]" \
  || fail "plaintext secrets left behind on root-fs (finding 8)"

# Idempotency: a second run over the now-symlinked paths is a clean no-op.
reloc_run >/dev/null 2>&1 && pass "relocation is idempotent (re-run over symlinks no-ops)" || fail "second relocation run errored"
[ "$(cat "$RREPO/data/secrets/audit.key" 2>/dev/null)" = "AUDIT_KEY_BYTES_DRILL" ] \
  && pass "audit.key intact after idempotent re-run" || fail "re-run corrupted audit.key"

# =============================================================================
# EXECUTING drill: symlink-aware .env writer (WARP-232 finding 2, second half)
#
# After relocation .env is a SYMLINK. The FIPS/single-box atomic env writers
# (_upsert_env_kv) must write THROUGH the link to the encrypted /data target —
# NOT replace the link with a plain file on the unencrypted root (which would
# move DEVICE_SECRET_KEY back outside the LUKS boundary + break the compose
# ../.env bind). Runs the real _upsert_env_kv from scripts/lib/secrets.sh.
# =============================================================================
echo ""
echo "--- EXECUTING drill: symlink-aware env writer (_upsert_env_kv through a relocated .env) ---"
SECRETS_LIB="$REPO_ROOT/scripts/lib/secrets.sh"
if [ -f "$SECRETS_LIB" ]; then
  env_real="$RDATA/droplet/env/.env"          # the real (encrypted-side) target
  before_key="$(grep '^DEVICE_SECRET_KEY=' "$env_real" 2>/dev/null || true)"
  ENV_FILE="$RREPO/.env" REPO_ROOT="$RREPO" bash -c '
    log_error(){ printf "ERR: %s\n" "$*"; }
    source "'"$SECRETS_LIB"'"
    _upsert_env_kv DROPLET_FIPS_MODE 1
  ' >/dev/null 2>&1
  [ -L "$RREPO/.env" ] && pass ".env is STILL a symlink after _upsert_env_kv (link not clobbered) [finding 2]" \
    || fail "_upsert_env_kv replaced the symlink with a plain file (finding 2 regression)"
  grep -q '^DROPLET_FIPS_MODE=1' "$env_real" \
    && pass "new key written THROUGH the link onto the encrypted /data target" \
    || fail "upsert did not reach the encrypted target"
  [ "$(grep '^DEVICE_SECRET_KEY=' "$env_real" 2>/dev/null)" = "$before_key" ] \
    && pass "DEVICE_SECRET_KEY stays on the encrypted /data (not moved onto root-fs) [finding 2]" \
    || fail "DEVICE_SECRET_KEY lost/moved by the env writer"
  # The root-fs must NOT hold a plain .env file carrying the secret.
  if [ "$(id -u)" -ne 0 ]; then
    [ -L "$RREPO/.env" ] && pass "no plaintext .env materialized on the unencrypted root" \
      || fail "a plaintext .env now sits on the unencrypted root"
  fi
else
  skip "secrets.sh not found — symlink-writer drill"
fi

# =============================================================================
# EXECUTING drill: provision RE-RUN refuses to wire boot with NO keyslot
# (WARP-232 finding 5 — power-cut mid-provision)
#
# A LUKS container that exists but does NOT open (zero keyslots — the classic
# luksFormat-then-power-cut state) must NOT get crypttab/fstab written, or the
# next boot mount-fails forever with no recovery key. Drives the existing-LUKS
# re-run branch with a stubbed LV_DEV present + isLuks true + open FAILING.
# =============================================================================
echo ""
echo "--- EXECUTING drill: provision re-run REFUSES a no-keyslot container [finding 5] ---"
if [ -x "$LUKS_SCRIPT" ]; then
  PWORK="$(mktemp -d -t provrerun-XXXXXXXX)"
  PSTUB="$PWORK/bin"; PETC="$PWORK/etc"; PDEV="$PWORK/dev"
  mkdir -p "$PSTUB" "$PETC" "$PDEV"
  PCMD="$PWORK/cmd.log"; : > "$PCMD"
  LVDEV="$PDEV/luks-lv"; : > "$LVDEV"      # existing LUKS "container" node (present)
  for t in lvcreate mkfs.ext4 mount blkid vgs systemd-cryptenroll; do
    printf '#!/usr/bin/env bash\nprintf "%s %%s\\n" "$*" >> "%s"\n' "$t" "$PCMD" > "$PSTUB/$t"
    chmod +x "$PSTUB/$t"
  done
  # findmnt: /data NOT mounted (so we don't short-circuit as already-active).
  printf '#!/usr/bin/env bash\nprintf "findmnt %%s\\n" "$*" >> "%s"\nexit 1\n' "$PCMD" > "$PSTUB/findmnt"
  chmod +x "$PSTUB/findmnt"
  # cryptsetup: isLuks TRUE; status FAILS (mapper never opened); open logs+fails.
  cat > "$PSTUB/cryptsetup" <<STUB
#!/usr/bin/env bash
printf 'cryptsetup %s\n' "\$*" >> "$PCMD"
case " \$* " in
  *" isLuks "*) exit 0 ;;
  *" status "*) exit 1 ;;
  *" open "*)   exit 1 ;;
esac
exit 0
STUB
  chmod +x "$PSTUB/cryptsetup"
  # systemd-cryptsetup attach: logs + FAILS (no keyslot to unseal).
  printf '#!/usr/bin/env bash\nprintf "systemd-cryptsetup %%s\\n" "$*" >> "%s"\nexit 1\n' "$PCMD" > "$PSTUB/systemd-cryptsetup"
  chmod +x "$PSTUB/systemd-cryptsetup"

  # DROPLET_LUKS_LV_DEV points the existing-LUKS check at our present tmp node,
  # DROPLET_LUKS_MAPPER_DEV at an ABSENT node so _unlock_verified's fallback also
  # reports "not open" — together the container "exists, isLuks, but won't open".
  prov_env=(
    "PATH=$PSTUB:$PATH"
    DROPLET_LUKS_SKIP_OS_GATE=1
    DROPLET_LUKS_VG=ubuntu-vg DROPLET_LUKS_LV=droplet-data
    DROPLET_LUKS_MAPPER=droplet-data-crypt DROPLET_DATA_MOUNT="$PWORK/data"
    DROPLET_LUKS_LV_DEV="$LVDEV"
    DROPLET_LUKS_MAPPER_DEV="$PDEV/mapper-absent"
    DROPLET_ETC_DIR="$PETC" DROPLET_LUKS_RUNTIME_DIR="$PWORK/run"
    DROPLET_TPM_DEVICE="$PSTUB/cryptsetup"
    DROPLET_LVCREATE_BIN="$PSTUB/lvcreate" DROPLET_VGS_BIN="$PSTUB/vgs"
    DROPLET_MKFS_BIN="$PSTUB/mkfs.ext4" DROPLET_MOUNT_BIN="$PSTUB/mount"
    DROPLET_CRYPTSETUP_BIN="$PSTUB/cryptsetup"
    DROPLET_CRYPTENROLL_BIN="$PSTUB/systemd-cryptenroll"
    DROPLET_SYSTEMD_CRYPTSETUP_BIN="$PSTUB/systemd-cryptsetup"
    CMD_LOG="$PCMD"
  )
  if env "${prov_env[@]}" "$LUKS_SCRIPT" provision >/dev/null 2>&1; then
    fail "provision re-run PROCEEDED on a no-keyslot container (finding 5 regression)"
  else
    rc=$?
    [ "$rc" -eq 2 ] && pass "provision re-run refuses a no-keyslot container (exit 2) [finding 5]" \
      || fail "provision re-run wrong exit code on no-keyslot container ($rc)"
  fi
  # The refusal must have written NO crypttab / fstab entry.
  if ! grep -q 'droplet-data-crypt' "$PETC/crypttab" 2>/dev/null \
     && ! grep -q 'ext4' "$PETC/fstab" 2>/dev/null; then
    pass "no crypttab/fstab wired for the unopenable container [finding 5]"
  else
    fail "provision wrote boot config for a container it could not open (finding 5)"
  fi
fi

# =============================================================================
# EXECUTING drill: a BLOCKING unlock is TIMED OUT, never hung (WARP-2100)
#
# droplet-firstboot ran provision with inherited stdin, no timeout, and no
# headless= option. A systemd-cryptsetup attach whose TPM unseal fails queues
# a socket-based ask-password prompt and BLOCKS; the bare `cryptsetup open`
# fallback then reads a passphrase from stdin and blocks again. With the
# firstboot unit's TimeoutStartSec=0 the box wedged on first boot FOREVER —
# and the WARP-232 _unlock_verified refusal sits AFTER the attach, so it never
# ran. The stubs model the queued prompt as a bounded sleep (bounded so a
# regression cannot wedge CI); provision must kill them via its shrunk
# DROPLET_LUKS_UNLOCK_TIMEOUT and land on the loud finding-5 refusal (exit 2)
# well inside the outer `timeout` — pre-WARP-2100 code hangs until the outer
# timeout fires (exit 124) and this drill fails fast instead of hanging.
# =============================================================================
echo ""
echo "--- EXECUTING drill: blocking unlock is TIMED OUT, not hung [WARP-2100] ---"
if [ -x "$LUKS_SCRIPT" ]; then
  HWORK="$(mktemp -d -t provhang-XXXXXXXX)"
  HSTUB="$HWORK/bin"; HETC="$HWORK/etc"; HDEV="$HWORK/dev"; HASK="$HWORK/ask-password"
  mkdir -p "$HSTUB" "$HETC" "$HDEV" "$HASK"
  HCMD="$HWORK/cmd.log"; : > "$HCMD"
  HLV="$HDEV/luks-lv"; : > "$HLV"          # existing LUKS "container" node
  : > "$HASK/ask.warp2100drill"            # a queued prompt the diagnostic must surface
  for t in lvcreate mkfs.ext4 mount blkid vgs systemd-cryptenroll; do
    printf '#!/usr/bin/env bash\nprintf "%s %%s\\n" "$*" >> "%s"\n' "$t" "$HCMD" > "$HSTUB/$t"
    chmod +x "$HSTUB/$t"
  done
  printf '#!/usr/bin/env bash\nprintf "findmnt %%s\\n" "$*" >> "%s"\nexit 1\n' "$HCMD" > "$HSTUB/findmnt"
  chmod +x "$HSTUB/findmnt"
  # cryptsetup: isLuks TRUE; status FAILS (never opened); `open` models the
  # interactive passphrase read — it SLEEPS (bounded).
  cat > "$HSTUB/cryptsetup" <<STUB
#!/usr/bin/env bash
printf 'cryptsetup %s\n' "\$*" >> "$HCMD"
case " \$* " in
  *" isLuks "*) exit 0 ;;
  *" status "*) exit 1 ;;
  *" open "*)   sleep 20; exit 1 ;;
esac
exit 0
STUB
  chmod +x "$HSTUB/cryptsetup"
  # systemd-cryptsetup attach: models the queued ask-password prompt — SLEEPS.
  cat > "$HSTUB/systemd-cryptsetup" <<STUB
#!/usr/bin/env bash
printf 'systemd-cryptsetup %s\n' "\$*" >> "$HCMD"
sleep 20
exit 1
STUB
  chmod +x "$HSTUB/systemd-cryptsetup"

  hang_env=(
    "PATH=$HSTUB:$PATH"
    DROPLET_LUKS_SKIP_OS_GATE=1
    DROPLET_LUKS_VG=ubuntu-vg DROPLET_LUKS_LV=droplet-data
    DROPLET_LUKS_MAPPER=droplet-data-crypt DROPLET_DATA_MOUNT="$HWORK/data"
    DROPLET_LUKS_LV_DEV="$HLV"
    DROPLET_LUKS_MAPPER_DEV="$HDEV/mapper-absent"
    DROPLET_ETC_DIR="$HETC" DROPLET_LUKS_RUNTIME_DIR="$HWORK/run"
    DROPLET_TPM_DEVICE="$HSTUB/cryptsetup"
    DROPLET_LVCREATE_BIN="$HSTUB/lvcreate" DROPLET_VGS_BIN="$HSTUB/vgs"
    DROPLET_MKFS_BIN="$HSTUB/mkfs.ext4" DROPLET_MOUNT_BIN="$HSTUB/mount"
    DROPLET_CRYPTSETUP_BIN="$HSTUB/cryptsetup"
    DROPLET_CRYPTENROLL_BIN="$HSTUB/systemd-cryptenroll"
    DROPLET_SYSTEMD_CRYPTSETUP_BIN="$HSTUB/systemd-cryptsetup"
    DROPLET_LUKS_UNLOCK_TIMEOUT=2
    DROPLET_ASK_PASSWORD_DIR="$HASK"
    CMD_LOG="$HCMD"
  )
  HOUT="$HWORK/provision.out"
  hrc=0
  timeout 15 env "${hang_env[@]}" "$LUKS_SCRIPT" provision > "$HOUT" 2>&1 || hrc=$?
  if [ "$hrc" -eq 124 ]; then
    fail "provision HUNG on the blocking unlock (killed by the outer 15s timeout) [WARP-2100]"
  elif [ "$hrc" -eq 2 ]; then
    pass "blocking unlock bounded: provision refused loudly (exit 2) inside the timeout [WARP-2100]"
  else
    fail "provision exited $hrc on a blocking unlock (want the loud exit-2 refusal, got neither hang nor refusal)"
  fi
  # The bounded failure must land on the finding-5 discipline: NO boot config.
  if ! grep -q 'droplet-data-crypt' "$HETC/crypttab" 2>/dev/null \
     && ! grep -q 'ext4' "$HETC/fstab" 2>/dev/null; then
    pass "no crypttab/fstab wired after the timed-out unlock [WARP-2100]"
  else
    fail "timed-out unlock still wired boot config (WARP-2100)"
  fi
  # The refusal diagnostic must surface the queued ask-password prompt.
  if grep -q 'ask-password' "$HOUT" 2>/dev/null && grep -q 'ask.warp2100drill' "$HOUT" 2>/dev/null; then
    pass "refusal diagnostic surfaces the pending ask-password prompt [WARP-2100]"
  else
    fail "no pending-prompt diagnostic in the refusal output (WARP-2100)"
  fi
fi

# =============================================================================
# EXECUTING drill: FRESH provision refuses a missing TPM2 USERSPACE — and
# self-heals via apt when it can (WARP-2101)
#
# /dev/tpm0 proves the CHIP; systemd-cryptenroll additionally dlopens the tss2
# userspace (libtss2-esys/-mu/-rc) at runtime. The install seed never shipped
# those, so on a box with healthy TPM hardware cryptenroll died "TPM2 support
# is not installed" AFTER luksFormat and BEFORE any keyslot enroll (set -e) —
# stranding the exact zero-keyslot container the finding-5 re-run branch
# refuses. The fix preflights the userspace (cryptenroll --tpm2-device=list)
# BEFORE creating anything, attempts the repo's apt self-install pattern
# (backup.sh restic precedent), and aborts pre-format when still unusable.
# =============================================================================
echo ""
echo "--- EXECUTING drill: missing TPM2 userspace fails BEFORE luksFormat [WARP-2101] ---"
if [ -x "$LUKS_SCRIPT" ]; then
  UWORK="$(mktemp -d -t tpm2usr-XXXXXXXX)"
  USTUB="$UWORK/bin"; UETC="$UWORK/etc"
  mkdir -p "$USTUB" "$UETC"
  UCMD="$UWORK/cmd.log"; : > "$UCMD"
  for t in lvcreate mkfs.ext4 mount cryptsetup systemd-cryptsetup; do
    printf '#!/usr/bin/env bash\nprintf "%s %%s\\n" "$*" >> "%s"\n' "$t" "$UCMD" > "$USTUB/$t"; chmod +x "$USTUB/$t"
  done
  printf '#!/usr/bin/env bash\nprintf "vgs %%s\\n" "$*" >> "%s"\nprintf "512\\n"\n' "$UCMD" > "$USTUB/vgs"; chmod +x "$USTUB/vgs"
  printf '#!/usr/bin/env bash\nprintf "findmnt %%s\\n" "$*" >> "%s"\nexit 1\n' "$UCMD" > "$USTUB/findmnt"; chmod +x "$USTUB/findmnt"
  printf '#!/usr/bin/env bash\nprintf "blkid %%s\\n" "$*" >> "%s"\nexit 2\n' "$UCMD" > "$USTUB/blkid"; chmod +x "$USTUB/blkid"
  # cryptenroll: EVERY --tpm2-device call (list AND auto) fails with the real
  # "TPM2 support is not installed" until the apt stub drops the
  # tss2-installed flag — exactly how a missing userspace behaves on the box.
  cat > "$USTUB/systemd-cryptenroll" <<STUB
#!/usr/bin/env bash
printf 'systemd-cryptenroll %s\n' "\$*" >> "$UCMD"
for a in "\$@"; do
  case "\$a" in
    --tpm2-device=*)
      if [ ! -e "$UWORK/tss2-installed" ]; then
        echo "TPM2 support is not installed." >&2
        exit 1
      fi ;;
    --recovery-key)
      printf 'aaaaa-bbbbb-ccccc-ddddd\n'; exit 0 ;;
  esac
done
exit 0
STUB
  chmod +x "$USTUB/systemd-cryptenroll"
  # apt-get: logs every call; "installs" the userspace only when
  # STUB_APT_HEALS=1. Always exits 0 — proving the script re-checks
  # cryptenroll instead of trusting apt's exit code.
  cat > "$USTUB/apt-get" <<STUB
#!/usr/bin/env bash
printf 'apt-get %s\n' "\$*" >> "$UCMD"
if [ "\${STUB_APT_HEALS:-0}" = "1" ]; then
  case " \$* " in *" install "*) : > "$UWORK/tss2-installed" ;; esac
fi
exit 0
STUB
  chmod +x "$USTUB/apt-get"

  uenv=(
    "PATH=$USTUB:$PATH"
    DROPLET_LUKS_SKIP_OS_GATE=1
    DROPLET_LUKS_VG=ubuntu-vg DROPLET_LUKS_LV=droplet-data
    DROPLET_LUKS_MAPPER=droplet-data-crypt DROPLET_DATA_MOUNT=/data
    DROPLET_ETC_DIR="$UETC" DROPLET_LUKS_RUNTIME_DIR="$UWORK/run"
    DROPLET_TPM_DEVICE="$USTUB/cryptsetup"  # TPM CHIP "present"; the USERSPACE is what's missing
    DROPLET_LVCREATE_BIN="$USTUB/lvcreate" DROPLET_VGS_BIN="$USTUB/vgs"
    DROPLET_MKFS_BIN="$USTUB/mkfs.ext4" DROPLET_MOUNT_BIN="$USTUB/mount"
    DROPLET_CRYPTSETUP_BIN="$USTUB/cryptsetup"
    DROPLET_CRYPTENROLL_BIN="$USTUB/systemd-cryptenroll"
    DROPLET_SYSTEMD_CRYPTSETUP_BIN="$USTUB/systemd-cryptsetup"
    DROPLET_APT_GET_BIN="$USTUB/apt-get"
    CMD_LOG="$UCMD"
  )

  # (1) userspace missing + apt cannot supply it → refuse BEFORE luksFormat.
  : > "$UCMD"
  urc=0
  uout="$(env "${uenv[@]}" "$LUKS_SCRIPT" provision 2>&1)" || urc=$?
  if [ "$urc" -eq 2 ]; then
    pass "missing TPM2 userspace refuses with exit 2 (precondition) [WARP-2101]"
  else
    fail "missing TPM2 userspace: wrong exit code ($urc) — cryptenroll died AFTER luksFormat, not in a preflight"
  fi
  if grep -q 'luksFormat' "$UCMD" || grep -q 'lvcreate' "$UCMD"; then
    fail "provision touched LVM/LUKS despite an unusable TPM2 userspace — the zero-keyslot stranded container [WARP-2101]"
  else
    pass "no LV created, no luksFormat run — abort lands BEFORE any container exists"
  fi
  if ! grep -q 'droplet-data-crypt' "$UETC/crypttab" 2>/dev/null && [ ! -s "$UETC/fstab" ]; then
    pass "no crypttab/fstab wired on the userspace refusal"
  else
    fail "boot config written despite the userspace refusal"
  fi
  grep -qE 'apt-get .*install .*libtss2-rc0t64' "$UCMD" \
    && pass "self-heal attempted (apt-get install libtss2-*) before refusing" \
    || fail "no apt self-install attempt (backup.sh restic pattern) before the refusal"
  printf '%s' "$uout" | grep -qi 'TPM2 userspace' \
    && pass "refusal message names the TPM2 userspace (distinct from the no-chip error)" \
    || fail "refusal message does not name the TPM2 userspace: $(printf '%s' "$uout" | tail -2 | tr '\n' ' ')"

  # (2) apt CAN supply it → provision self-heals and completes the full flow.
  : > "$UCMD"; rm -f "$UWORK/tss2-installed"
  if env "${uenv[@]}" STUB_APT_HEALS=1 "$LUKS_SCRIPT" provision >/dev/null 2>&1; then
    pass "provision self-heals via apt and completes [WARP-2101]"
  else
    fail "provision did not complete after the apt self-install healed the userspace"
  fi
  grep -qE 'cryptsetup luksFormat --type luks2' "$UCMD" && pass "healed run formats the container" || fail "healed run never formatted"
  grep -qE 'systemd-cryptenroll .*--tpm2-device=auto' "$UCMD" && pass "healed run enrolls the TPM keyslot" || fail "healed run never TPM-enrolled"

  # (3) enroll ORDER: the recovery keyslot must land BEFORE the TPM keyslot,
  # so an abort inside the TPM enroll can never strand a container whose only
  # keyslot is the tmpfs install keyfile that vanishes on reboot (WARP-2101).
  rec_line="$(grep -nE 'systemd-cryptenroll .*--recovery-key' "$UCMD" | head -1 | cut -d: -f1 || true)"
  tpm_line="$(grep -nE 'systemd-cryptenroll .*--tpm2-device=auto' "$UCMD" | head -1 | cut -d: -f1 || true)"
  if [ -n "$rec_line" ] && [ -n "$tpm_line" ] && [ "$rec_line" -lt "$tpm_line" ]; then
    pass "recovery keyslot enrolled BEFORE the TPM keyslot (abort-safe order) [WARP-2101]"
  else
    fail "TPM keyslot enrolled before the recovery keyslot (rec=${rec_line:-none} tpm=${tpm_line:-none}) — a TPM-enroll abort strands the container"
  fi
fi

# =============================================================================
# Static/exec: fstab + crypttab have `nofail` so a locked /data boots DEGRADED,
# not into emergency mode (WARP-232 finding 3).
# =============================================================================
echo ""
echo "--- fstab/crypttab nofail (locked /data boots degraded, not emergency) [finding 3] ---"
grep -q 'nofail' "$LUKS_SCRIPT" && pass "provision writes a nofail mount option" || fail "no nofail in provision"
# Re-run the happy-path provision drill and assert the WRITTEN fstab line has nofail.
if [ -x "$LUKS_SCRIPT" ]; then
  FWORK="$(mktemp -d -t fstabnofail-XXXXXXXX)"; FSTUB="$FWORK/bin"; FETC="$FWORK/etc"
  mkdir -p "$FSTUB" "$FETC"; FCMD="$FWORK/cmd.log"; : > "$FCMD"
  for t in lvcreate mkfs.ext4 mount blkid findmnt vgs cryptsetup systemd-cryptenroll systemd-cryptsetup; do
    printf '#!/usr/bin/env bash\nprintf "%s %%s\\n" "$*" >> "%s"\n' "$t" "$FCMD" > "$FSTUB/$t"; chmod +x "$FSTUB/$t"
  done
  printf '#!/usr/bin/env bash\nprintf "vgs %%s\\n" "$*" >> "%s"\nprintf "512\\n"\n' "$FCMD" > "$FSTUB/vgs"; chmod +x "$FSTUB/vgs"
  printf '#!/usr/bin/env bash\nprintf "findmnt %%s\\n" "$*" >> "%s"\nexit 1\n' "$FCMD" > "$FSTUB/findmnt"; chmod +x "$FSTUB/findmnt"
  printf '#!/usr/bin/env bash\nprintf "blkid %%s\\n" "$*" >> "%s"\nexit 2\n' "$FCMD" > "$FSTUB/blkid"; chmod +x "$FSTUB/blkid"
  cat > "$FSTUB/systemd-cryptenroll" <<'STUB'
#!/usr/bin/env bash
printf 'systemd-cryptenroll %s\n' "$*" >> "$CMD_LOG"
for a in "$@"; do [ "$a" = "--recovery-key" ] && { printf 'aaaaa-bbbbb\n'; exit 0; }; done
exit 0
STUB
  chmod +x "$FSTUB/systemd-cryptenroll"
  env PATH="$FSTUB:$PATH" DROPLET_LUKS_SKIP_OS_GATE=1 DROPLET_LUKS_VG=ubuntu-vg \
    DROPLET_LUKS_LV=droplet-data DROPLET_LUKS_MAPPER=droplet-data-crypt \
    DROPLET_DATA_MOUNT=/data DROPLET_ETC_DIR="$FETC" DROPLET_LUKS_RUNTIME_DIR="$FWORK/run" \
    DROPLET_TPM_DEVICE="$FSTUB/cryptsetup" DROPLET_LVCREATE_BIN="$FSTUB/lvcreate" \
    DROPLET_VGS_BIN="$FSTUB/vgs" DROPLET_MKFS_BIN="$FSTUB/mkfs.ext4" DROPLET_MOUNT_BIN="$FSTUB/mount" \
    DROPLET_CRYPTSETUP_BIN="$FSTUB/cryptsetup" DROPLET_CRYPTENROLL_BIN="$FSTUB/systemd-cryptenroll" \
    DROPLET_SYSTEMD_CRYPTSETUP_BIN="$FSTUB/systemd-cryptsetup" CMD_LOG="$FCMD" \
    "$LUKS_SCRIPT" provision >/dev/null 2>&1 || true
  grep -qE '/data ext4 .*nofail' "$FETC/fstab" 2>/dev/null \
    && pass "written fstab line carries nofail (degraded boot) [finding 3]" \
    || fail "fstab line missing nofail: $(grep /data "$FETC/fstab" 2>/dev/null)"
  grep -qE 'droplet-data-crypt .*nofail' "$FETC/crypttab" 2>/dev/null \
    && pass "written crypttab entry carries nofail [finding 3]" \
    || fail "crypttab entry missing nofail"
  rm -rf "$FWORK"
fi

# =============================================================================
# EXECUTING drill: crypto-shred targets the LUKS PARTITION recorded in state,
# not the plaintext mapper (WARP-232 finding 7).
# =============================================================================
echo ""
echo "--- EXECUTING drill: crypto-shred luksErase targets the backing partition [finding 7] ---"
if [ -x "$SHRED" ]; then
  SWORK="$(mktemp -d -t shreddrill-XXXXXXXX)"; SSTUB="$SWORK/bin"; SSTATE="$SWORK/state"; SREPO="$SWORK/repo"
  mkdir -p "$SSTUB" "$SSTATE" "$SREPO"
  SCMD="$SWORK/cmd.log"; : > "$SCMD"
  # State records an enrolled drive with device=the BACKING partition + a mapper.
  cat > "$SSTATE/mounts.json" <<'JSON'
{"mounts":[{"device":"/dev/sdz1","mount":"/mnt/droplet/usb","label":"usb","uuid":"abcd","trust":"enrolled","mapper":"/dev/mapper/droplet-usb-abcd"}]}
JSON
  cat > "$SSTUB/cryptsetup" <<STUB
#!/usr/bin/env bash
printf 'cryptsetup %s\n' "\$*" >> "$SCMD"
STUB
  for t in systemd-cryptenroll tpm2_clear shred find; do
    if [ "$t" = "find" ]; then
      # keep real find on PATH; just log via a wrapper is unnecessary.
      continue
    fi
    printf '#!/usr/bin/env bash\nprintf "%s %%s\\n" "$*" >> "%s"\n' "$t" "$SCMD" > "$SSTUB/$t"; chmod +x "$SSTUB/$t"
  done
  chmod +x "$SSTUB/cryptsetup"
  env PATH="$SSTUB:$PATH" DROPLET_SHRED_ASSUME_CONFIRM=1 \
    DROPLET_AUTOMOUNT_STATE_DIR="$SSTATE" DROPLET_REPO_ROOT="$SREPO" \
    DROPLET_LUKS_DEV="/dev/ubuntu-vg/droplet-data" \
    DROPLET_CRYPTSETUP_BIN="$SSTUB/cryptsetup" \
    DROPLET_CRYPTENROLL_BIN="$SSTUB/systemd-cryptenroll" \
    DROPLET_TPM2_CLEAR_BIN="$SSTUB/tpm2_clear" \
    "$SHRED" --yes-destroy-everything >/dev/null 2>&1 || true
  # luksErase must target the BACKING partition /dev/sdz1 (the real header) —
  # NOT the plaintext /dev/mapper/droplet-usb-abcd node (which has no header).
  if grep -q 'luksErase.*\/dev\/sdz1' "$SCMD" && ! grep -q 'luksErase.*mapper' "$SCMD"; then
    pass "crypto-shred luksErases the backing partition, not the mapper [finding 7]"
  else
    fail "crypto-shred targeted the wrong node (finding 7): $(grep luksErase "$SCMD" || echo none)"
  fi
  # And it luksErases the data LV too.
  grep -q 'luksErase.*droplet-data' "$SCMD" && pass "crypto-shred also erases the data LV header" \
    || fail "crypto-shred skipped the data LV"
  rm -rf "$SWORK"
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
