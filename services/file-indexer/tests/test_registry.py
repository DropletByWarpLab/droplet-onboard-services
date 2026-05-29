"""Tests for the recursion contract in the extractor registry (WARP-199).

Phase 2 adds:
  - MAX_RECURSION_DEPTH constant.
  - `depth: int = 0` parameter on dispatch().
  - Per-MIME byte-cap dispatcher (`_cap_for_mime`).

These tests live alongside the existing `test_extractors.py` (which covers
the Phase 1 dispatch behavior). Splitting them keeps the contract tests
focused and easy to find.
"""
from __future__ import annotations

import inspect
from pathlib import Path

from extractors import registry


def test_max_recursion_depth_constant_is_two():
    """The recursion contract pins MAX_RECURSION_DEPTH to 2 per spec §7."""
    assert registry.MAX_RECURSION_DEPTH == 2


def test_dispatch_default_depth_is_zero():
    """Backwards compat: callers that don't pass depth still work (defaults to 0)."""
    sig = inspect.signature(registry.dispatch)
    assert "depth" in sig.parameters
    assert sig.parameters["depth"].default == 0


def test_dispatch_returns_warning_when_recursion_too_deep(tmp_path):
    """At depth > MAX_RECURSION_DEPTH, dispatch returns a warning ExtractedDoc, never raises."""
    # File doesn't need to exist or be valid — depth check happens before stat().
    fake = tmp_path / "nope.txt"
    result = registry.dispatch(
        str(fake), "text/plain", depth=registry.MAX_RECURSION_DEPTH + 1
    )
    assert result is not None
    # WARP-287: depth-cap returns an empty spans list, not the old text="".
    assert result["spans"] == []
    assert "max_recursion_depth_exceeded" in result["warnings"]


def test_dispatch_existing_callers_without_depth_still_work(tmp_path):
    """Phase 1 callers pass (path, mime) only — must keep working."""
    f = tmp_path / "hello.txt"
    f.write_text("hello world\n")
    result = registry.dispatch(str(f), "text/plain")
    assert result is not None
    # WARP-287: spans replace the old text blob.
    full = " ".join(s.text for s in result["spans"])
    assert "hello world" in full


def test_cap_for_mime_returns_default_for_unknown_mime():
    """Unknown MIMEs fall back to the default 50 MB cap."""
    cap = registry._cap_for_mime("application/x-unknown")
    assert cap == registry.DEFAULT_MAX_BYTES


def test_email_mime_dispatches_via_route():
    """message/rfc822 routes to the email extractor (WARP-199)."""
    fn = registry._route("message/rfc822")
    assert fn is not None
    # The function ultimately resolves to extractors.email.extract.
    from extractors import email as email_ext

    assert fn is email_ext.extract


def test_email_cap_is_100mb():
    """Email envelope cap is 100 MB per spec §4.3."""
    assert registry._cap_for_mime("message/rfc822") == 100 * 1024 * 1024
    assert registry._cap_for_mime("application/vnd.ms-outlook") == 100 * 1024 * 1024


def test_call_handler_forwards_depth_to_recursive_handler():
    """_call_handler forwards depth only when the handler signature accepts it."""
    captured = {}

    def recursive_handler(path, mime, depth=0):
        captured["depth"] = depth
        captured["mime"] = mime
        return {"text": "ok", "metadata": {}, "warnings": []}

    def legacy_handler(path):
        captured["depth"] = "not-passed"
        return {"text": "ok", "metadata": {}, "warnings": []}

    registry._call_handler(recursive_handler, "/tmp/x", "text/plain", depth=1)
    assert captured["depth"] == 1
    assert captured["mime"] == "text/plain"

    registry._call_handler(legacy_handler, "/tmp/x", "text/plain", depth=1)
    assert captured["depth"] == "not-passed"


def test_dispatch_routes_eml_to_email_extractor(tmp_path):
    """End-to-end: dispatch on a .eml file returns the email extractor's output."""
    eml_path = tmp_path / "msg.eml"
    eml_path.write_text(
        "From: a@b.com\nTo: c@d.com\nSubject: hi\n\nbody text\n",
        encoding="utf-8",
    )
    result = registry.dispatch(str(eml_path), "message/rfc822")
    assert result is not None
    # WARP-287: email extractor emits one span per MIME text part. The
    # "Subject:" header is folded into the first part's text per the
    # email extractor's contract (see test_extractor_email_anchors.py).
    full = " ".join(s.text for s in result["spans"])
    assert "Subject: hi" in full
    assert "body text" in full


# ── archive registration (WARP-200 Task 4.4) ─────────────────────────


def test_archive_cap_is_200mb():
    """WARP-200 archive cap (200 MB) is what `_cap_for_mime` returns."""
    from extractors import registry

    assert registry._cap_for_mime("application/zip") == 200 * 1024 * 1024
    assert registry._cap_for_mime("application/x-tar") == 200 * 1024 * 1024
    assert registry._cap_for_mime("application/gzip") == 200 * 1024 * 1024


def test_archive_mime_dispatches_through_registry(tmp_path):
    """End-to-end: dispatch() picks the archive handler for application/zip."""
    from pathlib import Path as _Path

    from extractors import registry

    fixtures = _Path(__file__).parent / "fixtures"
    result = registry.dispatch(str(fixtures / "simple.zip"), "application/zip")
    assert result is not None
    # WARP-287: each archive member surfaces as its own span with an
    # ArchiveMemberAnchor (separator banners no longer exist; each
    # span's anchor identifies the member).
    full = " ".join(s.text for s in result["spans"])
    assert "one hundred thousand" in full
    anchors = [s.anchor for s in result["spans"]]
    assert any(getattr(a, "kind", None) == "archive-member" and getattr(a, "member", None) == "note.txt" for a in anchors)


def test_archive_handler_resolves_via_route():
    """`_route()` returns archive.extract for every archive MIME (WARP-199 unified contract)."""
    from extractors import archive, registry

    assert registry._route("application/zip") is archive.extract
    assert registry._route("application/x-tar") is archive.extract
    assert registry._route("application/gzip") is archive.extract
    # Non-archive MIME shouldn't resolve to archive.extract.
    assert registry._route("text/plain") is not archive.extract


# ── video registration (WARP-198 Task 2.5) ───────────────────────────


def test_video_mime_dispatches():
    """`_route()` returns video.extract for every video MIME (WARP-198)."""
    from extractors import registry, video

    for mime in video.SUPPORTED_MIMES:
        assert registry._route(mime) is video.extract, mime


def test_video_cap_is_2gb():
    """Video envelope cap is 2 GB per spec §4.2 / VIDEO_MAX_BYTES default."""
    from extractors import registry, video

    expected = 2 * 1024 * 1024 * 1024
    for mime in video.SUPPORTED_MIMES:
        assert registry._cap_for_mime(mime) == expected, mime
