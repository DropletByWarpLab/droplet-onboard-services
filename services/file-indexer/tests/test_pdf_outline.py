"""Unit tests for ``extractors.pdf._flatten_outline`` cycle / depth guards.

WARP-435 reviewer finding 2: pypdf surfaces the PDF outline tree as-is.
A malformed PDF with a circular outline reference (rare but possible) or
a pathologically deep outline would otherwise walk forever or hit
Python's recursion limit unpredictably. These tests pin the bounded
behaviour: a cyclic outline must terminate; a deep outline must stop at
the configured cap.

The tests use lightweight fakes rather than constructing real PDFs:
``_flatten_outline`` only touches three things on the entry objects
(``.title``, ``reader.get_destination_page_number(entry)``, and
``isinstance(entry, list)``), so a ``SimpleNamespace`` + a stub reader
covers the surface.
"""
from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from extractors.pdf import _flatten_outline


class _StubReader:
    """Minimal ``PdfReader`` stand-in for outline-walk tests.

    Returns a fixed page index for every destination. Real pypdf does a
    page lookup; the cycle / depth tests don't care about the index, just
    that the walk terminates.
    """

    def get_destination_page_number(self, entry):  # noqa: D401, ANN001
        return 0


def _dest(title: str):
    """Construct a fake outline destination with a ``.title`` attribute."""
    return SimpleNamespace(title=title)


def test_flatten_outline_cycle_does_not_loop(caplog):
    """A self-referential nested-list cycle must terminate, not infinite-loop.

    pypdf's outline shape interleaves Destination + list-of-children. If
    a malformed PDF surfaces a children-list that contains itself (or two
    lists that reference each other), the recursive walk would otherwise
    loop forever. The visited-set guard catches the reentry on ``id()``
    and skips the second descent.
    """
    reader = _StubReader()

    # Construct a cycle: children list ``inner`` references itself as one
    # of its own siblings. pypdf models children as the list immediately
    # following a Destination, so we shape it as:
    #   [DestA, [DestA1, <inner-which-also-contains-itself>]]
    inner: list = []
    inner.append(_dest("Sub"))
    inner.append(inner)  # self-reference — the cycle.

    outline = [_dest("Top"), inner]

    out: list = []
    caplog.set_level(logging.WARNING, logger="extractors.pdf")
    # If the guard is missing this either spins forever (test timeout) or
    # blows the recursion limit. Either way it never returns cleanly.
    _flatten_outline(reader, outline, [], out)

    # Walk completed. The guard should have logged a warning when it hit
    # the self-reference.
    assert any(
        "cycle" in rec.message.lower() or "visited" in rec.message.lower()
        for rec in caplog.records
    ), f"expected cycle/visited warning, got: {[r.message for r in caplog.records]}"


def test_flatten_outline_depth_cap_stops_descent(caplog):
    """A pathologically deep outline must stop at the depth cap.

    Constructs an outline 100 levels deep — well past the 32-level cap.
    The walk should stop descending at the cap, log a warning, and
    return cleanly rather than recursing 100 times.
    """
    reader = _StubReader()

    # Build nested outline: [Dest, [Dest, [Dest, [...]]]] 100 levels deep.
    # Each level is ``[destination, children_list]``.
    deepest: list = [_dest("level-100")]
    current = deepest
    for level in range(99, 0, -1):
        parent: list = [_dest(f"level-{level}"), current]
        current = parent

    out: list = []
    caplog.set_level(logging.WARNING, logger="extractors.pdf")
    _flatten_outline(reader, current, [], out)

    # Should have logged a depth-cap warning.
    assert any(
        "depth" in rec.message.lower() for rec in caplog.records
    ), f"expected depth-cap warning, got: {[r.message for r in caplog.records]}"

    # And out should contain at most ~32 entries (the cap), not 100.
    # Slack a couple to allow for stack-counted-from-zero vs -from-one.
    assert len(out) <= 40, (
        f"expected depth-bounded output (≤40 entries), got {len(out)}"
    )


def test_flatten_outline_normal_outline_still_works():
    """Regression check — the guard must not break the happy path."""
    reader = _StubReader()
    outline = [
        _dest("Chapter 1"),
        [_dest("1.1"), _dest("1.2")],
        _dest("Chapter 2"),
    ]
    out: list = []
    _flatten_outline(reader, outline, [], out)

    # Four destinations with non-empty titles → four entries (Chapter 1,
    # its two children, Chapter 2). The exact count isn't what we're
    # pinning here — what matters is that the guards don't strangle the
    # happy path. ≥3 means we got the top-level destinations plus at
    # least one child.
    assert len(out) >= 3
    titles_flat = [t for _, path in out for t in path]
    assert "Chapter 1" in titles_flat
    assert "Chapter 2" in titles_flat
    assert "1.1" in titles_flat
