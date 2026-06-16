"""Leaf-cert metadata extraction (acme_issuance/certinfo.py).

After ACME finalize returns a fullchain PEM, we pull serial / not_before
/ not_after off the leaf to store on the device_certificates row.
"""

from __future__ import annotations

import datetime

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from acme_issuance import certinfo


def _make_leaf(fqdn="d-abc.devices.warp-lab.ai", days=90):
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, fqdn)])
    not_before = datetime.datetime(2026, 6, 13, tzinfo=datetime.timezone.utc)
    not_after = not_before + datetime.timedelta(days=days)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(123456789)
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(fqdn)]), critical=False
        )
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM).decode("ascii")


def test_parses_leaf_metadata():
    pem = _make_leaf()
    info = certinfo.parse_leaf(pem)
    assert info.serial == format(123456789, "x")
    assert info.not_after.year == 2026
    assert info.not_before.tzinfo is not None  # tz-aware
    assert info.not_after.tzinfo is not None


def test_parses_first_cert_of_fullchain():
    # A fullchain is leaf + intermediate(s) concatenated; we read the leaf.
    leaf = _make_leaf(fqdn="d-leaf.devices.warp-lab.ai")
    intermediate = _make_leaf(fqdn="intermediate.example")
    fullchain = leaf + intermediate
    info = certinfo.parse_leaf(fullchain)
    assert info.san == "d-leaf.devices.warp-lab.ai"
