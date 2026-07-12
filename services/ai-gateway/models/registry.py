"""Tracks available models across all providers with a TTL cache."""

from __future__ import annotations

import time
import logging

from router import ModelListResult

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 60


class ModelRegistry:
    """In-memory cached model registry."""

    def __init__(self):
        self._cache: ModelListResult = ModelListResult(models=[], degraded_providers=[])
        self._last_fetched: float = 0

    @property
    def is_stale(self) -> bool:
        return time.time() - self._last_fetched > CACHE_TTL_SECONDS

    async def get_models(self, router) -> ModelListResult:
        """Return the cached model listing, refreshing if stale.

        WARP-1284: a DEGRADED listing (a provider's list_models() raised) is
        served but never cached as fresh — `_last_fetched` is only bumped on
        a fully healthy fetch, so the next access re-queries the providers
        and the degraded signal clears the moment they recover, instead of
        pinning "degraded" (or hiding a recovery) for a full TTL.
        """
        if self.is_stale:
            try:
                result = await router.list_all_models()
                self._cache = result
                if result.degraded_providers:
                    logger.warning(
                        "Model registry refresh degraded (providers: %s); "
                        "serving %d models uncached",
                        result.degraded_providers,
                        len(result.models),
                    )
                else:
                    self._last_fetched = time.time()
                    logger.info(
                        "Model registry refreshed: %d models", len(result.models)
                    )
            except Exception as e:
                logger.error("Failed to refresh model registry: %s", e)
                # Return stale cache rather than nothing
        return self._cache

    def invalidate(self):
        """Force a refresh on next access."""
        self._last_fetched = 0
