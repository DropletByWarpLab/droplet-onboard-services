"""Verify + safely extract the bundled Vosk wake-word model (WARP-154).

Invoked from the voice-io Dockerfile build step. Split out of the inline
`python -c` so the supply-chain checks are reviewable and unit-tested
(`tests/test_fetch_vosk_model.py`) rather than buried in a one-liner.

Two guarantees, both of which fail the build (non-zero exit) when
violated — a tampered artifact must never silently become the acoustic
model Kaldi loads:

  1. SHA-256 pin. The archive at alphacephei.com carries no checksum of
     its own, so we pin the exact release hash and verify the bytes
     before extracting. A swapped/compromised zip mismatches and aborts.

  2. Zip-slip defense. Every member is validated before extraction —
     absolute paths and any `..` traversal are rejected so a malicious
     archive cannot write outside the destination dir. The stdlib's
     `ZipFile.extractall()` has no such guard, so we extract member by
     member through a checked path join.

Network failure is handled by the CALLER (the Dockerfile skips this
script entirely when curl couldn't fetch the zip, so an offline build
still succeeds and falls back to openWakeWord). This script assumes the
zip is present; if it isn't, that's a hard error.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import zipfile


def sha256_of(path: str, *, chunk_size: int = 1 << 20) -> str:
    """Stream the file through SHA-256 (1 MiB chunks — the model is ~40 MB,
    we don't slurp it whole)."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()


def is_member_safe(name: str) -> bool:
    """True iff a zip member name is safe to extract under a dest dir.

    Rejects:
      * absolute POSIX paths (leading '/'),
      * Windows-style absolute / drive paths ('\\\\', 'C:'),
      * any component equal to '..' (parent traversal), including after
        normalising separators.

    Empty names and bare './' are treated as unsafe (nothing legitimate
    in the Vosk archive looks like that).
    """
    if not name:
        return False
    # Normalise Windows separators so '..\\x' is caught too.
    normalised = name.replace("\\", "/")
    if normalised.startswith("/"):
        return False
    # Drive-letter or UNC style.
    if ":" in normalised.split("/", 1)[0]:
        return False
    parts = [p for p in normalised.split("/") if p not in ("", ".")]
    if not parts:
        return False
    return ".." not in parts


def safe_extract(zip_path: str, dest_dir: str) -> None:
    """Extract every member of `zip_path` into `dest_dir`, rejecting any
    member whose path escapes `dest_dir`. Raises ValueError on the first
    unsafe member (before writing it)."""
    dest_root = os.path.realpath(dest_dir)
    os.makedirs(dest_root, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        members = zf.namelist()
        # Validate the WHOLE archive first so we never write a partial,
        # half-trusted tree before discovering a bad member.
        for name in members:
            if not is_member_safe(name):
                raise ValueError(f"unsafe zip member rejected (zip-slip): {name!r}")
            # Second belt-and-braces check: the resolved target must stay
            # inside dest_root even after the OS normalises the join.
            target = os.path.realpath(os.path.join(dest_root, name))
            if target != dest_root and not target.startswith(dest_root + os.sep):
                raise ValueError(f"zip member escapes dest dir: {name!r}")
        zf.extractall(dest_root)  # noqa: S202 — members validated above


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify + extract the Vosk model zip")
    parser.add_argument("--zip", required=True, help="path to the downloaded zip")
    parser.add_argument("--sha256", required=True, help="expected SHA-256 hex digest")
    parser.add_argument("--dest", required=True, help="destination models dir")
    parser.add_argument(
        "--expected-root",
        required=True,
        help="the single top-level dir the archive is expected to contain",
    )
    parser.add_argument(
        "--rename-to",
        required=True,
        help="rename the extracted root dir to this stable name",
    )
    args = parser.parse_args(argv)

    if not os.path.isfile(args.zip):
        print(f"ERROR: zip not found: {args.zip}", file=sys.stderr)
        return 1

    expected = args.sha256.strip().lower()
    actual = sha256_of(args.zip)
    if actual != expected:
        print(
            "ERROR: Vosk model checksum mismatch — refusing to extract a "
            "tampered/unexpected artifact.\n"
            f"  expected: {expected}\n"
            f"  actual:   {actual}",
            file=sys.stderr,
        )
        return 1

    try:
        safe_extract(args.zip, args.dest)
    except (ValueError, zipfile.BadZipFile) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    extracted_root = os.path.join(args.dest, args.expected_root)
    if not os.path.isdir(extracted_root):
        print(
            f"ERROR: expected extracted dir not found: {extracted_root}",
            file=sys.stderr,
        )
        return 1

    final_path = os.path.join(args.dest, args.rename_to)
    if os.path.abspath(extracted_root) != os.path.abspath(final_path):
        if os.path.exists(final_path):
            shutil.rmtree(final_path)
        os.rename(extracted_root, final_path)

    print(
        f"vosk model verified (sha256 ok) and extracted to {final_path}",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
