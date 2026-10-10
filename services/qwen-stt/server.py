"""Offline, CPU-only Qwen3-ASR Wyoming server. No audio or text is persisted."""
from __future__ import annotations

import array
import audioop
import asyncio
import ctypes
import json
import logging
import os
from pathlib import Path
import sys
import threading
from typing import Protocol

LOG = logging.getLogger("qwen-stt")
MAX_CONNECTIONS = 8
# One native decode at a time; a second request WAITS this long for the
# slot before it is answered `busy`. Appliance voice and dashboard dictation
# share this model, and a turn that arrives a few seconds behind a dictation
# must queue behind it, not fail - refusing outright used to end the voice
# turn with an error. Bounded so the client's own transcript deadline
# (90 s by default) and the 125 s request deadline below still win.
QUEUE_WAIT_S = 60.0


def check_headroom() -> None:
    """Reserve RAM for the rest of the appliance before loading the full model."""
    minimum = float(os.environ.get("QWEN_MIN_AVAILABLE_GIB", "14"))
    if not 0 <= minimum <= 1024:
        raise ValueError("QWEN_MIN_AVAILABLE_GIB must be between 0 and 1024")
    available = next(int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemAvailable:"))
    if available < minimum * 1024**3:
        raise RuntimeError(f"Qwen requires {minimum:g} GiB available RAM before startup; free RAM or use the Whisper rollback profile")
    for name in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        path = Path(name)
        if path.is_file():
            limit = path.read_text().strip()
            if limit != "max" and int(limit) < 10 * 1024**3:
                raise RuntimeError("Full Qwen speech recognition requires a container RAM limit of at least 10 GiB")


class RequestError(ValueError):
    pass


class BusyError(RequestError):
    pass


class Transcriber(Protocol):
    def transcribe(self, pcm: bytes) -> str: ...


class Qwen:
    """One resident full model, one native inference at a time."""

    def __init__(self, model_dir: str, library: str = "/app/libqwen_asr.so"):
        self._lock = threading.Lock()
        self.lib = ctypes.CDLL(library)
        self.lib.qwen_load.argtypes = [ctypes.c_char_p]
        self.lib.qwen_load.restype = ctypes.c_void_p
        self.lib.qwen_set_force_language.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        self.lib.qwen_set_force_language.restype = ctypes.c_int
        self.lib.qwen_transcribe_audio.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_int]
        self.lib.qwen_transcribe_audio.restype = ctypes.c_void_p
        self.lib.qwen_free.argtypes = [ctypes.c_void_p]
        self.lib.qwen_free.restype = None
        self.lib.qwen_set_threads.argtypes = [ctypes.c_int]
        self.lib.qwen_set_threads.restype = None
        threads = int(os.environ.get("QWEN_CPU_THREADS", "4"))
        if not 1 <= threads <= 16:
            raise ValueError("QWEN_CPU_THREADS must be between 1 and 16")
        self.lib.qwen_set_threads(threads)
        self._libc = ctypes.CDLL(None)
        self._libc.free.argtypes = [ctypes.c_void_p]
        self._libc.free.restype = None
        self.ctx = self.lib.qwen_load(os.fsencode(model_dir))
        if not self.ctx:
            raise RuntimeError("Qwen model could not be loaded")
        if self.lib.qwen_set_force_language(self.ctx, b"English") != 0:
            self.lib.qwen_free(self.ctx)
            raise RuntimeError("English language initialization failed")

    def transcribe(self, pcm: bytes) -> str:
        if not self._lock.acquire(blocking=False):
            raise BusyError("Speech recognition is busy; try again")
        try:
            samples = array.array("h", pcm)
            if sys.byteorder != "little":
                samples.byteswap()
            floats = (ctypes.c_float * len(samples))(*(sample / 32768.0 for sample in samples))
            result = self.lib.qwen_transcribe_audio(self.ctx, floats, len(samples))
            if not result:
                raise RuntimeError("Transcription failed")
            try:
                return ctypes.string_at(result).decode("utf-8").strip()
            finally:
                self._libc.free(result)
        finally:
            self._lock.release()


async def read_event(reader: asyncio.StreamReader) -> tuple[str, dict, bytes]:
    """Both Wyoming inline-data and data_length framing, with bounded reads."""
    try:
        line = await asyncio.wait_for(reader.readline(), 35)
        if not line or len(line) > 8192:
            raise RequestError("Invalid event header")
        header = json.loads(line)
        if not isinstance(header, dict) or not isinstance(header.get("type"), str):
            raise RequestError("Invalid event header")
        data = header.get("data", {})
        if data is None:
            data = {}
        if not isinstance(data, dict):
            raise RequestError("Invalid event data")
        for field, maximum in (("data_length", 4096), ("payload_length", 65536)):
            value = header.get(field, 0)
            if type(value) is not int or not 0 <= value <= maximum:
                raise RequestError("Event is too large")
        if header.get("data_length", 0):
            extra = json.loads(await asyncio.wait_for(reader.readexactly(header["data_length"]), 35))
            if not isinstance(extra, dict):
                raise RequestError("Invalid event data")
            data.update(extra)
        if not isinstance(data, dict):
            raise RequestError("Invalid event data")
        payload = await asyncio.wait_for(reader.readexactly(header.get("payload_length", 0)), 35)
        return header["type"], data, payload
    except (json.JSONDecodeError, asyncio.LimitOverrunError, ValueError) as exc:
        raise RequestError("Invalid event") from exc


async def send_event(writer: asyncio.StreamWriter, event: str, data: dict) -> None:
    writer.write(json.dumps({"type": event, "data": data, "payload_length": 0}).encode() + b"\n")
    await asyncio.wait_for(writer.drain(), 5)


def info() -> dict:
    return {"asr": [{"name": "qwen3-asr", "description": "Qwen3-ASR 1.7B (CPU)",
                     "attribution": {"name": "Qwen", "url": "https://huggingface.co/Qwen/Qwen3-ASR-1.7B"},
                     "installed": True, "version": "1.7B",
                     "models": [{"name": "qwen3-asr-1.7b", "description": "English",
                                 "attribution": {"name": "Qwen", "url": "https://huggingface.co/Qwen/Qwen3-ASR-1.7B"},
                                 "version": "1.7B",
                                 "installed": True, "languages": ["en"]}]}]}


class Server:
    def __init__(self, engine: Transcriber):
        self.engine = engine
        self.connections = 0
        # Serialises the native decode across connections, in arrival order.
        self._inference = asyncio.Lock()

    async def transcribe(self, pcm: bytes) -> str:
        """Run one decode on the worker thread, queued behind any decode in
        flight (bounded by QUEUE_WAIT_S). A cancelled waiter gives its place
        up at once; a cancelled decode keeps the slot until the native call
        returns - a worker thread cannot be interrupted, and the engine's
        own non-blocking lock would otherwise answer the next caller busy."""
        try:
            await asyncio.wait_for(self._inference.acquire(), QUEUE_WAIT_S)
        except asyncio.TimeoutError:
            raise BusyError("Speech recognition is busy; try again") from None
        try:
            future = asyncio.ensure_future(asyncio.to_thread(self.engine.transcribe, pcm))
            try:
                return await asyncio.shield(future)
            except asyncio.CancelledError:
                await future
                raise
        finally:
            self._inference.release()

    @property
    def busy(self) -> bool:
        return self._inference.locked()

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self.connections >= MAX_CONNECTIONS:
            await send_event(writer, "error", {"code": "busy", "text": "Speech recognition is busy"})
            writer.close()
            return
        self.connections += 1
        try:
            # A hard request deadline defeats clients that drip one byte/event forever.
            await asyncio.wait_for(self.request(reader, writer), 125)
        except BusyError:
            await send_event(writer, "error", {"code": "busy", "text": "Speech recognition is busy; try again"})
        except (RequestError, asyncio.TimeoutError, asyncio.IncompleteReadError):
            try:
                await send_event(writer, "error", {"code": "invalid-request", "text": "Invalid or incomplete speech request (8–48 kHz mono PCM, at most 30 seconds)"})
            except (ConnectionError, asyncio.TimeoutError):
                pass
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception:
            LOG.exception("Speech request failed")
            try:
                await send_event(writer, "error", {"code": "transcription-failed", "text": "Speech recognition failed"})
            except (ConnectionError, asyncio.TimeoutError):
                pass
        finally:
            self.connections -= 1
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass

    async def request(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        event, data, payload = await read_event(reader)
        if payload:
            raise RequestError("Unexpected payload")
        if event == "describe":
            await send_event(writer, "info", info())
            return
        if event != "transcribe" or data.get("language", "en") not in (None, "", "en", "English"):
            raise RequestError("Only English transcription is configured")
        event, data, payload = await read_event(reader)
        rate = data.get("rate")
        if event != "audio-start" or payload or type(rate) is not int or not 8000 <= rate <= 48000 or (data.get("width"), data.get("channels")) != (2, 1):
            raise RequestError("Expected 8–48 kHz mono signed 16-bit PCM")
        pcm = bytearray()
        for _ in range(4096):
            event, data, payload = await read_event(reader)
            if event == "audio-stop":
                if payload or not pcm:
                    raise RequestError("Empty audio")
                # Bluetooth microphones may capture at 8 kHz. No GPU or model
                # runtime is involved in this deterministic PCM conversion.
                normalized = bytes(pcm) if rate == 16000 else audioop.ratecv(bytes(pcm), 2, 1, rate, 16000, None)[0]
                text = await self.transcribe(normalized)
                await send_event(writer, "transcript", {"text": text, "language": "en"})
                return
            if event != "audio-chunk" or not payload or len(payload) % 2:
                raise RequestError("Invalid audio chunk")
            if any(data.get(key, expected) != expected for key, expected in (("rate", rate), ("width", 2), ("channels", 1))):
                raise RequestError("Audio format changed")
            if len(pcm) + len(payload) > rate * 2 * 30:
                raise RequestError("Audio exceeds 30 seconds")
            pcm.extend(payload)
        raise RequestError("Too many events")


async def main() -> None:
    check_headroom()
    engine = Qwen(os.environ.get("QWEN_MODEL_DIR", "/models/qwen3-asr-1.7b"))
    server = await asyncio.start_server(Server(engine).handle, "0.0.0.0", 10300, limit=8192)
    LOG.info("English CPU speech recognition ready on port 10300")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
