"""Archive extractor — five-layer bomb defense + bounded recursion.

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.4
Plan: docs/superpowers/plans/2026-05-07-rag-phase-2-foundation-plan.md §4.3

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
     Tracks running total across ALL members. The moment cumulative
     output crosses the line we abort the iteration, return the partial
     text we already accumulated, and emit a `decompressed_size_cap_exceeded`
     warning. This is the bomb defense.
  5. Streaming reads only — `zipfile.ZipFile.open(member)` + a chunked
     read() loop. We NEVER call `extractall()`. We NEVER call unbounded
     `read()` on a member.

Encrypted archives (zip flag_bits & 0x1) are detected up front and
skipped wholesale with an `encrypted_archive_skipped` warning. We don't
prompt for a password — that's WARP-212.

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

_MEMBER_SEPARATOR = "--- Member: {name} ---"


def _detect_mime(buf: bytes, filename: str) -> str:
    """Best-effort MIME detection from a buffer + filename hint.

    Prefers libmagic via python-magic when available — that's the
    definitive content-sniff. Falls back to a tiny extension map so the
    extractor still works on minimal CI images that don't ship libmagic1.
    """
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
    """Reject member paths that would escape the extraction root.

    `os.path.normpath` collapses the path; if the result starts with
    `..` or is absolute, we treat it as a zip-slip attempt. We also
    catch the Windows-style `\\` separator just in case.
    """
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


def _empty_doc(meta_format: str, warnings: list[str]) -> ExtractedDoc:
    return cast(
        ExtractedDoc,
        {
            "text": "",
            "page_breaks": [],
            "language": None,
            "metadata": {
                "extractor_name": "archive",
                "extractor_version": "1.0",
                "format": meta_format,
            },
            "warnings": warnings,
        },
    )


def _result_doc(
    meta_format: str,
    text_parts: list[str],
    warnings: list[str],
    chain: Optional[list[dict]] = None,
) -> ExtractedDoc:
    metadata: dict = {
        "extractor_name": "archive",
        "extractor_version": "1.0",
        "format": meta_format,
    }
    # WARP-214: surface the first member's chain on the doc-level metadata so
    # the chunker propagates it to FileContentChunk.metadata.chain. Multiple
    # members produce multiple chains; chunk-level chain assignment is a
    # follow-up — the dashboard's depth-2 cap is satisfied by the first chain.
    if chain:
        metadata["chain"] = chain
    return cast(
        ExtractedDoc,
        {
            "text": "\n".join(text_parts),
            "page_breaks": [],
            "language": None,
            "metadata": metadata,
            "warnings": warnings,
        },
    )


def _process_member_bytes(
    member_name: str,
    member_bytes: bytes,
    depth: int,
    parent_filename: str = "(archive)",
    parent_mime: str = "application/zip",
) -> tuple[str, list[str], Optional[list[dict]]]:
    """Detect MIME, write to a temp file, recurse via dispatch().

    The temp file is necessary because most extractors (PDF, docx, etc.)
    take a filesystem path, not a buffer. We delete it after. If
    `dispatch()` returns None (unsupported MIME), we surface that as a
    warning so the operator can see what slipped through.

    WARP-214: returns a third tuple element — the chain[] for this member,
    or None if the dispatch didn't produce a usable doc.
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
            return "", [f"unsupported_member:{member_name}:{mime}"], None
        text = sub.get("text", "")
        sub_warnings = list(sub.get("warnings") or [])
        # Tag forwarded warnings with the member name so the operator can
        # tell which member triggered which downstream warning.
        tagged = [f"member:{member_name}:{w}" for w in sub_warnings]
        # WARP-214: build the chain. If the member itself was a recursive
        # carrier (zip-in-zip, eml-in-zip), splice our parent around its chain.
        sub_chain = (sub.get("metadata") or {}).get("chain") or []
        if sub_chain:
            chain = [
                {"filename": parent_filename, "mime": parent_mime},
                *sub_chain,
                {"filename": member_name, "mime": mime},
            ]
        else:
            chain = [
                {"filename": parent_filename, "mime": parent_mime},
                {"filename": member_name, "mime": mime},
            ]
        return text, tagged, chain
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _extract_zip(path: Path, depth: int) -> ExtractedDoc:
    """Walk a zip with all five defenses applied."""
    text_parts: list[str] = []
    warnings: list[str] = []
    cumulative = 0
    parent_filename = path.name or "(archive)"
    member_chains: list[list[dict]] = []

    try:
        with zipfile.ZipFile(path) as zf:
            if _is_encrypted_zip(zf):
                # Defense layer 0 (whole-archive). No password prompts.
                return _empty_doc(
                    "zip", warnings=["encrypted_archive_skipped"]
                )

            members = zf.infolist()
            # Layer 1: too-many-members.
            if len(members) > MAX_ARCHIVE_MEMBERS:
                warnings.append(f"too_many_members:{len(members)}")
                members = members[:MAX_ARCHIVE_MEMBERS]

            for info in members:
                if info.is_dir():
                    continue

                # Layer 2: path traversal.
                if _is_traversal(info.filename):
                    warnings.append(
                        f"path_traversal_rejected:{info.filename}"
                    )
                    continue

                # Probe the first chunk for MIME detection (Layer 3 needs it).
                try:
                    with zf.open(info) as f:
                        head = f.read(_MIME_PROBE_BYTES)
                except (RuntimeError, zipfile.BadZipFile) as exc:
                    # RuntimeError is what stdlib zipfile raises if you
                    # try to open an encrypted member without a password.
                    # We already rejected encrypted archives above, but
                    # belt-and-braces: if a single member is encrypted,
                    # skip it.
                    warnings.append(
                        f"member_open_failed:{info.filename}:{exc}"
                    )
                    continue

                mime_guess = _detect_mime(head, info.filename)

                # Layer 3: per-member size cap (using registry's MIME map).
                from extractors import registry as _registry

                cap = _registry._cap_for_mime(mime_guess)
                if info.file_size > cap:
                    warnings.append(
                        f"member_size_cap_exceeded:{info.filename}"
                    )
                    continue

                # Layer 4 & 5: streaming read with cumulative byte tracking.
                with zf.open(info) as f:
                    chunks: list[bytes] = [head]
                    cumulative += len(head)
                    if cumulative > MAX_ARCHIVE_TOTAL_BYTES:
                        warnings.append("decompressed_size_cap_exceeded")
                        return _result_doc(
                            "zip", text_parts, warnings,
                            chain=member_chains[0] if member_chains else None,
                        )
                    while True:
                        b = f.read(_READ_CHUNK)
                        if not b:
                            break
                        cumulative += len(b)
                        if cumulative > MAX_ARCHIVE_TOTAL_BYTES:
                            warnings.append(
                                "decompressed_size_cap_exceeded"
                            )
                            return _result_doc(
                                "zip", text_parts, warnings,
                                chain=member_chains[0] if member_chains else None,
                            )
                        chunks.append(b)
                    member_bytes = b"".join(chunks)

                # Recurse via the registry — depth+1 is enforced by dispatch().
                t, w, chain = _process_member_bytes(
                    info.filename,
                    member_bytes,
                    depth,
                    parent_filename=parent_filename,
                    parent_mime="application/zip",
                )
                if t:
                    text_parts.append(
                        f"{_MEMBER_SEPARATOR.format(name=info.filename)}\n{t}"
                    )
                warnings.extend(w)
                if chain:
                    member_chains.append(chain)
    except zipfile.BadZipFile as exc:
        warnings.append(f"bad_zip_file:{exc}")
        return _result_doc(
            "zip", text_parts, warnings,
            chain=member_chains[0] if member_chains else None,
        )

    return _result_doc(
        "zip", text_parts, warnings,
        chain=member_chains[0] if member_chains else None,
    )


def _extract_tar(path: Path, depth: int) -> ExtractedDoc:
    """Walk a tarfile (`.tar`, `.tar.gz`, `.tar.bz2`) with the same defenses.

    `tarfile.open(mode='r:*')` auto-detects the inner compression so a
    single code path handles all three of the tar-family MIMEs.
    """
    text_parts: list[str] = []
    warnings: list[str] = []
    cumulative = 0
    parent_filename = path.name or "(archive)"
    member_chains: list[list[dict]] = []

    try:
        with tarfile.open(path, "r:*") as tf:
            members = tf.getmembers()

            # Layer 1: too-many-members.
            if len(members) > MAX_ARCHIVE_MEMBERS:
                warnings.append(f"too_many_members:{len(members)}")
                members = members[:MAX_ARCHIVE_MEMBERS]

            for m in members:
                if not m.isfile():
                    continue

                # Layer 2: path traversal.
                if _is_traversal(m.name):
                    warnings.append(f"path_traversal_rejected:{m.name}")
                    continue

                f = tf.extractfile(m)
                if f is None:
                    continue

                head = f.read(_MIME_PROBE_BYTES)
                mime_guess = _detect_mime(head, m.name)

                # Layer 3: per-member size cap.
                from extractors import registry as _registry

                cap = _registry._cap_for_mime(mime_guess)
                if m.size > cap:
                    warnings.append(
                        f"member_size_cap_exceeded:{m.name}"
                    )
                    continue

                # Layer 4 & 5: streaming + cumulative cap.
                chunks: list[bytes] = [head]
                cumulative += len(head)
                if cumulative > MAX_ARCHIVE_TOTAL_BYTES:
                    warnings.append("decompressed_size_cap_exceeded")
                    return _result_doc(
                        "tar", text_parts, warnings,
                        chain=member_chains[0] if member_chains else None,
                    )
                while True:
                    b = f.read(_READ_CHUNK)
                    if not b:
                        break
                    cumulative += len(b)
                    if cumulative > MAX_ARCHIVE_TOTAL_BYTES:
                        warnings.append("decompressed_size_cap_exceeded")
                        return _result_doc(
                            "tar", text_parts, warnings,
                            chain=member_chains[0] if member_chains else None,
                        )
                    chunks.append(b)
                member_bytes = b"".join(chunks)

                t, w, chain = _process_member_bytes(
                    m.name,
                    member_bytes,
                    depth,
                    parent_filename=parent_filename,
                    parent_mime="application/x-tar",
                )
                if t:
                    text_parts.append(
                        f"{_MEMBER_SEPARATOR.format(name=m.name)}\n{t}"
                    )
                warnings.extend(w)
                if chain:
                    member_chains.append(chain)
    except tarfile.TarError as exc:
        warnings.append(f"bad_tar_file:{exc}")
        return _result_doc(
            "tar", text_parts, warnings,
            chain=member_chains[0] if member_chains else None,
        )

    return _result_doc(
        "tar", text_parts, warnings,
        chain=member_chains[0] if member_chains else None,
    )


def extract(path, mime: str, depth: int = 0) -> Optional[ExtractedDoc]:
    """Top-level entry point used by the registry.

    `path` accepts both `str` and `pathlib.Path` because Phase 1 callers
    use strings while Phase 2 spec docs use Path; `os.fspath` reconciles.
    `depth` is forwarded by `registry._call_handler` because this
    function's signature declares it (per the recursion contract).
    """
    if mime not in SUPPORTED_MIMES:
        return None
    p = Path(os.fspath(path))
    if mime in {"application/zip", "application/x-zip-compressed"}:
        return _extract_zip(p, depth)
    return _extract_tar(p, depth)
