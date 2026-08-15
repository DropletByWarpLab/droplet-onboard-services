"""Legacy Word (.doc) extractor.

The regression that motivated it: `application/msword` was routed at the
docx extractor, so python-docx opened the OLE container, found no OOXML
parts, and raised "is not a Word file, content type is ...themeManager+xml".
Every Word 97-2003 document was therefore
`skipped/unsupported_or_failed_extraction`.
"""
from __future__ import annotations

import struct

import pytest

from extractors.doc import SUPPORTED_MIMES, _clean, _text_pieces, extract
from extractors.registry import _route


_FIB_LEN = 0x0200


def _piece_table(pieces: list[tuple[int, bool, int]]) -> bytes:
    """Build a Clx from (fc, compressed, n_chars) triples."""
    cps = [0]
    for _fc, _compressed, n_chars in pieces:
        cps.append(cps[-1] + n_chars)

    plc = b"".join(struct.pack("<I", cp) for cp in cps)
    for fc, compressed, _n in pieces:
        raw = ((fc * 2) | 0x40000000) if compressed else fc
        plc += struct.pack("<HIH", 0, raw, 0)  # PCD: flags, fc, prm

    return bytes([2]) + struct.pack("<I", len(plc)) + plc


def _build(body: bytes, pieces: list[tuple[int, bool, int]]):
    """Assemble a (WordDocument, table) stream pair.

    ``pieces`` offsets are relative to the start of ``body``; the FIB is
    prepended and the offsets rebased, then pointed at a Clx that occupies
    the whole table stream.
    """
    word = bytearray(_FIB_LEN)
    word[0:2] = b"\xec\xa5"  # wIdent
    struct.pack_into("<H", word, 0x000A, 0x0200)  # flags: use 1Table
    word += body

    table = _piece_table(
        [(_FIB_LEN + fc, compressed, n) for fc, compressed, n in pieces]
    )
    # The Clx starts at offset 0 of the table stream and runs its length.
    struct.pack_into("<II", word, 0x01A2, 0, len(table))
    return bytes(word), table


def test_reads_cp1252_compressed_pieces():
    body = b"Credit card authorization\rSigned by the patient\r"
    word, table = _build(body, [(0, True, len(body))])

    text = "".join(_text_pieces(word, table))

    assert "Credit card authorization" in text
    assert "Signed by the patient" in text


def test_reads_utf16_pieces():
    body = "Réservation".encode("utf-16-le")
    word, table = _build(body, [(0, False, len("Réservation"))])

    assert "".join(_text_pieces(word, table)) == "Réservation"


def test_pieces_are_concatenated_in_document_order():
    """Word stores edits as separate pieces; document order is the CP order,
    not the byte order in the stream."""
    body = b"second" + b"first "
    word, table = _build(body, [(6, True, 6), (0, True, 6)])

    assert "".join(_text_pieces(word, table)) == "first second"


def test_clean_turns_word_control_characters_into_whitespace():
    # \x07 ends a table cell, \r is a paragraph mark, \x13/\x14 bracket a
    # field code — none of them should survive as literal characters.
    raw = "Name:\x07Value\x07\rNext line\r\r\x13FIELD\x14"

    assert _clean(raw) == "Name:\nValue\nNext line\nFIELD"


def test_empty_piece_table_yields_no_pieces():
    word = bytearray(_FIB_LEN)
    struct.pack_into("<II", word, 0x01A2, 0, 0)  # lcbClx = 0

    assert _text_pieces(bytes(word), b"") == []


def test_non_ole_file_raises_rather_than_emitting_garbage(tmp_path):
    """An .rtf or .html saved as .doc must fail cleanly, not index noise."""
    target = tmp_path / "actually-rtf.doc"
    target.write_bytes(rb"{\rtf1\ansi Hello}")

    with pytest.raises(ValueError, match="not an OLE2"):
        extract(str(target))


@pytest.mark.parametrize("mime", sorted(SUPPORTED_MIMES))
def test_registry_routes_msword_to_this_extractor_not_docx(mime):
    routed = _route(mime)

    assert routed is extract
    assert routed.__module__ == "extractors.doc"


def test_docx_still_routes_to_the_docx_extractor():
    routed = _route(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )

    assert routed.__module__ == "extractors.docx"
