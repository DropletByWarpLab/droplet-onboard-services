"""WARP-154 — IP-geolocation contract.

The contract these tests pin:

  - `get_geo()` returns env-pinned location + timezone if BOTH are set
    (no HTTP call).
  - With env empty, makes ONE HTTP GET to ipapi.co (or override) and
    parses the JSON.
  - Handles ipapi.co's response shape (city / region / country_name /
    timezone) AND ip-api.com's shape (city / regionName / country /
    timezone) — swap-friendly via the GEO_URL env.
  - On HTTP error / non-JSON / rate-limit response → returns UTC
    fallback, NEVER raises.
  - Partial env (only DROPLET_LOCATION set, TZ not, or vice versa)
    blends env override with web-lookup fallback for the missing field.

We swap in `httpx.MockTransport` so we exercise httpx end-to-end
without a real network. No external geolocation service called.
"""
from __future__ import annotations

import json

import httpx
import pytest

from voice.geo import (
    DEFAULT_GEO_URL,
    UNKNOWN_TIMEZONE,
    GeoLocation,
    _fetch_via_ipapi,
    get_geo,
)


def _install_mock_transport(monkeypatch, handler):
    """Patch httpx.get to route through a MockTransport. Captures
    every request for assertions. Same plumbing as test_llm.py."""
    captured: list[httpx.Request] = []

    def _record(req: httpx.Request) -> httpx.Response:
        captured.append(req)
        return handler(req)

    transport = httpx.MockTransport(_record)
    client = httpx.Client(transport=transport)

    def _patched_get(url, **kwargs):
        return client.get(url, **kwargs)

    monkeypatch.setattr(httpx, "get", _patched_get)
    return captured


# ────────────────────────────────────────────────────────────────────
# Env-pinned path (no HTTP)
# ────────────────────────────────────────────────────────────────────

class TestEnvPinned:
    def test_both_env_pinned_skips_web_lookup(self, monkeypatch):
        # Both env vars set → no HTTP call, just return them.
        monkeypatch.setenv("DROPLET_LOCATION", "Greenwich, CT, USA")
        monkeypatch.setenv("TZ", "America/New_York")
        captured = _install_mock_transport(
            monkeypatch, lambda req: httpx.Response(500),
        )
        geo = get_geo()
        assert geo.description == "Greenwich, CT, USA"
        assert geo.timezone == "America/New_York"
        assert geo.source == "env"
        assert captured == []  # NO network call

    def test_only_location_pinned_falls_through_to_web(self, monkeypatch):
        # Operator pinned location but not TZ. Web lookup runs to
        # supply the timezone; location stays env-pinned.
        monkeypatch.setenv("DROPLET_LOCATION", "MyHouse")
        monkeypatch.delenv("TZ", raising=False)
        def handler(req):
            return httpx.Response(200, json={
                "city": "Lab",
                "region": "Region",
                "country_name": "Country",
                "timezone": "America/Los_Angeles",
            })
        _install_mock_transport(monkeypatch, handler)
        geo = get_geo()
        assert geo.description == "MyHouse"  # env wins
        assert geo.timezone == "America/Los_Angeles"  # from web

    def test_only_tz_pinned_falls_through_to_web(self, monkeypatch):
        monkeypatch.delenv("DROPLET_LOCATION", raising=False)
        monkeypatch.setenv("TZ", "Europe/London")
        def handler(req):
            return httpx.Response(200, json={
                "city": "Paris", "region": "Île-de-France",
                "country_name": "France", "timezone": "Europe/Paris",
            })
        _install_mock_transport(monkeypatch, handler)
        geo = get_geo()
        assert geo.description == "Paris, Île-de-France, France"
        assert geo.timezone == "Europe/London"  # env wins


# ────────────────────────────────────────────────────────────────────
# Web lookup happy path
# ────────────────────────────────────────────────────────────────────

class TestWebLookup:
    def test_ipapi_co_response_parses(self, monkeypatch):
        monkeypatch.delenv("DROPLET_LOCATION", raising=False)
        monkeypatch.delenv("TZ", raising=False)
        monkeypatch.delenv("GEO_URL", raising=False)

        def handler(req):
            assert "ipapi.co" in str(req.url)
            return httpx.Response(200, json={
                "ip": "1.2.3.4",
                "city": "Los Angeles",
                "region": "California",
                "country_name": "United States",
                "timezone": "America/Los_Angeles",
                "latitude": 34.05,
                "longitude": -118.25,
            })
        _install_mock_transport(monkeypatch, handler)

        geo = get_geo()
        assert geo.description == "Los Angeles, California, United States"
        assert geo.timezone == "America/Los_Angeles"
        assert geo.source == "ipapi.co"

    def test_ip_api_com_alternate_shape_via_geo_url_override(self, monkeypatch):
        # ip-api.com uses different field names. Verify GEO_URL override
        # works AND alternate shape is normalized correctly.
        monkeypatch.delenv("DROPLET_LOCATION", raising=False)
        monkeypatch.delenv("TZ", raising=False)
        monkeypatch.setenv("GEO_URL", "http://ip-api.com/json/")

        def handler(req):
            return httpx.Response(200, json={
                "city": "Tokyo",
                "regionName": "Tokyo",
                "country": "Japan",
                "timezone": "Asia/Tokyo",
            })
        _install_mock_transport(monkeypatch, handler)

        geo = get_geo()
        assert geo.description == "Tokyo, Tokyo, Japan"
        assert geo.timezone == "Asia/Tokyo"
        assert geo.source == "ip-api.com"

    def test_partial_response_uses_what_it_can(self, monkeypatch):
        # Only city + timezone, no region/country. Description still
        # built from what's there.
        monkeypatch.delenv("DROPLET_LOCATION", raising=False)
        monkeypatch.delenv("TZ", raising=False)
        def handler(req):
            return httpx.Response(200, json={
                "city": "Reykjavik",
                "timezone": "Atlantic/Reykjavik",
            })
        _install_mock_transport(monkeypatch, handler)

        geo = get_geo()
        assert geo.description == "Reykjavik"
        assert geo.timezone == "Atlantic/Reykjavik"


# ────────────────────────────────────────────────────────────────────
# Failure / fallback paths — must NEVER raise
# ────────────────────────────────────────────────────────────────────

class TestFallback:
    def test_http_500_falls_back_to_utc(self, monkeypatch):
        monkeypatch.delenv("DROPLET_LOCATION", raising=False)
        monkeypatch.delenv("TZ", raising=False)
        _install_mock_transport(monkeypatch, lambda r: httpx.Response(500))
        geo = get_geo()
        assert geo.description is None
        assert geo.timezone == UNKNOWN_TIMEZONE
        assert geo.source == "fallback"

    def test_transport_error_falls_back(self, monkeypatch):
        monkeypatch.delenv("DROPLET_LOCATION", raising=False)
        monkeypatch.delenv("TZ", raising=False)
        def handler(req):
            raise httpx.ConnectError("connection refused")
        _install_mock_transport(monkeypatch, handler)
        geo = get_geo()
        assert geo.timezone == UNKNOWN_TIMEZONE
        assert geo.source == "fallback"

    def test_non_json_response_falls_back(self, monkeypatch):
        monkeypatch.delenv("DROPLET_LOCATION", raising=False)
        monkeypatch.delenv("TZ", raising=False)
        _install_mock_transport(
            monkeypatch,
            lambda r: httpx.Response(200, content=b"not json"),
        )
        geo = get_geo()
        assert geo.source == "fallback"

    def test_rate_limit_error_response_falls_back(self, monkeypatch):
        # ipapi.co rate-limit responds with {"error":True,"reason":"..."}
        monkeypatch.delenv("DROPLET_LOCATION", raising=False)
        monkeypatch.delenv("TZ", raising=False)
        _install_mock_transport(
            monkeypatch,
            lambda r: httpx.Response(200, json={
                "error": True, "reason": "RateLimited",
            }),
        )
        geo = get_geo()
        assert geo.source == "fallback"

    def test_empty_response_falls_back(self, monkeypatch):
        # Lookup succeeded but returned nothing useful.
        monkeypatch.delenv("DROPLET_LOCATION", raising=False)
        monkeypatch.delenv("TZ", raising=False)
        _install_mock_transport(
            monkeypatch,
            lambda r: httpx.Response(200, json={}),
        )
        geo = get_geo()
        assert geo.timezone == UNKNOWN_TIMEZONE

    def test_partial_env_with_web_failure_keeps_env(self, monkeypatch):
        # Operator pinned location, web lookup fails, no TZ env.
        # We respect the location env even on lookup failure.
        monkeypatch.setenv("DROPLET_LOCATION", "MyHouse")
        monkeypatch.delenv("TZ", raising=False)
        _install_mock_transport(monkeypatch, lambda r: httpx.Response(500))
        geo = get_geo()
        assert geo.description == "MyHouse"
        assert geo.timezone == UNKNOWN_TIMEZONE


# ────────────────────────────────────────────────────────────────────
# Direct fetcher unit tests (skip env-overlay layer)
# ────────────────────────────────────────────────────────────────────

class TestFetcherDirect:
    def test_fetcher_returns_geolocation_dataclass(self, monkeypatch):
        monkeypatch.delenv("GEO_URL", raising=False)
        def handler(req):
            return httpx.Response(200, json={
                "city": "X", "country_name": "Y",
                "timezone": "America/New_York",
            })
        _install_mock_transport(monkeypatch, handler)
        result = _fetch_via_ipapi()
        assert isinstance(result, GeoLocation)
        assert result.description == "X, Y"
        assert result.timezone == "America/New_York"

    def test_fetcher_returns_none_on_error(self, monkeypatch):
        _install_mock_transport(monkeypatch, lambda r: httpx.Response(503))
        assert _fetch_via_ipapi() is None

    def test_source_label_uses_parsed_hostname_not_substring(self, monkeypatch):
        # CodeQL py/incomplete-url-substring-sanitization: a lookalike host
        # that merely CONTAINS "ip-api.com" must not be labelled as it.
        lookalike = "https://ip-api.com.example.net/json/"
        monkeypatch.setenv("GEO_URL", lookalike)
        _install_mock_transport(monkeypatch, lambda r: httpx.Response(200, json={
            "city": "X", "country": "Y", "timezone": "Asia/Tokyo",
        }))
        result = _fetch_via_ipapi()
        assert result is not None
        assert result.source == lookalike

    def test_source_label_accepts_subdomain_of_known_host(self, monkeypatch):
        monkeypatch.setenv("GEO_URL", "https://pro.ip-api.com/json/")
        _install_mock_transport(monkeypatch, lambda r: httpx.Response(200, json={
            "city": "X", "country": "Y", "timezone": "Asia/Tokyo",
        }))
        result = _fetch_via_ipapi()
        assert result is not None
        assert result.source == "ip-api.com"
