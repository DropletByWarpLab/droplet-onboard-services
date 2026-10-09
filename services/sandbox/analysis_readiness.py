"""Read-only kernel prerequisite query, never a successful-analysis assertion."""
import ctypes
import platform
import sys


def kernel_eligible() -> bool:
    if not sys.platform.startswith("linux") or platform.machine().lower() not in ("x86_64", "amd64", "aarch64", "arm64"):
        return False
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.syscall.restype = ctypes.c_long
        # LANDLOCK_CREATE_RULESET_VERSION = 1; query creates no ruleset.
        # NR_landlock_create_ruleset is 444 on both supported architectures.
        landlock_abi = libc.syscall(444, 0, 0, 1)
        # PR_GET_SECCOMP = 21: reads the mode; never installs a filter.
        return landlock_abi >= 1 and libc.prctl(21, 0, 0, 0, 0) >= 0
    except (AttributeError, OSError):
        return False
