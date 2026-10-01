"""WARP-3426 — no Hugging Face asset is fetched at runtime.

The image bakes every Hub asset at build time and runs with HF_HUB_OFFLINE=1;
its Dockerfile proves the baked load in a `RUN --network=none` step. That step
only runs when the image is rebuilt, so this is the PR-time half for
source-only changes: with an EMPTY cache, offline mode on and every Python
socket cut, each production loader must raise an offline-cache error. It must
not open a connection, and it must not succeed, because succeeding from an
empty cache means it fetched through a path that ignores offline mode. The old
`Tokenizer.from_pretrained(repo)` did exactly that.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

import embedding_models
from extractors import audio

SERVICE_DIR = Path(__file__).resolve().parent.parent

# Runs in a fresh interpreter so HF_HUB_OFFLINE is read at import, exactly as
# in the container. Any DNS lookup or connect from Python ends the process.
_PROBE = """
import socket, sys
def _cut(*a, **k):
    raise SystemExit("WARP-3426 NETWORK ATTEMPT")
socket.getaddrinfo = _cut
socket.create_connection = _cut
socket.socket.connect = _cut
try:
    exec(sys.argv[1])
except Exception as e:
    chain = []
    while e is not None:
        chain.append(f"{type(e).__name__}: {e}")
        e = e.__cause__ or e.__context__
    print("RAISED", " <- ".join(chain))
else:
    print("LOADED")
"""

_OFFLINE_ERROR = re.compile(
    r"LocalEntryNotFound|OfflineModeIsEnabled|outgoing traffic has been disabled"
)

_COMMIT = re.compile(r"[0-9a-f]{40}")


def _load_offline(stmt: str, cache: Path) -> str:
    env = {
        **os.environ,
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HOME": str(cache),
    }
    r = subprocess.run(
        [sys.executable, "-c", _PROBE, stmt],
        cwd=SERVICE_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    out = r.stdout + r.stderr
    assert "NETWORK ATTEMPT" not in out, f"{stmt!r} tried to reach the network:\n{out}"
    assert r.stdout.startswith("RAISED"), (
        f"{stmt!r} loaded from an EMPTY cache with offline mode on, so it "
        f"fetched past HF_HUB_OFFLINE:\n{out}"
    )
    assert _OFFLINE_ERROR.search(out), f"{stmt!r} failed for another reason:\n{out}"
    return out


def test_measuring_tokenizer_never_downloads(tmp_path):
    pytest.importorskip("tokenizers")
    pytest.importorskip("huggingface_hub")
    _load_offline("import chunker; chunker._get_measuring_tokenizer()", tmp_path)


@pytest.mark.skipif(audio.WhisperModel is None, reason="faster-whisper not installed")
def test_asr_model_never_downloads(tmp_path):
    _load_offline("from extractors.audio import _load_model; _load_model('cpu')", tmp_path)


def test_every_hub_asset_is_pinned_to_a_commit():
    """A branch name resolves offline only if the image baked that ref, and
    would let the bytes move under an embedded corpus if it ever didn't."""
    for spec in embedding_models.EMBEDDING_MODELS.values():
        assert _COMMIT.fullmatch(spec.hf_revision), spec
    assert _COMMIT.fullmatch(audio._PINNED_REVISIONS[audio._model_name()])
