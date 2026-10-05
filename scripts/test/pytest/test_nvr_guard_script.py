"""Hermetic tests for the NVR boot guard (WARP-3514 section 3.3, ADR-070).

The scenario this exists for: after a reboot the recordings bay is mounted by
droplet-automount@, which is ordered After=docker.service -- so Docker, and
Frigate with `restart: always`, come up BEFORE the bay. Compose then bind-mounts
/mnt/droplet/<tail>/nvr, Docker silently creates the missing directory on the
ROOT filesystem and Frigate fills the OS disk. scripts/host/droplet-nvr-guard.sh
closes that window:

  arm      (boot, Before=docker.service) -- if the bay is not mounted yet,
           create an immutable EMPTY placeholder at the recordings path on the
           root filesystem: Frigate gets EPERM instead of silently filling `/`.
  release  (timer, every ~30 s)          -- once the bay has mounted over it,
           restart Frigate ONCE so it re-binds the real directory, and disarm.
  disarm   (factory-reset)               -- remove the placeholder.
  status   -- print the root-only state.

Two properties carry the weight and are asserted hard:

  * The repo .env is droplet-writable, so NVR_MEDIA_SOURCE is UNTRUSTED input
    to a ROOT script that mkdir's and `chattr +i`'s what it names. Only a value
    matching EXACTLY <base>/<tail>/nvr with no symlink component is ever acted
    on; anything else must leave the filesystem untouched.
  * It must never block boot and must be idempotent.

The host is simulated: PATH shims stand in for mountpoint / stat (-c %d) /
chattr / docker / systemctl, driven by a fake mount table, so "the bay mounts
late" is one line of test code on a single real tmp filesystem. Nothing needs
root, a block device or a real docker. The mutation tests at the bottom prove
each guard layer is load-bearing.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "host" / "droplet-nvr-guard.sh"
UNIT_DIR = REPO_ROOT / "services" / "oled-display"
ARM_UNIT = UNIT_DIR / "droplet-nvr-guard.service"
RELEASE_UNIT = UNIT_DIR / "droplet-nvr-guard-release.service"
RELEASE_TIMER = UNIT_DIR / "droplet-nvr-guard-release.timer"
COMPOSE = REPO_ROOT / "docker" / "docker-compose.yml"
BASH = shutil.which("bash")

# The behavioural tests drive POSIX path/mount semantics through bash; the
# static ones (script text, unit files) run everywhere bash exists.
behavioural = pytest.mark.skipif(
    BASH is None or os.name == "nt",
    reason="needs bash and POSIX path semantics (run in Linux)")
needs_bash = pytest.mark.skipif(BASH is None, reason="bash not available")

ROOT_DEV = "2049"     # what `stat -c %d /` reports in the simulation
BAY_DEV = "4242"      # the bay's own filesystem once "mounted"
TAIL = "bay-ab12cd34"
ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
CONTAINER_ID = "0123456789ab"
FRIGATE_PS = "ps -q --filter label=com.docker.compose.service=frigate"

# --------------------------------------------------------------------------
# PATH shims. Each logs its argv under $FAKE_DIR so tests can assert on calls.
# --------------------------------------------------------------------------

SHIMS = {
    # Succeeds iff the path is listed in the fake mount table.
    "mountpoint": """#!/usr/bin/env bash
path=""
for a in "$@"; do case "$a" in -*) ;; *) path="$a" ;; esac; done
[ -n "$path" ] || exit 1
awk -v p="$path" '$1 == p { f = 1 } END { exit (f ? 0 : 1) }' "$FAKE_DIR/mounts"
""",
    # Only `stat -c %d <path>` is faked: the device of the longest fake mount
    # that is a prefix of the path, else the root device. Everything else
    # (e.g. a future stat -c %u) goes to the real stat.
    "stat": """#!/usr/bin/env bash
if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%d" ]; then
  path="${!#}"
  best=""
  dev="$FAKE_ROOT_DEV"
  while read -r mp d; do
    [ -n "$mp" ] || continue
    case "$path" in
      "$mp"|"$mp"/*)
        if [ "${#mp}" -gt "${#best}" ]; then best="$mp"; dev="$d"; fi ;;
    esac
  done < "$FAKE_DIR/mounts"
  echo "$dev"
  exit 0
fi
exec "$FAKE_REAL_STAT" "$@"
""",
    "chattr": """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/chattr.log"
if [ "${FAKE_CHATTR_RC:-0}" != "0" ]; then
  echo "chattr: Inappropriate ioctl for device while reading flags on ${!#}" >&2
  exit "$FAKE_CHATTR_RC"
fi
exit 0
""",
    "docker": """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/docker.log"
case "${1:-}" in
  ps)
    if [ "${FAKE_DOCKER_PS_RC:-0}" != "0" ]; then
      echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2
      exit "$FAKE_DOCKER_PS_RC"
    fi
    [ -z "${FAKE_DOCKER_PS:-}" ] || printf '%b\\n' "$FAKE_DOCKER_PS"
    exit 0 ;;
  restart) exit "${FAKE_DOCKER_RESTART_RC:-0}" ;;
esac
exit 0
""",
    # Mimics `systemctl is-active`: prints the state; exit 0 only for `active`
    # (a running oneshot is `activating`, for which the real tool exits 3).
    "systemctl": """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/systemctl.log"
if [ "${1:-}" = "is-active" ]; then
  st="${FAKE_MIGRATE_STATE:-inactive}"
  echo "$st"
  [ "$st" = "active" ] && exit 0
  exit 3
fi
exit 0
""",
}


def _snapshot(root: Path, ignore: tuple[str, ...] = ()) -> dict[str, str]:
    """A comparable picture of a tree: what exists, and of what kind."""
    out: dict[str, str] = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        if any(rel == i or rel.startswith(i + "/") for i in ignore):
            continue
        if p.is_symlink():
            out[rel] = "link->" + os.readlink(p)
        elif p.is_dir():
            out[rel] = "dir"
        else:
            out[rel] = f"file:{p.stat().st_size}"
    return out


class Box:
    """One simulated host: mount base, root-only state dir, repo .env, shims."""

    def __init__(self, tmp_path: Path, script: Path | None = None):
        self.tmp = tmp_path
        self.script = script or SCRIPT
        self.base = tmp_path / "mnt" / "droplet"
        self.base.mkdir(parents=True)
        self.state_dir = tmp_path / "var-lib-droplet-nvr"   # created by the script
        self.repo = tmp_path / "repo"
        self.repo.mkdir()
        self.env_file = self.repo / ".env"
        self.fake = tmp_path / "fake"
        self.fake.mkdir()
        (self.fake / "mounts").write_text("")
        self.shims = tmp_path / "shims"
        self.shims.mkdir()
        for name, body in SHIMS.items():
            self.shim(name, body)
        # The script runs from here, so a bug that wrote a RELATIVE path would
        # land in this empty dir (and be caught) rather than wherever pytest ran.
        self.cwd = tmp_path / "cwd"
        self.cwd.mkdir()
        self.sentinel = tmp_path / "SENTINEL"
        self.bay_root = self.base / TAIL
        self.source = self.bay_root / "nvr"
        self.write_env(f"NVR_MEDIA_SOURCE={self.source}\n")

    # -- host description ------------------------------------------------
    def shim(self, name: str, body: str):
        path = self.shims / name
        path.write_text(body, encoding="utf-8", newline="\n")
        os.chmod(path, 0o700)

    def write_env(self, text: str):
        self.env_file.write_text(
            "POSTGRES_PASSWORD=keepme\n" + text + "JWT_SECRET=alsokeepme\n",
            encoding="utf-8", newline="")

    def fmt(self, value: str) -> str:
        return value.format(base=self.base, tail=TAIL, tmp=self.tmp,
                            sentinel=self.sentinel)

    def mount(self, path: Path, dev: str = BAY_DEV):
        with open(self.fake / "mounts", "a", encoding="utf-8") as fh:
            fh.write(f"{path} {dev}\n")

    def mount_bay(self, nvr: str = "dir"):
        """The bay mounts at <base>/<tail>. `nvr` is what the bay's OWN
        filesystem holds at ./nvr: a directory, nothing, a plain file or a
        symlink."""
        self.bay_root.mkdir(parents=True, exist_ok=True)
        if self.source.is_symlink() or self.source.is_file():
            self.source.unlink()
        elif self.source.is_dir() and nvr != "dir":
            shutil.rmtree(self.source)
        if nvr == "dir":
            self.source.mkdir(exist_ok=True)
        elif nvr == "file":
            self.source.write_text("not a directory")
        elif nvr == "symlink":
            target = self.tmp / "elsewhere"
            target.mkdir(exist_ok=True)
            os.symlink(target, self.source)
        self.mount(self.bay_root, BAY_DEV)

    # -- state -----------------------------------------------------------
    @property
    def state_file(self) -> Path:
        return self.state_dir / "guard.json"

    def state(self):
        if not self.state_file.exists():
            return None
        return json.loads(self.state_file.read_text(encoding="utf-8"))

    def write_state(self, armed: bool, source, since="2026-01-01T00:00:00Z",
                    raw: str | None = None, **extra):
        self.state_dir.mkdir(mode=0o700, exist_ok=True)
        if raw is not None:
            self.state_file.write_text(raw, encoding="utf-8")
            return
        body = {"armed": armed, "source": str(source),
                "bayRoot": str(source).removesuffix("/nvr"), "since": since}
        body.update(extra)
        # json.dumps' default separators on purpose: the reader must not
        # depend on the guard's own compact formatting.
        self.state_file.write_text(json.dumps(body), encoding="utf-8")

    # -- running ---------------------------------------------------------
    def env(self, **extra) -> dict:
        env = dict(os.environ)
        env.update({
            "PATH": str(self.shims) + os.pathsep + os.environ.get("PATH", ""),
            "DROPLET_NVR_MOUNT_BASE": str(self.base),
            "DROPLET_NVR_ROOT_STATE_DIR": str(self.state_dir),
            "DROPLET_NVR_MEDIA_ENV_FILE": str(self.env_file),
            "FAKE_DIR": str(self.fake),
            "FAKE_ROOT_DEV": ROOT_DEV,
            "FAKE_REAL_STAT": shutil.which("stat") or "stat",
            "FAKE_DOCKER_PS": CONTAINER_ID,
        })
        env.update({k: str(v) for k, v in extra.items()})
        return env

    def run(self, *args: str, **env_extra):
        return subprocess.run([BASH, str(self.script), *args],
                              env=self.env(**env_extra), capture_output=True,
                              text=True, timeout=30, cwd=self.cwd)

    def arm_unmounted(self):
        proc = self.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert self.state()["armed"] is True
        return proc

    # -- observations ----------------------------------------------------
    def _log(self, name: str) -> list[str]:
        path = self.fake / f"{name}.log"
        return path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    def chattr_calls(self):
        return self._log("chattr")

    def docker_calls(self):
        return self._log("docker")

    def restarts(self):
        return [c for c in self._log("docker") if c.startswith("restart ")]

    def systemctl_calls(self):
        return self._log("systemctl")

    def world(self) -> dict[str, str]:
        """Everything the guard could have touched besides its own bookkeeping:
        the call logs and the root-only state dir are excluded (the state is
        asserted explicitly by each test)."""
        return _snapshot(self.tmp, ignore=("fake", "var-lib-droplet-nvr"))


# --------------------------------------------------------------------------
# Shape
# --------------------------------------------------------------------------

def test_script_exists_and_is_bash():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    assert SCRIPT.read_text(encoding="utf-8").splitlines()[0] == "#!/usr/bin/env bash"


@needs_bash
def test_script_is_strict_lf_and_parses():
    data = SCRIPT.read_bytes()
    assert b"\r" not in data, "CRLF line endings"
    assert b"set -euo pipefail" in data
    proc = subprocess.run([BASH, "-n", str(SCRIPT)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


@pytest.mark.skipif(shutil.which("shellcheck") is None,
                    reason="shellcheck not installed")
def test_script_is_shellcheck_clean():
    proc = subprocess.run(["shellcheck", "--severity=warning", str(SCRIPT)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_script_never_evals_sources_the_env_file_or_loops_forever():
    code = [ln for ln in SCRIPT.read_text(encoding="utf-8").splitlines()
            if not ln.lstrip().startswith("#")]
    body = "\n".join(code)
    assert not re.search(r"(^|[\s;&|(])eval(\s|$)", body), "eval in script"
    assert not re.search(r"(^|[\s;&|(])(source|\.)\s+\"?\$\{?(ENV_FILE|REPO_ROOT)", body), \
        "the droplet-writable .env must be READ, never sourced"
    assert not re.search(r"\b(bash|sh)\s+-c\b", body)
    assert "while true" not in body


def test_script_pins_the_contract_names():
    body = SCRIPT.read_text(encoding="utf-8")
    for needle in ("DROPLET_NVR_ROOT_STATE_DIR", "DROPLET_NVR_MEDIA_ENV_FILE",
                   "DROPLET_NVR_MOUNT_BASE", "/var/lib/droplet-nvr",
                   "/mnt/droplet", "guard.json", "droplet-nvr-migrate.service",
                   "com.docker.compose.service=frigate", "ADR-070"):
        assert needle in body, f"script no longer mentions {needle}"
    assert "ADR-069" not in body


# --------------------------------------------------------------------------
# arm
# --------------------------------------------------------------------------

@behavioural
class TestArm:
    def test_unmounted_bay_gets_an_immutable_empty_placeholder_and_state(self, tmp_path):
        box = Box(tmp_path)
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.source.is_dir()
        assert not any(box.source.iterdir()), "the placeholder must stay EMPTY"
        assert box.chattr_calls() == [f"+i {box.source}"]
        st = box.state()
        assert st["armed"] is True
        assert st["source"] == str(box.source)
        assert st["bayRoot"] == str(box.bay_root)
        assert ISO.fullmatch(st["since"]), st["since"]
        assert set(st) == {"armed", "source", "bayRoot", "since"}

    def test_placeholder_is_0700_and_state_is_root_only(self, tmp_path):
        box = Box(tmp_path)
        box.run("arm")
        assert stat.S_IMODE(os.stat(box.source).st_mode) == 0o700
        assert stat.S_IMODE(os.stat(box.state_dir).st_mode) == 0o700
        assert stat.S_IMODE(os.stat(box.state_file).st_mode) == 0o600

    def test_mounted_bay_is_left_completely_alone(self, tmp_path):
        box = Box(tmp_path)
        box.mount_bay()
        before = box.world()
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.world() == before, "arm touched a mounted bay"
        assert box.chattr_calls() == [], "arm must never chattr a mounted bay"
        st = box.state()
        assert st["armed"] is False
        assert st["source"] == str(box.source)

    def test_a_bind_of_the_root_filesystem_is_not_a_bay(self, tmp_path):
        """/mnt/droplet itself is a bind mount of the root fs, so 'is a
        mountpoint' alone proves nothing: the bay must be a DIFFERENT
        filesystem from /."""
        box = Box(tmp_path)
        box.bay_root.mkdir()
        box.mount(box.bay_root, ROOT_DEV)
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.chattr_calls() == [f"+i {box.source}"]
        assert box.state()["armed"] is True

    def test_arm_is_idempotent(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        first_state = box.state_file.read_bytes()
        first_world = box.world()
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.state_file.read_bytes() == first_state, \
            "re-arming must not rewrite `since`"
        assert box.world() == first_world
        assert all(c == f"+i {box.source}" for c in box.chattr_calls())

    def test_an_already_existing_empty_root_fs_dir_is_adopted(self, tmp_path):
        """Docker may have created the (empty) bind source before the guard
        was installed; it is still an empty dir on the root fs, so make it
        immutable rather than refuse."""
        box = Box(tmp_path)
        box.source.mkdir(parents=True)
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.chattr_calls() == [f"+i {box.source}"]

    def test_a_non_empty_root_fs_dir_is_never_frozen(self, tmp_path):
        """Immutability on a directory does not reach its subdirectories, so
        +i on a dir that already holds footage would guard nothing and would
        freeze data in place. Leave it, say so loudly, still arm for release."""
        box = Box(tmp_path)
        box.source.mkdir(parents=True)
        footage = box.source / "recordings"
        footage.mkdir()
        (footage / "a.mp4").write_text("x")
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.chattr_calls() == []
        assert (footage / "a.mp4").read_text() == "x"
        assert "not empty" in proc.stderr
        assert box.state()["armed"] is True

    def test_chattr_failure_leaves_the_dir_absent_and_logs_loudly_but_never_fails(self, tmp_path):
        box = Box(tmp_path)
        proc = box.run("arm", FAKE_CHATTR_RC=1)
        assert proc.returncode == 0, "arm must never block boot"
        assert not box.source.exists(), "a mutable placeholder is worse than none"
        assert "WARNING" in proc.stderr and "immutable" in proc.stderr
        assert box.state()["armed"] is True, "release must still fire later"

    def test_a_pre_existing_empty_dir_survives_a_chattr_failure(self, tmp_path):
        """Only a directory THIS run created is removed on fallback."""
        box = Box(tmp_path)
        box.source.mkdir(parents=True)
        proc = box.run("arm", FAKE_CHATTR_RC=1)
        assert proc.returncode == 0, proc.stderr
        assert box.source.is_dir()

    def test_a_foreign_filesystem_under_the_path_is_never_written(self, tmp_path):
        box = Box(tmp_path)
        box.mount(box.base, "77")          # something else is mounted AT the base
        before = box.world()
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.world() == before
        assert box.chattr_calls() == []
        assert "root filesystem" in proc.stderr

    def test_a_source_that_sits_on_another_filesystem_is_never_chattred(self, tmp_path):
        box = Box(tmp_path)
        box.source.mkdir(parents=True)
        box.mount(box.source, "77")        # nvr/ itself is another fs
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.chattr_calls() == []

    def test_a_late_bay_keeps_a_pending_release_armed(self, tmp_path):
        """Boot armed for this source, then `systemctl restart` of the guard
        while the bay is already up. Downgrading to armed:false here would drop
        the pending Frigate restart and leave it on the EPERM placeholder."""
        box = Box(tmp_path)
        box.arm_unmounted()
        since = box.state()["since"]
        box.mount_bay()
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        st = box.state()
        assert st["armed"] is True and st["since"] == since

    def test_since_is_preserved_across_a_rearm_of_the_same_source(self, tmp_path):
        box = Box(tmp_path)
        box.write_state(True, box.source, since="2001-02-03T04:05:06Z")
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.state()["since"] == "2001-02-03T04:05:06Z"

    def test_a_changed_source_gets_fresh_state(self, tmp_path):
        box = Box(tmp_path)
        box.write_state(True, box.base / "old-aaaa1111" / "nvr",
                        since="2001-02-03T04:05:06Z")
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        st = box.state()
        assert st["source"] == str(box.source)
        assert st["since"] != "2001-02-03T04:05:06Z"

    # -- never block boot -------------------------------------------------
    def test_missing_env_file_is_a_clean_no_op(self, tmp_path):
        box = Box(tmp_path)
        box.env_file.unlink()
        before = box.world()
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.world() == before
        assert box.chattr_calls() == []

    def test_unwritable_state_dir_does_not_block_or_unguard(self, tmp_path):
        box = Box(tmp_path)
        box.state_dir.write_text("a regular file where the state dir should be")
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.source.is_dir(), "the placeholder matters more than the state"
        assert "WARNING" in proc.stderr

    def test_a_broken_python_does_not_stop_arm(self, tmp_path):
        """arm runs before docker at boot; it must not depend on python being
        healthy (the state is written with printf, read best-effort)."""
        box = Box(tmp_path)
        box.shim("python3", "#!/usr/bin/env bash\nexit 127\n")
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.chattr_calls() == [f"+i {box.source}"]
        assert box.state()["armed"] is True

    def test_mkdir_failure_is_survivable(self, tmp_path):
        box = Box(tmp_path)
        box.bay_root.write_text("a regular file where the mount dir should be")
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.chattr_calls() == []
        assert box.state()["armed"] is True


# --------------------------------------------------------------------------
# arm: NVR_MEDIA_SOURCE comes from a droplet-writable file => untrusted
# --------------------------------------------------------------------------

NOT_A_BAY_SOURCE = [
    pytest.param("nvrdata", id="named-volume"),
    pytest.param("", id="empty"),
    pytest.param("/data/frigate", id="other-absolute-path"),
    pytest.param("{base}/{tail}", id="no-nvr-suffix"),
    pytest.param("{base}/{tail}/nvr/", id="trailing-slash"),
    pytest.param("{base}/{tail}/nvr/sub", id="below-nvr"),
    pytest.param("{base}/{tail}/NVR", id="wrong-case"),
    pytest.param("{base}/nvr", id="no-tail"),
    pytest.param("{base}/a/b/nvr", id="nested-tail"),
    pytest.param("{base}/{tail}//nvr", id="double-slash"),
    pytest.param("{base}//{tail}/nvr", id="double-slash-after-base"),
    pytest.param("{tail}/nvr", id="relative-one-segment"),
    pytest.param("relative/{tail}/nvr", id="relative"),
]

HOSTILE_SOURCE = NOT_A_BAY_SOURCE + [
    pytest.param("/", id="root"),
    pytest.param("/etc", id="etc"),
    pytest.param("{base}/.hidden/nvr", id="dot-tail"),
    pytest.param("{base}/../outside/nvr", id="dotdot-escape"),
    pytest.param("{base}/{tail}/../../outside/nvr", id="dotdot-below-tail"),
    pytest.param("{base}/-lead/nvr", id="leading-dash"),
    pytest.param("{base}/x y/nvr", id="space"),
    pytest.param("{base}/x;touch y/nvr", id="semicolon"),
    pytest.param("{base}/$(touch {sentinel})/nvr", id="command-subst"),
    pytest.param("{base}/x`touch {sentinel}`/nvr", id="backtick"),
    pytest.param("{base}/x*/nvr", id="glob"),
    pytest.param("{tmp}/outside/nvr", id="outside-the-base"),
    pytest.param("$(touch {sentinel})", id="bare-command-subst"),
]


@behavioural
class TestHostileEnv:
    @pytest.mark.parametrize("value", HOSTILE_SOURCE)
    def test_nothing_is_touched_and_stale_state_is_cleared(self, tmp_path, value):
        box = Box(tmp_path)
        (tmp_path / "outside").mkdir()
        box.write_env(f"NVR_MEDIA_SOURCE={box.fmt(value)}\n")
        # A previous arm left state behind; a non-bay value must clear it.
        box.write_state(True, box.base / "old-aaaa1111" / "nvr")
        before = box.world()
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.world() == before, (
            "a non-bay NVR_MEDIA_SOURCE changed the filesystem")
        assert box.chattr_calls() == []
        assert not box.sentinel.exists(), "the .env value was evaluated"
        assert not box.state_file.exists(), "stale state must be cleared"
        assert list(box.cwd.iterdir()) == [], "a relative path was acted on"

    def test_system_directories_are_never_chattred(self, tmp_path):
        for value in ("/", "/etc", "/boot", "/usr/local/sbin", "/var/lib/docker"):
            box = Box(tmp_path / (value.strip("/").replace("/", "_") or "root"))
            box.write_env(f"NVR_MEDIA_SOURCE={value}\n")
            proc = box.run("arm")
            assert proc.returncode == 0, proc.stderr
            assert box.chattr_calls() == [], value

    def test_other_keys_are_never_evaluated(self, tmp_path):
        box = Box(tmp_path)
        box.write_env(
            f"NVR_MEDIA_SOURCE={box.source}\n"
            f"EVIL=$(touch {box.sentinel})\n"
            f"ALSO=`touch {box.sentinel}`\n")
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert not box.sentinel.exists(), "the .env was sourced"
        assert box.state()["armed"] is True

    def test_a_symlinked_tail_is_refused(self, tmp_path):
        """The bay mount root is droplet-owned once mounted, so a symlink in
        the path is attacker-plantable: mkdir -p through it would create
        directories, and chattr +i would freeze them, anywhere root can write."""
        box = Box(tmp_path)
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        os.symlink(elsewhere, box.bay_root)
        before = box.world()
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.world() == before
        assert list(elsewhere.iterdir()) == []
        assert box.chattr_calls() == []
        assert box.state() is None

    def test_a_symlinked_nvr_is_refused(self, tmp_path):
        box = Box(tmp_path)
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        box.bay_root.mkdir()
        os.symlink(elsewhere, box.source)
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert list(elsewhere.iterdir()) == []
        assert box.chattr_calls() == []

    def test_a_symlinked_mount_base_or_ancestor_is_refused(self, tmp_path):
        box = Box(tmp_path)
        real = tmp_path / "real-base"
        real.mkdir()
        link = tmp_path / "base-link"
        os.symlink(real, link)
        box.write_env(f"NVR_MEDIA_SOURCE={link}/{TAIL}/nvr\n")
        proc = box.run("arm", DROPLET_NVR_MOUNT_BASE=str(link))
        assert proc.returncode == 0, proc.stderr
        assert list(real.iterdir()) == []
        assert box.chattr_calls() == []

        anc = tmp_path / "anc-link"
        os.symlink(tmp_path / "mnt", anc)
        box.write_env(f"NVR_MEDIA_SOURCE={anc}/droplet/{TAIL}/nvr\n")
        proc = box.run("arm", DROPLET_NVR_MOUNT_BASE=f"{anc}/droplet")
        assert proc.returncode == 0, proc.stderr
        assert box.chattr_calls() == []
        assert not box.bay_root.exists()

    # -- how the value is read -------------------------------------------
    @pytest.mark.parametrize("line", [
        "NVR_MEDIA_SOURCE={src}\n",
        'NVR_MEDIA_SOURCE="{src}"\n',
        "NVR_MEDIA_SOURCE='{src}'\n",
        "NVR_MEDIA_SOURCE={src}\r\n",
    ], ids=["plain", "double-quoted", "single-quoted", "crlf"])
    def test_value_formats_compose_accepts_are_guarded(self, tmp_path, line):
        box = Box(tmp_path)
        box.write_env(line.format(src=box.source))
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.state()["source"] == str(box.source)

    @pytest.mark.parametrize("line", [
        'NVR_MEDIA_SOURCE=""{src}""\n',
        'NVR_MEDIA_SOURCE="{src}\n',
        "NVR_MEDIA_SOURCE={src} # note\n",
        "NVR_MEDIA_SOURCE= {src}\n",
        "export NVR_MEDIA_SOURCE={src}\n",
        "#NVR_MEDIA_SOURCE={src}\n",
        "XNVR_MEDIA_SOURCE={src}\n",
    ], ids=["double-double-quotes", "unbalanced-quote", "inline-comment",
            "leading-space", "export-prefix", "commented-out", "prefixed-key"])
    def test_value_formats_outside_the_contract_are_not_guarded(self, tmp_path, line):
        box = Box(tmp_path)
        box.write_env(line.format(src=box.source))
        before = box.world()
        proc = box.run("arm")
        assert proc.returncode == 0, proc.stderr
        assert box.world() == before
        assert box.chattr_calls() == []

    def test_the_last_duplicate_wins_like_compose(self, tmp_path):
        """Docker Compose's dotenv takes the LAST assignment of a key, so that
        is the value Frigate will actually bind. (Verified against compose.)"""
        box = Box(tmp_path)
        box.write_env("NVR_MEDIA_SOURCE=nvrdata\n"
                      f"NVR_MEDIA_SOURCE={box.source}\n")
        assert box.run("arm").returncode == 0
        assert box.state()["armed"] is True

        box2 = Box(tmp_path / "second")
        box2.write_env(f"NVR_MEDIA_SOURCE={box2.source}\n"
                       "NVR_MEDIA_SOURCE=nvrdata\n")
        before = box2.world()
        assert box2.run("arm").returncode == 0
        assert box2.world() == before
        assert box2.chattr_calls() == []


# --------------------------------------------------------------------------
# release
# --------------------------------------------------------------------------

@behavioural
class TestRelease:
    def test_no_state_is_a_silent_no_op(self, tmp_path):
        box = Box(tmp_path)
        proc = box.run("release")
        assert proc.returncode == 0, proc.stderr
        assert box.docker_calls() == [] and box.systemctl_calls() == []
        assert proc.stderr.strip() == ""

    def test_not_armed_never_touches_docker(self, tmp_path):
        box = Box(tmp_path)
        box.write_state(False, box.source)
        box.mount_bay()
        proc = box.run("release")
        assert proc.returncode == 0, proc.stderr
        assert box.docker_calls() == []

    def test_before_the_bay_mounts_nothing_is_restarted(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        proc = box.run("release")
        assert proc.returncode == 0, proc.stderr
        assert box.docker_calls() == []
        assert box.state()["armed"] is True

    def test_after_the_bay_mounts_frigate_is_restarted_exactly_once_and_disarmed(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        proc = box.run("release")
        assert proc.returncode == 0, proc.stderr
        assert box.docker_calls() == [FRIGATE_PS, f"restart {CONTAINER_ID}"]
        st = box.state()
        assert st["armed"] is False
        assert st["source"] == str(box.source)
        # Idempotent: the next timer ticks are no-ops.
        for _ in range(2):
            assert box.run("release").returncode == 0
        assert len(box.restarts()) == 1

    def test_a_bay_that_is_up_but_has_no_nvr_dir_stays_armed(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay(nvr="missing")
        proc = box.run("release")
        assert proc.returncode == 0, proc.stderr
        assert box.docker_calls() == []
        assert "missing" in proc.stderr
        assert box.state()["armed"] is True

    @pytest.mark.parametrize("nvr", ["file", "symlink"])
    def test_a_non_directory_or_symlinked_nvr_is_not_released(self, tmp_path, nvr):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay(nvr=nvr)
        proc = box.run("release")
        assert proc.returncode == 0, proc.stderr
        assert box.docker_calls() == []
        assert box.state()["armed"] is True

    @pytest.mark.parametrize("state", ["activating", "active", "reloading",
                                       "deactivating"])
    def test_release_is_skipped_while_a_migration_runs(self, tmp_path, state):
        """A running oneshot is `activating`, for which `systemctl is-active`
        exits NON-zero -- so the exit code alone would miss the very case this
        guard exists for (the job stops and starts Frigate itself)."""
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        proc = box.run("release", FAKE_MIGRATE_STATE=state)
        assert proc.returncode == 0, proc.stderr
        assert box.docker_calls() == []
        assert box.state()["armed"] is True
        assert box.systemctl_calls() == ["is-active droplet-nvr-migrate.service"]

    @pytest.mark.parametrize("state", ["inactive", "failed", "dead", ""])
    def test_release_proceeds_once_the_migration_is_not_running(self, tmp_path, state):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        proc = box.run("release", FAKE_MIGRATE_STATE=state)
        assert proc.returncode == 0, proc.stderr
        assert len(box.restarts()) == 1

    def test_no_frigate_container_is_logged_and_still_disarms(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        proc = box.run("release", FAKE_DOCKER_PS="")
        assert proc.returncode == 0, proc.stderr
        assert box.restarts() == []
        assert "no running frigate" in proc.stderr
        assert box.state()["armed"] is False

    def test_an_unreachable_docker_stays_armed_for_the_next_tick(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        proc = box.run("release", FAKE_DOCKER_PS_RC=1)
        assert proc.returncode == 0, proc.stderr
        assert box.restarts() == []
        assert "docker" in proc.stderr
        assert box.state()["armed"] is True

    def test_a_failed_restart_stays_armed_and_does_not_fail_the_unit(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        proc = box.run("release", FAKE_DOCKER_RESTART_RC=1)
        assert proc.returncode == 0, proc.stderr
        assert box.state()["armed"] is True
        # ...and the next tick retries.
        assert box.run("release").returncode == 0
        assert box.state()["armed"] is False
        assert len(box.restarts()) == 2

    def test_every_matching_container_is_restarted(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        proc = box.run("release", FAKE_DOCKER_PS=f"{CONTAINER_ID}\\nba9876543210")
        assert proc.returncode == 0, proc.stderr
        assert box.restarts() == [f"restart {CONTAINER_ID}", "restart ba9876543210"]
        assert box.state()["armed"] is False

    @pytest.mark.parametrize("ps_out", [
        "abc; touch {sentinel}", "$(touch {sentinel})", "ABCDEF123456",
        "short", "--rm-rf", "0123456789ab extra",
    ])
    def test_a_container_id_that_is_not_hex_is_never_passed_to_docker(self, tmp_path, ps_out):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        proc = box.run("release", FAKE_DOCKER_PS=box.fmt(ps_out))
        assert proc.returncode == 0, proc.stderr
        assert box.restarts() == []
        assert not box.sentinel.exists()
        assert box.state()["armed"] is True

    def test_tampered_state_is_ignored(self, tmp_path):
        """guard.json is root-only, but release acts on the path inside it, so
        it is validated exactly like the .env value."""
        box = Box(tmp_path)
        box.mount_bay()
        for source in ("/etc", "/", f"{box.base}/../outside/nvr",
                       f"{box.base}/x y/nvr", "nvrdata"):
            box.write_state(True, source)
            proc = box.run("release")
            assert proc.returncode == 0, proc.stderr
            assert box.docker_calls() == [], source

    def test_a_tampered_bay_root_field_is_never_used(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        box.write_state(True, box.source, bayRoot="/etc")
        proc = box.run("release")
        assert proc.returncode == 0, proc.stderr
        assert len(box.restarts()) == 1, "bayRoot must be derived from source"

    def test_unreadable_state_is_loud_not_silent(self, tmp_path):
        """If the state says armed but cannot be parsed, silently doing nothing
        would leave Frigate on the EPERM placeholder forever."""
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        box.shim("python3", "#!/usr/bin/env bash\nexit 127\n")
        proc = box.run("release")
        assert proc.returncode == 0, proc.stderr
        assert box.docker_calls() == []
        assert "WARNING" in proc.stderr and "state" in proc.stderr


# --------------------------------------------------------------------------
# disarm
# --------------------------------------------------------------------------

@behavioural
class TestDisarm:
    def test_removes_the_placeholder_its_mount_dir_and_the_state(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        proc = box.run("disarm")
        assert proc.returncode == 0, proc.stderr
        assert box.chattr_calls() == [f"+i {box.source}", f"-i {box.source}"]
        assert not box.source.exists()
        assert not box.bay_root.exists(), "the empty mount-tail dir goes too"
        assert box.base.is_dir(), "the shared base is never removed"
        assert not box.state_file.exists()

    def test_leaves_a_mounted_bay_alone_but_still_clears_the_state(self, tmp_path):
        """Once the bay is mounted, <source> is the bay's REAL directory, not
        the placeholder: it must not be chattr'd or removed."""
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        before = box.world()
        proc = box.run("disarm")
        assert proc.returncode == 0, proc.stderr
        assert box.chattr_calls() == [f"+i {box.source}"]   # only arm's call
        assert box.world() == before
        assert not box.state_file.exists()

    def test_a_non_empty_placeholder_is_not_removed(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        (box.source / "data").write_text("x")
        proc = box.run("disarm")
        assert proc.returncode == 0, proc.stderr
        assert (box.source / "data").read_text() == "x"
        assert box.chattr_calls() == [f"+i {box.source}"]
        assert not box.state_file.exists()

    def test_the_mount_tail_dir_survives_when_it_holds_other_entries(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        (box.bay_root / "files").mkdir()
        proc = box.run("disarm")
        assert proc.returncode == 0, proc.stderr
        assert not box.source.exists()
        assert (box.bay_root / "files").is_dir()

    @pytest.mark.parametrize("source", [
        "/etc", "/", "{base}/../outside/nvr", "{base}/x y/nvr", "nvrdata",
        "{tmp}/outside/nvr", "{base}/{tail}/nvr/",
    ])
    def test_refuses_a_recorded_path_that_is_not_a_bay_path(self, tmp_path, source):
        box = Box(tmp_path)
        (tmp_path / "outside" / "nvr").mkdir(parents=True)
        box.write_state(True, box.fmt(source))
        before = box.world()
        proc = box.run("disarm")
        assert proc.returncode == 0, proc.stderr
        assert box.world() == before
        assert box.chattr_calls() == []
        assert not box.state_file.exists()

    def test_refuses_a_symlinked_placeholder(self, tmp_path):
        box = Box(tmp_path)
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        box.bay_root.mkdir()
        os.symlink(elsewhere, box.source)
        box.write_state(True, box.source)
        proc = box.run("disarm")
        assert proc.returncode == 0, proc.stderr
        assert elsewhere.is_dir()
        assert box.chattr_calls() == []

    def test_with_nothing_armed_it_is_a_clean_no_op_and_idempotent(self, tmp_path):
        box = Box(tmp_path)
        for _ in range(2):
            proc = box.run("disarm")
            assert proc.returncode == 0, proc.stderr
        assert box.chattr_calls() == []
        box.arm_unmounted()
        for _ in range(2):
            assert box.run("disarm").returncode == 0
        assert not box.source.exists()


# --------------------------------------------------------------------------
# status + CLI
# --------------------------------------------------------------------------

@behavioural
class TestStatusAndCli:
    def test_status_without_state(self, tmp_path):
        box = Box(tmp_path)
        proc = box.run("status")
        assert proc.returncode == 0, proc.stderr
        assert json.loads(proc.stdout) == {"armed": False}

    def test_status_reports_the_armed_state_verbatim(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        proc = box.run("status")
        assert proc.returncode == 0, proc.stderr
        assert json.loads(proc.stdout) == box.state()
        assert list(json.loads(proc.stdout)) == ["armed", "source", "bayRoot", "since"]

    def test_status_after_release_says_disarmed(self, tmp_path):
        box = Box(tmp_path)
        box.arm_unmounted()
        box.mount_bay()
        box.run("release")
        assert json.loads(box.run("status").stdout)["armed"] is False

    @pytest.mark.parametrize("raw", ["{not json", "[]", "null", '"s"', "",
                                     '{"armed": "yes", "source": "/x"}',
                                     '{"armed": true}'])
    def test_status_with_unusable_state_degrades_to_not_armed(self, tmp_path, raw):
        box = Box(tmp_path)
        box.write_state(True, box.source, raw=raw)
        proc = box.run("status")
        assert proc.returncode == 0, proc.stderr
        assert json.loads(proc.stdout) == {"armed": False}

    def test_status_never_echoes_a_tampered_path(self, tmp_path):
        box = Box(tmp_path)
        box.write_state(True, "/etc")
        assert json.loads(box.run("status").stdout) == {"armed": False}

    @pytest.mark.parametrize("args", [(), ("bogus",), ("ARM",), ("arm;reboot",)])
    def test_unknown_subcommand_is_a_usage_error(self, tmp_path, args):
        box = Box(tmp_path)
        proc = box.run(*args)
        assert proc.returncode == 2
        assert "usage" in proc.stderr.lower()
        assert box.chattr_calls() == [] and box.docker_calls() == []


# --------------------------------------------------------------------------
# Mutation checks -- prove every guard layer is load-bearing
# --------------------------------------------------------------------------

def _mutant(tmp_path: Path, needle: str, replacement: str) -> Path:
    src = SCRIPT.read_text(encoding="utf-8")
    assert src.count(needle) == 1, (
        f"guard shape changed (need exactly one occurrence) - update this "
        f"mutation test: {needle!r}")
    mutated = tmp_path / "mutated-guard.sh"
    mutated.write_text(src.replace(needle, replacement), encoding="utf-8",
                       newline="\n")
    return mutated


@behavioural
class TestMutations:
    def test_removing_the_base_prefix_check_acts_on_a_relative_path(self, tmp_path):
        """A RELATIVE `<tail>/nvr` matches the tail regex on its own: without
        the prefix check root would mkdir + chattr it under its cwd."""
        mutated = _mutant(tmp_path, '[[ "$p" == "$MOUNT_BASE"/* ]] || return 1',
                          'true || return 1')
        value = f"{TAIL}/nvr"
        real = Box(tmp_path / "real")
        real.write_env(f"NVR_MEDIA_SOURCE={value}\n")
        assert real.run("arm").returncode == 0
        assert real.chattr_calls() == [] and list(real.cwd.iterdir()) == []

        mut = Box(tmp_path / "mut", script=mutated)
        mut.write_env(f"NVR_MEDIA_SOURCE={value}\n")
        assert mut.run("arm").returncode == 0
        assert (mut.cwd / TAIL / "nvr").is_dir(), (
            "mutant should have created the relative path; if not, the prefix "
            "check is not what refuses it")

    def test_removing_the_shape_regex_lets_a_traversal_escape_the_base(self, tmp_path):
        mutated = _mutant(tmp_path, '[[ "$rest" =~ $NVR_REST_RE ]] || return 1',
                          'true || return 1')
        real = Box(tmp_path / "real")
        real.write_env(f"NVR_MEDIA_SOURCE={real.base}/../outside/nvr\n")
        assert real.run("arm").returncode == 0
        assert not (real.tmp / "mnt" / "outside").exists()

        mut = Box(tmp_path / "mut", script=mutated)
        mut.write_env(f"NVR_MEDIA_SOURCE={mut.base}/../outside/nvr\n")
        assert mut.run("arm").returncode == 0
        assert (mut.tmp / "mnt" / "outside" / "nvr").is_dir(), (
            "mutant should have escaped the base; if not, the regex is not "
            "what stops `..`")
        assert mut.chattr_calls() != []

    def test_removing_the_symlink_walk_follows_a_planted_symlink(self, tmp_path):
        mutated = _mutant(tmp_path, 'no_symlink_components "$p" || return 1',
                          'true || return 1')
        for name, script in (("real", None), ("mut", mutated)):
            box = Box(tmp_path / name, script=script)
            elsewhere = box.tmp / "elsewhere"
            elsewhere.mkdir()
            os.symlink(elsewhere, box.bay_root)
            assert box.run("arm").returncode == 0
            leaked = (elsewhere / "nvr").exists()
            if name == "real":
                assert not leaked
            else:
                assert leaked, ("mutant should have written through the "
                                "symlink; if not, the walk is not what stops it")
                assert box.chattr_calls() != []

    def test_removing_the_bay_present_check_mis_arms_a_mounted_bay(self, tmp_path):
        mutated = _mutant(tmp_path, 'if bay_present "$bay_root"; then',
                          'if false; then')
        real = Box(tmp_path / "real")
        real.mount_bay()
        assert real.run("arm").returncode == 0
        assert real.state()["armed"] is False

        mut = Box(tmp_path / "mut", script=mutated)
        mut.mount_bay()
        assert mut.run("arm").returncode == 0
        assert mut.state()["armed"] is True, (
            "mutant should have armed a mounted bay; if not, bay_present is "
            "not what decides it")

    def test_removing_the_root_device_check_would_freeze_a_foreign_fs(self, tmp_path):
        needle = '[ "$(dev_of "$src")" = "$root_dev" ] ||'
        mutated = _mutant(tmp_path, needle, 'true ||')
        for name, script in (("real", None), ("mut", mutated)):
            box = Box(tmp_path / name, script=script)
            box.source.mkdir(parents=True)
            box.mount(box.source, "77")         # nvr/ is another filesystem
            assert box.run("arm").returncode == 0
            if name == "real":
                assert box.chattr_calls() == []
            else:
                assert box.chattr_calls() == [f"+i {box.source}"], (
                    "mutant should have chattr'd the foreign fs; if not, the "
                    "device check is not what refuses it")

    def test_removing_the_emptiness_check_would_freeze_existing_footage(self, tmp_path):
        mutated = _mutant(tmp_path, 'dir_is_empty "$src" || {', 'true || {')
        for name, script in (("real", None), ("mut", mutated)):
            box = Box(tmp_path / name, script=script)
            box.source.mkdir(parents=True)
            (box.source / "recordings").mkdir()
            assert box.run("arm").returncode == 0
            if name == "real":
                assert box.chattr_calls() == []
            else:
                assert box.chattr_calls() == [f"+i {box.source}"]

    def test_removing_the_bay_check_in_release_restarts_frigate_too_early(self, tmp_path):
        mutated = _mutant(tmp_path, 'bay_present "$bay_root" || return 0',
                          'true || return 0')
        for name, script in (("real", None), ("mut", mutated)):
            box = Box(tmp_path / name, script=script)
            box.arm_unmounted()                 # bay NOT mounted
            assert box.run("release").returncode == 0
            if name == "real":
                assert box.restarts() == []
            else:
                assert len(box.restarts()) == 1, (
                    "mutant should have restarted Frigate before the bay "
                    "mounted; if not, the check is not what prevents it")

    def test_removing_the_migration_check_restarts_frigate_mid_migration(self, tmp_path):
        mutated = _mutant(tmp_path, 'if migration_busy; then', 'if false; then')
        for name, script in (("real", None), ("mut", mutated)):
            box = Box(tmp_path / name, script=script)
            box.arm_unmounted()
            box.mount_bay()
            assert box.run("release", FAKE_MIGRATE_STATE="activating").returncode == 0
            if name == "real":
                assert box.restarts() == []
            else:
                assert len(box.restarts()) == 1

    def test_removing_the_root_device_check_in_disarm_would_gut_the_bay(self, tmp_path):
        needle = '[ "$(dev_of "$src")" = "$root_dev" ] && dir_is_empty "$src"'
        mutated = _mutant(tmp_path, needle, 'dir_is_empty "$src"')
        for name, script in (("real", None), ("mut", mutated)):
            box = Box(tmp_path / name, script=script)
            box.arm_unmounted()
            box.mount_bay()                      # source is now the BAY's dir
            assert box.run("disarm").returncode == 0
            if name == "real":
                assert box.source.is_dir()
            else:
                assert not box.source.exists(), (
                    "mutant should have removed the bay's own nvr dir; if not, "
                    "the device check is not what protects it")


# --------------------------------------------------------------------------
# The systemd units
# --------------------------------------------------------------------------

def _parse_unit(path: Path) -> dict[str, list[tuple[str, str]]]:
    sections: dict[str, list[tuple[str, str]]] = {}
    current = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1]
            sections.setdefault(current, [])
            continue
        key, _, value = line.partition("=")
        assert current is not None, f"directive outside a section: {raw}"
        sections[current].append((key.strip(), value.strip()))
    return sections


def _values(unit, section, key):
    return [v for k, v in unit.get(section, []) if k == key]


def _tokens(unit, section, key):
    return [t for v in _values(unit, section, key) for t in v.split()]


def _comments(path: Path) -> str:
    return "\n".join(ln.strip().lstrip("#; ").strip()
                     for ln in path.read_text(encoding="utf-8").splitlines()
                     if ln.strip().startswith(("#", ";")))


ALL_UNITS = [ARM_UNIT, RELEASE_UNIT, RELEASE_TIMER]


@pytest.mark.parametrize("path", ALL_UNITS, ids=lambda p: p.name)
class TestEveryGuardUnit:
    def test_exists_lf_and_has_no_adr_069(self, path):
        assert path.exists(), f"missing {path}"
        data = path.read_bytes()
        assert b"\r" not in data
        assert b"ADR-069" not in data

    def test_never_hard_couples_to_docker_or_anything(self, path):
        """Handbook P6: Requires= makes docker.service stop/restart cascade a
        stop to this unit. Nothing here may use a hard dependency."""
        unit = _parse_unit(path)
        keys = {k for kv in unit.values() for k, _v in kv}
        assert not keys & {"Requires", "BindsTo", "PartOf", "Requisite"}
        text = path.read_text(encoding="utf-8")
        assert "Requires=docker.service" not in text

    def test_explains_the_reboot_scenario(self, path):
        why = _comments(path).lower()
        assert "reboot" in why
        assert "after=docker.service" in why or "docker" in why

    def test_has_no_environment_file(self, path):
        assert not _values(_parse_unit(path), "Service", "EnvironmentFile")


class TestArmUnit:
    def test_orders_before_docker_after_local_fs_and_is_enabled_at_boot(self):
        unit = _parse_unit(ARM_UNIT)
        assert "docker.service" in _tokens(unit, "Unit", "Before")
        assert "local-fs.target" in _tokens(unit, "Unit", "After")
        assert _values(unit, "Install", "WantedBy") == ["multi-user.target"]

    def test_is_a_remain_after_exit_oneshot_running_arm(self):
        unit = _parse_unit(ARM_UNIT)
        assert _values(unit, "Service", "Type") == ["oneshot"]
        assert _values(unit, "Service", "RemainAfterExit") == ["yes"]
        assert _values(unit, "Service", "ExecStart") == [
            "/usr/local/sbin/droplet-nvr-guard.sh arm"]

    def test_carries_the_repo_root_placeholder_and_a_known_good_path(self):
        unit = _parse_unit(ARM_UNIT)
        env = _values(unit, "Service", "Environment")
        assert "REPO_ROOT=@REPO_ROOT@" in env
        path = [v for v in env if v.startswith("PATH=")]
        assert len(path) == 1
        assert "/usr/local/sbin" in path[0].split("=", 1)[1].split(":")
        rendered = ARM_UNIT.read_text(encoding="utf-8").replace(
            "@REPO_ROOT@", "/home/droplet/edge-platform")
        assert "@REPO_ROOT@" not in rendered

    def test_has_a_finite_start_timeout_so_it_can_never_hold_docker_back(self):
        unit = _parse_unit(ARM_UNIT)
        (timeout,) = _values(unit, "Service", "TimeoutStartSec")
        assert re.fullmatch(r"\d+s?", timeout), timeout
        assert 0 < int(timeout.rstrip("s")) <= 60

    def test_does_not_pull_docker_in(self):
        """It runs BEFORE docker; a Wants= would make enabling the guard start
        docker as a side effect."""
        unit = _parse_unit(ARM_UNIT)
        assert "docker.service" not in _tokens(unit, "Unit", "Wants")
        assert "docker.service" not in _tokens(unit, "Unit", "After")


class TestReleaseUnit:
    def test_runs_release_after_docker_as_a_oneshot(self):
        unit = _parse_unit(RELEASE_UNIT)
        assert _values(unit, "Service", "Type") == ["oneshot"]
        assert "docker.service" in _tokens(unit, "Unit", "After")
        assert _values(unit, "Service", "ExecStart") == [
            "/usr/local/sbin/droplet-nvr-guard.sh release"]

    def test_is_driven_by_its_timer_only(self):
        assert "Install" not in _parse_unit(RELEASE_UNIT)

    def test_does_not_resurrect_a_stopped_docker(self):
        """A 30 s timer unit with Wants=docker.service would start docker
        again every tick after an operator stopped it for maintenance. After=
        orders; it does not pull in."""
        unit = _parse_unit(RELEASE_UNIT)
        assert "docker.service" not in _tokens(unit, "Unit", "Wants")

    def test_has_a_finite_timeout_so_a_hung_docker_cannot_wedge_the_timer(self):
        unit = _parse_unit(RELEASE_UNIT)
        (timeout,) = _values(unit, "Service", "TimeoutStartSec")
        assert re.fullmatch(r"\d+s?", timeout), timeout
        assert int(timeout.rstrip("s")) > 0


class TestReleaseTimer:
    def test_fields(self):
        unit = _parse_unit(RELEASE_TIMER)
        assert _values(unit, "Timer", "OnBootSec") == ["45s"]
        assert _values(unit, "Timer", "OnUnitActiveSec") == ["30s"]
        assert _values(unit, "Timer", "Unit") == [
            "droplet-nvr-guard-release.service"]
        assert _values(unit, "Install", "WantedBy") == ["timers.target"]

    def test_accuracy_is_tight_enough_for_a_30s_cadence(self):
        """The systemd default AccuracySec is 1 min, which would stretch a 30 s
        timer to up to 90 s between ticks."""
        unit = _parse_unit(RELEASE_TIMER)
        (acc,) = _values(unit, "Timer", "AccuracySec")
        assert re.fullmatch(r"\d+s", acc) and int(acc[:-1]) <= 10


# --------------------------------------------------------------------------
# Coupling to the compose file the guard protects
# --------------------------------------------------------------------------

def test_the_frigate_service_restarts_always_and_binds_the_nvr_seam():
    """The whole hazard rests on these two facts: Docker brings Frigate up on
    its own at boot (restart: always), and the bind source comes from
    ${NVR_MEDIA_SOURCE}. If either changes, this guard's premise changed."""
    body = COMPOSE.read_text(encoding="utf-8")
    m = re.search(r"\n  frigate:\n(.*?)(?=\n  [A-Za-z0-9_-]+:\n)", body, re.S)
    assert m, "frigate service not found in docker-compose.yml"
    block = m.group(1)
    assert "restart: always" in block
    assert "${NVR_MEDIA_SOURCE:-nvrdata}:/media/frigate" in block
