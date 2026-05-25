"""Unit tests for the chunker helpers (WARP-435 QA follow-up).

Covers ``section_path_for_offset`` shape + lookup semantics. The PDF
extractor regression that triggered QA fail boiled down to a shape
mismatch this helper is expected to consume — pinning the contract here
keeps the next extractor honest.
"""
from __future__ import annotations

import pytest

from chunker import section_path_for_offset


def test_section_path_empty_list_returns_empty():
    """Docstring: empty list → empty list (caller falls back to filename)."""
    assert section_path_for_offset(0, []) == []
    assert section_path_for_offset(100, []) == []


def test_section_path_none_returns_empty():
    """``None`` is the explicit "no extractor metadata" signal."""
    assert section_path_for_offset(0, None) == []


def test_section_path_offset_before_single_entry_returns_empty():
    """Offset preceding the first entry's offset → no path covers it yet."""
    section_paths = [(50, ["Chapter 1"])]
    assert section_path_for_offset(10, section_paths) == []


def test_section_path_offset_exactly_at_single_entry_returns_path():
    """Offset == entry offset → that entry's path applies."""
    section_paths = [(50, ["Chapter 1"])]
    assert section_path_for_offset(50, section_paths) == ["Chapter 1"]


def test_section_path_offset_between_entries_returns_most_recent_preceding():
    """The classic outline-walk: inherit the most recent preceding entry."""
    section_paths = [
        (0, ["Intro"]),
        (100, ["Chapter 1"]),
        (200, ["Chapter 1", "1.1"]),
        (300, ["Chapter 2"]),
    ]
    # Between Intro and Chapter 1 → still in Intro.
    assert section_path_for_offset(50, section_paths) == ["Intro"]
    # Between Chapter 1 and 1.1 → still in Chapter 1.
    assert section_path_for_offset(150, section_paths) == ["Chapter 1"]
    # Between 1.1 and Chapter 2 → still in 1.1.
    assert section_path_for_offset(250, section_paths) == ["Chapter 1", "1.1"]


def test_section_path_offset_after_last_entry_returns_last():
    """Tail content inherits the last entry's path forever."""
    section_paths = [
        (0, ["Intro"]),
        (100, ["Chapter 1"]),
        (300, ["Chapter 2"]),
    ]
    assert section_path_for_offset(10_000, section_paths) == ["Chapter 2"]


def test_section_path_tuple_shape_is_the_contract():
    """Regression guard for the WARP-435 PDF-extractor bug.

    The helper iterates ``for entry_offset, entry_path in section_paths``
    — passing the wrong shape (e.g. ``list[list[str]]`` indexed by page)
    raises ``ValueError: not enough values to unpack``. This test pins
    the contract so future extractors don't drift back.
    """
    bad_shape: list = [[], ["Chapter 1"], ["Chapter 1", "1.1"]]
    with pytest.raises(ValueError):
        section_path_for_offset(100, bad_shape)  # type: ignore[arg-type]
