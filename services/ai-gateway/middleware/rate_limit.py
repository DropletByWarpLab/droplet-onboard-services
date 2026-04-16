"""Per-IP sliding-window rate limiting for AI Gateway endpoints.

Uses Redis when available (production), falls back to in-memory dict (dev/test).
Configurable via RATE_LIMIT_RPM and RATE_LIMIT_BURST env vars.

Fail-open policy: if Redis is unreachable, requests are allowed through. This is
intentional — we prefer service availability over strict rate limits when the
rate-limit infrastructure is degraded. Logged at ERROR level so ops notices.
"""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


def _int_env(name: str, default: int) -> int:
    """Parse an int env var, falling back to default on malformed input."""
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("Invalid %s=%r, using default %d", name, raw, default)
        return default


RATE_LIMIT_RPM = _int_env("RATE_LIMIT_RPM", 60)
RATE_LIMIT_BURST = _int_env("RATE_LIMIT_BURST", 10)
REDIS_URL = os.getenv("REDIS_URL", "")

# Window sizes (seconds)
_WINDOW_SECONDS = 60
_BURST_WINDOW_SECONDS = 2

# Lua script for atomic check-and-increment on Redis sorted set.
# Prevents TOCTOU races where concurrent requests all read the count
# before any of them write. Runs atomically inside Redis.
#
# KEYS[1] = sorted-set key
# ARGV[1] = now (float seconds)
# ARGV[2] = window_start (now - 60)
# ARGV[3] = burst_start (now - 2)
# ARGV[4] = RATE_LIMIT_RPM
# ARGV[5] = RATE_LIMIT_BURST
# ARGV[6] = key TTL (seconds)
#
# Returns: {allowed(0|1), remaining, retry_after, count, burst_count}
_CHECK_AND_INCREMENT_LUA = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[2])
local count = redis.call('ZCARD', KEYS[1])
local rpm = tonumber(ARGV[4])
if count >= rpm then
  local oldest_entry = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local oldest = tonumber(ARGV[1])
  if oldest_entry[2] then oldest = tonumber(oldest_entry[2]) end
  local retry_after = math.max(1, math.ceil(oldest + 60 - tonumber(ARGV[1])))
  return {0, 0, retry_after, count, 0}
end
local burst_count = redis.call('ZCOUNT', KEYS[1], ARGV[3], '+inf')
local burst = tonumber(ARGV[5])
if burst_count >= burst then
  return {0, rpm - count, 2, count, burst_count}
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[6])
return {1, rpm - count - 1, 0, count, burst_count}
"""


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
    """Extract client IP, preferring the trusted X-Real-IP header from nginx.

    SECURITY:
    1. X-Real-IP is set by our nginx upstream as `$remote_addr` — the direct
       peer of nginx. It cannot be spoofed by a client because nginx overwrites
       (not appends) this header. This is the preferred source.
    2. X-Forwarded-For is APPENDED by nginx (via $proxy_add_x_forwarded_for),
       so the LEFT-most entries are client-supplied. We take the RIGHT-most
       entry (nginx's appended value) as a fallback if X-Real-IP is missing.
    3. If no proxy headers are present, falls back to the direct connection
       peer (for direct-to-gateway traffic outside the proxy chain).

    Taking `split(",")[0]` would allow trivial rate-limit bypass by sending
    `X-Forwarded-For: rotating-fake-ip` on every request.
    """
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()

    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if parts:
            return parts[-1]

    return request.client.host if request.client else "unknown"


class _InMemoryBackend:
    """Dev/test fallback — sliding window per IP using in-memory timestamps.

    NOT safe across workers — use Redis in production.
    """

    def __init__(self):
        self._windows: dict[str, list[float]] = defaultdict(list)

    async def check_and_increment(self, key: str) -> tuple[bool, int, int]:
        """Returns (allowed, remaining, retry_after_seconds)."""
        now = time.time()
        window_start = now - _WINDOW_SECONDS

        # Prune old entries
        self._windows[key] = [t for t in self._windows[key] if t > window_start]

        count = len(self._windows[key])
        if count >= RATE_LIMIT_RPM:
            oldest = self._windows[key][0] if self._windows[key] else now
            retry_after = max(1, int(oldest + _WINDOW_SECONDS - now))
            return False, 0, retry_after

        # Check burst (requests in last BURST_WINDOW seconds)
        burst_window = now - _BURST_WINDOW_SECONDS
        burst_count = sum(1 for t in self._windows[key] if t > burst_window)
        if burst_count >= RATE_LIMIT_BURST:
            return False, RATE_LIMIT_RPM - count, _BURST_WINDOW_SECONDS

        self._windows[key].append(now)
        return True, RATE_LIMIT_RPM - count - 1, 0

    async def close(self):
        pass


class _RedisBackend:
    """Production backend — sliding window using Redis sorted sets.

    Uses a Lua script for atomic check-and-increment to prevent TOCTOU races
    where concurrent requests all read the count before any of them write.
    """

    def __init__(self, redis_url: str):
        self._redis_url = redis_url
        self._redis = None
        self._script_sha: str | None = None

    async def _get_redis(self):
        if self._redis is None:
            import redis.asyncio as aioredis
            self._redis = aioredis.from_url(self._redis_url)
        return self._redis

    async def _get_script(self, r) -> str:
        if self._script_sha is None:
            self._script_sha = await r.script_load(_CHECK_AND_INCREMENT_LUA)
        return self._script_sha

    async def check_and_increment(self, key: str) -> tuple[bool, int, int]:
        """Returns (allowed, remaining, retry_after_seconds).

        Fails open (returns allowed=True) if Redis is unavailable. Logged at
        ERROR so persistent Redis outages are visible.
        """
        try:
            r = await self._get_redis()
            now = time.time()
            window_start = now - _WINDOW_SECONDS
            burst_start = now - _BURST_WINDOW_SECONDS
            redis_key = f"ratelimit:{key}"

            try:
                sha = await self._get_script(r)
                result = await r.evalsha(
                    sha, 1, redis_key,
                    str(now), str(window_start), str(burst_start),
                    str(RATE_LIMIT_RPM), str(RATE_LIMIT_BURST),
                    str(_WINDOW_SECONDS * 2),
                )
            except Exception:
                # Script cache eviction — reload and retry once
                self._script_sha = None
                sha = await self._get_script(r)
                result = await r.evalsha(
                    sha, 1, redis_key,
                    str(now), str(window_start), str(burst_start),
                    str(RATE_LIMIT_RPM), str(RATE_LIMIT_BURST),
                    str(_WINDOW_SECONDS * 2),
                )

            allowed, remaining, retry_after = int(result[0]), int(result[1]), int(result[2])
            return allowed == 1, remaining, retry_after
        except Exception:
            logger.error("Redis rate-limit check failed, failing open", exc_info=True)
            return True, RATE_LIMIT_RPM, 0

    async def close(self):
        if self._redis:
            await self._redis.close()


def _create_backend():
    if REDIS_URL:
        return _RedisBackend(REDIS_URL)
    return _InMemoryBackend()


# Lazy-init: the backend is created on first use, not at import time.
# This makes the module test-friendly (tests can override env vars and then
# instantiate the middleware) and keeps import cheap.
_backend: _InMemoryBackend | _RedisBackend | None = None


def _get_backend() -> _InMemoryBackend | _RedisBackend:
    global _backend
    if _backend is None:
        _backend = _create_backend()
    return _backend


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window rate limiter applied to chat endpoints."""

    async def dispatch(self, request: Request, call_next) -> Response:
        if not _is_rate_limited_path(request.url.path):
            return await call_next(request)

        client_key = _client_ip(request)
        allowed, remaining, retry_after = await _get_backend().check_and_increment(client_key)

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
    global _backend
    if _backend is not None:
        await _backend.close()
        _backend = None
