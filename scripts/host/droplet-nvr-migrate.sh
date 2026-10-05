#!/usr/bin/env bash
# =============================================================================
# WARP-3514 — NVR recordings MIGRATION / OLD-FOOTAGE-DELETE root job (ADR-070)
# =============================================================================
#
# Camera recordings never live on the OS disk (ADR-070). Once the writer
# (droplet-set-nvr-media.sh --apply) has pointed NVR_MEDIA_SOURCE at the bay
# drive's `nvr/` directory, THIS job moves the footage Frigate already recorded
# from its old home onto the new one — live, while cameras keep recording —
# and puts Frigate on the new drive. It also deletes the kept old footage when
# the owner confirms (tier 3 at the orchestrator).
#
#   bridge (droplet, sandboxed)                 this script (root)
#   ─────────────────────────────               ─────────────────────────────
#   writes nvr-spool/migrate-request.json ──►   reads + validates the ONE request
#   `systemctl start --no-block                 does the job as root
#    droplet-nvr-migrate.service`               rewrites nvr-spool/migrate-state.json
#   (polkit: start verb only)           ◄──     (progress, then done | failed)
#   GET /host/nvr-storage/migrate reads the state file
#
# Invoked ONLY as ExecStart of droplet-nvr-migrate.service (root, oneshot,
# TimeoutStartSec=infinity), which only the droplet user can start and which
# the bridge only starts after an owner-confirmed request. Repo-tracked
# (architecture-guard rule 20) and installed to /usr/local/sbin by
# scripts/install-device-bridge.sh — never hand-placed on a box.
#
# ── Trust model (WARP-843 invariant) ────────────────────────────────────────
# The spool directory and the repo .env are droplet-WRITABLE, therefore
# UNTRUSTED: the request is parsed from an fd opened O_NOFOLLOW inside a
# directory pinned by fd, size-capped, and every field is regex/enum
# validated BEFORE anything runs; nothing the request says ever becomes a path
# (the new location comes from `findmnt` for a validated uuid, the old one from
# `docker inspect` of the frigate container); every external command is an argv
# array and there is no eval. The `.env` value is only ever COMPARED, or
# written back from a value this script derived and validated itself. The
# state file is written the hardened way (unlink tmp, O_CREAT|O_EXCL|O_NOFOLLOW
# 0600, fchown to the spool dir's owner through the fd, rename inside the
# pinned directory). What `delete_old` may delete is decided ONLY by the
# root-only record /var/lib/droplet-nvr/migration.json (never droplet-writable,
# refused if it is not owned by root or is group/world writable).
#
# ── migrate ─────────────────────────────────────────────────────────────────
# NEW = <mount of fsUuid>/nvr (findmnt, must be <mount base>/<tail>) and the
# writer's --apply must have PREPARED exactly that target: the root-only record
# names it as newSource (--apply no longer writes the .env - WARP-3514 decision
# 2026-10-04: ONLY the flip below writes NVR_MEDIA_SOURCE), or the .env already
# says NVR_MEDIA_SOURCE=<NEW> (a re-run after a completed flip); else
# `target_not_applied`.
#   1 preflight  resolve OLD from ground truth: `docker inspect` of the frigate
#                container (label com.docker.compose.service=frigate), the mount
#                at /media/frigate: a volume -> its docker volume directory, a
#                bind -> /mnt/droplet/<tail>/nvr. No container: the root-only
#                record's previousSource. Anything else -> `bad_source`.
#                OLD == NEW means already migrated -> `done` at once (frigate is
#                only started if it is not running).
#                bytesTotal = du -sb OLD. A root rsync BYPASSES the ext4 project
#                quota (CAP_SYS_RESOURCE), so the free space of NEW (a quota'd
#                directory reports the REMAINING quota) is the only thing that
#                prevents overshoot: bytesTotal x 1.1 must fit, crediting bytes
#                a previous attempt already copied (path-preserving, so they are
#                the same files) so a retry can pass a tight reservation.
#   2 copy       live, frigate still running on OLD:
#                rsync -aHAX --numeric-ids --info=progress2 OLD/ NEW/
#                PATH-PRESERVING: container paths under /media/frigate stay
#                identical, so Frigate's database rows stay valid.
#   3 stop       docker stop -t 60 <frigate>      4 delta   same rsync again
#   5 verify     rsync -a --dry-run --itemize-changes OLD/ NEW/ must report
#                nothing left to transfer (the destination root directory's own
#                attributes are excluded: nvr/ stays 0700 root, OLD's root dir is
#                usually 0755 and rsync -a would otherwise widen it).
#   6 flip       NVR_MEDIA_SOURCE=<NEW> in .env (already there, so idempotent),
#                docker compose -f $COMPOSE_FILE up -d --force-recreate frigate,
#                then check the new container runs and mounts NEW.
#   7 done       OLD IS KEPT. The root-only record gains oldSource/previousSource.
# NEVER `--delete`: neither side is ever pruned by the copy.
# Any failure AFTER the stop rolls back: .env goes back to the OLD value and
# frigate is brought back on OLD (docker start of the original container, or a
# recreate when compose had already replaced it); state `failed` + errorCode. A
# failure BEFORE the stop only marks `failed` (frigate was never touched).
# SIGTERM/SIGINT/SIGHUP (systemctl stop) take the same path with `interrupted`.
#
# ── delete_old ──────────────────────────────────────────────────────────────
# Refuses unless the record shows a completed migration with undeleted old
# footage whose source differs from the CURRENT NVR_MEDIA_SOURCE AND from
# whatever the running frigate container actually mounts. A volume goes through
# `docker volume rm <name>` (name validated), a path has its CONTENTS removed
# with `rm -rf --one-file-system` (the nvr/ directory itself, which carries the
# quota project id, stays); the path must be exactly /mnt/droplet/<tail>/nvr.
#
# ── State file (migrate-state.json) ─────────────────────────────────────────
# {"request_id","job":"migrate|delete_old","state":"running|done|failed",
#  "phase":"preflight|copy|stop|delta|verify|flip|start|cleanup|null",
#  "progressPct","bytesCopied","bytesTotal","startedAt","finishedAt","error",
#  "errorCode","oldSource":{"kind":"volume|path","source","bytes","deleted"}|null}
# errorCode: insufficient_space | rsync_missing | docker_unavailable |
#   target_not_applied | bad_source | copy_failed | verify_failed | flip_failed |
#   interrupted | no_old_footage | delete_failed | internal
# `error` text never contains paths or footage names. oldSource is non-null
# only once OLD really is "old" (migration done) and while it is deleted.
# source is the real docker volume name (e.g. droplet_nvrdata) or the bay path.
#
# ── Exit codes ──────────────────────────────────────────────────────────────
#   0  the job reached a terminal state that was recorded (done, or a handled
#      failure whose rollback succeeded) — a refusal must not leave a failed unit
#   1  unexpected internal error, or the rollback could not restart frigate:
#      the unit is left visibly failed
#   2  executor-level breakage: no request / unusable or rejected request
#   3  another migration job holds the lock
#
# Hooks for hermetic tests (names follow DROPLET_<AREA>_...; none is needed on a box):
#   DROPLET_NVR_SPOOL_DIR=...        spool dir (default /var/lib/droplet-bridge/nvr-spool)
#   DROPLET_NVR_ROOT_STATE_DIR=...   root-only dir (default /var/lib/droplet-nvr)
#   DROPLET_NVR_MEDIA_ENV_FILE=...   the repo .env (default <repo>/.env)
#   DROPLET_NVR_MEDIA_COMPOSE_FILE=...  compose file (default <repo>/docker/docker-compose.yml)
#   DROPLET_NVR_MOUNT_BASE=...       bay mount base (default /mnt/droplet)
#   DROPLET_NVR_MEDIA_STATFS=...     command printing "<frsize> <blocks> <bfree> <bavail>"
#                                    for the path in $1 (same hook as the writer)
#   DROPLET_NVR_MIGRATE_PROGRESS_SECS=N      state refresh interval while copying (default 5)
#   DROPLET_NVR_MIGRATE_START_WAIT_SECS=N    how long to wait for frigate after the flip (default 10)
# External commands are resolved through PATH: docker, rsync, findmnt, du, flock.
# =============================================================================
set -euo pipefail
umask 077
# Every tool's output is parsed below; pin the locale (rsync even picks its
# thousands separator from it).
export LC_ALL=C
# `docker compose` interpolates ${NVR_MEDIA_SOURCE:-nvrdata}; a value inherited
# from our environment would beat the .env we are managing.
unset NVR_MEDIA_SOURCE

SPOOL_DIR="${DROPLET_NVR_SPOOL_DIR:-/var/lib/droplet-bridge/nvr-spool}"
ROOT_STATE_DIR="${DROPLET_NVR_ROOT_STATE_DIR:-/var/lib/droplet-nvr}"
MOUNT_BASE="${DROPLET_NVR_MOUNT_BASE:-/mnt/droplet}"
MOUNT_BASE="${MOUNT_BASE%/}"
PROGRESS_SECS="${DROPLET_NVR_MIGRATE_PROGRESS_SECS:-5}"
START_WAIT_SECS="${DROPLET_NVR_MIGRATE_START_WAIT_SECS:-10}"
[[ "$PROGRESS_SECS" =~ ^[0-9]{1,4}$ ]] || PROGRESS_SECS=5
[[ "$START_WAIT_SECS" =~ ^[0-9]{1,4}$ ]] || START_WAIT_SECS=10

err() { printf 'droplet-nvr-migrate: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

command -v python3 >/dev/null 2>&1 || die "python3 not found (needed to read the request and write the state file)"

# --- Resolve the repo root, .env, compose file and the canonical .env writer --
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The migration also performs the legacy NVR_MEDIA_SOURCE flip and rollback.
# Keep that transition under the same lock as pool writes and ejects.
# shellcheck source=./droplet-storage-topology-lock.sh
. "$SCRIPT_DIR/droplet-storage-topology-lock.sh"
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

# _upsert_env_kv (scripts/lib/secrets.sh) is the repo's one .env writer: it
# writes THROUGH a symlinked .env (relocated onto the encrypted /data) and
# lands the value literally. Same lookup chain as droplet-set-nvr-media.sh:
# the repo checkout first, then $REPO_ROOT/scripts/lib for the installed copy.
# Hard-fail without it rather than fall back to a clobbering writer.
LIB_DIR="$SCRIPT_DIR/../lib"
if [ ! -f "$LIB_DIR/secrets.sh" ]; then
  LIB_DIR="$REPO_ROOT/scripts/lib"
fi
[ -f "$LIB_DIR/secrets.sh" ] || die "secrets.sh not found under $LIB_DIR — refusing to rewrite ${ENV_FILE} without the canonical symlink-preserving writer"
# shellcheck source=../lib/secrets.sh
. "$LIB_DIR/secrets.sh"

# =============================================================================
# Python toolbox. All JSON handling and every root write into a directory the
# droplet user can influence lives here, in one place, with one hardened
# atomic-write routine. Run as: python3 -c "$PY_TOOLBOX" <command> ...
# =============================================================================
IFS= read -r -d '' PY_TOOLBOX <<'PY' || true
import json
import os
import re
import stat
import sys

MAX_REQUEST_BYTES = 65536
MAX_RECORD_BYTES = 65536
UUID_RE = re.compile(r"[0-9A-Fa-f][0-9A-Fa-f-]{6,35}")
REQID_RE = re.compile(r"[A-Za-z0-9._:-]{1,64}")
VOLNAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
SAFE_VALUE_RE = re.compile(r"[A-Za-z0-9._/-]*")
NO_CONTROL_RE = re.compile(r"[^\x00-\x1f\x7f]*")
REQUEST_NAME = "migrate-request.json"
STATE_NAME = "migrate-state.json"
RECORD_NAME = "migration.json"

NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
CLOEXEC = getattr(os, "O_CLOEXEC", 0)
NONBLOCK = getattr(os, "O_NONBLOCK", 0)
DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | NOFOLLOW | CLOEXEC
HAVE_DIRFD = all(f in os.supports_dir_fd for f in (os.open, os.unlink, os.rename))


def die(code, msg):
    sys.stderr.write("droplet-nvr-migrate: %s\n" % msg)
    sys.exit(code)


class PinnedDir:
    """A directory pinned by fd (O_DIRECTORY|O_NOFOLLOW): every operation below
    is relative to THAT inode, so swapping the path for a symlink afterwards
    cannot redirect a root write. (Falls back to plain paths where the platform
    has no dir_fd support, which only matters for exercising this on Windows.)"""

    def __init__(self, path):
        self.path = path
        self.fd = None
        if HAVE_DIRFD:
            self.fd = os.open(path, DIR_FLAGS)
            self.st = os.fstat(self.fd)
        else:
            self.st = os.stat(path)

    def _ref(self, name):
        return name if self.fd is not None else os.path.join(self.path, name)

    def _kw(self):
        return {"dir_fd": self.fd} if self.fd is not None else {}

    def open(self, name, flags, mode=0o600):
        return os.open(self._ref(name), flags, mode, **self._kw())

    def unlink(self, name):
        os.unlink(self._ref(name), **self._kw())

    def rename(self, src, dst):
        if self.fd is not None:
            os.rename(src, dst, src_dir_fd=self.fd, dst_dir_fd=self.fd)
        else:
            os.replace(os.path.join(self.path, src), os.path.join(self.path, dst))

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def atomic_write(dirpath, name, data, chown_to_dir):
    """Hardened atomic write of a root-written file into `dirpath`: unlink any
    pre-planted tmp, create it O_CREAT|O_EXCL|O_NOFOLLOW 0600 (refuses ANY
    pre-planted entry, file or symlink), set owner/mode through the fd (never
    by path), then rename inside the pinned directory (a planted final symlink
    is replaced, never followed)."""
    with PinnedDir(dirpath) as d:
        tmp = name + ".tmp"
        try:
            d.unlink(tmp)
        except FileNotFoundError:
            pass
        fd = d.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC, 0o600)
        try:
            if chown_to_dir and hasattr(os, "fchown"):
                os.fchown(fd, d.st.st_uid, d.st.st_gid)
            if hasattr(os, "fchmod"):
                os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as fh:
                fd = -1
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
        finally:
            if fd != -1:
                os.close(fd)
        d.rename(tmp, name)


def cmd_state_write(spool):
    e = os.environ

    def s(key):
        v = e.get(key, "")
        return v if v != "" else None

    def i(key):
        try:
            return max(0, int(e.get(key, "0") or "0"))
        except ValueError:
            return 0

    old = None
    if e.get("S_OLD_KIND"):
        old = {"kind": e["S_OLD_KIND"], "source": e.get("S_OLD_SOURCE", ""),
               "bytes": i("S_OLD_BYTES"), "deleted": e.get("S_OLD_DELETED") == "1"}
    doc = {
        "request_id": s("S_REQUEST_ID") or "unknown",
        "job": s("S_JOB"),
        "state": e.get("S_STATE", "failed"),
        "phase": s("S_PHASE"),
        "progressPct": min(100, i("S_PCT")),
        "bytesCopied": i("S_COPIED"),
        "bytesTotal": i("S_TOTAL"),
        "startedAt": s("S_STARTED"),
        "finishedAt": s("S_FINISHED"),
        "error": s("S_ERROR"),
        "errorCode": s("S_ERRCODE"),
        "oldSource": old,
    }
    atomic_write(spool, STATE_NAME,
                 (json.dumps(doc, separators=(",", ":")) + "\n").encode("utf-8"), True)


def cmd_request_read(spool):
    """Print request_id / operation / fsUuid (one per line) for a VALID request
    and consume it. Exit 2: no request. 3: unusable (symlink, not a plain file,
    too big). 4: not JSON. 5: a field failed validation. Never echoes content."""
    try:
        d = PinnedDir(spool)
    except FileNotFoundError:
        die(2, "no spool directory")
    except OSError:
        die(3, "the spool directory is not usable")
    with d:
        try:
            fd = d.open(REQUEST_NAME, os.O_RDONLY | NOFOLLOW | NONBLOCK | CLOEXEC)
        except FileNotFoundError:
            die(2, "no spooled migration request")
        except OSError:
            die(3, "the migration request is not a plain file")
        with os.fdopen(fd, "rb") as fh:
            st = os.fstat(fh.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_REQUEST_BYTES:
                die(3, "the migration request is not a plain file of sane size")
            raw = fh.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            die(3, "the migration request is too large")
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            die(4, "the migration request is not valid JSON")
        if not isinstance(data, dict):
            die(5, "the migration request is not a JSON object")
        rid = data.get("request_id")
        op = data.get("operation")
        params = data.get("params")
        if not (isinstance(rid, str) and REQID_RE.fullmatch(rid)):
            die(5, "bad request id")
        if not (isinstance(op, str) and op in ("migrate", "delete_old")):
            die(5, "unknown operation")
        if params is None:
            params = {}
        if not isinstance(params, dict):
            die(5, "bad params")
        fs = "-"
        if op == "migrate":
            v = params.get("fsUuid")
            if not (isinstance(v, str) and UUID_RE.fullmatch(v)):
                die(5, "bad fsUuid")
            fs = v
        # delete_old ignores params entirely: what it may delete comes ONLY from
        # the root-only record.
        try:
            d.unlink(REQUEST_NAME)
        except OSError:
            pass
    sys.stdout.write("%s\n%s\n%s\n" % (rid, op, fs))


def cmd_inspect_parse(ids):
    """stdin: `docker inspect <ids...>` JSON (same order as ids). Pick THE frigate
    container (the single running one; else the single one) and print its id,
    running flag and the /media/frigate mount. Exit 3: ambiguous. 4: unexpected."""
    try:
        data = json.load(sys.stdin)
    except ValueError:
        die(4, "docker inspect did not return JSON")
    if not isinstance(data, list) or len(data) != len(ids):
        die(4, "unexpected docker inspect output")
    conts = []
    for cid, c in zip(ids, data):
        if not isinstance(c, dict):
            die(4, "unexpected docker inspect output")
        state = c.get("State")
        running = True
        if isinstance(state, dict) and "Running" in state:
            running = bool(state.get("Running"))
        mount = None
        for m in c.get("Mounts") or []:
            if isinstance(m, dict) and m.get("Destination") == "/media/frigate":
                mount = m
        conts.append((cid, running, mount))
    running = [c for c in conts if c[1]]
    if len(running) == 1:
        chosen = running[0]
    elif len(running) > 1:
        die(3, "more than one running frigate container")
    elif len(conts) == 1:
        chosen = conts[0]
    else:
        die(3, "more than one frigate container and none running")
    cid, is_running, mount = chosen
    out = ["ID %s" % cid, "RUNNING %d" % (1 if is_running else 0)]
    if mount is None:
        out.append("TYPE none")
    else:
        typ = mount.get("Type")
        name = mount.get("Name") or ""
        src = mount.get("Source") or ""
        if typ not in ("volume", "bind") or not isinstance(name, str) or not isinstance(src, str):
            die(4, "unexpected frigate mount")
        for v in (name, src):
            if not SAFE_VALUE_RE.fullmatch(v):
                die(4, "unexpected characters in the frigate mount")
        out += ["TYPE %s" % typ, "NAME %s" % name, "SOURCE %s" % src]
    sys.stdout.write("\n".join(out) + "\n")


def cmd_volume_parse():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        die(4, "docker volume inspect did not return JSON")
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        die(4, "unexpected docker volume inspect output")
    name = data[0].get("Name")
    mp = data[0].get("Mountpoint")
    if not (isinstance(name, str) and VOLNAME_RE.fullmatch(name)):
        die(4, "unexpected volume name")
    if not (isinstance(mp, str) and SAFE_VALUE_RE.fullmatch(mp)):
        die(4, "unexpected volume mountpoint")
    sys.stdout.write("NAME %s\nMOUNTPOINT %s\n" % (name, mp))


def load_record(rootdir):
    """The root-only migration record: None when absent; exit 3 when it (or its
    directory) is not trustworthy; 4 when corrupt."""
    try:
        d = PinnedDir(rootdir)
    except FileNotFoundError:
        return None
    except OSError:
        die(3, "the root-only state directory is not usable")
    me = os.geteuid()
    with d:
        if d.st.st_uid != me or (d.st.st_mode & 0o022):
            die(3, "the root-only state directory is not trusted")
        try:
            fd = d.open(RECORD_NAME, os.O_RDONLY | NOFOLLOW | CLOEXEC)
        except FileNotFoundError:
            return None
        except OSError:
            die(3, "the migration record is not a plain file")
        with os.fdopen(fd, "rb") as fh:
            st = os.fstat(fh.fileno())
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != me or (st.st_mode & 0o022)
                    or st.st_size > MAX_RECORD_BYTES):
                die(3, "the migration record is not trusted")
            raw = fh.read(MAX_RECORD_BYTES + 1)
    try:
        rec = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        die(4, "the migration record is corrupt")
    if not isinstance(rec, dict):
        die(4, "the migration record is corrupt")
    return rec


def sane(v):
    return isinstance(v, str) and 0 < len(v) <= 4096 and NO_CONTROL_RE.fullmatch(v) is not None


def cmd_record_read(rootdir):
    rec = load_record(rootdir)
    if rec is None:
        return
    out = []
    for key in ("previousSource", "newSource", "fsUuid", "migratedAt"):
        if sane(rec.get(key)):
            out.append("%s %s" % (key, rec[key]))
    old = rec.get("oldSource")
    if isinstance(old, dict):
        kind, src, nbytes, deleted = old.get("kind"), old.get("source"), old.get("bytes"), old.get("deleted")
        if kind in ("volume", "path") and sane(src) and isinstance(deleted, bool):
            if not (isinstance(nbytes, int) and not isinstance(nbytes, bool) and nbytes >= 0):
                nbytes = 0
            out += ["oldKind %s" % kind, "oldSource %s" % src, "oldBytes %d" % nbytes,
                    "oldDeleted %d" % (1 if deleted else 0)]
    if out:
        sys.stdout.write("\n".join(out) + "\n")


def cmd_record_update(rootdir, mode):
    e = os.environ
    rec = load_record(rootdir) or {}
    now = e["REC_NOW"]
    if mode == "migrated":
        rec["previousSource"] = e["REC_PREVIOUS"]
        rec["newSource"] = e["REC_NEW"]
        rec["fsUuid"] = e["REC_FSUUID"]
        rec.setdefault("recordedAt", now)
        rec["oldSource"] = {"kind": e["REC_OLD_KIND"], "source": e["REC_OLD_SOURCE"],
                            "bytes": int(e["REC_OLD_BYTES"]), "deleted": False}
        rec["migratedAt"] = now
        rec.pop("deletedAt", None)
    elif mode == "deleted":
        old = rec.get("oldSource")
        if not isinstance(old, dict):
            die(4, "no old source is recorded")
        old["deleted"] = True
        rec["deletedAt"] = now
    else:
        die(2, "unknown record update")
    atomic_write(rootdir, RECORD_NAME,
                 (json.dumps(rec, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8"), False)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "state-write":
        cmd_state_write(sys.argv[2])
    elif cmd == "request-read":
        cmd_request_read(sys.argv[2])
    elif cmd == "inspect-parse":
        cmd_inspect_parse(sys.argv[2:])
    elif cmd == "volume-parse":
        cmd_volume_parse()
    elif cmd == "record-read":
        cmd_record_read(sys.argv[2])
    elif cmd == "record-update":
        cmd_record_update(sys.argv[2], sys.argv[3])
    else:
        die(2, "unknown toolbox command")


main()
PY

tb() { python3 -c "$PY_TOOLBOX" "$@"; }

# =============================================================================
# State
# =============================================================================
# Exported so the python state writer (and the progress reader subshell) always
# see the current values.
S_REQUEST_ID="unknown"; S_JOB=""; S_STATE="running"; S_PHASE=""; S_PCT=0; S_COPIED=0; S_TOTAL=0
S_STARTED=""; S_FINISHED=""; S_ERROR=""; S_ERRCODE=""
S_OLD_KIND=""; S_OLD_SOURCE=""; S_OLD_BYTES=0; S_OLD_DELETED=0
export S_REQUEST_ID S_JOB S_STATE S_PHASE S_PCT S_COPIED S_TOTAL S_STARTED S_FINISHED S_ERROR S_ERRCODE
export S_OLD_KIND S_OLD_SOURCE S_OLD_BYTES S_OLD_DELETED

JOB_ACTIVE=0          # 1 from the first `running` state until a terminal state is recorded
ROLLBACK_ARMED=0      # 1 once frigate is about to be stopped: any later failure rolls back
RECREATE_ATTEMPTED=0  # 1 once `compose up --force-recreate` ran (the old container may be gone)
ROLLBACK_OK=1
FRIGATE_ID=""         # the container that was running on OLD (as printed by docker ps)
FRIGATE_RUNNING=0
OLD_KIND=""; OLD_NAME=""; OLD_PATH=""; OLD_ENV_VALUE=""
NEW_MOUNT=""; NEW=""
REQ_ID=""; REQ_OP=""; REQ_FS=""
REC_PRESENT=0; REC_PREVIOUS=""; REC_NEWSRC=""; REC_FSUUID=""; REC_MIGRATED_AT=""
REC_OLD_KIND=""; REC_OLD_SOURCE=""; REC_OLD_BYTES=0; REC_OLD_DELETED=0
FR_FOUND=0; FR_ID=""; FR_RUNNING=0; FR_TYPE=""; FR_NAME=""; FR_SOURCE=""
INSPECT_FAIL_CODE="bad_source"
PROG_BYTES=0

# Best effort by design: losing a progress write must never abort a copy.
write_state() {
  tb state-write "$SPOOL_DIR" || { err "could not write the state file"; return 1; }
}

# fail <errorCode> <message>: record the cause and leave through the EXIT trap,
# which rolls back (when armed) and writes the terminal `failed` state. Never
# call it inside $(...) or a pipeline element: it must exit the MAIN shell.
fail() {
  S_ERRCODE="$1"
  S_ERROR="$2"
  err "FAILED ($1): $2"
  exit 1
}

# =============================================================================
# Shape validation (every path the job acts on matches a fixed allow-shape)
# =============================================================================
valid_volume_name() { [[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; }

# <mount base>/<tail> — the bay mount of one drive.
is_bay_mount() {
  local p="${1:-}" tail
  case "$p" in "$MOUNT_BASE"/*) ;; *) return 1 ;; esac
  tail="${p#"$MOUNT_BASE"/}"
  [[ "$tail" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

# <mount base>/<tail>/nvr — a bay drive's recordings directory, exactly.
valid_bay_nvr_path() {
  local p="${1:-}" tail
  case "$p" in "$MOUNT_BASE"/*/nvr) ;; *) return 1 ;; esac
  tail="${p#"$MOUNT_BASE"/}"
  tail="${tail%/nvr}"
  [[ "$tail" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

# <anything>/volumes/<name>/_data — a docker local volume's data directory.
valid_volume_path() {
  local p="${1:-}" n="${2:-}"
  [[ "$p" == /* ]] || return 1
  [[ "$p" == */volumes/"$n"/_data ]] || return 1
  case "$p/" in */../*|*/./*|*//*) return 1 ;; esac
  return 0
}

# =============================================================================
# .env helpers (the .env is droplet-writable: only compared, or written from
# values this script derived and validated)
# =============================================================================
# The effective NVR_MEDIA_SOURCE as written: first assignment, CR and one pair
# of quotes stripped (same parse as `droplet-set-nvr-media.sh --status`).
# Prints "" for a missing/empty key.
env_source_value() {
  local line="" v=""
  if [ -f "$ENV_FILE" ]; then
    line="$(grep -m1 '^NVR_MEDIA_SOURCE=' "$ENV_FILE" 2>/dev/null || true)"
  fi
  v="${line#NVR_MEDIA_SOURCE=}"
  v="${v%$'\r'}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

# Write NVR_MEDIA_SOURCE through _upsert_env_kv, but keep the .env's owner and
# mode: this job runs as root while the file belongs to the repo user (the
# compose stack reads it as that user), and _upsert_env_kv stages a fresh file
# that would otherwise end up root:root 0600.
env_set_source() {
  local value="$1" real="$ENV_FILE" uid="" gid="" mode=""
  if [ -L "$ENV_FILE" ]; then
    real="$(readlink -f -- "$ENV_FILE" 2>/dev/null || printf '%s' "$ENV_FILE")"
  fi
  if [ -e "$real" ]; then
    uid="$(stat -c %u -- "$real" 2>/dev/null || true)"
    gid="$(stat -c %g -- "$real" 2>/dev/null || true)"
    mode="$(stat -c %a -- "$real" 2>/dev/null || true)"
  fi
  _upsert_env_kv NVR_MEDIA_SOURCE "$value" || return 1
  if [ -n "$uid" ] && [ -n "$gid" ] && [ "$(id -u)" = 0 ]; then
    chown "$uid:$gid" -- "$real" 2>/dev/null || err "warning: could not restore the owner of the environment file"
  fi
  if [ -n "$mode" ]; then
    chmod "$mode" -- "$real" 2>/dev/null || true
  fi
  return 0
}

restore_env_old() {
  [ -n "$OLD_ENV_VALUE" ] || return 1
  if [ "$(env_source_value)" = "$OLD_ENV_VALUE" ]; then
    return 0
  fi
  env_set_source "$OLD_ENV_VALUE"
}

# =============================================================================
# The root-only migration record
# =============================================================================
# Sets REC_*. Returns 0 (loaded, or no record) / 3 (untrusted) / 4 (corrupt).
load_record() {
  local out="" rc=0 line key val
  REC_PRESENT=0; REC_PREVIOUS=""; REC_NEWSRC=""; REC_FSUUID=""; REC_MIGRATED_AT=""
  REC_OLD_KIND=""; REC_OLD_SOURCE=""; REC_OLD_BYTES=0; REC_OLD_DELETED=0
  out="$(tb record-read "$ROOT_STATE_DIR")" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    key="${line%% *}"
    val="${line#* }"
    REC_PRESENT=1
    case "$key" in
      previousSource) REC_PREVIOUS="$val" ;;
      newSource) REC_NEWSRC="$val" ;;
      fsUuid) REC_FSUUID="$val" ;;
      migratedAt) REC_MIGRATED_AT="$val" ;;
      oldKind) REC_OLD_KIND="$val" ;;
      oldSource) REC_OLD_SOURCE="$val" ;;
      oldBytes) REC_OLD_BYTES="$val" ;;
      oldDeleted) REC_OLD_DELETED="$val" ;;
      *) ;;
    esac
  done <<<"$out"
  [[ "$REC_OLD_BYTES" =~ ^[0-9]{1,18}$ ]] || REC_OLD_BYTES=0
  return 0
}

# record_update migrated|deleted — values come from the S_*/OLD_* state this
# script derived and validated itself.
record_update() {
  local now
  now="$(now_iso)"
  REC_NOW="$now" REC_PREVIOUS="$OLD_ENV_VALUE" REC_NEW="$NEW" REC_FSUUID="$REQ_FS" \
    REC_OLD_KIND="$S_OLD_KIND" REC_OLD_SOURCE="$S_OLD_SOURCE" REC_OLD_BYTES="$S_OLD_BYTES" \
    tb record-update "$ROOT_STATE_DIR" "$1"
}

# =============================================================================
# docker: the frigate container, as ground truth
# =============================================================================
# Sets FR_FOUND/FR_ID/FR_RUNNING/FR_TYPE/FR_NAME/FR_SOURCE. The container is
# found by its compose label; a stopped leftover next to ONE running container
# is ignored. Ambiguity fails with $INSPECT_FAIL_CODE, a dead daemon with
# docker_unavailable.
inspect_frigate() {
  local ps_out line insp parsed rc=0 key val
  local -a ids=()
  FR_FOUND=0; FR_ID=""; FR_RUNNING=0; FR_TYPE=""; FR_NAME=""; FR_SOURCE=""
  ps_out="$(docker ps -a -q --filter label=com.docker.compose.service=frigate)" \
    || fail docker_unavailable "docker could not list the frigate container"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    [[ "$line" =~ ^[0-9a-f]{12,64}$ ]] || fail "$INSPECT_FAIL_CODE" "docker returned an unexpected container id"
    ids+=("$line")
  done <<<"$ps_out"
  if [ "${#ids[@]}" -eq 0 ]; then
    return 0
  fi
  insp="$(docker inspect "${ids[@]}")" || fail docker_unavailable "docker could not inspect the frigate container"
  parsed="$(printf '%s\n' "$insp" | tb inspect-parse "${ids[@]}")" || rc=$?
  [ "$rc" -eq 0 ] || fail "$INSPECT_FAIL_CODE" "the frigate container could not be identified unambiguously"
  while IFS= read -r line; do
    key="${line%% *}"
    val="${line#* }"
    case "$key" in
      ID) FR_ID="$val" ;;
      RUNNING) FR_RUNNING="$val" ;;
      TYPE) FR_TYPE="$val" ;;
      NAME) FR_NAME="$val" ;;
      SOURCE) FR_SOURCE="$val" ;;
      *) ;;
    esac
  done <<<"$parsed"
  [[ "$FR_ID" =~ ^[0-9a-f]{12,64}$ ]] || fail "$INSPECT_FAIL_CODE" "the frigate container id is unexpected"
  FR_FOUND=1
}

# =============================================================================
# migrate
# =============================================================================
# NEW = <mount of the requested fsUuid>/nvr, and .env must already name it.
resolve_new_target() {
  local line
  NEW_MOUNT=""
  command -v findmnt >/dev/null 2>&1 || fail target_not_applied "findmnt is not available"
  while IFS= read -r line; do
    if is_bay_mount "$line"; then
      NEW_MOUNT="$line"
      break
    fi
  done < <(findmnt -rn -S "UUID=$REQ_FS" -o TARGET 2>/dev/null || true)
  [ -n "$NEW_MOUNT" ] || fail target_not_applied "the new recordings drive is not mounted where it should be"
  NEW="$NEW_MOUNT/nvr"
  if [ ! -d "$NEW" ] || [ -L "$NEW" ] || [ "$(readlink -f -- "$NEW" 2>/dev/null || true)" != "$NEW" ]; then
    fail target_not_applied "the new recordings directory is missing or is not a plain directory"
  fi
  [ -w "$NEW" ] || fail target_not_applied "the new recordings directory is not writable"
  # TARGET_PREPARED_GUARD: the writer (--apply) must have prepared NEW (its root-only
  # record names it) or the .env must already point at it; never guess.
  if [ "${REC_NEWSRC:-}" != "$NEW" ] && [ "$(env_source_value)" != "$NEW" ]; then
    fail target_not_applied "the recordings target has not been prepared on the new drive"
  fi
}

# Previous source from the record when frigate has no container.
resolve_old_from_record() {
  local prev="$REC_PREVIOUS" names line name insp parsed mp rc=0 key val
  local -a vols=()
  [ -n "$prev" ] || fail bad_source "frigate has no container and no previous recordings location is recorded"
  if valid_bay_nvr_path "$prev"; then
    OLD_KIND=path
    OLD_PATH="$prev"
    return 0
  fi
  valid_volume_name "$prev" || fail bad_source "the recorded previous recordings location is not recognised"
  # The record holds the COMPOSE volume name (nvrdata); the real docker volume
  # is project-prefixed (droplet_nvrdata). Compose labels its volumes.
  names="$(docker volume ls -q --filter "label=com.docker.compose.volume=$prev")" \
    || fail docker_unavailable "docker could not list volumes"
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      vols+=("$line")
    fi
  done <<<"$names"
  if [ "${#vols[@]}" -eq 1 ]; then
    name="${vols[0]}"
  elif [ "${#vols[@]}" -eq 0 ]; then
    name="$prev"
  else
    fail bad_source "more than one docker volume matches the previous recordings volume"
  fi
  valid_volume_name "$name" || fail bad_source "the previous recordings volume has an unexpected name"
  insp="$(docker volume inspect "$name")" || fail bad_source "the previous recordings volume does not exist"
  parsed="$(printf '%s\n' "$insp" | tb volume-parse)" || rc=$?
  [ "$rc" -eq 0 ] || fail bad_source "the previous recordings volume could not be inspected"
  mp=""
  while IFS= read -r line; do
    key="${line%% *}"
    val="${line#* }"
    if [ "$key" = MOUNTPOINT ]; then
      mp="$val"
    fi
  done <<<"$parsed"
  valid_volume_path "$mp" "$name" || fail bad_source "the previous recordings volume is not a docker volume directory"
  OLD_KIND=volume
  OLD_NAME="$name"
  OLD_PATH="$mp"
}

resolve_old_source() {
  OLD_KIND=""; OLD_NAME=""; OLD_PATH=""; OLD_ENV_VALUE=""
  INSPECT_FAIL_CODE="bad_source"
  inspect_frigate
  if [ "$FR_FOUND" = 1 ]; then
    FRIGATE_ID="$FR_ID"
    FRIGATE_RUNNING="$FR_RUNNING"
    case "$FR_TYPE" in
      volume)
        valid_volume_name "$FR_NAME" || fail bad_source "the frigate recordings volume has an unexpected name"
        valid_volume_path "$FR_SOURCE" "$FR_NAME" || fail bad_source "the frigate recordings volume is not a docker volume directory"
        OLD_KIND=volume; OLD_NAME="$FR_NAME"; OLD_PATH="$FR_SOURCE"
        ;;
      bind)
        valid_bay_nvr_path "$FR_SOURCE" || fail bad_source "the frigate recordings location is not a recordings directory on a bay drive"
        OLD_KIND=path; OLD_PATH="$FR_SOURCE"
        ;;
      *)
        fail bad_source "frigate has no recordings mount"
        ;;
    esac
  else
    resolve_old_from_record
  fi
  # The value that put frigate on OLD in the .env (restored on rollback): a
  # path is its own value; a volume is the COMPOSE volume name.
  if [ "$OLD_KIND" = path ]; then
    OLD_ENV_VALUE="$OLD_PATH"
  elif valid_volume_name "$REC_PREVIOUS"; then
    OLD_ENV_VALUE="$REC_PREVIOUS"
  else
    OLD_ENV_VALUE="nvrdata"
  fi
  if [ "$OLD_PATH" = "$NEW" ]; then
    return 0
  fi
  [ -d "$OLD_PATH" ] || fail bad_source "the old recordings location does not exist"
  if [ "$OLD_KIND" = path ]; then
    if [ -L "$OLD_PATH" ] || [ "$(readlink -f -- "$OLD_PATH" 2>/dev/null || true)" != "$OLD_PATH" ]; then
      fail bad_source "the old recordings directory is not a plain directory"
    fi
  fi
}

# Bytes under a path. `du` exits 1 when a file vanishes mid-scan of the LIVE
# tree but still prints the total, so the number decides, not the status.
du_bytes() {
  local out="" n
  out="$(du -sb "$1")" || true
  n="${out%%[[:space:]]*}"
  [[ "$n" =~ ^[0-9]{1,18}$ ]] || return 1
  printf '%s' "$n"
}

statfs_numbers() {
  local -a cmd=()
  if [ -n "${DROPLET_NVR_MEDIA_STATFS:-}" ]; then
    read -r -a cmd <<<"$DROPLET_NVR_MEDIA_STATFS"
    "${cmd[@]}" "$1"
  else
    stat -f -c '%S %b %f %a' -- "$1"
  fi
}

# bytesTotal x 1.1 must fit in what NEW can still take. A root rsync BYPASSES
# the project quota (CAP_SYS_RESOURCE), so this is the only thing that stops the
# copy from overshooting the reservation. Bytes a previous attempt already put
# in NEW (same relative paths, so the same files) are credited, capped at
# bytesTotal, so a retry after a partial copy can still pass a tight quota.
check_space() {
  local line="" fr="" bl="" bf="" ba="" v need credit required avail used
  line="$(statfs_numbers "$NEW")" || line=""
  read -r fr bl bf ba _ <<<"$line" || true
  for v in "$fr" "$bl" "$bf" "$ba"; do
    [[ "$v" =~ ^[0-9]{1,18}$ ]] || fail internal "could not read the free space of the new drive"
  done
  avail=$((ba * fr))
  used=$(((bl - bf) * fr))
  [ "$used" -ge 0 ] || used=0
  need=$((S_TOTAL + (S_TOTAL + 9) / 10))
  credit="$used"
  [ "$credit" -le "$S_TOTAL" ] || credit="$S_TOTAL"
  required=$((need - credit))
  # SPACE_GUARD
  if [ "$avail" -lt "$required" ]; then
    fail insufficient_space "not enough free space on the new drive: ${required} bytes needed, ${avail} available"
  fi
}

# rsync -a also syncs the destination ROOT directory's attributes; OLD's root
# (a docker volume dir, usually 0755) would widen nvr/ (0700 root, the writer
# made it that way so only root and frigate can traverse it). Put it back.
tighten_new_root() {
  chmod 0700 -- "$NEW" 2>/dev/null || err "warning: could not restore mode 0700 on the new recordings directory"
  if [ "$(id -u)" = 0 ]; then
    chown 0:0 -- "$NEW" 2>/dev/null || true
  fi
}

# One `--info=progress2` record per second, \r separated, e.g.
#   "     1,671,171  23%    1.50MB/s    0:00:03  "
# The first number is bytes transferred so far (the thousands separator comes
# from the locale; both , and . are stripped). Sets PROG_BYTES.
parse_progress_line() {
  local line="$1" tok re='^[[:space:]]*([0-9][0-9,.]*)[[:space:]]+[0-9]+%'
  if [[ "$line" =~ $re ]]; then
    tok="${BASH_REMATCH[1]}"
    tok="${tok//[,.]/}"
    [[ "$tok" =~ ^[0-9]{1,18}$ ]] || return 1
    PROG_BYTES=$((10#$tok))
    return 0
  fi
  return 1
}

# Reads rsync's stdout. mode "track" (live copy) updates bytesCopied/progressPct
# from it; mode "hold" (delta) only refreshes the file, so the numbers never
# slide backwards after the live pass. The state file is rewritten at least
# every PROGRESS_SECS even when rsync is silent (a huge file-list scan can take
# minutes), via the read timeout. Runs as a pipeline element (a subshell).
progress_reader() {
  local mode="$1" chunk line now last=0 hb="$PROGRESS_SECS" pct
  [ "$hb" -ge 1 ] || hb=1
  while IFS= read -r -d $'\r' -t "$hb" chunk || [ "$?" -gt 128 ]; do
    if [ "$mode" = track ]; then
      line="${chunk##*$'\n'}"
      if [ -z "$line" ]; then
        line="${chunk%$'\n'}"
        line="${line##*$'\n'}"
      fi
      if parse_progress_line "$line"; then
        S_COPIED="$PROG_BYTES"
        pct=0
        if [ "$S_TOTAL" -gt 0 ]; then
          pct=$((S_COPIED * 100 / S_TOTAL))
          [ "$pct" -le 99 ] || pct=99
        fi
        S_PCT="$pct"
      fi
    fi
    now="$(date +%s)"
    if [ $((now - last)) -ge "$PROGRESS_SECS" ]; then
      write_state || true
      last="$now"
    fi
  done
}

# sync_pass copy|delta — the same path-preserving rsync twice (frigate runs on
# OLD during `copy`, is stopped for `delta`). Exit 24 ("some files vanished")
# is normal while frigate expires segments; the verify pass is the real gate.
sync_pass() {
  local rc mode=hold
  S_PHASE="$1"
  if [ "$1" = copy ]; then
    mode=track
  fi
  write_state || true
  set +e
  rsync -aHAX --numeric-ids --info=progress2 "$OLD_PATH/" "$NEW/" | progress_reader "$mode"
  rc="${PIPESTATUS[0]}"
  set -e
  tighten_new_root
  case "$rc" in
    0|24) ;;
    *) fail copy_failed "rsync exited with code $rc during the $1 pass" ;;
  esac
  if [ "$1" = copy ]; then
    S_COPIED="$S_TOTAL"
    S_PCT=99
  fi
}

# A checksum-free dry run must find nothing left to transfer. The destination
# root directory line (`./`) is ours (nvr/ stays 0700), not a difference.
verify_copy() {
  local out="" rc=0 line path bad=0
  S_PHASE=verify
  write_state || true
  out="$(rsync -a --dry-run --itemize-changes "$OLD_PATH/" "$NEW/")" || rc=$?
  case "$rc" in
    0|24) ;;
    *) fail verify_failed "the verification pass could not complete (rsync exit $rc)" ;;
  esac
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path="${line#* }"
    if [ "$path" = "./" ]; then
      continue
    fi
    bad=$((bad + 1))
  done <<<"$out"
  [ "$bad" -eq 0 ] || fail verify_failed "$bad item(s) still differ between the old and the new location"
}

# After the recreate, frigate must be running AND mount the new drive.
wait_new_frigate_ready() {
  local deadline
  deadline=$(($(date +%s) + START_WAIT_SECS))
  INSPECT_FAIL_CODE="flip_failed"
  inspect_frigate
  until [ "$FR_FOUND" = 1 ] && [ "$FR_RUNNING" = 1 ]; do
    [ "$(date +%s)" -lt "$deadline" ] || fail flip_failed "frigate did not come back up on the new drive"
    sleep 1
    inspect_frigate
  done
  if [ "$FR_TYPE" != bind ] || [ "$FR_SOURCE" != "$NEW" ]; then
    fail flip_failed "frigate is not using the new drive after the restart"
  fi
}

flip() {
  S_PHASE=flip
  write_state || true
  if [ "$(env_source_value)" != "$NEW" ]; then
    env_set_source "$NEW" || fail flip_failed "the recordings target could not be written to the environment file"
  fi
  RECREATE_ATTEMPTED=1
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate frigate \
    || fail flip_failed "frigate could not be recreated on the new drive"
  S_PHASE=start
  write_state || true
  wait_new_frigate_ready
  ROLLBACK_ARMED=0
}

# Frigate already uses the new drive (OLD == NEW): nothing to copy, stop or flip.
# Carry the kept old source forward so its deletion stays possible.
finish_already_migrated() {
  if [ -n "$FRIGATE_ID" ] && [ "$FRIGATE_RUNNING" != 1 ]; then
    err "frigate is not running on the new drive — starting it"
    docker start "$FRIGATE_ID" || fail docker_unavailable "frigate could not be started"
  fi
  if [ -n "$REC_OLD_KIND" ]; then
    S_OLD_KIND="$REC_OLD_KIND"; S_OLD_SOURCE="$REC_OLD_SOURCE"
    S_OLD_BYTES="$REC_OLD_BYTES"; S_OLD_DELETED="$REC_OLD_DELETED"
  fi
  S_STATE=done; S_PHASE=""; S_PCT=100; S_ERROR=""; S_ERRCODE=""
  S_FINISHED="$(now_iso)"
  JOB_ACTIVE=0
  write_state || true
}

finish_done() {
  local final
  final="$(du_bytes "$OLD_PATH")" || final="$S_TOTAL"
  S_STATE=done; S_PHASE=""; S_PCT=100; S_COPIED="$final"; S_TOTAL="$final"
  S_ERROR=""; S_ERRCODE=""; S_FINISHED="$(now_iso)"
  S_OLD_KIND="$OLD_KIND"; S_OLD_BYTES="$final"; S_OLD_DELETED=0
  if [ "$OLD_KIND" = volume ]; then
    S_OLD_SOURCE="$OLD_NAME"
  else
    S_OLD_SOURCE="$OLD_PATH"
  fi
  # OLD IS KEPT. Bookkeeping failures must not undo a migration that worked.
  record_update migrated || err "warning: could not update the root-only migration record (delete_old will refuse until it exists)"
  JOB_ACTIVE=0
  write_state || true
}

job_migrate() {
  S_JOB=migrate; S_STATE=running; S_PHASE=preflight; S_PCT=0; S_COPIED=0; S_TOTAL=0
  S_STARTED="$(now_iso)"
  JOB_ACTIVE=1
  write_state || true

  command -v docker >/dev/null 2>&1 || fail docker_unavailable "the docker CLI is not available"
  local rc=0
  load_record || rc=$?
  if [ "$rc" -ne 0 ]; then
    err "warning: the root-only migration record is unusable (code $rc) — ignoring it"
    REC_PRESENT=0; REC_PREVIOUS=""; REC_OLD_KIND=""
  fi
  resolve_new_target
  resolve_old_source
  if [ "$OLD_PATH" = "$NEW" ]; then
    finish_already_migrated
    return 0
  fi
  command -v rsync >/dev/null 2>&1 || fail rsync_missing "rsync is not installed on this box"
  S_TOTAL="$(du_bytes "$OLD_PATH")" || fail bad_source "the old recordings could not be measured"
  write_state || true
  check_space

  sync_pass copy
  # From here on frigate is (about to be) stopped: any failure rolls back.
  ROLLBACK_ARMED=1
  S_PHASE=stop
  write_state || true
  if [ -n "$FRIGATE_ID" ]; then
    docker stop -t 60 "$FRIGATE_ID" || fail docker_unavailable "frigate could not be stopped"
  fi
  sync_pass delta
  verify_copy
  flip
  finish_done
}

# Undo everything after the stop: .env back to the OLD value, frigate back on
# OLD. Best effort; ROLLBACK_OK=0 marks a rollback that could not restart it.
rollback_after_failure() {
  ROLLBACK_OK=1
  [ "$ROLLBACK_ARMED" = 1 ] || return 0
  local env_ok=1
  err "rolling back: returning frigate to its previous recordings location"
  if ! restore_env_old; then
    err "could not restore the recordings target in the environment file"
    env_ok=0
  fi
  [ -n "$FRIGATE_ID" ] || return 0
  if [ "$RECREATE_ATTEMPTED" = 1 ] && [ "$env_ok" = 1 ]; then
    # compose may already have replaced the original container: recreate it
    # from the (restored) .env; fall back to starting the original.
    if docker compose -f "$COMPOSE_FILE" up -d --force-recreate frigate; then
      return 0
    fi
    err "recreating frigate on the old location failed — trying the original container"
  fi
  # ROLLBACK_START: the original container's bind mount is still OLD.
  if ! docker start "$FRIGATE_ID"; then
    err "could not restart frigate"
    ROLLBACK_OK=0
    S_ERROR="$S_ERROR; frigate could not be restarted automatically — start it manually with: docker compose up -d frigate"
  fi
  [ "$env_ok" = 1 ] || ROLLBACK_OK=0
}

# =============================================================================
# delete_old
# =============================================================================
delete_old_volume() {
  local names
  names="$(docker volume ls -q)" || fail docker_unavailable "docker could not list volumes"
  if ! printf '%s\n' "$names" | grep -Fxq -- "$REC_OLD_SOURCE"; then
    err "the old recordings volume no longer exists — treating it as deleted"
    return 0
  fi
  docker volume rm "$REC_OLD_SOURCE" \
    || fail delete_failed "docker could not remove the old recordings volume (is it still in use?)"
}

# CONTENTS only: nvr/ itself carries the quota project id and stays.
# --one-file-system keeps rm out of anything mounted below it.
delete_old_path() {
  find "$REC_OLD_SOURCE" -mindepth 1 -maxdepth 1 -exec rm -rf --one-file-system -- {} + \
    || fail delete_failed "the old recordings could not be fully removed"
}

job_delete_old() {
  local rc=0 cur
  S_JOB=delete_old; S_STATE=running; S_PHASE=cleanup; S_PCT=0; S_COPIED=0; S_TOTAL=0
  S_STARTED="$(now_iso)"
  JOB_ACTIVE=1
  write_state || true

  # Decided from the root-only record ALONE — never from the request or the .env.
  load_record || rc=$?
  [ "$rc" -eq 0 ] || fail delete_failed "the migration record is not trustworthy"
  if [ "$REC_PRESENT" != 1 ] || [ -z "$REC_OLD_KIND" ] || [ -z "$REC_MIGRATED_AT" ]; then
    fail no_old_footage "no completed migration with kept old footage is recorded"
  fi
  [ "$REC_OLD_DELETED" != 1 ] || fail no_old_footage "the old footage was already deleted"
  S_OLD_KIND="$REC_OLD_KIND"; S_OLD_SOURCE="$REC_OLD_SOURCE"; S_OLD_BYTES="$REC_OLD_BYTES"
  S_OLD_DELETED=0; S_TOTAL="$REC_OLD_BYTES"
  write_state || true

  case "$REC_OLD_KIND" in
    volume)
      valid_volume_name "$REC_OLD_SOURCE" || fail delete_failed "the recorded old volume name is not valid"
      ;;
    path)
      valid_bay_nvr_path "$REC_OLD_SOURCE" || fail delete_failed "the recorded old location is not a recordings directory on a bay drive"
      if [ ! -d "$REC_OLD_SOURCE" ] || [ -L "$REC_OLD_SOURCE" ] \
         || [ "$(readlink -f -- "$REC_OLD_SOURCE" 2>/dev/null || true)" != "$REC_OLD_SOURCE" ]; then
        fail delete_failed "the old recordings directory is not available as a plain directory"
      fi
      ;;
    *)
      fail delete_failed "the recorded old source kind is not valid"
      ;;
  esac

  # Never touch the live source: not the one the .env names (unset == the
  # compose default volume), not the new target, not what frigate really mounts.
  cur="$(env_source_value)"
  [ -n "$cur" ] || cur="nvrdata"
  # CURRENT_SOURCE_GUARD
  if [ "$cur" = "$REC_OLD_SOURCE" ] || [ "${cur%/}" = "$REC_OLD_SOURCE" ] \
     || { [ -n "$REC_PREVIOUS" ] && [ "$cur" = "$REC_PREVIOUS" ]; } \
     || { [ -n "$REC_NEWSRC" ] && [ "$REC_NEWSRC" = "$REC_OLD_SOURCE" ]; }; then
    fail delete_failed "refusing: the old location is the live recordings target"
  fi

  command -v docker >/dev/null 2>&1 || fail docker_unavailable "the docker CLI is not available"
  INSPECT_FAIL_CODE="delete_failed"
  inspect_frigate
  if [ "$FR_FOUND" = 1 ]; then
    if [ "$REC_OLD_KIND" = volume ] && [ "$FR_NAME" = "$REC_OLD_SOURCE" ]; then
      fail delete_failed "refusing: frigate is still using the old recordings volume"
    fi
    if [ "$REC_OLD_KIND" = path ] && [ "${FR_SOURCE%/}" = "$REC_OLD_SOURCE" ]; then
      fail delete_failed "refusing: frigate is still using the old recordings directory"
    fi
  fi

  if [ "$REC_OLD_KIND" = volume ]; then
    delete_old_volume
  else
    delete_old_path
  fi

  S_STATE=done; S_PHASE=""; S_PCT=100; S_COPIED="$S_TOTAL"
  S_ERROR=""; S_ERRCODE=""; S_FINISHED="$(now_iso)"; S_OLD_DELETED=1
  record_update deleted || err "warning: could not mark the old footage as deleted in the record (a retry is harmless)"
  JOB_ACTIVE=0
  write_state || true
}

# =============================================================================
# Lifecycle: lock, request, traps
# =============================================================================
take_lock() {
  mkdir -p -m 0700 "$ROOT_STATE_DIR" 2>/dev/null || true
  [ -d "$ROOT_STATE_DIR" ] || die "cannot create the root-only state directory"
  if command -v flock >/dev/null 2>&1; then
    exec 9>>"$ROOT_STATE_DIR/migrate.lock"
    if ! flock -n 9; then
      err "another migration job is already running"
      exit 3
    fi
  else
    err "warning: flock is not available — not guarding against a concurrent run"
  fi
}

read_request() {
  local out="" rc=0
  out="$(tb request-read "$SPOOL_DIR")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    # 2 = no request at all: say nothing, so a stray start can never clobber the
    # state of a finished job. Anything else is a rejected request: record it.
    if [ "$rc" -ne 2 ]; then
      S_ERRCODE=internal; S_ERROR="the migration request was rejected"; S_STATE=failed
      S_REQUEST_ID=unknown; S_STARTED="$(now_iso)"; S_FINISHED="$S_STARTED"
      write_state || true
    fi
    exit 2
  fi
  {
    IFS= read -r REQ_ID
    IFS= read -r REQ_OP
    IFS= read -r REQ_FS
  } <<<"$out" || true
  [ "$REQ_FS" != "-" ] || REQ_FS=""
  S_REQUEST_ID="$REQ_ID"
}

on_exit() {
  local rc=$?
  trap - EXIT
  trap '' TERM INT HUP
  if [ "$JOB_ACTIVE" = 1 ]; then
    JOB_ACTIVE=0
    if [ -z "$S_ERRCODE" ]; then
      S_ERRCODE=internal
      S_ERROR="unexpected error (exit status $rc)"
    fi
    rollback_after_failure
    S_STATE=failed
    S_FINISHED="$(now_iso)"
    if [ "$S_JOB" = migrate ]; then
      # A failed move has no "old" source: OLD is still the live one.
      S_OLD_KIND=""; S_OLD_SOURCE=""; S_OLD_BYTES=0; S_OLD_DELETED=0
    fi
    if ! write_state; then
      ROLLBACK_OK=0
    fi
    if [ "$S_ERRCODE" = internal ] || [ "$ROLLBACK_OK" != 1 ]; then
      rc=1
    else
      rc=0
    fi
  fi
  exit "$rc"
}

on_signal() {
  S_ERRCODE=interrupted
  S_ERROR="the migration was interrupted"
  exit 1
}

trap on_exit EXIT
trap on_signal TERM INT HUP

take_lock
read_request
set +e
storage_topology_lock
TOPOLOGY_LOCK_RC=$?
set -e
if [ "$TOPOLOGY_LOCK_RC" -ne 0 ]; then
  S_JOB="$REQ_OP"
  S_STATE=failed
  S_PHASE=""
  S_PCT=0
  S_STARTED="$(now_iso)"
  S_FINISHED="$S_STARTED"
  if [ "$TOPOLOGY_LOCK_RC" -eq 1 ]; then
    S_ERRCODE=busy
    S_ERROR="another storage operation is in progress"
  else
    S_ERRCODE=internal
    S_ERROR="recording storage could not be verified"
  fi
  write_state || true
  exit 0
fi
case "$REQ_OP" in
  migrate) job_migrate ;;
  delete_old) job_delete_old ;;
  *) die "unreachable operation" ;;
esac
exit 0
