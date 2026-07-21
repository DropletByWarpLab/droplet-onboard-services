"""WARP-1433 — pooled httpx.Client reuse for the voice → orchestrator hops.

Before this ticket, every `OrchestratorLLM.available` / `reply()` /
`reply_stream()` and every `PersonaFetcher.get_block()` called the
MODULE-level `httpx.get`/`httpx.post`/`httpx.stream`, so each hop paid a
fresh TCP connect + a full internal-mTLS handshake + a CA-file re-read —
and greeting turns pay it twice (persona fetch + chat). Downstream hops
already pool (orchestrator undici, ai-gateway AsyncClient); voice was the
outlier.

The contract these tests pin:

  - Each client object builds ONE `httpx.Client` (via the module-level
    `_new_httpx_client` factory) at construction and REUSES it across every
    turn — the factory is never called again per call.
  - The internal-mTLS material (client cert + CA) rides on the pooled
    Client constructor (built once), not on every request.
  - `close()` releases the pool; it's on the `LLMClient` interface so
    `MockLLM` inherits a safe no-op. `PersonaFetcher.close()` mirrors it.

The streaming SSE path (WARP-626) keeps working on the same pooled Client.
"""
from __future__ import annotations

import httpx

import voice.llm
import voice.persona
from voice.llm import MockLLM, OrchestratorLLM
from voice.persona import PersonaFetcher


def _ok_transport() -> httpx.MockTransport:
    """A transport that answers health (GET) + chat (POST) + persona (GET)
    with a trivial 200 so reply()/available()/get_block() all succeed."""

    def _handle(req: httpx.Request) -> httpx.Response:
        if req.method == "GET" and req.url.path.endswith("/health"):
            return httpx.Response(200, json={"status": "ok"})
        if req.url.path.endswith("/api/persona/prompt"):
            return httpx.Response(200, text="PERSONA")
        return httpx.Response(
            200, json={"message": {"role": "assistant", "content": "ok"}},
        )

    return httpx.MockTransport(_handle)


# ────────────────────────────────────────────────────────────────────
# OrchestratorLLM — one client, reused across turns
# ────────────────────────────────────────────────────────────────────

class TestOrchestratorClientReuse:
    def test_builds_exactly_one_client_at_construction(self, monkeypatch):
        count = {"n": 0}

        def _factory() -> httpx.Client:
            count["n"] += 1
            return httpx.Client(transport=_ok_transport())

        monkeypatch.setattr(voice.llm, "_new_httpx_client", _factory)
        OrchestratorLLM(base_url="http://test")
        assert count["n"] == 1

    def test_client_not_recreated_per_call(self, monkeypatch):
        # The whole point of WARP-1433: multiple turns reuse ONE client, so
        # the factory is called exactly once no matter how many hops fire.
        count = {"n": 0}

        def _factory() -> httpx.Client:
            count["n"] += 1
            return httpx.Client(transport=_ok_transport())

        monkeypatch.setattr(voice.llm, "_new_httpx_client", _factory)
        llm = OrchestratorLLM(base_url="http://test")
        llm.reply("one")
        llm.reply("two")
        _ = llm.available
        list(llm.reply_stream("three"))
        assert count["n"] == 1

    def test_same_client_instance_used_every_call(self, monkeypatch):
        client = httpx.Client(transport=_ok_transport())
        monkeypatch.setattr(voice.llm, "_new_httpx_client", lambda: client)
        llm = OrchestratorLLM(base_url="http://test")
        assert llm._client is client
        llm.reply("hi")
        _ = llm.available
        assert llm._client is client  # never swapped out mid-life


class TestOrchestratorClientClose:
    def test_close_closes_pooled_client(self, monkeypatch):
        closed = {"n": 0}

        class _FakeClient:
            def close(self) -> None:
                closed["n"] += 1

        monkeypatch.setattr(voice.llm, "_new_httpx_client", lambda: _FakeClient())
        llm = OrchestratorLLM(base_url="http://test")
        llm.close()
        assert closed["n"] == 1

    def test_close_is_on_the_interface_mock_is_noop(self):
        # `close()` lives on LLMClient so main.py can call it on whatever
        # build_llm_from_env returned. MockLLM must inherit a safe no-op.
        MockLLM().close()  # must not raise


class TestOrchestratorClientMtls:
    """The mTLS material (cert + CA) now rides on the POOLED Client
    constructor — built once — instead of on every request's kwargs."""

    def test_client_constructed_with_cert_and_ca(self, monkeypatch, tmp_path):
        for name in ("cert", "key", "ca"):
            (tmp_path / f"{name}.pem").write_text("PEM")
        monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
        monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
        monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
        monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))

        captured: dict = {}
        real_client = httpx.Client

        def _capturing(*args, **kwargs):
            captured.update(kwargs)
            return real_client(transport=_ok_transport())

        monkeypatch.setattr(voice.llm.httpx, "Client", _capturing)
        llm = OrchestratorLLM(base_url="http://orchestrator:3000")

        # https rewrite (base_url) + mTLS material on the pool constructor.
        assert llm._base_url.startswith("https://orchestrator:3000")
        assert captured["cert"] == (
            str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"),
        )
        assert captured["verify"] == str(tmp_path / "ca.pem")

    def test_no_mtls_kwargs_when_flag_off(self, monkeypatch):
        monkeypatch.delenv("DROPLET_INTERNAL_TLS", raising=False)
        captured: dict = {}
        real_client = httpx.Client

        def _capturing(*args, **kwargs):
            captured.update(kwargs)
            return real_client(transport=_ok_transport())

        monkeypatch.setattr(voice.llm.httpx, "Client", _capturing)
        OrchestratorLLM(base_url="http://test")
        assert "cert" not in captured
        assert "verify" not in captured


# ────────────────────────────────────────────────────────────────────
# PersonaFetcher — mirrors the same pooled-client contract
# ────────────────────────────────────────────────────────────────────

class TestPersonaClientReuse:
    def test_builds_exactly_one_client(self, monkeypatch):
        count = {"n": 0}

        def _factory() -> httpx.Client:
            count["n"] += 1
            return httpx.Client(transport=_ok_transport())

        monkeypatch.setattr(voice.persona, "_new_httpx_client", _factory)
        PersonaFetcher("http://test")
        assert count["n"] == 1

    def test_client_reused_across_fetches(self, monkeypatch):
        count = {"n": 0}

        def _factory() -> httpx.Client:
            count["n"] += 1
            return httpx.Client(transport=_ok_transport())

        monkeypatch.setattr(voice.persona, "_new_httpx_client", _factory)
        # ttl_s=0 forces a real fetch on every get_block(), so two calls
        # exercise reuse rather than the in-session cache.
        f = PersonaFetcher("http://test", ttl_s=0.0)
        f.get_block()
        f.get_block()
        assert count["n"] == 1

    def test_close_closes_pooled_client(self, monkeypatch):
        closed = {"n": 0}

        class _FakeClient:
            def close(self) -> None:
                closed["n"] += 1

        monkeypatch.setattr(
            voice.persona, "_new_httpx_client", lambda: _FakeClient(),
        )
        f = PersonaFetcher("http://test")
        f.close()
        assert closed["n"] == 1

    def test_client_constructed_with_cert_and_ca(self, monkeypatch, tmp_path):
        for name in ("cert", "key", "ca"):
            (tmp_path / f"{name}.pem").write_text("PEM")
        monkeypatch.setenv("DROPLET_INTERNAL_TLS", "1")
        monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
        monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
        monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))

        captured: dict = {}
        real_client = httpx.Client

        def _capturing(*args, **kwargs):
            captured.update(kwargs)
            return real_client(transport=_ok_transport())

        monkeypatch.setattr(voice.persona.httpx, "Client", _capturing)
        f = PersonaFetcher("http://orchestrator:3000")

        assert f._base_url.startswith("https://orchestrator:3000")
        assert captured["cert"] == (
            str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"),
        )
        assert captured["verify"] == str(tmp_path / "ca.pem")
