"""Backend selection — one env var, an explicit default, no silent fallback.

WARP-1743 / ADR-005 §1: the backend is chosen by an **explicit named value**,
never inferred from the absence of a setting and never from "a DMR URL happens
to be set". There is exactly one discriminator, :data:`RUNTIME_ENV_VAR`, and its
only legal values are the keys of :data:`_RUNTIMES`.

Two failure modes are treated very differently on purpose:

* **An unrecognised value is fatal.** ``INFERENCE_RUNTIME=dmr-rocm`` raises
  :class:`UnknownRuntimeError` at import, which stops the process. Falling back
  to Ollama would leave an operator who believes the box is on DMR staring at a
  perfectly healthy service that quietly is not — the exact silent-degradation
  class ADR-005 §3 spends a section on. A crash-looping container is loud;
  a wrong-but-green one is not.
* **An unset or blank value is the default.** Blank is treated as unset because
  a compose file written as ``INFERENCE_RUNTIME=${INFERENCE_RUNTIME:-}`` hands
  the process an empty string, and taking down every appliance that ships that
  line would be a self-inflicted outage caused by *nothing being configured* —
  the precise opposite of shipping dark (ADR-005 §8). It is logged at WARNING so
  it is still observable. This is not nullability-driven selection: the default
  is the named constant :data:`DEFAULT_RUNTIME`, and reaching DMR still requires
  writing the literal string ``dmr``.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping

import httpx

from .base import InferenceRuntime
from .dmr import DmrRuntime
from .ollama import OllamaRuntime

logger = logging.getLogger(__name__)

#: The single backend discriminator.
RUNTIME_ENV_VAR = "INFERENCE_RUNTIME"

#: Optional base-url override for whichever runtime is selected. Falls back to
#: ``OLLAMA_URL`` so an appliance that sets neither resolves exactly what it
#: resolves today. Renaming ``OLLAMA_URL`` itself is a separate ticket in the
#: WARP-1740 epic and deliberately not WARP-1743 — a rename touches every
#: compose file, the box's `.env`, and the two-box deployment at once, and this
#: ticket's whole claim is that it changes no deployed configuration.
RUNTIME_URL_ENV_VAR = "INFERENCE_RUNTIME_URL"
LEGACY_URL_ENV_VAR = "OLLAMA_URL"

#: Ollama stays the default and the reference implementation (ADR-005 §1).
#: Flipping this is Phase 2 and its own hard-gated ticket (ADR-005 Sequencing).
DEFAULT_RUNTIME = "ollama"

#: Unchanged from the literal ``main.py`` carried before WARP-1743. Kept here so
#: the default exists once rather than in two modules that can drift.
DEFAULT_BASE_URL = "http://localhost:11434"

_RUNTIMES: dict[str, type[OllamaRuntime] | type[DmrRuntime]] = {
    OllamaRuntime.name: OllamaRuntime,
    DmrRuntime.name: DmrRuntime,
}


class UnknownRuntimeError(ValueError):
    """Raised for a configured backend name we have no implementation for."""


def known_runtimes() -> tuple[str, ...]:
    """Every legal :data:`RUNTIME_ENV_VAR` value, sorted."""
    return tuple(sorted(_RUNTIMES))


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def resolve_runtime_name(env: Mapping[str, str] | None = None) -> str:
    """The configured backend name, or :data:`DEFAULT_RUNTIME`.

    Raises :class:`UnknownRuntimeError` for anything else. Call this at import
    time so a typo fails the process rather than the first request.
    """
    source = _env(env)
    raw = source.get(RUNTIME_ENV_VAR)
    if raw is None:
        return DEFAULT_RUNTIME
    name = raw.strip().lower()
    if not name:
        logger.warning(
            "%s is set but empty; using the default backend %r. "
            "An empty value usually means a compose default expanded to nothing.",
            RUNTIME_ENV_VAR,
            DEFAULT_RUNTIME,
        )
        return DEFAULT_RUNTIME
    if name not in _RUNTIMES:
        raise UnknownRuntimeError(
            f"{RUNTIME_ENV_VAR}={raw!r} is not a known inference runtime "
            f"(known: {', '.join(known_runtimes())}). Refusing to start rather "
            f"than falling back to {DEFAULT_RUNTIME!r}: a box configured for a "
            f"backend it is not running must fail loudly, not serve happily "
            f"from the wrong one."
        )
    return name


def resolve_base_url(env: Mapping[str, str] | None = None) -> str:
    """Base URL for the selected runtime.

    ``INFERENCE_RUNTIME_URL`` wins when set to something non-blank; otherwise
    this resolves ``OLLAMA_URL`` **exactly** the way ``main.py`` always has —
    including its behaviour for an explicitly-empty value — so that a deployment
    which sets no new variable gets a byte-identical base URL. Only the new
    variable gets the blank-means-unset treatment; the legacy one keeps its
    historical semantics precisely because changing them would be a behaviour
    change, however unlikely the case.
    """
    source = _env(env)
    override = (source.get(RUNTIME_URL_ENV_VAR) or "").strip()
    if override:
        return override
    return source.get(LEGACY_URL_ENV_VAR, DEFAULT_BASE_URL)


def build_runtime(
    client: httpx.AsyncClient,
    *,
    name: str | None = None,
    env: Mapping[str, str] | None = None,
) -> InferenceRuntime:
    """Bind the selected backend adapter to ``client``.

    Pass ``name`` when the caller already resolved it at startup (``main.py``
    does, so the env is read once and a bad value cannot first surface on a
    request). Adapters are stateless wrappers around the client, so constructing
    one per call is a single attribute assignment — cheaper than caching an
    object whose only field is a client the test suite swaps underneath us.
    """
    resolved = resolve_runtime_name(env) if name is None else name.strip().lower()
    runtime_cls = _RUNTIMES.get(resolved)
    if runtime_cls is None:
        raise UnknownRuntimeError(
            f"no inference runtime named {resolved!r} "
            f"(known: {', '.join(known_runtimes())})"
        )
    return runtime_cls(client)
