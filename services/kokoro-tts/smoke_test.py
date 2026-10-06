"""Real CPU/model smoke test, runnable with --network none after image build."""
import asyncio
import json
import os
from pathlib import Path
import resource
import time

from runtime import KokoroEngine
from server import CATALOG, MAX_EVENT_BYTES, WyomingServer, write_event


async def read_response(reader):
    header = json.loads(await asyncio.wait_for(reader.readline(), 60))
    payload = await reader.readexactly(header.get("payload_length", 0))
    return header, payload


async def smoke():
    started = time.monotonic()
    engine = KokoroEngine(Path(os.getenv("KOKORO_MODEL_DIR", "/app/models")), CATALOG)
    service = WyomingServer(engine)
    listener = await asyncio.start_server(service.handle, "127.0.0.1", 0, limit=MAX_EVENT_BYTES)
    reader, writer = await asyncio.open_connection("127.0.0.1", listener.sockets[0].getsockname()[1])
    try:
        await write_event(writer, "describe")
        event, _ = await read_response(reader)
        assert event["type"] == "info" and len(event["data"]["tts"][0]["voices"]) == 8
        for voice in ("af_heart", "am_michael", "bf_emma"):
            await write_event(writer, "synthesize", {"text": "Hello from Droplet.", "voice": {"name": voice}})
            event, _ = await read_response(reader)
            assert event["type"] == "audio-start" and event["data"]["rate"] == 24000
            pcm_bytes = 0
            while True:
                event, payload = await read_response(reader)
                if event["type"] == "audio-stop":
                    break
                assert event["type"] == "audio-chunk", event
                pcm_bytes += len(payload)
            assert pcm_bytes > 24000, f"No meaningful audio for {voice}"
        assert engine.session.get_providers() == ["CPUExecutionProvider"]
        print(
            "Offline CPU/TCP smoke passed: American female/male and British female audio; "
            f"{time.monotonic() - started:.1f}s; peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.0f} MiB"
        )
    finally:
        writer.close()
        await writer.wait_closed()
        listener.close()
        await listener.wait_closed()
        engine.close()


if __name__ == "__main__":
    asyncio.run(smoke())
