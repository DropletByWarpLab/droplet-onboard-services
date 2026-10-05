"""Descriptor capture rejects link escapes before an extractor sees bytes."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import shared_file


SECURE_OPEN_SUPPORTED = os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW")


def test_secure_open_refuses_path_traversal():
    for path in ("../secret.txt", "a/../../secret.txt", "/etc/passwd", "a//b", "."):
        with pytest.raises(shared_file.UnsafeSharedFile):
            shared_file.open_shared_file("/share", path)


def test_unsupported_secure_open_fails_closed(monkeypatch):
    monkeypatch.setattr(os, "supports_dir_fd", set())
    with pytest.raises(shared_file.UnsafeSharedFile, match="unavailable"):
        shared_file.open_shared_file("/share", "note.txt")


def test_each_directory_and_file_open_uses_no_follow(monkeypatch):
    opened = MagicMock(side_effect=[10, 11, 12])
    closed = MagicMock()
    monkeypatch.setattr(os, "open", opened)
    monkeypatch.setattr(os, "supports_dir_fd", {opened})
    monkeypatch.setattr(os, "O_NOFOLLOW", 0x100000, raising=False)
    monkeypatch.setattr(os, "O_DIRECTORY", 0x200000, raising=False)
    monkeypatch.setattr(os, "O_NONBLOCK", 0x400000, raising=False)
    monkeypatch.setattr(os, "close", closed)
    monkeypatch.setattr(os, "fstat", lambda fd: SimpleNamespace(st_mode=stat.S_IFREG))
    assert shared_file.open_shared_file("/share", "Docs/note.txt") == 12
    assert all(call.args[1] & os.O_NOFOLLOW for call in opened.call_args_list)
    assert opened.call_args_list[1].kwargs == {"dir_fd": 10}
    assert opened.call_args_list[2].kwargs == {"dir_fd": 11}
    assert sorted(call.args[0] for call in closed.call_args_list) == [10, 11]


@pytest.mark.skipif(not SECURE_OPEN_SUPPORTED, reason="appliance no-follow API requires POSIX")
def test_snapshot_extracts_private_regular_copy_and_removes_it(tmp_path, monkeypatch):
    (tmp_path / "note.txt").write_text("Shared content")
    monkeypatch.setattr(shared_file, "_cap_for_mime", lambda mime: 1000)
    with shared_file.shared_file_snapshot(str(tmp_path), "note.txt") as snapshot:
        assert Path(snapshot).read_text() == "Shared content"
        assert Path(snapshot).parent != tmp_path
        assert Path(snapshot).name == "note.txt"
    assert not Path(snapshot).exists()


@pytest.mark.skipif(not SECURE_OPEN_SUPPORTED, reason="appliance no-follow API requires POSIX")
def test_snapshot_rejects_path_replacement_even_when_open_descriptor_is_unchanged(
    tmp_path, monkeypatch
):
    source = tmp_path / "note.txt"
    replacement = tmp_path / "replacement.txt"
    source.write_text("Captured bytes belong to the original inode.")
    replacement.write_text("The path now names a different inode.")
    real_fstat = os.fstat
    calls = 0

    def replace_after_capture(descriptor):
        nonlocal calls
        calls += 1
        # open_shared_file and the pre-copy check are calls one and two;
        # replace the directory entry immediately before the post-copy fstat.
        if calls == 3:
            os.replace(replacement, source)
        return real_fstat(descriptor)

    monkeypatch.setattr(os, "fstat", replace_after_capture)
    with pytest.raises(shared_file.SharedFileChanged, match="path changed"):
        with shared_file.shared_file_snapshot(str(tmp_path), "note.txt"):
            pytest.fail("a replaced pathname reached extraction")


@pytest.mark.skipif(not SECURE_OPEN_SUPPORTED, reason="appliance no-follow API requires POSIX")
@pytest.mark.parametrize("directory_link", [False, True])
def test_snapshot_refuses_file_and_directory_symlink_escapes(tmp_path, directory_link):
    root = tmp_path / "share"
    root.mkdir()
    private = tmp_path / "private"
    private.mkdir()
    (private / "secret.txt").write_text("Private user data must not enter the shared corpus.")
    if directory_link:
        (root / "link").symlink_to(private, target_is_directory=True)
        relative = "link/secret.txt"
    else:
        (root / "link.txt").symlink_to(private / "secret.txt")
        relative = "link.txt"
    with pytest.raises(OSError):
        with shared_file.shared_file_snapshot(str(root), relative):
            pytest.fail("link contents reached extraction")


@pytest.mark.skipif(not SECURE_OPEN_SUPPORTED, reason="appliance no-follow API requires POSIX")
def test_snapshot_checks_cap_before_copy(tmp_path, monkeypatch):
    (tmp_path / "note.txt").write_text("File exceeds the extraction ceiling")
    monkeypatch.setattr(shared_file, "_cap_for_mime", lambda mime: 1)
    with pytest.raises(shared_file.OversizedSharedFile):
        with shared_file.shared_file_snapshot(str(tmp_path), "note.txt"):
            pytest.fail("oversized contents copied")
