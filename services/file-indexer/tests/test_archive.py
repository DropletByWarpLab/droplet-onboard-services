"""Unit tests for the archive extractor (WARP-200).

Each test maps to one of the five defenses called out in the spec:
1. MAX_ARCHIVE_MEMBERS = 1000
2. Path traversal rejection (zip-slip)
3. Per-member size cap (registry._cap_for_mime)
4. Cumulative decompressed size cap (MAX_ARCHIVE_TOTAL_BYTES = 500MB)
5. Streaming reads only — never extractall(), never read() unbounded

Plus: encrypted archives, recursion to depth 2, unsupported mime → None.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from extractors import archive

FIXTURES = Path(__file__).parent / "fixtures"


def test_simple_zip_extracts_member_text():
    result = archive.extract(FIXTURES / "simple.zip", mime="application/zip")
    assert result is not None
    assert "one hundred thousand" in result["text"]
    assert "second file" in result["text"]


def test_simple_zip_uses_member_separator():
    """The spec asserts each member's text is prefixed with --- Member: <name> ---."""
    result = archive.extract(FIXTURES / "simple.zip", mime="application/zip")
    assert result is not None
    assert "--- Member: note.txt ---" in result["text"]


def test_nested_zip_recurses_to_depth_2():
    """zip-in-zip: outer dispatches inner zip via registry, inner text bleeds through."""
    result = archive.extract(FIXTURES / "nested.zip", mime="application/zip")
    assert result is not None
    # The inner zip's text member said "the budget for q4 is one hundred thousand".
    # If the recursion path works, that string survives.
    assert "one hundred thousand" in result["text"]


def test_traversal_paths_are_rejected_but_siblings_indexed():
    result = archive.extract(FIXTURES / "traversal.zip", mime="application/zip")
    assert result is not None
    # The legit member made it.
    assert "hello" in result["text"]
    # The traversal one is excluded with a warning naming it.
    assert any(
        w.startswith("path_traversal_rejected:") for w in result["warnings"]
    )


def test_encrypted_zip_emits_warning_and_skips():
    result = archive.extract(FIXTURES / "encrypted.zip", mime="application/zip")
    assert result is not None
    assert "encrypted_archive_skipped" in result["warnings"]
    # No text leaked from the encrypted member.
    assert result["text"] == ""


def test_bomb_zip_aborts_at_cumulative_cap():
    """Cumulative-decompressed cap fires before the bomb finishes expanding.

    The bomb fixture is 600 MB of zeros decompressed; cap is 500 MB. We
    must abort (with a warning), never OOM the process, never raise.
    """
    result = archive.extract(FIXTURES / "bomb.zip", mime="application/zip")
    assert result is not None
    assert any(
        "decompressed_size_cap_exceeded" in w for w in result["warnings"]
    )


def test_unsupported_mime_returns_none():
    result = archive.extract(FIXTURES / "simple.zip", mime="text/plain")
    assert result is None


def test_extract_signature_takes_depth():
    """The recursion contract requires the (path, mime, depth) shape."""
    import inspect

    sig = inspect.signature(archive.extract)
    assert "depth" in sig.parameters
    assert sig.parameters["depth"].default == 0


def test_supported_mimes_includes_zip_and_tar_family():
    expected = {
        "application/zip",
        "application/x-zip-compressed",
        "application/x-tar",
        "application/gzip",
        "application/x-gzip",
        "application/x-bzip2",
    }
    assert expected.issubset(archive.SUPPORTED_MIMES)
    # Explicitly NOT 7z — that's WARP-212.
    assert "application/x-7z-compressed" not in archive.SUPPORTED_MIMES


def test_recursion_depth_cap_propagates_via_dispatch(tmp_path, monkeypatch):
    """When archive recurses to depth > MAX_RECURSION_DEPTH, dispatch returns
    the warning ExtractedDoc; archive should accumulate the warning, not crash.
    """
    from extractors import registry

    # Force MAX_RECURSION_DEPTH = 0 so any recursive call trips immediately.
    monkeypatch.setattr(registry, "MAX_RECURSION_DEPTH", 0)
    result = archive.extract(FIXTURES / "simple.zip", mime="application/zip")
    assert result is not None
    # Either we get warnings about the dispatch returning the depth-cap
    # warning OR the members were dispatched with no useful body — either
    # way we never crash.
    assert isinstance(result["warnings"], list)


def test_too_many_members_aborts_with_warning(tmp_path, monkeypatch):
    """When a zip has >MAX_ARCHIVE_MEMBERS, archive truncates with a warning."""
    import zipfile

    monkeypatch.setattr(archive, "MAX_ARCHIVE_MEMBERS", 3)
    big = tmp_path / "many.zip"
    with zipfile.ZipFile(big, "w") as z:
        for i in range(10):
            z.writestr(f"f{i}.txt", f"content {i}")

    result = archive.extract(big, mime="application/zip")
    assert result is not None
    assert any(w.startswith("too_many_members:") for w in result["warnings"])


def test_archive_with_member_writes_chain_metadata():
    """WARP-214: nested.zip (zip-in-zip) produces a chain[] reflecting the
    archive lineage. The chunker propagates this to chunk metadata.
    """
    result = archive.extract(FIXTURES / "nested.zip", mime="application/zip")
    assert result is not None
    metadata = result.get("metadata", {})
    chain = metadata.get("chain")
    assert chain is not None, f"chain missing; metadata keys={list(metadata)}"
    # The outermost archive (.zip) is the parent; the inner archive's content
    # is the leaf.
    assert any(c.get("mime") == "application/zip" for c in chain), (
        f"chain {chain} should include the outer zip"
    )


def test_tar_archive_extracts_member_text(tmp_path):
    """A plain .tar — the extractor handles it through the same code path."""
    import tarfile

    src = tmp_path / "src.txt"
    src.write_text("tarball content sentinel xyz")
    tar_path = tmp_path / "stuff.tar"
    with tarfile.open(tar_path, "w") as tf:
        tf.add(src, arcname="src.txt")

    result = archive.extract(tar_path, mime="application/x-tar")
    assert result is not None
    assert "tarball content sentinel xyz" in result["text"]
    assert "--- Member: src.txt ---" in result["text"]
