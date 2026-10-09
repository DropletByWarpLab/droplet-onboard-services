"""Bounded local archive import into the first attributed workspace commit."""
from __future__ import annotations

import os
import stat
import struct
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path
from typing import BinaryIO

import gitstore
from gitstore import StoreError

MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_ENTRIES = 50_000
IMPORT_TIMEOUT_S = 120


class _BoundedTarInfo(tarfile.TarInfo):
    """Bound metadata before tarfile reads a PAX/long-name body into RAM."""

    def _proc_pax(self, archive):
        if self.size > 65_536:
            raise StoreError(413, "archive metadata exceeds import limits")
        return super()._proc_pax(archive)

    def _proc_gnulong(self, archive):
        if self.size > 4096:
            raise StoreError(413, "archive name exceeds import limits")
        return super()._proc_gnulong(archive)

    def _proc_sparse(self, archive):
        raise StoreError(400, "archive sparse files are refused")


def _bounded_zip_index(source: BinaryIO) -> None:
    """Count central records before ZipFile allocates an object for each one."""
    source.seek(0, os.SEEK_END)
    length = source.tell()
    if length > MAX_ARCHIVE_BYTES:
        raise StoreError(413, "archive exceeds 256 MiB")
    source.seek(max(0, length - 65_557))
    tail = source.read(65_557)
    offset = tail.rfind(b"PK\x05\x06")
    if offset < 0 or len(tail) - offset < 22:
        raise StoreError(400, "archive has no zip directory")
    _, disk, start_disk, on_disk, count, size, start, comment = struct.unpack("<4s4H2LH", tail[offset:offset + 22])
    if disk or start_disk or on_disk != count or count > MAX_ENTRIES or size > 64 * 1024 * 1024:
        raise StoreError(413, "archive zip directory exceeds import limits")
    end_position = length - len(tail) + offset
    # ZipFile consults a ZIP64 locator immediately before the selected EOCD,
    # even when that footer is inside another EOCD's comment. Its 64-bit fields
    # override these classic bounds. Our import caps do not require ZIP64.
    if end_position >= 20:
        source.seek(end_position - 20)
        if source.read(4) == b"PK\x06\x07":
            raise StoreError(413, "archive ZIP64 directories are not supported")
    # ZipFile derives its actual directory from the EOCD's physical position
    # and size, adjusting offsets for prepended data. Count that SAME directory
    # before allocation, not a caller-selected prefix at the raw start offset.
    directory_start = end_position - size
    if offset + 22 + comment != len(tail) or directory_start < 0 or start > directory_start:
        raise StoreError(400, "archive zip directory is malformed")
    source.seek(directory_start)
    remaining = size
    records = 0
    while remaining:
        header = source.read(46)
        if len(header) != 46 or header[:4] != b"PK\x01\x02":
            raise StoreError(400, "archive zip directory is malformed")
        name, extra, note = struct.unpack("<3H", header[28:34])
        span = 46 + name + extra + note
        records += 1
        if records > MAX_ENTRIES or name > 4096:
            raise StoreError(413, "archive zip directory exceeds import limits")
        if span > remaining:
            raise StoreError(400, "archive zip directory is malformed")
        source.seek(span - 46, os.SEEK_CUR)
        remaining -= span
    if records != count:
        raise StoreError(400, "archive zip directory count is inconsistent")
    source.seek(0)


def _relative(name: str) -> Path | None:
    if not name or len(name) > 1024 or "\\" in name or ":" in name or name.startswith("/"):
        raise StoreError(400, "archive contains an unsafe path")
    if any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise StoreError(400, "archive contains an unsafe path")
    while name.startswith("./"):
        name = name[2:]
    if name in {"", "."}:
        return None
    parts = name.rstrip("/").split("/")
    if any(p in {"", ".", ".."} or p.casefold() in {".git", ".workspace"} for p in parts):
        raise StoreError(400, "archive cannot contain traversal, .git or .workspace paths")
    devices = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
    if any(p.endswith((".", " ")) or p.split(".", 1)[0].casefold() in devices for p in parts):
        raise StoreError(400, "archive contains a reserved filesystem name")
    return Path(*parts)


def unpack(source: BinaryIO, format: str, root: Path) -> None:
    deadline = time.monotonic() + IMPORT_TIMEOUT_S
    seen: set[str] = set()
    entries = total = 0

    def put(name: str, size: int, directory: bool, mode: int, opener) -> None:
        nonlocal entries, total
        entries += 1
        if entries > MAX_ENTRIES or size < 0 or total + size > MAX_UNPACKED_BYTES:
            raise StoreError(413, "archive exceeds 50,000 entries or 1 GiB unpacked")
        total += size
        if time.monotonic() >= deadline:
            raise StoreError(504, "archive unpack timed out")
        rel = _relative(name)
        if rel is None:
            return
        key = rel.as_posix().casefold()
        if key in seen:
            raise StoreError(400, "archive contains duplicate paths")
        seen.add(key)
        target = root / rel
        if not target.resolve().is_relative_to(root.resolve()):
            raise StoreError(400, "archive path escapes the workspace")
        if directory:
            target.mkdir(parents=True, exist_ok=True)
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        with opener() as inp, target.open("xb") as out:
            while True:
                if time.monotonic() >= deadline:
                    raise StoreError(504, "archive unpack timed out")
                chunk = inp.read(65_536)
                if not chunk:
                    break
                written += len(chunk)
                if written > size:
                    raise StoreError(413, "archive file exceeds its declared size")
                out.write(chunk)
        if written != size:
            raise StoreError(400, "archive file is truncated")
        target.chmod(0o755 if rel.parts[0] == "bin" and mode & 0o111 else 0o644)

    try:
        if format == "zip":
            _bounded_zip_index(source)
            with zipfile.ZipFile(source) as archive:
                if len(archive.infolist()) > MAX_ENTRIES:
                    raise StoreError(413, "archive exceeds 50,000 entries")
                for item in archive.infolist():
                    mode = item.external_attr >> 16
                    if item.flag_bits & 1 or stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}:
                        raise StoreError(400, "archive links, devices and encrypted files are refused")
                    # ZipInfo normalizes backslashes on Windows and truncates
                    # NULs. Validate the actual on-disk name before that repair.
                    put(item.orig_filename, item.file_size, item.is_dir(), mode, lambda item=item: archive.open(item))
        elif format == "tar.gz":
            with tarfile.open(fileobj=source, mode="r|gz", tarinfo=_BoundedTarInfo) as archive:
                for item in archive:
                    if not item.isreg() and not item.isdir():
                        raise StoreError(400, "archive links and special files are refused")
                    put(item.name, item.size, item.isdir(), item.mode, lambda item=item: archive.extractfile(item))
        else:
            raise StoreError(400, "archive format must be zip or tar.gz")
        if entries == 0:
            raise StoreError(400, "archive is empty")
    except (OSError, EOFError, RuntimeError, ValueError, tarfile.TarError, zipfile.BadZipFile) as exc:
        raise StoreError(400, "archive is malformed or contains conflicting paths") from exc


def import_workspace(workspace_id: str, format: str, source: BinaryIO, author: gitstore.Author) -> dict:
    gitstore.check_id(workspace_id)
    if workspace_id == gitstore.TEMPLATES_REPO:
        raise StoreError(400, "that workspace id is reserved")
    gitstore.ensure_dirs()
    bare, work = gitstore.bare_path(workspace_id), gitstore.work_path(workspace_id)
    if bare.exists() or work.exists():
        raise StoreError(409, "workspace already exists")
    with tempfile.TemporaryDirectory(prefix=".archive-import-", dir=gitstore.WORK_DIR) as temp:
        staging = Path(temp) / "tree"
        staging.mkdir()
        unpack(source, format, staging)
        with gitstore.WORKSPACE_CREATE_LOCK:
            if bare.exists() or work.exists():
                raise StoreError(409, "workspace already exists")
            try:
                bare.mkdir()
            except FileExistsError as exc:
                raise StoreError(409, "workspace already exists") from exc
            owns_work = False
            try:
                gitstore.must(gitstore.git(["init", "--bare", "-q", "-b", gitstore.WORK_BRANCH, str(bare)], gitstore.REPOS_DIR), "init repo")
                # Claim the checkout too: POSIX rename could otherwise replace
                # a competing creator's empty directory and make it ours.
                try:
                    work.mkdir()
                except FileExistsError as exc:
                    raise StoreError(409, "workspace already exists") from exc
                owns_work = True
                for child in staging.iterdir():
                    os.rename(child, work / child.name)
                gitstore.must(gitstore.git(["init", "-q", "-b", gitstore.WORK_BRANCH], work), "init checkout")
                gitstore.must(gitstore.git(["remote", "add", "origin", str(bare)], work), "add origin")
                # Offline dependencies and built UI survive imported ignore rules.
                gitstore.must(gitstore.git(["add", "--force", "--all"], work), "stage imported source")
                gitstore.must(gitstore.git(["commit", "-q", "--allow-empty", "-m", "Import application source"], work, author=author), "initial import commit")
                gitstore.must(gitstore.git(["push", "-q", "-u", "origin", gitstore.WORK_BRANCH], work), "push import")
            except Exception:
                if owns_work:
                    gitstore._rmtree(work)
                gitstore._rmtree(bare)
                raise
    return gitstore.status(workspace_id)
