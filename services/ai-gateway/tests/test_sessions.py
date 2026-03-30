"""Tests for session management endpoints."""

import pytest


class TestSessionCreate:
    async def test_create_session(self, client_with_sessions):
        resp = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3.2:3b", "title": "Test session"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["model"] == "llama3.2:3b"
        assert data["title"] == "Test session"
        assert "id" in data
        assert data["message_count"] == 0

    async def test_create_session_default_title(self, client_with_sessions):
        resp = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3.2:3b"},
        )
        assert resp.status_code == 201
        assert resp.json()["title"] == "New conversation"

    async def test_create_session_with_system_prompt(self, client_with_sessions):
        resp = await client_with_sessions.post(
            "/ai/sessions",
            json={
                "model": "llama3.2:3b",
                "system_prompt": "You are a helpful assistant.",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["system_prompt"] == "You are a helpful assistant."

    async def test_create_session_missing_model(self, client_with_sessions):
        resp = await client_with_sessions.post("/ai/sessions", json={})
        assert resp.status_code == 422


class TestSessionList:
    async def test_list_sessions_empty(self, client_with_sessions):
        resp = await client_with_sessions.get("/ai/sessions")
        assert resp.status_code == 200
        data = resp.json()
        assert data["sessions"] == []

    async def test_list_sessions_after_create(self, client_with_sessions):
        await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3.2:3b", "title": "First"},
        )
        await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "mistral:7b", "title": "Second"},
        )
        resp = await client_with_sessions.get("/ai/sessions")
        data = resp.json()
        assert len(data["sessions"]) == 2
        # Most recent first
        assert data["sessions"][0]["title"] == "Second"


class TestSessionGet:
    async def test_get_session(self, client_with_sessions):
        create_resp = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3.2:3b", "title": "Test"},
        )
        session_id = create_resp.json()["id"]

        resp = await client_with_sessions.get(f"/ai/sessions/{session_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == session_id
        assert data["messages"] == []

    async def test_get_nonexistent_session(self, client_with_sessions):
        resp = await client_with_sessions.get("/ai/sessions/nonexistent-id")
        assert resp.status_code == 404


class TestSessionUpdate:
    async def test_update_title(self, client_with_sessions):
        create_resp = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3.2:3b", "title": "Old title"},
        )
        session_id = create_resp.json()["id"]

        resp = await client_with_sessions.patch(
            f"/ai/sessions/{session_id}",
            json={"title": "New title"},
        )
        assert resp.status_code == 200
        assert resp.json()["title"] == "New title"

    async def test_update_nonexistent(self, client_with_sessions):
        resp = await client_with_sessions.patch(
            "/ai/sessions/fake-id",
            json={"title": "Nope"},
        )
        assert resp.status_code == 404


class TestSessionDelete:
    async def test_delete_session(self, client_with_sessions):
        create_resp = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3.2:3b"},
        )
        session_id = create_resp.json()["id"]

        resp = await client_with_sessions.delete(f"/ai/sessions/{session_id}")
        assert resp.status_code == 200

        # Verify it's gone
        resp = await client_with_sessions.get(f"/ai/sessions/{session_id}")
        assert resp.status_code == 404

    async def test_delete_nonexistent(self, client_with_sessions):
        resp = await client_with_sessions.delete("/ai/sessions/nonexistent")
        assert resp.status_code == 404


class TestSessionChat:
    async def test_session_chat_nonexistent(self, client_with_sessions):
        resp = await client_with_sessions.post(
            "/ai/sessions/nonexistent/chat",
            json={"message": "hello"},
        )
        assert resp.status_code == 404

    async def test_session_chat_missing_message(self, client_with_sessions):
        create_resp = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3.2:3b"},
        )
        session_id = create_resp.json()["id"]

        resp = await client_with_sessions.post(
            f"/ai/sessions/{session_id}/chat",
            json={},
        )
        assert resp.status_code == 422

    async def test_session_chat_adds_message(self, client_with_sessions):
        """Test that a chat request adds the user message to the session (provider may fail)."""
        create_resp = await client_with_sessions.post(
            "/ai/sessions",
            json={"model": "llama3.2:3b"},
        )
        session_id = create_resp.json()["id"]

        # This will fail at provider level (no Ollama) but the user message should still be saved
        resp = await client_with_sessions.post(
            f"/ai/sessions/{session_id}/chat",
            json={"message": "hello", "stream": False},
        )
        # 502 expected since no Ollama is running
        assert resp.status_code in (200, 502)

        # Check that user message was saved
        session_resp = await client_with_sessions.get(f"/ai/sessions/{session_id}")
        data = session_resp.json()
        assert len(data["messages"]) >= 1
        assert data["messages"][0]["role"] == "user"
        assert data["messages"][0]["content"] == "hello"
