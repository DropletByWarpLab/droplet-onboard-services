"""WARP-3193 PERF-15 — auto_fix_drivers must not block the event loop.

`check_kernel_module` shells out to `lsmod`/`modinfo` via blocking
`subprocess.run` (up to 5 s each). `auto_fix_drivers` is a coroutine and used
to call it directly, stalling every other request on the service's loop for
the whole scan. The check now runs in a worker thread.
"""

from __future__ import annotations

import threading

import pytest

import driver_checker


@pytest.mark.asyncio
async def test_kernel_module_checks_run_off_the_event_loop(monkeypatch):
    loop_thread = threading.get_ident()
    seen: list[int] = []

    def fake_run(cmd, timeout=5.0):
        seen.append(threading.get_ident())
        return 1, ""  # nothing loaded, nothing available

    monkeypatch.setattr(driver_checker, "_run", fake_run)
    monkeypatch.setattr(driver_checker, "Path", lambda _p: type("P", (), {"glob": lambda self, _g: []})())

    report = await driver_checker.auto_fix_drivers()

    assert seen, "expected the module checks to shell out"
    assert loop_thread not in seen
    assert all(a["result"].startswith("skipped") for a in report["actions"])
