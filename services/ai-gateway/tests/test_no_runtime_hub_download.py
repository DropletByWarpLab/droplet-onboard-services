"""WARP-3426 — no Hugging Face asset is fetched at runtime.

The image bakes the embedding model, the query classifier and the reranker at
build time and runs with HF_HUB_OFFLINE=1; its Dockerfile proves the baked load
in a `RUN --network=none` step. That step only runs when the image is rebuilt,
so this is the PR-time half for source-only changes: with an EMPTY cache,
offline mode on and every Python socket cut, each production loader must raise
an offline-cache error. It must not open a connection, and it must not
succeed, because succeeding from an empty cache means it fetched through a path
that ignores offline mode.
"""
from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

SERVICE_DIR = Path(__file__).resolve().parent.parent

# Cold torch/transformers imports in a fresh interpreter; well above the
# suite-wide 60 s ceiling in pytest.ini, well below the CI job timeout.
pytestmark = pytest.mark.timeout(240)

# Runs in a fresh interpreter so HF_HUB_OFFLINE is read at import, exactly as
# in the container. Any DNS lookup or connect from Python ends the process.
# The loaders' cache dirs default to /var/cache/droplet/models (root-owned on
# a CI runner), so the probe points them at the empty test cache first.
_PROBE = """
import os, pathlib, socket, sys
def _cut(*a, **k):
    raise SystemExit("WARP-3426 NETWORK ATTEMPT")
socket.getaddrinfo = _cut
socket.create_connection = _cut
socket.socket.connect = _cut
cache = pathlib.Path(os.environ["HF_HOME"])
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
    r"|couldn't find them in the cached files"
)

_COMMIT = re.compile(r"[0-9a-f]{40}")


def _needs(module: str) -> None:
    # find_spec, not importorskip: keep torch out of the pytest process.
    if importlib.util.find_spec(module) is None:
        pytest.skip(f"{module} not installed")


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
        timeout=200,
    )
    out = r.stdout + r.stderr
    assert "NETWORK ATTEMPT" not in out, f"{stmt!r} tried to reach the network:\n{out}"
    assert r.stdout.startswith("RAISED"), (
        f"{stmt!r} loaded from an EMPTY cache with offline mode on, so it "
        f"fetched past HF_HUB_OFFLINE:\n{out}"
    )
    assert _OFFLINE_ERROR.search(out), f"{stmt!r} failed for another reason:\n{out}"
    return out


def test_embedding_model_never_downloads(tmp_path):
    _needs("sentence_transformers")
    _load_offline("from providers.embeddings import _get_model; _get_model()", tmp_path)


def test_query_classifier_never_downloads(tmp_path):
    _needs("transformers")
    _load_offline(
        "import query_classifier as q; q.CLASSIFIER_CACHE_DIR = cache; "
        "q.QueryClassifierSingleton()",
        tmp_path,
    )


def test_reranker_never_downloads(tmp_path):
    _needs("optimum")
    _load_offline(
        "import reranker as r; r.RERANKER_CACHE_DIR = cache; r.RerankerSingleton()",
        tmp_path,
    )


def test_every_hub_asset_is_pinned_to_a_commit():
    """Offline, a branch name resolves only if the image baked that ref; and a
    moving ref would change the embedding space under stored vectors."""
    from providers import embeddings
    import query_classifier
    import reranker

    for repo in embeddings.SUPPORTED_MODELS.values():
        assert _COMMIT.fullmatch(embeddings.PINNED_REVISIONS[repo]), repo
    assert _COMMIT.fullmatch(query_classifier.CLASSIFIER_MODEL_REVISION)
    assert _COMMIT.fullmatch(reranker.RERANKER_MODEL_REVISION)
