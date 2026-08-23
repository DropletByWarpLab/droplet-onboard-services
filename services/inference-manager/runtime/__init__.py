"""Inference-runtime adapters for inference-manager (WARP-1743, ADR-005 §1).

One seam between the lifecycle API and whichever daemon serves the weights.
``main.py`` imports from this package and never from a concrete backend, so the
set of things that know a backend's wire format is exactly: ``runtime/ollama.py``
and ``runtime/dmr.py``.

Selection is a single explicit env var — see :mod:`runtime.factory`. The default
is Ollama and nothing here changes that; ``dmr`` ships dark (ADR-005 §8).

Layout::

    base.py     the contract + the endpoints both backends share verbatim
    ollama.py   default backend; a faithful extraction of pre-WARP-1743 main.py
    dmr.py      Docker Model Runner; opt-in, differs only in delete + model ids
    factory.py  INFERENCE_RUNTIME -> implementation, with a loud unknown-value path
"""

from __future__ import annotations

from .base import (
    InferenceRuntime,
    OllamaWireRuntime,
    RuntimePullError,
    deleted_result,
    pulled_result,
)
from .dmr import DmrRuntime
from .factory import (
    DEFAULT_BASE_URL,
    DEFAULT_RUNTIME,
    LEGACY_URL_ENV_VAR,
    RUNTIME_ENV_VAR,
    RUNTIME_URL_ENV_VAR,
    UnknownRuntimeError,
    build_runtime,
    known_runtimes,
    resolve_base_url,
    resolve_runtime_name,
)
from .ollama import OllamaRuntime

__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_RUNTIME",
    "DmrRuntime",
    "InferenceRuntime",
    "LEGACY_URL_ENV_VAR",
    "OllamaRuntime",
    "OllamaWireRuntime",
    "RUNTIME_ENV_VAR",
    "RUNTIME_URL_ENV_VAR",
    "RuntimePullError",
    "UnknownRuntimeError",
    "build_runtime",
    "deleted_result",
    "known_runtimes",
    "pulled_result",
    "resolve_base_url",
    "resolve_runtime_name",
]
