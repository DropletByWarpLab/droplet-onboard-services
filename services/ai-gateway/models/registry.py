"""Tracks available models across all providers with a TTL cache."""

from __future__ import annotations

import asyncio
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
        # WARP-1284 (F2): single-flight — at most ONE provider fan-out in
        # flight; concurrent callers await the same task. Degraded listings
        # never arm the TTL, so without this the wizard's 8s poll + the
        # dashboard's 30s SWR would each run their own fan-out while Ollama
        # is slow-not-down, stacking hung /api/tags calls onto the shared
        # httpx pool that chat also uses.
        self._inflight: asyncio.Task[ModelListResult] | None = None
        # Last degraded set, so the WARNING fires on state CHANGE rather
        # than on every re-query while degraded (the registry re-fetches on
        # each poll in that state — per-request logging would be spam).
        self._last_degraded: tuple[str, ...] = ()

    @property
    def is_stale(self) -> bool:
        return time.time() - self._last_fetched > CACHE_TTL_SECONDS

    async def get_models(self, router) -> ModelListResult:
        """Return the cached model listing, refreshing if stale.

        WARP-1284: a DEGRADED listing (a provider's list_models() raised) is
        served but never cached as fresh — `_last_fetched` is only bumped on
        a fully healthy fetch, so the next access re-queries the providers
        and the degraded signal clears the moment they recover, instead of
        pinning "degraded" (or hiding a recovery) for a full TTL. Refreshes
        are single-flight: concurrent callers share one fan-out; a LATER
        call while still degraded starts a fresh one (that re-query is what
        self-heals the signal).
        """
        if not self.is_stale:
            return self._cache
        inflight = self._inflight
        if inflight is None or inflight.done():
            inflight = asyncio.create_task(self._refresh(router))
            self._inflight = inflight
        return await inflight

    async def _refresh(self, router) -> ModelListResult:
        try:
            result = await router.list_all_models()
            self._cache = result
            degraded = tuple(result.degraded_providers)
            if degraded:
                if degraded != self._last_degraded:
                    logger.warning(
                        "Model registry refresh degraded (providers: %s); "
                        "serving %d models uncached until they recover",
                        list(degraded),
                        len(result.models),
                    )
            else:
                if self._last_degraded:
                    logger.info(
                        "Model registry recovered (providers %s back)",
                        list(self._last_degraded),
                    )
                self._last_fetched = time.time()
                logger.info("Model registry refreshed: %d models", len(result.models))
            self._last_degraded = degraded
        except Exception as e:
            logger.error("Failed to refresh model registry: %s", e)
            # Return stale cache rather than nothing
        return self._cache

    def invalidate(self):
        """Force a refresh on next access."""
        self._last_fetched = 0
