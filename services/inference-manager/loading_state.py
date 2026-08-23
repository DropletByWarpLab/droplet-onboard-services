"""Async-safe set tracking which models are currently being pulled or loaded.

The chat proxy reads from this to return ``503 + Retry-After`` rather than
hanging when a model isn't yet ready. The pull/sync handlers wrap their
work in ``add(...) ... remove(...)`` calls.
"""

from __future__ import annotations

import asyncio


class LoadingTracker:
    def __init__(self) -> None:
        self._models: set[str] = set()
        self._lock = asyncio.Lock()

    async def add(self, model: str) -> None:
        async with self._lock:
            self._models.add(model)

    async def remove(self, model: str) -> None:
        async with self._lock:
            self._models.discard(model)

    async def contains(self, model: str) -> bool:
        async with self._lock:
            return model in self._models

    async def list(self) -> list[str]:
        async with self._lock:
            return sorted(self._models)
