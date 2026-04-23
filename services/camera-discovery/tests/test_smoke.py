"""Smoke tests for services/camera-discovery.

Baseline coverage for the CI guard:
  - The module graph imports cleanly (catches syntax errors + missing deps).
  - Core FastAPI routes are registered.
  - SSRF/injection guards in `is_safe_ip` / `is_safe_rtsp_url` reject the
    well-known attack shapes (loopback, link-local, non-RTSP schemes).
"""

from __future__ import annotations

import importlib


def test_main_imports():
    main = importlib.import_module("main")
    assert hasattr(main, "app"), "main must expose a FastAPI `app`"


def test_core_routes_registered():
    main = importlib.import_module("main")
    paths = {getattr(r, "path", None) for r in main.app.routes}
    for expected in ("/health", "/cameras/discovered", "/scan", "/drivers"):
        assert expected in paths, f"route {expected} not registered"


def test_is_safe_ip_rejects_dangerous_addresses():
    main = importlib.import_module("main")
    # Loopback and link-local must never be probed.
    assert main.is_safe_ip("127.0.0.1") is False
    assert main.is_safe_ip("169.254.1.1") is False
    # Public IPs outside the allowed LAN ranges must also be rejected.
    assert main.is_safe_ip("8.8.8.8") is False
    # Garbage inputs must not raise.
    assert main.is_safe_ip("not-an-ip") is False


def test_is_safe_rtsp_url_requires_rtsp_scheme():
    main = importlib.import_module("main")
    assert main.is_safe_rtsp_url("http://192.168.1.10/stream") is False
    assert main.is_safe_rtsp_url("file:///etc/passwd") is False
    assert main.is_safe_rtsp_url("rtsp://127.0.0.1/stream") is False
