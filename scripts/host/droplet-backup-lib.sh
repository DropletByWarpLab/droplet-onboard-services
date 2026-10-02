#!/usr/bin/env bash
# =============================================================================
# WARP-254 — shared helpers for the restic backup family
# (droplet-backup.sh / droplet-restore.sh / droplet-restore-drill.sh)
#
# Source this file; do not execute directly. It is installed to
# /usr/local/sbin/droplet-backup-lib.sh alongside the three scripts by
# scripts/lib/backup.sh::install_restic_backup so the sourcing works both from
# a repo checkout and from the installed location.
#
# ── Repository password derivation (STABILITY CONTRACT) ─────────────────────
# The restic repository password is DERIVED from the device identity secret
# DEVICE_SECRET_KEY (the per-device master key setup.sh mints into .env) via
# HKDF-SHA256 (RFC 5869), single-block expand (L=32):
#
#   PRK = HMAC-SHA256(salt = "droplet-restic-v1",                 IKM = DEVICE_SECRET_KEY)
#   OKM = HMAC-SHA256(PRK,   "droplet-restic-repository-password" || 0x01)
#   password = lowercase-hex(OKM)   (64 chars)
#
# DO NOT change the salt, info string, or construction — every restic repo on
# every shipped box is keyed by this exact derivation; drift makes existing
# repos permanently unreadable. tests/restic-backup.test.sh pins it with an
# independent python3 known-answer test.
#
# Deriving (instead of reusing DEVICE_SECRET_KEY directly) keeps the master
# key out of restic's key-derivation surface entirely: what restic sees is a
# one-way image of the master key, rotatable independently in a future
# versioned derivation ("droplet-restic-v2") without touching the master key.
#
# The derived password is never written to a tracked file. It is materialized
# per-invocation into $DROPLET_BACKUP_RUNTIME_DIR (default /run/droplet — a
# root-only tmpfs path that never survives a reboot) at mode 0600 and handed
# to restic via RESTIC_PASSWORD_FILE.
# =============================================================================

# --- Logging (match device-backup.sh convention: repo lib when present) -----
if ! declare -F log_info >/dev/null 2>&1; then
  log_info()    { printf "  [droplet-backup] %s\n" "$*"; }
  log_success() { printf "  [droplet-backup] OK: %s\n" "$*"; }
  log_warn()    { printf "  [droplet-backup] WARN: %s\n" "$*" >&2; }
  log_error()   { printf "  [droplet-backup] ERROR: %s\n" "$*" >&2; }
fi

# =============================================================================
# droplet_backup_resolve_repo_root — echoes the droplet-onboard-services
# checkout root. Precedence:
#   1. $DROPLET_REPO_ROOT      (the systemd units set this via @REPO_ROOT@
#                               substitution at install time)
#   2. script-relative          (running from a checkout: <root>/scripts/host/)
# Fails loudly otherwise — no magic host-specific default paths.
# =============================================================================
droplet_backup_resolve_repo_root() {
  if [ -n "${DROPLET_REPO_ROOT:-}" ]; then
    printf '%s' "$DROPLET_REPO_ROOT"
    return 0
  fi
  # BASH_SOURCE[0] here is the lib; the sourcing script sits next to it. When
  # both live in scripts/host/ the checkout root is two levels up.
  local lib_dir candidate
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  candidate="$(cd "$lib_dir/../.." 2>/dev/null && pwd || true)"
  if [ -n "$candidate" ] && [ -f "$candidate/docker/docker-compose.yml" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  log_error "cannot resolve the droplet-onboard-services checkout root."
  log_error "Set DROPLET_REPO_ROOT=/path/to/droplet-onboard-services (the systemd units do this automatically)."
  return 2
}

# =============================================================================
# droplet_backup_dotenv_value KEY — echoes KEY's value from <repo-root>/.env
# (empty when the file or key is missing). Lets operators configure the
# backup knobs in .env; a same-named environment variable always wins at the
# call sites (the systemd units only set DROPLET_REPO_ROOT).
# =============================================================================
droplet_backup_dotenv_value() {
  local key="$1" root env_file
  root="$(droplet_backup_resolve_repo_root 2>/dev/null)" || return 0
  env_file="$root/.env"
  [ -f "$env_file" ] || return 0
  # `|| true` keeps a missing key from tripping set -euo pipefail callers.
  { grep -E "^${key}=" "$env_file" 2>/dev/null || true; } | head -n 1 | cut -d= -f2-
}

# hex-encode a string's bytes (portable: od is in coreutils + busybox).
_droplet_backup_str_to_hex() {
  printf '%s' "$1" | od -An -v -t x1 | tr -d ' \n'
}

# HMAC-SHA256 over stdin with a hex key; hex digest on stdout. Uses flags
# compatible with OpenSSL 1.1/3.0 (no 3.2-only options — CI runners ship 3.0).
_droplet_backup_hmac_sha256_hex() {
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:$1" | awk '{print $NF}'
}

# =============================================================================
# droplet_backup_derive_password — derived restic password on stdout.
# IKM precedence: $DEVICE_SECRET_KEY env, else DEVICE_SECRET_KEY= from
# <repo-root>/.env. Refuses an empty key.
# =============================================================================
droplet_backup_derive_password() {
  local ikm="${DEVICE_SECRET_KEY:-}"
  if [ -z "$ikm" ]; then
    local root env_file
    root="$(droplet_backup_resolve_repo_root)" || return 2
    env_file="$root/.env"
    if [ -f "$env_file" ]; then
      # `|| true` keeps a missing key from tripping set -euo pipefail callers
      # (grep exits 1 on no match) — the empty-check below is the real gate.
      ikm="$( { grep -E '^DEVICE_SECRET_KEY=' "$env_file" 2>/dev/null || true; } | head -n 1 | cut -d= -f2-)"
    fi
  fi
  if [ -z "$ikm" ]; then
    log_error "DEVICE_SECRET_KEY is empty — cannot derive the restic repository password."
    log_error "Run ./scripts/setup.sh first (it mints the device identity secrets into .env)."
    return 2
  fi

  # HKDF-SHA256, fixed salt + info (see the stability-contract header above).
  local salt_hex prk okm
  salt_hex="$(_droplet_backup_str_to_hex 'droplet-restic-v1')"
  prk="$(printf '%s' "$ikm" | _droplet_backup_hmac_sha256_hex "$salt_hex")"
  # \001 = the HKDF expand block counter (single block, L=32 <= hash length).
  okm="$(printf 'droplet-restic-repository-password\001' | _droplet_backup_hmac_sha256_hex "$prk")"
  if [ -z "$okm" ]; then
    log_error "HKDF derivation produced no output (openssl missing?)"
    return 2
  fi
  printf '%s' "$okm"
}

# =============================================================================
# droplet_backup_prepare_restic_env — derives the password, materializes it at
# a root-only runtime path, and exports:
#   RESTIC_REPOSITORY     from $DROPLET_BACKUP_TARGET (default
#                         /var/lib/droplet/restic-repo — local path on the
#                         data disk; off-device targets are future work)
#   RESTIC_PASSWORD_FILE  runtime password file (0600)
#   RESTIC_CACHE_DIR      under the state dir so the cache lives on the data
#                         disk, not /root/.cache
# =============================================================================
droplet_backup_prepare_restic_env() {
  local runtime_dir="${DROPLET_BACKUP_RUNTIME_DIR:-/run/droplet}"
  local state_dir="${DROPLET_BACKUP_STATE_DIR:-/var/lib/droplet/backup}"
  local pass target

  pass="$(droplet_backup_derive_password)" || return 2

  mkdir -p "$runtime_dir" "$state_dir"
  chmod 700 "$runtime_dir" 2>/dev/null || true
  chmod 700 "$state_dir" 2>/dev/null || true

  # Atomic 0600 write: create with restrictive umask, then rename — the
  # password bytes are never readable by another user, even mid-write.
  local pass_file="$runtime_dir/restic.pass" tmp
  tmp="$pass_file.tmp.$$"
  ( umask 077 && printf '%s' "$pass" > "$tmp" )
  mv "$tmp" "$pass_file"

  # Target precedence: environment > .env (operator knob) > data-disk default.
  target="${DROPLET_BACKUP_TARGET:-}"
  [ -z "$target" ] && target="$(droplet_backup_dotenv_value DROPLET_BACKUP_TARGET)"
  export RESTIC_REPOSITORY="${target:-/var/lib/droplet/restic-repo}"
  export RESTIC_PASSWORD_FILE="$pass_file"
  export RESTIC_CACHE_DIR="$state_dir/cache"
}

# =============================================================================
# droplet_backup_ensure_repo — initializes the restic repository on first use.
#
# THREE states, not two (WARP-2059). `restic cat config` exits non-zero for
# both "no repository here" and "a repository is here but this password does
# not open it". Treating every non-zero exit as "absent" sends the second case
# into `restic init`, which then fails with
#
#     Fatal: create repository at <repo> failed: config file already exists
#
# — a message describing the init attempt rather than the actual fault. It
# reads like missing init-detection, and was misdiagnosed as exactly that.
# The real cause on the box: factory-reset.sh rotated DEVICE_SECRET_KEY (the
# HKDF input the repository password is derived from — see the stability
# contract above) while /var/lib/droplet/restic-repo, which lives on the data
# disk factory-reset does NOT wipe, survived keyed to the OLD secret. Every
# nightly run failed from then on and the existing snapshots were unreadable.
#
# So: probe, then branch on WHY the probe failed. A repository that exists but
# cannot be opened is a hard stop with an actionable message — never an init
# attempt, whose error misdirects. Tolerating "config file already exists" and
# proceeding would not help either: `restic backup` needs the same password
# and would fail a step later, having discarded the one signal that says the
# snapshot history has been orphaned.
# =============================================================================

# Recovery guidance for a present-but-unopenable repository. Deliberately
# advisory: both remedies (restore the old secret / discard the old repo) are
# destructive in opposite directions, so the operator chooses.
#
# Sets DROPLET_BACKUP_KEY_MISMATCH=1 so droplet-backup.sh's exit trap records
# the EXPLICIT `key_mismatch` state (WARP-1405) rather than a generic failure.
DROPLET_BACKUP_KEY_MISMATCH=0
_droplet_backup_log_key_mismatch() {
  DROPLET_BACKUP_KEY_MISMATCH=1
  log_error "A restic repository EXISTS at $RESTIC_REPOSITORY but the password derived"
  log_error "from this device's DEVICE_SECRET_KEY does not open it."
  log_error "restic: ${1:-wrong password or no key found}"
  log_error ""
  log_error "This means the device identity was rotated (factory-reset.sh / a fresh"
  log_error "setup.sh run mints a new DEVICE_SECRET_KEY) while the repository — which"
  log_error "lives on the data disk a factory reset does not wipe — survived, still"
  log_error "keyed to the PREVIOUS secret. Existing snapshots are unreadable until the"
  log_error "old secret is supplied. Refusing to touch the repository."
  log_error ""
  log_error "No .env.bak.* / .env.torn.* beside .env holds a key that opens it, so it"
  log_error "could not be re-keyed automatically (WARP-1405)."
  log_error ""
  log_error "Either recover the old snapshots, if a copy of the previous .env exists"
  log_error "(an .env backup taken before the reset/rotation) — this re-keys the"
  log_error "repository to the current identity and keeps every snapshot:"
  log_error "    sudo DROPLET_REPO_ROOT=<checkout> droplet-backup.sh --rekey-from <old .env>"
  log_error "Or, if this device is intentionally starting a fresh identity and the old"
  log_error "snapshots are expendable, move the stale repository aside so the next run"
  log_error "initializes a new one:"
  log_error "    mv $RESTIC_REPOSITORY $RESTIC_REPOSITORY.orphaned-\$(date +%Y%m%d)"
}

# Case-insensitive substring test, done in-process. NOT `printf | grep -q`:
# grep -q exits on the first match and can SIGPIPE the upstream printf, which
# under `set -o pipefail` makes the pipeline return 141 — a MATCH reported as
# a non-zero (false) status. That failure mode is silent and only shows up on
# the path you least want it on.
_droplet_backup_err_matches() {
  local haystack="${1,,}" needle
  shift
  for needle in "$@"; do
    case "$haystack" in *"$needle"*) return 0 ;; esac
  done
  return 1
}

droplet_backup_ensure_repo() {
  local probe_err init_out rc=0
  probe_err="$(restic cat config 2>&1 >/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    return 0
  fi

  # A repository is present but no key matches. Match on the stable fragments —
  # restic has reworded the surrounding text across versions, but "wrong
  # password" / "no key found" have been constant.
  if _droplet_backup_err_matches "$probe_err" 'wrong password' 'no key found'; then
    # WARP-1405: the identity rotated but the previous key may still be on
    # disk — re-key instead of orphaning the snapshot history.
    if droplet_backup_rekey_from_previous_keys; then
      return 0
    fi
    _droplet_backup_log_key_mismatch "$probe_err"
    return 2
  fi

  log_info "Initializing restic repository at $RESTIC_REPOSITORY..."
  # Belt and braces: if the probe failed for some wording we do not recognize
  # yet, init is still the right next move — but a "config file already
  # exists" from it means the repository was there all along, so surface the
  # same actionable diagnostic rather than restic's misdirecting Fatal.
  rc=0
  init_out="$(restic init 2>&1)" || rc=$?
  # `if`, not `[ -n … ] && printf`: the callers run under `set -e`, where a
  # trailing && whose left side is false makes the whole function return 1.
  if [ -n "$init_out" ]; then
    printf '%s\n' "$init_out"
  fi
  if [ "$rc" -ne 0 ]; then
    if _droplet_backup_err_matches "$init_out" 'config file already exists' 'already initialized'; then
      if droplet_backup_rekey_from_previous_keys; then
        return 0
      fi
      _droplet_backup_log_key_mismatch "$init_out"
      return 2
    fi
    return "$rc"
  fi
  return 0
}

# =============================================================================
# WARP-1405 — KEY LIFECYCLE: a DEVICE_SECRET_KEY rotation re-keys the
# repository instead of orphaning it.
#
# Why re-key rather than a separate, rotation-proof restic secret: the
# repository password deliberately stays a one-way image of DEVICE_SECRET_KEY.
# docs/security/crypto-shred.md (row 3) relies on shredding that one key to
# orphan every snapshot — including off-box targets a factory reset cannot
# delete — and a second, stable secret would need its own shred step, its own
# custody and its own TPM sealing (WARP-1033). Re-keying keeps "one device
# secret, everything derives from it".
#
# How a rotation leaves the old key behind: `setup.sh --regenerate-env` and
# the torn-.env path both copy the previous .env to .env.bak.<epoch> beside the
# RESOLVED .env (WARP-2624) before writing new secrets. A factory reset shreds
# those copies on purpose, so a reset still orphans (= crypto-shreds) the
# repository — exactly as designed. An operator can also hand in an old .env
# explicitly (droplet-backup.sh --rekey-from FILE → DROPLET_BACKUP_REKEY_FROM).
#
# restic keeps ONE master key per repository and wraps it under any number of
# passwords, so re-keying re-encrypts nothing. The sequence is ordered so that
# every intermediate state still opens with at least one key:
#   1. find a candidate old key that opens the repository
#   2. `restic key add` the current derived password (authenticated by the old)
#   3. verify the current password opens the repository
#   4. only then `restic key remove` the OLD key id — a rotation means the old
#      secret must stop working; a failed remove leaves both keys valid (warn)
# NEVER deletes, moves or re-initializes a repository.
# =============================================================================

DROPLET_BACKUP_REKEYED_AT=""

# Candidate files that may hold a previous DEVICE_SECRET_KEY, newest first:
# the operator-supplied file, then .env.bak.* / .env.torn.* beside both the
# .env link and its resolved target (mirrors secrets.sh + factory-reset.sh).
_droplet_backup_previous_env_files() {
  if [ -n "${DROPLET_BACKUP_REKEY_FROM:-}" ]; then
    printf '%s\n' "$DROPLET_BACKUP_REKEY_FROM"
  fi
  local root env target
  root="$(droplet_backup_resolve_repo_root 2>/dev/null)" || return 0
  env="$root/.env"
  target="$env"
  if [ -L "$env" ]; then
    target="$(readlink -f "$env" 2>/dev/null || readlink "$env")"
  fi
  # shellcheck disable=SC2012  # names are ours (.env.bak.<epoch>); ls -t is the point.
  { ls -1t "$env".bak.* "$env".torn.* "$target".bak.* "$target".torn.* 2>/dev/null || true; } \
    | awk '!seen[$0]++'
}

# Echo the current key id of the repository as opened by RESTIC_PASSWORD_FILE.
_droplet_backup_current_key_id() {
  restic key list --json 2>/dev/null \
    | tr '}' '\n' | grep '"current":true' | grep -o '"id":"[0-9a-f]*"' | head -n 1 | cut -d'"' -f4
}

droplet_backup_rekey_from_previous_keys() {
  local current_pass cand key old_pass old_file old_id tried=" " rc
  [ -n "${RESTIC_PASSWORD_FILE:-}" ] || return 1
  current_pass="$(cat "$RESTIC_PASSWORD_FILE" 2>/dev/null)" || return 1
  old_file="$(dirname "$RESTIC_PASSWORD_FILE")/restic.pass.previous"

  while IFS= read -r cand; do
    [ -f "$cand" ] || continue
    key="$( { grep -E '^DEVICE_SECRET_KEY=' "$cand" 2>/dev/null || true; } | head -n 1 | cut -d= -f2-)"
    [ -n "$key" ] || continue
    old_pass="$(DEVICE_SECRET_KEY="$key" droplet_backup_derive_password 2>/dev/null)" || continue
    # Same identity as now, or a key already tried from another copy.
    [ "$old_pass" = "$current_pass" ] && continue
    case "$tried" in *" $old_pass "*) continue ;; esac
    tried="$tried$old_pass "

    ( umask 077 && printf '%s' "$old_pass" > "$old_file" )
    if ! RESTIC_PASSWORD_FILE="$old_file" restic cat config >/dev/null 2>&1; then
      continue
    fi

    log_warn "restic repository $RESTIC_REPOSITORY is keyed to a PREVIOUS DEVICE_SECRET_KEY"
    log_warn "  (found in $(basename "$cand")) — re-keying it to the current identity (WARP-1405)"
    old_id="$(RESTIC_PASSWORD_FILE="$old_file" _droplet_backup_current_key_id)"

    rc=0
    RESTIC_PASSWORD_FILE="$old_file" restic key add --new-password-file "$RESTIC_PASSWORD_FILE" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 0 ] || ! restic cat config >/dev/null 2>&1; then
      rm -f "$old_file"
      log_error "re-key FAILED (restic key add rc=$rc) — repository untouched, still keyed to the previous identity"
      return 1
    fi

    if [ -n "$old_id" ] && restic key remove "$old_id" >/dev/null 2>&1; then
      log_success "re-keyed $RESTIC_REPOSITORY to the current identity; previous key ${old_id:0:8} removed"
    else
      log_warn "re-keyed $RESTIC_REPOSITORY, but could not remove the previous key ${old_id:0:8}"
      log_warn "  — the previous DEVICE_SECRET_KEY still opens it. Remove by hand:"
      log_warn "    restic key list   # then: restic key remove <non-current id>"
    fi
    rm -f "$old_file"
    DROPLET_BACKUP_REKEYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    logger -t droplet-backup -p daemon.warning \
      "restic repository $RESTIC_REPOSITORY re-keyed to the current DEVICE_SECRET_KEY (WARP-1405)" 2>/dev/null || true
    return 0
  done < <(_droplet_backup_previous_env_files)

  rm -f "$old_file"
  return 1
}

# =============================================================================
# WARP-1405 — EXPLICIT backup status for the orchestrator's backup-health job.
#
#   $DROPLET_BACKUP_STATUS_DIR/status.json   (default /var/lib/droplet/backup-status)
#   {
#     "state": "ok" | "failed" | "key_mismatch" | "pending",   ← explicit enum
#     "reason":        why the last attempt failed ("" when ok/pending),
#     "since":         first time this box ever recorded a status (the
#                      window anchor before any success exists),
#     "lastAttemptAt", "lastSuccessAt", "lastFailureAt", "lastRekeyAt": ISO|null
#   }
#
# A dedicated directory — NOT the state dir, which holds the staged pg_dumps —
# because it is bind-mounted read-only into the orchestrator. The file carries
# no secret: timestamps, the enum, and a reason we author (never raw restic
# output, which can echo paths and key ids).
#
# $1 = state, $2 = reason, $3 = "bump" (default) records an attempt; anything
# else rewrites the file without claiming a run happened (--check-key).
# =============================================================================
_droplet_backup_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\t' '  '
}

# Previous value of a string field in the status file ("" when absent/null).
droplet_backup_status_field() {
  local file="${DROPLET_BACKUP_STATUS_DIR:-/var/lib/droplet/backup-status}/status.json"
  [ -f "$file" ] || return 0
  { grep -o "\"$1\": *\"[^\"]*\"" "$file" 2>/dev/null || true; } | head -n 1 | sed 's/^[^:]*: *"\(.*\)"$/\1/'
}

droplet_backup_write_status() {
  local state="$1" reason="${2:-}" bump="${3:-bump}"
  local dir="${DROPLET_BACKUP_STATUS_DIR:-/var/lib/droplet/backup-status}"
  local now since last_attempt last_success last_failure last_rekey tmp
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  since="$(droplet_backup_status_field since)"
  last_attempt="$(droplet_backup_status_field lastAttemptAt)"
  last_success="$(droplet_backup_status_field lastSuccessAt)"
  last_failure="$(droplet_backup_status_field lastFailureAt)"
  last_rekey="${DROPLET_BACKUP_REKEYED_AT:-$(droplet_backup_status_field lastRekeyAt)}"
  since="${since:-$now}"
  if [ "$bump" = "bump" ]; then
    last_attempt="$now"
    case "$state" in
      ok) last_success="$now" ;;
      failed|key_mismatch) last_failure="$now" ;;
    esac
  fi
  _q() { if [ -n "$1" ]; then printf '"%s"' "$(_droplet_backup_json_escape "$1")"; else printf 'null'; fi; }

  mkdir -p "$dir" || return 0
  chmod 755 "$dir" 2>/dev/null || true
  tmp="$dir/status.json.tmp.$$"
  cat > "$tmp" <<STATUS
{
  "schema": 1,
  "state": "$state",
  "reason": "$(_droplet_backup_json_escape "$reason")",
  "since": $(_q "$since"),
  "lastAttemptAt": $(_q "$last_attempt"),
  "lastSuccessAt": $(_q "$last_success"),
  "lastFailureAt": $(_q "$last_failure"),
  "lastRekeyAt": $(_q "$last_rekey"),
  "repository": $(_q "${RESTIC_REPOSITORY:-}")
}
STATUS
  chmod 644 "$tmp"
  mv "$tmp" "$dir/status.json"
}
