"""Offline Kokoro synthesis with an explicitly CPU-only ONNX session."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re


def create_cpu_session(model_path: Path, threads: int):
    import onnxruntime as ort

    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    session = ort.InferenceSession(
        str(model_path), sess_options=options, providers=["CPUExecutionProvider"],
    )
    if session.get_providers() != ["CPUExecutionProvider"]:
        raise RuntimeError("Kokoro requires CPUExecutionProvider exclusively")
    return session


def split_text(text: str):
    """Bound each synthesis batch so audio starts before a whole long reply finishes."""
    for sentence in re.split(r"(?<=[.!?;:])\s+|\n+", text):
        remaining = sentence.strip()
        while remaining:
            end = min(300, len(remaining))
            if end < len(remaining):
                space = remaining.rfind(" ", 0, end)
                if space > 0:
                    end = space
            yield remaining[:end]
            remaining = remaining[end:].lstrip()


class KokoroEngine:
    def __init__(self, model_dir: Path, catalog: list[dict], threads: int = 2):
        from kokoro_onnx import Kokoro

        for filename in ("model.onnx", "voices.npz"):
            if not (model_dir / filename).is_file():
                raise RuntimeError(f"Missing bundled Kokoro asset: {filename}; rebuild the image")
        self.session = create_cpu_session(model_dir / "model.onnx", threads)
        self.model = Kokoro.from_session(self.session, str(model_dir / "voices.npz"))
        self.languages = {voice["name"]: voice["language"].lower() for voice in catalog}
        if set(self.model.get_voices()) != set(self.languages):
            raise RuntimeError("Bundled voices do not match the advertised catalog")
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kokoro-cpu")

    def _create_pcm(self, text: str, voice: str) -> bytes:
        import numpy as np

        samples, rate = self.model.create(text, voice, lang=self.languages[voice])
        if rate != 24000:
            raise RuntimeError("Unexpected Kokoro sample rate")
        samples = np.asarray(samples).ravel()
        if not len(samples) or not np.isfinite(samples).all() or len(samples) > 24000 * 120:
            raise RuntimeError("Invalid or oversized Kokoro audio batch")
        return (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()

    async def stream(self, text: str, voice: str):
        loop = asyncio.get_running_loop()
        for part in split_text(text):
            future = loop.run_in_executor(self.executor, self._create_pcm, part, voice)
            try:
                pcm = await asyncio.shield(future)
            except asyncio.CancelledError:
                # A worker cannot be cancelled. Keep the inference slot until it finishes.
                await future
                raise
            yield pcm

    def close(self) -> None:
        self.executor.shutdown(wait=True, cancel_futures=True)
