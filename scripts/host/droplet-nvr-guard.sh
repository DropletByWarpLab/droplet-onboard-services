#!/usr/bin/env bash
# =============================================================================
# WARP-3514 — NVR boot guard (ADR-070): Frigate must never start writing to the
# OS disk because the recordings bay mounted late
# =============================================================================
#
# The reboot scenario. Camera recordings live on a dedicated, encrypted bay
# drive: NVR_MEDIA_SOURCE=/mnt/droplet/<label>-<uuid8>/nvr, bind-mounted into
# Frigate by the compose seam `${NVR_MEDIA_SOURCE:-nvrdata}:/media/frigate`.
# After a reboot the bay is mounted by droplet-automount@, which is ordered
# After=docker.service — so Docker, and Frigate with `restart: always`, come up
# BEFORE the bay does. The bind source /mnt/droplet/<tail>/nvr does not exist
# yet, Docker silently creates it on the ROOT filesystem and Frigate happily
# records 24/7 video onto the OS disk until the box falls over. The mount that
# arrives a minute later hides that directory but does not move the running
# container, which keeps writing to the hidden copy.
#
# This script closes that window with two halves:
#
#   arm      (boot, droplet-nvr-guard.service, Before=docker.service)
#            If the bay is NOT mounted yet, create an immutable EMPTY directory
#            at the recordings path on the root filesystem. Frigate then gets
#            EPERM — a loud, harmless failure — instead of silently filling `/`.
#            The real bay mounts over its parent directory later and hides it.
#   release  (droplet-nvr-guard-release.timer, every ~30 s, After=docker.service)
#            Once the bay has mounted and <source> exists on it, restart Frigate
#            ONCE so it re-binds the real directory, then disarm. A no-op unless
#            armed; deferred while a migration job is running.
#   disarm   (factory-reset) remove the placeholder and the state.
#   status   print the root-only state.
#
# It must never block boot and must be idempotent; every failure path logs
# loudly and exits 0.
#
# ── TRUST BOUNDARY (WARP-843 invariant) ─────────────────────────────────────
# NVR_MEDIA_SOURCE comes from the repo .env, which is DROPLET-WRITABLE, and this
# script runs as ROOT, creating a directory and setting the immutable flag on
# whatever that value names. So the value is treated as hostile:
#   * it is only READ and parsed (grep), never sourced or evaluated;
#   * only a value that is EXACTLY <base>/<tail>/nvr is ever acted on, where
#     <tail> matches [A-Za-z0-9][A-Za-z0-9._-]* — no `..`, no extra slash, no
#     whitespace or shell metacharacters — AND no existing component of the path
#     (from /) is a symlink (the bay's mount root is droplet-owned once mounted);
#   * anything else — a named volume, another path, garbage — clears the state
#     and exits 0, touching nothing;
#   * the placeholder is created only on the ROOT filesystem and only ever
#     marked immutable while it is an EMPTY directory on the root filesystem,
#     so a bay that is actually mounted can never be frozen;
#   * guard.json lives in a root-only directory, but release/disarm act on the
#     path inside it, so it is validated exactly like the .env value, and
#     bayRoot is always DERIVED from source, never read back.
#
# Design notes worth knowing before changing anything:
#   * The LAST ^NVR_MEDIA_SOURCE= line wins: Docker Compose's dotenv takes the
#     last assignment of a duplicated key (verified against compose), and the
#     guard has to protect the path Frigate will actually bind.
#   * "Bay mounted" means a mountpoint of a DIFFERENT filesystem than `/`.
#     /mnt/droplet is itself a bind mount of the root fs (mnt-droplet.mount), so
#     "is a mountpoint" alone proves nothing. Unknown ⇒ not mounted: the guard
#     never guesses that the bay is present.
#   * A migration job (droplet-nvr-migrate.service) is Type=oneshot, so while it
#     runs it is `activating`, for which `systemctl is-active` exits NON-zero;
#     release reads the state string, not just the exit code, so it never
#     restarts Frigate underneath the job that is stopping and starting it.
#   * arm never downgrades a pending armed:true for the same source to false
#     when the bay is already up: a `systemctl restart` of the guard after the
#     bay mounted but before the first release tick must not drop the pending
#     Frigate restart (that would leave Frigate on the EPERM placeholder).
#   * An immutable flag on a directory does not reach its subdirectories, so a
#     NON-empty root-fs <source> (footage Docker wrote before the guard existed)
#     is left alone and reported loudly; release still fires when the bay
#     mounts.
#
# State (root-only dir, never droplet-readable/writable):
#   $DROPLET_NVR_ROOT_STATE_DIR/guard.json
#   {"armed":bool,"source":"…","bayRoot":"…","since":"ISO"}
#
# Repo-tracked (architecture-guard rule 20) and installed to /usr/local/sbin by
# scripts/install-device-bridge.sh — never hand-placed.
#
# Test hooks (so this is exercisable without root, a bay or docker):
#   DROPLET_NVR_ROOT_STATE_DIR=...   default /var/lib/droplet-nvr
#   DROPLET_NVR_MEDIA_ENV_FILE=...   default <repo>/.env
#   DROPLET_NVR_MOUNT_BASE=...       default /mnt/droplet
#   plus PATH shims for mountpoint / stat / chattr / docker / systemctl.
# =============================================================================
set -euo pipefail
export LC_ALL=C

SUBCMD="${1:-}"

MOUNT_BASE="${DROPLET_NVR_MOUNT_BASE:-/mnt/droplet}"
MOUNT_BASE="${MOUNT_BASE%/}"
ROOT_STATE_DIR="${DROPLET_NVR_ROOT_STATE_DIR:-/var/lib/droplet-nvr}"
STATE_FILE="$ROOT_STATE_DIR/guard.json"
MIGRATE_UNIT="droplet-nvr-migrate.service"
FRIGATE_LABEL="com.docker.compose.service=frigate"

# The only recordings path the guard will ever act on, relative to the base.
NVR_REST_RE='^[A-Za-z0-9][A-Za-z0-9._-]*/nvr$'
# Container ids as `docker ps -q` prints them (lowercase hex).
CONTAINER_ID_RE='^[0-9a-f]{12,64}$'
SINCE_RE='^[0-9A-Za-z:.+-]{0,40}$'

err()  { printf 'droplet-nvr-guard: %s\n' "$*" >&2; }
info() { err "$*"; }
warn() { err "WARNING: $*"; }

case "$MOUNT_BASE" in
  /?*) ;;
  *) err "invalid DROPLET_NVR_MOUNT_BASE — must be an absolute path"; exit 2 ;;
esac

# Printable, bounded rendering of an untrusted value for the journal (no
# control characters or escape sequences, no unbounded length).
safe_str() {
  local s="${1//[^[:print:]]/?}"
  printf '%.100s' "$s"
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- Path validation -------------------------------------------------------------

# Shape: exactly <MOUNT_BASE>/<tail>/nvr and nothing more.
source_shape_ok() {
  local p="$1" rest
  [[ "$p" == "$MOUNT_BASE"/* ]] || return 1
  rest="${p#"$MOUNT_BASE"/}"
  [[ "$rest" =~ $NVR_REST_RE ]] || return 1
  return 0
}

# No component of the path that exists — from / down — may be a symlink. A
# component that does not exist yet cannot be one.
no_symlink_components() {
  local p="$1" cur="" part
  local -a parts=()
  IFS=/ read -r -a parts <<<"${p#/}"
  for part in ${parts[@]+"${parts[@]}"}; do
    [ -n "$part" ] || continue
    cur="$cur/$part"
    if [ -L "$cur" ]; then
      return 1
    fi
  done
  return 0
}

valid_source() {
  local p="$1"
  source_shape_ok "$p" || return 1
  no_symlink_components "$p" || return 1
  return 0
}

# --- Filesystem probes -----------------------------------------------------------

# st_dev of a path, empty when it cannot be determined.
dev_of() { stat -c %d -- "$1" 2>/dev/null || true; }

# True iff $1 is a mountpoint of a DIFFERENT filesystem than /. Unknown ⇒ false.
bay_present() {
  local root_dev bay_dev
  mountpoint -q -- "$1" 2>/dev/null || return 1
  root_dev="$(dev_of /)"
  bay_dev="$(dev_of "$1")"
  [ -n "$root_dev" ] && [ -n "$bay_dev" ] && [ "$root_dev" != "$bay_dev" ]
}

# The deepest existing directory on the way up to $1 ("/" if none).
nearest_existing_dir() {
  local d="$1"
  while [ -n "$d" ] && [ ! -d "$d" ]; do
    case "$d" in
      */*) d="${d%/*}" ;;
      *) d="." ;;
    esac
  done
  printf '%s' "${d:-/}"
}

# True iff directory $1 has no entries. A find error is "not empty" (fail safe).
dir_is_empty() {
  local first
  first="$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" || return 1
  [ -z "$first" ]
}

# --- State -----------------------------------------------------------------------

ST_ARMED=""
ST_SOURCE=""
ST_SINCE=""

# Prints "<armed>\n<source>\n<since>\n" for a well-formed state file, exits 1
# otherwise. Pure json.loads, so the reader does not depend on the guard's own
# compact formatting.
state_fields() {
  python3 - "$1" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.loads(fh.read(65536))
except Exception:
    sys.exit(1)
if not isinstance(data, dict):
    sys.exit(1)
armed = data.get("armed")
source = data.get("source")
since = data.get("since", "")
if not (isinstance(armed, bool) and isinstance(source, str)
        and isinstance(since, str)):
    sys.exit(1)
if "\n" in source or "\n" in since:
    sys.exit(1)
sys.stdout.reconfigure(newline="\n")
sys.stdout.write("%s\n%s\n%s\n" % ("true" if armed else "false", source, since))
PY
}

# Sets ST_ARMED / ST_SOURCE / ST_SINCE, all empty unless the state is
# well-formed AND its source passes the shape check. bayRoot is not read.
read_state() {
  ST_ARMED=""
  ST_SOURCE=""
  ST_SINCE=""
  [ -f "$STATE_FILE" ] && [ ! -L "$STATE_FILE" ] || return 0
  local out armed src since
  out="$(state_fields "$STATE_FILE" 2>/dev/null)" || return 0
  { IFS= read -r armed; IFS= read -r src; IFS= read -r since; } <<EOF
$out
EOF
  case "$armed" in true|false) ;; *) return 0 ;; esac
  source_shape_ok "$src" || return 0
  [[ "$since" =~ $SINCE_RE ]] || since=""
  ST_ARMED="$armed"
  ST_SOURCE="$src"
  ST_SINCE="$since"
}

# write_state <true|false> <source> <since> — atomic, root-only. Every value is
# already validated to a charset that needs no JSON escaping.
write_state() {
  local armed="$1" src="$2" since="$3" tmp
  if [ -L "$ROOT_STATE_DIR" ]; then
    warn "state directory $ROOT_STATE_DIR is a symlink — not recording guard state"
    return 1
  fi
  if [ ! -d "$ROOT_STATE_DIR" ]; then
    # shellcheck disable=SC2174 # the 0700 is meant for the final directory only; parents keep the default mode
    mkdir -p -m 0700 -- "$ROOT_STATE_DIR" 2>/dev/null \
      || { warn "cannot create the guard state directory $ROOT_STATE_DIR"; return 1; }
  fi
  tmp="$STATE_FILE.tmp.$$"
  if ! ( umask 077
         printf '{"armed":%s,"source":"%s","bayRoot":"%s","since":"%s"}\n' \
           "$armed" "$src" "${src%/nvr}" "$since" >"$tmp" ) 2>/dev/null; then
    rm -f -- "$tmp"
    warn "cannot write the guard state under $ROOT_STATE_DIR"
    return 1
  fi
  if ! mv -f -T -- "$tmp" "$STATE_FILE" 2>/dev/null; then
    rm -f -- "$tmp"
    warn "cannot install the guard state file $STATE_FILE"
    return 1
  fi
  return 0
}

clear_state() { rm -f -- "$STATE_FILE" 2>/dev/null || true; }

# --- .env ------------------------------------------------------------------------

ENV_FILE=""
resolve_env_file() {
  if [ -n "${DROPLET_NVR_MEDIA_ENV_FILE:-}" ]; then
    ENV_FILE="$DROPLET_NVR_MEDIA_ENV_FILE"
    return 0
  fi
  local script_dir repo_root
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="${REPO_ROOT:-}"
  if [ -z "$repo_root" ]; then
    if [ -f "$script_dir/../../docker/docker-compose.yml" ]; then
      repo_root="$(cd "$script_dir/../.." && pwd)"
    else
      repo_root="/home/droplet/edge-platform"
    fi
  fi
  ENV_FILE="$repo_root/.env"
}

# The effective NVR_MEDIA_SOURCE: the LAST ^NVR_MEDIA_SOURCE= line (compose's
# dotenv takes the last assignment of a duplicated key), CR stripped, ONE pair
# of surrounding quotes stripped. Prints nothing when absent or unreadable.
read_env_source() {
  [ -f "$ENV_FILE" ] || return 0
  local line
  line="$(grep -a '^NVR_MEDIA_SOURCE=' "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  line="${line#NVR_MEDIA_SOURCE=}"
  line="${line%$'\r'}"
  case "$line" in
    \"*\") line="${line#\"}"; line="${line%\"}" ;;
    \'*\') line="${line#\'}"; line="${line%\'}" ;;
  esac
  printf '%s' "$line"
}

# --- arm -------------------------------------------------------------------------

# Create the immutable EMPTY placeholder at <src> on the root filesystem. Returns
# 0 when it is in place and immutable, 1 when recordings are NOT guarded (always
# logged loudly). Never touches anything that is not an empty directory on the
# root filesystem.
ensure_placeholder() {
  local src="$1" root_dev anc created=0
  root_dev="$(dev_of /)"
  if [ -z "$root_dev" ]; then
    warn "cannot determine the root filesystem device — not creating the placeholder $src; recordings are NOT guarded"
    return 1
  fi
  if [ -e "$src" ] || [ -L "$src" ]; then
    if [ ! -d "$src" ] || [ -L "$src" ]; then
      warn "$src exists and is not a plain directory — leaving it alone; recordings are NOT guarded"
      return 1
    fi
  else
    anc="$(nearest_existing_dir "$src")"
    if [ "$(dev_of "$anc")" != "$root_dev" ]; then
      warn "$anc is not on the root filesystem — not creating the placeholder $src; recordings are NOT guarded"
      return 1
    fi
    # shellcheck disable=SC2174 # 0700 is meant for the placeholder itself; the mount-tail parent keeps the default mode
    if ! mkdir -p -m 0700 -- "$src"; then
      warn "could not create the placeholder $src; recordings are NOT guarded"
      return 1
    fi
    created=1
  fi
  [ "$(dev_of "$src")" = "$root_dev" ] || { warn "$src is not on the root filesystem — refusing to mark it immutable; recordings are NOT guarded"; return 1; }
  dir_is_empty "$src" || { warn "$src is on the root filesystem and is not empty — cannot guard it (an immutable directory does not protect its subdirectories); recordings are NOT guarded until the bay mounts"; return 1; }
  if chattr +i "$src"; then
    info "placeholder $src is in place and immutable — Frigate cannot write to the OS disk until the bay mounts"
    return 0
  fi
  warn "chattr +i failed on $src — could not make the placeholder immutable; recordings are NOT guarded"
  if [ "$created" = 1 ]; then
    rmdir -- "$src" 2>/dev/null || true
  fi
  return 1
}

cmd_arm() {
  local src bay_root since bay_up=0 pending=0
  resolve_env_file
  src="$(read_env_source)"
  if ! valid_source "$src"; then
    clear_state
    if [ -n "$src" ]; then
      info "NVR_MEDIA_SOURCE ($(safe_str "$src")) is not a recordings-bay path — nothing to guard"
    else
      info "NVR_MEDIA_SOURCE is not set — nothing to guard"
    fi
    return 0
  fi
  bay_root="${src%/nvr}"

  if bay_present "$bay_root"; then
    bay_up=1
  fi
  read_state
  since="$(now)"
  if [ "$ST_ARMED" = "true" ] && [ "$ST_SOURCE" = "$src" ]; then
    # A previous arm for this very source is still waiting for its release:
    # keep its start time, and never downgrade it (see the header notes).
    pending=1
    if [ -n "$ST_SINCE" ]; then
      since="$ST_SINCE"
    fi
  fi

  if [ "$bay_up" = 1 ]; then
    if [ "$pending" = 1 ]; then
      info "recordings bay already mounted at $bay_root; a release is pending — leaving the guard armed"
    else
      write_state false "$src" "$since" || true
      info "recordings bay already mounted at $bay_root — nothing to guard"
    fi
    return 0
  fi

  ensure_placeholder "$src" || true
  write_state true "$src" "$since" \
    || warn "could not record the guard state — release will not fire; Frigate may need a manual restart once the bay mounts"
  return 0
}

# --- release ---------------------------------------------------------------------

# True while the migration job is running. A running oneshot is `activating`
# (exit 3 from is-active), so the printed state matters, not just the exit code.
migration_busy() {
  command -v systemctl >/dev/null 2>&1 || return 1
  local st rc=0
  st="$(systemctl is-active "$MIGRATE_UNIT" 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  case "$st" in
    activating|reloading|deactivating) return 0 ;;
  esac
  return 1
}

# Restart every running frigate container. Returns 0 when release may disarm
# (restarted, or there is no container to restart), 1 to stay armed and retry.
restart_frigate() {
  local ids id ok=1
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not found — staying armed, will retry"
    return 1
  fi
  if ! ids="$(docker ps -q --filter "label=$FRIGATE_LABEL" 2>/dev/null)"; then
    warn "docker is unavailable — staying armed, will retry"
    return 1
  fi
  if [ -z "$ids" ]; then
    info "no running frigate container — nothing to restart; disarming"
    return 0
  fi
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if ! [[ "$id" =~ $CONTAINER_ID_RE ]]; then
      warn "ignoring an unexpected container id from docker"
      ok=0
      continue
    fi
    info "recordings bay is mounted — restarting frigate container $id so it re-binds the real directory"
    if ! docker restart "$id" >/dev/null; then
      warn "docker restart $id failed"
      ok=0
    fi
  done <<EOF
$ids
EOF
  [ "$ok" = 1 ]
}

cmd_release() {
  local bay_root
  [ -f "$STATE_FILE" ] || return 0
  # Fast path for the overwhelmingly common tick: nothing is armed.
  grep -q '"armed"[[:space:]]*:[[:space:]]*true' "$STATE_FILE" 2>/dev/null || return 0
  read_state
  if [ "$ST_ARMED" != "true" ]; then
    warn "the guard state says armed but could not be read or validated — not releasing; Frigate may need a manual restart once the bay mounts"
    return 0
  fi
  if ! valid_source "$ST_SOURCE"; then
    warn "recorded guard source $(safe_str "$ST_SOURCE") failed validation (symlink component?) — not releasing"
    return 0
  fi
  bay_root="${ST_SOURCE%/nvr}"
  bay_present "$bay_root" || return 0            # still waiting for the bay: silent
  if migration_busy; then
    info "a recordings migration is running — release deferred"
    return 0
  fi
  if [ ! -d "$ST_SOURCE" ]; then
    warn "recordings bay is mounted at $bay_root but $ST_SOURCE is missing or not a directory — staying armed (the allocator re-applies the target)"
    return 0
  fi
  restart_frigate || return 0
  write_state false "$ST_SOURCE" "$(now)" \
    || warn "frigate was restarted but the guard could not be disarmed — it will restart it again on the next tick"
  return 0
}

# --- disarm ----------------------------------------------------------------------

# Remove the placeholder iff it still lives on the root filesystem and is empty
# — once the bay is mounted, <src> is the bay's REAL directory and is never
# touched — and the mount-tail directory above it iff that is also a plain,
# empty, unmounted directory on the root filesystem.
remove_placeholder() {
  local src="$1" bay_root="${1%/nvr}" root_dev
  root_dev="$(dev_of /)"
  if [ -z "$root_dev" ]; then
    warn "cannot determine the root filesystem device — leaving $src in place"
    return 0
  fi
  if [ -d "$src" ] && [ ! -L "$src" ] && [ "$(dev_of "$src")" = "$root_dev" ] && dir_is_empty "$src"; then
    chattr -i "$src" || warn "chattr -i failed on $src"
    rmdir -- "$src" 2>/dev/null || warn "could not remove the placeholder $src"
    if [ -d "$bay_root" ] && [ ! -L "$bay_root" ] \
       && [ "$(dev_of "$bay_root")" = "$root_dev" ] \
       && ! mountpoint -q -- "$bay_root" 2>/dev/null \
       && dir_is_empty "$bay_root"; then
      rmdir -- "$bay_root" 2>/dev/null || true
    fi
    info "removed the placeholder $src"
  else
    info "no removable placeholder at $src (mounted bay, non-empty, or already gone) — left as is"
  fi
  return 0
}

cmd_disarm() {
  read_state
  if [ -n "$ST_SOURCE" ]; then
    if valid_source "$ST_SOURCE"; then
      remove_placeholder "$ST_SOURCE"
    else
      warn "recorded guard source $(safe_str "$ST_SOURCE") failed validation — not touching the filesystem"
    fi
  fi
  clear_state
  return 0
}

# --- status ----------------------------------------------------------------------

cmd_status() {
  if [ -e "$ROOT_STATE_DIR" ] && [ ! -x "$ROOT_STATE_DIR" ]; then
    warn "cannot read $ROOT_STATE_DIR — run as root"
  fi
  read_state
  if [ -n "$ST_ARMED" ]; then
    printf '{"armed":%s,"source":"%s","bayRoot":"%s","since":"%s"}\n' \
      "$ST_ARMED" "$ST_SOURCE" "${ST_SOURCE%/nvr}" "$ST_SINCE"
  else
    printf '{"armed":false}\n'
  fi
  return 0
}

# --- dispatch --------------------------------------------------------------------
# arm / release / disarm swallow their own unexpected errors (logged): the guard
# must never fail a boot or leave a failed timer tick behind.
case "$SUBCMD" in
  arm)     cmd_arm     || warn "arm hit an unexpected error — boot continues; recordings may be unguarded" ;;
  release) cmd_release || warn "release hit an unexpected error — will retry on the next tick" ;;
  disarm)  cmd_disarm  || warn "disarm hit an unexpected error" ;;
  status)  cmd_status ;;
  *)
    printf 'usage: %s arm|release|disarm|status\n' "$(basename "$0")" >&2
    exit 2
    ;;
esac
exit 0
