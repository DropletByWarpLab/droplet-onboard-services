"""WARP-1870 — the runtime selector must not fail open in silence.

`INFERENCE_RUNTIME` is read once at module import and defaults to "ollama".
On a DMR box that default is a silent trap: lose the variable and both DMR
flags (`_STATIC_CAPABILITY_TABLE`, `_GRAMMAR_SAFE_TOOL_SCHEMAS`) quietly flip
off. Every model then reports `tools=false`, tool schemas stop being
grammar-stripped, and the WARP-1839 outage returns — with no error anywhere.

Losing the variable is not hypothetical. It is exactly the WARP-1860 shape: a
compose `${VAR:-}` interpolating against an env file that lacks the key. And
`docker restart` re-reads nothing, so a box can sit in this state indefinitely.

The contradiction is detectable for free — `OLLAMA_URL` still points at DMR —
so the resolver logs it loudly instead of degrading quietly.
"""

from __future__ import annotations

import logging

from providers.ollama_local import _resolve_inference_runtime


def test_dmr_runtime_resolves_cleanly(caplog) -> None:
    with caplog.at_level(logging.ERROR):
        assert _resolve_inference_runtime("dmr", "http://dmr:12434") == "dmr"
    assert not caplog.records, "a coherent DMR box must log nothing"


def test_ollama_runtime_with_ollama_url_resolves_cleanly(caplog) -> None:
    with caplog.at_level(logging.ERROR):
        assert _resolve_inference_runtime("ollama", "http://ollama:11434") == "ollama"
    assert not caplog.records, "a coherent Ollama box must log nothing"


def test_lost_variable_against_a_dmr_url_is_shouted(caplog) -> None:
    """The trap: variable gone, URL still DMR. Must be loud."""
    with caplog.at_level(logging.ERROR):
        got = _resolve_inference_runtime("", "http://dmr:12434")
    assert got == "ollama", "empty resolves to the documented default"
    assert caplog.records, "an incoherent box MUST log at ERROR, not degrade silently"
    msg = caplog.records[0].getMessage()
    assert "tools=false" in msg, "the message must name the observable symptom"
    assert "force-recreate" in msg, "and the fix, since docker restart re-reads nothing"


def test_port_12434_alone_is_enough_to_detect_dmr(caplog) -> None:
    """Detection must not depend on the hostname being literally 'dmr' —
    an IP or an alias with DMR's port is the same contradiction."""
    with caplog.at_level(logging.ERROR):
        _resolve_inference_runtime("ollama", "http://127.0.0.1:12434")
    assert caplog.records


def test_resolver_does_not_auto_correct(caplog) -> None:
    """It warns; it does not silently rewrite the operator's choice.

    Inferring the runtime from a URL is its own guessing game, and an operator
    who genuinely wants Ollama against a DMR-shaped URL should be obeyed and
    warned — not overridden by a heuristic.
    """
    with caplog.at_level(logging.ERROR):
        assert _resolve_inference_runtime("ollama", "http://dmr:12434") == "ollama"


def test_whitespace_and_case_are_normalised(caplog) -> None:
    with caplog.at_level(logging.ERROR):
        assert _resolve_inference_runtime("  DMR  ", "http://dmr:12434") == "dmr"
    assert not caplog.records


def test_missing_url_does_not_crash_the_resolver(caplog) -> None:
    """A resolver that raises at import would take the whole gateway down —
    strictly worse than the degradation it exists to report."""
    with caplog.at_level(logging.ERROR):
        assert _resolve_inference_runtime("dmr", "") == "dmr"
        assert _resolve_inference_runtime("ollama", "") == "ollama"
