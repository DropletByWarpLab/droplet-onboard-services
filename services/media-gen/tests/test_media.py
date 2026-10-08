import asyncio
import base64
import io
import json
from pathlib import Path

import pytest
from PIL import Image
from fastapi import HTTPException
from pydantic import ValidationError

import contracts
import main

AUTH = {"Authorization": "Bearer test-media-token"}


def png(size=(512, 512), color="red"):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def encoded(size=(32, 32), color="red"):
    return base64.b64encode(png(size, color)).decode()


def test_auth_closed_when_token_missing(client, monkeypatch):
    monkeypatch.setattr(main, "MEDIA_GEN_SERVICE_TOKEN", "")
    assert client.get("/health").status_code == 200
    assert client.get("/capabilities", headers=AUTH).status_code == 503
    assert client.post("/render", json={"kind": "image", "prompt": "a tree"}, headers=AUTH).status_code == 503


def test_all_nonhealth_surfaces_need_auth(client):
    assert client.get("/capabilities").status_code == 401
    assert client.post("/render", json={"kind": "image", "prompt": "a tree"}).status_code == 401


def test_unprovisioned_model_is_named_closed_failure(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "MODEL_ROOT", tmp_path)
    data = client.get("/capabilities", headers=AUTH).json()
    assert data["image"] is False and data["video"] is False
    assert data["offline"] is True and data["inferenceVerified"] is False
    result = client.post("/render", json={"kind": "image", "prompt": "a tree"}, headers=AUTH)
    assert result.status_code == 503 and result.json()["detail"] == "model_not_provisioned"


def test_pipeline_index_without_weights_is_not_provisioned(tmp_path):
    folder = tmp_path / "sdxl"; folder.mkdir()
    (folder / "model_index.json").write_text('{"_class_name":"StableDiffusionXLPipeline"}')
    assert contracts.model_path(tmp_path, "sdxl") is None


def test_custom_pipeline_and_library_refused(models):
    path = models / "sdxl" / "model_index.json"
    path.write_text('{"_class_name":"CustomRemotePipeline"}')
    assert contracts.model_path(models, "sdxl") is None
    path.write_text('{"_class_name":"StableDiffusionXLPipeline","unet":["evil_library","CustomUnet"]}')
    assert contracts.model_path(models, "sdxl") is None


def test_fake_engine_contract_returns_real_png_and_headers(client, models, monkeypatch):
    captured = []
    async def fake(job):
        captured.append(job)
        return png((job.width, job.height))
    monkeypatch.setattr(main, "_run_worker", fake)
    result = client.post("/render", json={"kind": "image", "prompt": "a tree", "seed": 42}, headers=AUTH)
    assert result.status_code == 200 and result.headers["content-type"] == "image/png"
    assert result.headers["x-media-seed"] == "42" and result.headers["x-media-engine"] == "sdxl"
    assert result.headers["cache-control"] == "no-store"
    assert Image.open(io.BytesIO(result.content)).size == (512, 512)
    assert captured[0].prompt == "a tree"


def test_fake_video_contract_is_mp4_not_png(client, models, monkeypatch):
    # A fake header proves route MIME/header contracts, not playable video/GPU inference.
    async def fake(job):
        assert job.frames == 17 and job.fps == 12
        return b"\x00\x00\x00\x18ftypmp42" + b"test-video"
    monkeypatch.setattr(main, "_run_worker", fake)
    result = client.post("/render", json={"kind": "video", "prompt": "a river", "width": 256, "height": 256, "frames": 17, "seed": 2}, headers=AUTH)
    assert result.status_code == 200 and result.headers["content-type"] == "video/mp4"
    assert result.headers["x-media-engine"] == "wan"


def test_optional_ltx_source_video_and_capabilities(client, models, monkeypatch):
    monkeypatch.setenv("MEDIA_GEN_VIDEO_ENGINE", "ltx")
    data = client.get("/capabilities", headers=AUTH).json()
    assert data["engine"]["video"] == "ltx" and data["videoSourceImage"] is True
    async def fake(job):
        assert job.source_base64 is not None
        return b"\x00\x00\x00\x18ftypmp42fake"
    monkeypatch.setattr(main, "_run_worker", fake)
    result = client.post("/render", json={"kind": "video", "prompt": "animate", "source_base64": encoded()}, headers=AUTH)
    assert result.status_code == 200 and result.headers["x-media-engine"] == "ltx"


def test_default_wan_source_refused_explicitly(client, models, monkeypatch):
    monkeypatch.setenv("MEDIA_GEN_VIDEO_ENGINE", "wan")
    result = client.post("/render", json={"kind": "video", "prompt": "animate", "source_base64": encoded()}, headers=AUTH)
    assert result.status_code == 400 and result.json()["detail"] == "video_source_requires_ltx_engine"


@pytest.mark.parametrize("changes", [{"kind": "other"}, {"prompt": " "}, {"prompt": "x" * 4001}, {"width": 500}, {"width": 256}, {"height": 1088}, {"steps": 51}, {"steps": True}, {"seed": -1}, {"seed": 2**32}, {"seed": True}, {"mask_base64": encoded()}, {"source_base64": ""}, {"source_base64": "https://example.com/image.png"}, {"source_base64": encoded(), "mask_base64": encoded((16, 16))}, {"source_base64": "/data/private.png"}, {"model": "remote/weights"}, {"kind": "video", "frames": 16}, {"kind": "video", "width": 800}, {"kind": "video", "source_base64": encoded(), "mask_base64": encoded()}])
def test_invalid_input_never_spawns_worker(client, models, monkeypatch, changes):
    async def forbidden(_):
        pytest.fail("invalid input must not start inference")
    monkeypatch.setattr(main, "_run_worker", forbidden)
    result = client.post("/render", json={"kind": "image", "prompt": "a tree", **changes}, headers=AUTH)
    assert result.status_code == 400


def test_source_mask_resizing_and_no_silent_misalignment():
    job = contracts.RenderRequest(kind="image", prompt="replace red with blue", source_base64=encoded(), mask_base64=encoded(color="white"), width=512, height=768)
    source, mask = contracts.prepare_images(job)
    assert source.size == (512, 768) and mask.size == source.size and mask.mode == "L"


def test_request_body_bounded_before_json(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_REQUEST_BYTES", 1024)
    result = client.post("/render", content=b" " * 1025, headers={**AUTH, "Content-Type": "application/json"})
    assert result.status_code == 413


@pytest.mark.asyncio
async def test_subprocess_contract_and_exact_png(tmp_path, monkeypatch):
    data = png()
    script = tmp_path / "fake_worker.py"
    script.write_text("import sys,json,base64\njob=json.load(sys.stdin)\nassert job['seed']==42\nsys.stdout.buffer.write(base64.b64decode(" + repr(base64.b64encode(data).decode()) + "))\n")
    monkeypatch.setattr(main, "WORKER_SCRIPT", script)
    output = await main._run_worker(contracts.RenderRequest(kind="image", prompt="a tree", seed=42))
    assert output == data


@pytest.mark.asyncio
async def test_worker_environment_has_no_api_or_provider_credentials(tmp_path, monkeypatch):
    for key in ("MEDIA_GEN_SERVICE_TOKEN", "JWT_SECRET", "HF_TOKEN", "BRAVE_SEARCH_API_KEY", "DROPLET_TLS_KEY", "HTTPS_PROXY"):
        monkeypatch.setenv(key, "must-not-reach-inference")
    monkeypatch.setenv("MEDIA_GEN_DEVICE", "cpu")
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    data = png()
    script = tmp_path / "environment_worker.py"
    script.write_text("import os,sys,base64\nassert not any(k in os.environ for k in ('MEDIA_GEN_SERVICE_TOKEN','JWT_SECRET','HF_TOKEN','BRAVE_SEARCH_API_KEY','DROPLET_TLS_KEY','HTTPS_PROXY'))\nassert os.environ['MEDIA_GEN_DEVICE']=='cpu'\nassert os.environ['HF_HUB_OFFLINE']=='1'\nassert os.environ['TRANSFORMERS_OFFLINE']=='1'\nsys.stdin.buffer.read()\nsys.stdout.buffer.write(base64.b64decode(" + repr(base64.b64encode(data).decode()) + "))\n")
    monkeypatch.setattr(main, "WORKER_SCRIPT", script)
    assert await main._run_worker(contracts.RenderRequest(kind="image", prompt="a tree")) == data


@pytest.mark.asyncio
async def test_subprocess_timeout_kills_worker_and_does_not_return_partial_media(tmp_path, monkeypatch):
    script = tmp_path / "slow_worker.py"
    script.write_text("import sys,time\nsys.stdin.buffer.read()\nsys.stdout.buffer.write(b'partial')\nsys.stdout.flush()\ntime.sleep(30)\n")
    monkeypatch.setattr(main, "WORKER_SCRIPT", script)
    monkeypatch.setattr(main, "IMAGE_TIMEOUT", 0.2)
    with pytest.raises(HTTPException) as result:
        await main._run_worker(contracts.RenderRequest(kind="image", prompt="a tree"))
    assert result.value.status_code == 504 and result.value.detail == "media_generation_timeout"


@pytest.mark.asyncio
async def test_deadline_also_bounds_worker_after_pipes_close(tmp_path, monkeypatch):
    script = tmp_path / "silent_worker.py"
    script.write_text("import os,sys,time\nsys.stdin.buffer.read()\nos.close(1)\nos.close(2)\ntime.sleep(30)\n")
    monkeypatch.setattr(main, "WORKER_SCRIPT", script)
    monkeypatch.setattr(main, "IMAGE_TIMEOUT", 0.2)
    with pytest.raises(HTTPException) as result:
        await main._run_worker(contracts.RenderRequest(kind="image", prompt="a tree"))
    assert result.value.status_code == 504


@pytest.mark.asyncio
async def test_subprocess_output_limit_kills_worker(tmp_path, monkeypatch):
    script = tmp_path / "large_worker.py"
    script.write_text("import sys,time\nsys.stdin.buffer.read()\nsys.stdout.buffer.write(b'x'*1025)\nsys.stdout.flush()\ntime.sleep(30)\n")
    monkeypatch.setattr(main, "WORKER_SCRIPT", script)
    monkeypatch.setattr(main, "MAX_OUTPUT_BYTES", 1024)
    with pytest.raises(HTTPException) as result:
        await main._run_worker(contracts.RenderRequest(kind="image", prompt="a tree"))
    assert result.value.status_code == 413


@pytest.mark.asyncio
async def test_cancelled_subprocess_is_reaped(tmp_path, monkeypatch):
    script = tmp_path / "cancel_worker.py"
    script.write_text("import sys,time\nsys.stdin.buffer.read()\ntime.sleep(30)\n")
    monkeypatch.setattr(main, "WORKER_SCRIPT", script)
    task = asyncio.create_task(main._run_worker(contracts.RenderRequest(kind="image", prompt="a tree")))
    await asyncio.sleep(0.15)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 2)


@pytest.mark.asyncio
async def test_single_inflight_rejects_second_job(models, monkeypatch):
    class FakeRequest:
        async def stream(self):
            yield b'{"kind":"image","prompt":"a tree"}'
        async def receive(self):
            await asyncio.sleep(30)
            return {"type": "http.disconnect"}
    started = asyncio.Event(); finish = asyncio.Event()
    async def fake(_):
        started.set(); await finish.wait(); return png()
    monkeypatch.setattr(main, "_run_worker", fake)
    first = asyncio.create_task(main.render(FakeRequest()))
    await started.wait()
    with pytest.raises(HTTPException) as result:
        await main.render(FakeRequest())
    assert result.value.status_code == 429
    finish.set(); await first
    assert not main.inflight.locked()


@pytest.mark.asyncio
async def test_disconnect_cancels_job_and_releases_capacity(models, monkeypatch):
    cancelled = asyncio.Event()
    class FakeRequest:
        async def stream(self):
            yield b'{"kind":"image","prompt":"a tree"}'
        async def receive(self):
            return {"type": "http.disconnect"}
    async def fake(_):
        try: await asyncio.sleep(30)
        finally: cancelled.set()
    monkeypatch.setattr(main, "_run_worker", fake)
    with pytest.raises(HTTPException) as result:
        await main.render(FakeRequest())
    assert result.value.status_code == 499
    assert cancelled.is_set() and not main.inflight.locked()
