"""Legacy Word (.doc, Word 97-2003 binary) extractor via olefile.

The registry used to route ``application/msword`` at the docx extractor,
which is a different format entirely — python-docx opens the OLE container,
finds no OOXML parts and raises *"is not a Word file, content type is
...themeManager+xml"*, so every legacy .doc was recorded as
``unsupported_or_failed_extraction``.

The usual command-line converters for this format (antiword, catdoc,
wvWare) are all GPL, which we cannot ship in an appliance we convey, so the
text is read directly from the binary instead. olefile is BSD-licensed and
already in the image.

Format notes (MS-DOC): the document text is *not* one contiguous run. The
FIB in the ``WordDocument`` stream points at a piece table (``Clx``) in the
``0Table``/``1Table`` stream; each piece names a byte offset and an encoding
— CP1252 when bit 30 of the offset is set, UTF-16LE otherwise. Walking the
piece table is what separates real text from the deleted/undo fragments
that a naive scrape of the stream would pick up.
"""
from __future__ import annotations

import logging
import os
import re
import struct

from anchor_schema import NoneAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)

SUPPORTED_MIMES = {
    "application/msword",
    "application/vnd.ms-word",
}

# FIB field offsets within the WordDocument stream (MS-DOC §2.5.1).
_FIB_FLAGS = 0x000A  # bit 9 (0x0200) selects 0Table vs 1Table
_FIB_FC_CLX = 0x01A2  # offset of the piece table in the table stream
_FIB_LCB_CLX = 0x01A6  # its length

_CLXT_PRC = 1  # a formatting run — skip it
_CLXT_PCDT = 2  # the piece table we want

# Word's in-text control characters: field markers, footnote/annotation
# references, picture placeholders, and the cell/row terminators.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _text_pieces(word_stream: bytes, table_stream: bytes) -> list[str]:
    """Decode the piece table into text runs, in document order."""
    fc_clx, lcb_clx = struct.unpack_from("<II", word_stream, _FIB_FC_CLX)
    if lcb_clx == 0 or fc_clx + lcb_clx > len(table_stream):
        return []

    clx = table_stream[fc_clx : fc_clx + lcb_clx]

    # Walk past any Prc entries to find the Pcdt.
    pos = 0
    while pos < len(clx) and clx[pos] == _CLXT_PRC:
        if pos + 3 > len(clx):
            return []
        (cb_grpprl,) = struct.unpack_from("<H", clx, pos + 1)
        pos += 3 + cb_grpprl
    if pos >= len(clx) or clx[pos] != _CLXT_PCDT:
        return []

    (lcb_plc,) = struct.unpack_from("<I", clx, pos + 1)
    plc = clx[pos + 5 : pos + 5 + lcb_plc]

    # PlcPcd is (n+1) 4-byte CPs followed by n 8-byte PCDs, so
    # lcb = 4(n+1) + 8n  =>  n = (lcb - 4) / 12.
    n_pieces = (len(plc) - 4) // 12
    if n_pieces <= 0:
        return []

    cps = list(struct.unpack_from(f"<{n_pieces + 1}I", plc, 0))
    pcd_base = 4 * (n_pieces + 1)

    pieces: list[str] = []
    for i in range(n_pieces):
        (fc_raw,) = struct.unpack_from("<I", plc, pcd_base + i * 8 + 2)
        compressed = bool(fc_raw & 0x40000000)
        fc = (fc_raw & 0x3FFFFFFF) // 2 if compressed else fc_raw

        n_chars = cps[i + 1] - cps[i]
        if n_chars <= 0:
            continue

        if compressed:
            raw = word_stream[fc : fc + n_chars]
            text = raw.decode("cp1252", errors="replace")
        else:
            raw = word_stream[fc : fc + n_chars * 2]
            text = raw.decode("utf-16-le", errors="replace")
        pieces.append(text)

    return pieces


def _clean(text: str) -> str:
    """Turn Word's control characters into ordinary whitespace."""
    # \r is Word's paragraph mark; \x07 ends a table cell/row.
    text = text.replace("\r", "\n").replace("\x07", "\n")
    text = _CONTROL_CHARS.sub(" ", text)
    # Collapse the runs of blank lines that field codes leave behind.
    lines = [line.strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


def extract(path: str, mime: str = "") -> ExtractedDoc:
    import olefile

    filename = os.path.basename(path)
    warnings: list[str] = []

    if not olefile.isOleFile(path):
        # A .doc that is not an OLE container is almost always RTF or HTML
        # saved under the wrong extension; let the caller see a clean failure
        # rather than a garbage span.
        raise ValueError(f"{filename}: not an OLE2 compound file")

    ole = olefile.OleFileIO(path)
    try:
        if not ole.exists("WordDocument"):
            raise ValueError(f"{filename}: no WordDocument stream")
        word_stream = ole.openstream("WordDocument").read()

        # Bit 9 of the FIB flags picks which table stream is current; the
        # other one holds a stale copy from a previous save.
        (flags,) = struct.unpack_from("<H", word_stream, _FIB_FLAGS)
        table_name = "1Table" if flags & 0x0200 else "0Table"
        if not ole.exists(table_name):
            table_name = "1Table" if ole.exists("1Table") else "0Table"
            warnings.append("doc_table_stream_fallback")
        table_stream = (
            ole.openstream(table_name).read() if ole.exists(table_name) else b""
        )
    finally:
        ole.close()

    text = _clean("".join(_text_pieces(word_stream, table_stream)))

    spans: list[Span] = []
    if text:
        spans.append(Span(text=text, anchor=NoneAnchor(), section_path=[filename]))
    else:
        warnings.append("doc_no_text")

    return ExtractedDoc(
        spans=spans,
        language=None,
        metadata={
            "extractor_name": "doc",
            "extractor_version": "1",
            "word_count": len(text.split()),
        },
        warnings=warnings,
    )
