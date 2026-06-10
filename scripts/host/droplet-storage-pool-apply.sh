#!/usr/bin/env bash
# =============================================================================
# ADR-019 follow-up — Droplet storage-pool ROOT executor (spool consumer)
# =============================================================================
#
# Why this exists: the device-bridge runs droplet-storage-pool.sh from inside
# its own systemd sandbox — User=droplet + ProtectSystem=strict +
# NoNewPrivileges — where mdadm/mkfs/wipefs/mount ALL fail (EPERM on the
# root:disk 0660 block devices, EROFS under /mnt) and the blkid "has data"
# pre-flight probe silently degrades (an unprivileged blkid can't open the
# device, prints nothing, and the guard passes). So a real pool op could never
# succeed under that unit; verified on the shipping box. Same class of problem
# as the WARP-808 hostapd Wi-Fi write, but mdadm is a direct binary — there is
# no unit to polkit-restart — so the split is different:
#
#   bridge (droplet, sandboxed)                 this script (root)
#   ─────────────────────────────               ─────────────────────────────
#   writes pool-spool/request.json      ──►     reads the ONE spooled request
#   into its own StateDirectory                 runs droplet-storage-pool.sh
#   `systemctl start                            (whose hard pre-flight is the
#    droplet-storage-pool-apply.service`        last safety gate — and whose
#   (authorized by the narrowly-scoped          blkid/findmnt/lsblk probes now
#    polkit rule, start verb only;              actually work, because root)
#    NoNewPrivileges stays on)          ◄──     writes pool-spool/result.json
#   reads + deletes result.json                 and removes the request
#
# Invoked ONLY as ExecStart of droplet-storage-pool-apply.service (root,
# oneshot), which ONLY the droplet user can start (polkit rule
# 50-droplet-device-bridge.rules) and which the bridge only starts after its
# auth-gated POST /pools/command — itself reachable only via an owner session
# + a single-use confirm token at the orchestrator. The AI can never reach
# this. The spool directory lives inside the bridge's 0700 droplet-owned
# StateDirectory, so only the bridge (or root) can place a request there.
#
# Exit-code contract:
#   0        — a request was consumed and a result was written, REGARDLESS of
#              whether the pool op itself succeeded or was refused. The op's
#              rc/stdout/stderr travel in result.json; a refused confirm
#              phrase must not leave a "failed" unit behind.
#   non-zero — executor-level breakage only (no spooled request, malformed
#              request JSON). `systemctl start` then fails and the bridge
#              surfaces that honestly.
#
# Repo-tracked (architecture-guard rule 20) and installed to /usr/local/sbin
# by setup.sh via scripts/install-device-bridge.sh — never hand-placed.
#
# Test/dev hooks (so this is unit-testable without root or systemd):
#   DROPLET_POOL_SPOOL_DIR=...   override the spool dir
#                                (default /var/lib/droplet-bridge/pool-spool)
#   DROPLET_POOL_SCRIPT=...      override the pool script path
#                                (default /usr/local/sbin/droplet-storage-pool.sh)
# =============================================================================
set -euo pipefail

SPOOL_DIR="${DROPLET_POOL_SPOOL_DIR:-/var/lib/droplet-bridge/pool-spool}"
POOL_SCRIPT="${DROPLET_POOL_SCRIPT:-/usr/local/sbin/droplet-storage-pool.sh}"
REQ="$SPOOL_DIR/request.json"
RES="$SPOOL_DIR/result.json"

err() { printf 'droplet-storage-pool-apply: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

[ -f "$REQ" ] || die "no spooled request at $REQ — nothing to apply"

# --- Parse the spooled request -------------------------------------------------
# {request_id, operation, params}. Pure json.loads (python3 is a host dep, same
# as droplet-storage-pool.sh's own field extraction); params are re-serialized
# compactly so the pool script receives exactly one JSON argument. A malformed
# request is executor-level breakage: die non-zero, write no result.
parse_request() {
  REQ_PATH="$REQ" python3 - "$1" <<'PY'
import json, os, sys
key = sys.argv[1]
with open(os.environ["REQ_PATH"], "r", encoding="utf-8") as fh:
    data = json.load(fh)
if not isinstance(data, dict):
    sys.exit(3)
val = data.get(key)
sys.stdout.reconfigure(newline="\n")
if key == "params":
    sys.stdout.write(json.dumps(val if isinstance(val, dict) else {}))
elif val is not None:
    sys.stdout.write(str(val))
PY
}

if ! REQUEST_ID="$(parse_request request_id)"; then
  die "malformed request JSON at $REQ"
fi
OPERATION="$(parse_request operation)"
PARAMS_JSON="$(parse_request params)"
[ -n "$OPERATION" ] || die "spooled request has no operation"

# --- Run the pool script, capturing rc / stdout / stderr -----------------------
# The pool script's own allow-list + hard pre-flight (typed double-confirm,
# refuse mounted / has-data / OS-disk) is the real gate — running as root here
# is precisely what makes those blkid/findmnt probes trustworthy.
OUT_FILE="$(mktemp)"
ERR_FILE="$(mktemp)"
trap 'rm -f "$OUT_FILE" "$ERR_FILE"' EXIT
set +e
"$POOL_SCRIPT" "$OPERATION" "$PARAMS_JSON" >"$OUT_FILE" 2>"$ERR_FILE"
POOL_RC=$?
set -e

# --- Write the result where the sandboxed bridge can read it -------------------
# Atomic (tmp + mv in the same dir) so the bridge never reads a half-written
# file; owned like the spool dir (droplet) so the bridge can read it back.
# Symlink hardening (PR #554 review): this runs as ROOT inside a 0700
# droplet-owned dir on a FIXED, predictable path. A compromised droplet
# account could pre-plant `result.json.tmp` as a symlink to any root file --
# python's open(..., "w") and GNU chown-by-path both FOLLOW symlinks, turning
# this into an arbitrary-root-file-write/chown primitive. So: unlink first,
# create with O_NOFOLLOW|O_CREAT|O_EXCL (refuses any pre-planted entry), set
# perms/owner on the FD (never by path), and `mv -T` so the final rename
# cannot be redirected either.
RES_TMP="$RES.tmp"
rm -f "$RES_TMP"
SPOOL_UID="$(stat -c %u "$SPOOL_DIR")"
SPOOL_GID="$(stat -c %g "$SPOOL_DIR")"
RC="$POOL_RC" REQUEST_ID="$REQUEST_ID" OUT_FILE="$OUT_FILE" ERR_FILE="$ERR_FILE" \
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

err "applied ${OPERATION} (request ${REQUEST_ID}, pool-script rc=${POOL_RC})"
exit 0
