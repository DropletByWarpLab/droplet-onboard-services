#!/usr/bin/env bash
# =============================================================================
# WARP-3514 — NVR storage ROOT executor (spool consumer), ADR-070
# =============================================================================
#
# Why this exists: preparing the camera-recordings slice (project id + hard
# limit on <bay>/nvr, then recording NVR_MEDIA_SOURCE) needs root — block
# devices, chattr, quotactl, the bay mounts — but the device-bridge that owns
# the API runs in its own systemd sandbox: User=droplet + ProtectSystem=strict +
# NoNewPrivileges. Same split, same reason, as droplet-storage-pool-apply.sh:
#
#   bridge (droplet, sandboxed)                 this script (root)
#   ─────────────────────────────               ─────────────────────────────
#   writes nvr-spool/request.json       ──►     reads the ONE spooled request
#   into its own StateDirectory                 re-validates every param, then
#   `systemctl start                            runs the repo-tracked writer
#    droplet-nvr-storage-apply.service`         (droplet-set-nvr-media.sh)
#   (polkit: start verb only)           ◄──     writes nvr-spool/result.json
#   reads + deletes result.json                 and removes the request
#
# Operations (request.operation):
#   apply   {fsUuid, mode: reserved|full, limitBytes?}
#             -> writer --apply --fs-uuid <uuid> --mode <mode> [--limit-bytes N]
#   resize  {limitBytes}
#             -> writer --resize <N>
# Nothing else is accepted: migration and old-footage deletion have their own
# unit (droplet-nvr-migrate.service) and are never reachable from here.
#
# ── TRUST BOUNDARY (WARP-843 invariant) ─────────────────────────────────────
# The spool directory is droplet-owned, so request.json is UNTRUSTED input to
# this root script — a compromised bridge (or any droplet-uid process) can
# write whatever it likes there. Therefore:
#   * every param is re-validated HERE (UUID regex, mode enum, integer range)
#     before anything is exec'd, regardless of what the bridge already checked;
#   * the writer is exec'd with an argv ARRAY — no shell string, no eval, no
#     word splitting; a value that passes validation is one argv element;
#   * a request that fails validation never reaches the writer: it becomes a
#     synthesized refusal in the writer's own contract (rc 1, stdout
#     {"ok":false,"code":"bad_request",...}), and the refusal text never echoes
#     the offending value;
#   * the request file is opened O_NOFOLLOW, must be a regular file and is
#     size-capped; the spool directory itself must not be a symlink (root
#     writes result.json into it); request_id is restricted to a conservative
#     charset because it is echoed into the result and the journal.
#
# Exit-code contract (same as the pool executor):
#   0        — a request was consumed and a result written, REGARDLESS of
#              whether the writer succeeded or refused. A refusal must not
#              leave a failed unit behind; the writer's rc/stdout/stderr travel
#              in result.json. A request with invalid params is such a refusal.
#   non-zero — executor-level breakage only: no request, malformed request,
#              unknown operation (and the tamper cases that are the same
#              class: symlinked spool dir / request, non-regular or oversized
#              request, unusable request_id). `systemctl start` then fails and
#              the bridge reports that honestly. No result is written.
#
# Repo-tracked (architecture-guard rule 20) and installed to /usr/local/sbin by
# scripts/install-device-bridge.sh — never hand-placed.
#
# Test hooks (so this is exercisable without root or systemd):
#   DROPLET_NVR_SPOOL_DIR=...   override the spool dir
#                               (default /var/lib/droplet-bridge/nvr-spool)
#   DROPLET_NVR_WRITER=...      override the writer path
#                               (default /usr/local/sbin/droplet-set-nvr-media.sh)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The NVR writer's final mount/quota/source checks and writes serialize with
# pool mutations and the eject path.
# shellcheck source=./droplet-storage-topology-lock.sh
. "$SCRIPT_DIR/droplet-storage-topology-lock.sh"

SPOOL_DIR="${DROPLET_NVR_SPOOL_DIR:-/var/lib/droplet-bridge/nvr-spool}"
WRITER="${DROPLET_NVR_WRITER:-/usr/local/sbin/droplet-set-nvr-media.sh}"
REQ="$SPOOL_DIR/request.json"
RES="$SPOOL_DIR/result.json"

err() { printf 'droplet-nvr-storage-apply: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# Root writes result.json INTO the spool dir, and the droplet user owns that
# dir's parent — so a swapped-in symlink would aim the root write anywhere.
[ ! -L "$SPOOL_DIR" ] || die "spool directory is a symlink — refusing: $SPOOL_DIR"
[ ! -L "$REQ" ] || die "spooled request is a symlink — refusing: $REQ"
[ -f "$REQ" ] || die "no spooled request at $REQ — nothing to apply"

# --- Parse + validate the spooled request --------------------------------------
# One python3 pass (a host dep, same as the pool executor): parse, validate,
# and print a PLAN of newline-separated tokens — every token is validated to a
# charset with no whitespace, so the line protocol cannot be confused by data.
#
#   OK                       REFUSE
#   <request_id>             <request_id>
#   <operation>              <operation>
#   <writer argv, 1/line>    <refusal JSON, one line>
#                            <human message>
#
# Exit codes: 3 malformed, 4 no operation, 5 unknown operation.
parse_request() {
  REQ_PATH="$REQ" python3 - <<'PY'
import json
import os
import re
import stat
import sys

# --- Validators (the load-bearing part: see the mutation tests) -----------------
UUID_RE = re.compile(r"[0-9A-Fa-f][0-9A-Fa-f-]{6,35}")
REQUEST_ID_RE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
OPERATIONS = ("apply", "resize")
MODES = ("reserved", "full")
MAX_LIMIT = 2 ** 62
MAX_REQUEST_BYTES = 65536

EXIT_MALFORMED = 3
EXIT_NO_OPERATION = 4
EXIT_UNKNOWN_OPERATION = 5


def read_request(path):
    # O_NOFOLLOW + fstat on the descriptor we actually read closes the window
    # between the shell-side checks and this open; O_NONBLOCK keeps a FIFO
    # planted in the droplet-writable spool from hanging the unit. The getattr
    # fallbacks only keep this exercisable on a Windows dev host.
    flags = (os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
             | getattr(os, "O_NONBLOCK", 0))
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REQUEST_BYTES:
            raise ValueError("not a regular file within the size cap")
        with os.fdopen(fd, "rb") as fh:
            fd = -1
            raw = fh.read(MAX_REQUEST_BYTES + 1)
    finally:
        if fd != -1:
            os.close(fd)
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("request grew past the size cap")
    return json.loads(raw.decode("utf-8"))


def emit(*lines):
    sys.stdout.reconfigure(newline="\n")
    sys.stdout.write("\n".join(lines) + "\n")
    sys.exit(0)


def valid_limit(value):
    # bool is an int subclass and a float is never a byte count: both refused.
    return (isinstance(value, int) and not isinstance(value, bool)
            and 1 <= value <= MAX_LIMIT)


try:
    data = read_request(os.environ["REQ_PATH"])
except (OSError, ValueError, RecursionError):
    sys.exit(EXIT_MALFORMED)
if not isinstance(data, dict):
    sys.exit(EXIT_MALFORMED)

request_id = data.get("request_id")
if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
    sys.exit(EXIT_MALFORMED)
operation = data.get("operation")
if not isinstance(operation, str) or operation == "":
    sys.exit(EXIT_NO_OPERATION)
if operation not in OPERATIONS:
    sys.exit(EXIT_UNKNOWN_OPERATION)


def refuse(message):
    # The message names the param, never its value: it lands in the journal and
    # in the owner-facing error text.
    body = json.dumps({"ok": False, "code": "bad_request", "message": message},
                      separators=(",", ":"))
    emit("REFUSE", request_id, operation, body, message)


params = data.get("params")
if not isinstance(params, dict):
    params = {}

if operation == "apply":
    fs_uuid = params.get("fsUuid")
    if not (isinstance(fs_uuid, str) and UUID_RE.fullmatch(fs_uuid)):
        refuse("fsUuid must be a filesystem UUID "
               "(hex digits and dashes, 7 to 36 characters)")
    mode = params.get("mode")
    if not (isinstance(mode, str) and mode in MODES):
        refuse("mode must be 'reserved' or 'full'")
    limit = params.get("limitBytes")
    argv = ["--apply", "--fs-uuid", fs_uuid, "--mode", mode]
    if mode == "reserved":
        if not valid_limit(limit):
            refuse("limitBytes must be an integer between 1 and 2^62 "
                   "for mode 'reserved'")
        argv += ["--limit-bytes", str(limit)]
    elif limit is not None and not valid_limit(limit):
        # `full` computes its own limit and never forwards one, but a junk
        # value still means the caller is not our bridge.
        refuse("limitBytes, when given, must be an integer between 1 and 2^62")
else:  # resize
    limit = params.get("limitBytes")
    if not valid_limit(limit):
        refuse("limitBytes must be an integer between 1 and 2^62")
    argv = ["--resize", str(limit)]

emit("OK", request_id, operation, *argv)
PY
}

set +e
PLAN="$(parse_request)"
PARSE_RC=$?
set -e
case "$PARSE_RC" in
  0) ;;
  3) die "malformed request JSON at $REQ" ;;
  4) die "spooled request has no operation" ;;
  5) die "spooled request has an unknown operation (allowed: apply, resize)" ;;
  *) die "could not parse the spooled request at $REQ (python3 rc=$PARSE_RC)" ;;
esac

# `while read` rather than mapfile: portable to bash 3.2 dev hosts.
PLAN_LINES=()
while IFS= read -r _plan_line; do
  PLAN_LINES+=("$_plan_line")
done <<EOF
$PLAN
EOF
PLAN_KIND="${PLAN_LINES[0]}"
REQUEST_ID="${PLAN_LINES[1]}"
OPERATION="${PLAN_LINES[2]}"

# --- Run the writer (or synthesize the refusal), capturing rc / stdout / stderr -
# The writer's own hard pre-flight (mounted, rw, LUKS-backed, not the OS disk,
# quota support, size bounds) is the real gate for a well-formed request;
# running as root is what makes its findmnt/lsblk/chattr probes trustworthy.
OUT_FILE="$(mktemp)"
ERR_FILE="$(mktemp)"
trap 'rm -f "$OUT_FILE" "$ERR_FILE"' EXIT

case "$PLAN_KIND" in
  OK)
    WRITER_ARGV=("${PLAN_LINES[@]:3}")
    set +e
    storage_topology_lock
    LOCK_RC=$?
    set -e
    if [ "$LOCK_RC" -eq 0 ]; then
      set +e
      DROPLET_STORAGE_TOPOLOGY_LOCK_HELD=1 \
        "$WRITER" "${WRITER_ARGV[@]}" >"$OUT_FILE" 2>"$ERR_FILE" </dev/null
      WRITER_RC=$?
      set -e
    elif [ "$LOCK_RC" -eq 1 ]; then
      WRITER_RC=1
      printf '%s\n' '{"ok":false,"code":"busy","message":"another storage operation is in progress"}' >"$OUT_FILE"
      printf '%s\n' "droplet-nvr-storage-apply: topology lock is busy" >"$ERR_FILE"
    else
      WRITER_RC=1
      printf '%s\n' '{"ok":false,"code":"recordings_status_unavailable","message":"recording storage could not be verified"}' >"$OUT_FILE"
      printf '%s\n' "droplet-nvr-storage-apply: topology lock is unavailable" >"$ERR_FILE"
    fi
    ;;
  REFUSE)
    WRITER_RC=1
    printf '%s\n' "${PLAN_LINES[3]}" >"$OUT_FILE"
    printf 'droplet-nvr-storage-apply: %s\n' "${PLAN_LINES[4]}" >"$ERR_FILE"
    ;;
  *)
    die "internal error: unexpected parse result '$PLAN_KIND'"
    ;;
esac

# --- Write the result where the sandboxed bridge can read it -------------------
# Atomic (tmp + mv in the same dir) so the bridge never reads a half-written
# file; owned like the spool dir (droplet) so the bridge can read it back.
# Symlink hardening (PR #554 review, same as the pool executor): this runs as
# ROOT inside a 0700 droplet-owned dir on a FIXED, predictable path. A
# compromised droplet account could pre-plant `result.json.tmp` as a symlink to
# any root file — python's open(..., "w") and GNU chown-by-path both FOLLOW
# symlinks, turning this into an arbitrary-root-file-write/chown primitive.
# So: unlink first, create with O_NOFOLLOW|O_CREAT|O_EXCL (refuses any
# pre-planted entry), set perms/owner on the FD (never by path), and `mv -T` so
# the final rename cannot be redirected either.
RES_TMP="$RES.tmp"
rm -f "$RES_TMP"
SPOOL_UID="$(stat -c %u "$SPOOL_DIR")"
SPOOL_GID="$(stat -c %g "$SPOOL_DIR")"
RC="$WRITER_RC" REQUEST_ID="$REQUEST_ID" OUT_FILE="$OUT_FILE" ERR_FILE="$ERR_FILE" \
RES_TMP="$RES_TMP" SPOOL_UID="$SPOOL_UID" SPOOL_GID="$SPOOL_GID" python3 - <<'PY'
import json, os
with open(os.environ["OUT_FILE"], "r", encoding="utf-8", errors="replace") as fh:
    out = fh.read()
with open(os.environ["ERR_FILE"], "r", encoding="utf-8", errors="replace") as fh:
    err = fh.read()
result = {
    "request_id": os.environ["REQUEST_ID"],
    "rc": int(os.environ["RC"]),
    "stdout": out,
    "stderr": err,
}
path = os.environ["RES_TMP"]
# O_EXCL|O_NOFOLLOW: fail closed if ANYTHING (file or symlink) already sits
# at the path; 0600 from birth so the payload is never group/world-readable.
# O_NOFOLLOW/fchown/fchmod are POSIX-only -- the shipping box is Linux where
# all three exist; the getattr/hasattr fallbacks only keep the script
# exercisable by pytest on a Windows dev host (O_EXCL, the primary
# pre-planted-entry guard, holds on every platform).
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
fd = os.open(path, flags, 0o600)
try:
    # Owner/perms via the fd -- chown/chmod BY PATH would follow a racing
    # symlink swap; the fd pins the inode we just created.
    if hasattr(os, "fchown"):
        os.fchown(fd, int(os.environ["SPOOL_UID"]), int(os.environ["SPOOL_GID"]))
    if hasattr(os, "fchmod"):
        os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fd = -1
        json.dump(result, fh)
finally:
    if fd != -1:
        os.close(fd)
PY
mv -T "$RES_TMP" "$RES"

# Consume the request only after the result is in place, so a crash above
# leaves the request inspectable rather than silently swallowed.
rm -f "$REQ"

if [ "$PLAN_KIND" = "REFUSE" ]; then
  err "refused ${OPERATION} — invalid params (request ${REQUEST_ID})"
else
  err "applied ${OPERATION} (request ${REQUEST_ID}, writer rc=${WRITER_RC})"
fi
exit 0
