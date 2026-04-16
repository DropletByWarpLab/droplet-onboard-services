"""Tests for rate limiting middleware."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from middleware.rate_limit import _InMemoryBackend, _client_ip


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
    """Test X-Forwarded-For parsing — must not be spoofable."""

    def _make_request(
        self,
        xff: str | None = None,
        real_ip: str | None = None,
        peer: str = "10.0.0.1",
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
        req = self._make_request(None, peer="10.0.0.5")
        assert _client_ip(req) == "10.0.0.5"

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


class TestRateLimitEndpoint:
    """Test rate limiting via the FastAPI app."""

    async def test_non_chat_endpoints_not_rate_limited(self, client):
        # Health endpoint should never be rate-limited
        for _ in range(5):
            resp = await client.get("/ai/health")
            assert resp.status_code == 200
            assert "X-RateLimit-Limit" not in resp.headers

    async def test_chat_endpoint_has_rate_limit_headers(self, client):
        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": [{"role": "user", "content": "hi"}],
            },
        )
        # Request may fail at provider level (502) but should still have rate-limit headers
        if resp.status_code != 429:
            assert "X-RateLimit-Limit" in resp.headers
            assert "X-RateLimit-Remaining" in resp.headers
