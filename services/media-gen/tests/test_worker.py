"""Exercise built-in pipeline arguments and edits with injected fake engines.

These verify worker code contracts, not model quality or GPU compatibility.
"""
import contextlib
import io
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

import contracts
import worker
from test_media import encoded


@pytest.fixture
def engine(monkeypatch, models):
    events = []
    class Generator:
        def __init__(self, device): events.append(("generator_device", device))
        def manual_seed(self, seed): events.append(("seed", seed)); return self
    torch = SimpleNamespace(float32="float32", float16="float16", bfloat16="bfloat16", Generator=Generator, cuda=SimpleNamespace(is_available=lambda: True), inference_mode=contextlib.nullcontext)
    class Pipeline:
        @classmethod
        def from_pretrained(cls, path, **kwargs):
            events.append(("load", path, kwargs)); return cls()
        @classmethod
        def from_pipe(cls, pipeline): events.append(("from_pipe", cls.__name__)); return pipeline
        def to(self, device): events.append(("to", device)); return self
        def enable_model_cpu_offload(self, **kwargs): events.append(("offload", kwargs))
        def set_progress_bar_config(self, **kwargs): pass
        def enable_attention_slicing(self): pass
        def __call__(self, **kwargs):
            events.append(("call", kwargs))
            image = Image.new("RGB", (kwargs["width"], kwargs["height"]), "blue")
            return SimpleNamespace(images=[image], frames=[[image] * kwargs.get("num_frames", 9)])
    module = SimpleNamespace(**{name: type(name, (Pipeline,), {}) for name in ("StableDiffusionXLPipeline", "StableDiffusionXLImg2ImgPipeline", "StableDiffusionXLInpaintPipeline", "LTXPipeline", "LTXImageToVideoPipeline", "WanPipeline", "AutoencoderKLWan")})
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "diffusers", module)
    monkeypatch.setenv("MEDIA_GEN_MODEL_ROOT", str(models))
    monkeypatch.setenv("MEDIA_GEN_DEVICE", "cuda")
    monkeypatch.setenv("MEDIA_GEN_VIDEO_ENGINE", "wan")
    return events


def test_sdxl_local_safetensor_loader_and_real_png(engine):
    result = worker.render(contracts.RenderRequest(kind="image", prompt="a tree", seed=8))
    assert Image.open(io.BytesIO(result)).getpixel((0, 0)) == (0, 0, 255)
    load = next(event for event in engine if event[0] == "load")
    assert load[1].endswith("sdxl") and not load[1].startswith("https:")
    assert load[2]["local_files_only"] is True and load[2]["use_safetensors"] is True
    assert load[2]["trust_remote_code"] is False and load[2]["token"] is False
    assert ("seed", 8) in engine and ("offload", {"device": "cuda"}) in engine


@pytest.mark.parametrize("mask_color,expected", [("black", (255, 0, 0)), ("white", (0, 0, 255))])
def test_mask_edit_preserves_unmasked_pixels(engine, mask_color, expected):
    job = contracts.RenderRequest(kind="image", prompt="make blue", source_base64=encoded(color="red"), mask_base64=encoded(color=mask_color))
    result = worker.render(job)
    assert Image.open(io.BytesIO(result)).getpixel((0, 0)) == expected
    assert ("from_pipe", "StableDiffusionXLInpaintPipeline") in engine


def test_source_edit_uses_img2img_with_explicit_strength(engine):
    worker.render(contracts.RenderRequest(kind="image", prompt="make blue", source_base64=encoded()))
    assert ("from_pipe", "StableDiffusionXLImg2ImgPipeline") in engine
    params = next(event[1] for event in engine if event[0] == "call")
    assert params["strength"] == 0.75 and params["image"].size == (512, 512)


def test_wan_fixed_loader_float32_vae_and_bounded_mp4_encoding(engine, monkeypatch):
    encoded_bytes = []
    class FakeEncoder:
        def __init__(self, argv, **kwargs):
            assert argv[0] == "/usr/bin/ffmpeg" and "libx264" in argv and "yuv420p" in argv
            assert "https:" not in " ".join(argv) and kwargs["stdin"] == worker.subprocess.PIPE
            Path(argv[-1]).write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"fake")
            self.stdin = SimpleNamespace(write=lambda data: encoded_bytes.append(data), close=lambda: None)
        def wait(self, **kwargs): return 0
        def poll(self): return 0
    monkeypatch.setattr(worker.subprocess, "Popen", FakeEncoder)
    result = worker.render(contracts.RenderRequest(kind="video", prompt="a river", width=256, height=256, frames=9))
    assert result[4:8] == b"ftyp" and len(encoded_bytes) == 9
    assert all(len(data) == 256 * 256 * 3 for data in encoded_bytes)
    loads = [event for event in engine if event[0] == "load"]
    assert loads[0][2]["subfolder"] == "vae" and loads[0][2]["dtype"] == "float32"
    assert loads[1][1].endswith("wan")


def test_wan_source_refused_before_loading(engine):
    with pytest.raises(ValueError, match="video_source_requires_ltx_engine"):
        worker.render(contracts.RenderRequest(kind="video", prompt="animate", source_base64=encoded()))
    assert not any(event[0] == "load" for event in engine)


def test_operator_engine_unknown_fails_closed(monkeypatch):
    monkeypatch.setenv("MEDIA_GEN_VIDEO_ENGINE", "https://evil.example/model")
    with pytest.raises(ValueError, match="invalid_operator_video_engine"):
        contracts.video_engine()


def test_offline_environment_is_forced():
    assert worker.os.environ["HF_HUB_OFFLINE"] == "1" and worker.os.environ["TRANSFORMERS_OFFLINE"] == "1"
    assert "HF_TOKEN" not in worker.os.environ
