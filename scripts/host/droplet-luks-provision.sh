#!/usr/bin/env bash
# =============================================================================
# WARP-232 — LUKS2 + Argon2id data partition with TPM2-sealed unlock (host plane)
# =============================================================================
#
# Creates the encrypted data LV from the free VG extents the autoinstall
# storage layout leaves behind (Task 232.1), seals the unlock key to the TPM2
# (systemd-cryptenroll, PCRs default 0+2+4+7 — device-identity parity), enrolls
# an OFFLINE recovery key shown exactly once, wires crypttab/fstab for
# auto-unlock, and gates docker on /data so a PCR mismatch fails closed.
#
#   /dev/ubuntu-vg/droplet-data           LUKS2/Argon2id container
#   /dev/mapper/droplet-data-crypt        unlocked mapper, mounted at /data
#   /etc/crypttab                         tpm2-device=auto,luks,discard
#   /etc/fstab                            /data ext4 (x-systemd.device-timeout)
#   /etc/systemd/system/docker.service.d/droplet-data.conf   RequiresMountsFor=/data
#   /etc/docker/daemon.json               data-root=/data/docker + the WARP-2102
#                                         containerd-snapshotter=false pin (merged
#                                         into an existing file on re-runs)
#
# See droplet-tpm-lib.sh for why systemd tooling (systemd-cryptenroll) and not
# clevis / raw tpm2-tools / tpm2-pytss.
#
# Subcommands: provision | status   (see --help)
# Exit codes:  0 ok · 2 precondition (no TPM / no free extents / bad usage)
#
# Crypto-shred: `cryptsetup luksErase` + TPM clear destroys every keyslot →
# the data LV is ciphertext forever (docs/security/crypto-shred.md).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=droplet-tpm-lib.sh
source "$SCRIPT_DIR/droplet-tpm-lib.sh"

VG="${DROPLET_LUKS_VG:-ubuntu-vg}"
LV="${DROPLET_LUKS_LV:-droplet-data}"
MAPPER="${DROPLET_LUKS_MAPPER:-droplet-data-crypt}"
DATA_MOUNT="${DROPLET_DATA_MOUNT:-/data}"
ETC_DIR="${DROPLET_ETC_DIR:-/etc}"
RUNTIME_DIR="${DROPLET_LUKS_RUNTIME_DIR:-/run/droplet}"

# Tool seams (default to production binaries; tests inject PATH stubs).
LVCREATE="${DROPLET_LVCREATE_BIN:-lvcreate}"
VGS="${DROPLET_VGS_BIN:-vgs}"
MKFS="${DROPLET_MKFS_BIN:-mkfs.ext4}"
MOUNT="${DROPLET_MOUNT_BIN:-mount}"
CRYPTSETUP="$(droplet_tpm_cryptsetup)"
CRYPTENROLL="$(droplet_tpm_cryptenroll)"
SYSTEMD_CRYPTSETUP="${DROPLET_SYSTEMD_CRYPTSETUP_BIN:-/usr/lib/systemd/systemd-cryptsetup}"
APT_GET="${DROPLET_APT_GET_BIN:-apt-get}"

# TPM2 userspace packages systemd-cryptenroll dlopens at runtime (WARP-2101).
# Ubuntu 24.04 (noble) names — keep in sync with the autoinstall seed
# (scripts/image/autoinstall/user-data packages:).
TSS2_PKGS="libtss2-esys-3.0.2-0t64 libtss2-mu-4.0.1-0t64 libtss2-rc0t64"

# WARP-2100: hard bound (seconds) on each unlock attempt. droplet-firstboot
# runs this script unattended; an attach that queues an ask-password prompt
# otherwise blocks forever (see _attach_unlock). The hermetic harness shrinks
# this; scripts/lib/luks.sh forwards it across the sudo boundary.
UNLOCK_TIMEOUT="${DROPLET_LUKS_UNLOCK_TIMEOUT:-30}"
# Where systemd queues pending ask-password prompts (diagnostic surface only;
# seam so the harness can point it at a tmp dir).
ASK_PASSWORD_DIR="${DROPLET_ASK_PASSWORD_DIR:-/run/systemd/ask-password}"

# LV_DEV / MAPPER_DEV are the production LVM/dm paths; the hermetic harness
# overrides them (DROPLET_LUKS_LV_DEV / DROPLET_LUKS_MAPPER_DEV) to point at tmp
# nodes so the existing-LUKS re-run branch (finding 5) can be driven without a
# real /dev tree. Production never sets these.
LV_DEV="${DROPLET_LUKS_LV_DEV:-/dev/${VG}/${LV}}"
MAPPER_DEV="${DROPLET_LUKS_MAPPER_DEV:-/dev/mapper/${MAPPER}}"
CRYPTTAB="$ETC_DIR/crypttab"
FSTAB="$ETC_DIR/fstab"
DOCKER_DROPIN_DIR="$ETC_DIR/systemd/system/docker.service.d"
DOCKER_DROPIN="$DOCKER_DROPIN_DIR/droplet-data.conf"

log() { printf '  [droplet-luks-provision] %s\n' "$*"; }
err() { printf '  [droplet-luks-provision] ERROR: %s\n' "$*" >&2; }

_require_tpm() {
  if droplet_tpm_present; then
    return 0
  fi
  if [ "${DROPLET_LUKS_ALLOW_NO_TPM:-0}" = "1" ]; then
    log "WARNING: no TPM at ${DROPLET_TPM_DEVICE:-/dev/tpm0} but DROPLET_LUKS_ALLOW_NO_TPM=1 —"
    log "WARNING: proceeding for DEV ONLY. The data partition will NOT be TPM-sealed."
    return 0
  fi
  err "no TPM device at ${DROPLET_TPM_DEVICE:-/dev/tpm0} — refusing to provision the encrypted data partition."
  err "The data surfaces stay on the unencrypted root. On a real appliance this must be fixed;"
  err "on a dev box set DROPLET_LUKS_ALLOW_NO_TPM=1 to force plain-key provisioning."
  exit 2
}

# _require_tpm2_userspace — FRESH-provision-path preflight (WARP-2101).
# The seed shipped no tss2 userspace, so on a healthy-TPM box the first
# cryptenroll call died "TPM2 support is not installed" AFTER luksFormat and
# BEFORE any keyslot enroll — under set -e that strands a LUKS2 container with
# ZERO usable keyslots (the exact state the finding-5 re-run branch refuses).
# So: verify systemd-cryptenroll can actually drive the TPM (not just that
# /dev/tpm0 exists), self-heal via apt (the backup.sh restic pattern — this
# script already runs as root), and if STILL unusable abort loudly BEFORE
# anything is created. Never called on the existing-container re-run path,
# so an already-provisioned box can never be bricked by this gate.
_require_tpm2_userspace() {
  if droplet_tpm_userspace_ok; then
    return 0
  fi
  log "TPM2 userspace (tss2 libraries) missing — systemd-cryptenroll cannot drive the TPM."
  log "Attempting self-install: $TSS2_PKGS"
  if command -v "$APT_GET" >/dev/null 2>&1; then
    # shellcheck disable=SC2086  # TSS2_PKGS is a deliberate word-split list
    DEBIAN_FRONTEND=noninteractive "$APT_GET" install -y $TSS2_PKGS \
      || { "$APT_GET" update -y >/dev/null 2>&1 || true
           # shellcheck disable=SC2086
           DEBIAN_FRONTEND=noninteractive "$APT_GET" install -y $TSS2_PKGS || true; }
  fi
  if droplet_tpm_userspace_ok; then
    log "TPM2 userspace installed — continuing"
    return 0
  fi
  err "TPM2 userspace is NOT usable (systemd-cryptenroll --tpm2-device=list fails)"
  err "even though ${DROPLET_TPM_DEVICE:-/dev/tpm0} exists. Refusing BEFORE luksFormat:"
  err "proceeding would abort mid-provision and strand a LUKS container with ZERO"
  err "usable keyslots. No LV or container was created. Fix and re-run:"
  err "  apt-get install -y $TSS2_PKGS && droplet-luks-provision.sh provision"
  exit 2
}

_mapper_active() {
  # Prefer findmnt on the mount target (test-observable); fall back to the node.
  if findmnt -n -o SOURCE "$DATA_MOUNT" >/dev/null 2>&1; then return 0; fi
  [ -e "$MAPPER_DEV" ]
}

# _unlock_verified — did an unlock actually succeed? True iff the mapper is now
# an active dm device (the container opened). Used on the existing-LUKS re-run
# path (finding 5) to refuse wiring boot config for a container with no working
# keyslot. `cryptsetup status <mapper>` is the authoritative check; fall back to
# the mapper device node so the hermetic harness (stubbed cryptsetup) can drive
# both the opened and the no-keyslot outcomes.
_unlock_verified() {
  if "$CRYPTSETUP" status "$MAPPER" >/dev/null 2>&1; then return 0; fi
  [ -e "$MAPPER_DEV" ]
}

# _attach_unlock — WARP-2100: try the TPM attach, then the plain-keyslot open,
# without EVER blocking on an interactive prompt. droplet-firstboot hung
# forever here: a failed TPM unseal made systemd-cryptsetup queue an
# ask-password prompt no one on a headless appliance can answer. Three guards,
# all needed:
#   headless=true,tries=1  crypttab-style options in the attach OPTIONS
#                          argument (same slot as tpm2-device=auto):
#                          headless= stops the ask-password agent prompt being
#                          queued at all — the agent protocol is socket-based
#                          (/run/systemd/ask-password), so closing stdin alone
#                          would NOT stop it;
#   timeout                hard outer bound, in case a prompt still slips
#                          through (an older systemd warns on unknown crypttab
#                          options and continues);
#   </dev/null             the bare `cryptsetup open` fallback reads the
#                          passphrase from stdin — give it EOF instead of the
#                          inherited firstboot console.
# A failed/timed-out unlock still falls through (|| true) exactly as before:
# the callers (_unlock_verified refusal / blkid+mkfs) decide what an un-opened
# mapper means.
_attach_unlock() {
  timeout "$UNLOCK_TIMEOUT" "$SYSTEMD_CRYPTSETUP" attach "$MAPPER" "$LV_DEV" - \
      tpm2-device=auto,headless=true,tries=1 </dev/null 2>/dev/null \
    || timeout "$UNLOCK_TIMEOUT" "$CRYPTSETUP" open "$LV_DEV" "$MAPPER" \
      </dev/null 2>/dev/null \
    || true
}

# _report_pending_prompts — WARP-2100 diagnostic: after a failed unlock,
# surface any ask-password prompt left queued (the smoking gun for "the unlock
# wanted a passphrase nobody on a headless appliance can type").
_report_pending_prompts() {
  local pending
  pending="$(ls "$ASK_PASSWORD_DIR" 2>/dev/null | tr '\n' ' ' || true)"
  case "$pending" in
    *[![:space:]]*)
      err "pending systemd ask-password prompt(s) queued: $pending"
      err "— the unlock asked for an interactive passphrase; this box is"
      err "headless, so nothing can answer it (inspect with"
      err "systemd-tty-ask-password-agent --list). (WARP-2100)"
      ;;
  esac
}

_has_free_extents() {
  local free
  free="$("$VGS" --noheadings -o vg_free_count "$VG" 2>/dev/null | tr -d ' ' || echo 0)"
  [ -n "$free" ] && [ "$free" != "0" ] 2>/dev/null
}

_append_if_absent() { # $1=file $2=match $3=line
  local file="$1" match="$2" line="$3"
  mkdir -p "$(dirname "$file")"
  if [ -f "$file" ] && grep -qF "$match" "$file" 2>/dev/null; then
    return 0
  fi
  printf '%s\n' "$line" >> "$file"
}

cmd_provision() {
  # Production is Linux-only. The hermetic harness sets DROPLET_LUKS_SKIP_OS_GATE=1
  # so the stubbed drill can exercise the full flow on any OS (macOS CI/dev).
  if [ "${DROPLET_LUKS_SKIP_OS_GATE:-0}" != "1" ] && [ "$(uname)" != "Linux" ]; then
    log "not Linux — skipping LUKS data-partition provisioning"
    return 0
  fi
  _require_tpm

  # Idempotency: already unlocked + mounted → no storage work. The daemon.json
  # check still runs (WARP-2102): the fresh-provision path below was the ONLY
  # caller of _maybe_write_docker_data_root, so an already-provisioned box
  # could never receive the containerd-snapshotter pin on a setup.sh re-run —
  # exactly the fleet that needs it.
  if _mapper_active; then
    log "$MAPPER already active / $DATA_MOUNT mounted — storage already provisioned"
    _maybe_write_docker_data_root
    return 0
  fi

  # If the LUKS LV already exists but is locked, just open + mount it.
  #
  # WARP-232 (finding 5): a power cut BETWEEN luksFormat and the keyslot enrolls
  # (below) leaves a LUKS2 container with ZERO usable keyslots — the tmpfs
  # install keyfile is gone on reboot, and neither the TPM nor the recovery slot
  # was ever added. The old re-run path attached/opened with `|| true` and wrote
  # crypttab/fstab REGARDLESS, so the box booted into a permanent mount failure
  # with NO recovery key in existence — bricked. Now: VERIFY a working unlock
  # path (the mapper actually opened) BEFORE writing any boot config. If nothing
  # unlocks, refuse LOUDLY and leave the box bootable (no crypttab/fstab entry
  # for a container we can't open, so /data just stays absent → docker gate).
  if [ -e "$LV_DEV" ] && "$CRYPTSETUP" isLuks "$LV_DEV" 2>/dev/null; then
    log "existing LUKS container at $LV_DEV — opening (no re-format)"
    _attach_unlock
    if ! _unlock_verified; then
      _report_pending_prompts
      err "existing LUKS container at $LV_DEV has NO working unlock path — it"
      err "did not open via the TPM token or any keyslot. This is the classic"
      err "power-cut-mid-provision state (luksFormat completed but no keyslot"
      err "was enrolled). REFUSING to wire crypttab/fstab for an unopenable"
      err "device — that would brick the NEXT boot with no recovery key."
      err "Recover with the OFFLINE recovery key, or (if this LV holds no data"
      err "yet — first boot) wipe it and re-provision:"
      err "  cryptsetup luksErase $LV_DEV && droplet-luks-provision.sh provision"
      err "See docs/security/at-rest-encryption.md (power-cut recovery)."
      exit 2
    fi
    _mount_and_wire
    _maybe_write_docker_data_root
    return 0
  fi

  if ! _has_free_extents; then
    err "volume group $VG has no free extents — cannot create the data LV."
    err "Pre-WARP-232 images used the whole-disk lvm layout; encrypted-at-rest for such"
    err "boxes arrives via reflash/migration (docs/security/at-rest-encryption.md)."
    exit 2
  fi

  # WARP-2101: the TPM enroll below needs a working tss2 USERSPACE, not just
  # /dev/tpm0. Gate BEFORE creating anything (self-heals via apt; hard exit 2
  # otherwise). Skipped when no TPM is present — the ALLOW_NO_TPM dev path
  # never calls cryptenroll with --tpm2-device.
  if droplet_tpm_present; then
    _require_tpm2_userspace
  fi

  mkdir -p "$RUNTIME_DIR"; chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
  local keyfile="$RUNTIME_DIR/.luks-key.$$"
  # Temp install keyfile lives in the tmpfs runtime dir only; removed below.
  ( umask 077 && openssl rand 64 > "$keyfile" )

  log "creating data LV from free extents: $LV in $VG"
  "$LVCREATE" -l 100%FREE -n "$LV" "$VG"

  log "formatting LUKS2/Argon2id on $LV_DEV"
  "$CRYPTSETUP" luksFormat --type luks2 --pbkdf argon2id --batch-mode \
    --key-file "$keyfile" "$LV_DEV"

  # WARP-2101: enroll the RECOVERY keyslot FIRST, before the TPM keyslot. Any
  # abort inside the TPM enroll (userspace regression, TPM wedge, power cut)
  # then leaves a container whose recovery key already exists and was already
  # shown — never the zero-keyslot stranded state (the tmpfs install keyfile
  # is no keyslot that survives a reboot).
  log "enrolling recovery keyslot — the key is shown ONCE below"
  local recovery
  recovery="$("$CRYPTENROLL" --unlock-key-file="$keyfile" --recovery-key "$LV_DEV")"
  printf '\n=== STORE THIS RECOVERY KEY OFFLINE — IT IS SHOWN ONCE ===\n'
  printf '%s\n' "$recovery"
  printf '=== (never written to disk; see docs/security/at-rest-encryption.md) ===\n\n'

  # WARP-232 (finding 6): the TPM enroll must be SKIPPED on a TPM-less dev box
  # running with DROPLET_LUKS_ALLOW_NO_TPM=1 — `systemd-cryptenroll
  # --tpm2-device=auto` fails hard with no TPM and (under set -e) would abort
  # the provision. When the flag is set and no TPM is present, enroll ONLY the
  # recovery key (above) so the dev box still has a durable unlock path.
  if droplet_tpm_present; then
    log "enrolling TPM2 keyslot (PCRs $(droplet_tpm_pcrs))"
    "$CRYPTENROLL" --unlock-key-file="$keyfile" --tpm2-device=auto \
      --tpm2-pcrs="$(droplet_tpm_pcrs)" "$LV_DEV"
  else
    log "DROPLET_LUKS_ALLOW_NO_TPM=1 + no TPM — SKIPPING the TPM2 keyslot (DEV ONLY)."
    log "  The data partition is NOT TPM-sealed; only the recovery key unlocks it."
  fi

  log "removing the temporary install keyslot"
  "$CRYPTSETUP" luksRemoveKey "$LV_DEV" "$keyfile"
  rm -f "$keyfile"

  log "opening $MAPPER and formatting the filesystem"
  _attach_unlock
  if ! blkid -o value -s TYPE "$MAPPER_DEV" 2>/dev/null | grep -q ext4; then
    "$MKFS" -L droplet-data "$MAPPER_DEV"
  fi
  _mount_and_wire
  _maybe_write_docker_data_root
  log "provisioned encrypted data partition at $DATA_MOUNT"
}

_mount_and_wire() {
  # The mountpoint dir + the mount itself are best-effort: on a real box they
  # succeed; the crypttab/fstab wiring below is what makes /data come up on the
  # NEXT boot regardless, and the hermetic harness has no real /data.
  mkdir -p "$DATA_MOUNT" 2>/dev/null || true
  "$MOUNT" "$MAPPER_DEV" "$DATA_MOUNT" 2>/dev/null || true

  # crypttab: auto-unlock via the TPM2 header token. `nofail` so a PCR mismatch
  # (TPM refuses to release the key) does NOT fail the cryptsetup unit hard and
  # cascade into local-fs.target; the device-timeout bounds the wait.
  # `headless=true` (WARP-2100) so a failed unseal at boot NEVER queues an
  # ask-password passphrase prompt on a box with no console operator.
  _append_if_absent "$CRYPTTAB" "$MAPPER" \
    "$MAPPER $LV_DEV none tpm2-device=auto,luks,discard,nofail,headless=true,x-systemd.device-timeout=30s"
  # fstab: mount /data with `nofail` + a bounded device timeout. `nofail` is the
  # crux of finding 3: WITHOUT it, a locked /data (PCR mismatch on a headless
  # box) makes the mount a HARD requirement of local-fs.target → local-fs fails
  # → the box drops to emergency.target with NO network and NO SSH, so the
  # documented PCR-mismatch runbook (which SSHes in and unlocks with the
  # recovery key) is unreachable. WITH nofail the mount is best-effort: a locked
  # /data just stays absent, the box boots DEGRADED (network + SSH up), and the
  # docker `RequiresMountsFor=/data` gate below keeps every data-bearing
  # container down until an operator unlocks. `noauto` is deliberately NOT set —
  # we still WANT the auto-mount attempt on a healthy boot; nofail only removes
  # the boot-blocking hard dependency. fsck pass 0: a nofail encrypted mount
  # should not gate boot on an fsck of a device that may not be present.
  _append_if_absent "$FSTAB" "$DATA_MOUNT ext4" \
    "$MAPPER_DEV $DATA_MOUNT ext4 defaults,nofail,x-systemd.device-timeout=30s 0 0"
  # docker fail-closed gate: no /data ⇒ docker (and every data-bearing
  # container) refuses to start = "falls to recovery" on a PCR mismatch.
  mkdir -p "$DOCKER_DROPIN_DIR"
  if [ ! -f "$DOCKER_DROPIN" ]; then
    printf '[Unit]\n# WARP-232: docker must not start without the encrypted /data mount.\nRequiresMountsFor=/data\n' \
      > "$DOCKER_DROPIN"
  fi
}

_maybe_write_docker_data_root() {
  local daemon_json="$ETC_DIR/docker/daemon.json"
  if [ -f "$daemon_json" ]; then
    _merge_containerd_snapshotter_pin "$daemon_json"
    return 0
  fi
  mkdir -p "$(dirname "$daemon_json")"
  # WARP-2102: data-root ALONE is not enough. Docker >= 28 can serve images
  # from the containerd image store (features.containerd-snapshotter), whose
  # root is /var/lib/containerd — daemon.json data-root does NOT govern it,
  # so every image byte silently lands on the plain root LV (the bench box's
  # 63G root hit 92%) while /data/docker sits empty. Pin the snapshotter OFF
  # so the classic store — and with it data-root — governs the whole store.
  printf '{\n  "data-root": "/data/docker",\n  "features": {\n    "containerd-snapshotter": false\n  }\n}\n' > "$daemon_json"
  log "wrote $daemon_json (docker data-root on the encrypted /data; containerd image store pinned off — WARP-2102)"
}

# _merge_containerd_snapshotter_pin FILE — WARP-2102, the existing-file half.
# The old early-return ("leaving docker data-root alone") meant a box whose
# daemon.json predates this fix could NEVER receive the snapshotter pin here,
# so a Docker >= 28 install kept writing images to /var/lib/containerd on the
# plain root forever. Merge ONLY features.containerd-snapshotter=false, and
# only when the key is absent:
#   * data-root is never touched on an existing file — moving a live store is
#     the operator-driven --migrate-data runbook (docs/security/
#     at-rest-encryption.md), not an unattended provision re-run;
#   * an explicit operator value (true or false) is respected — `true` gets a
#     loud warning, because that store lives OUTSIDE the LUKS boundary;
#   * the merge must never corrupt the file dockerd boots from: back it up
#     first, rewrite via python3 json (the box's JSON tool — no jq host dep,
#     same as droplet-collect-logs.sh), re-parse the rewrite before it
#     replaces the live file, and restore the backup on any failure.
_merge_containerd_snapshotter_pin() {
  local daemon_json="$1" py backup verdict
  py="$(command -v python3 || true)"
  if [ -z "$py" ]; then
    log "WARNING: existing $daemon_json but no python3 — cannot merge the containerd-snapshotter"
    log "WARNING: pin (WARP-2102). Docker >= 28 may store images on the PLAIN root. Add manually:"
    log "WARNING:   \"features\": { \"containerd-snapshotter\": false }"
    return 0
  fi
  backup="${daemon_json}.warp2102-bak"
  cp -p "$daemon_json" "$backup"
  if verdict="$(DAEMON_JSON="$daemon_json" "$py" - <<'PYEOF'
import json, os, sys
path = os.environ["DAEMON_JSON"]
with open(path) as fh:
    cfg = json.load(fh)
if not isinstance(cfg, dict):
    raise SystemExit("daemon.json is not a JSON object")
features = cfg.setdefault("features", {})
if not isinstance(features, dict):
    raise SystemExit("daemon.json features is not a JSON object")
if "containerd-snapshotter" in features:
    print("kept:%s" % json.dumps(features["containerd-snapshotter"]))
    raise SystemExit(0)
features["containerd-snapshotter"] = False
tmp = path + ".warp2102-tmp"
with open(tmp, "w") as fh:
    json.dump(cfg, fh, indent=2)
    fh.write("\n")
with open(tmp) as fh:  # the rewrite must re-parse before it replaces the live file
    json.load(fh)
os.replace(tmp, path)
print("merged:%s" % json.dumps(cfg.get("data-root")))
PYEOF
  )"; then
    case "$verdict" in
      merged:*)
        log "added features.containerd-snapshotter=false to existing $daemon_json (WARP-2102;"
        log "  backup at $backup). Restart docker to apply. If this box already ran Docker >= 28"
        log "  with the containerd store, existing images become INVISIBLE after the restart (the"
        log "  classic and containerd stores share nothing) — re-pull, or docker save/load first."
        if [ "$verdict" != 'merged:"/data/docker"' ]; then
          log "NOTE: data-root in $daemon_json is not /data/docker — left alone (see --migrate-data runbook)"
        fi
        ;;
      kept:false)
        rm -f "$backup"
        log "existing $daemon_json already pins containerd-snapshotter=false — nothing to do"
        ;;
      kept:*)
        rm -f "$backup"
        log "WARNING: $daemon_json explicitly sets containerd-snapshotter=${verdict#kept:} — respecting"
        log "WARNING: the operator's choice, but the containerd image store IGNORES data-root: images"
        log "WARNING: live on the PLAIN root LV, outside the LUKS boundary (WARP-2102)."
        ;;
    esac
  else
    cp -p "$backup" "$daemon_json" 2>/dev/null || true
    log "WARNING: could not merge the containerd-snapshotter pin into $daemon_json (unparseable"
    log "WARNING: JSON?) — file restored/left as it was (backup at $backup). Fix the JSON by hand,"
    log "WARNING: then re-run provision (WARP-2102)."
  fi
}

cmd_status() {
  local encrypted=false mounted=false tpm_enrolled=false
  if [ -e "$LV_DEV" ] && "$CRYPTSETUP" isLuks "$LV_DEV" 2>/dev/null; then encrypted=true; fi
  if _mapper_active; then mounted=true; fi
  if [ -e "$LV_DEV" ] && "$CRYPTSETUP" luksDump "$LV_DEV" 2>/dev/null | grep -qi 'systemd-tpm2'; then
    tpm_enrolled=true
  fi
  printf '{"encrypted":%s,"mounted":%s,"tpm_enrolled":%s}\n' "$encrypted" "$mounted" "$tpm_enrolled"
}

case "${1:-}" in
  provision) cmd_provision ;;
  status)    cmd_status ;;
  -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) err "usage: droplet-luks-provision.sh {provision|status}"; exit 2 ;;
esac
