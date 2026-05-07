"""Unit tests for the audio extractor (WARP-197)."""
from __future__ import annotations

from pathlib import Path

import pytest

from extractors import audio
from extractors.types import ExtractedDoc

FIXTURES = Path(__file__).parent / "fixtures"

# `faster-whisper` is in requirements.txt but NOT in requirements-dev.txt
# (the dep pulls in a ~150 MB CTranslate2 wheel that we don't need for the
# unit-test surface — the integration test under RUN_RAG_INTEGRATION=1
# exercises the real transcription path with the live Compose stack).
# When faster-whisper isn't installed, `audio.WhisperModel` is `None` per
# the lazy-import in extractors/audio.py — skip the live-call test.
_WHISPER_AVAILABLE = audio.WhisperModel is not None


@pytest.mark.skipif(
    not _WHISPER_AVAILABLE,
    reason="faster-whisper not installed (only in requirements.txt, not -dev). "
    "Live ASR is exercised by tests/rag-audio.integration.test.ts under "
    "RUN_RAG_INTEGRATION=1.",
)
def test_extract_returns_extracted_doc_for_wav():
    """Happy path: real WAV file produces a non-None ExtractedDoc with metadata."""
    result = audio.extract(FIXTURES / "sample.wav", mime="audio/wav")
    assert result is not None
    assert isinstance(result, dict)  # ExtractedDoc is TypedDict; runtime is dict
    assert "text" in result
    assert "metadata" in result
    assert "duration_sec" in result["metadata"]
    # We don't assert specific text content because the fixture may be a tone
    # generator — the integration test is where we'd assert phrase content.
    assert result["metadata"]["duration_sec"] > 0


def test_extract_returns_none_for_unsupported_mime():
    """Defensive: extractor refuses MIMEs it doesn't claim."""
    result = audio.extract(FIXTURES / "sample.wav", mime="text/plain")
    assert result is None


def test_extract_warns_on_cpu_fallback(monkeypatch):
    """When CUDA OOMs, the extractor falls back to CPU and emits a warning."""
    # Force the CUDA path to raise OOM on first call.
    calls = {"n": 0}

    class FakeModel:
        def __init__(self, *a, **kw):
            calls["n"] += 1
            if kw.get("device") == "cuda":
                raise RuntimeError("CUDA out of memory")

        def transcribe(self, *a, **kw):
            # Return shape: (segments, info)
            class Seg:
                start = 0.0
                end = 1.0
                text = "hello"

            class Info:
                language = "en"
                duration = 1.0

            return [Seg()], Info()

    monkeypatch.setattr(audio, "WhisperModel", FakeModel)
    audio._reset_model_cache()  # exposed test seam — see implementation
    result = audio.extract(FIXTURES / "sample.wav", mime="audio/wav")
    assert result is not None
    assert "gpu_unavailable" in result["warnings"]
