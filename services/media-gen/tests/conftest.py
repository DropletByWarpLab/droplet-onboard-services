import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("MEDIA_GEN_SERVICE_TOKEN", "test-media-token")
import main

AUTH = {"Authorization": "Bearer test-media-token"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "MEDIA_GEN_SERVICE_TOKEN", "test-media-token")
    return TestClient(main.app)


@pytest.fixture
def models(tmp_path, monkeypatch):
    import json
    for name, cls, weighted in (("sdxl", "StableDiffusionXLPipeline", ("unet", "vae", "text_encoder", "text_encoder_2")), ("wan", "WanPipeline", ("transformer", "vae", "text_encoder")), ("ltx", "LTXPipeline", ("transformer", "vae", "text_encoder"))):
        folder = tmp_path / name
        folder.mkdir()
        (folder / "model_index.json").write_text(json.dumps({"_class_name": cls}))
        for component in weighted:
            (folder / component).mkdir()
            (folder / component / "test.safetensors").write_bytes(b"fake weights, never loaded")
        for component in ("tokenizer", "scheduler") + (("tokenizer_2",) if name == "sdxl" else ()):
            (folder / component).mkdir()
    monkeypatch.setattr(main, "MODEL_ROOT", tmp_path)
    return tmp_path
