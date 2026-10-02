"""Ollama backend — the default, and the reference implementation (WARP-1743).

Read this file as a *move*, not a rewrite. Every call below is the same verb,
path, JSON body and timeout that ``services/inference-manager/main.py`` issued
before WARP-1743, lifted out of the handlers unchanged:

===========================  ==========================================
was (pre-WARP-1743 main.py)  is (here)
===========================  ==========================================
``main.py:135``   tags       :meth:`~runtime.base.OllamaWireRuntime.health`
``main.py:167``   tags       :meth:`~runtime.base.OllamaWireRuntime.list_installed`
``main.py:180``   ps         :meth:`~runtime.base.OllamaWireRuntime.list_loaded`
``main.py:225``   pull       :meth:`OllamaRuntime.open_pull_stream`
``main.py:315``   pull       :meth:`OllamaRuntime.pull`
``main.py:354``   delete     :meth:`OllamaRuntime.delete`
``main.py:386``   tags       :meth:`~runtime.base.OllamaWireRuntime.list_installed`
``main.py:434``   pull       :meth:`OllamaRuntime.pull`
===========================  ==========================================

Note in particular what is *absent*: no retry, no response-body inspection, no
error normalisation, no id translation. Ollama identifies models by ``name:tag``
which is exactly what the manifest and every caller already use, so the
identifier passes through untouched. Adding anything here would move the
default path, which ADR-005 §8 forbids for this ticket.
"""

from __future__ import annotations

import httpx

from timeouts import TIMEOUT_PULL

from .base import OllamaWireRuntime, deleted_result, pulled_result, unload_result

PULL_PATH = "/api/pull"
DELETE_PATH = "/api/delete"
# WARP-3047 — Ollama's documented unload is a prompt-less generate with
# `keep_alive: 0`; there is no dedicated endpoint.
GENERATE_PATH = "/api/generate"


def _resident_names(ps: dict) -> list[str]:
    """Model names from an ``/api/ps`` body, in order, without repeats."""
    names: list[str] = []
    for entry in ps.get("models") or []:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name") or entry.get("model")
        if isinstance(name, str) and name.strip() and name not in names:
            names.append(name)
    return names


class OllamaRuntime(OllamaWireRuntime):
    """The default backend. Selected when ``INFERENCE_RUNTIME`` is unset."""

    name = "ollama"

    def _pull_body(self, model: str, *, stream: bool) -> dict[str, object]:
        # `name` (not `model`) is what this service has always sent. Ollama
        # accepts both — `name` is its legacy field — but the point of this
        # ticket is that the default path is byte-identical, so the historical
        # key stays. Compare `runtime/dmr.py`, which sends both deliberately.
        return {"name": model, "stream": stream}

    async def pull(self, model: str) -> dict[str, str]:
        """Blocking pull. Ollama answers non-2xx on failure, so status is enough.

        The response body is not inspected — that was true before WARP-1743 and
        stays true. ``raise_for_status()`` raises ``httpx.HTTPStatusError``,
        which ``main.py`` maps to the upstream status code; transport failures
        propagate to its 502 arm.
        """
        resp = await self._client.post(
            PULL_PATH,
            json=self._pull_body(model, stream=False),
            timeout=TIMEOUT_PULL,
        )
        resp.raise_for_status()
        return pulled_result(model)

    async def open_pull_stream(self, model: str) -> httpx.Response:
        """Start an NDJSON progress pull (WARP-1111 §7.1) and hand back the stream.

        Built with ``build_request`` + ``send(stream=True)`` rather than
        ``post(...)`` because the caller must see the status line *before* the
        body is consumed: a non-2xx here has to close as a plain error response
        instead of committing to a 200 streaming body.
        """
        request = self._client.build_request(
            "POST",
            PULL_PATH,
            json=self._pull_body(model, stream=True),
            timeout=TIMEOUT_PULL,
        )
        return await self._client.send(request, stream=True)

    async def delete(self, model: str) -> dict[str, str]:
        """Delete via Ollama's JSON-body DELETE.

        ``client.request("DELETE", ...)`` rather than ``client.delete(...)``
        because httpx's ``delete()`` helper takes no ``json=`` argument — a
        DELETE with a body is unusual, and this is the shape Ollama requires.
        No explicit timeout: it inherits the client's ``TIMEOUT_MGMT``, exactly
        as before.
        """
        resp = await self._client.request("DELETE", DELETE_PATH, json={"name": model})
        resp.raise_for_status()
        return deleted_result(model)

    async def unload_others(self, keep: str) -> dict[str, list[str]]:
        """Unload every resident model except ``keep`` (WARP-3047).

        Added, not moved: nothing on the pre-WARP-1743 path unloaded. Ollama
        honours ``OLLAMA_MAX_LOADED_MODELS`` itself, so on this backend the
        call mostly saves the swap's cold-reload thrash; it exists so a model
        switch behaves the same on both daemons. Names come back from
        ``/api/ps`` exactly as Ollama reports them — the caller's vocabulary —
        so ``keep`` is compared as-is. Re-listed afterwards: a model mid-
        request finishes before Ollama drops it.
        """
        target = (keep or "").strip()
        others = [n for n in _resident_names(await self.list_loaded()) if n != target]
        for name in others:
            resp = await self._client.post(GENERATE_PATH, json={"model": name, "keep_alive": 0})
            resp.raise_for_status()
        after = [n for n in _resident_names(await self.list_loaded()) if n != target]
        return unload_result([n for n in others if n not in after], after)
