#!/usr/bin/env bash
# =============================================================================
# WARP-2099 — NVR recordings-target write-back host executor
# =============================================================================
#
# `NVR_MEDIA_SOURCE` is the one key that decides where Frigate writes 24/7
# camera footage. It is consumed at exactly one seam — the compose volume line
# `- ${NVR_MEDIA_SOURCE:-nvrdata}:/media/frigate` — and until this script
# existed NOTHING anywhere WROTE it. `grep -rn NVR_MEDIA_SOURCE scripts/`
# returned zero. The value could only exist because a human hand-edited .env
# over SSH, and factory-reset.sh correctly deletes .env — so every reset or
# re-image silently reverted recordings to the boot disk with nothing to
# re-establish them.
#
# The fallback is silent BY CONSTRUCTION: `nvrdata` is a bare local named
# volume under Docker's data root on the boot disk, and `:-nvrdata` absorbs an
# unset variable without error. That is how a 2x2 TB RAID1 sat empty for a
# month while `/` climbed to 94%.
#
# This is the WRITER. It does two things and refuses loudly rather than
# guessing:
#
#   1. Validates the requested target, then idempotently writes
#      NVR_MEDIA_SOURCE=<value> into the repo .env via the canonical
#      _upsert_env_kv (scripts/lib/secrets.sh) — symlink-preserving and
#      literal-safe (WARP-2522).
#   2. Recreates the frigate container, because an .env edit does NOT affect a
#      running container. Skipping this leg would be its own silent failure:
#      a successful save with no behaviour change.
#
# Repo-tracked (architecture-guard rule 20) and installed to
# /usr/local/sbin/droplet-set-nvr-media.sh by setup.sh via
# scripts/install-device-bridge.sh — never hand-placed on a box. Removed by
# scripts/factory-reset.sh so a reset truly returns the box to out-of-box.
#
# Usage:
#   droplet-set-nvr-media.sh '/mnt/droplet/pool-1a2b3c4d/nvr'   # bind mount
#   droplet-set-nvr-media.sh 'nvrdata'                          # named volume
#
# ── HARD VALIDATION (reject BEFORE writing) ─────────────────────────────────
#
# Exactly two value shapes are accepted, because compose accepts exactly two:
# a compose-DECLARED volume name, or an ABSOLUTE path. Anything else makes
# `docker compose up` fail on an undefined volume, which would take the whole
# stack down rather than just the cameras.
#
# For an absolute path we do NOT merely test "is it a mountpoint", which is
# what a first reading of the hazard suggests. `/` is itself a mountpoint, and
# so is `/boot` — both would sail through that check while being precisely the
# disks footage must never land on. The invariant that actually matters is
# "does this path live on a DIFFERENT filesystem from the root filesystem",
# so that is what we test, by comparing st_dev. That is strictly stronger than
# a mountpoint test for the real hazard AND it permits the dedicated-subdir
# shape (`<pool>/nvr`) that avoids colliding with the Nextcloud external-
# storage view registered at the pool root.
#
# A non-existent path is refused outright: Docker would create an empty
# directory for a missing bind source and record onto the boot disk anyway —
# the exact silent failure this ticket exists to end.
#
# Test/dev hooks (so validation + upsert are unit-testable without root):
#   DROPLET_NVR_MEDIA_ENV_FILE=...      override the .env path (default <repo>/.env)
#   DROPLET_NVR_MEDIA_COMPOSE_FILE=...  override the compose file consulted for
#                                       declared volume names
#   DROPLET_NVR_MEDIA_ROOT_DEV=...      override the st_dev treated as "the root
#                                       filesystem" (lets a test simulate a box
#                                       without needing a second real device)
#   DROPLET_NVR_MEDIA_SKIP_RECREATE=1   write only; do not touch docker
#
# =============================================================================
# WARP-3514 (ADR-070) — auto-sized, quota-capped recordings slice
# =============================================================================
#
# Camera recordings get a size-capped SLICE of an ENCRYPTED bay drive: an ext4
# PROJECT quota on <mount>/nvr (`chattr +P -p <projid>` + a hard block limit),
# not a repartition. Three modes extend this writer; the legacy positional mode
# above is unchanged except for one small addition (see "ancestry" below).
#
#   droplet-set-nvr-media.sh --status
#       ONE JSON object on stdout; read-only; works UNPRIVILEGED (the sandboxed
#       device-bridge runs it as user `droplet`). Describes the CURRENT target:
#       source/kind, the drive's fsUuid + mount, physical disk + ancestry,
#       isSystemDisk, encrypted, mounted, rw, and (only while the recorded
#       allocation matches the live drive) projectId/limitBytes/usedBytes.
#       Missing tools degrade fields to null/false; it never prints non-JSON.
#
#   droplet-set-nvr-media.sh --apply --fs-uuid <uuid> --mode reserved|full [--limit-bytes N]
#       root. Prepares the slice and RECORDS the target; it does NOT recreate
#       frigate and does NOT move any data (droplet-nvr-migrate.sh does that).
#       Order matters, every step has a test: validate the arguments; find the
#       mount (/mnt/droplet/<tail>); refuse a drive that is read-only, shares a
#       physical disk with the OS (by lsblk ANCESTRY, not by device name), is
#       not LUKS-backed, or is not ext4 mounted with prjquota; size-check the
#       limit; create <mount>/nvr (0700, never through a symlink); chattr +P -p;
#       set the hard limit through the quota tool; VERIFY the quota reads back
#       and is what the bind mount will show (statfs); reserve the Nextcloud side
#       (when <mount>/files exists: project id 4097 with quota = filesystem size
#       - slice - 2 % slack, so files can never eat the recordings slice; `full`
#       needs files/ EMPTY and deregisters it from Nextcloud); then the root-only
#       target record and the droplet-readable storage.json. It does NOT write
#       NVR_MEDIA_SOURCE: ONLY the migration flip does, after the delta copy and
#       verification, with frigate stopped (WARP-3514 decision 2026-10-04) - a
#       prepared-but-unmigrated slice therefore never changes where frigate writes.
#       Re-running with the same arguments is a no-op that still reports success.
#
#   droplet-set-nvr-media.sh --resize <bytes>
#       root. Quota only (same limit checks + read-back verification): no
#       docker, no .env write, no frigate restart.
#
# Output contract (the three modes above, NOT the legacy mode):
#   success   one JSON object, exit 0, quiet stderr:
#               {"ok":true,"operation":"apply","fsUuid":..,"mountPath":..,"source":..,
#                "mode":..,"projectId":N,"limitBytes":N,"previousSource":..,
#                "filesLimitBytes":N|null,"filesDeregistered":bool}
#               {"ok":true,"operation":"resize","limitBytes":N,"usedBytes":N,"projectId":N}
#   refusal   stdout {"ok":false,"code":"<code>","message":"<human>"}, stderr
#             "droplet-set-nvr-media: <human>", exit 1. Messages never carry a
#             drive label, mount path or device path (they travel to the owner).
#             Stable codes: bad_request not_mounted bad_mount read_only os_disk
#             not_encrypted quota_unsupported quota_failed no_allocation
#             below_used exceeds_fs files_not_empty internal
#
# Trust: the .env, the spool dir and everything in it are droplet-writable, so
# they are UNTRUSTED input to this root script (WARP-843): arguments are
# validated with strict regexes/integers BEFORE any tool runs, tools get argv
# arrays (no eval, no string-built commands), the state files are written with
# the hardened atomic pattern of droplet-storage-pool-apply.sh (unlink the tmp,
# O_CREAT|O_EXCL|O_NOFOLLOW 0600, fchown through the fd, mv -T), and every JSON
# value that came from an untrusted place is escaped (a hostile .env value can
# only ever be ONE string value).
#
# State files:
#   $DROPLET_NVR_STATE_DIR/storage.json      last applied allocation, readable by
#                                            the unprivileged --status
#   $DROPLET_NVR_ROOT_STATE_DIR/migration.json   root-only {previousSource,
#                                            newSource, fsUuid, recordedAt}
#
# ancestry (legacy mode): for an absolute path the physical disk(s) behind its
# filesystem are ALSO compared with the OS disk(s) — `/`, `/boot`, `/boot/efi`
# and `/data` resolved through `lsblk -s` down to their TYPE=disk leaves — and a
# match is refused. Only when the ancestry is resolvable (lsblk present and
# answering); the st_dev check above stays the primary guard. While
# DROPLET_NVR_MEDIA_ROOT_DEV simulates a box, the REAL topology of the machine
# running the tests is not what is being simulated, so the check is skipped
# unless DROPLET_NVR_MEDIA_OSDISK also names the OS disks explicitly.
#
# Hooks (all optional; names are shared with the other WARP-3514 scripts/tests):
#   DROPLET_NVR_QUOTA_TOOL=...        executable for quota ops, called as
#                                     `$TOOL set <device> <projid> <hard_bytes>` and
#                                     `$TOOL get <device> <projid>` (prints JSON
#                                     {"hardBytes":N,"usedBytes":N,...}). Default:
#                                     droplet-nvr-quota.py beside this script, else
#                                     /usr/local/sbin/droplet-nvr-quota.py
#   DROPLET_NVR_STATE_DIR=...         dir holding storage.json
#                                     (default /var/lib/droplet-bridge/nvr-spool)
#   DROPLET_NVR_ROOT_STATE_DIR=...    root-only dir holding migration.json
#                                     (default /var/lib/droplet-nvr)
#   DROPLET_NVR_PROJID=...            project id of <mount>/nvr (default 4096)
#   DROPLET_NVR_FILES_PROJID=...      project id of <mount>/files (default 4097)
#   NEXTCLOUD_CONTAINER=...           container whose occ deregisters files/ in
#                                     `full` mode (default droplet-nextcloud-1)
#   DROPLET_NVR_MOUNT_BASE=...        where bay drives are mounted
#                                     (default /mnt/droplet)
#   DROPLET_NVR_MEDIA_STATFS=...      executable printing `<frsize> <blocks> <bfree>
#                                     <bavail>` for the path in $1 (default:
#                                     stat -f -c '%S %b %f %a' -- <path>)
#   DROPLET_NVR_MEDIA_OSDISK=...      space-separated kernel disk names treated as
#                                     the OS disks instead of probing /, /boot,
#                                     /boot/efi and /data
# Tools resolve through PATH (findmnt, lsblk, chattr, stat, python3, docker for
# the legacy recreate only) so tests can shim them; cryptsetup is NOT needed.
# =============================================================================
set -euo pipefail

# Which mode? Only these three flags are new; anything else (including a bad
# `--something`) stays a legacy positional target, exactly as before.
MODE="legacy"
case "${1:-}" in
  --status) MODE="status" ;;
  --apply)  MODE="apply" ;;
  --resize) MODE="resize" ;;
esac

TARGET="${1:-}"

err() { printf 'droplet-set-nvr-media: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# --- Resolve the repo root + .env target ------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${REPO_ROOT:-}" ]; then
  if [ -f "$SCRIPT_DIR/../../docker/docker-compose.yml" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
  else
    REPO_ROOT="/home/droplet/edge-platform"
  fi
fi
export REPO_ROOT

ENV_FILE="${DROPLET_NVR_MEDIA_ENV_FILE:-$REPO_ROOT/.env}"
COMPOSE_FILE="${DROPLET_NVR_MEDIA_COMPOSE_FILE:-$REPO_ROOT/docker/docker-compose.yml}"

# =============================================================================
# WARP-3514 — --status / --apply / --resize
# =============================================================================
# DEFINITIONS ONLY: nothing below runs until a mode calls it. The helpers serve
# the three new modes and the legacy absolute-path ancestry check. Names carry
# an nvr_ prefix so they cannot collide with the libs sourced further down.
#
# nvr_refuse EXITS: never call it inside $( ), a pipeline or a subshell — it
# would only leave that subshell and its JSON would be captured. Helpers that
# can refuse hand their results back through globals instead.

# --- JSON emitters (pure bash; every value is treated as UNTRUSTED text) -----
# `\` and `"` are escaped; every byte outside printable ASCII (control chars,
# DEL, multi-byte text, a stray newline) becomes the JSON escape \ufffd (U+FFFD).
# The output is always plain-ASCII, valid JSON, and a hostile value can only
# ever be ONE string.
# Needs LC_ALL=C (exported when a new mode starts) so [^ -~] is a BYTE range.
# The replacements go through quoted variables on purpose: a literal backslash
# in the replacement text of ${s//x/y} is read differently across bash
# versions, a quoted expansion is not.
NVR_BS='\'
NVR_DQ='"'
NVR_U_FFFD='\ufffd'
nvr_json_str() {
  local s="$1"
  s="${s//"$NVR_BS"/"$NVR_BS$NVR_BS"}"
  s="${s//"$NVR_DQ"/"$NVR_BS$NVR_DQ"}"
  s="${s//[^ -~]/"$NVR_U_FFFD"}"
  printf '"%s"' "$s"
}
nvr_json_str_or_null() { if [ -n "$1" ]; then nvr_json_str "$1"; else printf 'null'; fi; }
# A canonical unsigned integer of at most 18 digits (safe in bash arithmetic).
nvr_is_uint() { local re='^(0|[1-9][0-9]{0,17})$'; [[ "$1" =~ $re ]]; }
nvr_json_uint_or_null() { if nvr_is_uint "$1"; then printf '%s' "$1"; else printf 'null'; fi; }

# One JSON object on stdout, the text on stderr, exit 1.
nvr_refuse() {   # nvr_refuse <code> <message>   (messages: ASCII, no paths/labels)
  err "$2" || true
  printf '{"ok":false,"code":%s,"message":%s}\n' "$(nvr_json_str "$1")" "$(nvr_json_str "$2")"
  exit 1
}

# --- Configuration (new modes only; the legacy mode never reads these) --------
nvr_init_base() {
  NVR_MOUNT_BASE="${DROPLET_NVR_MOUNT_BASE:-/mnt/droplet}"
  NVR_STATE_DIR="${DROPLET_NVR_STATE_DIR:-/var/lib/droplet-bridge/nvr-spool}"
  NVR_ROOT_STATE_DIR="${DROPLET_NVR_ROOT_STATE_DIR:-/var/lib/droplet-nvr}"
  case "$NVR_MOUNT_BASE" in
    /*[!/]) ;;   # absolute, not "/" itself, no trailing slash
    *) nvr_refuse internal "the drive mount base must be an absolute path without a trailing slash" ;;
  esac
}
nvr_init_projid() {
  local re='^[1-9][0-9]{0,9}$'
  NVR_PROJID="${DROPLET_NVR_PROJID:-4096}"
  if ! [[ "$NVR_PROJID" =~ $re ]] || [ "$NVR_PROJID" -gt 4294967294 ]; then
    nvr_refuse internal "the configured project id is not valid"
  fi
}
nvr_init_files_projid() {
  local re='^[1-9][0-9]{0,9}$'
  NVR_FILES_PROJID="${DROPLET_NVR_FILES_PROJID:-4097}"
  if ! [[ "$NVR_FILES_PROJID" =~ $re ]] || [ "$NVR_FILES_PROJID" -gt 4294967294 ] \
     || [ "$NVR_FILES_PROJID" = "$NVR_PROJID" ]; then
    nvr_refuse internal "the configured files project id is not valid"
  fi
}
nvr_init_tool() {
  if [ -n "${DROPLET_NVR_QUOTA_TOOL:-}" ]; then
    NVR_QUOTA_TOOL="$DROPLET_NVR_QUOTA_TOOL"
  elif [ -f "$SCRIPT_DIR/droplet-nvr-quota.py" ]; then
    NVR_QUOTA_TOOL="$SCRIPT_DIR/droplet-nvr-quota.py"
  else
    NVR_QUOTA_TOOL="/usr/local/sbin/droplet-nvr-quota.py"
  fi
}

# --- Small validators / text helpers ------------------------------------------
nvr_valid_uuid() { local re='^[0-9A-Fa-f][0-9A-Fa-f-]{6,35}$'; [[ "$1" =~ $re ]]; }
# A positive integer without leading zeros, 1 .. 2^62. Compared as text by
# length then lexically so a 19-digit input cannot wrap bash's signed 64-bit.
nvr_valid_limit() {
  local v="$1" max="4611686018427387904" re='^[1-9][0-9]{0,18}$'
  [[ "$v" =~ $re ]] || return 1
  [ "${#v}" -lt "${#max}" ] && return 0
  [ "${#v}" -eq "${#max}" ] && [[ ! "$v" > "$max" ]]
}
nvr_has_opt() { case ",$1," in *",$2,"*) return 0 ;; esac; return 1; }
nvr_last_line() { local s="$1"; printf '%s' "${s##*$'\n'}"; }
nvr_join_comma() { local IFS=,; printf '%s' "$*"; }
nvr_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# The nearest ancestor of <path> that exists (a bay that is not mounted may not
# even have its mountpoint directory).
nvr_nearest_existing() {
  local p="$1"
  while [ -n "$p" ] && [ ! -e "$p" ] && [ "${p%/*}" != "$p" ]; do p="${p%/*}"; done
  [ -n "$p" ] || p="/"
  printf '%s' "$p"
}
# <mount>/<tail> is the ONLY shape accepted for a bay mount; prints the tail.
nvr_mount_tail() {
  local p="$1" t="" re='^[A-Za-z0-9][A-Za-z0-9._-]*$'
  case "$p" in
    "$NVR_MOUNT_BASE"/*) t="${p#"$NVR_MOUNT_BASE"/}" ;;
    *) return 1 ;;
  esac
  [[ "$t" =~ $re ]] || return 1
  printf '%s' "$t"
}

# statfs of <path> -> SF_FRSIZE SF_BLOCKS SF_BFREE SF_BAVAIL (digits), or return 1.
# DROPLET_NVR_MEDIA_STATFS (an executable) replaces `stat -f` for the tests —
# the dev host's stat -f is unreliable.
nvr_statfs() {
  local out="" a="" b="" c="" d="" extra=""
  SF_FRSIZE=""; SF_BLOCKS=""; SF_BFREE=""; SF_BAVAIL=""
  if [ -n "${DROPLET_NVR_MEDIA_STATFS:-}" ]; then
    out="$("$DROPLET_NVR_MEDIA_STATFS" "$1" 2>/dev/null)" || return 1
  else
    out="$(stat -f -c '%S %b %f %a' -- "$1" 2>/dev/null)" || return 1
  fi
  read -r a b c d extra <<<"$out" || true
  nvr_is_uint "$a" && nvr_is_uint "$b" && nvr_is_uint "$c" && nvr_is_uint "$d" || return 1
  [ -z "$extra" ] && [ "$a" -gt 0 ] || return 1
  SF_FRSIZE="$a"; SF_BLOCKS="$b"; SF_BFREE="$c"; SF_BAVAIL="$d"
}

# The effective NVR_MEDIA_SOURCE: the first ^NVR_MEDIA_SOURCE= line of .env, CR
# and one pair of quotes stripped; empty/missing means the named volume.
nvr_env_source() {
  local line="" v=""
  if [ -r "$ENV_FILE" ] && [ ! -d "$ENV_FILE" ]; then
    line="$(grep -m1 '^NVR_MEDIA_SOURCE=' -- "$ENV_FILE" 2>/dev/null | head -c 8192 || true)"
  fi
  v="${line#NVR_MEDIA_SOURCE=}"
  v="${v%$'\r'}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  [ -n "$v" ] || v="nvrdata"
  printf '%s' "$v"
}

# --- Mount + block-device facts ------------------------------------------------
# The closest mount of <path>: M_TARGET M_SOURCE (a trailing [/subdir] of a bind
# stripped) M_OPTS M_UUID. UUID is last because it can legitimately be empty.
nvr_mount_row() {
  local out="" line=""
  M_TARGET=""; M_SOURCE=""; M_OPTS=""; M_UUID=""
  out="$(findmnt -rn -o TARGET,SOURCE,OPTIONS,UUID --target "$1" 2>/dev/null || true)"
  line="$(nvr_last_line "$out")"
  [ -n "$line" ] || return 1
  read -r M_TARGET M_SOURCE M_OPTS M_UUID _ <<<"$line" || true
  M_SOURCE="${M_SOURCE%%[*}"
  [ -n "$M_TARGET" ]
}

# The whole dependency chain of <device> (`lsblk -s` walks partition -> dm/LVM/
# crypt -> md -> disk): ANC_NAMES (lsblk order, device first), ANC_DISKS (the
# TYPE=disk leaves, sorted, unique), ANC_CRYPT (1 when ANY layer is dm-crypt),
# ANC_OK (1 when lsblk answered). Never fails.
nvr_load_ancestry() {
  local dev="${1%%[*}" rows="" name="" type="" disks=""
  ANC_NAMES=(); ANC_DISKS=(); ANC_CRYPT=0; ANC_OK=0
  case "$dev" in /*) ;; *) return 0 ;; esac
  rows="$(lsblk -s -rn -o NAME,TYPE "$dev" 2>/dev/null || true)"
  while read -r name type _; do
    [ -n "$name" ] && [ -n "$type" ] || continue
    ANC_OK=1
    ANC_NAMES+=("$name")
    case "$type" in
      disk) disks+="$name"$'\n' ;;
      crypt) ANC_CRYPT=1 ;;
    esac
  done <<<"$rows"
  if [ -n "$disks" ]; then
    while IFS= read -r name; do ANC_DISKS+=("$name"); done < <(printf '%s' "$disks" | sort -u)
  fi
  return 0
}

# The physical disk(s) behind `/`, `/boot`, `/boot/efi` and `/data` — the OS
# disks — space separated; empty when none can be resolved. The same
# resolution as droplet-storage-pool.sh's ancestor_disks/is_os_disk, inline,
# plus /data. DROPLET_NVR_MEDIA_OSDISK names them explicitly (tests). Only
# reads, so it is safe inside $( ).
nvr_os_disks() {
  local mp="" src="" d="" out=""
  if [ -n "${DROPLET_NVR_MEDIA_OSDISK:-}" ]; then
    printf '%s' "$DROPLET_NVR_MEDIA_OSDISK"
    return 0
  fi
  for mp in / /boot /boot/efi /data; do
    src="$(findmnt -rn -o SOURCE --target "$mp" 2>/dev/null || true)"
    src="$(nvr_last_line "$src")"
    src="${src%%[*}"
    [ -n "$src" ] || continue
    nvr_load_ancestry "$src"
    for d in ${ANC_DISKS[@]+"${ANC_DISKS[@]}"}; do out+="$d"$'\n'; done
  done
  printf '%s' "$out" | sort -u | tr '\n' ' '
}

# True when the two space-separated disk lists share a name.
nvr_disks_intersect() {
  local a="" b=""
  # shellcheck disable=SC2086  # word-splitting the disk-name lists is the point
  for a in $1; do
    for b in $2; do
      if [ "$a" = "$b" ]; then return 0; fi
    done
  done
  return 1
}

# --- Tiny JSON readers for state files and tool answers -----------------------
# Strict on purpose (the files are droplet-writable): exactly ONE occurrence of
# the key, and a value of the expected shape, else failure.
nvr_json_uint() {   # nvr_json_uint <json> <key> -> prints the unsigned integer
  local json="$1" key="$2" rest="" val="" n=0 re=""
  re="\"${key}\"[[:space:]]*:[[:space:]]*([0-9]+)([,}[:space:]]|\$)"
  rest="$json"
  while [[ "$rest" =~ $re ]]; do
    n=$((n + 1))
    val="${BASH_REMATCH[1]}"
    rest="${rest#*"${BASH_REMATCH[0]}"}"
  done
  [ "$n" -eq 1 ] && nvr_is_uint "$val" || return 1
  printf '%s' "$val"
}
nvr_json_uuid() {   # nvr_json_uuid <json> <key> -> prints a UUID-shaped string value
  local json="$1" key="$2" rest="" val="" n=0 re=""
  re="\"${key}\"[[:space:]]*:[[:space:]]*\"([0-9A-Fa-f][0-9A-Fa-f-]{6,35})\""
  rest="$json"
  while [[ "$rest" =~ $re ]]; do
    n=$((n + 1))
    val="${BASH_REMATCH[1]}"
    rest="${rest#*"${BASH_REMATCH[0]}"}"
  done
  [ "$n" -eq 1 ] || return 1
  printf '%s' "$val"
}
# $NVR_STATE_DIR/storage.json -> REC_FSUUID REC_PROJID; return 1 unless both
# parse. (Only the fsUuid is ever used to locate anything; the projectId is
# informational — the operating project id always comes from the environment.)
nvr_read_record() {
  local f="$NVR_STATE_DIR/storage.json" body=""
  REC_FSUUID=""; REC_PROJID=""
  if [ ! -f "$f" ] || [ -L "$f" ]; then return 1; fi
  body="$(head -c 65536 -- "$f" 2>/dev/null)" || return 1
  REC_FSUUID="$(nvr_json_uuid "$body" fsUuid)" || return 1
  REC_PROJID="$(nvr_json_uint "$body" projectId)" || return 1
  [ "$REC_PROJID" -ge 1 ] && [ "$REC_PROJID" -le 4294967294 ]
}

# --- --status ---------------------------------------------------------------------
nvr_status_json() {
  local source="" kind="" probe="" size_path="" fs_uuid="" mount_path="" m_src=""
  local mounted=false rw=false encrypted=false is_system=false
  local physical="" names_json="" os_disks="" seen=" " n="" i=0
  local proj="" limit="" used="" fs_size="" fs_free=""

  source="$(nvr_env_source)"
  case "$source" in /*) kind=path ;; *) kind=volume ;; esac

  if [ "$kind" = path ]; then
    probe="$(nvr_nearest_existing "$source")"
    if nvr_mount_row "$probe"; then
      mount_path="$M_TARGET"
      m_src="$M_SOURCE"
      # An unmounted bay resolves onto `/` (or the shared mount-base bind
      # itself) — only /<base>/<something> counts as mounted.
      case "$mount_path" in
        "$NVR_MOUNT_BASE"/?*)
          mounted=true
          fs_uuid="$M_UUID"
          if nvr_has_opt "$M_OPTS" rw && ! nvr_has_opt "$M_OPTS" ro; then rw=true; fi
          ;;
      esac
    fi
    size_path="$mount_path"
  else
    # A named volume lives in Docker's data root, on the OS disk.
    mounted=true
    rw=true
    size_path="/var/lib/docker"
    if nvr_mount_row /var/lib/docker || nvr_mount_row /; then m_src="$M_SOURCE"; fi
  fi

  # The filesystem UUID: unprivileged, libblkid often cannot read it from the
  # device, but udev's database (via lsblk) still can.
  if [ "$mounted" = true ] && [ "$kind" = path ]; then
    nvr_valid_uuid "$fs_uuid" || fs_uuid=""
    if [ -z "$fs_uuid" ]; then
      case "$m_src" in
        /*)
          fs_uuid="$(lsblk -dn -o UUID "$m_src" 2>/dev/null | head -n 1 || true)"
          fs_uuid="${fs_uuid//[[:space:]]/}"
          nvr_valid_uuid "$fs_uuid" || fs_uuid=""
          ;;
      esac
    fi
  else
    fs_uuid=""
  fi

  if [ -n "$size_path" ]; then
    if nvr_statfs "$size_path" || { [ "$kind" = volume ] && nvr_statfs /; }; then
      fs_size=$((SF_BLOCKS * SF_FRSIZE))
      fs_free=$((SF_BAVAIL * SF_FRSIZE))
    fi
  fi

  nvr_load_ancestry "$m_src"
  physical="$(nvr_join_comma ${ANC_DISKS[@]+"${ANC_DISKS[@]}"})"
  if [ "$ANC_CRYPT" = 1 ]; then encrypted=true; fi
  # Bottom-up (the physical disk first, as in the contract example), each once.
  for (( i = ${#ANC_NAMES[@]} - 1; i >= 0; i-- )); do
    n="${ANC_NAMES[$i]}"
    case "$seen" in *" $n "*) continue ;; esac
    seen+="$n "
    names_json+="${names_json:+,}$(nvr_json_str "$n")"
  done
  if [ "$kind" = volume ]; then
    is_system=true
  elif [ -n "$physical" ]; then
    os_disks="$(nvr_os_disks)"
    if [ -n "${os_disks// /}" ] && nvr_disks_intersect "${ANC_DISKS[*]}" "$os_disks"; then
      is_system=true
    fi
  fi

  # The slice: only while the recorded allocation is for THIS live drive.
  if [ "$mounted" = true ] && [ "$kind" = path ] && [ -n "$fs_uuid" ] && nvr_read_record; then
    if [ "${REC_FSUUID,,}" = "${fs_uuid,,}" ]; then
      proj="$REC_PROJID"
      # a project-quota'd dir reports the quota as its total
      if nvr_statfs "$source" && [ "$SF_BFREE" -le "$SF_BLOCKS" ]; then
        limit=$((SF_BLOCKS * SF_FRSIZE))
        used=$(((SF_BLOCKS - SF_BFREE) * SF_FRSIZE))
      fi
    fi
  fi

  printf '{"source":%s,"kind":%s,"fsUuid":%s,"mountPath":%s,"physicalDisk":%s,"backingDevices":[%s],"isSystemDisk":%s,"encrypted":%s,"mounted":%s,"rw":%s,"projectId":%s,"limitBytes":%s,"usedBytes":%s,"fsSizeBytes":%s,"fsFreeBytes":%s}\n' \
    "$(nvr_json_str "$source")" "$(nvr_json_str "$kind")" \
    "$(nvr_json_str_or_null "$fs_uuid")" "$(nvr_json_str_or_null "$mount_path")" \
    "$(nvr_json_str_or_null "$physical")" "$names_json" \
    "$is_system" "$encrypted" "$mounted" "$rw" \
    "$(nvr_json_uint_or_null "$proj")" "$(nvr_json_uint_or_null "$limit")" \
    "$(nvr_json_uint_or_null "$used")" "$(nvr_json_uint_or_null "$fs_size")" \
    "$(nvr_json_uint_or_null "$fs_free")"
}

nvr_run_status() {
  local out=""
  shift
  [ "$#" -eq 0 ] || nvr_refuse bad_request "--status takes no arguments"
  nvr_init_base
  if ! out="$(nvr_status_json)"; then
    err "could not build the status report"
    exit 1
  fi
  printf '%s\n' "$out"
}

# --- --apply / --resize shared steps -------------------------------------------------
# The quota tool is root-only and not on PATH; run it directly, or through
# python3 when the checkout copy lost its executable bit.
nvr_quota() {
  if [ -x "$NVR_QUOTA_TOOL" ]; then
    "$NVR_QUOTA_TOOL" "$@"
  elif [ -f "$NVR_QUOTA_TOOL" ]; then
    python3 "$NVR_QUOTA_TOOL" "$@"
  else
    return 127
  fi
}

# Directories this mode writes into, checked BEFORE anything is changed.
nvr_check_dirs() {   # nvr_check_dirs <state-dir-must-exist:0|1>
  if [ -L "$NVR_STATE_DIR" ]; then nvr_refuse internal "the state directory is a symlink"; fi
  if [ "$1" -eq 1 ] && [ ! -d "$NVR_STATE_DIR" ]; then nvr_refuse internal "the state directory does not exist"; fi
  if [ -L "$NVR_ROOT_STATE_DIR" ]; then nvr_refuse internal "the root-only state directory is a symlink"; fi
}

# Resolve <fsuuid> to its mount: BAY_MOUNT BAY_SOURCE BAY_FSTYPE BAY_OPTS, or
# refuse. The same filesystem can show up more than once (a bind peer outside
# the mount area); only a /<base>/<tail> line counts.
nvr_resolve_bay() {
  local rows="" line="" t="" s="" f="" o="" any=0
  rows="$(findmnt -rn -S "UUID=$1" -o TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null || true)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    any=1
    read -r t s f o _ <<<"$line" || true
    if nvr_mount_tail "$t" >/dev/null; then
      BAY_MOUNT="$t"; BAY_SOURCE="${s%%[*}"; BAY_FSTYPE="$f"; BAY_OPTS="$o"
      return 0
    fi
  done <<<"$rows"
  if [ "$any" -eq 0 ]; then nvr_refuse not_mounted "the drive is not mounted"; fi
  nvr_refuse bad_mount "the drive is not mounted in the Droplet drive area"
}

# The checks every mount must pass, FIRST FAILURE WINS: read_only, os_disk,
# not_encrypted, quota_unsupported.
nvr_check_bay() {
  local bay_disks="" os_disks=""
  if ! nvr_has_opt "$BAY_OPTS" rw || nvr_has_opt "$BAY_OPTS" ro; then
    nvr_refuse read_only "the drive is mounted read-only"
  fi
  # Physical ancestry, not device names: a LUKS mapper and the root LVM can
  # both stack on one NVMe. Fail CLOSED when the OS disk cannot be determined
  # ("not the OS disk" is then unprovable).
  nvr_load_ancestry "$BAY_SOURCE"
  bay_disks="${ANC_DISKS[*]-}"
  [ -n "$bay_disks" ] || bay_disks="${BAY_SOURCE##*/}"
  os_disks="$(nvr_os_disks)"
  if [ -z "${os_disks// /}" ]; then
    nvr_refuse os_disk "cannot determine which disk holds the operating system, so the drive cannot be shown to be a separate disk"
  fi
  if nvr_disks_intersect "$bay_disks" "$os_disks"; then
    nvr_refuse os_disk "the drive shares a physical disk with the operating system - camera recordings are never stored on it"
  fi
  [ "$ANC_CRYPT" = 1 ] || nvr_refuse not_encrypted "the drive is not encrypted (LUKS) - prepare it before using it for camera recordings"
  if [ "$BAY_FSTYPE" != ext4 ] || ! nvr_has_opt "$BAY_OPTS" prjquota; then
    nvr_refuse quota_unsupported "the drive filesystem has no project quota support (it needs ext4 mounted with prjquota)"
  fi
}

# The space recordings use now: NVR_USED (empty when unknown). The quota tool
# first; for --resize a statfs of <mount>/nvr is a valid fallback (an active
# project quota reports its usage there) — for a first --apply it is NOT (before
# the project id is set statfs shows the whole filesystem).
nvr_current_usage() {   # nvr_current_usage <statfs-fallback:0|1>
  local json=""
  NVR_USED=""
  if json="$(nvr_quota get "$BAY_SOURCE" "$NVR_PROJID" 2>/dev/null)"; then
    NVR_USED="$(nvr_json_uint "$json" usedBytes)" || NVR_USED=""
  fi
  if [ -z "$NVR_USED" ] && [ "$1" -eq 1 ] && nvr_statfs "$NVR_DIR" && [ "$SF_BFREE" -le "$SF_BLOCKS" ]; then
    NVR_USED=$(((SF_BLOCKS - SF_BFREE) * SF_FRSIZE))
  fi
  return 0
}

# A limit must fit the filesystem and clear current usage by 10 percent (below
# that Frigate would hit ENOSPC). FS_SIZE must be set. ONE place for both
# modes; --resize additionally REQUIRES a usage reading.
nvr_check_limit_bounds() {   # nvr_check_limit_bounds <limit> <resize:0|1>
  local limit="$1" min_limit=0
  [ "$limit" -le "$FS_SIZE" ] || nvr_refuse exceeds_fs "the requested size is larger than the drive"
  nvr_current_usage "$2"
  if [ -z "$NVR_USED" ]; then
    [ "$2" -eq 0 ] || nvr_refuse quota_failed "cannot determine the space recordings currently use (usage unreadable), so the new limit cannot be checked"
    return 0
  fi
  if [ "$NVR_USED" -gt 0 ]; then
    min_limit=$(((NVR_USED * 11 + 9) / 10))
    if [ "$limit" -lt "$min_limit" ]; then
      nvr_refuse below_used "the requested size is below the space already used (plus 10 percent headroom)"
    fi
  fi
}

# After `set`: the quota must (a) read back as exactly ceil(limit/1024) KiB — the
# tool rounds UP — and (b) be what the bind mount shows: the statfs total of
# <mount>/nvr within max(1 MiB, 1% of the limit) of the request. This is the
# ONE place that tolerance lives. A silently wrong quotactl struct would
# otherwise only surface on the real box.
nvr_quota_visible() {   # nvr_quota_visible <limit> [projid] [dir]
  local limit="$1" projid="${2:-$NVR_PROJID}" dir="${3:-$NVR_DIR}"
  local want=0 got="" json="" total=0 tol=0 diff=0
  want=$(((limit + 1023) / 1024 * 1024))
  json="$(nvr_quota get "$BAY_SOURCE" "$projid" 2>/dev/null)" || return 1
  got="$(nvr_json_uint "$json" hardBytes)" || return 1
  [ "$got" = "$want" ] || return 1
  nvr_statfs "$dir" || return 1
  total=$((SF_BLOCKS * SF_FRSIZE))
  tol=$((limit / 100))
  [ "$tol" -ge 1048576 ] || tol=1048576
  if [ "$total" -ge "$limit" ]; then diff=$((total - limit)); else diff=$((limit - total)); fi
  [ "$diff" -le "$tol" ]
}

# Set the hard limit and prove it took (see nvr_quota_visible).
nvr_set_quota_verified() {   # nvr_set_quota_verified <limit> [projid] [dir]
  local limit="$1" projid="${2:-$NVR_PROJID}" dir="${3:-$NVR_DIR}" why=""
  if ! why="$(nvr_quota set "$BAY_SOURCE" "$projid" "$limit" 2>&1 >/dev/null)"; then
    why="$(nvr_last_line "$why")"
    nvr_refuse quota_failed "could not set the size limit${why:+: ${why:0:200}}"
  fi
  if ! nvr_quota_visible "$limit" "$projid" "$dir"; then
    nvr_refuse quota_failed "the project quota was set but is not visible or readable back (the limit check failed)"
  fi
}

# --- the Nextcloud side of the drive: <mount>/files --------------------------------
# WARP-3514 (decision 2026-10-04): files/ gets its OWN project quota (id 4097) of
# filesystem size - recordings slice - 2 % slack, re-applied on every slice
# change, so the files side can never eat space reserved for recordings. files/
# is created by the drive-preparation flow, not here: when it does not exist
# there is nothing to cap yet (FILES_LIMIT stays empty).
nvr_files_dir() { FILES_DIR="$BAY_MOUNT/files"; }
nvr_files_nonempty() {   # true when <mount>/files holds ANY entry (dotfiles included)
  local first=""
  nvr_files_dir
  [ -d "$FILES_DIR" ] && [ ! -L "$FILES_DIR" ] || return 1
  first="$(find "$FILES_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  [ -n "$first" ]
}
nvr_require_empty_files() {
  if nvr_files_nonempty; then
    nvr_refuse files_not_empty "the drive still holds files - move or delete them before giving the whole drive to camera recordings"
  fi
}
nvr_reserve_files() {   # nvr_reserve_files <slice-limit>   (FS_SIZE must be set)
  local slice="$1" slack=0 q=0 first=""
  FILES_LIMIT=""
  nvr_files_dir
  if [ -L "$FILES_DIR" ] || [ ! -d "$FILES_DIR" ]; then return 0; fi
  slack=$(((FS_SIZE + 49) / 50))
  q=$((FS_SIZE - slice - slack))
  [ "$q" -ge 1048576 ] || q=1048576
  first="$(find "$FILES_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  if [ -n "$first" ]; then
    chattr -R +P -p "$NVR_FILES_PROJID" "$FILES_DIR" >/dev/null 2>&1 \
      || nvr_refuse quota_failed "could not mark the files directory for the project quota"
  else
    chattr +P -p "$NVR_FILES_PROJID" "$FILES_DIR" >/dev/null 2>&1 \
      || nvr_refuse quota_failed "could not mark the files directory for the project quota"
  fi
  nvr_set_quota_verified "$q" "$NVR_FILES_PROJID" "$FILES_DIR"
  FILES_LIMIT="$q"
}
# `full` gives the whole drive to recordings, so files/ (empty by then) must stop
# being a Nextcloud external storage. Best-effort by design (a warming/absent
# container must not fail a quota change that already succeeded); the result is
# reported as filesDeregistered. occ addresses the drive as /host/<tail>/files.
nvr_deregister_files() {
  local tail="${BAY_MOUNT##*/}" container="${NEXTCLOUD_CONTAINER:-droplet-nextcloud-1}"
  local listing="" ids="" id=""
  FILES_DEREGISTERED=false
  command -v docker >/dev/null 2>&1 || return 0
  listing="$(timeout 30 docker exec -u 33 "$container" php occ files_external:list --output=json 2>/dev/null || true)"
  [ -n "$listing" ] || return 0
  ids="$(NVR_LISTING="$listing" NVR_DATADIR="/host/$tail/files" python3 - <<'PY' 2>/dev/null || true
import json, os
try:
    rows = json.loads(os.environ["NVR_LISTING"])
except Exception:
    raise SystemExit(0)
want = os.environ["NVR_DATADIR"]
for row in rows if isinstance(rows, list) else []:
    cfg = row.get("configuration") if isinstance(row, dict) else None
    mid = row.get("mount_id") if isinstance(row, dict) else None
    if isinstance(cfg, dict) and cfg.get("datadir") == want and isinstance(mid, int):
        print(mid)
PY
)"
  for id in $ids; do
    if timeout 30 docker exec -u 33 "$container" php occ files_external:delete "$id" -y >/dev/null 2>&1; then
      FILES_DEREGISTERED=true
    fi
  done
  return 0
}

# --- state files (the hardened atomic write of droplet-storage-pool-apply.sh) ----
# Root writes into a directory the droplet user controls: unlink the tmp name,
# create it O_EXCL|O_NOFOLLOW 0600 (refuses ANY pre-planted entry), chown and
# chmod through the fd (never by path), then `mv -T` so the final rename cannot
# be redirected either. The payload is round-tripped through json so a broken
# escape can never put a malformed file on disk.
nvr_write_json() {   # nvr_write_json <dir> <name> <json> <own-to-dir:0|1>
  local dir="$1" name="$2" payload="$3" own="$4" tmp=""
  tmp="$dir/$name.tmp"
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then return 1; fi
  rm -f -- "$tmp" || return 1
  if ! NVR_PAYLOAD="$payload" NVR_TMP="$tmp" NVR_DIR="$dir" NVR_OWN="$own" python3 - <<'PY'
import json, os, sys
payload = json.loads(os.environ["NVR_PAYLOAD"])
if not isinstance(payload, dict):
    sys.exit(3)
path = os.environ["NVR_TMP"]
# O_EXCL|O_NOFOLLOW: fail closed if ANYTHING (file or symlink) already sits at
# the path; 0600 from birth. fchown/fchmod are POSIX-only; the guards only keep
# the script exercisable by pytest on a Windows dev host.
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
fd = os.open(path, flags, 0o600)
try:
    if os.environ.get("NVR_OWN") == "1" and hasattr(os, "fchown"):
        st = os.stat(os.environ["NVR_DIR"])
        os.fchown(fd, st.st_uid, st.st_gid)
    if hasattr(os, "fchmod"):
        os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fd = -1
        json.dump(payload, fh, separators=(",", ":"))
        fh.write("\n")
finally:
    if fd != -1:
        os.close(fd)
PY
  then
    rm -f -- "$tmp"
    return 1
  fi
  mv -T -- "$tmp" "$dir/$name" || { rm -f -- "$tmp"; return 1; }
}

# The droplet-readable "last applied allocation".
nvr_write_storage() {   # nvr_write_storage <fsuuid> <mode> <limit>
  local payload=""
  payload="$(printf '{"fsUuid":%s,"mountPath":%s,"source":%s,"mode":%s,"projectId":%s,"limitBytes":%s,"appliedAt":%s}' \
    "$(nvr_json_str "$1")" "$(nvr_json_str "$BAY_MOUNT")" "$(nvr_json_str "$NVR_DIR")" \
    "$(nvr_json_str "$2")" "$NVR_PROJID" "$3" "$(nvr_json_str "$(nvr_now)")")"
  nvr_write_json "$NVR_STATE_DIR" storage.json "$payload" 1 \
    || nvr_refuse internal "could not record the applied allocation"
}

# True when <file> already describes the move to <new-source> and carries a
# previousSource (root-only file; read with python so any junk simply fails).
nvr_record_describes() {   # nvr_record_describes <file> <new-source>
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        rec = json.load(fh)
except Exception:
    sys.exit(1)
ok = (isinstance(rec, dict) and rec.get("newSource") == sys.argv[2]
      and isinstance(rec.get("previousSource"), str) and rec["previousSource"] != "")
sys.exit(0 if ok else 1)
PY
}

# The ROOT-ONLY record of where the footage lived before this target: used
# later by the migration job (rollback, delete of the old copy). A re-apply of
# the SAME target keeps the record that is already there — it must never be
# overwritten with the new path.
nvr_record_previous() {   # nvr_record_previous <previous> <new> <fsuuid>
  local file="$NVR_ROOT_STATE_DIR/migration.json" payload=""
  [ "$1" != "$2" ] || return 0
  if [ -f "$file" ] && nvr_record_describes "$file" "$2"; then return 0; fi
  install -d -m 0700 -- "$NVR_ROOT_STATE_DIR" || return 1
  chmod 0700 -- "$NVR_ROOT_STATE_DIR" || return 1
  payload="$(printf '{"previousSource":%s,"newSource":%s,"fsUuid":%s,"recordedAt":%s}' \
    "$(nvr_json_str "$1")" "$(nvr_json_str "$2")" "$(nvr_json_str "$3")" "$(nvr_json_str "$(nvr_now)")")"
  nvr_write_json "$NVR_ROOT_STATE_DIR" migration.json "$payload" 0
}

# --- --apply -----------------------------------------------------------------------
nvr_run_apply() {
  local fs_uuid="" mode="" limit_raw="" have_uuid=0 have_mode=0 have_limit=0
  local limit=0 previous="" first=""
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --fs-uuid)
        { [ "$have_uuid" -eq 0 ] && [ "$#" -ge 2 ]; } || nvr_refuse bad_request "--fs-uuid needs exactly one value"
        fs_uuid="$2"; have_uuid=1; shift 2 ;;
      --mode)
        { [ "$have_mode" -eq 0 ] && [ "$#" -ge 2 ]; } || nvr_refuse bad_request "--mode needs exactly one value"
        mode="$2"; have_mode=1; shift 2 ;;
      --limit-bytes)
        { [ "$have_limit" -eq 0 ] && [ "$#" -ge 2 ]; } || nvr_refuse bad_request "--limit-bytes needs exactly one value"
        limit_raw="$2"; have_limit=1; shift 2 ;;
      *) nvr_refuse bad_request "unexpected argument" ;;
    esac
  done
  [ "$have_uuid" -eq 1 ] || nvr_refuse bad_request "--fs-uuid is required"
  nvr_valid_uuid "$fs_uuid" || nvr_refuse bad_request "--fs-uuid is not a filesystem UUID"
  case "$mode" in
    reserved|full) ;;
    *) nvr_refuse bad_request "--mode must be reserved or full" ;;
  esac
  if [ "$have_limit" -eq 1 ] && ! nvr_valid_limit "$limit_raw"; then
    nvr_refuse bad_request "--limit-bytes must be a positive integer of at most 2^62"
  fi
  if [ "$mode" = reserved ] && [ "$have_limit" -eq 0 ]; then
    nvr_refuse bad_request "--limit-bytes is required for --mode reserved"
  fi

  nvr_init_base
  nvr_init_projid
  nvr_init_files_projid
  nvr_init_tool
  nvr_check_dirs 1

  nvr_resolve_bay "$fs_uuid"
  nvr_check_bay
  # `full` hands the whole drive to recordings: the Nextcloud side must be empty
  # (checked BEFORE anything on the drive changes).
  if [ "$mode" = full ]; then nvr_require_empty_files; fi

  # <mount>/nvr must be a plain directory (never a symlink root would follow).
  NVR_DIR="$BAY_MOUNT/nvr"
  if [ -L "$NVR_DIR" ] || { [ -e "$NVR_DIR" ] && [ ! -d "$NVR_DIR" ]; }; then
    nvr_refuse bad_mount "the recordings directory on the drive is not a plain directory (a symlink or file is in its place)"
  fi

  # Size the slice. `reserved` = what was asked (bounded); `full` = the whole
  # filesystem.
  nvr_statfs "$BAY_MOUNT" || nvr_refuse internal "cannot read the size of the drive filesystem"
  FS_SIZE=$((SF_BLOCKS * SF_FRSIZE))
  if [ "$mode" = full ]; then
    limit="$FS_SIZE"
  else
    limit="$limit_raw"
    nvr_check_limit_bounds "$limit" 0
  fi
  previous="$(nvr_env_source)"

  # --- from here the drive is changed ---
  if [ ! -d "$NVR_DIR" ]; then
    mkdir -m 0700 -- "$NVR_DIR" 2>/dev/null || nvr_refuse internal "could not create the recordings directory on the drive"
  fi
  chmod 0700 -- "$NVR_DIR" 2>/dev/null || nvr_refuse internal "could not restrict the recordings directory"
  if [ "$EUID" -eq 0 ]; then
    chown root:root -- "$NVR_DIR" 2>/dev/null || nvr_refuse internal "could not take ownership of the recordings directory"
  fi
  if [ -L "$NVR_DIR" ]; then
    nvr_refuse bad_mount "the recordings directory was replaced by a symlink"
  fi
  # Project id + inherit flag; recursive only when content already exists.
  first="$(find "$NVR_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  if [ -n "$first" ]; then
    chattr -R +P -p "$NVR_PROJID" "$NVR_DIR" >/dev/null 2>&1 \
      || nvr_refuse quota_failed "could not mark the recordings directory for the project quota"
  else
    chattr +P -p "$NVR_PROJID" "$NVR_DIR" >/dev/null 2>&1 \
      || nvr_refuse quota_failed "could not mark the recordings directory for the project quota"
  fi
  nvr_set_quota_verified "$limit"
  FILES_DEREGISTERED=false
  if [ "$mode" = full ]; then
    nvr_deregister_files
    FILES_LIMIT=""
  else
    nvr_reserve_files "$limit"
  fi

  # The root-only record of where the footage lived before (the migration job's
  # rollback + delete-old input) and of the target it must flip to. NVR_MEDIA_SOURCE
  # itself is NOT written here - only the migration flip writes it.
  if ! nvr_record_previous "$previous" "$NVR_DIR" "$fs_uuid"; then
    nvr_refuse internal "could not record where the recordings lived before"
  fi
  nvr_write_storage "$fs_uuid" "$mode" "$limit"

  printf '{"ok":true,"operation":"apply","fsUuid":%s,"mountPath":%s,"source":%s,"mode":%s,"projectId":%s,"limitBytes":%s,"previousSource":%s,"filesLimitBytes":%s,"filesDeregistered":%s}\n' \
    "$(nvr_json_str "$fs_uuid")" "$(nvr_json_str "$BAY_MOUNT")" "$(nvr_json_str "$NVR_DIR")" \
    "$(nvr_json_str "$mode")" "$NVR_PROJID" "$limit" "$(nvr_json_str "$previous")" \
    "$(nvr_json_uint_or_null "$FILES_LIMIT")" "$FILES_DEREGISTERED"
}

# --- --resize ---------------------------------------------------------------------
nvr_run_resize() {
  local limit=0 mode="reserved"
  shift
  [ "$#" -eq 1 ] || nvr_refuse bad_request "--resize takes exactly one value: the new limit in bytes"
  nvr_valid_limit "$1" || nvr_refuse bad_request "the new limit must be a positive integer of at most 2^62"
  limit="$1"

  nvr_init_base
  nvr_init_projid
  nvr_init_files_projid
  nvr_init_tool
  nvr_check_dirs 0
  nvr_read_record || nvr_refuse no_allocation "no recordings allocation is recorded on this box"
  nvr_resolve_bay "$REC_FSUUID"
  # The record is only trusted while .env still points at that drive's nvr/.
  NVR_DIR="$BAY_MOUNT/nvr"
  [ "$(nvr_env_source)" = "$NVR_DIR" ] \
    || nvr_refuse no_allocation "the recorded allocation is not the active recordings target"
  if [ -L "$NVR_DIR" ] || [ ! -d "$NVR_DIR" ]; then
    nvr_refuse no_allocation "the recordings directory of the recorded allocation is missing"
  fi
  nvr_check_bay

  nvr_statfs "$BAY_MOUNT" || nvr_refuse internal "cannot read the size of the drive filesystem"
  FS_SIZE=$((SF_BLOCKS * SF_FRSIZE))
  nvr_check_limit_bounds "$limit" 1
  if [ "$limit" -ge "$FS_SIZE" ]; then mode="full"; nvr_require_empty_files; fi
  nvr_set_quota_verified "$limit"
  FILES_DEREGISTERED=false
  if [ "$mode" = full ]; then nvr_deregister_files; else nvr_reserve_files "$limit"; fi
  nvr_write_storage "$REC_FSUUID" "$mode" "$limit"

  printf '{"ok":true,"operation":"resize","limitBytes":%s,"usedBytes":%s,"projectId":%s}\n' \
    "$limit" "$NVR_USED" "$NVR_PROJID"
}

# --- legacy absolute path: physical-disk ancestry ----------------------------------
# A LUKS partition on the OS NVMe is a different filesystem from `/` (so the
# st_dev check passes) yet still fills the OS disk. Refuse a path whose backing
# physical disk(s) include an OS disk — only when the ancestry is resolvable.
# While DROPLET_NVR_MEDIA_ROOT_DEV simulates a box the machine's REAL topology
# is not what is being simulated, so it is skipped unless the OS disks are
# named explicitly (DROPLET_NVR_MEDIA_OSDISK) — that keeps the WARP-2099 tests
# hermetic on any runner.
nvr_legacy_ancestry_check() {   # nvr_legacy_ancestry_check <resolved-path>
  local src="" target_disks="" os_disks=""
  if [ -n "${DROPLET_NVR_MEDIA_ROOT_DEV:-}" ] && [ -z "${DROPLET_NVR_MEDIA_OSDISK:-}" ]; then
    return 0
  fi
  src="$(findmnt -rn -o SOURCE --target "$1" 2>/dev/null || true)"
  src="$(nvr_last_line "$src")"
  src="${src%%[*}"
  [ -n "$src" ] || return 0
  nvr_load_ancestry "$src"
  [ "${#ANC_DISKS[@]}" -gt 0 ] || return 0
  target_disks="${ANC_DISKS[*]}"
  os_disks="$(nvr_os_disks)"
  [ -n "${os_disks// /}" ] || return 0
  if nvr_disks_intersect "$target_disks" "$os_disks"; then
    die "target '${1}' is on a physical disk shared with the OS/boot/data filesystem (${target_disks}) — recordings must never land on the OS disk. Point this at a dedicated bay drive (e.g. /mnt/droplet/<drive>/nvr)."
  fi
}

# --- Dispatch ---------------------------------------------------------------------
# The three new modes; everything else is the legacy positional mode below,
# untouched.
case "$MODE" in
  status) export LC_ALL=C; nvr_run_status "$@"; exit 0 ;;
  apply)  export LC_ALL=C; nvr_run_apply "$@"; exit 0 ;;
  resize) export LC_ALL=C; nvr_run_resize "$@"; exit 0 ;;
esac

[ -n "$TARGET" ] || die "no recordings target given"

# --- Reject shell-hostile values before anything else -----------------------
# The value is interpolated into .env and later into a compose volume spec.
# Matched with bash's [[ =~ ]] (whole-string, newline-safe) rather than a
# `printf | grep -q` pipe — grep is LINE-based, so a newline-bearing arg like
# 'nvrdata<LF>KEY=evil' would pass a grep check on its first line and inject a
# second .env assignment.
if [[ "$TARGET" =~ [[:space:]] ]]; then
  die "target '${TARGET}' contains whitespace"
fi
if [ "${#TARGET}" -gt 255 ]; then
  die "target is longer than 255 characters"
fi

case "$TARGET" in
  /*)
    # ---------------- Absolute path: bind mount ----------------------------
    # A relative path is NOT a third shape — compose would read it as a
    # relative bind source against the compose file's directory, silently
    # landing footage inside the repo (i.e. the boot disk). Refused above by
    # falling through to the named-volume branch, which rejects the slash.
    [ -d "$TARGET" ] || die "target '${TARGET}' does not exist (or is not a directory) — refusing: Docker would create an empty directory for a missing bind source and record onto the boot disk anyway"

    # Canonicalize so `/mnt/pool/../..` cannot smuggle us back onto /.
    _resolved="$(readlink -f "$TARGET" 2>/dev/null || printf '%s' "$TARGET")"

    # Never the boot/ESP filesystems, whatever their st_dev says. These are
    # separate devices from / on every Droplet layout, so the st_dev test
    # below would happily accept them.
    case "$_resolved" in
      /boot|/boot/*)
        die "target '${_resolved}' is on the boot filesystem — recordings must never land there"
        ;;
    esac

    _root_dev="${DROPLET_NVR_MEDIA_ROOT_DEV:-$(stat -c %d / 2>/dev/null || echo "")}"
    _target_dev="$(stat -c %d "$_resolved" 2>/dev/null || echo "")"
    if [ -z "$_root_dev" ] || [ -z "$_target_dev" ]; then
      die "could not determine the filesystem of '${_resolved}' — refusing rather than guessing"
    fi
    if [ "$_root_dev" = "$_target_dev" ]; then
      die "target '${_resolved}' is on the ROOT filesystem — recordings there fill the boot disk and take the appliance down. Point this at a mounted pool (e.g. /mnt/droplet/<pool>/nvr)."
    fi
    # WARP-3514: a different filesystem can still sit on the OS DISK (a LUKS
    # partition beside the root one). Compare physical-disk ancestry as well.
    nvr_legacy_ancestry_check "$_resolved"
    TARGET="$_resolved"
    ;;
  *)
    # ---------------- Bare name: compose-declared volume -------------------
    # Docker's own volume-name grammar. Anything outside it (a slash, a colon,
    # a leading dot) is not a volume name and not an absolute path.
    if ! [[ "$TARGET" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
      die "target '${TARGET}' is neither an absolute path nor a valid volume name"
    fi
    # It must actually be DECLARED, or `docker compose up` fails on an
    # undefined volume and takes the whole stack down — a far worse outcome
    # than the misconfiguration we are fixing.
    if [ -f "$COMPOSE_FILE" ]; then
      if ! awk '
        /^volumes:/        { inv = 1; next }
        /^[A-Za-z_-]+:/    { inv = 0 }
        inv && /^  [A-Za-z0-9][A-Za-z0-9_.-]*:/ {
          name = $1; sub(/:$/, "", name); print name
        }
      ' "$COMPOSE_FILE" | grep -qxF "$TARGET"; then
        die "volume '${TARGET}' is not declared in ${COMPOSE_FILE} — 'docker compose up' would fail on an undefined volume"
      fi
    fi
    ;;
esac

# --- Idempotent .env write-back (canonical upsert — WARP-2522) --------------
# The previous rewrite here staged a temp file and `mv`-ed it over $ENV_FILE.
# On a box where relocate_secrets_to_data has run, $ENV_FILE is a SYMLINK into
# the encrypted /data — mv REPLACED the link with a plain file on the
# unencrypted boot disk (the WARP-232 regression class). Its sed splice also
# interpolated the operator-supplied path unescaped, so a target containing
# `&` (splices the matched text) or `|` (the expression's own delimiter)
# corrupted the value or killed the write outright.
#
# _upsert_env_kv (scripts/lib/secrets.sh) is the repo's one .env writer with
# the right discipline: it resolves a symlinked $ENV_FILE and renames onto the
# REAL target so the link survives, strips-and-appends with printf (no sed, so
# every byte of the value lands literally), normalizes a missing trailing
# newline first, and stages under umask 077 + chmod 600. Hard-fail when the
# lib cannot be found rather than fall back to a clobbering writer — same
# "refuse loudly" posture as the validation above. The LIB_DIR fallback chain
# mirrors droplet-set-public-fqdn.sh: the repo-checkout location first, then
# $REPO_ROOT/scripts/lib for the /usr/local/sbin installed copy.
LIB_DIR="$SCRIPT_DIR/../lib"
if [ ! -f "$LIB_DIR/secrets.sh" ]; then
  LIB_DIR="$REPO_ROOT/scripts/lib"
fi
[ -f "$LIB_DIR/secrets.sh" ] || die "secrets.sh not found under $LIB_DIR — refusing to rewrite ${ENV_FILE} without the canonical symlink-preserving writer"
# shellcheck source=../lib/secrets.sh
. "$LIB_DIR/secrets.sh"

# Create the file if missing so a brand-new box can still record the choice.
[ -f "$ENV_FILE" ] || { : > "$ENV_FILE"; chmod 0600 "$ENV_FILE"; }

_desired="NVR_MEDIA_SOURCE=${TARGET}"
_changed=true
if grep -qxF "$_desired" "$ENV_FILE"; then
  _changed=false  # already current — no rewrite (keeps re-runs byte-identical)
else
  # _upsert_env_kv targets $ENV_FILE when set — which this script always sets
  # (the DROPLET_NVR_MEDIA_ENV_FILE test hook included).
  _upsert_env_kv NVR_MEDIA_SOURCE "$TARGET"
fi
printf 'NVR_MEDIA_SOURCE=%s persisted to %s\n' "$TARGET" "$ENV_FILE"

# --- Recreate frigate so the new target actually takes effect ---------------
# An .env edit does nothing to a running container. The orchestrator has no
# docker socket (ADR-023), which is why this leg lives here on the host.
if [ "${DROPLET_NVR_MEDIA_SKIP_RECREATE:-0}" = "1" ]; then
  printf 'skipping frigate recreate (DROPLET_NVR_MEDIA_SKIP_RECREATE=1)\n'
  exit 0
fi
if [ "$_changed" = "false" ]; then
  printf 'target unchanged — frigate left running\n'
  exit 0
fi
if ! command -v docker >/dev/null 2>&1; then
  err "docker not found — .env was written but frigate was NOT recreated; footage keeps going to the OLD target until it is"
  exit 3
fi
printf 'recreating frigate so the new recordings target takes effect...\n'
if ! docker compose -f "$COMPOSE_FILE" up -d --force-recreate frigate; then
  # Deliberately a DISTINCT non-zero code: the write succeeded, the apply did
  # not. A caller that reports plain success here would be telling the owner
  # their footage moved when it has not.
  err "frigate recreate FAILED — .env now says ${TARGET} but the running container still uses the old target"
  exit 4
fi
printf 'frigate recreated — recordings now go to %s\n' "$TARGET"

exit 0
