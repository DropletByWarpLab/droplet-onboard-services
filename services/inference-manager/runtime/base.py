"""``InferenceRuntime`` — the contract ``main.py`` needs from a model backend.

WARP-1743, the this-repo half of ADR-005 §1 ("the runtime becomes a named
contract with an explicit backend discriminator"). Before this package every
lifecycle handler in ``main.py`` drove a raw ``httpx.AsyncClient`` pointed at
Ollama, which made the daemon's wire format the appliance's internal API. This
puts exactly one seam between the two: ``main.py`` asks a runtime to perform an
*operation*, and the runtime knows which URL, verb and body that operation is
on its backend.

Two rules govern everything in this package:

1. **The ``/models/*`` wire contract does not move.** ADR-003 fixed that
   endpoint list as the appliance's public surface and ADR-005 §1 keeps "every
   route it has and every response shape". Methods here return the exact dicts
   ``main.py`` already returned — see :func:`pulled_result` /
   :func:`deleted_result`, which exist precisely so two implementations cannot
   drift into returning different bodies for the same route.
2. **Ships dark (ADR-005 §8).** :class:`~runtime.ollama.OllamaRuntime` is a
   *faithful extraction* of the pre-WARP-1743 code — same paths, same JSON
   keys, same timeouts, same exception types escaping to the same handlers. It
   is not "the Ollama-flavoured implementation of a new abstraction"; it is the
   old code, moved. Any behaviour change there is a bug in this ticket, not a
   design choice.

**Errors are deliberately not normalised** into a runtime-specific hierarchy.
``main.py`` maps ``httpx.HTTPStatusError`` to the upstream status code and
everything else to 502; adapters therefore let ``raise_for_status()`` and
transport errors propagate untouched so that mapping keeps working unchanged
for both backends. The one exception is :class:`RuntimePullError` — see its
docstring for why a *new* failure mode needed a name.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

import httpx

from timeouts import TIMEOUT_HEALTH

# The two endpoints DMR replicates field-for-field (ADR-005 §2, verified
# against `docker/model-runner` @ main, `pkg/ollama/http_handler.go` — not
# against Docker's published docs, which omit /api/ps entirely). Because the
# responses are identical down to `size_vram`, both backends share the
# implementations below rather than each carrying its own copy.
TAGS_PATH = "/api/tags"
PS_PATH = "/api/ps"


def pulled_result(model: str) -> dict[str, str]:
    """The body ``POST /models/pull`` returns in blocking mode.

    Defined once, here, so that ``ollama`` and ``dmr`` cannot answer the same
    route with different shapes. ``model`` is always the identifier the *caller*
    supplied — never a backend-translated one (see ``runtime/dmr.py``).
    """
    return {"status": "pulled", "model": model}


def deleted_result(model: str) -> dict[str, str]:
    """The body ``DELETE /models/{name}`` returns. Same reasoning as above."""
    return {"status": "deleted", "model": model}


class RuntimePullError(RuntimeError):
    """A pull that the backend reported as failed inside a 2xx response body.

    Ollama signals a failed blocking pull with a non-2xx status, so the
    pre-WARP-1743 code could rely on ``raise_for_status()`` alone and this
    exception is never raised on the default path. It exists for backends whose
    ollama-compatible ``/api/pull`` answers 200 and reports the failure as a
    terminal ``{"error": ...}`` object in the NDJSON body — the ``error`` field
    is part of the verified pull shape (ADR-005 §2). ``main.py`` maps it to 502
    through its existing ``except Exception`` arm; no handler change needed.
    """


@runtime_checkable
class InferenceRuntime(Protocol):
    """What ``main.py`` requires of a backend. Five operations, no more.

    Deliberately narrow: this is the whole of ADR-005's "our dependency" table
    minus ``POST /api/show``, which no code in *this* repo calls (it is the
    orchestrator's capability probe — WARP-1744 owns it). Adding a method here
    is a contract change and needs both implementations plus conformance tests,
    otherwise the abstraction is decorative and rots (ADR-005, Consequences).

    ``pull`` and ``open_pull_stream`` are the two halves of one operation:
    ``POST /models/pull`` serves a blocking JSON body by default and an NDJSON
    progress stream under ``?stream=true`` (WARP-1111 §7.1). They are separate
    methods rather than one flag-switched method because their *return types*
    differ — a finished result dict versus a live response the caller must
    iterate and close.
    """

    #: Stable discriminator for logs/metrics. Matches the ``INFERENCE_RUNTIME``
    #: value that selects this implementation.
    name: str

    async def list_installed(self) -> dict[str, Any]:
        """Models present on disk. Body of ``GET /models/available``."""
        ...

    async def list_loaded(self) -> dict[str, Any]:
        """Models resident in GPU/unified memory. Body of ``GET /models/loaded``."""
        ...

    async def pull(self, model: str) -> dict[str, str]:
        """Download ``model``, blocking until done. Returns :func:`pulled_result`."""
        ...

    async def open_pull_stream(self, model: str) -> httpx.Response:
        """Start a streaming pull and return the *open* upstream response.

        The caller owns the response: it must check ``status_code``, iterate,
        and ``aclose()`` it. That ownership stays in ``main.py`` because the
        NDJSON proxying is bound up with ``LoadingTracker`` semantics that have
        nothing to do with which backend is behind the seam.
        """
        ...

    async def delete(self, model: str) -> dict[str, str]:
        """Remove ``model`` from local storage. Returns :func:`deleted_result`."""
        ...

    async def health(self) -> bool:
        """Cheap reachability probe. Never raises — returns False instead."""
        ...

    def preferred_id(self, pull_tag: str, oci: str | None = None) -> str:
        """Which manifest identifier THIS backend should be addressed with.

        WARP-2130 / ADR-005 §2. A manifest entry can now declare an `oci`
        reference alongside its Ollama `pull_tag`; which of the two goes to the
        daemon depends on which daemon is behind the seam, so the choice lives
        in the adapter rather than in the caller.

        Takes the two strings rather than the `ManifestEntry` on purpose:
        `runtime/` imports nothing from `manifest`, and a contract that reached
        for the model object would create that coupling for no gain.
        """
        ...

    def comparable_id(self, model: str) -> str:
        """Reduce a model id to the form used for "is this already installed?".

        WARP-1743. ``/models/sync`` decides what to pull by testing manifest
        entries against the names the daemon reports. Those two vocabularies are
        the same under Ollama and DIFFERENT under DMR, which reports
        ``docker.io/ai/smollm2:latest`` where the manifest says ``smollm2:360M``.
        Comparing them raw made every entry look absent, so every sync re-pulled
        every model forever — exactly the re-pull storm the WARP-193 guard in
        ``model_sync`` exists to prevent, reintroduced silently by the id
        translation.

        Both sides of the comparison must go through this, and it must be
        idempotent so a value that has already been reduced survives unchanged.
        """
        ...


class OllamaWireRuntime:
    """Shared base for backends that speak Ollama's wire format on tags/ps.

    ``GET /api/tags`` and ``GET /api/ps`` are field-for-field identical between
    Ollama and DMR (ADR-005 §2), so they live here once instead of being copied
    into both adapters — a copy would be free to drift silently, and these two
    responses feed ``/models/available``, ``/models/loaded``, ``/models/sync``'s
    already-pulled set and the health probe.

    Subclasses supply only the three operations that genuinely differ: the two
    pull forms and delete.
    """

    #: Overridden by each concrete adapter.
    name = "ollama-wire"

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    @property
    def client(self) -> httpx.AsyncClient:
        """The bound management client. Its ``base_url`` locates the backend."""
        return self._client

    def preferred_id(self, pull_tag: str, oci: str | None = None) -> str:
        """`pull_tag`, always — an OCI reference means nothing to Ollama.

        Ollama resolves names against `registry.ollama.ai`; handing it
        `ai/foo:bar` would address a repository that registry does not serve.
        So the declared `oci` is deliberately IGNORED here rather than
        preferred, and this path stays byte-identical to its behaviour before
        the field existed. DMR overrides this.
        """
        return pull_tag

    def comparable_id(self, model: str) -> str:
        """Identity — the daemon's vocabulary is the caller's.

        True for Ollama, which echoes back the same ``name:tag`` the manifest
        supplied. DMR overrides this. Keeping identity as the base means the
        default path's comparison is bit-for-bit the string equality it always
        was, not a normalisation that merely happens to agree.
        """
        return (model or "").strip()

    async def list_installed(self) -> dict[str, Any]:
        resp = await self._client.get(TAGS_PATH)
        resp.raise_for_status()
        return resp.json()

    async def list_loaded(self) -> dict[str, Any]:
        resp = await self._client.get(PS_PATH)
        resp.raise_for_status()
        return resp.json()

    async def health(self) -> bool:
        """True iff a tag listing came back 200 within ``TIMEOUT_HEALTH``.

        Swallowing every exception is intentional and pre-existing: ``/health``
        reports reachability as a boolean and must answer even when the backend
        is down. Note this probes ``/api/tags`` on *both* backends rather than
        DMR's own ``GET /engines/status`` — that one is the container-level
        healthcheck (compose's concern); here we want the same question asked
        the same way on every backend so ``/health.ollama_reachable`` keeps
        meaning "the lifecycle API can talk to the daemon".
        """
        try:
            resp = await self._client.get(TAGS_PATH, timeout=TIMEOUT_HEALTH)
            return resp.status_code == 200
        except Exception:
            return False

    # ── backend-specific: implemented by subclasses ──

    async def pull(self, model: str) -> dict[str, str]:  # pragma: no cover - abstract
        raise NotImplementedError

    async def open_pull_stream(self, model: str) -> httpx.Response:  # pragma: no cover - abstract
        raise NotImplementedError

    async def delete(self, model: str) -> dict[str, str]:  # pragma: no cover - abstract
        raise NotImplementedError
