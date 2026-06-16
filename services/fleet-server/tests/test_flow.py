"""Issuance background-task flow (issuance/flow.py).

run_order_flow: pending -> (ACME dance) -> active | failed. The leaf
metadata is parsed off the returned fullchain and persisted. A failure
during the ACME dance lands the row in 'failed' with last_error, never
leaves it stuck in 'pending'.
"""

from __future__ import annotations

import datetime

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from issuance import flow
from schemas import CertStatus
from tests.fakes import FakeAcmeIssuer, FakeRepository


def _leaf(fqdn, days=90):
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, fqdn)])
    nb = datetime.datetime(2026, 6, 13, tzinfo=datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject).issuer_name(subject)
        .public_key(key.public_key()).serial_number(42)
        .not_valid_before(nb).not_valid_after(nb + datetime.timedelta(days=days))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(fqdn)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM).decode("ascii")


@pytest.mark.asyncio
async def test_order_flow_success_marks_active_with_metadata():
    fqdn = "d-abc.devices.warp-lab.ai"
    repo = FakeRepository()
    await repo.upsert_cert_pending(
        device_id="dev1", public_label="d-abc", fqdn=fqdn,
        order_id="ord1", csr_fingerprint="fp1", csr_pem="CSR",
    )
    issuer = FakeAcmeIssuer(fullchain=_leaf(fqdn))

    await flow.run_order_flow(
        repo=repo, issuer=issuer, device_id="dev1", csr_pem="CSR", fqdn=fqdn
    )

    cert = await repo.get_cert("dev1")
    assert cert.status == CertStatus.ACTIVE
    assert cert.fullchain_pem is not None
    assert cert.cert_serial == format(42, "x")
    assert cert.not_after.year == 2026
    assert issuer.ordered == [("CSR", fqdn)]


@pytest.mark.asyncio
async def test_order_flow_failure_marks_failed_not_stuck_pending():
    fqdn = "d-abc.devices.warp-lab.ai"
    repo = FakeRepository()
    await repo.upsert_cert_pending(
        device_id="dev1", public_label="d-abc", fqdn=fqdn,
        order_id="ord1", csr_fingerprint="fp1", csr_pem="CSR",
    )
    issuer = FakeAcmeIssuer(fail=True)

    await flow.run_order_flow(
        repo=repo, issuer=issuer, device_id="dev1", csr_pem="CSR", fqdn=fqdn
    )

    cert = await repo.get_cert("dev1")
    assert cert.status == CertStatus.FAILED
    assert cert.last_error and "ACME" in cert.last_error
