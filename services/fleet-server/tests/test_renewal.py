"""Renewal job (issuance/renewal.py).

The apscheduler daily job renews rows with status=active AND
not_after within RENEW_BEFORE_DAYS. It re-orders against the stored CSR
fingerprint... but renewal needs a CSR. Per the contract, /renew uses the
SAME body as /order (the box re-submits a fresh CSR). The scheduled job
can only renew rows for which it has a stored renewable CSR — so the job
here renews rows the repo reports as renewable using a renew callback,
and marks renewing -> active. We test the SELECTION predicate + the
renewing transition; the actual re-order reuses run_order_flow.
"""

from __future__ import annotations

import datetime

import pytest

from issuance import renewal
from schemas import CertStatus
from tests.fakes import FakeRepository


def _now():
    return datetime.datetime(2026, 6, 13, 12, 0, 0, tzinfo=datetime.timezone.utc)


async def _seed(repo, device_id, days_to_expiry, status=CertStatus.ACTIVE):
    await repo.upsert_cert_pending(
        device_id=device_id, public_label="d-" + device_id,
        fqdn=f"d-{device_id}.devices.warp-lab.ai", order_id="o",
        csr_fingerprint="fp", csr_pem="CSR",
    )
    cert = repo.certs[device_id]
    cert.status = status
    cert.not_after = _now() + datetime.timedelta(days=days_to_expiry)


@pytest.mark.asyncio
async def test_select_renewable_picks_only_within_window():
    repo = FakeRepository()
    await _seed(repo, "near", days_to_expiry=10)    # renew
    await _seed(repo, "far", days_to_expiry=60)     # skip
    await _seed(repo, "expired", days_to_expiry=-1)  # renew

    picked = await renewal.select_renewable(repo, renew_before_days=30, now=_now())
    ids = {c.device_id for c in picked}
    assert ids == {"near", "expired"}


@pytest.mark.asyncio
async def test_select_renewable_ignores_non_active():
    repo = FakeRepository()
    await _seed(repo, "revoked", days_to_expiry=5, status=CertStatus.REVOKED)
    await _seed(repo, "pending", days_to_expiry=5, status=CertStatus.PENDING)
    picked = await renewal.select_renewable(repo, renew_before_days=30, now=_now())
    assert picked == []


@pytest.mark.asyncio
async def test_run_renewal_cycle_marks_renewing_then_active(monkeypatch):
    repo = FakeRepository()
    await _seed(repo, "near", days_to_expiry=10)

    transitions = []

    async def fake_renew_one(*, repo, device_id):
        transitions.append(("renewing", device_id))
        await repo.mark_cert_renewing(device_id=device_id)
        # simulate successful re-order
        await repo.mark_cert_active(
            device_id=device_id, fullchain_pem="NEW", cert_serial="ff",
            not_before=_now(),
            not_after=_now() + datetime.timedelta(days=90),
        )
        transitions.append(("active", device_id))

    await renewal.run_renewal_cycle(
        repo, renew_before_days=30, renew_one=fake_renew_one, now=_now()
    )
    assert ("renewing", "near") in transitions
    assert ("active", "near") in transitions
    assert repo.certs["near"].status == CertStatus.ACTIVE
    assert repo.certs["near"].not_after > _now() + datetime.timedelta(days=80)
