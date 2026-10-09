"""Bounded, URL-free local media requests shared by the controller and worker."""
from __future__ import annotations

import base64
import binascii
import io
import json
import secrets
from pathlib import Path
from typing import Literal

from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

MAX_INPUT_BYTES = 4 * 1024 * 1024
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_OUTPUT_BYTES = 20 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 16 * 1024 * 1024


class RenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: Literal["image", "video"]
    prompt: str = Field(min_length=1, max_length=4000)
    source_base64: str | None = Field(default=None, min_length=1, max_length=5_592_408)
    mask_base64: str | None = Field(default=None, min_length=1, max_length=5_592_408)
    width: StrictInt = Field(default=512, ge=256, le=1024)
    height: StrictInt = Field(default=512, ge=256, le=1024)
    steps: StrictInt = Field(default=30, ge=8, le=50)
    seed: StrictInt = Field(default_factory=lambda: secrets.randbelow(2**32), ge=0, le=2**32 - 1)
    frames: StrictInt = Field(default=25, ge=9, le=49)
    fps: StrictInt = Field(default=12, ge=8, le=24)

    @model_validator(mode="after")
    def validate_job(self):
        if not self.prompt.strip() or any(ord(c) < 32 and c not in "\n\t" for c in self.prompt):
            raise ValueError("invalid_prompt")
        divisor, minimum, maximum = (64, 512, 1024) if self.kind == "image" else (32, 256, 768)
        if any(d < minimum or d > maximum or d % divisor for d in (self.width, self.height)):
            raise ValueError("invalid_dimensions")
        if self.kind == "video" and (self.frames - 1) % 8:
            raise ValueError("frames_must_be_8n_plus_1")
        if self.mask_base64 is not None and (self.source_base64 is None or self.kind != "image"):
            raise ValueError("mask_requires_image_source")
        return self


def decode_image(value: str) -> Image.Image:
    try:
        raw = base64.b64decode(value, validate=True)
        if not raw or len(raw) > MAX_INPUT_BYTES:
            raise ValueError("invalid_image_size")
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"} or image.width * image.height > Image.MAX_IMAGE_PIXELS or getattr(image, "n_frames", 1) != 1:
                raise ValueError("invalid_image_format")
            image.verify()
        with Image.open(io.BytesIO(raw)) as image:
            return ImageOps.exif_transpose(image).convert("RGB").copy()
    except (binascii.Error, UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ValueError("invalid_image") from None


def prepare_images(job: RenderRequest) -> tuple[Image.Image | None, Image.Image | None]:
    source = decode_image(job.source_base64) if job.source_base64 else None
    mask = decode_image(job.mask_base64) if job.mask_base64 else None
    if mask and source and mask.size != source.size:
        raise ValueError("mask_dimensions_must_match_source")
    size = (job.width, job.height)
    # The contract explicitly resizes supplied images to the requested size.
    if source:
        source = source.resize(size, Image.Resampling.LANCZOS)
    if mask:
        mask = mask.convert("L").resize(size, Image.Resampling.NEAREST)
    return source, mask


def video_engine() -> Literal["wan", "ltx"]:
    import os
    engine = os.getenv("MEDIA_GEN_VIDEO_ENGINE", "wan")
    if engine not in {"wan", "ltx"}:
        raise ValueError("invalid_operator_video_engine")
    return engine


def model_path(root: Path, name: Literal["sdxl", "wan", "ltx"]) -> Path | None:
    """Only built-in pipeline configs from the fixed mounted model root."""
    try:
        root = root.resolve()
        path = (root / name).resolve()
        path.relative_to(root)
        index = path / "model_index.json"
        if not index.is_file() or index.stat().st_size > 64 * 1024:
            return None
        config = json.loads(index.read_text(encoding="utf-8"))
        expected = {"sdxl": "StableDiffusionXLPipeline", "wan": "WanPipeline", "ltx": "LTXPipeline"}[name]
        if config.get("_class_name") != expected:
            return None
        for key, value in config.items():
            if key.startswith("_"):
                continue
            if isinstance(value, list) and len(value) == 2 and value[0] not in (None, "diffusers", "transformers"):
                return None
        weighted = ("unet", "vae", "text_encoder", "text_encoder_2") if name == "sdxl" else ("transformer", "vae", "text_encoder")
        for component in weighted:
            folder = (path / component).resolve()
            folder.relative_to(path)
            if not folder.is_dir() or not any(folder.glob("*.safetensors")):
                return None
        for component in ("tokenizer", "scheduler") + (("tokenizer_2",) if name == "sdxl" else ()):
            folder = (path / component).resolve()
            folder.relative_to(path)
            if not folder.is_dir():
                return None
        return path
    except (OSError, ValueError, AttributeError):
        return None
