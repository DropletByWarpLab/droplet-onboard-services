"""Inherited filesystem boundary for the sandbox API and customer subprocesses.

Workspace/extension children still use git, Python, Node and loopback sockets.
They may read the image runtime and write the workspace volumes, but cannot
read the TLS mount through any filesystem alias. No seccomp/network policy
is added here; analysis children apply their own tighter boundary afterward.
"""
from __future__ import annotations

import ctypes
import os
import platform
import stat
import sys
from pathlib import Path


class IsolationUnavailable(RuntimeError):
    pass


READ_ONLY_PATHS = ("/app", "/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/dev", "/proc")
READ_WRITE_PATHS = ("/tmp", "/var/lib/workspace", "/var/lib/workspace-git", "/var/lib/workspace-ext")
# git and process supervision open DEVNULL read/write. Grant only these safe
# character devices, with file rights rather than directory creation rights.
WRITE_DEVICES = ("/dev/null", "/dev/zero")


def _fail(libc: ctypes.CDLL, operation: str) -> None:
    raise IsolationUnavailable(f"sandbox filesystem isolation unavailable: {operation}: {os.strerror(ctypes.get_errno())}")


def seal_sandbox() -> int:
    """Install an irreversible, inherited Landlock policy before serving code."""
    if not sys.platform.startswith("linux") or platform.machine().lower() not in ("x86_64", "amd64", "aarch64", "arm64"):
        raise IsolationUnavailable("sandbox filesystem isolation requires Linux with Landlock")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    abi = libc.syscall(444, ctypes.c_void_p(), 0, 1)
    if abi < 1:
        _fail(libc, "Landlock ABI query")

    class Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]

    class PathBeneath(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

    handled = (1 << 13) - 1
    if abi >= 2:
        handled |= 1 << 13  # REFER
    if abi >= 3:
        handled |= 1 << 14  # TRUNCATE
    descriptor = libc.syscall(444, ctypes.byref(Ruleset(handled)), ctypes.sizeof(Ruleset), 0)
    if descriptor < 0:
        _fail(libc, "Landlock ruleset creation")
    read_execute = (1 << 0) | (1 << 2) | (1 << 3)
    try:
        # Resolve runtime symlinks once. Grant no parent of /data/service-tls.
        rules: dict[str, int] = {}
        for path, permissions in [(p, read_execute) for p in READ_ONLY_PATHS] + [(p, handled) for p in READ_WRITE_PATHS]:
            if Path(path).exists():
                canonical = str(Path(path).resolve(strict=True))
                if canonical == "/" or canonical == "/data" or canonical.startswith("/data/service-tls"):
                    raise IsolationUnavailable("sandbox filesystem policy would expose the TLS mount")
                rules[canonical] = rules.get(canonical, 0) | permissions
        for path in WRITE_DEVICES:
            if not stat.S_ISCHR(os.stat(path).st_mode):
                raise IsolationUnavailable(f"sandbox runtime device is not a character device: {path}")
            rules[path] = (1 << 1) | (1 << 2) | (handled & (1 << 14))
        for path, permissions in sorted(rules.items()):
            path_descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = PathBeneath(permissions, path_descriptor)
                if libc.syscall(445, descriptor, 1, ctypes.byref(rule), 0) < 0:
                    _fail(libc, "Landlock path rule")
            finally:
                os.close(path_descriptor)
        if libc.prctl(38, 1, 0, 0, 0) != 0:
            _fail(libc, "no_new_privs")
        if libc.syscall(446, descriptor, 0) != 0:
            _fail(libc, "Landlock restriction")
    finally:
        os.close(descriptor)
    return int(abi)
