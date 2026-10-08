"""Internal-only local media generation controller with disposable workers."""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import os
import signal
import sys
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from pydantic import ValidationError

from contracts import MAX_OUTPUT_BYTES, MAX_REQUEST_BYTES, RenderRequest, model_path, prepare_images, video_engine

MEDIA_GEN_SERVICE_TOKEN = os.getenv("MEDIA_GEN_SERVICE_TOKEN", "").strip()
MODEL_ROOT = Path(os.getenv("MEDIA_GEN_MODEL_ROOT", "/models"))
WORKER_SCRIPT = Path(__file__).with_name("worker.py")
IMAGE_TIMEOUT = 120
VIDEO_TIMEOUT = 300
inflight = asyncio.Lock()


def require_bearer(request: Request) -> None:
    if request.url.path == "/health":
        return
    if not MEDIA_GEN_SERVICE_TOKEN:
        raise HTTPException(status_code=503, detail="media_auth_not_configured")
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip(), MEDIA_GEN_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


app = FastAPI(title="Droplet Local Media Generation", version="1.0.0", dependencies=[Depends(require_bearer)])


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/capabilities")
async def capabilities():
    try:
        engine = video_engine()
    except ValueError:
        raise HTTPException(status_code=503, detail="invalid_operator_video_engine") from None
    return {"image": model_path(MODEL_ROOT, "sdxl") is not None, "video": model_path(MODEL_ROOT, engine) is not None, "engine": {"image": "sdxl", "video": engine}, "videoSourceImage": engine == "ltx", "offline": True, "inferenceVerified": False, "busy": inflight.locked(), "limits": {"inputBytes": 4 * 1024 * 1024, "outputBytes": MAX_OUTPUT_BYTES, "imageTimeoutSeconds": IMAGE_TIMEOUT, "videoTimeoutSeconds": VIDEO_TIMEOUT}}


async def _kill(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
    await process.wait()


async def _run_worker(job: RenderRequest) -> bytes:
    # Give inference only OS/accelerator knobs, never the API bearer, TLS key
    # paths, provider credentials or the appliance's inherited environment.
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "MEDIA_GEN_MODEL_ROOT", "MEDIA_GEN_DEVICE", "MEDIA_GEN_VIDEO_ENGINE"}
    worker_env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    worker_env.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HOME": str(Path(os.getenv("TEMP", "/tmp")) / "huggingface"), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"})
    process = await asyncio.create_subprocess_exec(sys.executable, "-I", str(WORKER_SCRIPT), env=worker_env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=os.name == "posix")
    async def input_job():
        assert process.stdin
        try:
            process.stdin.write(job.model_dump_json().encode())
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass  # Early worker failure is mapped from its exit code below.
        finally:
            process.stdin.close()
    async def output_media():
        assert process.stdout
        data = bytearray()
        while chunk := await process.stdout.read(65536):
            data.extend(chunk)
            if len(data) > MAX_OUTPUT_BYTES:
                raise HTTPException(status_code=413, detail="media_output_too_large")
        return bytes(data)
    async def drain_diagnostics():
        assert process.stderr
        while await process.stderr.read(8192):
            pass  # Drain without retaining or returning model/library text.
    tasks = [asyncio.create_task(input_job()), asyncio.create_task(output_media()), asyncio.create_task(drain_diagnostics()), asyncio.create_task(process.wait())]
    try:
        await asyncio.wait_for(asyncio.gather(*tasks), IMAGE_TIMEOUT if job.kind == "image" else VIDEO_TIMEOUT)
        code = process.returncode
        if code:
            mapping = {3: (503, "model_not_provisioned"), 4: (400, "invalid_media_input"), 6: (413, "media_output_too_large")}
            status, detail = mapping.get(code, (503, "media_generation_failed"))
            raise HTTPException(status_code=status, detail=detail)
        data = tasks[1].result()
        valid = data.startswith(b"\x89PNG\r\n\x1a\n") if job.kind == "image" else len(data) >= 12 and data[4:8] == b"ftyp"
        if not valid:
            raise HTTPException(status_code=503, detail="invalid_media_output")
        return data
    except TimeoutError:
        raise HTTPException(status_code=504, detail="media_generation_timeout") from None
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await _kill(process)
        await asyncio.gather(*tasks, return_exceptions=True)


async def _disconnect(request: Request):
    # Body is already consumed. Await ASGI disconnect directly; the polling
    # is_disconnected helper's cancel scope can swallow task cancellation.
    while True:
        message = await request.receive()
        if message["type"] == "http.disconnect":
            return


@app.post("/render")
async def render(request: Request):
    # Consume with an actual streamed cap before JSON/base64 allocations.
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="media_request_too_large")
    try:
        job = RenderRequest.model_validate(json.loads(raw))
        prepare_images(job)  # Validate byte format, pixels and mask alignment before a worker.
    except (ValueError, ValidationError):
        raise HTTPException(status_code=400, detail="invalid_media_input") from None
    try:
        engine = "sdxl" if job.kind == "image" else video_engine()
    except ValueError:
        raise HTTPException(status_code=503, detail="invalid_operator_video_engine") from None
    if engine == "wan" and job.source_base64:
        raise HTTPException(status_code=400, detail="video_source_requires_ltx_engine")
    if model_path(MODEL_ROOT, engine) is None:
        raise HTTPException(status_code=503, detail="model_not_provisioned")
    if inflight.locked():
        raise HTTPException(status_code=429, detail="media_busy")
    async with inflight:
        task = asyncio.create_task(_run_worker(job))
        disconnect = asyncio.create_task(_disconnect(request))
        try:
            done, _ = await asyncio.wait({task, disconnect}, return_when=asyncio.FIRST_COMPLETED)
            if task not in done:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                raise HTTPException(status_code=499, detail="media_cancelled")
            data = await task
            return Response(content=data, media_type="image/png" if job.kind == "image" else "video/mp4", headers={"X-Media-Seed": str(job.seed), "X-Media-Engine": engine, "Cache-Control": "no-store"})
        finally:
            disconnect.cancel()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, disconnect, return_exceptions=True)
