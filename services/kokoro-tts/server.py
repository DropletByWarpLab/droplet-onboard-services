"""Bounded Wyoming TCP TTS service. No HTTP or runtime asset downloads."""
from __future__ import annotations

import asyncio
from contextlib import suppress
import json
import logging
import os
from pathlib import Path

from runtime import KokoroEngine

LOGGER = logging.getLogger("kokoro-tts")
MAX_EVENT_BYTES = 16384
MAX_TEXT_CHARS = 2000
MAX_CONNECTIONS = 16
IO_TIMEOUT = 10
# One synthesis at a time; a second request WAITS this long for the slot
# before it is answered `busy`. A cue pre-synthesis racing a reply, or a
# dashboard preview landing mid-sentence, then queues behind the batch in
# flight instead of failing the caller's turn. Bounded so a client's own
# synthesis deadline (60 s by default) still wins.
SYNTH_QUEUE_WAIT_S = 30.0
PCM_CHUNK_BYTES = 24000 * 2 // 5  # 200 ms of mono int16 PCM
CATALOG = json.loads(Path(__file__).with_name("voices.json").read_text())
VOICE_NAMES = {voice["name"] for voice in CATALOG}
ATTRIBUTION = {"name": "hexgrad", "url": "https://huggingface.co/hexgrad/Kokoro-82M"}


class RequestError(Exception):
    def __init__(self, code: str, text: str):
        super().__init__(text)
        self.code = code


async def read_event(reader: asyncio.StreamReader):
    try:
        line = await asyncio.wait_for(reader.readline(), IO_TIMEOUT)
        if not line:
            return None
        header = json.loads(line)
        if not isinstance(header, dict) or not isinstance(header.get("type"), str):
            raise ValueError("event type required")
        length = header.get("data_length", 0)
        payload_length = header.get("payload_length", 0)
        if type(length) is not int or not 0 <= length <= MAX_EVENT_BYTES:
            raise ValueError("invalid data_length")
        if type(payload_length) is not int or payload_length != 0:
            raise ValueError("TTS requests cannot carry binary payloads")
        data = header.get("data")
        if data is None:
            data = {}
        if not isinstance(data, dict):
            raise ValueError("data must be an object")
        if length:
            extra = json.loads(await asyncio.wait_for(reader.readexactly(length), IO_TIMEOUT))
            if not isinstance(extra, dict):
                raise ValueError("data must be an object")
            data.update(extra)
        return header["type"], data
    except (ValueError, UnicodeDecodeError, asyncio.IncompleteReadError) as error:
        raise RequestError("invalid-request", "Malformed or oversized Wyoming event") from error


async def write_event(writer: asyncio.StreamWriter, event_type: str, data=None, payload: bytes = b""):
    header = {"type": event_type, "data": data, "payload_length": len(payload)}
    writer.write(json.dumps(header, ensure_ascii=False).encode() + b"\n" + payload)
    await asyncio.wait_for(writer.drain(), IO_TIMEOUT)


def info(default_voice: str) -> dict:
    voices = [
        {
            "name": voice["name"], "description": voice["description"],
            "languages": [voice["language"]], "installed": True,
            "attribution": ATTRIBUTION, "version": "1.0",
        }
        for voice in CATALOG
    ]
    return {"tts": [{
        "name": "kokoro", "description": "Kokoro 82M (CPU)",
        "attribution": ATTRIBUTION, "version": "1.0", "installed": True,
        "voices": voices, "supports_synthesize_streaming": False,
        "default_voice": default_voice,
    }]}


class WyomingServer:
    def __init__(self, engine, default_voice: str = "af_heart"):
        if default_voice not in VOICE_NAMES:
            raise ValueError("TTS_VOICE must be a bundled Kokoro voice")
        self.engine = engine
        self.default_voice = default_voice
        self.connections = 0
        # Serialises synthesis across connections, in arrival order.
        self._synth_slot = asyncio.Lock()

    @property
    def synthesizing(self) -> bool:
        return self._synth_slot.locked()

    async def synthesize(self, data: dict, writer: asyncio.StreamWriter):
        text = data.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
            raise RequestError("invalid-text", f"text must contain 1–{MAX_TEXT_CHARS} characters")
        selected = data.get("voice")
        if selected is not None and not isinstance(selected, dict):
            raise RequestError("invalid-voice", "voice must be an object containing name")
        voice = (selected or {}).get("name") or self.default_voice
        if not isinstance(voice, str) or voice not in VOICE_NAMES:
            raise RequestError("invalid-voice", "Unknown Kokoro voice")
        try:
            await asyncio.wait_for(self._synth_slot.acquire(), SYNTH_QUEUE_WAIT_S)
        except asyncio.TimeoutError:
            raise RequestError("busy", "Kokoro is already synthesizing; retry later") from None
        try:
            started = False
            async for pcm in self.engine.stream(text.strip(), voice):
                if not started:
                    await write_event(writer, "audio-start", {"rate": 24000, "width": 2, "channels": 1})
                    started = True
                for offset in range(0, len(pcm), PCM_CHUNK_BYTES):
                    await write_event(writer, "audio-chunk", {"rate": 24000, "width": 2, "channels": 1}, pcm[offset:offset + PCM_CHUNK_BYTES])
            if not started:
                raise RequestError("synthesis-failed", "Kokoro produced no audio")
            await write_event(writer, "audio-stop")
        finally:
            self._synth_slot.release()

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        if self.connections >= MAX_CONNECTIONS:
            with suppress(OSError, asyncio.TimeoutError):
                await write_event(writer, "error", {"code": "busy", "text": "Too many TTS connections"})
            writer.close()
            return
        self.connections += 1
        try:
            # Event-driven reads, with a per-read deadline; no background polling.
            while event := await read_event(reader):
                event_type, data = event
                if event_type == "describe":
                    await write_event(writer, "info", info(self.default_voice))
                elif event_type == "synthesize":
                    await self.synthesize(data, writer)
                elif event_type == "select-program" and data.get("name") == "kokoro":
                    continue
                else:
                    raise RequestError("unsupported-event", "Expected describe or synthesize")
        except RequestError as error:
            with suppress(OSError, asyncio.TimeoutError):
                await write_event(writer, "error", {"code": error.code, "text": str(error)})
        except (OSError, asyncio.TimeoutError):
            pass
        except Exception as error:
            # Do not log spoken text or echo internal details to clients.
            LOGGER.error("Kokoro synthesis failed (%s)", type(error).__name__)
            with suppress(OSError, asyncio.TimeoutError):
                await write_event(writer, "error", {"code": "synthesis-failed", "text": "Kokoro synthesis failed"})
        finally:
            self.connections -= 1
            # Closing after error also releases older Wyoming clients waiting for audio-stop.
            writer.close()
            with suppress(OSError):
                await writer.wait_closed()


async def run() -> None:
    threads = int(os.getenv("KOKORO_CPU_THREADS", "2"))
    if not 1 <= threads <= 16:
        raise ValueError("KOKORO_CPU_THREADS must be between 1 and 16")
    engine = KokoroEngine(Path(os.getenv("KOKORO_MODEL_DIR", "/app/models")), CATALOG, threads)
    service = WyomingServer(engine, os.getenv("TTS_VOICE", "af_heart"))
    try:
        server = await asyncio.start_server(service.handle, "0.0.0.0", 10200, limit=MAX_EVENT_BYTES)
        LOGGER.info("Kokoro ready on :10200; CPUExecutionProvider only; %d voices", len(CATALOG))
        async with server:
            await server.serve_forever()
    finally:
        engine.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run())
