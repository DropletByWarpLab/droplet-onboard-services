"""Smoke tests for services/file-indexer.

Baseline coverage for the CI guard:
  - Core modules import cleanly (catches syntax errors + missing deps).
  - `chunker.chunk_spans` obeys its documented invariants for empty and
    small inputs (WARP-287 replaced the old `chunk_text(str)` API).
"""

from __future__ import annotations

import importlib


def test_config_imports():
    config = importlib.import_module("config")
    assert hasattr(config, "DATABASE_URL")
    assert hasattr(config, "CHUNK_SIZE_TOKENS")


def test_main_imports():
    # file-indexer is a daemon; importing `main` must not start the watcher.
    main = importlib.import_module("main")
    assert callable(main.main)


def test_chunker_handles_empty_and_small_inputs():
    from anchor_schema import NoneAnchor
    from chunker import chunk_spans
    from extractors.spans import Span

    assert chunk_spans([]) == []

    out = chunk_spans([Span(text="one two three four five", anchor=NoneAnchor())])
    assert len(out) == 1
    assert out[0].text == "one two three four five"
    assert out[0].anchor.kind == "none"
