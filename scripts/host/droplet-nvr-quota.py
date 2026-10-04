#!/usr/bin/env python3
"""droplet-nvr-quota — set / read an ext4 PROJECT quota through quotactl(2).

WARP-3514 (ADR-070): camera recordings get an auto-sized, size-capped slice of
an encrypted bay drive. The slice is an ext4 *project quota* on the
`<mount>/nvr` directory (`chattr +P -p <projid>`), NOT a repartition. This
helper is the only code that talks to the kernel's quota interface; the writer
(droplet-set-nvr-media.sh --apply / --resize) shells it. The `setquota`/`quota`
packages are not installed on the box (and are never hand-installed), so the
syscall is made directly through ctypes — stdlib only.

Usage (root; the kernel requires CAP_SYS_ADMIN for Q_SETQUOTA):

  droplet-nvr-quota.py set <device-or-mountpoint> <projid> <hard_bytes>
  droplet-nvr-quota.py get <device-or-mountpoint> <projid>

`set` writes the BLOCK hard limit only: hard = ceil(bytes / 1024) KiB (the
kernel counts 1 KiB blocks, so rounding up never leaves the slice smaller than
promised), soft = 0, `dqb_valid = QIF_BLIMITS` so no other field is touched.
It is silent on success.

`get` prints one JSON line `{"hardBytes":N,"softBytes":N,"usedBytes":N}` —
limits converted from KiB blocks to bytes, `usedBytes` is the kernel's
`dqb_curspace` (already bytes).

The first argument may be a block device (`/dev/mapper/droplet-bay-…`) or the
mountpoint of one; a mountpoint is resolved to its source device from
/proc/self/mountinfo (the kernel's quotactl wants the device, not the path).

Exit codes: 0 ok, 1 runtime failure (message on stderr, never a traceback),
2 usage error. ENOSYS / ENOTSUP / EOPNOTSUPP / ESRCH — the kernel or the
filesystem has no (project) quota — all report the stable message
"project quota not enabled on this filesystem".

libc is loaded LAZILY inside the thin `_quotactl()` wrapper so the module
imports on hosts without it (a Windows dev host) and the unit tests replace the
wrapper (this dev host's WSL2 kernel has no CONFIG_QUOTA — the tests pin every
byte the syscall would receive instead).
"""

from __future__ import annotations

import ctypes
import ctypes.util
import errno
import json
import os
import re
import stat
import struct
import sys

# --- Kernel ABI (include/uapi/linux/quota.h) --------------------------------
SUBCMDSHIFT = 8
SUBCMDMASK = 0x00FF
Q_GETQUOTA = 0x800007
Q_SETQUOTA = 0x800008
PRJQUOTA = 2
QIF_BLIMITS = 1

# struct if_dqblk {
#   __u64 dqb_bhardlimit, dqb_bsoftlimit, dqb_curspace,
#         dqb_ihardlimit, dqb_isoftlimit, dqb_curinodes,
#         dqb_btime, dqb_itime;
#   __u32 dqb_valid;
# };
# Eight u64 + one u32, which the C compiler pads to a multiple of 8: 72 bytes.
# "=" = native byte order and NO implicit alignment, so the pad is explicit.
DQBLK = struct.Struct("=8QI4x")

PROG = "droplet-nvr-quota"
USAGE = (
    "usage: droplet-nvr-quota.py set <device-or-mountpoint> <projid> <hard_bytes>\n"
    "       droplet-nvr-quota.py get <device-or-mountpoint> <projid>"
)

# Where mountpoint -> source device is resolved. Replaced by the tests.
MOUNTINFO = "/proc/self/mountinfo"

MAX_PROJID = 0xFFFFFFFE            # (u32)-1 is reserved; 0 means "no project"
MAX_BYTES = 2 ** 62

# errnos that mean "this kernel/filesystem has no (project) quota to talk to".
_NOT_ENABLED = frozenset(
    code for code in (
        errno.ENOSYS,
        errno.ESRCH,
        getattr(errno, "ENOTSUP", None),
        getattr(errno, "EOPNOTSUPP", None),
    ) if code is not None
)


class UsageError(Exception):
    """Bad command line (exit 2)."""


class QuotaError(Exception):
    """A runtime failure with a human message (exit 1)."""


def qcmd(cmd: int, qtype: int) -> int:
    """The kernel's QCMD(): sub-command in the high bits, quota type in the low byte."""
    return (cmd << SUBCMDSHIFT) | (qtype & SUBCMDMASK)


# --- libc (lazy) ------------------------------------------------------------
_LIBC = None


def _libc_quotactl():
    global _LIBC
    if _LIBC is None:
        # find_library may return None (musl); CDLL(None) is the process's own
        # symbol table, which carries quotactl on a glibc/musl Linux.
        lib = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        fn = lib.quotactl
        fn.argtypes = [ctypes.c_uint, ctypes.c_char_p, ctypes.c_uint, ctypes.c_void_p]
        fn.restype = ctypes.c_int
        _LIBC = lib
    return _LIBC.quotactl


def _quotactl(cmd: int, special: str, qid: int, buf: bytearray) -> None:
    """quotactl(2). The ONLY place that touches libc; raises OSError on failure.

    `buf` is the if_dqblk the call reads (Q_SETQUOTA) or fills (Q_GETQUOTA).
    """
    if not sys.platform.startswith("linux"):
        raise OSError(errno.ENOSYS, "quotactl(2) is only available on Linux")
    fn = _libc_quotactl()
    view = (ctypes.c_char * len(buf)).from_buffer(buf)
    if fn(cmd, os.fsencode(special), qid, ctypes.addressof(view)) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


# --- device / mountpoint ----------------------------------------------------
def _is_block_device(path: str) -> bool:
    try:
        return stat.S_ISBLK(os.stat(path).st_mode)
    except OSError:
        return False


def _unescape(field: str) -> str:
    """mountinfo escapes space, tab, newline and backslash as \\NNN (octal)."""
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), field)


def _mountinfo_source(mountpoint: str) -> str | None:
    """Source device of the (topmost) mount at exactly `mountpoint`, else None.

    A line is `id parent maj:min root mountpoint opts [optional...] - fstype
    source super-opts`; a later line at the same mountpoint covers an earlier
    one, so the LAST match wins.
    """
    best = None
    with open(MOUNTINFO, "r", encoding="utf-8", errors="surrogateescape") as fh:
        for line in fh:
            left, sep, right = line.rstrip("\n").partition(" - ")
            if not sep:
                continue
            head = left.split(" ")
            tail = right.split(" ")
            if len(head) < 6 or len(tail) < 2:
                continue
            if _unescape(head[4]) == mountpoint:
                best = _unescape(tail[1])
    return best


def resolve_device(arg: str) -> str:
    """A block device is used as given; a mountpoint becomes its source device."""
    if _is_block_device(arg):
        return arg
    want = re.sub(r"/+", "/", arg)
    if len(want) > 1:
        want = want.rstrip("/")
    try:
        source = _mountinfo_source(want)
    except OSError as exc:
        raise QuotaError("cannot read the mount table: %s" % (exc.strerror or exc))
    if source is None:
        raise QuotaError("the given path is neither a block device nor a mountpoint")
    if not source.startswith("/"):
        raise QuotaError("the mount is not backed by a block device")
    return source


# --- commands ---------------------------------------------------------------
def _parse_uint(text: str, what: str, lo: int, hi: int) -> int:
    if not re.fullmatch(r"[0-9]{1,20}", text):
        raise UsageError("%s must be a positive integer" % what)
    value = int(text)
    if not lo <= value <= hi:
        raise UsageError("%s out of range" % what)
    return value


def _parse(argv: list[str]):
    if not argv:
        raise UsageError("a command is required")
    cmd = argv[0]
    if cmd == "set":
        if len(argv) != 4:
            raise UsageError("set takes <device-or-mountpoint> <projid> <hard_bytes>")
        return (cmd, argv[1],
                _parse_uint(argv[2], "projid", 1, MAX_PROJID),
                _parse_uint(argv[3], "hard_bytes", 1, MAX_BYTES))
    if cmd == "get":
        if len(argv) != 3:
            raise UsageError("get takes <device-or-mountpoint> <projid>")
        return (cmd, argv[1], _parse_uint(argv[2], "projid", 1, MAX_PROJID), None)
    raise UsageError("unknown command %r" % cmd)


def _do_set(device: str, projid: int, nbytes: int) -> None:
    hard_kib = (nbytes + 1023) // 1024
    buf = bytearray(DQBLK.size)
    # hard, soft, curspace, ihard, isoft, curinodes, btime, itime, valid
    DQBLK.pack_into(buf, 0, hard_kib, 0, 0, 0, 0, 0, 0, 0, QIF_BLIMITS)
    _quotactl(qcmd(Q_SETQUOTA, PRJQUOTA), device, projid, buf)


def _do_get(device: str, projid: int) -> dict:
    buf = bytearray(DQBLK.size)
    _quotactl(qcmd(Q_GETQUOTA, PRJQUOTA), device, projid, buf)
    hard, soft, cur, _ih, _is, _ic, _bt, _it, _valid = DQBLK.unpack(bytes(buf))
    return {"hardBytes": hard * 1024, "softBytes": soft * 1024, "usedBytes": cur}


def _describe(exc: OSError) -> str:
    if exc.errno in _NOT_ENABLED:
        return "project quota not enabled on this filesystem"
    return exc.strerror or os.strerror(exc.errno or 0) or str(exc)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        cmd, target, projid, nbytes = _parse(args)
    except UsageError as exc:
        sys.stderr.write("%s: %s\n%s\n" % (PROG, exc, USAGE))
        return 2
    try:
        device = resolve_device(target)
        if cmd == "set":
            _do_set(device, projid, nbytes)
        else:
            sys.stdout.write(json.dumps(_do_get(device, projid), separators=(",", ":")) + "\n")
    except QuotaError as exc:
        sys.stderr.write("%s: %s\n" % (PROG, exc))
        return 1
    except OSError as exc:
        sys.stderr.write("%s: %s\n" % (PROG, _describe(exc)))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
