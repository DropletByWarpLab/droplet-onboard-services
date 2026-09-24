"""Process probes shared by the supervision and extension suites (Linux).

WARP-2900 review #2323 (d): a stop, a disable or a crash must take what the
supervised child forked with it. These read /proc, so the tests that use
them are skipped off Linux.
"""

from __future__ import annotations

import sys
import time

import pytest

needs_linux = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="process groups and /proc")


def alive(pid: int) -> bool:
    """The pid still runs. A zombie waiting for its reaper counts as gone:
    it holds no memory, no file and no environment."""
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii") as fh:
            return fh.read().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def wait_gone(pid: int, timeout_s: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not alive(pid):
            return True
        time.sleep(0.05)
    return False
