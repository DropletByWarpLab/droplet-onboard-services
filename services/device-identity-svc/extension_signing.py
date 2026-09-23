"""WARP-2900 (ADR-056 slice H1): what the box extension key will sign.

The device-identity sidecar holds two keys. The device-id key proves "this
box" to HQ (cert PoP, overlay, audit root, hardware BOM). The extension key,
added here, signs exactly one kind of message: an extension statement the
owner promoted on this box. Keeping them apart means a bug or a compromise in
one signing flow can never produce a signature the other flow accepts.

The sidecar, not its caller, decides what the extension key signs:

  1. the statement must be a UTF-8 JSON object of at most
     MAX_STATEMENT_BYTES, with no duplicate keys;
  2. it must declare kind == "extension" AND keyUsage == "extension";
  3. the bytes actually signed are EXTENSION_STATEMENT_PREFIX || statement.

The prefix is a domain separator. No other message this box signs starts
with it (the device-key flows use "droplet-cert:v1:", "droplet-overlay-*:v1:"
and friends, or bare canonical JSON), so an extension signature can never be
replayed as one of those, and none of those can be replayed as an extension
signature. The orchestrator verifier (apps/orchestrator/src/services/
update-agent/extension-verify.ts) mirrors the literal, and a drift test there
reads this file as text.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

# Changing this is a protocol version bump: every box-signed extension
# statement stops verifying.
EXTENSION_STATEMENT_PREFIX = b"droplet-extension-statement:v1:"

EXTENSION_KEY_USAGE = "extension"

# Storage file for the extension key. Never "device-id.sealed".
EXTENSION_KEY_FILE = "extension-signing.sealed"

# A statement is a handful of short fields (ids, a semver, two git SHAs, a
# sha256). 4 KiB is far above any legitimate one and bounds what a caller can
# make the sidecar parse.
MAX_STATEMENT_BYTES = 4096

EXTENSION_SIGNATURE_ALGORITHM = "ECDSA-P256-SHA256"


class StatementRefused(ValueError):
    """The statement is not something the extension key signs."""


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise StatementRefused(f"duplicate key {key!r} in statement")
        out[key] = value
    return out


def validate_statement(statement: bytes) -> dict[str, Any]:
    """Parse and check a statement. Raises StatementRefused on anything the
    extension key must not sign; returns the parsed object otherwise."""
    if not isinstance(statement, (bytes, bytearray)):
        raise StatementRefused("statement must be bytes")
    if len(statement) == 0:
        raise StatementRefused("statement is empty")
    if len(statement) > MAX_STATEMENT_BYTES:
        raise StatementRefused(
            f"statement is {len(statement)} bytes; the limit is {MAX_STATEMENT_BYTES}"
        )
    try:
        text = bytes(statement).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise StatementRefused("statement is not UTF-8") from exc
    try:
        parsed = json.loads(text, object_pairs_hook=_no_duplicate_keys)
    except StatementRefused:
        raise
    except ValueError as exc:
        raise StatementRefused("statement is not JSON") from exc
    if not isinstance(parsed, dict):
        raise StatementRefused("statement is not a JSON object")
    if parsed.get("kind") != EXTENSION_KEY_USAGE:
        raise StatementRefused("statement kind is not 'extension'")
    if parsed.get("keyUsage") != EXTENSION_KEY_USAGE:
        raise StatementRefused("statement keyUsage is not 'extension'")
    return parsed


def signing_envelope(statement: bytes) -> bytes:
    """The exact bytes the extension key signs. Validates first, so no code
    path can reach the key with a statement the sidecar would refuse."""
    validate_statement(statement)
    return EXTENSION_STATEMENT_PREFIX + bytes(statement)


def spki_fingerprint(spki_der: bytes) -> str:
    """"sha256:<hex>" over the SubjectPublicKeyInfo DER bytes."""
    return "sha256:" + hashlib.sha256(spki_der).hexdigest()
