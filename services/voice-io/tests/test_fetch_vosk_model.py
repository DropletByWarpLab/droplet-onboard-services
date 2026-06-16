"""WARP-154 review item 5 — supply-chain hardening of the bundled Vosk
model fetch.

The Dockerfile pins a SHA-256 and extracts member-by-member through a
zip-slip guard instead of the stdlib's bare extractall(). These tests
pin both guarantees against a present-but-tampered artifact:

  * a checksum mismatch aborts (non-zero exit), and the model is NOT
    extracted;
  * a zip member with an absolute path or `..` traversal is rejected
    before anything is written;
  * the happy path verifies, extracts, and renames the top-level dir to
    the stable name the detector resolves by default.

These run on any box — no network, no vosk install, just stdlib zip +
the script under test.
"""
from __future__ import annotations

import hashlib
import io
import zipfile

import pytest

from scripts.fetch_vosk_model import (
    is_member_safe,
    main,
    safe_extract,
    sha256_of,
)


def _write_zip(path, members: dict[str, bytes]) -> str:
    """Write a zip with the given {name: bytes} members, return its
    SHA-256 hex digest."""
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read())
    return h.hexdigest()


# ────────────────────────────────────────────────────────────────────
# is_member_safe — the zip-slip predicate
# ────────────────────────────────────────────────────────────────────

class TestIsMemberSafe:
    @pytest.mark.parametrize("name", [
        "vosk-model-small-en-us-0.15/",
        "vosk-model-small-en-us-0.15/am/final.mdl",
        "vosk-model-small-en-us-0.15/conf/model.conf",
        "a/b/c.txt",
    ])
    def test_safe_relative_members_accepted(self, name):
        assert is_member_safe(name) is True

    @pytest.mark.parametrize("name", [
        "/etc/passwd",                       # absolute POSIX
        "../escape.txt",                     # parent traversal
        "model/../../escape.txt",            # traversal mid-path
        "a/../../b",                         # nested traversal
        "..\\windows\\evil",                 # windows-style traversal
        "C:/Windows/System32/evil.dll",      # drive-letter absolute
        "\\\\server\\share\\evil",           # UNC
        "",                                   # empty
        ".",                                  # bare dot
    ])
    def test_unsafe_members_rejected(self, name):
        assert is_member_safe(name) is False


# ────────────────────────────────────────────────────────────────────
# safe_extract — rejects zip-slip before writing
# ────────────────────────────────────────────────────────────────────

class TestSafeExtract:
    def test_extracts_safe_archive(self, tmp_path):
        zip_path = tmp_path / "ok.zip"
        _write_zip(zip_path, {
            "root/file.txt": b"hello",
            "root/sub/deep.bin": b"\x00\x01",
        })
        dest = tmp_path / "out"
        safe_extract(str(zip_path), str(dest))
        assert (dest / "root" / "file.txt").read_bytes() == b"hello"
        assert (dest / "root" / "sub" / "deep.bin").read_bytes() == b"\x00\x01"

    def test_rejects_parent_traversal_member(self, tmp_path):
        zip_path = tmp_path / "evil.zip"
        # Write the malicious member directly so zipfile doesn't normalise it.
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("root/ok.txt", b"fine")
            zf.writestr("../escape.txt", b"pwned")
        dest = tmp_path / "out"
        with pytest.raises(ValueError, match="zip-slip"):
            safe_extract(str(zip_path), str(dest))
        # Nothing escaped: the sibling of dest must not exist.
        assert not (tmp_path / "escape.txt").exists()

    def test_rejects_absolute_member(self, tmp_path):
        zip_path = tmp_path / "abs.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("/abs/evil.txt", b"pwned")
        dest = tmp_path / "out"
        with pytest.raises(ValueError):
            safe_extract(str(zip_path), str(dest))

    def test_no_partial_extraction_when_a_member_is_unsafe(self, tmp_path):
        # The whole archive is validated before any member is written, so a
        # bad member late in the list doesn't leave a half-trusted tree.
        zip_path = tmp_path / "mixed.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("root/good1.txt", b"a")
            zf.writestr("root/good2.txt", b"b")
            zf.writestr("../evil.txt", b"x")
        dest = tmp_path / "out"
        with pytest.raises(ValueError):
            safe_extract(str(zip_path), str(dest))
        assert not (dest / "root" / "good1.txt").exists()


# ────────────────────────────────────────────────────────────────────
# sha256_of
# ────────────────────────────────────────────────────────────────────

class TestSha256:
    def test_matches_hashlib(self, tmp_path):
        p = tmp_path / "blob.bin"
        data = b"droplet" * 1000
        p.write_bytes(data)
        assert sha256_of(str(p)) == hashlib.sha256(data).hexdigest()


# ────────────────────────────────────────────────────────────────────
# main — end-to-end: checksum gate + extract + rename
# ────────────────────────────────────────────────────────────────────

class TestMain:
    def test_happy_path_verifies_extracts_and_renames(self, tmp_path):
        zip_path = tmp_path / "vosk.zip"
        digest = _write_zip(zip_path, {
            "vosk-model-small-en-us-0.15/": b"",
            "vosk-model-small-en-us-0.15/am/final.mdl": b"model-bytes",
            "vosk-model-small-en-us-0.15/conf/model.conf": b"--option",
        })
        dest = tmp_path / "models"
        rc = main([
            "--zip", str(zip_path),
            "--sha256", digest,
            "--dest", str(dest),
            "--expected-root", "vosk-model-small-en-us-0.15",
            "--rename-to", "vosk-model-small-en-us",
        ])
        assert rc == 0
        # Renamed to the stable name the detector resolves by default.
        assert (dest / "vosk-model-small-en-us" / "am" / "final.mdl").read_bytes() == b"model-bytes"
        # Original versioned dir gone (renamed, not copied).
        assert not (dest / "vosk-model-small-en-us-0.15").exists()

    def test_checksum_mismatch_aborts_and_does_not_extract(self, tmp_path):
        zip_path = tmp_path / "vosk.zip"
        _write_zip(zip_path, {
            "vosk-model-small-en-us-0.15/am/final.mdl": b"model-bytes",
        })
        dest = tmp_path / "models"
        rc = main([
            "--zip", str(zip_path),
            "--sha256", "0" * 64,   # deliberately wrong
            "--dest", str(dest),
            "--expected-root", "vosk-model-small-en-us-0.15",
            "--rename-to", "vosk-model-small-en-us",
        ])
        assert rc == 1
        # A tampered artifact must NOT have produced any model bytes.
        assert not (dest / "vosk-model-small-en-us").exists()
        assert not (dest / "vosk-model-small-en-us-0.15").exists()

    def test_zip_slip_member_aborts_via_main(self, tmp_path):
        zip_path = tmp_path / "vosk.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("vosk-model-small-en-us-0.15/am/final.mdl", b"ok")
            zf.writestr("../escape.txt", b"pwned")
        digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
        dest = tmp_path / "models"
        rc = main([
            "--zip", str(zip_path),
            "--sha256", digest,
            "--dest", str(dest),
            "--expected-root", "vosk-model-small-en-us-0.15",
            "--rename-to", "vosk-model-small-en-us",
        ])
        assert rc == 1
        assert not (tmp_path / "escape.txt").exists()

    def test_missing_zip_is_hard_error(self, tmp_path):
        rc = main([
            "--zip", str(tmp_path / "nope.zip"),
            "--sha256", "0" * 64,
            "--dest", str(tmp_path / "models"),
            "--expected-root", "vosk-model-small-en-us-0.15",
            "--rename-to", "vosk-model-small-en-us",
        ])
        assert rc == 1
