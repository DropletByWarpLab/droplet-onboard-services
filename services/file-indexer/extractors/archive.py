"""Archive extractor — five-layer bomb defense + bounded recursion + spans.

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.4
Plan: docs/superpowers/plans/2026-05-07-rag-phase-2-foundation-plan.md §4.3
WARP-287: spans-based interface with depth-capped recursive anchors.

Emits one `Span` per text-bearing member with an `ArchiveMemberAnchor`.
When the member itself is a recursive carrier (zip-in-zip, pdf-in-zip),
the dispatch's inner spans are wrapped into a new outer span keeping the
inner anchor under `innerAnchor` — until the anchor-nesting cap fires.

Cap interplay:
  - `registry.MAX_RECURSION_DEPTH` (2) bounds the *registry call*
    recursion. At registry depth=3, dispatch returns an empty doc with
    `max_recursion_depth_exceeded`. We translate that into our own
    `archive_recursion_capped` warning + a leaf placeholder span so the
    consumer still sees something for the deeply-nested member.
  - `anchor_schema.MAX_ARCHIVE_ANCHOR_DEPTH` (3) bounds the *anchor
    nesting depth* we expose. When `depth + 1 >= MAX_ARCHIVE_ANCHOR_DEPTH`,
    we set `innerAnchor = None` and emit `archive_recursion_capped`
    instead of wrapping the inner anchor.

Five defenses, evaluated in order on every member iteration. The order
matters — cheapest checks first, then per-member size, then the
expensive cumulative-byte check that requires actually streaming the
member:

  1. MAX_ARCHIVE_MEMBERS = 1000 — refuse manifests with too many entries
     up front. A zip with a million entries is almost always hostile.
  2. Path traversal rejection (zip-slip) — `os.path.normpath(name)`
     escaping the extraction root is rejected with a granular warning;
     the rest of the archive still indexes.
  3. Per-member size cap — re-uses `registry._cap_for_mime(mime)` so a
     600 MB MP4 inside a zip respects VIDEO_MAX_BYTES, an embedded
     archive respects ARCHIVE_MAX_BYTES, etc.
  4. Cumulative decompressed size cap — MAX_ARCHIVE_TOTAL_BYTES = 500 MB.
     Tracks running total across ALL members.
  5. Streaming reads only — `zipfile.ZipFile.open(member)` + a chunked
     read() loop. We NEVER call `extractall()`.

Encrypted archives (zip flag_bits & 0x1) are detected up front and
skipped wholesale with an `encrypted_archive_skipped` warning.

7z is intentionally out of scope here (also WARP-212).
"""
from __future__ import annotations

import logging
import os
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Optional, cast

from anchor_schema import (
    ArchiveMemberAnchor,
    MAX_ARCHIVE_ANCHOR_DEPTH,
    NoneAnchor,
)
from extractors.spans import Span
from extractors.types import ExtractedDoc

logger = logging.getLogger(__name__)


SUPPORTED_MIMES = frozenset(
    {
        "application/zip",
        "application/x-zip-compressed",
        "application/x-tar",
        "application/gzip",
        "application/x-gzip",
        "application/x-bzip2",
    }
)

MAX_ARCHIVE_MEMBERS = int(os.environ.get("MAX_ARCHIVE_MEMBERS", 1000))
MAX_ARCHIVE_TOTAL_BYTES = int(
    os.environ.get("MAX_ARCHIVE_TOTAL_BYTES", 500 * 1024 * 1024)
)
_READ_CHUNK = 64 * 1024
_MIME_PROBE_BYTES = 8192

# Sentinel warning that propagates up the archive nesting un-prefixed so
# the outermost doc can surface it cleanly. Per-member warnings are
# normally tagged `member:<name>:<original>`; this one is special-cased.
_CAP_WARNING = "archive_recursion_capped"


def _detect_mime(buf: bytes, filename: str) -> str:
    """Best-effort MIME detection from a buffer + filename hint."""
    try:
        import magic  # type: ignore[import-not-found]

        return magic.from_buffer(buf, mime=True)
    except Exception:  # pragma: no cover — fallback path
        pass
    ext = os.path.splitext(filename)[1].lower()
    return _EXT_FALLBACK.get(ext, "application/octet-stream")


_EXT_FALLBACK = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "application/xml",
    ".html": "text/html",
    ".htm": "text/html",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".bz2": "application/x-bzip2",
}


def _is_traversal(name: str) -> bool:
    """Reject member paths that would escape the extraction root."""
    if not name:
        return True
    norm = os.path.normpath(name)
    if norm.startswith(".."):
        return True
    if os.path.isabs(norm):
        return True
    if "/.." in norm or "\\.." in norm:
        return True
    return False


def _is_encrypted_zip(zf: zipfile.ZipFile) -> bool:
    return any(info.flag_bits & 0x1 for info in zf.infolist())


def _doc(
    meta_format: str,
    spans: list[Span],
    warnings: list[str],
    chain: Optional[list[dict]] = None,
) -> ExtractedDoc:
    metadata: dict = {
        "extractor_name": "archive",
        "extractor_version": "2",
        "format": meta_format,
    }
    if chain:
        metadata["chain"] = chain
    return cast(
        ExtractedDoc,
        {
            "spans": spans,
            "language": None,
            "metadata": metadata,
            "warnings": warnings,
        },
    )


def _wrap_inner_anchor(inner_anchor, depth: int) -> tuple[object, bool]:
    """Decide what to put under `ArchiveMemberAnchor.innerAnchor`.

    Returns (innerAnchor_value, capped) — `capped` is True when the
    anchor-nesting depth cap forced us to drop the inner anchor.

    The outer anchor for this archive sits at depth `depth + 1`
    (1-indexed). If wrapping the inner_anchor would push the chain past
    `MAX_ARCHIVE_ANCHOR_DEPTH`, we set innerAnchor=None.

    `depth + 1 >= MAX_ARCHIVE_ANCHOR_DEPTH` is the spec-stated guard.
    """
    if depth + 1 >= MAX_ARCHIVE_ANCHOR_DEPTH:
        return None, True
    return inner_anchor, False


def _process_member_bytes(
    member_name: str,
    member_bytes: bytes,
    depth: int,
    parent_filename: str = "(archive)",
    parent_mime: str = "application/zip",
) -> tuple[list[Span], list[str], Optional[list[dict]]]:
    """Detect MIME, write to a temp file, recurse via dispatch().

    Returns (spans, warnings, chain). Spans are already wrapped with the
    outer `ArchiveMemberAnchor(member=member_name, innerAnchor=...)`.
    When the registry's recursion cap kicks in (dispatch returns empty
    doc), we emit a single placeholder span so deeply-nested members
    still surface in the output, and add the `archive_recursion_capped`
    warning un-prefixed.
    """
    # Local import to avoid a circular import at module load time.
    from extractors import registry

    mime = _detect_mime(member_bytes, member_name)
    suffix = os.path.splitext(member_name)[1] or ""
    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        os.write(fd, member_bytes)
    finally:
        os.close(fd)
    try:
        sub = registry.dispatch(tmp, mime, depth=depth + 1)
        if sub is None:
            return [], [f"unsupported_member:{member_name}:{mime}"], None

        sub_spans: list[Span] = list(sub.get("spans") or [])
        sub_warnings = list(sub.get("warnings") or [])

        # If the registry capped recursion deeper, sub_spans is empty +
        # warning carries `max_recursion_depth_exceeded`. Translate that
        # into our anchor-side cap: emit one placeholder span so the
        # member is still represented, and surface `archive_recursion_capped`.
        registry_capped = "max_recursion_depth_exceeded" in sub_warnings
        if not sub_spans and registry_capped:
            placeholder_anchor = ArchiveMemberAnchor(
                member=member_name, innerAnchor=NoneAnchor()
            )
            placeholder = Span(
                text=member_name,
                anchor=placeholder_anchor,
                section_path=[member_name],
            )
            return [placeholder], [_CAP_WARNING], _build_chain(
                parent_filename, parent_mime, member_name, mime, None
            )

        # Tag forwarded warnings with the member name, except the cap
        # warning which is propagated un-prefixed.
        tagged: list[str] = []
        for w in sub_warnings:
            if w == _CAP_WARNING:
                tagged.append(_CAP_WARNING)
            else:
                tagged.append(f"member:{member_name}:{w}")

        # Wrap each inner span with our outer ArchiveMemberAnchor.
        capped_any = False
        wrapped: list[Span] = []
        for inner in sub_spans:
            inner_anchor, capped = _wrap_inner_anchor(inner.anchor, depth)
            if capped:
                capped_any = True
            anchor = ArchiveMemberAnchor(
                member=member_name,
                innerAnchor=inner_anchor if inner_anchor is not None else None,
            )
            # Preserve the inner extractor's section_path (already the
            # member filename or a richer breadcrumb for structured
            # members); fall back to the member name if it's empty.
            inner_section = list(inner.section_path) or [member_name]
            wrapped.append(
                Span(text=inner.text, anchor=anchor, section_path=inner_section)
            )

        if capped_any and _CAP_WARNING not in tagged:
            tagged.append(_CAP_WARNING)

        # Build the WARP-214 chain lineage.
        sub_chain = (sub.get("metadata") or {}).get("chain") or []
        chain = _build_chain(parent_filename, parent_mime, member_name, mime, sub_chain)
        return wrapped, tagged, chain
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _build_chain(
    parent_filename: str,
    parent_mime: str,
    member_name: str,
    member_mime: str,
    sub_chain: Optional[list[dict]],
) -> list[dict]:
    if sub_chain:
        return [{"filename": parent_filename, "mime": parent_mime}, *sub_chain]
    return [
        {"filename": parent_filename, "mime": parent_mime},
        {"filename": member_name, "mime": member_mime},
    ]


def _extract_zip(path: Path, depth: int) -> ExtractedDoc:
    """Walk a zip with all five defenses applied."""
    spans: list[Span] = []
    warnings: list[str] = []
    cumulative = 0
    parent_filename = path.name or "(archive)"
    member_chains: list[list[dict]] = []

    try:
        with zipfile.ZipFile(path) as zf:
            if _is_encrypted_zip(zf):
                return _doc("zip", spans=[], warnings=["encrypted_archive_skipped"])

            members = zf.infolist()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                warnings.append(f"too_many_members:{len(members)}")
                members = members[:MAX_ARCHIVE_MEMBERS]

            for info in members:
                if info.is_dir():
                    continue

                if _is_traversal(info.filename):
                    warnings.append(f"path_traversal_rejected:{info.filename}")
                    continue

                try:
                    with zf.open(info) as f:
                        head = f.read(_MIME_PROBE_BYTES)
                except (RuntimeError, zipfile.BadZipFile) as exc:
                    warnings.append(f"member_open_failed:{info.filename}:{exc}")
                    continue

                mime_guess = _detect_mime(head, info.filename)

                from extractors import registry as _registry

                cap = _registry._cap_for_mime(mime_guess)
                if info.file_size > cap:
                    warnings.append(f"member_size_cap_exceeded:{info.filename}")
                    continue

                with zf.open(info) as f:
                    chunks: list[bytes] = [head]
                    cumulative += len(head)
                    if cumulative > MAX_ARCHIVE_TOTAL_BYTES:
                        warnings.append("decompressed_size_cap_exceeded")
                        return _doc(
                            "zip", spans, warnings,
                            chain=member_chains[0] if member_chains else None,
                        )
                    while True:
                        b = f.read(_READ_CHUNK)
                        if not b:
                            break
                        cumulative += len(b)
                        if cumulative > MAX_ARCHIVE_TOTAL_BYTES:
                            warnings.append("decompressed_size_cap_exceeded")
                            return _doc(
                                "zip", spans, warnings,
                                chain=member_chains[0] if member_chains else None,
                            )
                        chunks.append(b)
                    member_bytes = b"".join(chunks)

                member_spans, member_warnings, chain = _process_member_bytes(
                    info.filename,
                    member_bytes,
                    depth,
                    parent_filename=parent_filename,
                    parent_mime="application/zip",
                )
                spans.extend(member_spans)
                warnings.extend(member_warnings)
                if chain:
                    member_chains.append(chain)
    except zipfile.BadZipFile as exc:
        warnings.append(f"bad_zip_file:{exc}")
        return _doc(
            "zip", spans, warnings,
            chain=member_chains[0] if member_chains else None,
        )

    return _doc(
        "zip", spans, warnings,
        chain=member_chains[0] if member_chains else None,
    )


def _extract_tar(path: Path, depth: int) -> ExtractedDoc:
    """Walk a tarfile (`.tar`, `.tar.gz`, `.tar.bz2`) with the same defenses."""
    spans: list[Span] = []
    warnings: list[str] = []
    cumulative = 0
    parent_filename = path.name or "(archive)"
    member_chains: list[list[dict]] = []

    try:
        with tarfile.open(path, "r:*") as tf:
            members = tf.getmembers()

            if len(members) > MAX_ARCHIVE_MEMBERS:
                warnings.append(f"too_many_members:{len(members)}")
                members = members[:MAX_ARCHIVE_MEMBERS]

            for m in members:
                if not m.isfile():
                    continue

                if _is_traversal(m.name):
                    warnings.append(f"path_traversal_rejected:{m.name}")
                    continue

                f = tf.extractfile(m)
                if f is None:
                    continue

                head = f.read(_MIME_PROBE_BYTES)
                mime_guess = _detect_mime(head, m.name)

                from extractors import registry as _registry

                cap = _registry._cap_for_mime(mime_guess)
                if m.size > cap:
                    warnings.append(f"member_size_cap_exceeded:{m.name}")
                    continue

                chunks: list[bytes] = [head]
                cumulative += len(head)
                if cumulative > MAX_ARCHIVE_TOTAL_BYTES:
                    warnings.append("decompressed_size_cap_exceeded")
                    return _doc(
                        "tar", spans, warnings,
                        chain=member_chains[0] if member_chains else None,
                    )
                while True:
                    b = f.read(_READ_CHUNK)
                    if not b:
                        break
                    cumulative += len(b)
                    if cumulative > MAX_ARCHIVE_TOTAL_BYTES:
                        warnings.append("decompressed_size_cap_exceeded")
                        return _doc(
                            "tar", spans, warnings,
                            chain=member_chains[0] if member_chains else None,
                        )
                    chunks.append(b)
                member_bytes = b"".join(chunks)

                member_spans, member_warnings, chain = _process_member_bytes(
                    m.name,
                    member_bytes,
                    depth,
                    parent_filename=parent_filename,
                    parent_mime="application/x-tar",
                )
                spans.extend(member_spans)
                warnings.extend(member_warnings)
                if chain:
                    member_chains.append(chain)
    except tarfile.TarError as exc:
        warnings.append(f"bad_tar_file:{exc}")
        return _doc(
            "tar", spans, warnings,
            chain=member_chains[0] if member_chains else None,
        )

    return _doc(
        "tar", spans, warnings,
        chain=member_chains[0] if member_chains else None,
    )


def extract(path, mime: Optional[str] = None, depth: int = 0) -> Optional[ExtractedDoc]:
    """Top-level entry point used by the registry.

    `path` accepts both `str` and `pathlib.Path`.
    `mime` defaults to None for direct callers (tests, ad-hoc use); we
    infer from the file extension in that case.
    `depth` is forwarded by `registry._call_handler` per the recursion
    contract.
    """
    p = Path(os.fspath(path))
    if mime is None:
        ext = p.suffix.lower()
        mime = _EXT_FALLBACK.get(ext, "application/zip")
    if mime not in SUPPORTED_MIMES:
        return None
    if mime in {"application/zip", "application/x-zip-compressed"}:
        return _extract_zip(p, depth)
    return _extract_tar(p, depth)
