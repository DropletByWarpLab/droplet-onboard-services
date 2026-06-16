"""Cloudflare DNS-01 worker (acme_issuance/cloudflare_dns.py).

All Cloudflare HTTP is mocked with respx — NO live Cloudflare. We assert:
  * a TXT record is created at _acme-challenge.<fqdn> with the validation
    value;
  * the record is DELETED afterwards (the publish helper cleans up in a
    finally block even when the body raises);
  * ONLY TXT records are ever created — never A / AAAA (ADR-023 §Decision
    3: no public address record, the home IP is never published).
"""

from __future__ import annotations

import httpx
import pytest
import respx

from acme_issuance import cloudflare_dns

CF_BASE = "https://api.cloudflare.com/client/v4"
ZONE = "pytest-fake-zone"


def _ok(result):
    return {"success": True, "errors": [], "messages": [], "result": result}


@pytest.fixture
def cf():
    return cloudflare_dns.CloudflareDns(
        api_token="t0ken", zone_id=ZONE, api_base=CF_BASE,
        propagation_timeout_sec=0, poll_sec=0,
    )


@pytest.mark.asyncio
@respx.mock
async def test_create_txt_record_posts_only_txt(cf):
    create = respx.post(f"{CF_BASE}/zones/{ZONE}/dns_records").mock(
        return_value=httpx.Response(200, json=_ok({"id": "rec123"}))
    )
    rec_id = await cf.create_txt_record("_acme-challenge.d-abc.devices.warp-lab.ai", "valval")
    assert rec_id == "rec123"
    assert create.called
    body = create.calls.last.request.content.decode()
    assert '"type": "TXT"' in body or '"type":"TXT"' in body
    assert "valval" in body
    # Never an address record.
    assert '"A"' not in body and '"AAAA"' not in body


@pytest.mark.asyncio
@respx.mock
async def test_delete_txt_record(cf):
    delete = respx.delete(f"{CF_BASE}/zones/{ZONE}/dns_records/rec123").mock(
        return_value=httpx.Response(200, json=_ok({"id": "rec123"}))
    )
    await cf.delete_txt_record("rec123")
    assert delete.called


@pytest.mark.asyncio
@respx.mock
async def test_publish_challenge_cleans_up_on_success(cf):
    respx.post(f"{CF_BASE}/zones/{ZONE}/dns_records").mock(
        return_value=httpx.Response(200, json=_ok({"id": "rec123"}))
    )
    delete = respx.delete(f"{CF_BASE}/zones/{ZONE}/dns_records/rec123").mock(
        return_value=httpx.Response(200, json=_ok({"id": "rec123"}))
    )
    ran = {}

    async def body():
        ran["yes"] = True

    await cf.publish_challenge(
        "_acme-challenge.d-abc.devices.warp-lab.ai", "valval", body
    )
    assert ran.get("yes") is True
    assert delete.called  # cleaned up


@pytest.mark.asyncio
@respx.mock
async def test_publish_challenge_cleans_up_even_when_body_raises(cf):
    respx.post(f"{CF_BASE}/zones/{ZONE}/dns_records").mock(
        return_value=httpx.Response(200, json=_ok({"id": "rec123"}))
    )
    delete = respx.delete(f"{CF_BASE}/zones/{ZONE}/dns_records/rec123").mock(
        return_value=httpx.Response(200, json=_ok({"id": "rec123"}))
    )

    async def body():
        raise RuntimeError("ACME finalize blew up")

    with pytest.raises(RuntimeError):
        await cf.publish_challenge(
            "_acme-challenge.d-abc.devices.warp-lab.ai", "valval", body
        )
    # The TXT must STILL be deleted — no orphan record left in public DNS.
    assert delete.called


@pytest.mark.asyncio
@respx.mock
async def test_create_txt_raises_on_cloudflare_error(cf):
    respx.post(f"{CF_BASE}/zones/{ZONE}/dns_records").mock(
        return_value=httpx.Response(
            403, json={"success": False, "errors": [{"message": "bad token"}]}
        )
    )
    with pytest.raises(cloudflare_dns.CloudflareError):
        await cf.create_txt_record("_acme-challenge.d-abc.devices.warp-lab.ai", "v")
