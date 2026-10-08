"""One disposable local diffusion job. stdout is media bytes only.

No Hugging Face credentials, remote code, network downloads or user-selected
pipeline/module/path. Container networking enforces the offline boundary.
"""
from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# `python -I` isolates environment Python paths; only our checked-in module is added.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from contracts import MAX_OUTPUT_BYTES, MAX_REQUEST_BYTES, RenderRequest, model_path, prepare_images, video_engine

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
for credential in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACEHUB_API_TOKEN"):
    os.environ.pop(credential, None)


def render(job: RenderRequest) -> bytes:
    # Imports are lazy: the API can explain missing weights without loading a model.
    import torch
    from diffusers import StableDiffusionXLPipeline, StableDiffusionXLImg2ImgPipeline, StableDiffusionXLInpaintPipeline, LTXPipeline, LTXImageToVideoPipeline, WanPipeline, AutoencoderKLWan

    root = Path(os.getenv("MEDIA_GEN_MODEL_ROOT", "/models"))
    engine = "sdxl" if job.kind == "image" else video_engine()
    if engine == "wan" and job.source_base64:
        raise ValueError("video_source_requires_ltx_engine")
    path = model_path(root, engine)
    if path is None:
        raise FileNotFoundError("model_not_provisioned")
    device = os.getenv("MEDIA_GEN_DEVICE", "cuda")
    if device not in {"cuda", "cpu"} or (device == "cuda" and not torch.cuda.is_available()):
        raise RuntimeError("accelerator_unavailable")
    dtype = torch.float32 if device == "cpu" else (torch.bfloat16 if job.kind == "video" else torch.float16)
    generator = torch.Generator(device=device).manual_seed(job.seed)
    source, mask = prepare_images(job)
    cls = {"sdxl": StableDiffusionXLPipeline, "ltx": LTXPipeline, "wan": WanPipeline}[engine]
    kwargs = {"local_files_only": True, "use_safetensors": True, "token": False, "dtype": dtype, "trust_remote_code": False}
    if engine == "wan":
        # The official Wan integration recommends float32 for VAE decoding.
        kwargs["vae"] = AutoencoderKLWan.from_pretrained(str(path), subfolder="vae", local_files_only=True, use_safetensors=True, token=False, dtype=torch.float32, trust_remote_code=False)
    pipeline = cls.from_pretrained(str(path), **kwargs)
    if source:
        edit_cls = StableDiffusionXLInpaintPipeline if mask else StableDiffusionXLImg2ImgPipeline
        if job.kind == "video":
            edit_cls = LTXImageToVideoPipeline
        pipeline = edit_cls.from_pipe(pipeline)
    # Bound accelerator residency with the existing Accelerate offload path.
    # Actual VRAM/driver support remains a device acceptance check.
    if device == "cuda":
        pipeline.enable_model_cpu_offload(device=device)
    else:
        pipeline.to(device)
    pipeline.set_progress_bar_config(disable=True)
    if hasattr(pipeline, "enable_attention_slicing"):
        pipeline.enable_attention_slicing()
    params = {"prompt": job.prompt, "width": job.width, "height": job.height, "num_inference_steps": job.steps, "generator": generator}
    if source:
        params["image"] = source
        if job.kind == "image":
            params["strength"] = 0.75
    if mask:
        params["mask_image"] = mask
    with torch.inference_mode():
        if job.kind == "image":
            image = pipeline(**params).images[0]
            # Inpainting must preserve unmasked pixels after diffusion as well.
            if source and mask:
                from PIL import Image
                image = Image.composite(image.convert("RGB"), source, mask)
            output = io.BytesIO()
            image.save(output, format="PNG")
            return output.getvalue()
        params["num_frames"] = job.frames
        params["output_type"] = "pil"
        frames = pipeline(**params).frames[0]
    if len(frames) != job.frames:
        raise RuntimeError("invalid_generated_frames")
    with tempfile.TemporaryDirectory(prefix="droplet-media-") as tmp:
        target = Path(tmp) / "video.mp4"
        # System FFmpeg, fixed argv, no shell, no supplied input filenames/URLs.
        encoder = subprocess.Popen(["/usr/bin/ffmpeg", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{job.width}x{job.height}", "-r", str(job.fps), "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", str(target)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            assert encoder.stdin is not None
            for frame in frames:
                if frame.size != (job.width, job.height):
                    raise RuntimeError("invalid_generated_dimensions")
                encoder.stdin.write(frame.convert("RGB").tobytes())
            encoder.stdin.close()
            if encoder.wait(timeout=30) != 0 or not target.exists() or target.stat().st_size > MAX_OUTPUT_BYTES:
                raise RuntimeError("video_encoding_failed")
            return target.read_bytes()
        finally:
            if encoder.poll() is None:
                encoder.kill()
                encoder.wait()


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            return 4
        job = RenderRequest.model_validate_json(raw)
        # Prevent library progress output from corrupting the binary response.
        with contextlib.redirect_stdout(sys.stderr):
            data = render(job)
        if len(data) > MAX_OUTPUT_BYTES:
            return 6
        sys.stdout.buffer.write(data)
        return 0
    except FileNotFoundError:
        return 3
    except ValueError:
        return 4
    except Exception:
        # No prompt, path, weights configuration or credentials in diagnostics.
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
