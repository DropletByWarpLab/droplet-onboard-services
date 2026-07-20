"""runner.run_once — caller-supplied stamp, failure output tail, record pruning.

Pins two admission-path defects plus the retention extension:
  - The runId minted at admission and the stamp run_once() used for the
    results filename were computed seconds apart, so results-<runId>.json
    lookups could miss. run_once(stamp=...) now lets the caller make them
    identical.
  - A failed run's error used to be a bare str(CalledProcessError) —
    "exited non-zero", no cause. run_once keeps a 40-line tail of the
    streamed output and raises CalledProcessError with it as `.output`;
    error_summary() renders it into the durable record's error string.
  - _prune_old_runs must also cap record-*.json (failed runs have records
    but no results pair, so the lists are independent).
"""

from __future__ import annotations

import io
import re
import subprocess

import pytest

import runner


class _FakePopen:
    """Stand-in for subprocess.Popen: replays canned output lines and an
    exit code without spawning anything."""

    def __init__(self, lines, returncode):
        self.stdout = io.StringIO("".join(f"{line}\n" for line in lines))
        self.returncode = returncode

    def wait(self):
        return self.returncode


def _patch_popen(monkeypatch, lines=("hello",), returncode=0):
    calls = []

    def fake_popen(cmd, **_kwargs):
        calls.append(cmd)
        return _FakePopen(lines, returncode)

    monkeypatch.setattr(runner.subprocess, "Popen", fake_popen)
    return calls


def test_run_once_uses_caller_provided_stamp(monkeypatch, tmp_path):
    calls = _patch_popen(monkeypatch)
    out = runner.run_once(target_dir=tmp_path, stamp="20260102T030405Z")
    assert out == tmp_path / "results-20260102T030405Z.json"
    cmd = calls[0]
    assert cmd[cmd.index("--out") + 1] == str(out)
    assert cmd[cmd.index("--out-md") + 1] == str(
        tmp_path / "results-20260102T030405Z.md"
    )


def test_run_once_defaults_to_fresh_stamp(monkeypatch, tmp_path):
    _patch_popen(monkeypatch)
    out = runner.run_once(target_dir=tmp_path)
    assert re.fullmatch(r"results-\d{8}T\d{6}Z\.json", out.name)


def test_nonzero_exit_raises_with_output_tail(monkeypatch, tmp_path):
    lines = [f"line-{i:02d}" for i in range(50)]
    _patch_popen(monkeypatch, lines=lines, returncode=2)
    with pytest.raises(subprocess.CalledProcessError) as excinfo:
        runner.run_once(target_dir=tmp_path)
    assert excinfo.value.returncode == 2
    # deque(maxlen=40): only the LAST 40 lines survive.
    assert excinfo.value.output == "\n".join(lines[-40:])


def test_error_summary_renders_exit_code_and_tail():
    exc = subprocess.CalledProcessError(2, ["ragas"], output="judge exploded")
    assert runner.error_summary(exc) == "ragas_runner exited 2: judge exploded"


def test_error_summary_without_output_is_just_exit_code():
    exc = subprocess.CalledProcessError(3, ["ragas"])
    assert runner.error_summary(exc) == "ragas_runner exited 3"


def test_error_summary_caps_length_and_keeps_the_tail_end():
    exc = subprocess.CalledProcessError(1, ["ragas"], output="x" * 5000 + "END")
    summary = runner.error_summary(exc)
    assert len(summary) <= 1000
    assert summary.startswith("ragas_runner exited 1: ")
    assert summary.endswith("END")


def test_error_summary_passes_other_exceptions_through():
    assert runner.error_summary(ValueError("boom")) == "boom"


def test_prune_caps_records_independently_of_results_pairs(tmp_path):
    result_stamps = [f"2026010{i}T000000Z" for i in range(1, 6)]  # 5 pairs
    record_stamps = [f"2026010{i}T000000Z" for i in range(2, 7)]  # 5 records
    for stamp in result_stamps:
        (tmp_path / f"results-{stamp}.json").write_text("{}")
        (tmp_path / f"results-{stamp}.md").write_text("md")
    for stamp in record_stamps:
        (tmp_path / f"record-{stamp}.json").write_text("{}")

    runner._prune_old_runs(tmp_path, keep=3)

    kept_results = sorted(p.name for p in tmp_path.glob("results-*.json"))
    kept_mds = sorted(p.name for p in tmp_path.glob("results-*.md"))
    kept_records = sorted(p.name for p in tmp_path.glob("record-*.json"))
    # Newest 3 of EACH list — a failed run's record must not be evicted
    # just because successes wrote newer results pairs.
    assert kept_results == [f"results-{s}.json" for s in result_stamps[-3:]]
    assert kept_mds == [f"results-{s}.md" for s in result_stamps[-3:]]
    assert kept_records == [f"record-{s}.json" for s in record_stamps[-3:]]
