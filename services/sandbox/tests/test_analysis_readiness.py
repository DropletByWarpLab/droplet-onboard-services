from types import SimpleNamespace

import analysis_readiness
import main


def test_readiness_requires_auth_and_never_executes_or_seals(client, auth, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Readiness must not execute sample/user code")
    monkeypatch.setattr(main, "run_transform", forbidden)
    monkeypatch.setattr(analysis_readiness, "kernel_eligible", lambda: True)
    assert client.get("/capabilities").status_code == 401
    assert client.get("/capabilities", headers=auth).json() == {"version": 1, "analysisEligible": True, "busy": False}
    assert main.ANALYSIS_LOCK.acquire(blocking=False)
    try:
        assert client.get("/capabilities", headers=auth).json()["busy"] is True
    finally:
        main.ANALYSIS_LOCK.release()


def test_kernel_readiness_unsupported_platform_does_not_probe(monkeypatch):
    monkeypatch.setattr(analysis_readiness.sys, "platform", "win32")
    monkeypatch.setattr(analysis_readiness.ctypes, "CDLL", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("No syscall on Windows")))
    assert analysis_readiness.kernel_eligible() is False


def test_kernel_query_only_reads_landlock_abi_and_seccomp_mode(monkeypatch):
    calls = []
    def syscall(*args):
        calls.append(("syscall", args))
        return 1
    def prctl(*args):
        calls.append(("prctl", args))
        return 0
    monkeypatch.setattr(analysis_readiness.sys, "platform", "linux")
    monkeypatch.setattr(analysis_readiness.platform, "machine", lambda: "aarch64")
    monkeypatch.setattr(analysis_readiness.ctypes, "CDLL", lambda *_args, **_kwargs: SimpleNamespace(syscall=syscall, prctl=prctl))
    assert analysis_readiness.kernel_eligible() is True
    assert calls == [("syscall", (444, 0, 0, 1)), ("prctl", (21, 0, 0, 0, 0))]


def test_kernel_missing_landlock_fails_closed(monkeypatch):
    syscall = lambda *_args: -1
    monkeypatch.setattr(analysis_readiness.sys, "platform", "linux")
    monkeypatch.setattr(analysis_readiness.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(analysis_readiness.ctypes, "CDLL", lambda *_args, **_kwargs: SimpleNamespace(syscall=syscall, prctl=lambda *_args: 0))
    assert analysis_readiness.kernel_eligible() is False
