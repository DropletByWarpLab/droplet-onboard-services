"""Tracks available models across all providers with a TTL cache."""

from __future__ import annotations

import time
import logging

from schemas import ModelInfo

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 60


class ModelRegistry:
    """In-memory cached model registry."""

    def __init__(self):
        self._cache: list[ModelInfo] = []
        self._last_fetched: float = 0

    @property
    def is_stale(self) -> bool:
        return time.time() - self._last_fetched > CACHE_TTL_SECONDS

    async def get_models(self, router) -> list[ModelInfo]:
        """Return cached models, refreshing if stale."""
        if self.is_stale:
            try:
                self._cache = await router.list_all_models()
                self._last_fetched = time.time()
                logger.info("Model registry refreshed: %d models", len(self._cache))
            except Exception as e:
                logger.error("Failed to refresh model registry: %s", e)
                # Return stale cache rather than nothing
        return self._cache

    def invalidate(self):
        """Force a refresh on next access."""
        self._last_fetched = 0
