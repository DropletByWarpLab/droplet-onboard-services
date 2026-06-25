"""WARP-560: inbound service-to-service auth on /ai/* routes.

The gateway previously had NO inbound auth — chat, session reads, and BYOK key
CRUD were reachable by anything that could open the socket. The
ServiceAuthMiddleware now requires a Bearer service token on every /ai/* route
except the /ai/health liveness probe, and records the forwarded end-user
principal so session ownership can be scoped.
"""

import pytest

import main
from main import PRINCIPAL_HEADER


_TOKEN = "test-ai-gateway-service-token"


@pytest.fixture
def auth_enabled(monkeypatch):
    """Turn on inbound auth by setting the module-level service token.

    The middleware reads ``main.SERVICE_TOKEN_AI_GATEWAY`` on every request, so
    patching the global is enough (no app rebuild needed)."""
    monkeypatch.setattr(main, "SERVICE_TOKEN_AI_GATEWAY", _TOKEN)
    yield _TOKEN


class TestInboundAuthDevEscapeHatch:
    """With no token configured AND AI_GATEWAY_ALLOW_NO_AUTH=1 the gate is a
    no-op so local dev + the bulk of the suite keep working. conftest sets the
    opt-in for exactly this reason."""

    async def test_unauthenticated_allowed_when_opt_in_set(self, client):
        # conftest sets AI_GATEWAY_ALLOW_NO_AUTH=1 and no service token →
        # middleware passes through.
        resp = await client.get("/ai/keys")
        assert resp.status_code == 200


class TestInboundAuthFailsClosed:
    """The HIGH bug this fixes: a blank SERVICE_TOKEN_AI_GATEWAY (failed secret
    injection in prod) must NOT serve /ai/* unauthenticated. With the opt-in
    cleared, every non-health route is refused."""

    @pytest.fixture
    def fail_closed(self, monkeypatch):
        # Blank token + opt-in off = production-shaped misconfiguration.
        monkeypatch.setattr(main, "SERVICE_TOKEN_AI_GATEWAY", "")
        monkeypatch.setattr(main, "AI_GATEWAY_ALLOW_NO_AUTH", False)
        yield

    async def test_health_still_exempt_when_failing_closed(self, client, fail_closed):
        # Liveness probe must answer even in the fail-closed state.
        resp = await client.get("/ai/health")
        assert resp.status_code == 200

    async def test_keys_refused_when_failing_closed(self, client, fail_closed):
        resp = await client.get("/ai/keys")
        assert resp.status_code == 401

    async def test_chat_refused_when_failing_closed(self, client, fail_closed):
        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": [{"role": "user", "content": "hi"}],
                "stream": False,
            },
        )
        assert resp.status_code == 401

    async def test_refused_even_with_a_bearer_token(self, client, fail_closed):
        # No configured secret to match against → any presented token is refused.
        resp = await client.get(
            "/ai/keys", headers={"Authorization": "Bearer anything"}
        )
        assert resp.status_code == 401


class TestInboundAuthEnforced:
    async def test_health_is_always_exempt(self, client, auth_enabled):
        # Liveness probe must answer tokenless (compose healthcheck / ops probe).
        resp = await client.get("/ai/health")
        assert resp.status_code == 200

    async def test_unauthenticated_keys_rejected(self, client, auth_enabled):
        resp = await client.get("/ai/keys")
        assert resp.status_code == 401

    async def test_unauthenticated_chat_rejected(self, client, auth_enabled):
        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": [{"role": "user", "content": "hi"}],
                "stream": False,
            },
        )
        assert resp.status_code == 401

    async def test_wrong_token_rejected(self, client, auth_enabled):
        resp = await client.get(
            "/ai/keys", headers={"Authorization": "Bearer not-the-token"}
        )
        assert resp.status_code == 401

    async def test_non_ascii_token_rejected_not_500(self, client, auth_enabled):
        # A non-ASCII Authorization header (raw bytes on the wire, latin-1
        # decoded by Starlette into a str with non-ASCII codepoints) must
        # produce a clean 401, not a 500 from hmac.compare_digest raising
        # TypeError on two str operands. Encoding both operands keeps the
        # compare byte-safe. Header passed as bytes so httpx forwards it
        # verbatim instead of ASCII-encoding it client-side.
        resp = await client.get(
            "/ai/keys",
            headers={"Authorization": "Bearer café-tøken-ñ".encode("utf-8")},
        )
        assert resp.status_code == 401

    async def test_bare_token_without_bearer_prefix_accepted(
        self, client, auth_enabled, keys_dir
    ):
        # Mirrors services/switch/main.py: `removeprefix("Bearer ")` leaves a
        # bare correctly-valued token unchanged, so it still matches. This is
        # not a weakness — it still requires knowing the secret — and keeping
        # the exact switch behavior avoids gratuitous divergence.
        resp = await client.get("/ai/keys", headers={"Authorization": _TOKEN})
        assert resp.status_code == 200

    async def test_correct_token_passes(self, client, auth_enabled, keys_dir):
        resp = await client.get(
            "/ai/keys", headers={"Authorization": f"Bearer {_TOKEN}"}
        )
        assert resp.status_code == 200
        assert resp.json()["providers"] == []


class TestSessionOwnershipScoping:
    """WARP-560: a non-owner cannot read another principal's session."""

    @staticmethod
    def _auth(principal: str) -> dict:
        return {
            "Authorization": f"Bearer {_TOKEN}",
            PRINCIPAL_HEADER: principal,
        }

    async def test_owner_can_read_non_owner_cannot(
        self, client_with_sessions, auth_enabled
    ):
        # Alice creates a session.
        create = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3.2:3b", "title": "Alice's chat"},
            headers=self._auth("alice"),
        )
        assert create.status_code == 201
        sid = create.json()["id"]

        # Alice reads it back — allowed.
        own = await client_with_sessions.get(
            f"/ai/sessions/{sid}", headers=self._auth("alice")
        )
        assert own.status_code == 200
        assert own.json()["id"] == sid

        # Bob tries to read Alice's session — 404 (do not confirm existence).
        other = await client_with_sessions.get(
            f"/ai/sessions/{sid}", headers=self._auth("bob")
        )
        assert other.status_code == 404

    async def test_non_owner_cannot_delete(
        self, client_with_sessions, auth_enabled
    ):
        create = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3.2:3b"},
            headers=self._auth("alice"),
        )
        sid = create.json()["id"]

        # Bob's delete is refused...
        resp = await client_with_sessions.delete(
            f"/ai/sessions/{sid}", headers=self._auth("bob")
        )
        assert resp.status_code == 404

        # ...and the session still exists for Alice.
        still = await client_with_sessions.get(
            f"/ai/sessions/{sid}", headers=self._auth("alice")
        )
        assert still.status_code == 200
