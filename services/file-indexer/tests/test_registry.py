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
    assert result["text"] == ""
    assert "max_recursion_depth_exceeded" in result["warnings"]


def test_dispatch_existing_callers_without_depth_still_work(tmp_path):
    """Phase 1 callers pass (path, mime) only — must keep working."""
    f = tmp_path / "hello.txt"
    f.write_text("hello world\n")
    result = registry.dispatch(str(f), "text/plain")
    assert result is not None
    assert "hello world" in result["text"]


def test_cap_for_mime_returns_default_for_unknown_mime():
    """Unknown MIMEs fall back to the default 50 MB cap."""
    cap = registry._cap_for_mime("application/x-unknown")
    assert cap == registry.DEFAULT_MAX_BYTES
