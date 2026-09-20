#!/usr/bin/env bash
# =============================================================================
# Droplet — factory-reset wipe of the LIVE secrets on /data (WARP-2629)
# =============================================================================
#
# THE DEFECT
#
# Since the WARP-232 relocation, the real `.env` lives at
# `/data/droplet/env/.env` and the audit / doc-KEK keys at
# `/data/droplet/secrets/` (`scripts/lib/luks.sh:116`), with SYMLINKS left
# behind at `<repo>/.env` and `<repo>/data/secrets`. `factory-reset.sh` removed
# the symlinks — and `rm` on a symlink unlinks the LINK, never the target. So
# every generated secret survived a "factory reset" on a relocated box:
# `DEVICE_SECRET_KEY` (the HKDF input for the restic repo password, the USB
# per-drive recovery slots and the doc-KEK recovery path), the audit signing
# key, `doc-kek.key`, and every `.env.bak.*` / `.env.torn.*` snapshot beside
# them. Nothing else picked them up: `scripts/lib/storage-wipe.sh` covers only
# the bulk drives adopted under `/mnt/droplet`, never the `/data` LUKS mount.
#
# The product is a 2-year hardware LEASE. A rack that was factory-reset and
# then returned or re-provisioned was still carrying the previous tenant's
# keys. That is what this library closes.
#
# WHAT THIS DOES (option 1 of the ticket — wipe)
#
#   1. overwrite-then-unlink the live `.env` at the RESOLVED target
#   2. the same for every snapshot / staging sibling beside it
#      (`.bak.*`, `.torn.*`, `.tmp.*`, `.migrate.*`, `.upsert.*`)
#   3. the same for every file under the resolved `data/secrets`
#   4. re-create both containers EMPTY with the ownership/mode
#      `relocate_secrets_to_data` establishes (install user, dirs 0750 —
#      `scripts/lib/luks.sh:109-114`), so the next `setup.sh` regenerates into
#      a tree it can traverse instead of one root owns
#
# Idempotent: a second run finds nothing and is a no-op. It needs no Docker,
# no network and no root on a normally-relocated box (the containers are owned
# by the install user); `SECW_SUDO` is the fallback for a tree an earlier
# privileged run left root-owned.
#
# WHY OVERWRITE-THEN-UNLINK, AND WHAT IT IS WORTH
#
# `rm` only unlinks; the blocks stay carveable off a pulled disk. `shred -u`
# overwrites in place first, and where `shred` is absent (it is not in the
# macOS base system) the fallback is one zero pass with `dd conv=notrunc` —
# same extents, then unlink.
#
# `/data` is **ext4** on LUKS2 (`scripts/host/droplet-luks-provision.sh:43`,
# `:352`), so a single in-place pass really does land on the file's own
# blocks — ext4 is not log-structured. It still cannot reach blocks the
# filesystem already relocated, journal copies, or blocks the SSD FTL has
# remapped (`/data` is mounted with `discard`). This is residual-reduction on
# top of an already-encrypted volume, not a forensic guarantee — the same
# caveat `relocate_secrets_to_data` and `docs/security/at-rest-encryption.md`
# already state for the relocation's own shred.
#
# WHY NOT RE-KEY THE LUKS VOLUME (option 2 of the ticket)
#
# Destroying the `/data` keyslots (`cryptsetup luksErase` + a TPM re-seal, then
# re-format and re-provision) is strictly stronger: it makes EVERY byte on the
# volume unrecoverable, including anything a future writer forgets to add to
# the list above — this library is a list, and lists rot. It is also a much
# bigger operation: the volume has to be re-formatted and re-provisioned, the
# TPM sealing hierarchy re-sealed, and a reset would stop being something that
# can run unattended and still leave a bootable box. That is Romain's call, not
# an agent's — the wipe here closes the leak now. The destroy-the-key path
# already exists for decommissioning: `scripts/host/droplet-crypto-shred.sh`
# and `docs/security/crypto-shred.md`.
#
# THE POST-WIPE GATE (WARP-2638)
#
# `secw_wipe_live_secrets` reports what it could not remove and carries on, so
# a survivor was a warning the transcript scrolled past. The volume phase does
# not work that way: `_remaining_owned_volumes` re-enumerates from Docker and
# REFUSES to finish while an owned volume is still there. Given the failure
# mode here — hand a leased rack back carrying the previous tenant's
# `DEVICE_SECRET_KEY` — the secrets wipe now gets the same treatment.
#
# `secw_verify_wipe` re-lists every class the wipe owns (the resolved `.env`,
# its five snapshot/staging classes, everything under the resolved secrets dir,
# and the link-side `.env*` / `data/secrets` classes on the boot disk) and
# reports the survivors in SECW_LEFTOVER_PATHS. It re-scans the filesystem
# rather than trusting the counters the wipe itself set — a gate that reads the
# wiper's own bookkeeping only proves the wiper is self-consistent.
#
# PATHS ONLY, never contents (rule 19): the whole point of the line is that an
# operator learns a secret survived, and printing it would defeat the change.
# It needs no Docker and no root, so it runs on the box a reset actually runs
# on — a box whose daemon is down.
#
# Test seams (mirroring `SW_*` in `storage-wipe.sh`): SECW_SUDO, SECW_OWNER,
# SECW_DIR_MODE, SECW_REPO_ROOT. `tests/factory-reset-secrets-wipe.test.sh`
# drills the whole path against a fixture tree with no Docker and no root.
# =============================================================================

SECW_SUDO="${SECW_SUDO-sudo}"
# The user:group `relocate_secrets_to_data` owns the /data containers by (its
# own default is the install user, `DROPLET_RELOCATE_OWNER` being its seam).
SECW_OWNER="${SECW_OWNER-$(id -un):$(id -gn)}"
SECW_DIR_MODE="${SECW_DIR_MODE:-0750}"
# Used ONLY to tell a relocated container apart from a repo-side path, so the
# re-create step never chmods anything inside the checkout.
SECW_REPO_ROOT="${SECW_REPO_ROOT:-${REPO_ROOT:-}}"

# Set by secw_wipe_live_secrets. Counts only — never a value (rule 19).
SECW_WIPED_ENV=0
SECW_WIPED_SNAPSHOTS=0
SECW_WIPED_SECRETS=0
SECW_WIPED_COUNT=0
SECW_FAILED_COUNT=0

# WARP-2621 — recorded by secw_wipe_live_secrets BEFORE it touches anything,
# and consumed by secw_verify_wipe. 1 means the directory the .env lives in was
# not there when the wipe started, which on a relocated box means the /data
# volume was not mounted. It has to be captured pre-wipe: step (4) re-creates
# the containers, after which "wiped" and "was never reachable" are the same
# empty tree and no amount of re-scanning can tell them apart.
SECW_ENV_CONTAINER_MISSING=0

# Set by secw_verify_wipe. Paths only — never contents (rule 19).
SECW_LEFTOVER_PATHS=""
SECW_LEFTOVER_COUNT=0
# BLOCKED is a THIRD verdict, distinct from both pass and "a secret survived":
# the gate could not observe the volume at all. For a secrets wipe it has to be
# treated as failure, but the operator needs to be told which one it was — one
# says "shred it again", the other says "unlock the volume".
SECW_VERIFY_BLOCKED=0
# shellcheck disable=SC2034  # read by factory-reset.sh's gate, not in this file
SECW_VERIFY_BLOCKED_REASON=""

_secw_warn() { printf '  ! %s\n' "$*" >&2; }

# secw_volume_unreachable <repo-root> <resolved-env-target>
#
# 0 (true) when <repo-root>/.env is a SYMLINK whose target lives in a directory
# that does not exist — i.e. the box HAS been relocated onto /data, but /data is
# not mounted (TPM unlock failed, or the LUKS volume is still locked).
#
# That state is invisible to everything downstream: `readlink -f` fails on a
# path whose parent chain is missing, so factory-reset.sh's fallback yields the
# raw link text; the wipe then finds nothing at every path and reports zero
# wiped AND zero failed. A reset must refuse rather than shred nothing and say
# so — the previous tenant's keys are intact on the locked volume.
#
# Deliberately keyed on the SYMLINK, not on "the directory is missing":
#   - on a never-relocated box .env is a plain file and its directory is the
#     checkout, which is always present — so this can never fire there;
#   - after a normal wipe the container is re-created, so a second reset on the
#     same box does not fire either (the reset stays idempotent).
# It is NOT keyed on data/secrets: that container can legitimately be absent on
# a box whose setup never generated one, and a false abort here would refuse to
# reset a healthy appliance.
secw_volume_unreachable() {
  local _repo="$1" _env_target="$2"
  [ -n "$_repo" ] && [ -n "$_env_target" ] || return 1
  [ -L "$_repo/.env" ] || return 1
  [ -d "$(dirname "$_env_target")" ] && return 1
  return 0
}

# _secw_try <cmd...> — run it as us; retry under $SECW_SUDO only if that failed
# AND a sudo command is configured. Keeps the whole library usable unprivileged.
_secw_try() {
  if "$@" >/dev/null 2>&1; then
    return 0
  fi
  [ -n "$SECW_SUDO" ] || return 1
  $SECW_SUDO "$@" >/dev/null 2>&1
}

# secw_shred_file <path> — overwrite-then-unlink one secrets-bearing file.
# Returns 0 when the path is gone (including "was never there"), 1 when it
# survived. Never prints the file's contents.
secw_shred_file() {
  local _f="$1" _sz _blocks
  [ -f "$_f" ] || return 0

  if command -v shred >/dev/null 2>&1 && _secw_try shred -u "$_f"; then
    return 0
  fi

  # Fallback: one zero pass over the file's OWN blocks (`conv=notrunc` keeps
  # the extents — truncating first would free them and overwrite nothing),
  # then unlink.
  _sz="$(wc -c < "$_f" 2>/dev/null || printf '0')"
  _sz="${_sz//[![:digit:]]/}"
  if [ -n "$_sz" ] && [ "$_sz" -gt 0 ]; then
    _blocks=$(( (_sz + 4095) / 4096 ))
    _secw_try dd if=/dev/zero "of=$_f" bs=4096 "count=$_blocks" conv=notrunc || true
  fi
  _secw_try rm -f "$_f" || true
  [ ! -e "$_f" ]
}

# _secw_recreate_dir <dir> — leave the container present, EMPTY, and owned the
# way relocate_secrets_to_data leaves it. Repo-side paths are skipped: on a
# non-relocated box those belong to setup.sh, and Phase 4's existing
# `rm -rf data/secrets` must find nothing put back.
_secw_recreate_dir() {
  local _d="$1" _parent
  [ -n "$_d" ] || return 0
  if [ -n "$SECW_REPO_ROOT" ]; then
    case "$_d" in
      "$SECW_REPO_ROOT" | "$SECW_REPO_ROOT"/*) return 0 ;;
    esac
  fi
  # WARP-2621 — the PARENT has to already exist. `mkdir -p /data/droplet/env`
  # on a box whose /data is not mounted happily builds the whole chain on the
  # ROOT filesystem, underneath the mountpoint: it destroys the one structural
  # signal that the volume was unreachable, and it does so under a path the
  # next successful mount SHADOWS, so nothing can find it afterwards either.
  # Re-creating a container whose parent is present is the legitimate case
  # (relocate_secrets_to_data made /data/droplet and the wipe only emptied the
  # leaf); conjuring the tree never is.
  _parent="$(dirname "$_d")"
  if [ ! -d "$_parent" ]; then
    _secw_warn "not re-creating $_d — $_parent does not exist, so the volume behind it is not mounted"
    return 0
  fi
  _secw_try mkdir -p "$_d" || { _secw_warn "could not re-create $_d"; return 0; }
  if [ -n "$SECW_OWNER" ]; then
    _secw_try chown "$SECW_OWNER" "$_d" || true
  fi
  _secw_try chmod "$SECW_DIR_MODE" "$_d" || true
}

# _secw_wipe_one <path> — shred one file and account for it in the totals.
# Returns 0 when a file was actually wiped, 1 when it was absent or survived,
# so the caller can bump its own per-class counter.
_secw_wipe_one() {
  local _f="$1"
  [ -f "$_f" ] || return 1
  if secw_shred_file "$_f"; then
    SECW_WIPED_COUNT=$(( SECW_WIPED_COUNT + 1 ))
    return 0
  fi
  SECW_FAILED_COUNT=$(( SECW_FAILED_COUNT + 1 ))
  # Path only. The point of this line is that an operator learns a secret
  # SURVIVED the reset — printing the secret would defeat the whole change.
  _secw_warn "could not remove $_f — it still carries device secrets"
  return 1
}

# secw_wipe_live_secrets <env-target> <secrets-dir>
#
#   <env-target>  the ALREADY-RESOLVED .env — `/data/droplet/env/.env` on a
#                 relocated box, `<repo>/.env` otherwise. This function never
#                 resolves a symlink itself: the caller owns that, so there is
#                 exactly one resolution per reset.
#   <secrets-dir> the ALREADY-RESOLVED data/secrets directory.
#
# Always returns 0 — a reset that aborts half-way is worse than one that
# reports what it could not remove. Read SECW_FAILED_COUNT for that.
secw_wipe_live_secrets() {
  local _env_target="$1" _secrets_dir="$2"
  local _f

  SECW_WIPED_ENV=0
  SECW_WIPED_SNAPSHOTS=0
  SECW_WIPED_SECRETS=0
  SECW_WIPED_COUNT=0
  SECW_FAILED_COUNT=0

  # WARP-2621 — observe the container BEFORE anything below can create it.
  # Step (4) re-creates the containers, so after this function returns there is
  # no way left to tell "the wipe emptied it" from "the volume was never
  # mounted". secw_verify_wipe consumes this rather than re-deriving it.
  SECW_ENV_CONTAINER_MISSING=0
  [ -d "$(dirname "$_env_target")" ] || SECW_ENV_CONTAINER_MISSING=1

  # (1) the live .env — every generated device secret.
  if _secw_wipe_one "$_env_target"; then
    SECW_WIPED_ENV=$(( SECW_WIPED_ENV + 1 ))
  fi

  # (2) its snapshot + staging siblings. Each is a COMPLETE copy of the same
  # secrets (WARP-2624 moved them here); the globs are that PR's.
  for _f in "$_env_target".bak.* \
            "$_env_target".torn.* \
            "$_env_target".tmp.* \
            "$_env_target".migrate.* \
            "$_env_target".upsert.*; do
    if _secw_wipe_one "$_f"; then
      SECW_WIPED_SNAPSHOTS=$(( SECW_WIPED_SNAPSHOTS + 1 ))
    fi
  done

  # (3) the secrets dir: audit signing key (WARP-456), doc-kek.key (WARP-242),
  # and anything else generated in there. Files first, so the container itself
  # can be left in place and re-created empty below.
  if [ -d "$_secrets_dir" ]; then
    while IFS= read -r _f; do
      [ -n "$_f" ] || continue
      if _secw_wipe_one "$_f"; then
        SECW_WIPED_SECRETS=$(( SECW_WIPED_SECRETS + 1 ))
      fi
    done < <(find "$_secrets_dir" -type f 2>/dev/null || true)
    # Whatever is left (empty subdirs, stray symlinks) is structure, not
    # secrets — unlink it so the container really is empty.
    _secw_try find "$_secrets_dir" -mindepth 1 -delete || true
  fi

  # (4) leave the containers present, empty, and traversable by the install
  # user, so the next setup.sh regenerates straight into them.
  _secw_recreate_dir "$(dirname "$_env_target")"
  _secw_recreate_dir "$_secrets_dir"

  return 0
}

# _secw_record_leftover <path> — append one survivor, de-duplicated. On a
# non-relocated box the resolved target and the link-side path are the SAME
# file, so both passes below would otherwise name it twice.
_secw_record_leftover() {
  case $'\n'"$SECW_LEFTOVER_PATHS"$'\n' in
    *$'\n'"$1"$'\n'*) return 0 ;;
  esac
  SECW_LEFTOVER_PATHS="${SECW_LEFTOVER_PATHS}${SECW_LEFTOVER_PATHS:+$'\n'}$1"
  SECW_LEFTOVER_COUNT=$(( SECW_LEFTOVER_COUNT + 1 ))
}

# secw_verify_wipe <env-target> <secrets-dir> [<repo-root>] [<container-missing-pre-wipe>]
#
# The post-wipe gate (WARP-2638). Re-enumerates the filesystem — it does NOT
# read the counters secw_wipe_live_secrets set, because a gate built on the
# wiper's own bookkeeping only ever proves the wiper agrees with itself.
#
# Returns 0 when every class is empty, 1 otherwise, with the survivors in
# SECW_LEFTOVER_PATHS (one per line) and SECW_LEFTOVER_COUNT. Never prints or
# returns a file's contents (rule 19).
#
# Call it AFTER the reset has purged the link side too, not straight after the
# wipe: the `<repo>/.env.*` classes and `<repo>/data/secrets` are removed by
# factory-reset.sh further down Phase 4, and this checks those as well.
#
# THE ONE THING RE-SCANNING CANNOT DECIDE (WARP-2621). If /data was never
# mounted, every path below is absent for the wrong reason and this gate would
# return PASS over a volume holding an intact DEVICE_SECRET_KEY — the exact
# green verification a leased-box handover must never wear. That fact is only
# observable BEFORE the wipe (step (4) re-creates the containers), so it is an
# INPUT here: 4th argument, defaulting to what secw_wipe_live_secrets recorded.
# When set, no re-scan result can produce a pass.
secw_verify_wipe() {
  local _env_target="$1" _secrets_dir="$2" _repo="${3:-$SECW_REPO_ROOT}"
  local _pre_missing="${4:-$SECW_ENV_CONTAINER_MISSING}"
  local _f

  SECW_LEFTOVER_PATHS=""
  SECW_LEFTOVER_COUNT=0
  SECW_VERIFY_BLOCKED=0
  SECW_VERIFY_BLOCKED_REASON=""

  if [ "$_pre_missing" = "1" ]; then
    SECW_VERIFY_BLOCKED=1
    # shellcheck disable=SC2034  # read by factory-reset.sh's gate, not in this file
    SECW_VERIFY_BLOCKED_REASON="$(dirname "$_env_target") did not exist before the wipe — the volume behind it was not mounted, so an empty re-scan proves nothing about what is on it"
  fi

  # (1)+(2) the resolved .env and every snapshot / staging sibling beside it.
  # An unmatched glob stays literal (no nullglob), and `-e` on the literal is
  # false — so an empty class contributes nothing.
  for _f in "$_env_target" \
            "$_env_target".bak.* \
            "$_env_target".torn.* \
            "$_env_target".tmp.* \
            "$_env_target".migrate.* \
            "$_env_target".upsert.*; do
    if [ -e "$_f" ] || [ -L "$_f" ]; then
      _secw_record_leftover "$_f"
    fi
  done

  # (3) the resolved secrets dir. It is left PRESENT and EMPTY on a relocated
  # box, so the assertion is on its contents, not on the container itself.
  if [ -d "$_secrets_dir" ]; then
    while IFS= read -r _f; do
      [ -n "$_f" ] || continue
      _secw_record_leftover "$_f"
    done < <(find "$_secrets_dir" -mindepth 1 2>/dev/null || true)
  elif [ -e "$_secrets_dir" ] || [ -L "$_secrets_dir" ]; then
    # Not a directory but still there: a stray file, or a symlink the reset
    # left dangling into /data.
    _secw_record_leftover "$_secrets_dir"
  fi

  # (4) the link side, on the UNENCRYPTED boot disk. On a relocated box these
  # are the legacy copies a mid-life upgrade left behind plus the symlinks
  # themselves; on a plain box they are the same files as (1)-(3).
  if [ -n "$_repo" ]; then
    for _f in "$_repo/.env" \
              "$_repo"/.env.bak.* \
              "$_repo"/.env.torn.* \
              "$_repo"/.env.tmp.* \
              "$_repo"/.env.migrate.* \
              "$_repo"/.env.upsert.* \
              "$_repo/data/secrets"; do
      if [ -e "$_f" ] || [ -L "$_f" ]; then
        _secw_record_leftover "$_f"
      fi
    done
  fi

  [ "$SECW_VERIFY_BLOCKED" -eq 0 ] && [ "$SECW_LEFTOVER_COUNT" -eq 0 ]
}
