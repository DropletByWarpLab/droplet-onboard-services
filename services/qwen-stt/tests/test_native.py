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
    memory_files(monkeypatch, 13, 10)
    with pytest.raises(RuntimeError, match="available RAM"):
        check_headroom()


def test_small_container_limit_is_refused_even_on_a_large_host(monkeypatch):
    memory_files(monkeypatch, 32, 8)
    with pytest.raises(RuntimeError, match="at least 10 GiB"):
        check_headroom()


def test_supported_memory_budget_passes(monkeypatch):
    memory_files(monkeypatch, 16, 10)
    check_headroom()


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
