"""Per-IP sliding-window rate limiting for AI Gateway endpoints.

Uses Redis when available (production), falls back to in-memory dict (dev/test).
Configurable via RATE_LIMIT_RPM and RATE_LIMIT_BURST env vars.
"""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)

RATE_LIMIT_RPM = int(os.getenv("RATE_LIMIT_RPM", "60"))
RATE_LIMIT_BURST = int(os.getenv("RATE_LIMIT_BURST", "10"))
REDIS_URL = os.getenv("REDIS_URL", "")

def _is_rate_limited_path(path: str) -> bool:
    """Check if the request path should be rate-limited.

    Only rate-limits actual inference endpoints, not session CRUD.
    """
    if path == "/ai/chat":
        return True
    # /ai/sessions/{id}/chat — the session inference endpoint
    if path.startswith("/ai/sessions/") and path.endswith("/chat"):
        return True
    return False


def _client_ip(request: Request) -> str:
    """Extract client IP, respecting X-Forwarded-For from the nginx proxy."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class _InMemoryBackend:
    """Dev/test fallback — sliding window per IP using in-memory timestamps."""

    def __init__(self):
        self._windows: dict[str, list[float]] = defaultdict(list)

    async def check_and_increment(self, key: str) -> tuple[bool, int, int]:
        """Returns (allowed, remaining, retry_after_seconds)."""
        now = time.time()
        window_start = now - 60

        # Prune old entries
        self._windows[key] = [t for t in self._windows[key] if t > window_start]

        count = len(self._windows[key])
        if count >= RATE_LIMIT_RPM:
            oldest = self._windows[key][0] if self._windows[key] else now
            retry_after = max(1, int(oldest + 60 - now))
            return False, 0, retry_after

        # Check burst (requests in last 2 seconds)
        burst_window = now - 2
        burst_count = sum(1 for t in self._windows[key] if t > burst_window)
        if burst_count >= RATE_LIMIT_BURST:
            return False, RATE_LIMIT_RPM - count, 2

        self._windows[key].append(now)
        return True, RATE_LIMIT_RPM - count - 1, 0

    async def close(self):
        pass


class _RedisBackend:
    """Production backend — sliding window using Redis sorted sets."""

    def __init__(self, redis_url: str):
        self._redis_url = redis_url
        self._redis = None

    async def _get_redis(self):
        if self._redis is None:
            import redis.asyncio as aioredis
            self._redis = aioredis.from_url(self._redis_url)
        return self._redis

    async def check_and_increment(self, key: str) -> tuple[bool, int, int]:
        """Returns (allowed, remaining, retry_after_seconds)."""
        try:
            r = await self._get_redis()
            now = time.time()
            window_start = now - 60
            redis_key = f"ratelimit:{key}"

            pipe = r.pipeline()
            pipe.zremrangebyscore(redis_key, 0, window_start)
            pipe.zcard(redis_key)
            pipe.zrange(redis_key, 0, 0, withscores=True)
            results = await pipe.execute()

            count = results[1]
            if count >= RATE_LIMIT_RPM:
                oldest_entries = results[2]
                oldest = oldest_entries[0][1] if oldest_entries else now
                retry_after = max(1, int(oldest + 60 - now))
                return False, 0, retry_after

            # Check burst
            burst_start = now - 2
            burst_count = await r.zcount(redis_key, burst_start, "+inf")
            if burst_count >= RATE_LIMIT_BURST:
                return False, RATE_LIMIT_RPM - count, 2

            pipe2 = r.pipeline()
            pipe2.zadd(redis_key, {f"{now}": now})
            pipe2.expire(redis_key, 120)
            await pipe2.execute()

            return True, RATE_LIMIT_RPM - count - 1, 0
        except Exception:
            logger.warning("Redis rate-limit check failed, allowing request")
            return True, RATE_LIMIT_RPM, 0

    async def close(self):
        if self._redis:
            await self._redis.close()


def _create_backend():
    if REDIS_URL:
        return _RedisBackend(REDIS_URL)
    return _InMemoryBackend()


_backend = _create_backend()


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window rate limiter applied to chat endpoints."""

    async def dispatch(self, request: Request, call_next) -> Response:
        if not _is_rate_limited_path(request.url.path):
            return await call_next(request)

        client_key = _client_ip(request)
        allowed, remaining, retry_after = await _backend.check_and_increment(client_key)

        if not allowed:
            from starlette.responses import JSONResponse
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded. Try again later."},
                headers={
                    "Retry-After": str(retry_after),
                    "X-RateLimit-Limit": str(RATE_LIMIT_RPM),
                    "X-RateLimit-Remaining": "0",
                },
            )

        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(RATE_LIMIT_RPM)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response


async def close_rate_limiter():
    """Clean up backend connections on shutdown."""
    await _backend.close()
