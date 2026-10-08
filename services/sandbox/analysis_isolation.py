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


# Reviewed against the Linux x86_64 and asm-generic (aarch64) UAPI tables:
# https://github.com/torvalds/linux/blob/master/arch/x86/entry/syscalls/syscall_64.tbl
# https://github.com/torvalds/linux/blob/master/include/uapi/asm-generic/unistd.h
# Each pair is (x86_64, aarch64). Everything absent is denied, including future
# syscall numbers. No process creation/signalling/inspection, network, IPC,
# keyring, BPF, inotify, metadata path reads/mutations, or resource-limit changes.
_RUNTIME_SYSCALLS = {
    "brk": (12, 214), "mmap": (9, 222), "mprotect": (10, 226),
    "munmap": (11, 215), "mremap": (25, 216), "madvise": (28, 233),
    "rt_sigaction": (13, 134), "rt_sigprocmask": (14, 135),
    "rt_sigreturn": (15, 139), "sigaltstack": (131, 132),
    "futex": (202, 98), "sched_yield": (24, 124),
    "getpid": (39, 172), "gettid": (186, 178),
    "getuid": (102, 174), "geteuid": (107, 175),
    "getgid": (104, 176), "getegid": (108, 177),
    "gettimeofday": (96, 169), "clock_gettime": (228, 113),
    "clock_getres": (229, 114), "nanosleep": (35, 101),
    "clock_nanosleep": (230, 115), "getrandom": (318, 278),
    "exit": (60, 93), "exit_group": (231, 94),
}
# Descriptors start with stdio only (Popen close_fds). Every subsequently opened
# file/directory must pass Landlock: read-only runtime or this private scratch.
# fstat is descriptor-only; fstatat/statx are NOT interchangeable safe aliases.
# Landlock guards name creation/removal/rename and writable opens. fd-only
# ftruncate requires a writable descriptor. chmod/chown/xattr/ioctl are absent.
_PRIVATE_FS_SYSCALLS = {
    "read": (0, 63), "write": (1, 64), "close": (3, 57),
    "fstat": (5, 80), "lseek": (8, 62),
    "pread64": (17, 67), "pwrite64": (18, 68),
    "readv": (19, 65), "writev": (20, 66), "getdents64": (217, 61),
    "fsync": (74, 82), "fdatasync": (75, 83), "ftruncate": (77, 46),
    "mkdirat": (258, 34), "unlinkat": (263, 35),
    "renameat": (264, 38), "renameat2": (316, 276), "getcwd": (79, 17),
}


def _fail(libc, operation):
    number = ctypes.get_errno()
    raise IsolationUnavailable(f"secure analysis isolation unavailable: {operation}: {os.strerror(number)}")


def seal_analysis(scratch_dir: str) -> int:
    """Allow only read-only Python/runtime + this call's private scratch.

    Landlock v1 is sufficient for content reads; later write/truncate rights are
    handled when supported. Seccomp permits only the documented runtime/private
    file-I/O syscall allowlist; all other APIs and unknown calls are denied.
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
        number_index = 0
        open_flags = [(2, 24), (257, 32)]  # open arg 1 / openat arg 2
    else:
        architecture = 0xC00000B7
        number_index = 1
        open_flags = [(56, 32)]
    # Load arch, kill a different ABI, then load syscall nr. x32 uses the same
    # audit arch with a high syscall bit; refuse it as well, rather than bypass.
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, architecture), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, 0x00050000 | errno.EACCES)]
    # O_PATH can pin ANY path without a Landlock read check. BPF inspects the
    # scalar open/openat flags directly. Also reject O_RDONLY|O_TRUNC: older
    # Landlock ABIs do not restrict truncation, and a read-only runtime fd must
    # never gain a write effect. Normal scratch w/w+ opens remain permitted.
    # openat2's flags live behind a pointer and are NOT on the allowlist.
    for number, offset in open_flags:
        instructions.extend([(0x15, 0, 8, number), (0x20, 0, 0, offset),
                             (0x45, 0, 1, os.O_PATH), (0x06, 0, 0, 0x00050000 | errno.EACCES),
                             (0x45, 0, 3, os.O_TRUNC), (0x54, 0, 0, os.O_ACCMODE),
                             (0x15, 0, 1, os.O_RDONLY), (0x06, 0, 0, 0x00050000 | errno.EACCES),
                             (0x06, 0, 0, 0x7FFF0000)])
    allowed = {pair[number_index] for table in (_RUNTIME_SYSCALLS, _PRIVATE_FS_SYSCALLS) for pair in table.values()}
    for number in sorted(allowed):
        instructions.extend([(0x15, 0, 1, number), (0x06, 0, 0, 0x7FFF0000)])
    instructions.append((0x06, 0, 0, 0x00050000 | errno.EACCES))
    filters = (Filter * len(instructions))(*(Filter(*entry) for entry in instructions))
    program = Program(len(instructions), filters)
    if libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:  # PR_SET_SECCOMP, SECCOMP_MODE_FILTER
        _fail(libc, "seccomp restriction")
    return int(abi)
