"""Hermetic tests for the NVR recordings MIGRATION job (WARP-3514, ADR-070).

scripts/host/droplet-nvr-migrate.sh is the ExecStart of the root oneshot
droplet-nvr-migrate.service. The device-bridge (user `droplet`, sandboxed)
spools a request into its own StateDirectory and starts the unit with
`systemctl start --no-block`; the job then moves the camera footage from the
OLD Frigate recordings source onto the encrypted bay drive's `nvr/` dir,
reporting progress through `migrate-state.json`, or (owner-confirmed, tier 3)
deletes the old footage afterwards. This file pins that contract:

  * the request is UNTRUSTED (the spool dir is droplet-writable): strict
    validation, nothing is exec'd or touched for a hostile value;
  * OLD is resolved from ground truth (`docker inspect` of the frigate
    container), the root-only migration.json is only the fallback;
  * a root rsync BYPASSES the ext4 project quota, so the space preflight is the
    only thing preventing overshoot;
  * the copy is live and PATH-PRESERVING, then frigate is stopped, a delta pass
    runs (never `--delete`), a dry-run verifies, the container is recreated on
    the new drive, and OLD IS KEPT;
  * any failure after the stop rolls back (old container started, `.env`
    restored to the old value) and reports `failed` with an errorCode;
  * delete_old trusts ONLY the root-only record and never touches the live
    source.

The job is driven through subprocess with PATH shims for docker, rsync,
findmnt and du (Python scripts that log every argv together with the job's
current `phase`, so the state machine itself is asserted), a statfs hook, and
tmp spool / root-state / mount-base dirs: no root, no real docker, no real
block device. The tests labelled "real rsync smoke" additionally run the real
rsync binary to prove the path-preserving copy and the verify step end to end.

Run in Linux (bash + rsync + flock + GNU coreutils):
    C:/droplet-work/warp-3514/pytest-linux.sh scripts/test/pytest/test_nvr_migrate_script.py -q
The static (shape) tests run anywhere; the behavioural tests skip on Windows.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest
from _topology_lock_test_support import add_trusted_stat_env, install_trusted_stat_shim

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "host" / "droplet-nvr-migrate.sh"
UNIT = REPO_ROOT / "services" / "oled-display" / "droplet-nvr-migrate.service"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")

posix_world = pytest.mark.skipif(
    os.name == "nt" or BASH is None or shutil.which("python3") is None,
    reason="behavioural tests need a POSIX host (PATH shims, flock, GNU coreutils); "
           "run them through pytest-linux.sh",
)
needs_real_rsync = pytest.mark.skipif(
    shutil.which("rsync") is None, reason="real rsync not installed")
needs_root = pytest.mark.skipif(
    not hasattr(os, "geteuid") or os.geteuid() != 0, reason="needs root (chown fixtures)")

FS_UUID = "6f1d0c52-9a3e-4d71-8b24-0c5e7a1f3b90"
NEW_TAIL = "bay2-6f1d0c52"
OLD_TAIL = "bay1-11aa22bb"
VOL_NAME = "droplet_nvrdata"
OLD_CID = "a1b2c3d4e5f6" + "0" * 52          # 64 hex; `docker ps -q` prints the first 12
OLD_CID_SHORT = OLD_CID[:12]
OLD_BYTES = 123456

ISO_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
STATE_KEYS = {
    "request_id", "job", "state", "phase", "progressPct", "bytesCopied", "bytesTotal",
    "startedAt", "finishedAt", "error", "errorCode", "oldSource",
}
ERROR_CODES = {
    "insufficient_space", "rsync_missing", "docker_unavailable", "target_not_applied",
    "bad_source", "copy_failed", "verify_failed", "flip_failed", "interrupted", "busy",
    "no_old_footage", "delete_failed", "internal",
}
PHASES = {"preflight", "copy", "stop", "delta", "verify", "flip", "start", "cleanup", None}


# --------------------------------------------------------------------------
# PATH shims. ONE Python source, installed as docker / rsync / findmnt / du.
# Every call appends {tool, argv, phase, state} to $FAKE_DIR/calls.jsonl where
# phase/state are read from the job's own migrate-state.json AT CALL TIME, so a
# test can say "docker stop ran while the job reported phase=stop".
# --------------------------------------------------------------------------

SHIM_SRC = r'''
import json
import os
import shutil
import subprocess
import sys
import time

FAKE = os.environ["FAKE_DIR"]


def _load(name, default=None):
    try:
        with open(os.path.join(FAKE, name), encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def _save(name, data):
    with open(os.path.join(FAKE, name), "w", encoding="utf-8") as fh:
        json.dump(data, fh)


def _state_now():
    try:
        with open(os.environ["FAKE_STATE_PATH"], encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError, KeyError):
        return None


def _log(tool, argv):
    st = _state_now() or {}
    with open(os.path.join(FAKE, "calls.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"tool": tool, "argv": argv,
                             "phase": st.get("phase"), "state": st.get("state")}) + "\n")


def _real(tool):
    return shutil.which(tool, path=os.environ["FAKE_REAL_PATH"])


def _bump(name):
    cur = _load(name, {"n": 0})
    cur["n"] += 1
    _save(name, cur)
    return cur["n"]


def _env_source():
    value = "nvrdata"
    try:
        with open(os.environ["FAKE_ENV_FILE"], encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("NVR_MEDIA_SOURCE="):
                    value = line.rstrip("\n").split("=", 1)[1].strip("\"'") or "nvrdata"
                    break
    except FileNotFoundError:
        pass
    return value


# ---------------------------------------------------------------- docker
def docker(argv):
    if os.environ.get("FAKE_DOCKER_DOWN"):
        sys.stderr.write("Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n")
        return 1
    st = _load("docker.json")
    sub = argv[0] if argv else ""
    key = ("volume_" + argv[1]) if (sub == "volume" and len(argv) > 1) else sub
    st["counts"][key] = st["counts"].get(key, 0) + 1
    nth = st["counts"][key]
    spec = json.loads(os.environ.get("FAKE_DOCKER_FAIL", "{}")).get(key)
    _save("docker.json", st)
    if spec == "*" or (isinstance(spec, list) and nth in spec):
        sys.stderr.write("fake docker: injected failure for %s\n" % key)
        return 1
    containers = st["containers"]

    if sub == "ps":
        want = argv[argv.index("--filter") + 1] if "--filter" in argv else ""
        for cid, c in containers.items():
            if want.startswith("label="):
                k, _, v = want[len("label="):].partition("=")
                if c["Config"]["Labels"].get(k) != v:
                    continue
            if "-a" not in argv and not c["State"]["Running"]:
                continue
            print(cid[:12])
        return 0

    if sub == "inspect":
        out = []
        for want in argv[1:]:
            match = [c for cid, c in containers.items() if cid.startswith(want)]
            if not match:
                sys.stderr.write("Error: No such object: %s\n" % want)
                return 1
            out.append(match[0])
        print(json.dumps(out, indent=4))
        return 0

    if sub in ("stop", "start"):
        want = argv[-1]
        match = [cid for cid in containers if cid.startswith(want)]
        if not match:
            sys.stderr.write("Error response from daemon: No such container: %s\n" % want)
            return 1
        containers[match[0]]["State"]["Running"] = (sub == "start")
        _save("docker.json", st)
        print(want)
        return 0

    if sub == "compose":
        plan = json.loads(os.environ.get("FAKE_COMPOSE_PLAN", "[]"))
        step = plan[nth - 1] if nth - 1 < len(plan) else {}
        for cid in [k for k, c in containers.items()
                    if c["Config"]["Labels"].get("com.docker.compose.service") == "frigate"]:
            if step.get("fail") is None or step.get("remove_then_fail"):
                del containers[cid]
        if step.get("fail") or step.get("remove_then_fail"):
            _save("docker.json", st)
            sys.stderr.write("fake docker compose: injected failure\n")
            return 1
        value = _env_source()
        n = st["next_id"]
        st["next_id"] = n + 1
        cid = ("%012x" % (0xbeef00000000 + n)) + "c" * 52
        if value.startswith("/"):
            mount = {"Type": "bind", "Source": step.get("bind_override", value),
                     "Destination": "/media/frigate", "RW": True}
        else:
            name = "droplet_" + value
            mount = {"Type": "volume", "Name": name,
                     "Source": st["volumes"].get(name, {}).get("Mountpoint", "/nonexistent"),
                     "Destination": "/media/frigate", "RW": True}
        containers[cid] = {
            "Id": cid, "Name": "/droplet-frigate-1",
            "State": {"Status": "running", "Running": step.get("running", True)},
            "Config": {"Labels": {"com.docker.compose.service": "frigate"}},
            "Mounts": [{"Type": "volume", "Name": "droplet_frigate-config",
                        "Source": "/nonexistent/cfg", "Destination": "/config", "RW": True}, mount],
        }
        _save("docker.json", st)
        return 0

    if sub == "volume":
        action = argv[1] if len(argv) > 1 else ""
        vols = st["volumes"]
        if action == "ls":
            want = argv[argv.index("--filter") + 1] if "--filter" in argv else ""
            for name, v in vols.items():
                if want.startswith("label="):
                    k, _, val = want[len("label="):].partition("=")
                    if v.get("Labels", {}).get(k) != val:
                        continue
                print(name)
            return 0
        if action == "inspect":
            name = argv[-1]
            if name not in vols:
                sys.stderr.write("Error: No such volume: %s\n" % name)
                return 1
            print(json.dumps([{"Name": name, "Driver": "local",
                               "Mountpoint": vols[name]["Mountpoint"],
                               "Labels": vols[name].get("Labels", {})}]))
            return 0
        if action == "rm":
            name = argv[-1]
            if name not in vols:
                sys.stderr.write("Error response from daemon: get %s: no such volume\n" % name)
                return 1
            del vols[name]
            _save("docker.json", st)
            print(name)
            return 0
    sys.stderr.write("fake docker: unsupported invocation %r\n" % (argv,))
    return 2


# ---------------------------------------------------------------- rsync
def _capture(want):
    # Wait (bounded) for the job's state file to catch up with the progress
    # line just printed, then record what a bridge reader would see MID-COPY.
    path = os.environ["FAKE_STATE_PATH"]
    deadline = time.time() + 5
    seen = None
    while time.time() < deadline:
        seen = _state_now()
        if seen and seen.get("bytesCopied") == want:
            break
        time.sleep(0.05)
    with open(os.path.join(FAKE, "captures.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"want": want, "state": seen}) + "\n")


def _heartbeat_probe():
    path = os.environ["FAKE_STATE_PATH"]

    def mtime():
        try:
            return os.stat(path).st_mtime_ns
        except OSError:
            return None

    first = mtime()
    deadline = time.time() + 8
    changed = False
    while time.time() < deadline:
        time.sleep(0.2)
        if mtime() != first:
            changed = True
            break
    with open(os.path.join(FAKE, "captures.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"hb_changed": changed}) + "\n")


def rsync(argv):
    cfg = json.loads(os.environ.get("FAKE_RSYNC", "{}"))
    dry = "--dry-run" in argv
    if os.environ.get("FAKE_RSYNC_REAL"):
        rc = subprocess.call([_real("rsync")] + argv)
        if not dry:
            n = _bump("rsync_pass.json")
            post = cfg.get("real_post", {}).get(str(n)) or {}
            if post.get("rm"):
                try:
                    os.remove(post["rm"])
                except FileNotFoundError:
                    pass
        return rc
    if dry:
        sys.stdout.write(cfg.get("verify_out", ""))
        sys.stdout.flush()
        return cfg.get("verify_rc", 0)
    n = _bump("rsync_pass.json")
    passes = cfg.get("passes") or [{}]
    p = passes[min(n, len(passes)) - 1]
    sep = p.get("sep", ",")
    for b in p.get("progress", []):
        pct = min(100, b * 100 // max(1, p.get("total", 10 * max(p["progress"]))))
        sys.stdout.write("\r%15s %3d%%   1.00MB/s    0:00:01" % (("{:,}".format(b)).replace(",", sep), pct))
        sys.stdout.flush()
        if cfg.get("capture"):
            _capture(b)
        time.sleep(p.get("sleep", 0))
    if cfg.get("heartbeat_probe") and n == 1:
        _heartbeat_probe()
    if p.get("hang"):
        time.sleep(p["hang"])
    if p.get("stderr"):
        sys.stderr.write(p["stderr"] + "\n")
    sys.stdout.write("\n")
    sys.stdout.flush()
    return p.get("rc", 0)


# ---------------------------------------------------------------- findmnt / du
def findmnt(argv):
    table = _load("findmnt.json", {})
    for a in argv:
        if a.startswith("UUID="):
            targets = table.get(a[len("UUID="):], [])
            for t in targets:
                print(t)
            return 0 if targets else 1
    return 1


def du(argv):
    path = argv[-1]
    table = _load("du.json", {})
    if path in table:
        if os.environ.get("FAKE_DU_FAIL"):
            sys.stderr.write("du: cannot access something: No such file or directory\n")
        sys.stdout.write("%d\t%s\n" % (table[path], path))
        sys.stdout.flush()
        return 1 if os.environ.get("FAKE_DU_FAIL") else 0
    real = _real("du")
    os.execv(real, [real] + argv)


def main():
    tool = os.path.basename(sys.argv[0])
    argv = sys.argv[1:]
    _log(tool, argv)
    rc = globals()[tool](argv)
    sys.stdout.flush()
    sys.exit(rc or 0)


main()
'''

SHIM_TOOLS = ("docker", "rsync", "findmnt", "du")

# Real tools the job needs besides the shims; used to build a RESTRICTED PATH so
# "rsync missing" / "docker missing" are tested for real, not by convention.
REAL_TOOLS = (
    "bash", "sh", "env", "python3", "cat", "date", "mkdir", "rm", "mv", "chmod", "chown",
    "stat", "tr", "head", "tail", "grep", "sed", "sleep", "readlink", "dirname", "basename",
    "find", "flock", "id", "mktemp", "touch", "ln", "cut", "sort", "uniq", "wc", "tee",
    "kill", "true", "false", "test", "realpath", "install", "printf", "awk",
)


class Result:
    def __init__(self, box: "Box", proc: subprocess.CompletedProcess):
        self.box = box
        self.proc = proc
        self.rc = proc.returncode
        self.out = proc.stdout
        self.err = proc.stderr

    @property
    def state(self):
        return self.box.state()


def assert_state_schema(st):
    assert set(st) == STATE_KEYS, sorted(set(st) ^ STATE_KEYS)
    assert st["state"] in {"running", "done", "failed"}
    assert st["job"] in {"migrate", "delete_old", None}
    assert st["phase"] in PHASES, st["phase"]
    for k in ("progressPct", "bytesCopied", "bytesTotal"):
        assert isinstance(st[k], int) and not isinstance(st[k], bool) and st[k] >= 0, (k, st[k])
    assert 0 <= st["progressPct"] <= 100
    assert isinstance(st["request_id"], str)
    assert ISO_RE.fullmatch(st["startedAt"] or ""), st["startedAt"]
    assert st["finishedAt"] is None or ISO_RE.fullmatch(st["finishedAt"]), st["finishedAt"]
    assert st["error"] is None or isinstance(st["error"], str)
    assert st["errorCode"] is None or st["errorCode"] in ERROR_CODES, st["errorCode"]
    old = st["oldSource"]
    if old is not None:
        assert set(old) == {"kind", "source", "bytes", "deleted"}, old
        assert old["kind"] in {"volume", "path"}
        assert isinstance(old["source"], str) and old["source"]
        assert isinstance(old["bytes"], int) and not isinstance(old["bytes"], bool)
        assert isinstance(old["deleted"], bool)
    if st["state"] == "failed":
        assert st["errorCode"] and st["error"] and st["finishedAt"], st
    if st["state"] == "done":
        assert st["errorCode"] is None and st["error"] is None, st
        assert st["progressPct"] == 100 and st["finishedAt"], st
    if st["state"] == "running":
        assert st["finishedAt"] is None and st["errorCode"] is None, st


class Box:
    """A hermetic world: spool dir, root-only state dir, mount base, a fake
    docker daemon holding the OLD frigate container (recordings on the
    `droplet_nvrdata` volume), a mounted+applied NEW bay drive, and the shims."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.bin = tmp / "bin"
        self.fake = tmp / "fake"
        self.spool = tmp / "spool"
        self.rootstate = tmp / "rootstate"
        self.topology_lock = tmp / "recordings-topology.lock"
        self.mnt = tmp / "mnt" / "droplet"
        self.vol_root = tmp / "dockerroot" / "volumes"
        self.envfile = tmp / "repo.env"
        self.compose = tmp / "docker-compose.yml"
        for d in (self.bin, self.fake, self.spool, self.rootstate, self.mnt, self.vol_root):
            d.mkdir(parents=True)
        self.topology_lock.touch()
        install_trusted_stat_shim(self.bin / "topology-lock-stat", self.topology_lock)
        self.spool.chmod(0o700)
        self.rootstate.chmod(0o700)
        for tool in SHIM_TOOLS:
            p = self.bin / tool
            p.write_text(f"#!{sys.executable}\n" + SHIM_SRC, encoding="utf-8")
            p.chmod(0o755)
        self.compose.write_text("services: {}\n", encoding="utf-8")

        # OLD: the docker volume the running frigate container writes to.
        self.old_vol = self.vol_root / VOL_NAME / "_data"
        (self.old_vol / "recordings" / "2026-10-03" / "cam1").mkdir(parents=True)
        (self.old_vol / "recordings" / "2026-10-03" / "cam1" / "seg1.mp4").write_bytes(b"x" * 64)
        (self.old_vol / "exports").mkdir()

        # NEW: the bay drive, mounted under the mount base and already applied
        # (nvr/ 0700, NVR_MEDIA_SOURCE pointing at it).
        self.new_mount = self.mnt / NEW_TAIL
        self.new = self.new_mount / "nvr"
        self.new.mkdir(parents=True)
        self.new.chmod(0o700)
        (self.new_mount / "files").mkdir()

        self.write_json("fake/docker.json", {
            "counts": {}, "next_id": 1,
            "containers": {OLD_CID: {
                "Id": OLD_CID, "Name": "/droplet-frigate-1",
                "State": {"Status": "running", "Running": True},
                "Config": {"Labels": {"com.docker.compose.service": "frigate",
                                      "com.docker.compose.project": "droplet"}},
                "Mounts": [
                    {"Type": "volume", "Name": "droplet_frigate-config",
                     "Source": "/var/lib/docker/volumes/droplet_frigate-config/_data",
                     "Destination": "/config", "RW": True},
                    {"Type": "bind", "Source": "/etc/localtime",
                     "Destination": "/etc/localtime", "RW": False},
                    {"Type": "volume", "Name": VOL_NAME, "Source": str(self.old_vol),
                     "Destination": "/media/frigate", "RW": True},
                ]}},
            "volumes": {VOL_NAME: {"Mountpoint": str(self.old_vol),
                                   "Labels": {"com.docker.compose.volume": "nvrdata",
                                              "com.docker.compose.project": "droplet"}}},
        })
        self.write_json("fake/findmnt.json", {FS_UUID: [str(self.new_mount)]})
        self.write_json("fake/du.json", {str(self.old_vol): OLD_BYTES})
        self.set_statfs(4096, 1_000_000, 900_000, 900_000)
        self.envfile.write_text(
            "JWT_SECRET=keepme-not-a-secret\nNVR_MEDIA_SOURCE=nvrdata\nOTHER_KEY=also-kept\n",
            encoding="utf-8")
        self.write_record({"previousSource": "nvrdata", "newSource": str(self.new),
                           "fsUuid": FS_UUID, "recordedAt": "2026-10-03T00:00:00Z"})

    # ------------------------------------------------------------ fixtures
    def write_json(self, rel: str, data) -> None:
        (self.tmp / rel).write_text(json.dumps(data), encoding="utf-8")

    def read_json(self, path: Path):
        return json.loads(path.read_text(encoding="utf-8"))

    def docker_state(self):
        return self.read_json(self.fake / "docker.json")

    def save_docker(self, st) -> None:
        self.write_json("fake/docker.json", st)

    def write_record(self, rec) -> None:
        (self.rootstate / "migration.json").write_text(json.dumps(rec), encoding="utf-8")

    def record(self):
        p = self.rootstate / "migration.json"
        return self.read_json(p) if p.exists() else None

    def set_du(self, path, nbytes) -> None:
        table = self.read_json(self.fake / "du.json")
        table[str(path)] = nbytes
        self.write_json("fake/du.json", table)

    def set_statfs(self, frsize, blocks, bfree, bavail) -> None:
        hook = self.bin / "statfs-hook"
        hook.write_text(f"#!/bin/sh\necho '{frsize} {blocks} {bfree} {bavail}'\n", encoding="utf-8")
        hook.chmod(0o755)

    def set_frigate_mount(self, mount) -> None:
        st = self.docker_state()
        c = st["containers"][OLD_CID]
        c["Mounts"] = [m for m in c["Mounts"] if m["Destination"] != "/media/frigate"]
        if mount is not None:
            c["Mounts"].append(dict(mount, Destination="/media/frigate", RW=True))
        self.save_docker(st)

    def set_frigate_running(self, running: bool) -> None:
        st = self.docker_state()
        st["containers"][OLD_CID]["State"]["Running"] = running
        self.save_docker(st)

    def make_old_bay(self, files=True) -> Path:
        """OLD is a previous bay drive's nvr/ (kind path): frigate binds it."""
        old_mount = self.mnt / OLD_TAIL
        old_nvr = old_mount / "nvr"
        (old_nvr / "recordings" / "cam1").mkdir(parents=True)
        if files:
            (old_nvr / "recordings" / "cam1" / "seg1.mp4").write_bytes(b"y" * 32)
            (old_nvr / ".dotfile").write_text("hidden", encoding="utf-8")
        (old_mount / "files").mkdir(exist_ok=True)
        (old_mount / "files" / "canary.txt").write_text("not-recordings", encoding="utf-8")
        self.set_frigate_mount({"Type": "bind", "Source": str(old_nvr)})
        self.set_du(old_nvr, OLD_BYTES)
        return old_nvr

    def point_frigate_at_new(self) -> None:
        self.set_frigate_mount({"Type": "bind", "Source": str(self.new)})

    def after_migration(self, kind="volume") -> Path | str:
        """The box as it is once a migration completed: frigate runs on NEW and
        the root-only record carries the (kept) old source."""
        self.point_frigate_at_new()
        if kind == "volume":
            old = {"kind": "volume", "source": VOL_NAME, "bytes": OLD_BYTES, "deleted": False}
            prev = "nvrdata"
            ret = VOL_NAME
        else:
            old_nvr = self.make_old_bay()
            self.point_frigate_at_new()
            old = {"kind": "path", "source": str(old_nvr), "bytes": OLD_BYTES, "deleted": False}
            prev = str(old_nvr)
            ret = old_nvr
        self.envfile.write_text(
            f"JWT_SECRET=keepme-not-a-secret\nNVR_MEDIA_SOURCE={self.new}\nOTHER_KEY=also-kept\n",
            encoding="utf-8")
        self.write_record({"previousSource": prev, "newSource": str(self.new), "fsUuid": FS_UUID,
                           "recordedAt": "2026-10-03T00:00:00Z", "oldSource": old,
                           "migratedAt": "2026-10-03T01:00:00Z"})
        return ret

    # ------------------------------------------------------------ observe
    def state(self):
        p = self.spool / "migrate-state.json"
        if not p.exists():
            return None
        st = self.read_json(p)
        assert_state_schema(st)
        return st

    def calls(self, *tools):
        p = self.fake / "calls.jsonl"
        if not p.exists():
            return []
        out = []
        for line in p.read_text(encoding="utf-8").splitlines():
            rec = json.loads(line)
            if not tools or rec["tool"] in tools:
                out.append([rec["tool"]] + rec["argv"])
        return out

    def calls_with_phase(self, *tools):
        p = self.fake / "calls.jsonl"
        out = []
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                rec = json.loads(line)
                if not tools or rec["tool"] in tools:
                    out.append(([rec["tool"]] + rec["argv"], rec["phase"]))
        return out

    def captures(self):
        p = self.fake / "captures.jsonl"
        if not p.exists():
            return []
        return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines()]

    def env_value(self):
        for line in self.envfile.read_text(encoding="utf-8").splitlines():
            if line.startswith("NVR_MEDIA_SOURCE="):
                return line.split("=", 1)[1]
        return None

    def frigate_containers(self):
        st = self.docker_state()
        return [c for c in st["containers"].values()
                if c["Config"]["Labels"].get("com.docker.compose.service") == "frigate"]

    @staticmethod
    def mount_of(container):
        return [m for m in container["Mounts"] if m["Destination"] == "/media/frigate"][0]

    # ------------------------------------------------------------ run
    def restricted_path(self, exclude=()) -> str:
        rbin = self.tmp / "rbin"
        if rbin.exists():
            shutil.rmtree(rbin)
        rbin.mkdir()
        for tool in SHIM_TOOLS:
            if tool not in exclude:
                os.symlink(self.bin / tool, rbin / tool)
        for tool in REAL_TOOLS:
            if tool in exclude:
                continue
            if tool == "stat":
                os.symlink(self.bin / "topology-lock-stat" / "stat", rbin / tool)
                continue
            real = shutil.which(tool)
            if real and not (rbin / tool).exists():
                os.symlink(real, rbin / tool)
        return str(rbin)

    def env_for(self, **extra) -> dict:
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("DROPLET_NVR_", "FAKE_", "NVR_"))}
        env.update({
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "FAKE_DIR": str(self.fake),
            "FAKE_REAL_PATH": os.environ["PATH"],
            "FAKE_ENV_FILE": str(self.envfile),
            "FAKE_STATE_PATH": str(self.spool / "migrate-state.json"),
            "DROPLET_NVR_SPOOL_DIR": str(self.spool),
            "DROPLET_NVR_ROOT_STATE_DIR": str(self.rootstate),
            "DROPLET_STORAGE_TOPOLOGY_LOCK_FILE": str(self.topology_lock),
            "DROPLET_NVR_MEDIA_ENV_FILE": str(self.envfile),
            "DROPLET_NVR_MEDIA_COMPOSE_FILE": str(self.compose),
            "DROPLET_NVR_MOUNT_BASE": str(self.mnt),
            "DROPLET_NVR_MEDIA_STATFS": str(self.bin / "statfs-hook"),
            "DROPLET_NVR_MIGRATE_PROGRESS_SECS": "0",
            "DROPLET_NVR_MIGRATE_START_WAIT_SECS": "0",
            "REPO_ROOT": str(REPO_ROOT),
        })
        env.update({k: str(v) for k, v in extra.items()})
        return add_trusted_stat_env(env, self.bin, self.topology_lock)

    def write_request(self, operation="migrate", params=None, request_id="req-1", raw=None):
        path = self.spool / "migrate-request.json"
        if raw is not None:
            path.write_text(raw, encoding="utf-8")
            return
        if params is None:
            params = {"fsUuid": FS_UUID} if operation == "migrate" else {}
        path.write_text(json.dumps({"request_id": request_id, "operation": operation,
                                    "params": params}), encoding="utf-8")

    def _full_env(self, rsync, docker_fail, compose_plan, env, path):
        e = self.env_for(**(env or {}))
        if rsync is not None:
            e["FAKE_RSYNC"] = json.dumps(rsync)
        if docker_fail is not None:
            e["FAKE_DOCKER_FAIL"] = json.dumps(docker_fail)
        if compose_plan is not None:
            e["FAKE_COMPOSE_PLAN"] = json.dumps(compose_plan)
        if path is not None:
            e["PATH"] = path
        return e

    def run(self, operation="migrate", *, params=None, request_id="req-1", raw=None,
            rsync=None, docker_fail=None, compose_plan=None, env=None, path=None,
            write_request=True, timeout=120) -> Result:
        if write_request:
            self.write_request(operation, params, request_id, raw)
        proc = subprocess.run(
            [BASH, str(SCRIPT)], env=self._full_env(rsync, docker_fail, compose_plan, env, path),
            cwd=str(self.tmp), capture_output=True, text=True, timeout=timeout)
        return Result(self, proc)

    def start(self, operation="migrate", *, params=None, rsync=None, docker_fail=None,
              compose_plan=None, env=None) -> subprocess.Popen:
        """Non-blocking run in its own session, so a test can signal the whole
        process group the way systemd does on `systemctl stop`."""
        self.write_request(operation, params)
        return subprocess.Popen(
            [BASH, str(SCRIPT)], env=self._full_env(rsync, docker_fail, compose_plan, env, None),
            cwd=str(self.tmp), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True)

    def wait_for_phase(self, phase, timeout=40):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                st = self.read_json(self.spool / "migrate-state.json")
            except (OSError, ValueError):
                st = None
            if st and st.get("phase") == phase and st.get("state") == "running":
                return st
            time.sleep(0.1)
        raise AssertionError(f"job never reached phase {phase!r}")


@pytest.fixture
def box(tmp_path):
    return Box(tmp_path)


def argv_of(tool, *args):
    return [tool, *args]


def rsync_copy_argv(old, new):
    return ["rsync", "-aHAX", "--numeric-ids", "--info=progress2", f"{old}/", f"{new}/"]


PS_ARGV = ["docker", "ps", "-a", "-q", "--filter", "label=com.docker.compose.service=frigate"]


def assert_nothing_executed(box):
    assert box.calls() == [], box.calls()


def assert_env_untouched(box, original: bytes):
    assert box.envfile.read_bytes() == original


# ==========================================================================
# Static shape
# ==========================================================================

def test_script_exists_and_is_bash():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    lines = SCRIPT.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "#!/usr/bin/env bash"
    assert "set -euo pipefail" in lines


def test_script_parses_and_is_lf_only():
    assert b"\r" not in SCRIPT.read_bytes(), "script must use LF line endings"
    proc = subprocess.run([BASH, "-n", str(SCRIPT)], capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr


def _code_lines():
    return [ln for ln in SCRIPT.read_text(encoding="utf-8").splitlines()
            if ln.strip() and not ln.lstrip().startswith("#")]


def test_script_never_uses_eval_polling_loops_or_rsync_delete():
    """WARP-843: argv arrays, no eval. House rule: no `while true` schedulers.
    Product rule: the copy NEVER deletes (neither side is ever pruned)."""
    for ln in _code_lines():
        assert not re.search(r"\beval\b", ln), ln
        assert not re.search(r"\bwhile\s+(true|:)\b", ln), ln
        assert "--delete" not in ln and "-delete" not in ln, ln


def test_script_uses_shipping_names_and_cites_adr_070():
    text = SCRIPT.read_text(encoding="utf-8")
    assert not re.search(r"\b(poc|prototype)\b", text, re.I)
    assert not re.search(r"(--[a-z0-9-]*)(-|_)(dev|test)\b", text)
    assert "ADR-070" in text
    assert "ADR-069" not in text


def test_delete_path_uses_one_file_system_and_contents_only():
    body = SCRIPT.read_text(encoding="utf-8")
    assert "--one-file-system" in body
    assert "-mindepth 1" in body, "path deletion must target the CONTENTS only, never the nvr dir itself"


def test_unit_file_shape():
    assert UNIT.exists(), f"missing {UNIT}"
    text = UNIT.read_text(encoding="utf-8")
    assert "\r" not in text
    code = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    assert "[Unit]" in code and "[Service]" in code
    assert "[Install]" not in code, "on-demand unit: never enabled, never runs at boot"
    for needle in (
        "Type=oneshot",
        "ExecStart=/usr/local/sbin/droplet-nvr-migrate.sh",
        "TimeoutStartSec=infinity",
        "Environment=REPO_ROOT=@REPO_ROOT@",
        "PrivateNetwork=true",
        "ProtectKernelTunables=true",
        "ProtectKernelModules=true",
        "ProtectKernelLogs=true",
        "ProtectControlGroups=true",
        "RestrictAddressFamilies=AF_UNIX",
        "LockPersonality=true",
        "RestrictRealtime=true",
    ):
        assert needle in code, needle
    path_line = [ln for ln in code if ln.startswith("Environment=PATH=")]
    assert path_line and "/usr/sbin" in path_line[0] and "/usr/bin" in path_line[0]
    # It writes <repo>/.env under /home and rsyncs onto /mnt + docker's data root.
    for ln in code:
        assert not ln.startswith(("ProtectHome=", "ProtectSystem=", "PrivateDevices=")), ln
    assert "ADR-070" in text and "ADR-069" not in text


# ==========================================================================
# migrate: happy paths
# ==========================================================================

@posix_world
def test_shared_topology_lock_contention_fails_closed_without_host_commands(box):
    import fcntl

    box.write_request()
    fd = os.open(box.topology_lock, os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = box.run(write_request=False)
    finally:
        os.close(fd)

    assert result.rc == 0, result.err
    assert result.state["state"] == "failed"
    assert result.state["errorCode"] == "busy"
    assert not box.calls(), "migration issued a host command while topology was locked"


@posix_world
def test_happy_path_volume_source_exact_ordered_sequence(box):
    original_env = box.envfile.read_bytes()
    r = box.run()
    assert r.rc == 0, r.err
    new_cid = box.frigate_containers()[0]["Id"]
    assert new_cid != OLD_CID, "frigate must have been recreated"
    old, new = str(box.old_vol), str(box.new)
    assert box.calls("docker", "rsync") == [
        PS_ARGV,
        ["docker", "inspect", OLD_CID_SHORT],
        rsync_copy_argv(old, new),
        ["docker", "stop", "-t", "60", OLD_CID_SHORT],
        rsync_copy_argv(old, new),
        ["rsync", "-a", "--dry-run", "--itemize-changes", f"{old}/", f"{new}/"],
        ["docker", "compose", "-f", str(box.compose), "up", "-d", "--force-recreate", "frigate"],
        PS_ARGV,
        ["docker", "inspect", new_cid[:12]],
    ]
    # NEW is resolved first; du measures OLD before anything is copied.
    full = box.calls()
    assert full[0] == ["findmnt", "-rn", "-S", f"UUID={FS_UUID}", "-o", "TARGET"]
    first_rsync = next(i for i, c in enumerate(full) if c[0] == "rsync")
    assert ["du", "-sb", old] in full[:first_rsync]
    # The recreated container writes to the NEW bay, OLD is untouched.
    assert box.mount_of(box.frigate_containers()[0])["Source"] == new
    assert box.env_value() == new


@posix_world
def test_happy_path_state_document_and_records(box):
    original_env = box.envfile.read_bytes()
    r = box.run(request_id="req-happy-1")
    assert r.rc == 0, r.err
    st = r.state
    assert st["request_id"] == "req-happy-1" and st["job"] == "migrate"
    assert st["state"] == "done" and st["phase"] is None and st["progressPct"] == 100
    assert st["bytesTotal"] == st["bytesCopied"] == OLD_BYTES
    assert st["startedAt"] <= st["finishedAt"]
    assert st["error"] is None and st["errorCode"] is None
    assert st["oldSource"] == {"kind": "volume", "source": VOL_NAME, "bytes": OLD_BYTES,
                               "deleted": False}
    # The flip is the ONLY writer of NVR_MEDIA_SOURCE (WARP-3514): it lands on NEW,
    # every other line of the .env is preserved byte for byte.
    assert original_env == (b"JWT_SECRET=keepme-not-a-secret\nNVR_MEDIA_SOURCE=nvrdata\n"
                            b"OTHER_KEY=also-kept\n")
    body = box.envfile.read_text(encoding="utf-8")
    assert f"NVR_MEDIA_SOURCE={box.new}\n" in body and body.count("NVR_MEDIA_SOURCE=") == 1
    assert "JWT_SECRET=keepme-not-a-secret\n" in body and "OTHER_KEY=also-kept\n" in body
    rec = box.record()
    assert rec["previousSource"] == "nvrdata"
    assert rec["newSource"] == str(box.new) and rec["fsUuid"] == FS_UUID
    assert rec["recordedAt"] == "2026-10-03T00:00:00Z", "the writer's own fields are preserved"
    assert rec["oldSource"] == st["oldSource"]
    assert ISO_RE.fullmatch(rec["migratedAt"])
    # The request was consumed so it can never be replayed.
    assert not (box.spool / "migrate-request.json").exists()
    assert stat.S_IMODE(os.stat(box.spool / "migrate-state.json").st_mode) == 0o600


@posix_world
def test_old_footage_is_kept_and_nothing_is_ever_deleted(box):
    r = box.run()
    assert r.rc == 0, r.err
    assert (box.old_vol / "recordings" / "2026-10-03" / "cam1" / "seg1.mp4").read_bytes() == b"x" * 64
    assert box.docker_state()["volumes"].keys() == {VOL_NAME}, "the old volume must survive"
    for call in box.calls("docker"):
        assert call[1:3] != ["volume", "rm"], call
    for call in box.calls("rsync"):
        assert not any(a.startswith("--delete") for a in call), call


@posix_world
def test_phases_reported_while_each_step_runs(box):
    """The state file names the step AS it runs (the bridge/orchestrator poll it)."""
    r = box.run()
    assert r.rc == 0, r.err
    phased = box.calls_with_phase("docker", "rsync", "du")
    by_argv = {}
    for argv, phase in phased:
        by_argv.setdefault(tuple(argv), []).append(phase)
    old, new = str(box.old_vol), str(box.new)
    assert by_argv[tuple(PS_ARGV)][0] == "preflight"
    assert by_argv[("du", "-sb", old)][0] == "preflight"
    copies = by_argv[tuple(rsync_copy_argv(old, new))]
    assert copies == ["copy", "delta"]
    assert by_argv[("docker", "stop", "-t", "60", OLD_CID_SHORT)] == ["stop"]
    assert by_argv[("rsync", "-a", "--dry-run", "--itemize-changes", f"{old}/", f"{new}/")] == ["verify"]
    compose = ("docker", "compose", "-f", str(box.compose), "up", "-d", "--force-recreate", "frigate")
    assert by_argv[compose] == ["flip"]
    # The post-restart health check runs in phase `start`.
    assert by_argv[tuple(PS_ARGV)][-1] == "start"


@posix_world
def test_happy_path_bay_source_kind_path(box):
    old_nvr = box.make_old_bay()
    r = box.run()
    assert r.rc == 0, r.err
    assert rsync_copy_argv(old_nvr, box.new) in box.calls("rsync")
    assert r.state["oldSource"] == {"kind": "path", "source": str(old_nvr),
                                    "bytes": OLD_BYTES, "deleted": False}
    assert (old_nvr / "recordings" / "cam1" / "seg1.mp4").exists(), "old drive footage kept"
    assert box.record()["previousSource"] == str(old_nvr)


@posix_world
def test_old_source_comes_from_the_container_not_from_the_record(box):
    """Ground truth beats the root-only record: the record says another drive
    while the running container is on the docker volume."""
    other = box.mnt / "ghost-deadbeef" / "nvr"
    other.mkdir(parents=True)
    box.write_record({"previousSource": str(other), "newSource": str(box.new), "fsUuid": FS_UUID,
                      "recordedAt": "2026-10-03T00:00:00Z"})
    r = box.run()
    assert r.rc == 0, r.err
    srcs = [c[-2] for c in box.calls("rsync") if "--dry-run" not in c]
    assert srcs and all(s == f"{box.old_vol}/" for s in srcs), srcs
    assert r.state["oldSource"]["kind"] == "volume"


@posix_world
def test_no_container_falls_back_to_the_record_volume_name(box):
    st = box.docker_state()
    st["containers"] = {}
    box.save_docker(st)
    r = box.run()
    assert r.rc == 0, r.err
    docker_calls = box.calls("docker")
    assert docker_calls[0] == PS_ARGV
    assert ["docker", "volume", "ls", "-q", "--filter",
            "label=com.docker.compose.volume=nvrdata"] in docker_calls
    assert ["docker", "volume", "inspect", VOL_NAME] in docker_calls
    assert not any(c[1] in ("stop", "start") for c in docker_calls), "nothing to stop"
    assert rsync_copy_argv(box.old_vol, box.new) in box.calls("rsync")
    assert any(c[1] == "compose" for c in docker_calls), "frigate is created on the new drive"
    assert r.state["state"] == "done"
    assert r.state["oldSource"]["source"] == VOL_NAME


@posix_world
def test_no_container_falls_back_to_the_record_path(box):
    old_nvr = box.make_old_bay()
    st = box.docker_state()
    st["containers"] = {}
    box.save_docker(st)
    box.write_record({"previousSource": str(old_nvr), "newSource": str(box.new),
                      "fsUuid": FS_UUID, "recordedAt": "2026-10-03T00:00:00Z"})
    r = box.run()
    assert r.rc == 0, r.err
    assert rsync_copy_argv(old_nvr, box.new) in box.calls("rsync")
    assert r.state["oldSource"]["kind"] == "path"


@posix_world
def test_quoted_env_value_is_accepted(box):
    box.envfile.write_text(f'JWT_SECRET=x\nNVR_MEDIA_SOURCE="{box.new}"\n', encoding="utf-8")
    r = box.run()
    assert r.rc == 0, r.err
    assert r.state["state"] == "done"


@posix_world
def test_runs_without_repo_root_in_the_environment_when_in_tree(box):
    env = box.env_for()
    del env["REPO_ROOT"]
    box.write_request()
    proc = subprocess.run([BASH, str(SCRIPT)], env=env, cwd=str(box.tmp),
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    assert box.state()["state"] == "done"


@posix_world
def test_default_statfs_implementation_works_without_the_hook(box):
    r = box.run(env={"DROPLET_NVR_MEDIA_STATFS": ""})
    assert r.rc == 0, r.err
    assert r.state["state"] == "done"


# ==========================================================================
# migrate: already migrated (idempotent)
# ==========================================================================

@posix_world
def test_old_equals_new_is_done_immediately_and_touches_nothing(box):
    box.point_frigate_at_new()
    original_env = box.envfile.read_bytes()
    r = box.run()
    assert r.rc == 0, r.err
    assert [c for c in box.calls("docker", "rsync")] == [PS_ARGV, ["docker", "inspect", OLD_CID_SHORT]]
    st = r.state
    assert st["state"] == "done" and st["phase"] is None and st["progressPct"] == 100
    assert st["oldSource"] is None, "no completed migration is recorded, so no old source"
    assert_env_untouched(box, original_env)


@posix_world
def test_old_equals_new_ensures_frigate_runs(box):
    box.point_frigate_at_new()
    box.set_frigate_running(False)
    r = box.run()
    assert r.rc == 0, r.err
    assert box.calls("docker", "rsync") == [
        PS_ARGV, ["docker", "inspect", OLD_CID_SHORT], ["docker", "start", OLD_CID_SHORT]]
    assert r.state["state"] == "done"


@posix_world
def test_rerun_after_success_is_a_noop_that_keeps_the_old_source(box):
    first = box.run(request_id="first")
    assert first.rc == 0, first.err
    done_old = first.state["oldSource"]
    n_calls = len(box.calls())
    second = box.run(request_id="second")
    assert second.rc == 0, second.err
    new_calls = box.calls()[n_calls:]
    assert [c[0] for c in new_calls if c[0] == "rsync"] == [], "a re-run must not copy again"
    assert not any(c[:2] in (["docker", "stop"], ["docker", "compose"]) for c in new_calls)
    st = second.state
    assert st["request_id"] == "second" and st["state"] == "done"
    assert st["oldSource"] == done_old, "the kept old footage stays visible/deletable"


@posix_world
def test_rerun_keeps_a_deleted_flag(box):
    box.after_migration()
    rec = box.record()
    rec["oldSource"]["deleted"] = True
    box.write_record(rec)
    r = box.run()
    assert r.rc == 0, r.err
    assert r.state["oldSource"]["deleted"] is True


# ==========================================================================
# migrate: NEW target resolution (all refusals touch nothing)
# ==========================================================================

@posix_world
def test_target_not_mounted_is_refused(box):
    box.write_json("fake/findmnt.json", {})
    original_env = box.envfile.read_bytes()
    r = box.run()
    assert r.rc == 0, r.err
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "target_not_applied"
    assert st["phase"] == "preflight"
    assert [c[0] for c in box.calls()] == ["findmnt"], "nothing but the mount lookup ran"
    assert_env_untouched(box, original_env)


@pytest.mark.parametrize("target", [
    "/etc", "/", "/mnt", "{mnt}", "{mnt}/a/b", "{mnt}/../etc", "/mnt/droplet/x y",
    "{mnt}/bad name", "{mnt}/-rf", "{mnt}/.hidden-ok-but-must-start-alnum",
])
@posix_world
def test_mount_outside_the_allowed_shape_is_refused(box, target):
    target = target.replace("{mnt}", str(box.mnt))
    box.write_json("fake/findmnt.json", {FS_UUID: [target]})
    r = box.run()
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "target_not_applied"
    assert [c[0] for c in box.calls()] == ["findmnt"]


@posix_world
def test_a_target_that_was_not_prepared_is_refused(box):
    """`--apply` must have PREPARED this exact target (root-only record names it);
    the job never guesses. Since 2026-10-04 `--apply` does not touch the .env."""
    (box.rootstate / "migration.json").unlink()
    original_env = box.envfile.read_bytes()
    r = box.run()
    assert r.rc == 0, r.err
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "target_not_applied"
    assert box.calls("docker", "rsync", "du") == []
    assert_env_untouched(box, original_env)


@posix_world
@pytest.mark.parametrize("new_source", [
    "{mnt}/other-0a0a0a0a/nvr",        # a different drive
    "{new}/",                          # trailing slash: not the path the job resolved
    "",                                # empty
])
def test_a_record_naming_another_target_is_refused(box, new_source):
    box.write_record({"previousSource": "nvrdata",
                      "newSource": new_source.replace("{new}", str(box.new)).replace("{mnt}", str(box.mnt)),
                      "fsUuid": FS_UUID, "recordedAt": "2026-10-03T00:00:00Z"})
    r = box.run()
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "target_not_applied"
    assert box.calls("docker", "rsync") == []


@posix_world
def test_the_env_alone_is_enough_when_the_flip_already_happened(box):
    """A re-run after a completed flip: no record, but .env already names NEW."""
    (box.rootstate / "migration.json").unlink()
    box.envfile.write_text(f"NVR_MEDIA_SOURCE={box.new}\n", encoding="utf-8")
    r = box.run()
    assert r.state["errorCode"] != "target_not_applied", r.err


@posix_world
def test_the_flip_is_the_only_writer_of_the_env_and_it_lands_after_the_verify(box):
    r = box.run()
    assert r.state["state"] == "done", (r.state, r.err)
    assert f"NVR_MEDIA_SOURCE={box.new}\n" in box.envfile.read_text(encoding="utf-8")


@posix_world
def test_nvr_dir_missing_or_a_symlink_is_refused(box, tmp_path):
    shutil.rmtree(box.new)
    r = box.run()
    assert r.state["errorCode"] == "target_not_applied"
    assert box.calls("docker", "rsync") == []
    victim = tmp_path / "victim"
    victim.mkdir()
    os.symlink(victim, box.new)
    r = box.run()
    assert r.state["errorCode"] == "target_not_applied"
    assert box.calls("docker", "rsync") == []
    assert list(victim.iterdir()) == [], "a symlinked nvr must never be written through"


@posix_world
def test_findmnt_missing_is_target_not_applied(box):
    r = box.run(path=box.restricted_path(exclude=("findmnt",)))
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "target_not_applied"
    assert box.calls("docker", "rsync") == []


# ==========================================================================
# migrate: OLD source resolution refusals
# ==========================================================================

def _bind(box, src):
    box.set_frigate_mount({"Type": "bind", "Source": src})


def _volume(box, name, src):
    box.set_frigate_mount({"Type": "volume", "Name": name, "Source": src})


BAD_SOURCES = {
    "bind-etc": lambda b: _bind(b, "/etc"),
    "bind-root": lambda b: _bind(b, "/"),
    "bind-os-disk-data": lambda b: _bind(b, "/data/nvr"),
    "bind-mount-root-without-nvr": lambda b: _bind(b, str(b.mnt / OLD_TAIL)),
    "bind-nvr2": lambda b: _bind(b, str(b.mnt / OLD_TAIL / "nvr2")),
    "bind-extra-component": lambda b: _bind(b, str(b.mnt / "a" / "b" / "nvr")),
    "bind-dotdot-escape": lambda b: _bind(b, str(b.mnt / OLD_TAIL / "nvr" / ".." / ".." / ".." / "etc")),
    "bind-trailing-slash": lambda b: _bind(b, str(b.mnt / OLD_TAIL / "nvr") + "/"),
    "volume-source-not-a-volume-path": lambda b: _volume(b, VOL_NAME, "/etc"),
    "volume-name-mismatch": lambda b: _volume(
        b, "other_vol", str(b.vol_root / VOL_NAME / "_data")),
    "volume-dotdot": lambda b: _volume(
        b, VOL_NAME, str(b.vol_root / ".." / "volumes" / VOL_NAME / "_data")),
    "volume-name-with-space": lambda b: _volume(
        b, "bad name", str(b.vol_root / "bad name" / "_data")),
    "volume-name-with-semicolon": lambda b: _volume(
        b, "x;id", str(b.vol_root / "x;id" / "_data")),
    "no-recordings-mount": lambda b: b.set_frigate_mount(None),
}


@posix_world
@pytest.mark.parametrize("case", sorted(BAD_SOURCES))
def test_unsafe_or_unrecognised_old_sources_are_refused(box, case):
    BAD_SOURCES[case](box)
    original_env = box.envfile.read_bytes()
    r = box.run()
    assert r.rc == 0, r.err
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "bad_source", st
    # Nothing was copied, stopped, started or recreated.
    assert box.calls("rsync") == []
    assert not any(c[1] in ("stop", "start", "compose") for c in box.calls("docker"))
    assert_env_untouched(box, original_env)


@posix_world
def test_old_location_missing_on_disk_is_refused(box):
    shutil.rmtree(box.vol_root / VOL_NAME)
    r = box.run()
    assert r.state["errorCode"] == "bad_source"
    assert box.calls("rsync") == []


@posix_world
def test_two_running_frigate_containers_are_ambiguous(box):
    st = box.docker_state()
    twin = json.loads(json.dumps(st["containers"][OLD_CID]))
    twin["Id"] = "b" * 64
    st["containers"][twin["Id"]] = twin
    box.save_docker(st)
    r = box.run()
    assert r.state["errorCode"] == "bad_source"
    assert box.calls("rsync") == []


@posix_world
def test_a_stopped_leftover_next_to_one_running_container_is_ignored(box):
    """Compose recreate can leave a stopped renamed container behind; the single
    RUNNING one is ground truth."""
    st = box.docker_state()
    leftover = json.loads(json.dumps(st["containers"][OLD_CID]))
    leftover["Id"] = "c" * 64
    leftover["State"]["Running"] = False
    leftover["Mounts"][-1] = {"Type": "bind", "Source": "/etc", "Destination": "/media/frigate", "RW": True}
    st["containers"][leftover["Id"]] = leftover
    box.save_docker(st)
    r = box.run()
    assert r.rc == 0, r.err
    assert r.state["state"] == "done"
    assert ["docker", "stop", "-t", "60", OLD_CID_SHORT] in box.calls("docker")


# ==========================================================================
# migrate: preflight
# ==========================================================================

def _space_case(box, du_bytes, statfs):
    box.set_du(box.old_vol, du_bytes)
    box.set_statfs(*statfs)


@posix_world
def test_insufficient_space_is_refused_with_numbers_before_anything_moves(box):
    """A root rsync BYPASSES the project quota, so this check is the only thing
    preventing the copy from overshooting the reservation."""
    _space_case(box, 1000, (1, 1000, 1000, 1000))     # need 1100, have 1000
    original_env = box.envfile.read_bytes()
    r = box.run()
    assert r.rc == 0, r.err
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "insufficient_space"
    assert st["phase"] == "preflight"
    assert st["bytesTotal"] == 1000 and st["bytesCopied"] == 0 and st["progressPct"] == 0
    assert "1100" in st["error"] and "1000" in st["error"], st["error"]
    assert str(box.tmp) not in st["error"], "error text must not leak paths"
    assert box.calls("rsync") == []
    assert not any(c[1] in ("stop", "start", "compose") for c in box.calls("docker"))
    assert_env_untouched(box, original_env)


@posix_world
@pytest.mark.parametrize("du_bytes,statfs,ok", [
    (1000, (1, 1100, 1100, 1100), True),     # exactly 1.1 x
    (1000, (1, 1099, 1099, 1099), False),    # one byte short
    (1001, (1, 1102, 1102, 1102), True),     # ceil(1.1 x 1001) = 1102
    (1001, (1, 1101, 1101, 1101), False),
    (0, (1, 10, 10, 10), True),              # an empty old volume still migrates
    (1000, (4, 275, 275, 275), True),        # frsize multiplies: 4 x 275 = 1100
    (1000, (4, 274, 274, 274), False),
    # A re-run after a partial/complete copy: bytes already in NEW are credited
    # (capped at the old size), otherwise a retry could never pass a tight quota.
    (1000, (1, 2000, 1000, 1000), True),     # used 1000 credited: 100 more needed
    (1000, (1, 5000, 50, 50), False),        # credit is CAPPED at bytesTotal
    (1000, (1, 5000, 100, 100), True),
    # bavail (what a non-privileged writer may use) governs, not bfree.
    (1000, (1, 5000, 4000, 50), False),
])
def test_space_boundaries(box, du_bytes, statfs, ok):
    _space_case(box, du_bytes, statfs)
    r = box.run()
    assert r.rc == 0, r.err
    if ok:
        assert r.state["state"] == "done", r.state
    else:
        assert r.state["errorCode"] == "insufficient_space", r.state
        assert box.calls("rsync") == []


@posix_world
def test_unreadable_statfs_is_an_internal_error_and_nothing_moves(box):
    hook = box.bin / "statfs-hook"
    hook.write_text("#!/bin/sh\necho garbage\n", encoding="utf-8")
    r = box.run()
    assert r.rc == 1, "an unclassified failure leaves a failed unit so ops see it"
    assert r.state["errorCode"] == "internal"
    assert box.calls("rsync") == []
    assert not any(c[1] in ("stop", "start", "compose") for c in box.calls("docker"))


@posix_world
def test_du_failure_after_partial_output_still_uses_the_total(box):
    """`du` exits 1 when a file vanishes during a scan of the LIVE tree but
    still prints the total."""
    r = box.run(env={"FAKE_DU_FAIL": "1"})
    assert r.rc == 0, r.err
    assert r.state["state"] == "done"


@posix_world
def test_rsync_missing_is_refused_before_anything_moves(box):
    original_env = box.envfile.read_bytes()
    control = box.run(path=box.restricted_path())        # the restricted PATH itself works
    assert control.rc == 0 and control.state["state"] == "done", control.err
    # fresh world for the real assertion
    box2 = Box(box.tmp / "w2")
    r = box2.run(path=box2.restricted_path(exclude=("rsync",)))
    assert r.rc == 0, r.err
    assert r.state["state"] == "failed" and r.state["errorCode"] == "rsync_missing"
    assert not any(c[1] in ("stop", "start", "compose") for c in box2.calls("docker"))


@posix_world
def test_docker_missing_is_refused(box):
    original_env = box.envfile.read_bytes()
    r = box.run(path=box.restricted_path(exclude=("docker",)))
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "docker_unavailable"
    assert box.calls("rsync") == []
    assert_env_untouched(box, original_env)


@posix_world
def test_docker_daemon_down_is_refused(box):
    original_env = box.envfile.read_bytes()
    r = box.run(env={"FAKE_DOCKER_DOWN": "1"})
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "docker_unavailable"
    assert box.calls("rsync") == []
    assert_env_untouched(box, original_env)


# ==========================================================================
# migrate: copy / stop / delta / verify / flip failures and ROLLBACK
# ==========================================================================

@posix_world
def test_live_copy_failure_never_touches_frigate_or_env(box):
    original_env = box.envfile.read_bytes()
    r = box.run(rsync={"passes": [{"rc": 23, "stderr": "rsync error: some files/attrs were not transferred"}]})
    assert r.rc == 0, r.err
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "copy_failed" and st["phase"] == "copy"
    assert st["oldSource"] is None, "a failed move has no 'old' source: OLD is still live"
    assert "23" in st["error"]
    assert not any(c[1] in ("stop", "start", "compose") for c in box.calls("docker"))
    assert_env_untouched(box, original_env)
    assert box.frigate_containers()[0]["State"]["Running"] is True


@posix_world
def test_vanished_source_files_during_the_live_copy_are_not_an_error(box):
    """rsync exits 24 when frigate expires a segment mid-scan; that is normal
    on a live tree and the delta pass + verify settle it."""
    r = box.run(rsync={"passes": [{"rc": 24}, {}]})
    assert r.rc == 0, r.err
    assert r.state["state"] == "done"


@posix_world
def test_delta_failure_rolls_back_start_old_container_and_restore_env(box):
    original_env = box.envfile.read_bytes()
    r = box.run(rsync={"passes": [{}, {"rc": 23}]})
    assert r.rc == 0, r.err
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "copy_failed" and st["phase"] == "delta"
    docker = box.calls("docker")
    stop_i = docker.index(["docker", "stop", "-t", "60", OLD_CID_SHORT])
    start_i = docker.index(["docker", "start", OLD_CID_SHORT])
    assert start_i > stop_i, "the old container is started again after the failed stop"
    assert not any(c[1] == "compose" for c in docker), "frigate must not be recreated"
    # .env is back to the OLD value (the compose volume name), neighbours intact.
    body = box.envfile.read_text(encoding="utf-8")
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in body and str(box.new) not in body
    assert "JWT_SECRET=keepme-not-a-secret\n" in body and "OTHER_KEY=also-kept\n" in body
    assert body.count("NVR_MEDIA_SOURCE=") == 1
    # The original container runs again, on the old volume.
    c = box.frigate_containers()[0]
    assert c["Id"] == OLD_CID and c["State"]["Running"] is True
    assert box.mount_of(c)["Name"] == VOL_NAME
    assert st["oldSource"] is None


@posix_world
def test_stop_failure_still_attempts_the_rollback(box):
    r = box.run(docker_fail={"stop": "*"})
    assert r.rc == 0, r.err
    assert r.state["state"] == "failed" and r.state["errorCode"] == "docker_unavailable"
    assert r.state["phase"] == "stop"
    assert ["docker", "start", OLD_CID_SHORT] in box.calls("docker")
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in box.envfile.read_text(encoding="utf-8")


@posix_world
def test_verify_failure_rolls_back_and_never_flips(box):
    r = box.run(rsync={"verify_out": ">f+++++++++ recordings/2026-10-03/cam1/seg9.mp4\n"})
    assert r.rc == 0, r.err
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "verify_failed" and st["phase"] == "verify"
    assert "seg9" not in st["error"] and "cam1" not in st["error"], "no footage paths in the error"
    docker = box.calls("docker")
    assert ["docker", "start", OLD_CID_SHORT] in docker
    assert not any(c[1] == "compose" for c in docker)
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in box.envfile.read_text(encoding="utf-8")


@posix_world
def test_verify_ignores_only_the_destination_root_directory_line(box):
    """rsync -a also syncs the destination ROOT dir's attributes; the job
    re-tightens nvr/ to 0700, so the dry-run always shows `./` — benign."""
    r = box.run(rsync={"verify_out": ".d...p..... ./\n"})
    assert r.rc == 0, r.err
    assert r.state["state"] == "done"
    # ...but any other directory line is a real difference.
    box2 = Box(box.tmp / "w2")
    r2 = box2.run(rsync={"verify_out": ".d...p..... ./\n.d..t...... recordings/\n"})
    assert r2.state["errorCode"] == "verify_failed"


@posix_world
def test_verify_command_failure_is_verify_failed(box):
    r = box.run(rsync={"verify_rc": 23})
    assert r.state["errorCode"] == "verify_failed"
    assert ["docker", "start", OLD_CID_SHORT] in box.calls("docker")


@posix_world
def test_flip_failure_recreates_frigate_on_the_old_location(box):
    r = box.run(compose_plan=[{"fail": True}, {}])
    assert r.rc == 0, r.err
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "flip_failed" and st["phase"] == "flip"
    composes = [c for c in box.calls("docker") if c[1] == "compose"]
    assert len(composes) == 2, "recreate failed, then recreate again with the OLD .env"
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in box.envfile.read_text(encoding="utf-8")
    c = box.frigate_containers()
    assert len(c) == 1 and c[0]["State"]["Running"] is True
    assert box.mount_of(c[0])["Name"] == VOL_NAME, "frigate is back on the old volume"
    assert ["docker", "start", OLD_CID_SHORT] not in box.calls("docker")


@posix_world
def test_flip_failure_last_resort_starts_the_original_container(box):
    r = box.run(docker_fail={"compose": "*"})
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "flip_failed"
    docker = box.calls("docker")
    assert [c for c in docker if c[1] == "compose"] and ["docker", "start", OLD_CID_SHORT] in docker
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in box.envfile.read_text(encoding="utf-8")
    assert box.frigate_containers()[0]["State"]["Running"] is True


@posix_world
def test_rollback_that_cannot_restart_frigate_leaves_a_failed_unit(box):
    r = box.run(compose_plan=[{"remove_then_fail": True}, {"remove_then_fail": True}])
    assert r.rc == 1, "frigate could not be brought back: the unit must be visibly failed"
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "flip_failed"
    assert "manually" in st["error"] or "could not" in st["error"], st["error"]


@posix_world
def test_new_container_that_is_not_running_triggers_rollback(box):
    r = box.run(compose_plan=[{"running": False}, {}])
    assert r.rc == 0, r.err
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "flip_failed" and st["phase"] == "start"
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in box.envfile.read_text(encoding="utf-8")
    c = box.frigate_containers()
    assert len(c) == 1 and c[0]["State"]["Running"] is True
    assert box.mount_of(c[0])["Name"] == VOL_NAME


@posix_world
def test_new_container_on_the_wrong_mount_triggers_rollback(box):
    r = box.run(compose_plan=[{"bind_override": "/mnt/droplet/elsewhere-00000000/nvr"}, {}])
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "flip_failed" and r.state["phase"] == "start"
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in box.envfile.read_text(encoding="utf-8")


@posix_world
def test_rollback_without_a_container_restores_env_only(box):
    st = box.docker_state()
    st["containers"] = {}
    box.save_docker(st)
    r = box.run(rsync={"passes": [{}, {"rc": 23}]})
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "copy_failed"
    docker = box.calls("docker")
    assert not any(c[1] in ("stop", "start", "compose") for c in docker)
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in box.envfile.read_text(encoding="utf-8")


@posix_world
def test_rollback_restores_a_bay_old_source_value(box):
    old_nvr = box.make_old_bay()
    r = box.run(rsync={"passes": [{}, {"rc": 23}]})
    assert r.rc == 0, r.err
    assert f"NVR_MEDIA_SOURCE={old_nvr}\n" in box.envfile.read_text(encoding="utf-8")
    assert ["docker", "start", OLD_CID_SHORT] in box.calls("docker")


@needs_root
@posix_world
def test_rollback_keeps_env_owner_and_mode(box):
    """The job runs as root but the repo .env belongs to the repo user and the
    compose stack reads it as that user: _upsert_env_kv alone would turn it
    into root:root 0600."""
    os.chown(box.envfile, 1234, 1235)
    os.chmod(box.envfile, 0o640)
    r = box.run(rsync={"passes": [{}, {"rc": 23}]})
    assert r.rc == 0, r.err
    st = os.stat(box.envfile)
    assert (st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode)) == (1234, 1235, 0o640)
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in box.envfile.read_text(encoding="utf-8")


@posix_world
def test_rollback_writes_through_an_env_symlink(box, tmp_path):
    real = tmp_path / "data" / "secrets.env"
    real.parent.mkdir()
    real.write_text(box.envfile.read_text(encoding="utf-8"), encoding="utf-8")
    box.envfile.unlink()
    box.envfile.symlink_to(real)
    r = box.run(rsync={"passes": [{}, {"rc": 23}]})
    assert r.rc == 0, r.err
    assert box.envfile.is_symlink(), "the .env symlink was replaced by a plain file"
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in real.read_text(encoding="utf-8")


# ==========================================================================
# migrate: progress reporting
# ==========================================================================

@posix_world
def test_progress_is_refreshed_in_the_state_file_while_rsync_runs(box):
    r = box.run(rsync={"capture": True, "passes": [{"progress": [1000, 25_000, 100_000]}, {}]})
    assert r.rc == 0, r.err
    caps = box.captures()
    assert [c["want"] for c in caps] == [1000, 25_000, 100_000]
    for c in caps:
        st = c["state"]
        assert st["state"] == "running" and st["phase"] == "copy", st
        assert st["bytesCopied"] == c["want"]
        assert st["bytesTotal"] == OLD_BYTES
        assert st["progressPct"] == min(99, c["want"] * 100 // OLD_BYTES)
        assert st["finishedAt"] is None and st["errorCode"] is None
    assert [c["state"]["progressPct"] for c in caps] == [0, 20, 81]


@posix_world
def test_progress_is_clamped_below_100_until_verified(box):
    r = box.run(rsync={"capture": True, "passes": [{"progress": [OLD_BYTES, 10 * OLD_BYTES]}, {}]})
    assert r.rc == 0, r.err
    pcts = [c["state"]["progressPct"] for c in box.captures()]
    assert pcts == [99, 99]
    assert r.state["progressPct"] == 100


@posix_world
def test_progress_parses_the_other_locale_thousands_separator(box):
    r = box.run(rsync={"capture": True, "passes": [{"progress": [1_234_567], "sep": "."}, {}]})
    assert r.rc == 0, r.err
    assert box.captures()[0]["state"]["bytesCopied"] == 1_234_567


@posix_world
def test_state_is_rewritten_during_a_silent_copy(box):
    """rsync can be silent for minutes while it builds a huge file list; the
    state file must still be refreshed (liveness) at least every interval."""
    r = box.run(rsync={"capture": True, "heartbeat_probe": True,
                       "passes": [{"progress": [1000]}, {}]},
                env={"DROPLET_NVR_MIGRATE_PROGRESS_SECS": "1"})
    assert r.rc == 0, r.err
    assert {"hb_changed": True} in box.captures()


@posix_world
def test_delta_pass_progress_is_reported_in_phase_delta(box):
    r = box.run(rsync={"capture": True, "passes": [{}, {"progress": [500]}]})
    assert r.rc == 0, r.err
    st = box.captures()[0]["state"]
    assert st["phase"] == "delta" and st["state"] == "running"


# ==========================================================================
# migrate: interruption (systemd stops the unit: SIGTERM to the whole cgroup)
# ==========================================================================

def _terminate_group(proc):
    import signal
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        out, err = proc.communicate(timeout=60)
    except subprocess.TimeoutExpired:           # pragma: no cover - failure path
        os.killpg(proc.pid, signal.SIGKILL)
        raise
    return out, err


@posix_world
def test_sigterm_during_the_live_copy_marks_interrupted_without_touching_frigate(box):
    original_env = box.envfile.read_bytes()
    proc = box.start(rsync={"passes": [{"progress": [1000], "hang": 60}]})
    box.wait_for_phase("copy")
    _terminate_group(proc)
    st = box.state()
    assert st["state"] == "failed" and st["errorCode"] == "interrupted"
    assert not any(c[1] in ("stop", "start", "compose") for c in box.calls("docker"))
    assert_env_untouched(box, original_env)


@posix_world
def test_sigterm_after_the_stop_restarts_frigate_and_restores_env(box):
    proc = box.start(rsync={"passes": [{}, {"progress": [1000], "hang": 60}]})
    box.wait_for_phase("delta")
    _terminate_group(proc)
    st = box.state()
    assert st["state"] == "failed" and st["errorCode"] == "interrupted"
    assert ["docker", "start", OLD_CID_SHORT] in box.calls("docker")
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in box.envfile.read_text(encoding="utf-8")
    assert box.frigate_containers()[0]["State"]["Running"] is True


# ==========================================================================
# the request is UNTRUSTED (spool dir is droplet-writable)
# ==========================================================================

@posix_world
def test_missing_request_is_executor_breakage_and_leaves_the_state_alone(box):
    prior = {"request_id": "old", "job": "migrate", "state": "done", "phase": None,
             "progressPct": 100, "bytesCopied": 1, "bytesTotal": 1,
             "startedAt": "2026-10-03T00:00:00Z", "finishedAt": "2026-10-03T00:01:00Z",
             "error": None, "errorCode": None, "oldSource": None}
    box.write_json("spool/migrate-state.json", prior)
    r = box.run(write_request=False)
    assert r.rc == 2
    assert box.read_json(box.spool / "migrate-state.json") == prior, "a stray start must not clobber a finished job's state"
    assert_nothing_executed(box)


@posix_world
def test_malformed_request_is_refused_and_left_for_inspection(box):
    r = box.run(raw="{not json")
    assert r.rc == 2
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "internal" and st["request_id"] == "unknown"
    assert (box.spool / "migrate-request.json").exists()
    assert_nothing_executed(box)


HOSTILE_REQUESTS = {
    "fsuuid-shell": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": "x; touch PWNED"}},
    "fsuuid-subshell": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": "$(touch PWNED)"}},
    "fsuuid-backtick": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": "`touch PWNED`"}},
    "fsuuid-traversal": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": "../../etc/passwd"}},
    "fsuuid-newline": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": FS_UUID + "\ntouch PWNED"}},
    "fsuuid-option": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": "-o"}},
    "fsuuid-too-short": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": "abc"}},
    "fsuuid-too-long": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": "a" * 100}},
    "fsuuid-leading-dash": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": "-" + "a" * 10}},
    "fsuuid-int": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": 1234567890}},
    "fsuuid-list": {"request_id": "r1", "operation": "migrate", "params": {"fsUuid": [FS_UUID]}},
    "fsuuid-missing": {"request_id": "r1", "operation": "migrate", "params": {}},
    "params-missing": {"request_id": "r1", "operation": "migrate"},
    "params-not-a-dict": {"request_id": "r1", "operation": "migrate", "params": [FS_UUID]},
    "operation-unknown": {"request_id": "r1", "operation": "wipe", "params": {"fsUuid": FS_UUID}},
    "operation-injection": {"request_id": "r1", "operation": "migrate; touch PWNED", "params": {"fsUuid": FS_UUID}},
    "operation-list": {"request_id": "r1", "operation": ["migrate"], "params": {"fsUuid": FS_UUID}},
    "operation-missing": {"request_id": "r1", "params": {"fsUuid": FS_UUID}},
    "request-id-space": {"request_id": "bad id", "operation": "migrate", "params": {"fsUuid": FS_UUID}},
    "request-id-newline": {"request_id": "r1\ntouch PWNED", "operation": "migrate", "params": {"fsUuid": FS_UUID}},
    "request-id-quote": {"request_id": 'r"1', "operation": "migrate", "params": {"fsUuid": FS_UUID}},
    "request-id-long": {"request_id": "r" * 100, "operation": "migrate", "params": {"fsUuid": FS_UUID}},
    "request-id-int": {"request_id": 5, "operation": "migrate", "params": {"fsUuid": FS_UUID}},
    "request-id-missing": {"operation": "migrate", "params": {"fsUuid": FS_UUID}},
    "not-an-object": ["migrate"],
    "null": None,
}


@posix_world
@pytest.mark.parametrize("case", sorted(HOSTILE_REQUESTS))
def test_hostile_request_values_are_rejected_and_nothing_is_touched(box, case):
    original_env = box.envfile.read_bytes()
    original_record = (box.rootstate / "migration.json").read_bytes()
    r = box.run(raw=json.dumps(HOSTILE_REQUESTS[case]))
    assert r.rc == 2, (r.rc, r.err)
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "internal"
    assert st["request_id"] == "unknown", "a rejected request id is never echoed"
    assert_nothing_executed(box)
    assert_env_untouched(box, original_env)
    assert (box.rootstate / "migration.json").read_bytes() == original_record
    assert not (box.tmp / "PWNED").exists(), "injection executed"
    assert box.old_vol.exists() and (box.new).exists()


@posix_world
def test_request_that_is_a_symlink_is_refused_and_its_target_never_read(box, tmp_path):
    secret = tmp_path / "root-only.txt"
    secret.write_text('{"request_id":"LEAK-ME","operation":"migrate","params":{"fsUuid":"%s"}}' % FS_UUID,
                      encoding="utf-8")
    (box.spool / "migrate-request.json").symlink_to(secret)
    r = box.run(write_request=False)
    assert r.rc == 2
    st = r.state
    assert st["state"] == "failed" and "LEAK-ME" not in json.dumps(st)
    assert_nothing_executed(box)


@posix_world
def test_oversized_request_is_refused(box):
    big = json.dumps({"request_id": "r1", "operation": "migrate",
                      "params": {"fsUuid": FS_UUID}, "pad": "x" * 70_000})
    r = box.run(raw=big)
    assert r.rc == 2
    assert_nothing_executed(box)


@posix_world
def test_request_that_is_a_fifo_cannot_hang_the_job(box):
    os.mkfifo(box.spool / "migrate-request.json")
    r = box.run(write_request=False, timeout=30)
    assert r.rc == 2
    assert_nothing_executed(box)


@posix_world
def test_extra_request_params_cannot_redirect_the_job(box, tmp_path):
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "x").write_text("keep", encoding="utf-8")
    r = box.run(params={"fsUuid": FS_UUID, "oldSource": str(victim), "source": str(victim),
                        "path": "/", "kind": "path", "target": str(victim)})
    assert r.rc == 0, r.err
    assert r.state["oldSource"]["source"] == VOL_NAME
    assert all(str(victim) not in " ".join(c) for c in box.calls())
    assert (victim / "x").read_text() == "keep"


# ==========================================================================
# state-file write hardening (root writing into a droplet-owned directory)
# ==========================================================================

@posix_world
def test_preplanted_tmp_symlink_is_not_followed(box, tmp_path):
    victim = tmp_path / "victim.txt"
    victim.write_text("precious", encoding="utf-8")
    (box.spool / "migrate-state.json.tmp").symlink_to(victim)
    r = box.run()
    assert r.rc == 0, r.err
    assert victim.read_text() == "precious", "root followed a planted symlink"
    assert not (box.spool / "migrate-state.json").is_symlink()
    assert r.state["state"] == "done"


@posix_world
def test_preplanted_final_symlink_is_replaced_not_followed(box, tmp_path):
    victim = tmp_path / "victim.txt"
    victim.write_text("precious", encoding="utf-8")
    (box.spool / "migrate-state.json").symlink_to(victim)
    r = box.run()
    assert r.rc == 0, r.err
    assert victim.read_text() == "precious"
    assert not (box.spool / "migrate-state.json").is_symlink()
    assert r.state["state"] == "done"


@posix_world
def test_spool_dir_replaced_by_a_symlink_is_refused(box, tmp_path):
    real = tmp_path / "elsewhere"
    box.spool.rename(real)
    box.spool.symlink_to(real)
    (real / "migrate-request.json").write_text(
        json.dumps({"request_id": "r1", "operation": "migrate", "params": {"fsUuid": FS_UUID}}),
        encoding="utf-8")
    r = box.run(write_request=False)
    assert r.rc == 2
    assert not (real / "migrate-state.json").exists()
    assert_nothing_executed(box)


@needs_root
@posix_world
def test_state_file_is_owned_like_the_spool_dir_so_the_bridge_can_read_it(box):
    os.chown(box.spool, 1234, 1235)
    r = box.run()
    assert r.rc == 0, r.err
    st = os.stat(box.spool / "migrate-state.json")
    assert (st.st_uid, st.st_gid) == (1234, 1235)
    assert stat.S_IMODE(st.st_mode) == 0o600


@posix_world
def test_second_instance_refuses_while_one_is_running(box):
    import fcntl
    box.rootstate.mkdir(exist_ok=True)
    fd = os.open(box.rootstate / "migrate.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        r = box.run()
        assert r.rc == 3
        assert (box.spool / "migrate-request.json").exists(), "the running job's request is not consumed"
        assert box.state() is None, "a refused second instance must not write state"
        assert_nothing_executed(box)
    finally:
        os.close(fd)


# ==========================================================================
# delete_old
# ==========================================================================

@posix_world
def test_delete_old_volume_happy_path(box):
    box.after_migration("volume")
    original_env = box.envfile.read_bytes()
    r = box.run("delete_old")
    assert r.rc == 0, r.err
    docker = box.calls("docker")
    assert docker[0] == PS_ARGV and docker[1][:2] == ["docker", "inspect"]
    assert ["docker", "volume", "rm", VOL_NAME] in docker
    assert docker.index(["docker", "volume", "rm", VOL_NAME]) > 1
    assert box.calls("rsync") == []
    st = r.state
    assert st["job"] == "delete_old" and st["state"] == "done" and st["progressPct"] == 100
    assert st["phase"] is None and st["oldSource"] == {
        "kind": "volume", "source": VOL_NAME, "bytes": OLD_BYTES, "deleted": True}
    assert box.record()["oldSource"]["deleted"] is True
    assert VOL_NAME not in box.docker_state()["volumes"]
    assert_env_untouched(box, original_env)
    assert (box.new).exists(), "the current source is never touched"


@posix_world
def test_delete_old_phase_is_cleanup_while_running(box):
    box.after_migration("volume")
    r = box.run("delete_old")
    assert r.rc == 0, r.err
    phases = {tuple(argv): ph for argv, ph in box.calls_with_phase("docker")}
    assert phases[("docker", "volume", "rm", VOL_NAME)] == "cleanup"


@posix_world
def test_delete_old_path_removes_contents_only(box):
    old_nvr = box.after_migration("path")
    (old_nvr / "recordings" / "cam1" / "nested").mkdir()
    (old_nvr / "recordings" / "cam1" / "nested" / "deep.mp4").write_bytes(b"z")
    (old_nvr / ".hidden-dir").mkdir()
    (old_nvr / ".hidden-dir" / "f").write_bytes(b"z")
    (new_marker := box.new / "live-footage.mp4").write_bytes(b"live")
    r = box.run("delete_old")
    assert r.rc == 0, r.err
    assert old_nvr.is_dir() and list(old_nvr.iterdir()) == [], "contents gone, the nvr dir itself (quota root) stays"
    assert (old_nvr.parent / "files" / "canary.txt").read_text() == "not-recordings", "siblings untouched"
    assert new_marker.read_bytes() == b"live", "the live source is never touched"
    st = r.state
    assert st["state"] == "done" and st["oldSource"]["deleted"] is True
    assert st["oldSource"]["kind"] == "path"
    assert not any(c[1:3] == ["volume", "rm"] for c in box.calls("docker"))
    assert box.record()["oldSource"]["deleted"] is True


@posix_world
def test_delete_old_params_in_the_request_cannot_redirect_it(box, tmp_path):
    box.after_migration("volume")
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "x").write_text("keep", encoding="utf-8")
    r = box.run("delete_old", params={"path": str(victim), "source": str(victim), "name": "other",
                                      "kind": "path", "fsUuid": FS_UUID})
    assert r.rc == 0, r.err
    assert (victim / "x").read_text() == "keep"
    assert ["docker", "volume", "rm", VOL_NAME] in box.calls("docker")
    assert not any(c[1:3] == ["volume", "rm"] and c[3] != VOL_NAME for c in box.calls("docker"))


@posix_world
def test_delete_old_refuses_without_a_record(box):
    (box.rootstate / "migration.json").unlink()
    r = box.run("delete_old")
    assert r.rc == 0, r.err
    assert r.state["state"] == "failed" and r.state["errorCode"] == "no_old_footage"
    assert not any(c[1:3] == ["volume", "rm"] for c in box.calls("docker"))


@posix_world
@pytest.mark.parametrize("mutate", [
    lambda rec: rec.pop("oldSource"),
    lambda rec: rec.pop("migratedAt"),
    lambda rec: rec["oldSource"].update(deleted=True),
    lambda rec: rec.update(oldSource=None),
    lambda rec: rec.update(oldSource="volume"),
], ids=["no-oldSource", "migration-not-completed", "already-deleted", "null-oldSource", "wrong-type"])
def test_delete_old_refuses_unless_a_completed_migration_is_recorded(box, mutate):
    box.after_migration("volume")
    rec = box.record()
    mutate(rec)
    box.write_record(rec)
    r = box.run("delete_old")
    assert r.rc == 0, r.err
    assert r.state["state"] == "failed" and r.state["errorCode"] == "no_old_footage"
    assert not any(c[1:3] == ["volume", "rm"] for c in box.calls("docker"))


@posix_world
def test_delete_old_is_idempotent_second_run_has_nothing_to_delete(box):
    box.after_migration("volume")
    assert box.run("delete_old").state["state"] == "done"
    second = box.run("delete_old")
    assert second.state["errorCode"] == "no_old_footage"


@posix_world
def test_delete_old_refuses_when_the_old_source_is_the_current_env_source_path(box):
    old_nvr = box.after_migration("path")
    box.envfile.write_text(f"NVR_MEDIA_SOURCE={old_nvr}\n", encoding="utf-8")
    r = box.run("delete_old")
    assert r.rc == 0, r.err
    assert r.state["state"] == "failed" and r.state["errorCode"] == "delete_failed"
    assert (old_nvr / "recordings" / "cam1" / "seg1.mp4").exists(), "live recordings were deleted"


@posix_world
@pytest.mark.parametrize("current", ["nvrdata", VOL_NAME])
def test_delete_old_refuses_when_the_env_points_back_at_the_old_volume(box, current):
    box.after_migration("volume")
    box.envfile.write_text(f"NVR_MEDIA_SOURCE={current}\n", encoding="utf-8")
    r = box.run("delete_old")
    assert r.state["errorCode"] == "delete_failed"
    assert not any(c[1:3] == ["volume", "rm"] for c in box.calls("docker"))


@posix_world
def test_delete_old_with_unset_env_source_means_the_default_volume_and_is_refused(box):
    box.after_migration("volume")
    box.envfile.write_text("JWT_SECRET=x\n", encoding="utf-8")
    r = box.run("delete_old")
    assert r.state["errorCode"] == "delete_failed", "an unset key IS the nvrdata volume (compose default)"


@posix_world
def test_delete_old_refuses_when_the_running_container_still_uses_the_old_volume(box):
    """Ground truth beats the .env: a rolled-back migration leaves frigate on
    the old volume, and deleting it then would destroy live footage."""
    box.after_migration("volume")
    _volume(box, VOL_NAME, str(box.old_vol))
    r = box.run("delete_old")
    assert r.state["state"] == "failed" and r.state["errorCode"] == "delete_failed"
    assert not any(c[1:3] == ["volume", "rm"] for c in box.calls("docker"))
    assert box.old_vol.exists()


@posix_world
def test_delete_old_refuses_when_the_running_container_still_uses_the_old_path(box):
    old_nvr = box.after_migration("path")
    _bind(box, str(old_nvr))
    r = box.run("delete_old")
    assert r.state["errorCode"] == "delete_failed"
    assert (old_nvr / "recordings" / "cam1" / "seg1.mp4").exists()


@posix_world
def test_delete_old_path_kind_needs_docker_to_prove_it_is_unused(box):
    old_nvr = box.after_migration("path")
    r = box.run("delete_old", env={"FAKE_DOCKER_DOWN": "1"})
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "docker_unavailable"
    assert (old_nvr / "recordings" / "cam1" / "seg1.mp4").exists()


@posix_world
def test_delete_old_volume_already_gone_is_reported_deleted(box):
    box.after_migration("volume")
    st = box.docker_state()
    st["volumes"].clear()
    box.save_docker(st)
    r = box.run("delete_old")
    assert r.rc == 0, r.err
    assert r.state["state"] == "done" and r.state["oldSource"]["deleted"] is True
    assert not any(c[1:3] == ["volume", "rm"] for c in box.calls("docker"))


@posix_world
def test_delete_old_volume_rm_failure_is_delete_failed_and_stays_retryable(box):
    box.after_migration("volume")
    r = box.run("delete_old", docker_fail={"volume_rm": "*"})
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "delete_failed"
    assert box.record()["oldSource"]["deleted"] is False
    assert box.run("delete_old").state["state"] == "done", "a retry succeeds"


BAD_RECORDED_VOLUMES = ["../x", "a b", "-rf", "x;y", "", ".hidden", "a/b", "$(id)", "x\ny", "a" * 0]
BAD_RECORDED_PATHS = [
    "/etc", "/", "/mnt", "{mnt}", "{mnt}/x", "{mnt}/x/nvr/..", "{mnt}/x/nvr/../../etc",
    "{mnt}/x/nvr2", "{mnt}/a/b/nvr", "{mnt}/x y/nvr", "nvr", "relative/nvr", "{mnt}/x/nvr/",
    "{mnt}/-rf/nvr", "/data/nvr", "{mnt}/../etc/nvr",
]


@posix_world
@pytest.mark.parametrize("name", BAD_RECORDED_VOLUMES)
def test_delete_old_rejects_bad_recorded_volume_names(box, name):
    box.after_migration("volume")
    rec = box.record()
    rec["oldSource"]["source"] = name
    box.write_record(rec)
    r = box.run("delete_old")
    assert r.rc == 0, r.err
    assert r.state["state"] == "failed" and r.state["errorCode"] in ("delete_failed", "no_old_footage")
    assert not any(c[1:3] == ["volume", "rm"] for c in box.calls("docker")), box.calls("docker")


@posix_world
@pytest.mark.parametrize("raw_path", BAD_RECORDED_PATHS)
def test_delete_old_rejects_bad_recorded_paths_and_deletes_nothing(box, tmp_path, raw_path):
    box.after_migration("volume")
    canary = box.mnt / "x" / "nvr"
    canary.mkdir(parents=True, exist_ok=True)
    (canary / "canary.txt").write_text("keep", encoding="utf-8")
    keep = [canary / "canary.txt", box.new, box.old_vol]
    rec = box.record()
    rec["oldSource"] = {"kind": "path", "source": raw_path.replace("{mnt}", str(box.mnt)),
                        "bytes": 1, "deleted": False}
    box.write_record(rec)
    r = box.run("delete_old")
    assert r.rc == 0, r.err
    assert r.state["state"] == "failed" and r.state["errorCode"] in ("delete_failed", "no_old_footage")
    for k in keep:
        assert k.exists(), f"{k} was deleted"
    assert (box.mnt / "x" / "nvr" / "canary.txt").read_text() == "keep"


@posix_world
def test_delete_old_refuses_a_recorded_path_that_is_a_symlink(box, tmp_path):
    box.after_migration("volume")
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "x").write_text("keep", encoding="utf-8")
    link_mount = box.mnt / "link-0a0a0a0a"
    link_mount.mkdir()
    os.symlink(victim, link_mount / "nvr")
    rec = box.record()
    rec["oldSource"] = {"kind": "path", "source": str(link_mount / "nvr"), "bytes": 1, "deleted": False}
    box.write_record(rec)
    r = box.run("delete_old")
    assert r.state["errorCode"] == "delete_failed"
    assert (victim / "x").read_text() == "keep", "rm followed a symlink out of the bay"


@posix_world
def test_delete_old_refuses_the_new_target_even_if_the_record_says_so(box):
    box.after_migration("volume")
    rec = box.record()
    rec["oldSource"] = {"kind": "path", "source": str(box.new), "bytes": 1, "deleted": False}
    box.write_record(rec)
    (box.new / "live.mp4").write_bytes(b"live")
    r = box.run("delete_old")
    assert r.state["errorCode"] == "delete_failed"
    assert (box.new / "live.mp4").exists()


@posix_world
def test_delete_old_does_not_trust_a_group_or_world_writable_record(box):
    box.after_migration("volume")
    # Attack fixture: exercise rejection of a world-writable migration record.
    os.chmod(box.rootstate / "migration.json", 0o666)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions -- intentionally weak attack input for the guard test
    r = box.run("delete_old")
    assert r.state["state"] == "failed"
    assert not any(c[1:3] == ["volume", "rm"] for c in box.calls("docker"))


@posix_world
def test_delete_old_does_not_trust_a_record_that_is_a_symlink(box, tmp_path):
    box.after_migration("volume")
    real = tmp_path / "elsewhere.json"
    real.write_text((box.rootstate / "migration.json").read_text(), encoding="utf-8")
    (box.rootstate / "migration.json").unlink()
    (box.rootstate / "migration.json").symlink_to(real)
    r = box.run("delete_old")
    assert r.state["state"] == "failed"
    assert not any(c[1:3] == ["volume", "rm"] for c in box.calls("docker"))


@posix_world
def test_delete_old_corrupt_record_is_refused(box):
    (box.rootstate / "migration.json").write_text("{not json", encoding="utf-8")
    r = box.run("delete_old")
    assert r.rc == 0, r.err
    assert r.state["state"] == "failed" and r.state["errorCode"] in ("delete_failed", "no_old_footage")
    assert not any(c[1:3] == ["volume", "rm"] for c in box.calls("docker"))


@posix_world
def test_delete_old_without_docker_cli_is_docker_unavailable(box):
    box.after_migration("volume")
    r = box.run("delete_old", path=box.restricted_path(exclude=("docker",)))
    assert r.rc == 0, r.err
    assert r.state["errorCode"] == "docker_unavailable"


# ==========================================================================
# real rsync smoke tests (the shims above never copy a byte)
# ==========================================================================

def _populate_old_tree(root: Path):
    (root / "recordings" / "2026-10-03" / "cam 1").mkdir(parents=True)
    (root / "recordings" / "2026-10-03" / "cam 1" / "10.00.00.mp4").write_bytes(os.urandom(70_000))
    (root / "recordings" / "2026-10-03" / "cam 1" / "10.00.10.mp4").write_bytes(os.urandom(5_000))
    (root / "clips").mkdir()
    (root / "clips" / "event.mp4").write_bytes(os.urandom(2_000))
    (root / "clips" / "event.mp4").chmod(0o640)
    (root / ".hidden").write_text("dot", encoding="utf-8")
    (root / "empty-dir").mkdir()
    os.symlink("clips/event.mp4", root / "latest")
    os.link(root / "clips" / "event.mp4", root / "clips" / "event-hardlink.mp4")
    os.utime(root / "clips" / "event.mp4", (1_700_000_000, 1_700_000_000))
    root.chmod(0o755)


def _tree_manifest(root: Path):
    out = {}
    for p in sorted(root.rglob("*")):
        rel = str(p.relative_to(root))
        st = os.lstat(p)
        if p.is_symlink():
            out[rel] = ("link", os.readlink(p))
        elif p.is_dir():
            out[rel] = ("dir", stat.S_IMODE(st.st_mode))
        else:
            out[rel] = ("file", p.read_bytes(), stat.S_IMODE(st.st_mode), int(st.st_mtime), st.st_nlink)
    return out


@needs_real_rsync
@posix_world
def test_real_rsync_smoke_copy_is_path_preserving_complete_and_non_destructive(box):
    """REAL rsync: every file lands at the identical relative path with content,
    mode, mtime, symlinks and hard links intact (so Frigate's DB rows, which hold
    /media/frigate/... paths, stay valid); nothing in NEW is pruned (no --delete);
    OLD is untouched; nvr/ keeps its 0700; the dry-run verify passes."""
    _populate_old_tree(box.old_vol)
    box.set_du(box.old_vol, 77_000)
    box.set_du(box.new, 0)
    (box.new / "keep-me.txt").write_text("pre-existing, not in OLD", encoding="utf-8")
    before = _tree_manifest(box.old_vol)
    r = box.run(env={"FAKE_RSYNC_REAL": "1"})
    assert r.rc == 0, r.err
    assert r.state["state"] == "done", r.state
    after_old = _tree_manifest(box.old_vol)
    assert after_old == before, "OLD must be left exactly as it was"
    new = _tree_manifest(box.new)
    assert (box.new / "keep-me.txt").read_text() == "pre-existing, not in OLD", "the copy must never prune"
    new.pop("keep-me.txt")
    assert new.keys() == before.keys()
    for rel, meta in before.items():
        assert new[rel] == meta, rel
    ino = {os.stat(box.new / "clips" / n).st_ino for n in ("event.mp4", "event-hardlink.mp4")}
    assert len(ino) == 1, "hard links must be preserved (-H)"
    assert stat.S_IMODE(os.stat(box.new).st_mode) == 0o700, "rsync -a must not widen nvr/ to the old root's mode"
    assert os.stat(box.new).st_uid == os.stat(box.old_vol).st_uid or os.geteuid() != 0
    # The Frigate container was recreated on the new bay.
    assert box.mount_of(box.frigate_containers()[0])["Source"] == str(box.new)


@needs_real_rsync
@posix_world
def test_real_rsync_smoke_verify_catches_a_real_difference_and_rolls_back(box):
    """REAL rsync dry-run: after the (real) delta pass one file goes missing from
    NEW; the verify must report it and the job must roll back."""
    _populate_old_tree(box.old_vol)
    box.set_du(box.old_vol, 77_000)
    victim = box.new / "recordings" / "2026-10-03" / "cam 1" / "10.00.10.mp4"
    r = box.run(env={"FAKE_RSYNC_REAL": "1"},
                rsync={"real_post": {"2": {"rm": str(victim)}}})
    assert r.rc == 0, r.err
    st = r.state
    assert st["state"] == "failed" and st["errorCode"] == "verify_failed", st
    assert ["docker", "start", OLD_CID_SHORT] in box.calls("docker")
    assert "NVR_MEDIA_SOURCE=nvrdata\n" in box.envfile.read_text(encoding="utf-8")
    assert (box.old_vol / "recordings" / "2026-10-03" / "cam 1" / "10.00.10.mp4").exists()


@needs_real_rsync
@posix_world
def test_real_rsync_smoke_second_run_is_idempotent(box):
    _populate_old_tree(box.old_vol)
    box.set_du(box.old_vol, 77_000)
    assert box.run(env={"FAKE_RSYNC_REAL": "1"}).state["state"] == "done"
    n = len(box.calls())
    again = box.run(env={"FAKE_RSYNC_REAL": "1"}, request_id="again")
    assert again.state["state"] == "done"
    assert [c for c in box.calls()[n:] if c[0] == "rsync"] == []


# ==========================================================================
# mutation checks: prove each guard is load-bearing, not decorative
# ==========================================================================

def _mutant(box, needle, replacement, name="mutant.sh") -> Path:
    """Neutralise the guard a marker comment (`# NEEDLE ...`) introduces: the marker
    line, any comment lines that continue it, and the `if ... fi` statement right
    after them are replaced by `replacement` (a shell no-op such as `: # neutered`)."""
    src = SCRIPT.read_text(encoding="utf-8")
    assert needle in src, f"guard shape changed - update this mutation test: {needle!r}"
    lines = src.split("\n")
    idx = next(i for i, ln in enumerate(lines) if needle in ln and ln.lstrip().startswith("#"))
    j = idx + 1
    while lines[j].lstrip().startswith("#"):
        j += 1
    indent = lines[j][: len(lines[j]) - len(lines[j].lstrip())]
    assert lines[j].lstrip().startswith("if "), f"guard shape changed - no if-statement after {needle!r}"
    k = j
    while lines[k] != indent + "fi":
        k += 1
    lines[idx : k + 1] = [indent + replacement]
    path = box.tmp / name
    path.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    (box.tmp / "droplet-storage-topology-lock.sh").write_text(
        (REPO_ROOT / "scripts" / "host" / "droplet-storage-topology-lock.sh").read_text(
            encoding="utf-8"), encoding="utf-8", newline="\n")
    return path


def _run_mutant(box, path, **kw):
    env = box.env_for()
    box.write_request(kw.get("operation", "migrate"))
    return subprocess.run([BASH, str(path)], env=env, cwd=str(box.tmp), capture_output=True,
                          text=True, timeout=120)


@posix_world
def test_mutation_without_the_space_preflight_an_overshooting_copy_proceeds(box):
    _space_case(box, 1000, (1, 1000, 1000, 1000))
    assert box.run().state["errorCode"] == "insufficient_space"
    box2 = Box(box.tmp / "w2")
    _space_case(box2, 1000, (1, 1000, 1000, 1000))
    mutant = _mutant(box2, "SPACE_GUARD", ": # neutered")
    proc = _run_mutant(box2, mutant)
    assert box2.state()["errorCode"] != "insufficient_space", (
        "removing the guard changed nothing, so it never protected the quota")
    assert proc.returncode in (0, 1)


@posix_world
def test_mutation_without_the_prepared_target_guard_an_unprepared_target_is_accepted(box):
    (box.rootstate / "migration.json").unlink()
    assert box.run().state["errorCode"] == "target_not_applied"
    box2 = Box(box.tmp / "w2")
    (box2.rootstate / "migration.json").unlink()
    mutant = _mutant(box2, "TARGET_PREPARED_GUARD", ": # neutered")
    _run_mutant(box2, mutant)
    assert box2.state()["errorCode"] != "target_not_applied"


@posix_world
def test_mutation_without_the_rollback_a_failed_delta_leaves_frigate_stopped(box):
    r = box.run(rsync={"passes": [{}, {"rc": 23}]})
    assert ["docker", "start", OLD_CID_SHORT] in box.calls("docker")
    box2 = Box(box.tmp / "w2")
    mutant = _mutant(box2, "ROLLBACK_START", ": # neutered")
    env = box2.env_for(FAKE_RSYNC=json.dumps({"passes": [{}, {"rc": 23}]}))
    box2.write_request()
    subprocess.run([BASH, str(mutant)], env=env, cwd=str(box2.tmp), capture_output=True,
                   text=True, timeout=120)
    assert ["docker", "start", OLD_CID_SHORT] not in box2.calls("docker")
    assert box2.frigate_containers()[0]["State"]["Running"] is False


@posix_world
def test_mutation_without_the_current_source_guard_delete_old_removes_live_footage(box):
    old_nvr = box.after_migration("path")
    box.envfile.write_text(f"NVR_MEDIA_SOURCE={old_nvr}\n", encoding="utf-8")
    assert box.run("delete_old").state["errorCode"] == "delete_failed"
    box2 = Box(box.tmp / "w2")
    old2 = box2.after_migration("path")
    box2.envfile.write_text(f"NVR_MEDIA_SOURCE={old2}\n", encoding="utf-8")
    mutant = _mutant(box2, "CURRENT_SOURCE_GUARD", ": # neutered")
    _run_mutant(box2, mutant, operation="delete_old")
    assert box2.state()["errorCode"] != "delete_failed" or not (old2 / "recordings" / "cam1" / "seg1.mp4").exists()
