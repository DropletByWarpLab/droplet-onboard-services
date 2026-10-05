"""Capture SMB files without following attacker-controlled symbolic links.

Extractors reopen paths. Passing them a checked share path would leave a
check/open race, so read through a descriptor rooted in the share and extract
from a private snapshot instead. The appliance runs Linux; unsupported
platforms fail closed rather than weakening the no-follow guarantee.
"""

from __future__ import annotations

import mimetypes
import os
import stat
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from extractors.registry import _cap_for_mime


class UnsafeSharedFile(ValueError):
    pass


class OversizedSharedFile(ValueError):
    pass


class SharedFileChanged(ValueError):
    pass


class SharedFileSnapshot(str):
    """Private snapshot path bound to the source file identity it captured."""

    def __new__(cls, path: str, source_identity: tuple[int, int, int, int]):
        value = super().__new__(cls, path)
        value.source_identity = source_identity
        return value


def _file_identity(metadata: os.stat_result) -> tuple[int, int, int, int]:
    return metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns


def open_shared_file(root: str, relative_path: str) -> int:
    """Return a regular-file descriptor, refusing links in every component."""
    parts = relative_path.split("/")
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise UnsafeSharedFile("invalid shared-file path")
    if os.open not in os.supports_dir_fd or not hasattr(os, "O_NOFOLLOW"):
        raise UnsafeSharedFile("secure shared-file opening is unavailable")
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(root, directory_flags)
    try:
        for part in parts[:-1]:
            child = os.open(part, directory_flags, dir_fd=directory)
            os.close(directory)
            directory = child
        # NONBLOCK prevents a named pipe from blocking before fstat can reject
        # it. A share must not make the indexer read devices or special files.
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=directory,
        )
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            os.close(descriptor)
            raise UnsafeSharedFile("shared path is not a regular file")
        return descriptor
    finally:
        os.close(directory)


def shared_file_identity_matches(
    root: str, relative_path: str, expected: tuple[int, int, int, int]
) -> bool:
    """Check that the path still names the captured regular-file version."""
    try:
        descriptor = open_shared_file(root, relative_path)
    except (OSError, UnsafeSharedFile):
        return False
    try:
        return _file_identity(os.fstat(descriptor)) == expected
    finally:
        os.close(descriptor)


@contextmanager
def shared_file_snapshot(root: str, relative_path: str):
    """Yield a bounded private copy of the safely opened file."""
    descriptor = open_shared_file(root, relative_path)
    with os.fdopen(descriptor, "rb") as source:
        before = os.fstat(source.fileno())
        # Use the same MIME ceilings as dispatch, before making a disk copy.
        mime = mimetypes.guess_type(relative_path)[0] or "text/plain"
        if before.st_size > _cap_for_mime(mime):
            raise OversizedSharedFile("shared file exceeds its extraction cap")
        with TemporaryDirectory(prefix="droplet-share-index-") as temporary:
            snapshot = Path(temporary) / relative_path.rsplit("/", 1)[-1]
            remaining = before.st_size
            with snapshot.open("wb") as destination:
                while remaining:
                    block = source.read(min(1024 * 1024, remaining))
                    if not block:
                        raise SharedFileChanged("shared file changed during capture")
                    destination.write(block)
                    remaining -= len(block)
            after = os.fstat(source.fileno())
            if _file_identity(before) != _file_identity(after):
                raise SharedFileChanged("shared file changed during capture")
            identity = _file_identity(before)
            if not shared_file_identity_matches(root, relative_path, identity):
                raise SharedFileChanged("shared file path changed during capture")
            yield SharedFileSnapshot(str(snapshot), identity)
