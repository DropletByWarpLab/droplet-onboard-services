#!/usr/bin/env bash
# =============================================================================
# ADR-071 slice B — Droplet router/AP/switch PAIRING root executor (spool consumer)
# =============================================================================
#
# The routing service claims a freshly-flashed router's `droplet-ai` account with
# a password it mints (ADR-071 §2.2 step 3). That password must land in
# docker/secrets/<role>_password or the next routing restart loses it. Routing is a
# container and the device-bridge runs as the unprivileged `droplet` user, so the
# write goes through the same split the storage-pool and NVR units use:
#
#   bridge (droplet, sandboxed)                  this script (root)
#   ─────────────────────────────                ─────────────────────────────
#   POST /host/router-pairing {target,password}
#   writes request.json (0600) into a /run  ──►  re-validates target + 32 hex,
#   tmpfs RuntimeDirectory                       writes the secret file (0600,
#   `systemctl start                             owner droplet, temp + atomic
#    droplet-pair-apply.service`                 rename), zeroes + unlinks the
#   (polkit, start verb only)                    spool, then recreates the
#                                                container that reads it once.
#
# Invoked ONLY as ExecStart of droplet-pair-apply.service (root, oneshot, no
# [Install] section), which only the `droplet` user can start (polkit rule in
# services/oled-display/50-droplet-device-bridge.rules) and which the bridge only
# starts after its admin-token-gated POST /host/router-pairing, itself reachable
# only via an owner/admin session at the orchestrator. The password is never
# logged, never put in argv, and never held in a shell variable: python does the
# read, the write and the wipe.
#
# Secret file format: the bare 32 hex characters, NO trailing newline. Routing's
# _load_openwrt_password() strips whitespace, so either would load; no newline
# matches what scripts/lib/secrets.sh writes. For an external router,
# `setup.sh --sync-secrets` keeps a non-empty operator-owned file (WARP-3738), so
# what this writes survives.
#
# Exit-code contract:
#   0        secret written, spool consumed, container recreated
#   non-zero executor failure (no/invalid spool, secret not writable, recreate
#            failed). The spool is wiped on EVERY exit path that read it.
#
# Test hooks (no root, no docker needed):
#   DROPLET_PAIR_SPOOL_DIR=...     spool dir (default /run/droplet-bridge-pair-spool)
#   DROPLET_PAIR_REPO_ROOT=...     checkout (default: derived from droplet.service)
#   DROPLET_PAIR_SECRETS_DIR=...   secret dir (default <repo>/docker/secrets)
#   DROPLET_PAIR_OWNER=...         owner of the secret file (default droplet)
#   DROPLET_PAIR_SKIP_RECREATE=1   do not run docker compose
# =============================================================================
set -euo pipefail

SPOOL_DIR="${DROPLET_PAIR_SPOOL_DIR:-/run/droplet-bridge-pair-spool}"
REQ="$SPOOL_DIR/request.json"
OWNER="${DROPLET_PAIR_OWNER:-droplet}"

err() { printf 'droplet-pair-apply: %s\n' "$*" >&2; }
log() { printf 'droplet-pair-apply: %s\n' "$*"; }
die() { err "$*"; exit 1; }

# Same derivation droplet-reapply-host-integration uses: the checkout is named in
# droplet.service ExecStart (`docker compose -f <repo>/docker/...`).
resolve_checkout() {
  if [ -n "${DROPLET_PAIR_REPO_ROOT:-}" ]; then
    printf '%s' "$DROPLET_PAIR_REPO_ROOT"
    return 0
  fi
  command -v systemctl >/dev/null 2>&1 || return 1
  local execstart token dir
  execstart="$(systemctl show droplet.service -p ExecStart 2>/dev/null)"
  [ -n "$execstart" ] || return 1
  for token in $(printf '%s' "$execstart" | tr ' ;' '\n\n' | grep '^/'); do
    [ -e "$token" ] || continue
    dir="$(dirname "$token")"
    while [ -n "$dir" ] && [ "$dir" != "/" ]; do
      if [ -f "$dir/docker/docker-compose.yml" ]; then
        printf '%s' "$dir"
        return 0
      fi
      dir="$(dirname "$dir")"
    done
  done
  return 1
}

[ -f "$REQ" ] || die "no spooled request at $REQ — nothing to apply"

# The checkout lookup runs before the spool is read; if it fails the spool is
# still wiped (a request nobody can apply must not sit on disk).
wipe_spool() {
  python3 -c '
import os, sys
p = sys.argv[1]
try:
    fd = os.open(p, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.write(fd, b"\0" * os.fstat(fd).st_size)
        os.fsync(fd)
    finally:
        os.close(fd)
except OSError:
    pass
try:
    os.unlink(p)
except OSError:
    pass
' "$REQ" || true
}

if ! REPO_ROOT="$(resolve_checkout)" || [ -z "$REPO_ROOT" ]; then
  wipe_spool
  die "could not locate the checkout (set DROPLET_PAIR_REPO_ROOT); spool wiped"
fi
SECRETS_DIR="${DROPLET_PAIR_SECRETS_DIR:-$REPO_ROOT/docker/secrets}"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"

# --- Consume the spool, write the secret, wipe the spool ----------------------
# The python prints exactly one line on stdout: the validated target. The
# password stays inside python. Its `finally` wipes + unlinks the spool whether
# or not the request was valid.
read -r -d '' PY_APPLY <<'PY' || true
import json, os, re, sys

req_path, secrets_dir, owner = sys.argv[1], sys.argv[2], sys.argv[3]

FILES = {
    "router": "openwrt_password",
    "ap": "ap_openwrt_password",
    "switch": "switch_password",
}
HEX32 = re.compile(r"[0-9a-f]{32}")
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


def wipe(path):
    try:
        fd = os.open(path, os.O_WRONLY | NOFOLLOW)
        try:
            os.write(fd, b"\0" * os.fstat(fd).st_size)
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass
    try:
        os.unlink(path)
    except OSError:
        pass


rc = 1
try:
    fd = os.open(req_path, os.O_RDONLY | NOFOLLOW)
    with os.fdopen(fd, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("request is not an object")
    target = data.get("target")
    password = data.get("password")
    if target not in FILES:
        raise ValueError("target must be one of router, ap, switch")
    if not isinstance(password, str) or not HEX32.fullmatch(password):
        raise ValueError("password must be exactly 32 lowercase hex characters")

    os.makedirs(secrets_dir, mode=0o700, exist_ok=True)
    dest = os.path.join(secrets_dir, FILES[target])
    tmp = "%s.pair.%d" % (dest, os.getpid())
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    # O_EXCL|O_NOFOLLOW: refuse any pre-planted entry (this runs as root in a
    # droplet-owned directory). Owner and mode are set on the fd, never by path.
    wfd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
    try:
        if hasattr(os, "fchown"):
            import pwd
            pw = pwd.getpwnam(owner)
            os.fchown(wfd, pw.pw_uid, pw.pw_gid)
        if hasattr(os, "fchmod"):
            os.fchmod(wfd, 0o600)
        os.write(wfd, password.encode("ascii"))  # no trailing newline
        os.fsync(wfd)
    except BaseException:
        os.close(wfd)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    os.close(wfd)
    os.replace(tmp, dest)  # atomic rename within one directory
    sys.stdout.write(target)
    rc = 0
except Exception as exc:  # message never carries the password
    sys.stderr.write("droplet-pair-apply: %s: %s\n" % (type(exc).__name__, exc
                     if isinstance(exc, ValueError) else "see exception type"))
finally:
    wipe(req_path)
sys.exit(rc)
PY

TARGET="$(python3 -c "$PY_APPLY" "$REQ" "$SECRETS_DIR" "$OWNER")" \
  || die "spool rejected or secret not written (spool wiped)"

case "$TARGET" in
  router|ap) CONTAINER=routing ;;
  switch)    CONTAINER=switch ;;
  *) die "internal: unexpected target" ;;
esac
log "wrote the $TARGET secret (0600, owner $OWNER); spool wiped"

if [ "${DROPLET_PAIR_SKIP_RECREATE:-0}" = "1" ]; then
  log "skipping $CONTAINER recreate (DROPLET_PAIR_SKIP_RECREATE=1)"
  exit 0
fi
command -v docker >/dev/null 2>&1 \
  || die "docker not found — the secret was written but $CONTAINER was NOT recreated"
# routing reads the secret once at import and the compose secret is a file bind,
# so only a recreate picks the new value up.
if ! docker compose -p droplet -f "$COMPOSE_FILE" up -d --no-deps --force-recreate "$CONTAINER"; then
  die "$CONTAINER recreate FAILED — the secret is on disk but the running container still holds the old one"
fi
log "$CONTAINER recreated"
exit 0
