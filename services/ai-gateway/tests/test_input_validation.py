"""Tests for input validation bounds on chat schemas."""

from __future__ import annotations

import pytest


class TestChatRequestValidation:
    """Test that schema validation rejects out-of-bounds inputs."""

    async def test_max_tokens_too_high(self, client):
        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 999999,
            },
        )
        assert resp.status_code == 422

    async def test_max_tokens_zero(self, client):
        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 0,
            },
        )
        assert resp.status_code == 422

    async def test_max_tokens_valid(self, client):
        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 1024,
            },
        )
        # Should not be a validation error (may fail at provider level)
        assert resp.status_code != 422

    async def test_max_tokens_at_boundary(self, client):
        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 4096,
            },
        )
        assert resp.status_code != 422

    async def test_empty_messages_rejected(self, client):
        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": [],
            },
        )
        assert resp.status_code == 422

    async def test_too_many_messages_rejected(self, client):
        messages = [{"role": "user", "content": f"msg {i}"} for i in range(101)]
        resp = await client.post(
            "/ai/chat",
            json={
                "model": "llama3:8b",
                "messages": messages,
            },
        )
        assert resp.status_code == 422

    async def test_session_chat_max_tokens_validated(self, client_with_sessions):
        # Create a session first
        session_resp = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3:8b", "title": "test"},
        )
        if session_resp.status_code != 201:
            pytest.skip("Session creation failed")
        session_id = session_resp.json()["id"]

        resp = await client_with_sessions.post(
            f"/ai/sessions/{session_id}/chat",
            json={"message": "hi", "max_tokens": 999999},
        )
        assert resp.status_code == 422

    async def test_session_chat_empty_message_rejected(self, client_with_sessions):
        session_resp = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3:8b", "title": "test"},
        )
        if session_resp.status_code != 201:
            pytest.skip("Session creation failed")
        session_id = session_resp.json()["id"]

        resp = await client_with_sessions.post(
            f"/ai/sessions/{session_id}/chat",
            json={"message": "", "max_tokens": 100},
        )
        assert resp.status_code == 422
