"""Bearer auth — every route except /health requires SANDBOX_SERVICE_TOKEN.

Missing / wrong / wrong-scheme tokens are 401. An UNSET token env fails CLOSED
with 503 on every non-/health route: there is no *_ALLOW_NO_AUTH escape,
because a failed secret injection at deploy must not leave a code-execution
service answering anything on the internal network.
"""

from __future__ import annotations

import os
import subprocess
import sys

import pytest

import main

BODY = {"code": "output = 1"}


def test_health_needs_no_token(client):
    assert client.get("/health").status_code == 200


def test_transform_rejects_a_missing_token(client):
    assert client.post("/transform", json=BODY).status_code == 401


def test_transform_rejects_a_wrong_token(client):
    assert client.post("/transform", json=BODY, headers={"Authorization": "Bearer nope"}).status_code == 401


def test_transform_rejects_a_wrong_scheme(client):
    r = client.post("/transform", json=BODY, headers={"Authorization": "Basic pytest-fake-token"})
    assert r.status_code == 401


def test_transform_accepts_the_configured_token(client, auth):
    r = client.post("/transform", json=BODY, headers=auth)
    assert r.status_code == 200
    assert r.json() == {"output": 1}


def test_unset_token_fails_closed_with_503(client, auth, monkeypatch):
    monkeypatch.setattr(main, "SANDBOX_SERVICE_TOKEN", "")
    assert client.post("/transform", json=BODY, headers=auth).status_code == 503
    assert client.get("/health").status_code == 200


# ── the bearer is not readable by a same-uid child (WARP-2900) ─────────────
#
# Installed extensions and workspace runs execute as the sandbox's own uid.
# A dumpable server lets any of them read SANDBOX_SERVICE_TOKEN from
# /proc/<server pid>/environ and drive the whole sandbox API. The server
# marks itself non-dumpable at import, which makes its /proc entries
# root-owned and ptrace-protected for the same uid.


class _FakeLibc:
    def __init__(self, rc: int = 0) -> None:
        self.calls: list[tuple[int, ...]] = []
        self.rc = rc

    def prctl(self, *args: int) -> int:
        self.calls.append(args)
        return self.rc


def test_the_server_asks_the_kernel_to_be_non_dumpable():
    # MUTATION: skip the prctl call and nothing is asked of the kernel.
    libc = _FakeLibc()
    assert main._make_undumpable(libc) is True
    assert libc.calls == [(main.PR_SET_DUMPABLE, 0, 0, 0, 0)]
    assert main.PR_SET_DUMPABLE == 4


def test_a_refused_prctl_is_reported_not_hidden():
    assert main._make_undumpable(_FakeLibc(rc=-1)) is False


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="/proc and prctl are Linux")
@pytest.mark.skipif(sys.platform.startswith("linux") and os.geteuid() == 0, reason="root reads any /proc entry")
def test_a_same_uid_child_cannot_read_the_server_environment():
    # `import main` ran in THIS process, so this process is the "server".
    assert main.SERVER_UNDUMPABLE is True
    probe = subprocess.run(
        [sys.executable, "-c", f"open('/proc/{os.getpid()}/environ', 'rb').read()"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert probe.returncode != 0
    assert "PermissionError" in probe.stderr

