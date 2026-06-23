"""Model capability resolution (vision / tools)."""

from __future__ import annotations

from capabilities import cloud_capabilities, ollama_capabilities_from_show


def test_cloud_vision_allowlist():
    assert cloud_capabilities("gpt-4o").vision is True
    assert cloud_capabilities("gpt-4o-mini").vision is True
    assert cloud_capabilities("claude-3-5-haiku-20241022").vision is True
    assert cloud_capabilities("claude-sonnet-4-20250514").vision is True


def test_cloud_non_vision():
    # A hypothetical text-only cloud model id should not be flagged vision.
    assert cloud_capabilities("o1-mini").vision is False
    # Cloud models are assumed tool-capable.
    assert cloud_capabilities("o1-mini").tools is True


def test_ollama_show_vision_via_capabilities():
    caps = ollama_capabilities_from_show({"capabilities": ["completion", "vision"]})
    assert caps.vision is True


def test_ollama_show_vision_via_family():
    caps = ollama_capabilities_from_show({"details": {"families": ["mllama"]}})
    assert caps.vision is True


def test_ollama_show_text_only():
    caps = ollama_capabilities_from_show({"capabilities": ["completion"]})
    assert caps.vision is False


def test_ollama_show_tools():
    caps = ollama_capabilities_from_show({"capabilities": ["completion", "tools"]})
    assert caps.tools is True
    assert caps.vision is False
