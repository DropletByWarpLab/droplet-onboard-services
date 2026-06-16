"""ACME order orchestration (acme_issuance/client.py).

Drives: new_order(external box CSR) -> pick the DNS-01 challenge ->
compute the TXT value -> Cloudflare creates the TXT -> answer challenge
-> finalize -> fetch fullchain -> TXT deleted. The underlying acme
ClientV2 is a fake; the Cloudflare worker is mocked with respx. NO live
LE, NO live Cloudflare.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
import respx

from acme_issuance import client as acme_client
from acme_issuance import cloudflare_dns

CF_BASE = "https://api.cloudflare.com/client/v4"
ZONE = "pytest-fake-zone"
FQDN = "d-abc.devices.warp-lab.ai"


def _ok(result):
    return {"success": True, "errors": [], "messages": [], "result": result}


class _FakeDns01:
    """Stand-in for acme.challenges.DNS01."""

    typ = "dns-01"

    def validation(self, account_key, **_):
        return "TXT-VALIDATION-VALUE"

    def validation_domain_name(self, domain):
        return f"_acme-challenge.{domain}"

    def response(self, account_key, **_):
        return SimpleNamespace()


class _FakeChallengeBody:
    def __init__(self, chall):
        self.chall = chall


class _FakeAuthz:
    def __init__(self, domain, challenges):
        self.body = SimpleNamespace(
            identifier=SimpleNamespace(value=domain),
            challenges=challenges,
        )


class _FakeOrderResource:
    def __init__(self, authorizations, fullchain="FULLCHAIN-PEM"):
        self.authorizations = authorizations
        self.fullchain_pem = fullchain
        self.uri = "https://acme/order/1"


class _FakeAcmeClientV2:
    """Records calls and returns canned order resources."""

    def __init__(self, *, with_dns01=True):
        self.answered = []
        self.finalized = False
        self.new_order_csr = None
        body = _FakeChallengeBody(_FakeDns01()) if with_dns01 else _FakeChallengeBody(
            SimpleNamespace(typ="http-01")
        )
        self._authz = _FakeAuthz(FQDN, [body])

    def new_order(self, csr_pem):
        self.new_order_csr = csr_pem
        return _FakeOrderResource([self._authz])

    def answer_challenge(self, challb, response):
        self.answered.append(challb)
        return SimpleNamespace()

    def poll_and_finalize(self, orderr, deadline=None):
        self.finalized = True
        return _FakeOrderResource(orderr.authorizations, fullchain="FULLCHAIN-PEM")


@pytest.fixture
def cf():
    return cloudflare_dns.CloudflareDns(
        api_token="t", zone_id=ZONE, api_base=CF_BASE,
        propagation_timeout_sec=0, poll_sec=0,
    )


@pytest.mark.asyncio
@respx.mock
async def test_order_certificate_happy_path(cf):
    create = respx.post(f"{CF_BASE}/zones/{ZONE}/dns_records").mock(
        return_value=httpx.Response(200, json=_ok({"id": "rec1"}))
    )
    delete = respx.delete(f"{CF_BASE}/zones/{ZONE}/dns_records/rec1").mock(
        return_value=httpx.Response(200, json=_ok({"id": "rec1"}))
    )
    fake = _FakeAcmeClientV2()
    issuer = acme_client.AcmeIssuer(
        acme_client_v2=fake, account_key=object(), dns=cf, order_timeout_sec=5
    )

    result = await issuer.order_certificate(csr_pem="CSR-PEM", fqdn=FQDN)

    # External box CSR was handed to new_order untouched.
    assert fake.new_order_csr == b"CSR-PEM"
    # DNS-01 challenge was answered, order finalized.
    assert len(fake.answered) == 1
    assert fake.finalized is True
    # Cloudflare TXT created then cleaned up.
    assert create.called and delete.called
    # Returned the chain.
    assert result.fullchain_pem == "FULLCHAIN-PEM"


@pytest.mark.asyncio
@respx.mock
async def test_order_certificate_cleans_txt_when_finalize_raises(cf):
    respx.post(f"{CF_BASE}/zones/{ZONE}/dns_records").mock(
        return_value=httpx.Response(200, json=_ok({"id": "rec1"}))
    )
    delete = respx.delete(f"{CF_BASE}/zones/{ZONE}/dns_records/rec1").mock(
        return_value=httpx.Response(200, json=_ok({"id": "rec1"}))
    )
    fake = _FakeAcmeClientV2()

    def boom(orderr, deadline=None):
        raise RuntimeError("LE finalize failed")

    fake.poll_and_finalize = boom
    issuer = acme_client.AcmeIssuer(
        acme_client_v2=fake, account_key=object(), dns=cf, order_timeout_sec=5
    )

    with pytest.raises(RuntimeError):
        await issuer.order_certificate(csr_pem="CSR-PEM", fqdn=FQDN)
    # TXT still deleted — no orphan record.
    assert delete.called


@pytest.mark.asyncio
async def test_no_dns01_challenge_raises(cf):
    fake = _FakeAcmeClientV2(with_dns01=False)
    issuer = acme_client.AcmeIssuer(
        acme_client_v2=fake, account_key=object(), dns=cf, order_timeout_sec=5
    )
    with pytest.raises(acme_client.AcmeOrderError):
        await issuer.order_certificate(csr_pem="CSR-PEM", fqdn=FQDN)
