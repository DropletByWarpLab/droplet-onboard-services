"""Irreversible Linux filesystem/process/network boundary for analysis children.

The shared sandbox also mounts other people's workshop/extension state. The
Python import guard is deliberately NOT this boundary: even successful object
introspection must meet kernel denial. Unsupported kernels/platforms fail closed.
"""
from __future__ import annotations

import ctypes
import errno
import os
import platform
import sys
import sysconfig
from pathlib import Path


class IsolationUnavailable(RuntimeError):
    pass


def _fail(libc, operation):
    number = ctypes.get_errno()
    raise IsolationUnavailable(f"secure analysis isolation unavailable: {operation}: {os.strerror(number)}")


def seal_analysis(scratch_dir: str) -> int:
    """Allow only read-only Python/runtime + this call's private scratch.

    Landlock v1 is sufficient for content reads; later write/truncate rights are
    handled when supported. Seccomp also denies path metadata/O_PATH, sockets,
    process spawning, signals and process-memory/fd inspection. No capabilities.
    """
    if not sys.platform.startswith("linux"):
        raise IsolationUnavailable("secure data analysis requires Linux with Landlock; this platform is unsupported")
    machine = platform.machine().lower()
    if machine not in ("x86_64", "amd64", "aarch64", "arm64"):
        raise IsolationUnavailable(f"secure data analysis isolation does not support CPU {machine}")
    scratch = Path(scratch_dir).resolve(strict=True)
    if not scratch.is_dir() or not scratch.name.startswith("analysis-"):
        raise IsolationUnavailable("secure data analysis requires a private scratch directory")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    abi = libc.syscall(444, ctypes.c_void_p(), 0, 1)  # landlock_create_ruleset(VERSION)
    if abi < 1:
        _fail(libc, "Landlock ABI query (kernel or container policy unsupported)")

    class Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]

    class PathBeneath(ctypes.Structure):
        # Kernel UAPI is packed, otherwise ctypes pads this to 16 bytes.
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

    handled = (1 << 13) - 1
    if abi >= 2:
        handled |= 1 << 13  # REFER (rename/link across directories)
    if abi >= 3:
        handled |= 1 << 14  # TRUNCATE
    ruleset = Ruleset(handled)
    descriptor = libc.syscall(444, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0)
    if descriptor < 0:
        _fail(libc, "Landlock ruleset creation")
    read = (1 << 2) | (1 << 3)  # READ_FILE | READ_DIR
    runtime = {sysconfig.get_path("stdlib"), sysconfig.get_path("platstdlib"), sysconfig.get_path("purelib"), sysconfig.get_path("platlib"), "/usr/lib", "/lib"}
    # Managed/standalone interpreters may report the venv's stdlib prefix in
    # sysconfig while modules actually live under the base interpreter.
    version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    runtime.add(str(Path(sys.base_prefix) / "lib" / version))
    runtime.add(str(Path(sys.base_exec_prefix) / "lib" / version))
    try:
        paths = {str(Path(p).resolve()) for p in runtime if p and Path(p).is_dir()}
        paths.add(str(scratch))
        for allowed_path in sorted(paths):
            path_descriptor = os.open(allowed_path, os.O_PATH | os.O_CLOEXEC)
            try:
                # EXECUTE is never allowed, even in scratch. No app/service,
                # workspace, /proc, /dev, home or /etc paths are granted.
                permissions = read if allowed_path != str(scratch) else handled & ~(1 << 0)
                rule = PathBeneath(permissions, path_descriptor)
                if libc.syscall(445, descriptor, 1, ctypes.byref(rule), 0) < 0:
                    _fail(libc, "Landlock path rule")
            finally:
                os.close(path_descriptor)
        if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
            _fail(libc, "no_new_privs")
        if libc.syscall(446, descriptor, 0) != 0:  # landlock_restrict_self
            _fail(libc, "Landlock restriction")
    finally:
        os.close(descriptor)

    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]

    class Program(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]

    if machine in ("x86_64", "amd64"):
        architecture = 0xC000003E
        deny = [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 288, 299, 307,
                29, 30, 31, 64, 65, 66, 67, 68, 69, 70, 71, 220,
                56, 57, 58, 59, 62, 101, 155, 165, 166, 200, 234, 272, 298, 303, 304, 308, 310, 311, 312, 322,
                424, 425, 426, 427, 434, 435, 438, 440]
        # Landlock does NOT restrict stat/access/readlink/O_PATH. Do not allow
        # known paths outside this invocation to disclose size/times/targets.
        # fd-only fstat (5) remains available: every non-stdio fd was opened
        # through the Landlock boundary, and inherited fds are closed by Popen.
        deny.extend([4, 6, 21, 80, 81, 89, 161, 262, 267, 269, 332, 437, 439])
        # Path/descriptor metadata mutations are not covered by Landlock.
        # Refuse them even for runtime descriptors, whose contents are read
        # only. Pathname truncate also needs denial on Landlock ABI < 3.
        deny.extend([76, 90, 91, 92, 93, 94, 132, 137, 188, 189, 190,
                     191, 192, 194, 195, 197, 198, 199, 235, 260, 261, 268, 280, 452])
        open_flags = [(2, 24), (257, 32)]  # open arg 1 / openat arg 2
    else:
        architecture = 0xC00000B7
        deny = [198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 242, 243, 269,
                186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197,
                39, 40, 41, 97, 117, 129, 130, 131, 220, 221, 241, 264, 265, 268, 270, 271, 272, 281,
                424, 425, 426, 427, 434, 435, 438, 440]
        # aarch64 uses fstat (80), fstatat (79), statx (291), openat (56).
        deny.extend([48, 49, 50, 51, 78, 79, 291, 437, 439])
        deny.extend([5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 43, 45, 52, 53, 54, 55, 88, 452])
        open_flags = [(56, 32)]
    # Load arch, kill a different ABI, then load syscall nr. x32 uses the same
    # audit arch with a high syscall bit; refuse it as well, rather than bypass.
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, architecture), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, 0x00050000 | errno.EACCES)]
    # O_PATH can pin ANY path without a Landlock read check. BPF can inspect
    # scalar open/openat flags directly. openat2's flags live behind a pointer,
    # so that syscall is refused above instead of leaving an inspection bypass.
    for number, offset in open_flags:
        instructions.extend([(0x15, 0, 4, number), (0x20, 0, 0, offset),
                             (0x45, 0, 1, os.O_PATH), (0x06, 0, 0, 0x00050000 | errno.EACCES),
                             (0x20, 0, 0, 0)])
    for number in sorted(set(deny)):
        instructions.extend([(0x15, 0, 1, number), (0x06, 0, 0, 0x00050000 | errno.EACCES)])
    instructions.append((0x06, 0, 0, 0x7FFF0000))
    filters = (Filter * len(instructions))(*(Filter(*entry) for entry in instructions))
    program = Program(len(instructions), filters)
    if libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:  # PR_SET_SECCOMP, SECCOMP_MODE_FILTER
        _fail(libc, "seccomp restriction")
    return int(abi)
