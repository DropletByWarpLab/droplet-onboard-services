"""WARP-3126 — the Whisper STT sidecar's CPU quota and thread count.

Transcription starts only once the speaker stops talking, so the Whisper
sidecar's decode time sits directly in front of the LLM call on EVERY voice
turn. WARP-3126 raised the defaults from 2 CPUs / 2 threads to 4 / 4 to
roughly halve that time.

Two rules are pinned here:

  * WARP-1434 — CTranslate2's `--cpu-threads` MUST equal the container's
    `cpus:` quota. More threads than cores just adds context-switch churn
    (the old `--cpu-threads 4` inside `cpus: 2.0`); fewer leaves the quota
    idle. The two knobs (WHISPER_CPUS / WHISPER_CPU_THREADS) move together.
  * The operator-facing docs (.env.example) state the same defaults the
    compose file actually ships, so nobody tunes against a stale number.

Hermetic by design — no pyyaml (see shell-validation-tests.yml: a
requirements.txt appearing in this lane means a test stopped being hermetic),
so the compose file is scanned line-wise rather than parsed into objects.
"""
from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_COMPOSE = _REPO_ROOT / "docker" / "docker-compose.yml"
_ENV_EXAMPLE = _REPO_ROOT / ".env.example"

_SERVICE = "wyoming-faster-whisper"

# WARP-3126 defaults.
_EXPECTED_CPUS = 4.0
_EXPECTED_THREADS = 4

_CPUS_LINE = re.compile(r"^ {4}cpus: \$\{WHISPER_CPUS:-([0-9.]+)\}\s*$")
_THREADS_ARG = re.compile(r"--cpu-threads \$\{WHISPER_CPU_THREADS:-([0-9]+)\}")


def _service_block(name: str) -> list[str]:
    """Return the non-comment lines of one service, keyed off indentation.

    Services sit at 2 spaces under `services:`; the block ends at the next
    2-space key or the next top-level key.
    """
    lines = _COMPOSE.read_text(encoding="utf-8").splitlines()
    block: list[str] = []
    inside = False
    for raw in lines:
        if raw.strip().startswith("#") or not raw.strip():
            continue
        if re.match(rf"^ {{2}}{re.escape(name)}:\s*$", raw):
            inside = True
            continue
        if inside and (re.match(r"^ {2}\S", raw) or re.match(r"^\S", raw)):
            break
        if inside:
            block.append(raw)
    return block


def _compose_defaults() -> tuple[str, str]:
    block = _service_block(_SERVICE)
    assert block, f"{_SERVICE} not found in {_COMPOSE} — parser drifted"

    cpus = [m.group(1) for line in block if (m := _CPUS_LINE.match(line))]
    threads = [m.group(1) for line in block if (m := _THREADS_ARG.search(line))]

    assert len(cpus) == 1, (
        f"expected exactly one `cpus: ${{WHISPER_CPUS:-N}}` line on {_SERVICE}, "
        f"found {len(cpus)} — the quota must stay env-overridable"
    )
    assert len(threads) == 1, (
        f"expected exactly one `--cpu-threads ${{WHISPER_CPU_THREADS:-N}}` in "
        f"{_SERVICE}'s command, found {len(threads)} — the thread count must "
        "stay env-overridable"
    )
    return cpus[0], threads[0]


def test_whisper_defaults_to_four_cpus_and_four_threads():
    """WARP-3126: 4/4 halves the STT stage on the per-turn critical path."""
    cpus, threads = _compose_defaults()
    assert float(cpus) == _EXPECTED_CPUS, (
        f"{_SERVICE} default cpus is {cpus}, expected {_EXPECTED_CPUS} (WARP-3126)"
    )
    assert int(threads) == _EXPECTED_THREADS, (
        f"{_SERVICE} default --cpu-threads is {threads}, expected "
        f"{_EXPECTED_THREADS} (WARP-3126)"
    )


def test_whisper_threads_track_the_cpu_quota():
    """WARP-1434: CTranslate2 threads == container CPU quota, always."""
    cpus, threads = _compose_defaults()
    assert float(cpus) == float(threads), (
        f"{_SERVICE} runs --cpu-threads {threads} inside cpus: {cpus}. The "
        "CTranslate2 thread count must equal the CPU quota (WARP-1434) — "
        "raise or lower WHISPER_CPUS and WHISPER_CPU_THREADS together."
    )


def test_env_example_documents_the_whisper_cpu_knobs_with_the_shipped_defaults():
    """The operator docs must show the defaults compose actually ships."""
    cpus, threads = _compose_defaults()
    env_example = _ENV_EXAMPLE.read_text(encoding="utf-8")

    m_cpus = re.search(r"^#? ?WHISPER_CPUS=([0-9.]+)\s*$", env_example, re.M)
    m_threads = re.search(r"^#? ?WHISPER_CPU_THREADS=([0-9]+)\s*$", env_example, re.M)

    assert m_cpus, ".env.example does not document WHISPER_CPUS"
    assert m_threads, ".env.example does not document WHISPER_CPU_THREADS"
    assert float(m_cpus.group(1)) == float(cpus), (
        f".env.example shows WHISPER_CPUS={m_cpus.group(1)} but compose ships {cpus}"
    )
    assert int(m_threads.group(1)) == int(threads), (
        f".env.example shows WHISPER_CPU_THREADS={m_threads.group(1)} but "
        f"compose ships {threads}"
    )
