"""WARP-108 — pure ASGI middleware that adopts/generates x-request-id.

Pure ASGI (not BaseHTTPMiddleware) so the contextvar set here is visible in the
endpoint and downstream provider calls — BaseHTTPMiddleware runs the app in a
separate task and the contextvar would not propagate.
"""
from __future__ import annotations

from request_context import new_request_id, sanitize_request_id, set_request_id


class RequestIdMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        raw = None
        for name, value in scope.get("headers", []):
            if name == b"x-request-id":
                raw = value.decode("latin-1")
                break
        request_id = sanitize_request_id(raw) or new_request_id()
        set_request_id(request_id)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                headers.append((b"x-request-id", request_id.encode("latin-1")))
            await send(message)

        await self.app(scope, receive, send_wrapper)
