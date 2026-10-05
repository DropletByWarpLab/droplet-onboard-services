"""The shared topology lock refuses untrusted paths before flocking them."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
LOCK_HELPER = REPO_ROOT / "scripts" / "host" / "droplet-storage-topology-lock.sh"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(
    os.name == "nt" or BASH is None,
    reason="the shared flock contract requires POSIX file descriptors",
)

STAT_STUB = r'''#!/usr/bin/env bash
target="${@: -1}"
kind=""
case "$target" in
  */fd/7) kind=parent_fd ;;
  */fd/8) kind=file_fd ;;
  "$LOCK_DIR") kind=parent_path ;;
  "$LOCK_FILE") kind=file_path ;;
  *) kind=ancestor ;;
esac
case "$STAT_SCENARIO:$kind" in
  good:parent_*|busy:parent_*) printf 'directory|0|1001|750|2|1|101\n' ;;
  good:ancestor|busy:ancestor) printf 'directory|0|0|755|2|1|100\n' ;;
  good:file_*|busy:file_*) printf 'regular empty file|0|1001|660|1|1|202\n' ;;
  wrong_owner_parent:parent_*) printf 'directory|1000|1001|750|2|1|101\n' ;;
  wrong_owner_parent:ancestor) printf 'directory|0|0|755|2|1|100\n' ;;
  wrong_owner_parent:file_*) printf 'regular empty file|0|1001|660|1|1|202\n' ;;
  wrong_owner_lock:parent_*) printf 'directory|0|1001|750|2|1|101\n' ;;
  wrong_owner_lock:ancestor) printf 'directory|0|0|755|2|1|100\n' ;;
  wrong_owner_lock:file_*) printf 'regular empty file|1000|1001|660|1|1|202\n' ;;
  world_access_lock:parent_*) printf 'directory|0|1001|750|2|1|101\n' ;;
  world_access_lock:ancestor) printf 'directory|0|0|755|2|1|100\n' ;;
  world_access_lock:file_*) printf 'regular empty file|0|1001|666|1|1|202\n' ;;
  swapped_parent:parent_path) printf 'directory|0|1001|750|2|1|101\n' ;;
  swapped_parent:parent_fd) printf 'directory|0|1001|750|2|1|102\n' ;;
  swapped_parent:ancestor) printf 'directory|0|0|755|2|1|100\n' ;;
  swapped_parent:file_*) printf 'regular empty file|0|1001|660|1|1|202\n' ;;
  world_writable_ancestor:parent_*) printf 'directory|0|1001|750|2|1|101\n' ;;
  world_writable_ancestor:ancestor) printf 'directory|0|0|777|2|1|100\n' ;;
  world_writable_ancestor:file_*) printf 'regular empty file|0|1001|660|1|1|202\n' ;;
  world_writable_parent:parent_*) printf 'directory|0|1001|777|2|1|101\n' ;;
  world_writable_parent:ancestor) printf 'directory|0|0|755|2|1|100\n' ;;
  world_writable_parent:file_*) printf 'regular empty file|0|1001|660|1|1|202\n' ;;
  hardlinked_lock:file_*) printf 'regular empty file|0|1001|660|2|1|202\n' ;;
  hardlinked_lock:parent_*) printf 'directory|0|1001|750|2|1|101\n' ;;
  hardlinked_lock:ancestor) printf 'directory|0|0|755|2|1|100\n' ;;
  swapped_lock:file_path) printf 'regular empty file|0|1001|660|1|1|999\n' ;;
  swapped_lock:file_fd) printf 'regular empty file|0|1001|660|1|1|202\n' ;;
  swapped_lock:parent_*) printf 'directory|0|1001|750|2|1|101\n' ;;
  swapped_lock:ancestor) printf 'directory|0|0|755|2|1|100\n' ;;
  *) exit 2 ;;
esac
'''


class Fixture:
    def __init__(self, tmp_path: Path, scenario: str = "good"):
        self.root = tmp_path
        self.parent = tmp_path / "lock-parent"
        self.parent.mkdir()
        self.lock = self.parent / "topology.lock"
        self.lock.touch()
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.stat = self.bin / "stat"
        self.stat.write_text(STAT_STUB, encoding="utf-8", newline="\n")
        self.stat.chmod(0o755)
        self.scenario = scenario

    def env(self):
        env = dict(os.environ)
        env.update({
            "PATH": str(self.bin) + os.pathsep + env.get("PATH", ""),
            "LOCK_DIR": str(self.parent),
            "LOCK_FILE": str(self.lock),
            "DROPLET_STORAGE_TOPOLOGY_LOCK_FILE": str(self.lock),
            "STAT_SCENARIO": self.scenario,
        })
        return env

    def run(self):
        return subprocess.run(
            [BASH, "-c", '. "$1"; storage_topology_lock; rc=$?; printf "%s\\n" "$rc"; exit "$rc"',
             "topology-lock-test", str(LOCK_HELPER)],
            env=self.env(), capture_output=True, text=True, timeout=10,
        )


def test_acquires_a_trusted_lock_even_when_test_process_is_not_root(tmp_path):
    fixture = Fixture(tmp_path)
    proc = fixture.run()
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "0"


@pytest.mark.parametrize("scenario", [
    "world_writable_parent", "world_writable_ancestor", "hardlinked_lock", "swapped_lock",
    "wrong_owner_parent", "wrong_owner_lock", "world_access_lock", "swapped_parent",
])
def test_rejects_untrusted_parent_or_lock_inode(tmp_path, scenario):
    fixture = Fixture(tmp_path, scenario)
    if scenario == "hardlinked_lock":
        os.link(fixture.lock, fixture.parent / "second-link")
    proc = fixture.run()
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert proc.stdout.strip() == "2"


def test_reports_contention_only_after_validating_the_open_inode(tmp_path):
    import fcntl

    fixture = Fixture(tmp_path, "busy")
    fd = os.open(fixture.lock, os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        proc = fixture.run()
    finally:
        os.close(fd)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert proc.stdout.strip() == "1"


def test_rejects_symlinked_lock_without_following_it(tmp_path):
    fixture = Fixture(tmp_path)
    target = fixture.parent / "target"
    fixture.lock.unlink()
    target.touch()
    fixture.lock.symlink_to(target)
    proc = fixture.run()
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert proc.stdout.strip() == "2"
