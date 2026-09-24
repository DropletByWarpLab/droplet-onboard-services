"""The extension's entry point. `run` is what the box calls with the tool's
arguments; return plain JSON the assistant can read back."""

from __future__ import annotations


def run(input: dict) -> dict:
    text = str(input.get("text", ""))
    words = 0 if not text.strip() else len(text.split())
    return {"words": words, "characters": len(text)}
