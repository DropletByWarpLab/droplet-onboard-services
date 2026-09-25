"""The /proc probes the supervision suites lean on (WARP-2900).

`alive()` is what `wait_gone()` polls, so a probe that raises instead of
answering turns a process that exited on time into a red test. These pin
every answer without needing Linux: `open` is replaced.
"""

from __future__ import annotations

import builtins
import io

import pytest

from tests import proc_helpers


def _open_raising(exc: BaseException):
    def fake_open(*_args, **_kwargs):
        raise exc

    return fake_open


class _ReadRaises(io.StringIO):
    """Opens fine, then the pid exits: the read is what fails (ESRCH)."""

    def read(self, *_args):
        raise ProcessLookupError(3, "No such process")


@pytest.mark.parametrize(
    ("stat", "expected"),
    [
        ("4575 (sleep) S 1 4575 4575 0 -1", True),
        ("4575 (sleep) R 1 4575 4575 0 -1", True),
        ("4575 (sleep) Z 1 4575 4575 0 -1", False),
        # A command name may itself contain ") " — the state follows the LAST one.
        ("4575 (a) b) S 1 4575 4575 0 -1", True),
    ],
)
def test_alive_reads_the_state_field(monkeypatch, stat, expected):
    monkeypatch.setattr(builtins, "open", lambda *_a, **_k: io.StringIO(stat))
    assert proc_helpers.alive(4575) is expected


def test_a_pid_with_no_proc_entry_is_gone(monkeypatch):
    monkeypatch.setattr(
        builtins,
        "open",
        _open_raising(FileNotFoundError(2, "No such file or directory")),
    )
    assert proc_helpers.alive(4575) is False


def test_a_pid_that_exits_between_open_and_read_is_gone(monkeypatch):
    monkeypatch.setattr(builtins, "open", lambda *_a, **_k: _ReadRaises())
    assert proc_helpers.alive(4575) is False


def test_a_pid_that_exits_before_open_answers_esrch_is_gone(monkeypatch):
    monkeypatch.setattr(
        builtins, "open", _open_raising(ProcessLookupError(3, "No such process"))
    )
    assert proc_helpers.alive(4575) is False


def test_wait_gone_returns_once_the_read_races_the_exit(monkeypatch):
    monkeypatch.setattr(builtins, "open", lambda *_a, **_k: _ReadRaises())
    assert proc_helpers.wait_gone(4575, timeout_s=0.5) is True
