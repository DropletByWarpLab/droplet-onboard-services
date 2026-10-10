import asyncio
import ctypes
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

from server import BusyError, Qwen, check_headroom


def memory_files(monkeypatch, available_gib, limit_gib):
    files = {
        "/proc/meminfo": f"MemAvailable: {available_gib * 1024**2} kB\n",
        "/sys/fs/cgroup/memory.max": str(limit_gib * 1024**3),
    }
    monkeypatch.setattr(Path, "read_text", lambda path: files[path.as_posix()])
    monkeypatch.setattr(Path, "is_file", lambda path: path.as_posix() in files)
    monkeypatch.delenv("QWEN_MIN_AVAILABLE_GIB", raising=False)


def test_model_is_refused_when_appliance_headroom_is_insufficient(monkeypatch):
    memory_files(monkeypatch, 7, 4)
    with pytest.raises(RuntimeError, match="available RAM"):
        check_headroom()


def test_small_container_limit_is_refused_even_on_a_large_host(monkeypatch):
    # WARP-3729: 3 GiB is where the measured 0.6B footprint ran at the limit.
    memory_files(monkeypatch, 32, 3)
    with pytest.raises(RuntimeError, match="at least 4 GiB"):
        check_headroom()


def test_supported_memory_budget_passes(monkeypatch):
    # Exactly the documented defaults: 8 GiB available, 4 GiB cap.
    memory_files(monkeypatch, 8, 4)
    check_headroom()


async def test_startup_warms_the_decoder_before_the_port_opens(monkeypatch):
    # WARP-3729: ready must mean resident weights, so one second of silence
    # goes through the real decode path after load and before listening.
    import server as server_mod

    order = []

    class Engine:
        def __init__(self, model_dir):
            order.append(("load", model_dir))

        def transcribe(self, pcm):
            order.append(("decode", pcm))
            return ""

    class Listener:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def serve_forever(self):
            order.append("serve")

    async def start_server(*args, **kwargs):
        order.append("listen")
        return Listener()

    monkeypatch.setattr(server_mod, "check_headroom", lambda: order.append("headroom"))
    monkeypatch.setattr(server_mod, "Qwen", Engine)
    monkeypatch.setattr(server_mod.asyncio, "start_server", start_server)
    monkeypatch.delenv("QWEN_MODEL_DIR", raising=False)
    await server_mod.main()
    assert order == ["headroom", ("load", "/models/qwen3-asr-0.6b"), ("decode", bytes(16000 * 2)), "listen", "serve"]


async def test_cancelled_client_keeps_native_inference_exclusive():
    engine = object.__new__(Qwen)
    engine._lock = threading.Lock()
    engine.ctx = 1
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    result = ctypes.create_string_buffer(b"hello")

    def native(*args):
        started.set()
        assert release.wait(3)
        return ctypes.addressof(result)

    engine.lib = SimpleNamespace(qwen_transcribe_audio=native)
    engine._libc = SimpleNamespace(free=lambda address: finished.set())
    task = asyncio.create_task(asyncio.to_thread(engine.transcribe, b"\x01\x00"))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        with pytest.raises(BusyError):
            engine.transcribe(b"\x01\x00")
    finally:
        release.set()
        assert await asyncio.to_thread(finished.wait, 3)
    assert engine.transcribe(b"\x01\x00") == "hello"
