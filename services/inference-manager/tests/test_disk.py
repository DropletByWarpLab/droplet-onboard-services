"""Tests for the disk-space preflight (WARP-1111 §7.2 / closes WARP-196)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest


def _usage(total_gb: float, free_gb: float) -> SimpleNamespace:
    gb = 1024**3
    return SimpleNamespace(
        total=int(total_gb * gb),
        used=int((total_gb - free_gb) * gb),
        free=int(free_gb * gb),
    )


def test_rejects_when_insufficient_space(monkeypatch):
    import disk
    monkeypatch.setattr(disk.shutil, "disk_usage", lambda path: _usage(100, 5))

    result = disk.check_disk_space(disk_gb=10, path="/whatever")

    assert result is not None
    assert result.ok is False
    assert result.needed_gb == pytest.approx(20.0)  # 10 model + 10 headroom
    assert result.free_gb == pytest.approx(5.0)


def test_allows_when_sufficient_space(monkeypatch):
    import disk
    monkeypatch.setattr(disk.shutil, "disk_usage", lambda path: _usage(200, 50))

    result = disk.check_disk_space(disk_gb=10, path="/whatever")

    assert result is not None
    assert result.ok is True
    assert result.needed_gb == pytest.approx(20.0)
    assert result.free_gb == pytest.approx(50.0)


def test_boundary_exactly_at_headroom_passes(monkeypatch):
    """free == needed (model + headroom exactly) is allowed, not rejected."""
    import disk
    monkeypatch.setattr(disk.shutil, "disk_usage", lambda path: _usage(100, 20))

    result = disk.check_disk_space(disk_gb=10, path="/whatever")
    assert result.ok is True


def test_skips_when_disk_gb_unknown(monkeypatch):
    """No manifest entry / no disk_gb — skip rather than block, and never
    even touch the filesystem."""
    import disk
    called = False

    def _fake(path):
        nonlocal called
        called = True
        return _usage(200, 200)

    monkeypatch.setattr(disk.shutil, "disk_usage", _fake)

    result = disk.check_disk_space(disk_gb=None, path="/whatever")

    assert result is None
    assert called is False


def test_skips_when_path_unavailable(monkeypatch):
    """Mount not visible (e.g. local dev without the volume) — fail open
    with a logged warning rather than blocking every pull."""
    import disk

    def _raise(path):
        raise OSError("no such mount")

    monkeypatch.setattr(disk.shutil, "disk_usage", _raise)

    result = disk.check_disk_space(disk_gb=10, path="/nope")

    assert result is None


def test_skips_logs_structured_event_when_disk_gb_unknown(monkeypatch):
    from structlog.testing import capture_logs

    import disk

    with capture_logs() as logs:
        result = disk.check_disk_space(disk_gb=None)

    assert result is None
    events = [e for e in logs if e.get("event") == "disk_preflight_skipped_unknown_size"]
    assert len(events) == 1


def test_skips_logs_structured_event_when_path_unavailable(monkeypatch):
    from structlog.testing import capture_logs

    import disk

    def _raise(path):
        raise OSError("no such mount")

    monkeypatch.setattr(disk.shutil, "disk_usage", _raise)

    with capture_logs() as logs:
        result = disk.check_disk_space(disk_gb=10, path="/nope")

    assert result is None
    events = [e for e in logs if e.get("event") == "disk_preflight_unavailable"]
    assert len(events) == 1
    assert events[0]["path"] == "/nope"


def test_uses_env_override_path(monkeypatch):
    import disk
    monkeypatch.setenv("OLLAMA_DATA_PATH", "/custom/ollama-data")
    seen: dict[str, str] = {}

    def _fake(path):
        seen["path"] = path
        return _usage(200, 200)

    monkeypatch.setattr(disk.shutil, "disk_usage", _fake)

    disk.check_disk_space(disk_gb=1)

    assert seen["path"] == "/custom/ollama-data"


def test_default_path_when_no_env(monkeypatch):
    import disk
    monkeypatch.delenv("OLLAMA_DATA_PATH", raising=False)

    assert disk.disk_check_path() == disk.DEFAULT_DISK_CHECK_PATH
