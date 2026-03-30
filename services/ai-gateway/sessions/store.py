"""Session store — persists chat sessions and their messages.

Uses Redis when available (production), falls back to in-memory dict (dev/test).
Each session stores metadata and an ordered list of messages.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field, asdict

logger = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "")
SESSION_TTL = int(os.getenv("SESSION_TTL", str(7 * 24 * 3600)))  # 7 days default


@dataclass
class SessionMessage:
    role: str
    content: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class Session:
    id: str
    title: str
    model: str
    created_at: float
    updated_at: float
    messages: list[SessionMessage] = field(default_factory=list)
    system_prompt: str | None = None


class SessionStore:
    """Abstract session storage interface."""

    async def create(self, model: str, title: str = "", system_prompt: str | None = None) -> Session:
        raise NotImplementedError

    async def get(self, session_id: str) -> Session | None:
        raise NotImplementedError

    async def list_sessions(self, limit: int = 50, offset: int = 0) -> list[Session]:
        raise NotImplementedError

    async def add_message(self, session_id: str, role: str, content: str) -> SessionMessage | None:
        raise NotImplementedError

    async def delete(self, session_id: str) -> bool:
        raise NotImplementedError

    async def update_title(self, session_id: str, title: str) -> bool:
        raise NotImplementedError

    async def close(self):
        pass


class InMemorySessionStore(SessionStore):
    """In-memory session store for development and testing."""

    def __init__(self):
        self._sessions: dict[str, Session] = {}

    async def create(self, model: str, title: str = "", system_prompt: str | None = None) -> Session:
        session_id = str(uuid.uuid4())
        now = time.time()
        session = Session(
            id=session_id,
            title=title or "New conversation",
            model=model,
            created_at=now,
            updated_at=now,
            system_prompt=system_prompt,
        )
        self._sessions[session_id] = session
        return session

    async def get(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    async def list_sessions(self, limit: int = 50, offset: int = 0) -> list[Session]:
        all_sessions = sorted(
            self._sessions.values(), key=lambda s: s.updated_at, reverse=True
        )
        return all_sessions[offset : offset + limit]

    async def add_message(self, session_id: str, role: str, content: str) -> SessionMessage | None:
        session = self._sessions.get(session_id)
        if not session:
            return None
        msg = SessionMessage(role=role, content=content)
        session.messages.append(msg)
        session.updated_at = time.time()
        return msg

    async def delete(self, session_id: str) -> bool:
        return self._sessions.pop(session_id, None) is not None

    async def update_title(self, session_id: str, title: str) -> bool:
        session = self._sessions.get(session_id)
        if not session:
            return False
        session.title = title
        session.updated_at = time.time()
        return True


class RedisSessionStore(SessionStore):
    """Redis-backed session store for production."""

    KEY_PREFIX = "session:"
    INDEX_KEY = "sessions:index"

    def __init__(self, redis_url: str):
        import redis.asyncio as aioredis
        self._redis = aioredis.from_url(redis_url, decode_responses=True)

    def _key(self, session_id: str) -> str:
        return f"{self.KEY_PREFIX}{session_id}"

    def _session_from_dict(self, data: dict) -> Session:
        messages = [SessionMessage(**m) for m in json.loads(data.get("messages", "[]"))]
        return Session(
            id=data["id"],
            title=data.get("title", ""),
            model=data.get("model", ""),
            created_at=float(data.get("created_at", 0)),
            updated_at=float(data.get("updated_at", 0)),
            messages=messages,
            system_prompt=data.get("system_prompt"),
        )

    def _session_to_dict(self, session: Session) -> dict:
        return {
            "id": session.id,
            "title": session.title,
            "model": session.model,
            "created_at": str(session.created_at),
            "updated_at": str(session.updated_at),
            "messages": json.dumps([asdict(m) for m in session.messages]),
            "system_prompt": session.system_prompt or "",
        }

    async def create(self, model: str, title: str = "", system_prompt: str | None = None) -> Session:
        session_id = str(uuid.uuid4())
        now = time.time()
        session = Session(
            id=session_id,
            title=title or "New conversation",
            model=model,
            created_at=now,
            updated_at=now,
            system_prompt=system_prompt,
        )
        key = self._key(session_id)
        await self._redis.hset(key, mapping=self._session_to_dict(session))
        await self._redis.expire(key, SESSION_TTL)
        await self._redis.zadd(self.INDEX_KEY, {session_id: now})
        return session

    async def get(self, session_id: str) -> Session | None:
        data = await self._redis.hgetall(self._key(session_id))
        if not data:
            return None
        return self._session_from_dict(data)

    async def list_sessions(self, limit: int = 50, offset: int = 0) -> list[Session]:
        ids = await self._redis.zrevrange(self.INDEX_KEY, offset, offset + limit - 1)
        sessions = []
        for sid in ids:
            session = await self.get(sid)
            if session:
                sessions.append(session)
        return sessions

    async def add_message(self, session_id: str, role: str, content: str) -> SessionMessage | None:
        key = self._key(session_id)
        exists = await self._redis.exists(key)
        if not exists:
            return None

        session = await self.get(session_id)
        if not session:
            return None

        msg = SessionMessage(role=role, content=content)
        session.messages.append(msg)
        now = time.time()
        session.updated_at = now

        await self._redis.hset(key, mapping={
            "messages": json.dumps([asdict(m) for m in session.messages]),
            "updated_at": str(now),
        })
        await self._redis.expire(key, SESSION_TTL)
        await self._redis.zadd(self.INDEX_KEY, {session_id: now})
        return msg

    async def delete(self, session_id: str) -> bool:
        key = self._key(session_id)
        deleted = await self._redis.delete(key)
        await self._redis.zrem(self.INDEX_KEY, session_id)
        return deleted > 0

    async def update_title(self, session_id: str, title: str) -> bool:
        key = self._key(session_id)
        exists = await self._redis.exists(key)
        if not exists:
            return False
        now = time.time()
        await self._redis.hset(key, mapping={"title": title, "updated_at": str(now)})
        await self._redis.zadd(self.INDEX_KEY, {session_id: now})
        return True

    async def close(self):
        await self._redis.aclose()


def create_session_store() -> SessionStore:
    """Factory: use Redis if REDIS_URL is set, otherwise in-memory."""
    if REDIS_URL:
        logger.info("Using Redis session store: %s", REDIS_URL)
        return RedisSessionStore(REDIS_URL)
    logger.info("Using in-memory session store (no REDIS_URL set)")
    return InMemorySessionStore()
