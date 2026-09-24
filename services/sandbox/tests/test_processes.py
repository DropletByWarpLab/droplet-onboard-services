"""The supervision seam (slice H) — gated off by default, closed in shape, real when on.

Off: every /processes route is 404 (undiscoverable). On: argv[0] must be a
bare interpreter name the image ships, the entrypoint must live under the
extensions directory, arguments carry a conservative charset — and then a
long-lived child is started, read and stopped. State is explicit, never
inferred from a missing pid.

The tests point SANDBOX_PYTHON_BIN at this interpreter and
SANDBOX_EXTENSIONS_DIR at a temp dir holding tiny entrypoint scripts, so the
seam runs REAL processes on the Linux CI runner and a Windows dev checkout.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

import pytest

import supervisor
from tests.proc_helpers import alive, needs_linux, wait_gone


@pytest.fixture()
def ext(tmp_path: Path, monkeypatch):
    """An extensions dir with three entrypoints, and the seam pointed at it."""
    (tmp_path / "sleeper.py").write_text("import time\ntime.sleep(30)\n")
    (tmp_path / "exit3.py").write_text("raise SystemExit(3)\n")
    (tmp_path / "ok.py").write_text("pass\n")
    monkeypatch.setattr(supervisor, "EXTENSIONS_DIR", os.path.realpath(str(tmp_path)))
    monkeypatch.setattr(supervisor, "INTERPRETERS", {"python": sys.executable, "python3": sys.executable, "node": "/usr/local/bin/node"})
    return tmp_path


def _wait_for(sup: supervisor.Supervisor, proc_id: str, states: set[str], timeout_s: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        st = sup.status(proc_id)
        if st and st["state"] in states:
            return st
        time.sleep(0.05)
    return sup.status(proc_id) or {}


def test_gated_off_by_default_every_route_is_404(client, auth, monkeypatch):
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", False)
    body = {"id": "ext-a", "argv": ["python", "ok.py"]}
    assert client.post("/processes", json=body, headers=auth).status_code == 404
    assert client.get("/processes/ext-a", headers=auth).status_code == 404
    assert client.delete("/processes/ext-a", headers=auth).status_code == 404
    assert client.get("/health").json()["processes"] is False


def test_the_seam_is_closed_in_shape(ext):
    # MUTATION: pass the request's argv straight to Popen and every case
    # below goes green-for-the-wrong-reason (it would run) — except the
    # first, which pins that a path is never accepted as the interpreter.
    r = supervisor.resolve_argv
    with pytest.raises(supervisor.SupervisorError):
        r([sys.executable, "ok.py"], None)  # a PATH, not a bare name
    with pytest.raises(supervisor.SupervisorError):
        r(["bash", "ok.py"], None)  # not an interpreter the image ships
    with pytest.raises(supervisor.SupervisorError):
        r(["python"], None)  # no entrypoint
    with pytest.raises(supervisor.SupervisorError):
        r(["python", "../../etc/passwd"], None)  # escapes the extensions dir
    with pytest.raises(supervisor.SupervisorError):
        r(["python", "/etc/passwd"], None)  # absolute, outside
    with pytest.raises(supervisor.SupervisorError):
        r(["python", "ok.py", "; rm -rf /"], None)  # metacharacters
    with pytest.raises(supervisor.SupervisorError):
        r(["python", "ok.py"], "/")  # cwd outside the extensions dir
    argv, cwd = r(["python", "ok.py", "--port=8100"], None)
    assert argv[0] == sys.executable
    assert argv[1] == os.path.join(supervisor.EXTENSIONS_DIR, "ok.py")
    assert argv[2] == "--port=8100"
    assert cwd == supervisor.EXTENSIONS_DIR


def test_start_status_stop_when_enabled(client, auth, monkeypatch, ext):
    monkeypatch.setattr(supervisor, "SUPERVISION_ENABLED", True)
    monkeypatch.setattr(supervisor, "SUPERVISOR", supervisor.Supervisor())
    body = {"id": "ext-b", "argv": ["python", "sleeper.py"], "restart": "never"}
    r = client.post("/processes", json=body, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "running"
    assert r.json()["pid"]

    assert client.post("/processes", json=body, headers=auth).status_code == 409
    assert client.post("/processes", json={"id": "ext-x", "argv": ["bash", "x"]}, headers=auth).status_code == 400

    assert client.get("/processes/ext-b", headers=auth).json()["state"] == "running"

    d = client.delete("/processes/ext-b", headers=auth).json()
    assert d["state"] == "stopped"
    assert client.get("/processes/nope", headers=auth).status_code == 404


def test_on_failure_restarts_up_to_the_budget_then_reports_failed(ext):
    sup = supervisor.Supervisor()
    snap = sup.start("ext-c", ["python", "exit3.py"], cwd=None, restart="on-failure", max_restarts=2, env={})
    assert snap["id"] == "ext-c"
    st = _wait_for(sup, "ext-c", {"failed"})
    assert st["state"] == "failed"
    assert st["restarts"] == 2
    assert st["exitCode"] == 3


def test_a_clean_exit_with_never_is_exited_not_failed(ext):
    sup = supervisor.Supervisor()
    sup.start("ext-d", ["python", "ok.py"], cwd=None, restart="never", max_restarts=3, env={})
    assert _wait_for(sup, "ext-d", {"exited", "failed"})["state"] == "exited"


# ── WARP-2900 review #2323 (d): a stop takes the whole process tree ────────


def _forker(ext: Path, name: str, then: str) -> Path:
    """An entrypoint that forks a long sleeper, writes its pid, then `then`."""
    pidfile = ext / f"{name}.pid"
    (ext / f"{name}.py").write_text(
        "import os, subprocess, sys, time\n"
        "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
        f"with open({str(pidfile)!r} + '.tmp', 'w') as fh:\n"
        "    fh.write(str(p.pid))\n"
        f"os.replace({str(pidfile)!r} + '.tmp', {str(pidfile)!r})\n"
        f"{then}\n"
    )
    return pidfile


def _read_pid(pidfile: Path, timeout_s: float = 10.0) -> int:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if pidfile.exists():
            return int(pidfile.read_text())
        time.sleep(0.05)
    raise AssertionError(f"{pidfile.name} never appeared")


@needs_linux
def test_stop_takes_a_process_the_child_forked(ext):
    # Stop used to signal only the direct child, so an extension that forked
    # kept the fork running through disable and uninstall, holding its
    # DROPLET_EXT_TOKEN. MUTATIONS: drop start_new_session -> the child shares
    # the server's group (getpgid != pid), red; terminate()/kill() the child
    # instead of killpg -> the sleeper survives the stop, red.
    pidfile = _forker(ext, "forker", "time.sleep(120)")
    sup = supervisor.Supervisor()
    snap = sup.start("ext-fork", ["python", "forker.py"], cwd=None, restart="never", max_restarts=0, env={})
    sleeper = _read_pid(pidfile)
    assert os.getpgid(snap["pid"]) == snap["pid"], "the child leads its own process group"
    assert os.getpgid(sleeper) == snap["pid"]
    assert alive(sleeper)
    assert sup.stop("ext-fork")["state"] == "stopped"
    assert wait_gone(sleeper), "the forked sleeper outlived the stop"


@needs_linux
def test_stop_kills_a_group_that_ignores_sigterm_after_the_grace(ext):
    # MUTATION: drop the SIGKILL to the group after the grace -> the child
    # is still running when stop waits for it, red.
    pidfile = ext / "stubborn.pid"
    (ext / "stubborn.py").write_text(
        "import os, signal, subprocess, sys, time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "p = subprocess.Popen([sys.executable, '-c', "
        "'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)'])\n"
        f"with open({str(pidfile)!r} + '.tmp', 'w') as fh:\n"
        "    fh.write(str(p.pid))\n"
        f"os.replace({str(pidfile)!r} + '.tmp', {str(pidfile)!r})\n"
        "time.sleep(120)\n"
    )
    sup = supervisor.Supervisor()
    snap = sup.start("ext-stubborn", ["python", "stubborn.py"], cwd=None, restart="never", max_restarts=0, env={})
    sleeper = _read_pid(pidfile)
    assert sup.stop("ext-stubborn", grace_s=0.5)["state"] == "stopped"
    assert wait_gone(snap["pid"]) and wait_gone(sleeper)


@needs_linux
def test_a_child_that_exits_takes_its_forks_with_it(ext):
    # With restart "never" a crashed extension stays down until install()
    # starts it again; what it forked must not keep running meanwhile.
    # MUTATION: drop the group kill in _watch and the sleeper survives, red.
    pidfile = _forker(ext, "crasher", "raise SystemExit(4)")
    sup = supervisor.Supervisor()
    sup.start("ext-crash", ["python", "crasher.py"], cwd=None, restart="never", max_restarts=0, env={})
    sleeper = _read_pid(pidfile)
    assert _wait_for(sup, "ext-crash", {"failed"})["exitCode"] == 4
    assert wait_gone(sleeper), "the forked sleeper outlived its parent"


# ── WARP-2900 H2: the seam as slice H needs it ──────────────────────────────


def test_the_host_shims_are_the_one_entrypoint_outside_the_extensions_dir(ext):
    shim = os.path.join(supervisor.HOST_SHIMS_DIR, "host.py")
    argv, cwd = supervisor.resolve_argv(["python", shim, "."], str(ext))
    assert argv == [sys.executable, shim, "."] and cwd == os.path.realpath(str(ext))
    # Anything else next to the shims is still outside the extensions dir.
    with pytest.raises(supervisor.SupervisorError):
        supervisor.resolve_argv(["python", os.path.join(supervisor.HOST_SHIMS_DIR, "..", "main.py")], str(ext))
    with pytest.raises(supervisor.SupervisorError):
        supervisor.resolve_argv(["python", os.path.join(supervisor.HOST_SHIMS_DIR, "nope.py")], str(ext))


def test_extra_env_is_an_allowlist(ext):
    # MUTATION: return `dict(extra_env)` from check_extra_env without the
    # unknown-key check and the first two cases start a child holding a
    # secret it was never meant to see.
    sup = supervisor.Supervisor()
    for bad in ({"SANDBOX_SERVICE_TOKEN": "x"}, {"PATH": "/tmp/evil"}, {"DROPLET_EXT_ID": "a b"}):
        with pytest.raises(supervisor.SupervisorError) as exc:
            sup.start("ext-env", ["python", "ok.py"], cwd=None, restart="never", max_restarts=0, env={}, extra_env=bad)
        assert exc.value.status == 400
    assert sup.status("ext-env") is None
    ok = supervisor.check_extra_env({"DROPLET_EXT_ID": "ws-a", "DROPLET_EXT_PORT": "18000", "DROPLET_EXT_TOKEN": "dxt_abc-_x"})
    assert ok["DROPLET_EXT_PORT"] == "18000"


def test_no_preexec_fn_the_limits_are_an_exec_wrapper(ext, monkeypatch):
    # preexec_fn in a threaded server is unsafe (workspace.py); the WARP-2895
    # seam used it. MUTATION: put `preexec_fn=...` back in _spawn and red.
    seen: dict = {}
    real_popen = supervisor.subprocess.Popen

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return real_popen(*args, **kwargs)

    monkeypatch.setattr(supervisor.subprocess, "Popen", spy)
    sup = supervisor.Supervisor()
    sup.start("ext-w", ["python", "ok.py"], cwd=None, restart="never", max_restarts=0, env={})
    assert "preexec_fn" not in seen
    _wait_for(sup, "ext-w", {"exited", "failed"})


def test_node_gets_a_heap_cap_and_nothing_gets_an_address_space_cap():
    # The WARP-2895 seam capped every child's address space at 256 MB; V8
    # reserves far more than that and dies at start, and a python server
    # under a small cap cannot start a thread. MUTATION: add RLIMIT_AS back
    # to _LIMIT_WRAPPER and red (and the live node/thread cases on Linux).
    node = supervisor.limited_command("node", ["/usr/local/bin/node", "/ext/a/host.mjs", "."], 128, posix=True)
    assert node[:5] == [sys.executable, "-I", "-S", "-c", supervisor._LIMIT_WRAPPER]
    assert node[5:7] == [str(supervisor.CHILD_MAX_PROCS), str(supervisor.CHILD_MAX_FILE_BYTES)]
    assert node[7:] == ["/usr/local/bin/node", "--max-old-space-size=128", "/ext/a/host.mjs", "."]
    py = supervisor.limited_command("python", ["/usr/local/bin/python", "/ext/a/host.py", "."], 64, posix=True)
    assert py[7:] == ["/usr/local/bin/python", "/ext/a/host.py", "."]
    # No address-space or data cap anywhere in the wrapper, and NPROC only
    # when an operator sets one (it is per-UID ACROSS containers).
    assert supervisor.CHILD_MAX_PROCS == 0
    assert "if nproc > 0" in supervisor._LIMIT_WRAPPER
    assert "RLIMIT_AS" not in supervisor._LIMIT_WRAPPER
    assert "RLIMIT_DATA" not in supervisor._LIMIT_WRAPPER
    # A dev checkout (not POSIX) runs the command plainly.
    assert supervisor.limited_command("node", ["node", "x"], 128, posix=False) == ["node", "--max-old-space-size=128", "x"]


@pytest.mark.skipif(os.name != "posix", reason="rlimits are POSIX-only")
def test_the_wrapper_really_execs_under_the_limits(tmp_path):
    probe = tmp_path / "probe.py"
    probe.write_text(
        "import resource, threading\n"
        "ts = [threading.Thread(target=lambda: None) for _ in range(32)]\n"
        "[t.start() for t in ts]; [t.join() for t in ts]\n"
        "print(resource.getrlimit(resource.RLIMIT_FSIZE)[0], resource.getrlimit(resource.RLIMIT_AS)[0])\n",
        encoding="utf-8",
    )
    import subprocess as sp

    out = sp.run(supervisor.with_limits([sys.executable, str(probe)]), capture_output=True, text=True, check=True)
    fsize, as_limit = out.stdout.split()
    assert int(fsize) == supervisor.CHILD_MAX_FILE_BYTES
    assert int(as_limit) == -1  # RLIM_INFINITY: no address-space cap; and 32 threads started


@pytest.mark.skipif(os.name != "posix" or shutil.which("node") is None, reason="needs node on a POSIX host")
def test_node_starts_under_the_wrapper(tmp_path):
    # The regression for the RLIMIT_AS defect, end to end.
    import subprocess as sp

    node = shutil.which("node")
    cmd = supervisor.limited_command("node", [node, "-e", "process.exit(0)"], 128)
    assert sp.run(cmd, capture_output=True, timeout=60, check=False).returncode == 0
