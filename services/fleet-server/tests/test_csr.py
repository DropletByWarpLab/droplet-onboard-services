"""CSR validation for the issuance contract (issuance/csr.py).

The order contract requires: the CSR is valid, and its ONLY SAN equals
the device's fqdn. We also derive a stable csr_fingerprint for
idempotency keying on (device_id, csr_fingerprint).
"""

from __future__ import annotations

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from issuance import csr as csr_mod


def _make_csr(sans: list[str]) -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    builder = x509.CertificateSigningRequestBuilder().subject_name(
        x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, sans[0])])
    )
    if sans:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(s) for s in sans]),
            critical=False,
        )
    req = builder.sign(key, hashes.SHA256())
    return req.public_bytes(serialization.Encoding.PEM).decode("ascii")


def test_valid_csr_with_single_matching_san_passes():
    fqdn = "d-abcdef0123456789.devices.warp-lab.ai"
    pem = _make_csr([fqdn])
    csr_mod.validate_csr(pem, expected_fqdn=fqdn)  # must not raise


def test_csr_with_wrong_san_rejected():
    pem = _make_csr(["evil.example.com"])
    with pytest.raises(csr_mod.CsrValidationError):
        csr_mod.validate_csr(pem, expected_fqdn="d-aaa.devices.warp-lab.ai")


def test_csr_with_extra_san_rejected():
    fqdn = "d-abc.devices.warp-lab.ai"
    pem = _make_csr([fqdn, "extra.warp-lab.ai"])
    with pytest.raises(csr_mod.CsrValidationError):
        csr_mod.validate_csr(pem, expected_fqdn=fqdn)


def test_csr_with_no_san_rejected():
    # CSR with only a CN, no SAN extension.
    key = ec.generate_private_key(ec.SECP256R1())
    req = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "x")]))
        .sign(key, hashes.SHA256())
    )
    pem = req.public_bytes(serialization.Encoding.PEM).decode("ascii")
    with pytest.raises(csr_mod.CsrValidationError):
        csr_mod.validate_csr(pem, expected_fqdn="d-abc.devices.warp-lab.ai")


def test_malformed_csr_rejected():
    with pytest.raises(csr_mod.CsrValidationError):
        csr_mod.validate_csr("not a real pem", expected_fqdn="d-abc.devices.warp-lab.ai")


def test_csr_with_bad_signature_rejected():
    # Tamper with the PEM body so the embedded self-signature no longer
    # verifies (proof the requester holds the private key).
    fqdn = "d-abc.devices.warp-lab.ai"
    pem = _make_csr([fqdn])
    lines = pem.strip().splitlines()
    # Corrupt a middle base64 line.
    mid = len(lines) // 2
    corrupted = bytearray(lines[mid].encode())
    corrupted[0] = ord("A") if corrupted[0] != ord("A") else ord("B")
    lines[mid] = corrupted.decode()
    bad_pem = "\n".join(lines) + "\n"
    with pytest.raises(csr_mod.CsrValidationError):
        csr_mod.validate_csr(bad_pem, expected_fqdn=fqdn)


def test_csr_fingerprint_is_stable_and_distinct():
    fqdn = "d-abc.devices.warp-lab.ai"
    pem = _make_csr([fqdn])
    fp1 = csr_mod.csr_fingerprint(pem)
    fp2 = csr_mod.csr_fingerprint(pem)
    assert fp1 == fp2
    assert len(fp1) == 64  # sha256 hex
    other = _make_csr([fqdn])
    assert csr_mod.csr_fingerprint(other) != fp1
