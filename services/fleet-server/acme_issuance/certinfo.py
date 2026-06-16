"""Leaf-cert metadata extraction for the device_certificates row.

After ACME finalize returns a fullchain PEM (leaf first, then
intermediates), we pull the serial + validity window + SAN off the LEAF
to persist on the row. Used to drive the renewal predicate and surface
``not_after`` to the box.
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass

from cryptography import x509


@dataclass(frozen=True)
class LeafInfo:
    serial: str
    not_before: datetime.datetime
    not_after: datetime.datetime
    san: str | None


def parse_leaf(fullchain_pem: str) -> LeafInfo:
    """Parse the FIRST (leaf) certificate from a fullchain PEM."""
    leaf = x509.load_pem_x509_certificate(fullchain_pem.encode("utf-8"))

    san: str | None = None
    try:
        ext = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName)
        dns = ext.value.get_values_for_type(x509.DNSName)
        san = dns[0] if dns else None
    except x509.ExtensionNotFound:
        san = None

    return LeafInfo(
        serial=format(leaf.serial_number, "x"),
        # cryptography >= 42 exposes tz-aware *_utc accessors; prefer them.
        not_before=leaf.not_valid_before_utc,
        not_after=leaf.not_valid_after_utc,
        san=san,
    )
