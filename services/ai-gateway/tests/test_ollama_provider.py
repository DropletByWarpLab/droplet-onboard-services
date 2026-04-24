"""Tests for the Ollama provider helpers."""

import pytest

from providers.ollama_local import prettify_ollama_name


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("llama3.1:8b", "Llama 3.1 8B"),
        ("llama3.2:3b", "Llama 3.2 3B"),
        ("qwen2.5:3b-instruct", "Qwen 2.5 3B Instruct"),
        ("mistral:7b", "Mistral 7B"),
        ("phi3.5:3.8b", "Phi 3.5 3.8B"),
        ("gemma2:9b-instruct-q4_0", "Gemma 2 9B Instruct Q4_0"),
        # No tag: just title-case the base.
        ("llama3", "Llama 3"),
        # Already pretty / oddly-shaped inputs: don't over-mangle.
        ("codellama:latest", "Codellama LATEST"),
    ],
)
def test_prettify_ollama_name(raw: str, expected: str) -> None:
    assert prettify_ollama_name(raw) == expected
