"""Tests for rate limiting middleware."""

from __future__ import annotations

import asyncio
import ipaddress
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import middleware.rate_limit as rl
from middleware.rate_limit import _InMemoryBackend, _client_ip, _parse_trusted_proxies


class TestInMemoryRateLimiter:
    """Test the in-memory sliding window rate limiter."""

    @pytest.fixture
    def backend(self):
        return _InMemoryBackend()

    async def test_allows_requests_under_limit(self, backend):
        allowed, remaining, retry_after = await backend.check_and_increment("ip1")
        assert allowed is True
        assert remaining >= 0
        assert retry_after == 0

    async def test_tracks_remaining_count(self, backend):
        _, remaining1, _ = await backend.check_and_increment("ip1")
        _, remaining2, _ = await backend.check_and_increment("ip1")
        assert remaining2 == remaining1 - 1

    @patch("middleware.rate_limit.RATE_LIMIT_RPM", 3)
    async def test_blocks_when_limit_reached(self):
        backend = _InMemoryBackend()
        for _ in range(3):
            allowed, _, _ = await backend.check_and_increment("ip1")
            assert allowed is True

        allowed, remaining, retry_after = await backend.check_and_increment("ip1")
        assert allowed is False
        assert remaining == 0
        assert retry_after > 0

    @patch("middleware.rate_limit.RATE_LIMIT_BURST", 2)
    async def test_burst_protection(self):
        backend = _InMemoryBackend()
        await backend.check_and_increment("ip1")
        await backend.check_and_increment("ip1")
        allowed, _, retry_after = await backend.check_and_increment("ip1")
        assert allowed is False
        assert retry_after == 2

    async def test_separate_keys_are_independent(self, backend):
        for _ in range(5):
            await backend.check_and_increment("ip1")

        allowed, _, _ = await backend.check_and_increment("ip2")
        assert allowed is True


class TestClientIpExtraction:
    """Test X-Forwarded-For / X-Real-IP parsing.

    GW-14: forwarding headers are only trusted when the DIRECT socket peer is a
    configured trusted proxy. The trusted-proxy peer used throughout is
    10.0.0.1 (set via the autouse fixture below). A non-trusted peer must have
    its headers ignored entirely.
    """

    TRUSTED_PEER = "10.0.0.1"

    @pytest.fixture(autouse=True)
    def _trust_the_test_peer(self, monkeypatch):
        # Treat the default test peer as the nginx edge so the header-trust
        # paths are exercised. Untrusted-peer tests override req.client.host.
        monkeypatch.setattr(
            rl, "TRUSTED_PROXIES", [ipaddress.ip_network("10.0.0.1/32")]
        )

    def _make_request(
        self,
        xff: str | None = None,
        real_ip: str | None = None,
        peer: str = TRUSTED_PEER,
    ):
        req = MagicMock()
        headers_map = {}
        if xff is not None:
            headers_map["x-forwarded-for"] = xff
        if real_ip is not None:
            headers_map["x-real-ip"] = real_ip
        headers = MagicMock()
        headers.get = lambda k, default=None: headers_map.get(k, default)
        req.headers = headers
        req.client = MagicMock()
        req.client.host = peer
        return req

    def test_prefers_x_real_ip_over_xff(self):
        """nginx sets X-Real-IP from $remote_addr (cannot be spoofed). Trust it first."""
        req = self._make_request(xff="spoofed-1, spoofed-2", real_ip="192.168.1.100")
        assert _client_ip(req) == "192.168.1.100"

    def test_uses_x_real_ip_only(self):
        req = self._make_request(real_ip="10.1.2.3")
        assert _client_ip(req) == "10.1.2.3"

    def test_uses_rightmost_xff_entry(self):
        """Right-most entry is the one appended by our trusted nginx — not spoofable."""
        req = self._make_request("spoofed-client-value, 192.168.1.100")
        assert _client_ip(req) == "192.168.1.100"

    def test_ignores_leftmost_spoofed_value(self):
        """A client sending X-Forwarded-For: attacker-ip must not be taken as the IP."""
        req = self._make_request("1.1.1.1, 2.2.2.2, 192.168.1.100")
        assert _client_ip(req) == "192.168.1.100"

    def test_falls_back_to_peer_when_no_xff(self):
        req = self._make_request(None, peer="10.0.0.1")
        assert _client_ip(req) == "10.0.0.1"

    def test_handles_whitespace(self):
        req = self._make_request("  1.2.3.4  ,  5.6.7.8  ")
        assert _client_ip(req) == "5.6.7.8"

    def test_rate_limit_bypass_resistant(self):
        """
        Regression test: if we take split[0] we'd credit "attacker-rotated-ip"
        and allow unlimited requests. Taking split[-1] pins all requests to
        the real nginx-appended IP.
        """
        shared_real_ip = "192.168.1.100"
        req1 = self._make_request(f"attacker-ip-1, {shared_real_ip}")
        req2 = self._make_request(f"attacker-ip-2, {shared_real_ip}")
        req3 = self._make_request(f"attacker-ip-3, {shared_real_ip}")
        assert _client_ip(req1) == shared_real_ip
        assert _client_ip(req2) == shared_real_ip
        assert _client_ip(req3) == shared_real_ip

    # --- GW-14: untrusted peer must NOT be able to spoof its bucket ---

    def test_untrusted_peer_headers_ignored(self):
        """A direct (non-proxy) caller's X-Real-IP / XFF are ignored; we key on
        the socket peer instead."""
        req = self._make_request(
            xff="9.9.9.9", real_ip="8.8.8.8", peer="172.30.0.42"
        )
        assert _client_ip(req) == "172.30.0.42"

    def test_untrusted_peer_cannot_rotate_buckets(self):
        """The core bypass: a compose-network container rotating X-Real-IP must
        still be keyed on its real (single) socket peer."""
        attacker_peer = "172.30.0.42"
        req1 = self._make_request(real_ip="fake-1", peer=attacker_peer)
        req2 = self._make_request(real_ip="fake-2", peer=attacker_peer)
        req3 = self._make_request(real_ip="fake-3", peer=attacker_peer)
        assert _client_ip(req1) == attacker_peer
        assert _client_ip(req2) == attacker_peer
        assert _client_ip(req3) == attacker_peer

    def test_no_trusted_proxies_configured_uses_peer(self, monkeypatch):
        """Default posture (empty TRUSTED_PROXIES): always key on the socket peer."""
        monkeypatch.setattr(rl, "TRUSTED_PROXIES", [])
        req = self._make_request(real_ip="8.8.8.8", peer="10.0.0.1")
        assert _client_ip(req) == "10.0.0.1"


class TestTrustedProxyParsing:
    """GW-14: RATE_LIMIT_TRUSTED_PROXIES parsing."""

    def test_parses_ips_and_cidrs(self):
        nets = _parse_trusted_proxies("172.18.0.5, 10.0.0.0/8")
        assert ipaddress.ip_address("172.18.0.5") in nets[0]
        assert ipaddress.ip_address("10.1.2.3") in nets[1]

    def test_skips_malformed_entries(self):
        nets = _parse_trusted_proxies("not-an-ip, 10.0.0.0/8, , garbage")
        assert len(nets) == 1
        assert ipaddress.ip_address("10.255.255.255") in nets[0]

    def test_empty_string_yields_no_proxies(self):
        assert _parse_trusted_proxies("") == []


class TestRateLimitEndpoint:
    """Test rate limiting via the FastAPI app."""

    async def test_non_chat_endpoints_not_rate_limited(self, client):
        # Health endpoint should never be rate-limited
        for _ in range(5):
            resp = await client.get("/ai/health")
            assert resp.status_code == 200
            assert "X-RateLimit-Limit" not in resp.headers

    async def test_chat_endpoint_has_rate_limit_headers(self, client, monkeypatch):
        # The /ai/chat response must carry the rate-limit headers even when the
        # provider call fails. We force a deterministic provider failure so the
        # test never makes a REAL network call: httpx's ASGITransport does not
        # run the app lifespan, so in the full suite this endpoint would reach a
        # real ProviderRouter left in module state by an earlier test and hang on
        # a connect to the unreachable OLLAMA_URL (this is the test that has been
        # cancelling the ai-gateway CI job at ~15m). Mocking the module globals
        # makes it fast, deterministic, and order-independent.
        import main

        done: asyncio.Future = asyncio.get_running_loop().create_future()
        done.set_result(None)
        fake_scheduler = AsyncMock()
        fake_scheduler.enqueue = AsyncMock(return_value=done)
        fake_scheduler.release = AsyncMock()
        monkeypatch.setattr(main, "inference_scheduler", fake_scheduler)

        fake_router = AsyncMock()
        fake_router.chat = AsyncMock(side_effect=RuntimeError("provider unreachable"))
        monkeypatch.setattr(main, "provider_router", fake_router)

        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": [{"role": "user", "content": "hi"}],
            },
        )
        # Provider failure surfaces as a 502 (GW-08); the rate-limit middleware
        # still stamps the headers on the way out.
        assert resp.status_code == 502
        assert "X-RateLimit-Limit" in resp.headers
        assert "X-RateLimit-Remaining" in resp.headers
