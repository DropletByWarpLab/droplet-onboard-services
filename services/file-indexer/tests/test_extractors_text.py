"""Unit tests for the text/HTML/CSV extractor (spans shape — WARP-287).

Anchor-shape coverage (single NoneAnchor span) lives in
test_non_mvp_extractors_emit_none_anchor.py. This file keeps the
content-level corner-cases: HTML boilerplate stripping, CSV passthrough,
unicode decode fallback.
"""
from __future__ import annotations

from extractors.text import extract


def _full_text(doc) -> str:
    return " ".join(s.text for s in doc["spans"])


def test_plain_text(tmp_path):
    f = tmp_path / "doc.txt"
    f.write_text("Hello world.\nSecond line.\n", encoding="utf-8")
    doc = extract(str(f))
    full = _full_text(doc)
    assert "Hello world" in full
    assert "Second line" in full
    assert doc["metadata"]["extractor_name"] == "text"
    assert doc["metadata"]["word_count"] >= 4


def test_html_strips_boilerplate(tmp_path):
    f = tmp_path / "page.html"
    f.write_text(
        "<html><head><script>var x=1;</script></head><body>"
        "<nav>Skip me</nav>"
        "<article><h1>Real Title</h1><p>Real content here.</p></article>"
        "</body></html>",
        encoding="utf-8",
    )
    doc = extract(str(f))
    full = _full_text(doc)
    assert "Real Title" in full
    assert "Real content here" in full
    # Boilerplate should be stripped.
    assert "var x" not in full


def test_csv_passthrough(tmp_path):
    f = tmp_path / "data.csv"
    f.write_text("col1,col2\nA,1\nB,2\n", encoding="utf-8")
    doc = extract(str(f))
    full = _full_text(doc)
    assert "col1,col2" in full
    assert "A,1" in full


def test_unicode_decode_fallback(tmp_path):
    f = tmp_path / "weird.txt"
    f.write_bytes(b"\xff\xfe\x00\x00plain ASCII tail")
    # Should not raise; should fall back to errors='replace'.
    doc = extract(str(f))
    assert "plain ASCII tail" in _full_text(doc)


# ── RTF (WARP-1790) ──────────────────────────────────────────────────────────
# `mimetypes.guess_type("x.rtf")` returns "text/rtf", so the registry routes
# .rtf to THIS extractor on its `mime.startswith("text/")` branch. Before the
# fix it fell through to raw passthrough and the control-word stream was
# indexed as prose — QA reported chunk snippets reading
# "\lsdpriority46 \lsdlocked0 List Ta…" for a real essay.

# A cut-down document carrying the exact style-table control words from the
# ticket, plus a font table and an escaped character, around real prose.
_RTF_SAMPLE = (
    r"{\rtf1\ansi\ansicpg1252\deff0"
    r"{\fonttbl{\f0\fnil\fcharset0 Times New Roman;}}"
    r"{\*\listtable{\list\listtemplateid1{\listlevel\levelnfc0}}}"
    r"{\stylesheet{\s0\lsdpriority46\lsdlocked0 List Table 4;}}"
    r"\viewkind4\uc1\pard\f0\fs24 "
    r"Adler argues that reading well is an active art.\par "
    r"A second paragraph continues the argument.\par}"
)


def test_rtf_yields_prose_not_control_words(tmp_path):
    f = tmp_path / "Adler Essay 2.4 IVC.rtf"
    f.write_text(_RTF_SAMPLE, encoding="utf-8")
    doc = extract(str(f))
    full = _full_text(doc)

    assert "Adler argues that reading well is an active art." in full
    assert "A second paragraph continues the argument." in full

    # The exact markup QA saw leaking into the Knowledge snippets.
    for control_word in ("lsdpriority", "lsdlocked", "fonttbl", "listtable", "viewkind"):
        assert control_word not in full, f"{control_word} leaked into indexed text"
    assert "\\" not in full


def test_rtf_detected_by_magic_even_with_a_wrong_extension(tmp_path):
    # A mis-named file must not reach the index as markup either.
    f = tmp_path / "notes.txt"
    f.write_text(_RTF_SAMPLE, encoding="utf-8")
    full = _full_text(extract(str(f)))
    assert "Adler argues that reading well is an active art." in full
    assert "lsdpriority" not in full


def test_rtf_falls_back_to_a_regex_strip_when_striprtf_is_missing(tmp_path, monkeypatch):
    # Mirrors the HTML contract: a missing dependency must degrade, never
    # regress to indexing raw markup.
    import builtins

    real_import = builtins.__import__

    def _no_striprtf(name, *args, **kwargs):
        if name.startswith("striprtf"):
            raise ImportError("simulated missing dependency")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _no_striprtf)

    f = tmp_path / "doc.rtf"
    f.write_text(_RTF_SAMPLE, encoding="utf-8")
    full = _full_text(extract(str(f)))

    assert "Adler argues that reading well is an active art." in full
    assert "lsdpriority" not in full


def test_plain_text_is_untouched_by_the_rtf_path(tmp_path):
    # Regression guard: a normal .txt must not be run through any stripper.
    f = tmp_path / "doc.txt"
    body = "A backslash \\ and a brace { should survive in plain text.\n"
    f.write_text(body, encoding="utf-8")
    full = _full_text(extract(str(f)))
    assert "backslash \\" in full
    assert "{" in full
