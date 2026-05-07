"""Unit tests for the email extractor (WARP-199).

Covers:
  - .eml header + body extraction.
  - Recursive attachment dispatch (PDF attachment → Phase 1 PDF extractor).
  - Unsupported MIME early return.

The .msg path is exercised by skip-marked tests when a public-domain MAPI
sample is committed; see the module-level skip below for the rationale.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from extractors import email as email_ext

FIXTURES = Path(__file__).parent / "fixtures"


def test_simple_eml_extracts_headers_and_body():
    result = email_ext.extract(str(FIXTURES / "simple.eml"), mime="message/rfc822")
    assert result is not None
    assert "From: alice@example.com" in result["text"]
    assert "Subject: Q4 budget kickoff" in result["text"]
    assert "one hundred thousand" in result["text"]


def test_eml_with_pdf_attachment_recurses():
    """The PDF attachment is dispatched recursively and its text is appended."""
    result = email_ext.extract(
        str(FIXTURES / "with-pdf-attachment.eml"), mime="message/rfc822"
    )
    assert result is not None
    # Email body
    assert "Bob, see the attached PDF" in result["text"]
    # Attachment separator + PDF text (Phase 1 fixture content)
    assert "--- Attachment: proposal.pdf ---" in result["text"]
    # The Phase 1 sample.pdf contains a known phrase — assert non-trivial text bled through.
    assert len(result["text"]) > 200


def test_unsupported_mime_returns_none():
    result = email_ext.extract(str(FIXTURES / "simple.eml"), mime="text/plain")
    assert result is None


def test_html_only_eml_strips_html_to_text():
    """Non-multipart text/html email: HTML must be stripped to text."""
    result = email_ext.extract(
        str(FIXTURES / "simple-html-only.eml"), mime="message/rfc822"
    )
    assert result is not None
    assert "Quarterly digest" in result["text"]
    assert "one hundred thousand" in result["text"]
    assert "<h1>" not in result["text"]  # HTML stripped
    assert "<p>" not in result["text"]


@pytest.mark.skip(
    reason=(
        "No public-domain .msg fixture committed. extract-msg's own test "
        "corpus is not licensed for redistribution; revisit when we land "
        "a hand-rolled MAPI sample. The .eml path covers the recursion "
        "contract, so .msg coverage is gated on Outlook traffic in the wild."
    )
)
def test_msg_extracts_headers_and_body():  # pragma: no cover
    """Placeholder for when we have a public-domain .msg fixture."""
    raise NotImplementedError
