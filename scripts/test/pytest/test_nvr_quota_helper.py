"""Hermetic tests for the NVR project-quota helper (WARP-3514, ADR-070).

scripts/host/droplet-nvr-quota.py is the one place that talks to the kernel's
quota interface: it sets / reads an ext4 PROJECT quota on a bay drive through
quotactl(2). droplet-set-nvr-media.sh shells it as
`droplet-nvr-quota.py set <device> <projid> <hard_bytes>` and `... get ...`.

What is under test, with no root, no block device and no real libc call:

  * the module imports with NO libc loaded (it must import on a Windows dev
    host, and a test must be able to replace the thin `_quotactl()` wrapper);
  * the command word is composed exactly as the kernel macro does —
    QCMD(cmd, type) = (cmd << 8) | (type & 0xff) with Q_SETQUOTA / Q_GETQUOTA
    and PRJQUOTA — because a wrong word is a silent no-op on a real box;
  * `struct if_dqblk` is packed with the right layout (8 x u64 + u32, padded
    to 72 bytes), the hard limit in whole KiB rounded UP, the soft limit 0 and
    `dqb_valid = QIF_BLIMITS` so ONLY the block limits are touched;
  * a mountpoint argument resolves to its source device via mountinfo
    (escapes, stacked mounts), a device argument is used as given;
  * errno handling: "quota not enabled" family -> the stable message the
    writer/orchestrator can recognise, everything else -> strerror, never a
    traceback.

This dev host's kernel (WSL2) has no CONFIG_QUOTA, so the real syscall cannot
be exercised here — these tests pin every byte the syscall would receive.
"""

from __future__ import annotations

import errno
import importlib.util
import json
import os
import struct
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
HELPER = REPO_ROOT / "scripts" / "host" / "droplet-nvr-quota.py"

DEV = "/dev/mapper/droplet-bay-ab12cd34"
# struct if_dqblk, include/uapi/linux/quota.h: 8 x __u64 then __u32, which the
# C compiler pads to a multiple of 8 -> 72 bytes. "=" = native byte order, no
# implicit alignment, so the trailing pad is spelled out.
DQBLK_FMT = "=8QI4x"


def _load():
    """A fresh copy of the (hyphen-named) helper module for every test."""
    spec = importlib.util.spec_from_file_location("droplet_nvr_quota", HELPER)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def mod():
    return _load()


def _patch_quotactl(monkeypatch, mod, *, fill: bytes | None = None, raises=None):
    """Replace the libc wrapper; record every call as (cmd, special, qid, bytes)."""
    calls = []

    def fake(cmd, special, qid, buf):
        calls.append((cmd, special, qid, bytes(buf)))
        if raises is not None:
            raise raises
        if fill is not None:
            buf[:] = fill

    monkeypatch.setattr(mod, "_quotactl", fake)
    return calls


# --------------------------------------------------------------------------
# Shape
# --------------------------------------------------------------------------

def test_helper_exists_with_python_shebang_and_lf_endings():
    assert HELPER.exists(), f"missing {HELPER}"
    raw = HELPER.read_bytes()
    assert raw.startswith(b"#!/usr/bin/env python3\n")
    assert b"\r" not in raw, "CRLF would break the shebang on the box (203/EXEC)"


def test_importing_never_touches_libc(monkeypatch):
    """The module must import on a host without libc/quotactl (Windows dev
    host) — libc is loaded lazily inside the wrapper, never at import."""
    import ctypes
    import ctypes.util

    def boom(*_a, **_k):
        raise AssertionError("libc was touched at import time")

    monkeypatch.setattr(ctypes, "CDLL", boom)
    monkeypatch.setattr(ctypes.util, "find_library", boom)
    _load()  # must not raise


def test_source_uses_only_the_standard_library():
    src = HELPER.read_text(encoding="utf-8")
    allowed = {
        "__future__", "ctypes", "errno", "json", "os", "re", "stat", "struct",
        "sys",
    }
    imported = set()
    for line in src.splitlines():
        line = line.strip()
        if line.startswith("import "):
            imported.add(line.split()[1].split(".")[0].rstrip(","))
        elif line.startswith("from "):
            imported.add(line.split()[1].split(".")[0])
    assert imported <= allowed, f"unexpected imports: {imported - allowed}"


# --------------------------------------------------------------------------
# Kernel ABI constants + struct layout
# --------------------------------------------------------------------------

def test_constants_match_the_kernel_header(mod):
    assert mod.SUBCMDSHIFT == 8
    assert mod.Q_GETQUOTA == 0x800007
    assert mod.Q_SETQUOTA == 0x800008
    assert mod.PRJQUOTA == 2
    assert mod.QIF_BLIMITS == 1


def test_qcmd_composes_like_the_kernel_macro(mod):
    assert mod.qcmd(mod.Q_SETQUOTA, mod.PRJQUOTA) == (0x800008 << 8) | 2
    assert mod.qcmd(mod.Q_GETQUOTA, mod.PRJQUOTA) == (0x800007 << 8) | 2
    # The type lives in the low byte ONLY — a stray high bit must be masked,
    # not smeared into the sub-command.
    assert mod.qcmd(0x800008, 0x1FF) == (0x800008 << 8) | 0xFF


def test_dqblk_layout_is_72_bytes_with_the_documented_offsets(mod):
    assert mod.DQBLK.size == 72 == struct.calcsize(DQBLK_FMT)
    probe = mod.DQBLK.pack(1, 2, 3, 4, 5, 6, 7, 8, 9)
    assert struct.unpack_from("=Q", probe, 0)[0] == 1    # dqb_bhardlimit
    assert struct.unpack_from("=Q", probe, 8)[0] == 2    # dqb_bsoftlimit
    assert struct.unpack_from("=Q", probe, 16)[0] == 3   # dqb_curspace
    assert struct.unpack_from("=I", probe, 64)[0] == 9   # dqb_valid


# --------------------------------------------------------------------------
# set
# --------------------------------------------------------------------------

def test_set_sends_only_the_block_hard_limit(mod, monkeypatch):
    calls = _patch_quotactl(monkeypatch, mod)
    monkeypatch.setattr(mod, "_is_block_device", lambda _p: True)

    rc = mod.main(["set", DEV, "4096", "1000000000"])

    assert rc == 0
    assert len(calls) == 1
    cmd, special, qid, raw = calls[0]
    assert cmd == (0x800008 << 8) | 2
    assert special == DEV
    assert qid == 4096
    hard, soft, cur, ihard, isoft, icur, btime, itime, valid = struct.unpack(DQBLK_FMT, raw)
    assert hard == 976563            # ceil(1e9 / 1024) KiB
    assert soft == 0
    assert (cur, ihard, isoft, icur, btime, itime) == (0, 0, 0, 0, 0, 0)
    assert valid == 1                # QIF_BLIMITS: touch the block limits only


@pytest.mark.parametrize("nbytes, kib", [
    (1, 1),
    (1023, 1),
    (1024, 1),
    (1025, 2),
    (2048, 2),
    (10 ** 9, 976563),
    (2 ** 62, 2 ** 52),
])
def test_set_rounds_the_limit_up_to_whole_kib(mod, monkeypatch, nbytes, kib):
    """The kernel counts 1 KiB blocks. Rounding DOWN would let the slice end
    up smaller than the owner was promised; rounding up never does."""
    calls = _patch_quotactl(monkeypatch, mod)
    monkeypatch.setattr(mod, "_is_block_device", lambda _p: True)
    assert mod.main(["set", DEV, "4096", str(nbytes)]) == 0
    hard = struct.unpack(DQBLK_FMT, calls[0][3])[0]
    assert hard == kib


def test_set_is_silent_on_success(mod, monkeypatch, capsys):
    _patch_quotactl(monkeypatch, mod)
    monkeypatch.setattr(mod, "_is_block_device", lambda _p: True)
    assert mod.main(["set", DEV, "4096", "4096"]) == 0
    out = capsys.readouterr()
    assert out.out == "" and out.err == ""


# --------------------------------------------------------------------------
# get
# --------------------------------------------------------------------------

def test_get_prints_hard_soft_and_used_in_bytes(mod, monkeypatch, capsys):
    fill = struct.pack(DQBLK_FMT, 100, 7, 12345, 0, 0, 0, 0, 0, 0x1F)
    calls = _patch_quotactl(monkeypatch, mod, fill=fill)
    monkeypatch.setattr(mod, "_is_block_device", lambda _p: True)

    rc = mod.main(["get", DEV, "4096"])

    assert rc == 0
    cmd, special, qid, _raw = calls[0]
    assert cmd == (0x800007 << 8) | 2
    assert special == DEV and qid == 4096
    out = capsys.readouterr().out
    assert out.count("\n") == 1, "exactly one JSON line"
    # limits are KiB blocks, curspace is already bytes
    assert json.loads(out) == {"hardBytes": 102400, "softBytes": 7168, "usedBytes": 12345}


# --------------------------------------------------------------------------
# device vs mountpoint
# --------------------------------------------------------------------------

MOUNTINFO = (
    "22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n"
    "98 22 254:3 / /mnt/droplet/bay-ab12cd34 rw,nosuid,nodev,noatime shared:77 master:2 - ext4 "
    "/dev/mapper/droplet-bay-ab12cd34 rw,prjquota\n"
    "99 22 254:4 / /mnt/droplet/with\\040space rw - ext4 /dev/mapper/other rw\n"
    "100 22 8:1 / /mnt/stack rw - ext4 /dev/sdz1 rw\n"
    "101 22 8:2 / /mnt/stack rw - ext4 /dev/sdz2 rw\n"
    "102 22 0:50 / /mnt/virtual rw - tmpfs tmpfs rw\n"
)


@pytest.fixture()
def mountinfo(tmp_path, monkeypatch, mod):
    info = tmp_path / "mountinfo"
    info.write_text(MOUNTINFO, encoding="utf-8", newline="\n")
    monkeypatch.setattr(mod, "MOUNTINFO", str(info))
    monkeypatch.setattr(mod, "_is_block_device", lambda _p: False)
    return info


def test_mountpoint_resolves_to_its_source_device(mod, mountinfo):
    assert mod.resolve_device("/mnt/droplet/bay-ab12cd34") == DEV


def test_mountpoint_escapes_are_decoded(mod, mountinfo):
    assert mod.resolve_device("/mnt/droplet/with space") == "/dev/mapper/other"


def test_stacked_mounts_resolve_to_the_topmost(mod, mountinfo):
    assert mod.resolve_device("/mnt/stack") == "/dev/sdz2"


def test_a_trailing_slash_on_the_mountpoint_is_tolerated(mod, mountinfo):
    assert mod.resolve_device("/mnt/droplet/bay-ab12cd34/") == DEV


@pytest.mark.parametrize("arg", [
    "/mnt/droplet",                       # a directory, not a mountpoint
    "/mnt/droplet/bay-ab12cd34/nvr",      # inside a mount, not the mount itself
    "/nope",
])
def test_non_mountpoints_are_refused(mod, mountinfo, arg):
    with pytest.raises(mod.QuotaError):
        mod.resolve_device(arg)


def test_a_mount_whose_source_is_not_a_device_is_refused(mod, mountinfo):
    with pytest.raises(mod.QuotaError):
        mod.resolve_device("/mnt/virtual")


def test_a_block_device_argument_is_used_as_given(mod, monkeypatch):
    monkeypatch.setattr(mod, "_is_block_device", lambda p: p == DEV)
    monkeypatch.setattr(mod, "MOUNTINFO", "/nonexistent/mountinfo")
    assert mod.resolve_device(DEV) == DEV


def test_main_resolves_a_mountpoint_before_calling_the_kernel(mod, mountinfo, monkeypatch):
    calls = _patch_quotactl(monkeypatch, mod)
    assert mod.main(["set", "/mnt/droplet/bay-ab12cd34", "4096", "2048"]) == 0
    assert calls[0][1] == DEV


def test_unreadable_mountinfo_is_a_clean_error(mod, monkeypatch, capsys):
    monkeypatch.setattr(mod, "_is_block_device", lambda _p: False)
    monkeypatch.setattr(mod, "MOUNTINFO", "/nonexistent/mountinfo")
    rc = mod.main(["get", "/mnt/droplet/x", "4096"])
    assert rc == 1
    err = capsys.readouterr().err
    assert err.strip() and "Traceback" not in err


# --------------------------------------------------------------------------
# errors
# --------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "ESRCH"])
def test_quota_not_enabled_errnos_give_the_stable_message(mod, monkeypatch, capsys, name):
    """ENOSYS/ENOTSUP: kernel or fs without quota support; ESRCH: quota not
    turned on for the type — all mean the fs is not prjquota-capable."""
    code = getattr(errno, name)
    _patch_quotactl(monkeypatch, mod, raises=OSError(code, os.strerror(code)))
    monkeypatch.setattr(mod, "_is_block_device", lambda _p: True)
    rc = mod.main(["set", DEV, "4096", "4096"])
    assert rc == 1
    assert "project quota not enabled on this filesystem" in capsys.readouterr().err


def test_other_errnos_surface_their_strerror(mod, monkeypatch, capsys):
    _patch_quotactl(monkeypatch, mod, raises=OSError(errno.EPERM, os.strerror(errno.EPERM)))
    monkeypatch.setattr(mod, "_is_block_device", lambda _p: True)
    rc = mod.main(["get", DEV, "4096"])
    err = capsys.readouterr().err
    assert rc == 1
    assert os.strerror(errno.EPERM) in err
    assert "Traceback" not in err


@pytest.mark.parametrize("argv", [
    [],
    ["bogus"],
    ["set"],
    ["set", DEV],
    ["set", DEV, "4096"],
    ["set", DEV, "4096", "1000", "extra"],
    ["get"],
    ["get", DEV],
    ["get", DEV, "4096", "extra"],
    ["set", DEV, "abc", "1000"],
    ["set", DEV, "0", "1000"],            # project id 0 means "no project"
    ["set", DEV, "4294967295", "1000"],   # (u32)-1 is reserved
    ["set", DEV, "-1", "1000"],
    ["set", DEV, "4096", "0"],
    ["set", DEV, "4096", "-5"],
    ["set", DEV, "4096", "1.5"],
    ["set", DEV, "4096", "12abc"],
    ["set", DEV, "4096", str(2 ** 62 + 1)],
    ["get", DEV, "0"],
])
def test_bad_usage_exits_2_and_never_calls_the_kernel(mod, monkeypatch, capsys, argv):
    calls = _patch_quotactl(monkeypatch, mod)
    monkeypatch.setattr(mod, "_is_block_device", lambda _p: True)
    rc = mod.main(argv)
    assert rc == 2
    assert calls == []
    assert "usage" in capsys.readouterr().err.lower()


# --------------------------------------------------------------------------
# The thin libc wrapper
# --------------------------------------------------------------------------

def test_wrapper_loads_libc_once_and_maps_errno(mod, monkeypatch):
    seen = {"loads": 0, "calls": []}

    class FakeFn:
        argtypes = None
        restype = None

        def __call__(self, cmd, special, qid, addr):
            seen["calls"].append((cmd, special, qid))
            return -1

    class FakeLib:
        quotactl = FakeFn()

    def fake_cdll(_name, use_errno=False):
        assert use_errno is True, "errno must be captured to report the failure"
        seen["loads"] += 1
        return FakeLib()

    monkeypatch.setattr(mod.sys, "platform", "linux")
    monkeypatch.setattr(mod.ctypes, "CDLL", fake_cdll)
    monkeypatch.setattr(mod.ctypes.util, "find_library", lambda _n: "libc.so.6")
    monkeypatch.setattr(mod.ctypes, "get_errno", lambda: errno.ENOSYS)
    monkeypatch.setattr(mod, "_LIBC", None, raising=False)

    cmd = mod.qcmd(mod.Q_SETQUOTA, mod.PRJQUOTA)
    for _ in range(2):
        with pytest.raises(OSError) as info:
            mod._quotactl(cmd, DEV, 4096, bytearray(mod.DQBLK.size))
        assert info.value.errno == errno.ENOSYS

    assert seen["loads"] == 1
    assert seen["calls"][0] == (cmd, DEV.encode(), 4096)


def test_wrapper_refuses_a_non_linux_platform(mod, monkeypatch):
    monkeypatch.setattr(mod.sys, "platform", "win32")
    with pytest.raises(OSError) as info:
        mod._quotactl(1, DEV, 4096, bytearray(mod.DQBLK.size))
    assert info.value.errno == errno.ENOSYS


# --------------------------------------------------------------------------
# As a real process (what the writer script actually executes)
# --------------------------------------------------------------------------

def _run_helper(*args):
    return subprocess.run([sys.executable, str(HELPER), *args],
                          capture_output=True, text=True, timeout=30)


def test_cli_without_arguments_prints_usage_and_exits_2():
    proc = _run_helper()
    assert proc.returncode == 2
    assert "usage" in proc.stderr.lower()
    assert "Traceback" not in proc.stderr


def test_cli_on_a_missing_device_fails_cleanly():
    proc = _run_helper("get", "/definitely/not/a/device", "4096")
    assert proc.returncode == 1
    assert proc.stderr.strip()
    assert "Traceback" not in proc.stderr
    assert proc.stdout == ""
