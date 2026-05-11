"""Audio extractor — faster-whisper ASR with CUDA→CPU fallback.

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.1

Engine: faster-whisper (CTranslate2). Default model `small.en` (~470MB);
configurable via `ASR_MODEL` env var with allow-list.

Single-worker queue: a process-global threading.Lock serializes
transcription calls so we never run two ASR jobs in parallel and never
crash the Ollama-owned GPU. CUDA-first; on RuntimeError (OOM, etc.)
fall back to CPU for that call only and emit `gpu_unavailable`.

Lazy model load: model is instantiated on first call and cached on the
module. `_reset_model_cache()` is a test seam to drop the cache.
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Optional, Union

from anchor_schema import MediaTimestampAnchor
from extractors.spans import Span

from .types import ExtractedDoc

logger = logging.getLogger(__name__)

# MIMEs we claim. Anything else returns None from extract().
SUPPORTED_MIMES = frozenset(
    {
        "audio/mpeg",
        "audio/mp4",  # m4a
        "audio/wav",
        "audio/x-wav",
        "audio/ogg",
        "audio/flac",
        "audio/webm",
        "audio/aac",
    }
)

# Allowed model names — keep the env var honest.
_ALLOWED_MODELS = frozenset({"tiny.en", "base.en", "small.en", "medium.en", "large-v3"})

# Lazy import — keep the module importable even when faster-whisper isn't
# installed yet (helps unit tests that mock WhisperModel).
try:
    from faster_whisper import WhisperModel  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    WhisperModel = None  # type: ignore[assignment,misc]


_model_lock = threading.Lock()
_model_cache: dict[str, object] = {}  # keyed by f"{model_name}:{device}"


def _model_name() -> str:
    raw = os.environ.get("ASR_MODEL", "small.en")
    if raw not in _ALLOWED_MODELS:
        logger.warning("Unknown ASR_MODEL=%r; falling back to small.en", raw)
        return "small.en"
    return raw


def _reset_model_cache() -> None:
    """Test seam: drop the cached model so the next call re-instantiates."""
    _model_cache.clear()


def _load_model(device: str):
    """Return a cached WhisperModel for the given device, instantiating if needed."""
    name = _model_name()
    key = f"{name}:{device}"
    if key not in _model_cache:
        compute_type = "float16" if device == "cuda" else "int8"
        _model_cache[key] = WhisperModel(name, device=device, compute_type=compute_type)
    return _model_cache[key]


# Backwards-compatibility alias — older callers may import `_get_model`.
_get_model = _load_model


def extract(path: Union[str, Path], mime: str) -> Optional[ExtractedDoc]:
    """Transcribe an audio file via faster-whisper.

    Returns None if the MIME isn't in SUPPORTED_MIMES.
    On CUDA OOM, falls back to CPU and emits 'gpu_unavailable' in warnings.
    """
    if mime not in SUPPORTED_MIMES:
        return None

    warnings: list[str] = []
    segments = []
    info = None

    # Single-worker queue: only one ASR job runs at a time across the
    # file-indexer process.
    with _model_lock:
        try:
            model = _load_model("cuda")
            segments_iter, info = model.transcribe(
                str(path), beam_size=5, temperature=0.0
            )
            segments = list(segments_iter)
        except (RuntimeError, ValueError) as exc:
            # RuntimeError: most commonly CUDA OOM when Ollama is mid-inference.
            # ValueError: ctranslate2 raises this when the package was not
            #   compiled with CUDA (e.g. macOS dev box, CPU-only Jetson host).
            # Either way the response is the same: drop to CPU for this call
            # and emit gpu_unavailable so the caller knows.
            logger.warning("CUDA path failed (%s); falling back to CPU", exc)
            # Drop the broken cuda entry so we don't keep retrying it.
            _model_cache.pop(f"{_model_name()}:cuda", None)
            warnings.append("gpu_unavailable")
            model = _load_model("cpu")
            segments_iter, info = model.transcribe(
                str(path), beam_size=5, temperature=0.0
            )
            segments = list(segments_iter)

    # One Span per non-empty Whisper segment, anchored to its time window.
    spans: list[Span] = []
    for seg in segments:
        seg_text = (seg.text or "").strip()
        if not seg_text:
            continue
        start_ms = int(round(seg.start * 1000))
        end_ms = int(round(seg.end * 1000))
        # MediaTimestampAnchor strictly requires endMs > startMs. Whisper
        # occasionally emits zero-length or inverted segments; skip them
        # rather than crashing the whole transcription.
        if end_ms <= start_ms:
            warnings.append(f"degenerate_segment_skipped:start={start_ms}ms")
            continue
        spans.append(
            Span(
                text=seg_text,
                anchor=MediaTimestampAnchor(startMs=start_ms, endMs=end_ms),
            )
        )

    language = getattr(info, "language", None) if info else None
    duration = getattr(info, "duration", None) if info else None

    return ExtractedDoc(
        spans=spans,
        language=language,
        metadata={
            "extractor_name": "audio",
            "extractor_version": "2",
            "duration_seconds": duration,
        },
        warnings=warnings,
    )
