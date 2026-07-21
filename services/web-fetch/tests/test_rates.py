"""GET /rates — ECB daily reference rates, re-based, all upstream calls mocked."""

from __future__ import annotations

import httpx
import pytest

import providers
from tests.conftest import AUTH

ECB_XML = """<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <gesmes:Sender>
    <gesmes:name>European Central Bank</gesmes:name>
  </gesmes:Sender>
  <Cube>
    <Cube time="2026-07-17">
      <Cube currency="USD" rate="1.0824"/>
      <Cube currency="JPY" rate="158.33"/>
      <Cube currency="GBP" rate="0.8531"/>
      <Cube currency="CHF" rate="0.9412"/>
    </Cube>
  </Cube>
</gesmes:Envelope>
"""


@pytest.fixture
def ecb_ok(mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == providers.ECB_HOST
        return httpx.Response(200, text=ECB_XML)

    mock_transport(handler)


def test_rates_rebased_to_usd(client, ecb_ok):
    resp = client.get("/rates?base=USD", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["base"] == "USD"
    assert body["asOf"] == "2026-07-17"

    rates = body["rates"]
    # Base key excluded, EUR present, every other ECB currency present.
    assert "USD" not in rates
    assert set(rates) == {"EUR", "JPY", "GBP", "CHF"}
    # Re-basing arithmetic: rate[Y] = ecb[Y] / ecb[USD]; EUR = 1 / ecb[USD].
    assert rates["EUR"] == pytest.approx(1 / 1.0824, abs=1e-9)
    assert rates["JPY"] == pytest.approx(158.33 / 1.0824, abs=1e-9)
    assert rates["GBP"] == pytest.approx(0.8531 / 1.0824, abs=1e-9)
    assert rates["CHF"] == pytest.approx(0.9412 / 1.0824, abs=1e-9)


def test_rates_default_base_eur_passthrough(client, ecb_ok):
    resp = client.get("/rates", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["base"] == "EUR"
    assert body["asOf"] == "2026-07-17"
    # EUR (the base) absent; ECB values passed through untouched.
    assert body["rates"] == {
        "USD": 1.0824,
        "JPY": 158.33,
        "GBP": 0.8531,
        "CHF": 0.9412,
    }


def test_rates_base_is_case_insensitive(client, ecb_ok):
    resp = client.get("/rates?base=usd", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["base"] == "USD"


def test_unknown_base_returns_400(client, ecb_ok):
    resp = client.get("/rates?base=XXX", headers=AUTH)
    assert resp.status_code == 400
    assert resp.json() == {"detail": "unknown_currency"}


def test_wrong_length_base_is_rejected(client, ecb_ok):
    resp = client.get("/rates?base=US", headers=AUTH)
    assert resp.status_code == 422


def test_ecb_fetch_500_returns_502(client, mock_transport):
    mock_transport(lambda request: httpx.Response(500, text="boom"))
    resp = client.get("/rates", headers=AUTH)
    assert resp.status_code == 502
    assert resp.json() == {"detail": "rates_unavailable"}


def test_ecb_malformed_xml_returns_502(client, mock_transport):
    mock_transport(lambda request: httpx.Response(200, text="<not-xml"))
    resp = client.get("/rates", headers=AUTH)
    assert resp.status_code == 502
    assert resp.json() == {"detail": "rates_unavailable"}


def test_ecb_xml_without_rates_returns_502(client, mock_transport):
    mock_transport(
        lambda request: httpx.Response(200, text="<Envelope><Cube/></Envelope>")
    )
    resp = client.get("/rates", headers=AUTH)
    assert resp.status_code == 502
    assert resp.json() == {"detail": "rates_unavailable"}
