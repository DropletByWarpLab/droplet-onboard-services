"""Unit tests for the device-bridge NVR recordings-storage boundary (WARP-3514).

Camera recordings are allocated automatically on an encrypted bay drive: an
ext4 project-quota slice created by the host writer
(`droplet-set-nvr-media.sh`), moved by a root migration job. The bridge is the
only thing the orchestrator can talk to, and it runs as the unprivileged
`droplet` user inside a ProtectSystem=strict / NoNewPrivileges sandbox, so — like
the storage-pool write path — it NEVER does the privileged work itself:

  GET  /host/nvr-storage           `<writer> --status` (read-only, unprivileged)
  POST /host/nvr-storage           spool op `apply`  + blocking start of the apply unit
  POST /host/nvr-storage/resize    spool op `resize` + blocking start of the apply unit
  POST /host/nvr-storage/migrate   migrate-request.json + `systemctl start --no-block`
  GET  /host/nvr-storage/migrate   migrate-state.json (written by the root job)
  POST /host/nvr-storage/old/delete  migrate-request.json (delete_old) + no-block start

plus two guards (409, nothing executed): the drive that holds the recordings
cannot be ejected, and cannot be adopted / reclaimed / pool-operated on.

Everything is exercised through the real `Handler` with the `_run` boundary
replaced by `FakeHost`, which plays the roles of the writer's `--status`, the
root apply unit, the root migrate unit and `systemctl is-active`. No systemctl,
no writer, no root and no real block device is ever touched. The fake RECORDS
any command the bridge was not supposed to run, and every test fails if it did.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"

_TOKEN = "pytest-bridge-token"
_AUTH = {"X-Droplet-Auth": _TOKEN}
_SCRIPT = "/opt/fixtures/droplet-set-nvr-media.sh"
_APPLY_UNIT = "droplet-nvr-storage-apply.service"
_MIGRATE_UNIT = "droplet-nvr-migrate.service"
_FS_UUID = "3f2a9c1e-7b4d-4c58-9e21-0a1b2c3d4e5f"
_BAY_MOUNT = "/mnt/droplet/bay-ab12cd34"

# What `<writer> --status` prints for a recordings slice that is up and running.
_STATUS_ACTIVE = {
    "source": _BAY_MOUNT + "/nvr", "kind": "path", "fsUuid": _FS_UUID,
    "mountPath": _BAY_MOUNT, "physicalDisk": "sdb",
    "backingDevices": ["sdb", "sdb1", "droplet-bay-ab12cd34"],
    "isSystemDisk": False, "encrypted": True, "mounted": True, "rw": True,
    "projectId": 4096, "limitBytes": 100, "usedBytes": 10,
    "fsSizeBytes": 1000, "fsFreeBytes": 800,
}
_WRITER_APPLY_OK = {
    "ok": True, "operation": "apply", "fsUuid": _FS_UUID, "mountPath": _BAY_MOUNT,
    "source": _BAY_MOUNT + "/nvr", "mode": "reserved", "projectId": 4096,
    "limitBytes": 123, "previousSource": "nvrdata", "envChanged": True,
}
_WRITER_RESIZE_OK = {
    "ok": True, "operation": "resize", "limitBytes": 456, "usedBytes": 45,
    "projectId": 4096,
}
# Every stable machine code the writer documents for a refusal.
_WRITER_CODES = [
    "bad_request", "not_mounted", "bad_mount", "read_only", "os_disk",
    "not_encrypted", "quota_unsupported", "quota_failed", "no_allocation",
    "below_used", "exceeds_fs", "env_write_failed", "internal",
]

_IS_POSIX = os.name == "posix"
_NEEDS_POSIX = pytest.mark.skipif(
    sys.platform == "win32", reason="drive/ejection paths are POSIX-only")


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

class FakeHost:
    """Everything the bridge shells out to for NVR storage, in one fake `_run`."""

    def __init__(self, spool: Path):
        self.spool = spool
        self.calls: list[tuple[list[str], float]] = []
        self.unexpected: list[list[str]] = []
        # `<writer> --status`
        self.status: object = dict(_STATUS_ACTIVE)
        self.status_rc = 0
        self.status_stdout: str | None = None
        # The root apply unit: the writer's outcome that lands in result.json.
        self.writer = {"rc": 0, "stdout": json.dumps(_WRITER_APPLY_OK), "stderr": ""}
        self.write_result = True
        self.result_request_id: str | None = None
        # `systemctl start` outcome for either unit.
        self.start_rc = 0
        self.start_err = ""
        # What `systemctl is-active <migrate unit>` prints.
        self.unit_state = "inactive"
        # Observations.
        self.requests: list[dict] = []
        self.request_modes: list[int] = []
        self.migrate_requests: list[dict] = []
        # Concurrency hooks: the apply unit blocks until `hold` is set.
        self.hold: threading.Event | None = None
        self.entered = threading.Event()

    # -- the `_run` boundary -------------------------------------------------
    def __call__(self, cmd, timeout=15):
        cmd = list(cmd)
        self.calls.append((cmd, timeout))
        if cmd == [_SCRIPT, "--status"]:
            if self.status_rc != 0:
                return self.status_rc, "", "status script exploded"
            out = (self.status_stdout if self.status_stdout is not None
                   else json.dumps(self.status))
            return 0, out, ""
        if cmd == ["systemctl", "start", _APPLY_UNIT]:
            return self._apply_unit()
        if cmd == ["systemctl", "start", "--no-block", _MIGRATE_UNIT]:
            return self._migrate_unit()
        if cmd == ["systemctl", "is-active", _MIGRATE_UNIT]:
            rc = 0 if self.unit_state in ("active", "activating") else 3
            return rc, self.unit_state + "\n", ""
        if cmd[:1] in (["sync"], ["umount"]):
            return 0, "", ""
        self.unexpected.append(cmd)
        raise AssertionError("unexpected command: {}".format(cmd))

    def _apply_unit(self):
        if self.hold is not None:
            self.entered.set()
            assert self.hold.wait(10), "test never released the apply unit"
        if self.start_rc != 0:
            # The unit never ran (polkit denied / not installed): the request
            # is left behind for the bridge to clean up.
            return self.start_rc, "", self.start_err
        req_path = self.spool / "request.json"
        assert req_path.exists(), "bridge must spool the request before starting the unit"
        if _IS_POSIX:
            self.request_modes.append(stat.S_IMODE(req_path.stat().st_mode))
        req = json.loads(req_path.read_text())
        self.requests.append(req)
        req_path.unlink()
        if self.write_result:
            rid = self.result_request_id or req["request_id"]
            (self.spool / "result.json").write_text(
                json.dumps({"request_id": rid, **self.writer}))
        return 0, "", ""

    def _migrate_unit(self):
        if self.start_rc != 0:
            return self.start_rc, "", self.start_err
        req_path = self.spool / "migrate-request.json"
        assert req_path.exists(), "bridge must spool the request before starting the unit"
        self.migrate_requests.append(json.loads(req_path.read_text()))
        return 0, "", ""   # the root job consumes the request later, not us

    # -- assertions ------------------------------------------------------------
    def commands(self) -> list[list[str]]:
        return [c for c, _t in self.calls]


class _FakeHeaders(dict):
    def get(self, k, default=None):
        for key, val in self.items():
            if key.lower() == k.lower():
                return val
        return default


class _FakeRfile:
    def __init__(self, body: bytes):
        self._body = body

    def read(self, n):
        return self._body[:n]


class _FakeHandler:
    """Drives Handler.do_GET / do_POST without a socket.

    Binds ONLY `_authed`, `do_GET`, `do_POST` and `_dispatch_post` from the real
    Handler — exactly what the sibling bridge tests bind — so the NVR routes are
    pinned to depend on nothing but `_authed` / `_send` / headers / rfile.
    """

    def __init__(self, bridge, headers, path, body: bytes = b""):
        self.headers = _FakeHeaders(headers)
        self.rfile = _FakeRfile(body)
        self.path = path
        self.sent: list[tuple[int, object]] = []
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_GET = bridge.Handler.do_GET.__get__(self, bridge.Handler)
        self.do_POST = bridge.Handler.do_POST.__get__(self, bridge.Handler)
        self._dispatch_post = bridge.Handler._dispatch_post.__get__(self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _get(bridge, path, headers=_AUTH):
    h = _FakeHandler(bridge, headers, path)
    h.do_GET()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def _post(bridge, path, payload=None, *, headers=_AUTH, raw=None):
    body = raw if raw is not None else json.dumps(
        {} if payload is None else payload).encode()
    h = _FakeHandler(bridge, {**headers, "Content-Length": str(len(body))}, path, body)
    h.do_POST()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def _load_bridge(monkeypatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", _TOKEN)
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_nvr_storage_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def nvr(monkeypatch, tmp_path):
    spool = tmp_path / "nvr-spool"
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_NVR_SCRIPT": _SCRIPT,
        "DROPLET_NVR_SPOOL_DIR": str(spool),
        "DROPLET_NVR_APPLY_UNIT": _APPLY_UNIT,
        "DROPLET_NVR_MIGRATE_UNIT": _MIGRATE_UNIT,
    })
    host = FakeHost(spool)
    monkeypatch.setattr(bridge, "_run", host)
    invalidations: list[bool] = []
    monkeypatch.setattr(
        bridge, "drives_snapshot",
        lambda invalidate=False: invalidations.append(invalidate) or {})
    ns = SimpleNamespace(bridge=bridge, host=host, spool=spool,
                         invalidations=invalidations, tmp=tmp_path)
    yield ns
    # A command the bridge was never allowed to run may have been swallowed by
    # a fail-open path — the fake remembers it regardless.
    assert host.unexpected == [], host.unexpected


def _spool_files(nvr) -> list[str]:
    return sorted(p.name for p in nvr.spool.iterdir()) if nvr.spool.exists() else []


def _no_side_effects(nvr):
    assert nvr.host.calls == [], nvr.host.calls
    assert _spool_files(nvr) == []
    assert nvr.invalidations == []


# ---------------------------------------------------------------------------
# Configuration defaults + "not a pool op"
# ---------------------------------------------------------------------------

def test_defaults_match_the_installed_names(monkeypatch):
    for name in ("DROPLET_NVR_SCRIPT", "DROPLET_NVR_SPOOL_DIR",
                 "DROPLET_NVR_APPLY_UNIT", "DROPLET_NVR_MIGRATE_UNIT"):
        monkeypatch.delenv(name, raising=False)
    bridge = _load_bridge(monkeypatch)
    assert bridge.NVR_SCRIPT == "/usr/local/sbin/droplet-set-nvr-media.sh"
    assert bridge.NVR_SPOOL_DIR == "/var/lib/droplet-bridge/nvr-spool"
    assert bridge.NVR_APPLY_UNIT == "droplet-nvr-storage-apply.service"
    assert bridge.NVR_MIGRATE_UNIT == "droplet-nvr-migrate.service"


def test_empty_env_override_falls_back_to_the_default(monkeypatch):
    # An empty override must never produce an empty (CWD-relative) spool path.
    bridge = _load_bridge(monkeypatch, {"DROPLET_NVR_SPOOL_DIR": "  "})
    assert bridge.NVR_SPOOL_DIR == "/var/lib/droplet-bridge/nvr-spool"


def test_nvr_is_not_routed_through_the_pool_ops(nvr):
    # Not STORAGE_OPS / _POOL_OPS: those are Tier-3 data-destroying ops behind a
    # typed confirm; the NVR endpoints have their own contract.
    assert not [op for op in nvr.bridge._POOL_OPS if "nvr" in op]
    status, body = _post(nvr.bridge, "/pools/command",
                         {"operation": "nvr_apply", "params": {"fsUuid": _FS_UUID}})
    assert status == 422 and body["ok"] is False
    assert nvr.host.calls == []


def test_the_bridge_only_ever_starts_or_probes_units():
    # polkit grants the start verb only; `is-active` is an unprivileged read.
    import re
    src = _BRIDGE_PATH.read_text(encoding="utf-8")
    verbs = set(re.findall(r'\["systemctl",\s*"([a-z-]+)"', src))
    assert verbs <= {"start", "is-active"}, verbs


# ---------------------------------------------------------------------------
# Auth — every endpoint, nothing runs
# ---------------------------------------------------------------------------

_ROUTES = [
    ("GET", "/host/nvr-storage"),
    ("POST", "/host/nvr-storage"),
    ("POST", "/host/nvr-storage/resize"),
    ("POST", "/host/nvr-storage/migrate"),
    ("GET", "/host/nvr-storage/migrate"),
    ("POST", "/host/nvr-storage/old/delete"),
]
_BAD_AUTH = [
    pytest.param({}, id="no-token"),
    pytest.param({"X-Droplet-Auth": "not-the-token"}, id="wrong-token"),
    pytest.param({"Authorization": "Bearer not-the-token"}, id="wrong-bearer"),
]


@pytest.mark.parametrize("headers", _BAD_AUTH)
@pytest.mark.parametrize("method,path", _ROUTES)
def test_every_endpoint_requires_the_bridge_token(nvr, method, path, headers):
    if method == "GET":
        status, body = _get(nvr.bridge, path, headers)
    else:
        status, body = _post(nvr.bridge, path,
                             {"fsUuid": _FS_UUID, "mode": "full", "limitBytes": 5},
                             headers=headers)
    assert status == 401
    assert body == {"ok": False, "error": "unauthorized"}
    _no_side_effects(nvr)


def test_bearer_token_is_accepted(nvr):
    status, body = _get(nvr.bridge, "/host/nvr-storage",
                        {"Authorization": "Bearer " + _TOKEN})
    assert status == 200 and body["ok"] is True


def test_unknown_nvr_path_is_a_404(nvr):
    status, _body = _post(nvr.bridge, "/host/nvr-storage/nope", {})
    assert status == 404
    status, _body = _get(nvr.bridge, "/host/nvr-storage/nope")
    assert status == 404
    _no_side_effects(nvr)


# ---------------------------------------------------------------------------
# GET /host/nvr-storage — the writer's --status, verbatim
# ---------------------------------------------------------------------------

def test_status_returns_the_writer_json_verbatim(nvr):
    status, body = _get(nvr.bridge, "/host/nvr-storage")
    assert status == 200
    assert body["ok"] is True
    for key, value in _STATUS_ACTIVE.items():
        assert body[key] == value, key
    # One unprivileged read, with the documented 20 s budget — never a write.
    assert nvr.host.calls == [([_SCRIPT, "--status"], 20)]
    assert nvr.invalidations == []


def test_status_query_string_is_ignored(nvr):
    status, _body = _get(nvr.bridge, "/host/nvr-storage?cachebust=1")
    assert status == 200


def test_status_ok_flag_cannot_be_overridden_by_the_script_output(nvr):
    nvr.host.status = {**_STATUS_ACTIVE, "ok": False}
    status, body = _get(nvr.bridge, "/host/nvr-storage")
    assert status == 200 and body["ok"] is True


@pytest.mark.parametrize("configure", [
    pytest.param(lambda h: setattr(h, "status_rc", 1), id="script-exits-nonzero"),
    pytest.param(lambda h: setattr(h, "status_stdout", ""), id="empty-output"),
    pytest.param(lambda h: setattr(h, "status_stdout", "<html>nope</html>"), id="not-json"),
    pytest.param(lambda h: setattr(h, "status_stdout", "[1, 2]"), id="json-not-an-object"),
    pytest.param(lambda h: setattr(h, "status_stdout", "null"), id="json-null"),
])
def test_status_failure_is_a_502_with_a_machine_code(nvr, configure):
    configure(nvr.host)
    status, body = _get(nvr.bridge, "/host/nvr-storage")
    assert status == 502
    assert body["ok"] is False
    assert body["code"] == "host_script_unavailable"
    assert body["error"]


def test_status_never_raises_when_the_script_cannot_run(nvr, monkeypatch):
    def explode(cmd, timeout=15):
        raise OSError("writer not installed")
    monkeypatch.setattr(nvr.bridge, "_run", explode)
    status, body = _get(nvr.bridge, "/host/nvr-storage")
    assert status == 502 and body["code"] == "host_script_unavailable"


# ---------------------------------------------------------------------------
# POST /host/nvr-storage — apply
# ---------------------------------------------------------------------------

def test_apply_reserved_goes_via_spool_and_the_apply_unit(nvr):
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "reserved", "limitBytes": 123})
    assert status == 200
    assert body == {"ok": True, "applied": _WRITER_APPLY_OK}
    # The spooled request: op + exactly the validated params, nothing else.
    [req] = nvr.host.requests
    assert req["operation"] == "apply"
    assert req["params"] == {"fsUuid": _FS_UUID, "mode": "reserved", "limitBytes": 123}
    assert set(req) == {"request_id", "operation", "params"}
    assert req["request_id"]
    # Blocking start of the apply unit with the documented 125 s budget, and
    # NEVER the writer / docker / rsync directly.
    assert nvr.host.commands() == [
        ["systemctl", "is-active", _MIGRATE_UNIT],
        ["systemctl", "start", _APPLY_UNIT],
    ]
    assert (["systemctl", "start", _APPLY_UNIT], 125) in nvr.host.calls
    # Result consumed and deleted — nothing stale left in the spool.
    assert _spool_files(nvr) == []
    # The drive inventory (usage.role) is refreshed.
    assert nvr.invalidations == [True]


def test_apply_full_ignores_limit_bytes(nvr):
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full", "limitBytes": "junk"})
    assert status == 200
    [req] = nvr.host.requests
    assert req["params"] == {"fsUuid": _FS_UUID, "mode": "full"}


def test_apply_full_without_a_limit_is_fine(nvr):
    status, _body = _post(nvr.bridge, "/host/nvr-storage",
                          {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 200
    status, _body = _post(nvr.bridge, "/host/nvr-storage",
                          {"fsUuid": _FS_UUID, "mode": "full", "limitBytes": None})
    assert status == 200


def test_apply_does_not_forward_unknown_client_keys(nvr):
    status, _body = _post(nvr.bridge, "/host/nvr-storage", {
        "fsUuid": _FS_UUID, "mode": "reserved", "limitBytes": 7,
        "device": "sda", "operation": "pool_destroy", "path": "/etc"})
    assert status == 200
    [req] = nvr.host.requests
    assert req["operation"] == "apply"
    assert req["params"] == {"fsUuid": _FS_UUID, "mode": "reserved", "limitBytes": 7}


@pytest.mark.parametrize("limit", [1, 2 ** 62])
def test_apply_limit_boundaries_are_accepted(nvr, limit):
    status, _body = _post(nvr.bridge, "/host/nvr-storage",
                          {"fsUuid": _FS_UUID, "mode": "reserved", "limitBytes": limit})
    assert status == 200
    assert nvr.host.requests[-1]["params"]["limitBytes"] == limit


@pytest.mark.parametrize("fs_uuid", [
    "3f2a9c1e", "ABCD123", "A" * 36, "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
])
def test_apply_accepts_real_filesystem_uuid_shapes(nvr, fs_uuid):
    status, _body = _post(nvr.bridge, "/host/nvr-storage",
                          {"fsUuid": fs_uuid, "mode": "full"})
    assert status == 200


_BAD_UUIDS = [
    pytest.param("", id="empty"),
    pytest.param("ABCD12", id="too-short"),
    pytest.param("A" * 37, id="too-long"),
    pytest.param("-ABCD1234", id="leading-hyphen"),
    pytest.param("ZZZZZZZZ", id="non-hex"),
    pytest.param("ab12cd34; rm -rf /", id="shell-metachars"),
    pytest.param("ab12cd34\n", id="trailing-newline"),
    pytest.param("ab12cd34\nmode=full", id="embedded-newline"),
    pytest.param("ab12 cd34", id="space"),
    pytest.param("../../etc/passwd", id="path"),
    pytest.param("/dev/sda1", id="device-path"),
    pytest.param(12345678, id="int"),
    pytest.param(None, id="null"),
    pytest.param(["ab12cd34"], id="list"),
    pytest.param({"a": 1}, id="object"),
]


@pytest.mark.parametrize("fs_uuid", _BAD_UUIDS)
def test_apply_rejects_a_bad_fs_uuid_before_any_exec(nvr, fs_uuid):
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": fs_uuid, "mode": "full"})
    assert status == 400
    assert body["ok"] is False and body["code"] == "bad_request"
    _no_side_effects(nvr)


@pytest.mark.parametrize("mode", [
    "RESERVED", "Full", "", "whole", "reserved ", None, 1, True, ["full"],
])
def test_apply_rejects_a_bad_mode_before_any_exec(nvr, mode):
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": mode, "limitBytes": 5})
    assert status == 400 and body["code"] == "bad_request"
    _no_side_effects(nvr)


_BAD_LIMITS = [
    pytest.param(0, id="zero"),
    pytest.param(-1, id="negative"),
    pytest.param(2 ** 62 + 1, id="above-2^62"),
    pytest.param(10 ** 30, id="huge"),
    pytest.param("100", id="numeric-string"),
    pytest.param("1e3", id="exp-string"),
    pytest.param(1.5, id="float"),
    pytest.param(100.0, id="integral-float"),
    pytest.param(True, id="bool-true"),
    pytest.param(False, id="bool-false"),
    pytest.param([], id="list"),
    pytest.param({}, id="object"),
    pytest.param(None, id="null"),
]


@pytest.mark.parametrize("limit", _BAD_LIMITS)
def test_apply_reserved_rejects_a_bad_limit_before_any_exec(nvr, limit):
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "reserved", "limitBytes": limit})
    assert status == 400 and body["code"] == "bad_request"
    _no_side_effects(nvr)


def test_apply_reserved_requires_a_limit(nvr):
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "reserved"})
    assert status == 400 and body["code"] == "bad_request"
    _no_side_effects(nvr)


@pytest.mark.parametrize("raw", [
    pytest.param(b"{not json", id="malformed-json"),
    pytest.param(b"[]", id="array"),
    pytest.param(b"null", id="null"),
    pytest.param(b'"text"', id="string"),
    pytest.param(b"5", id="number"),
])
@pytest.mark.parametrize("path", [
    "/host/nvr-storage", "/host/nvr-storage/resize",
    "/host/nvr-storage/migrate", "/host/nvr-storage/old/delete",
])
def test_non_object_bodies_are_400_before_any_exec(nvr, path, raw):
    status, body = _post(nvr.bridge, path, raw=raw)
    assert status == 400 and body["ok"] is False
    _no_side_effects(nvr)


def test_body_is_capped_at_4096_bytes(nvr):
    # The cap truncates the read, so an oversized body is malformed JSON.
    big = json.dumps({"fsUuid": _FS_UUID, "mode": "full",
                      "pad": "x" * 5000}).encode()
    status, body = _post(nvr.bridge, "/host/nvr-storage", raw=big)
    assert status == 400
    _no_side_effects(nvr)


@pytest.mark.parametrize("code", _WRITER_CODES)
def test_apply_writer_refusal_maps_on_the_machine_code(nvr, code):
    # The message deliberately contains words a substring match would misread
    # as lock contention / a running job: the status keys on `code` alone
    # (WARP-834 finding 1).
    msg = "another operation is already in progress; busy; migration running"
    nvr.host.writer = {
        "rc": 1, "stdout": json.dumps({"ok": False, "code": code, "message": msg}),
        "stderr": "droplet-set-nvr-media: " + msg + "\n"}
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "reserved", "limitBytes": 9})
    assert status == 422
    assert body == {"ok": False, "code": code, "error": msg}
    assert nvr.invalidations == []           # a refusal changed nothing
    assert _spool_files(nvr) == []


def test_apply_refusal_without_a_message_still_has_an_error_text(nvr):
    nvr.host.writer = {"rc": 1, "stdout": json.dumps({"ok": False, "code": "os_disk"}),
                       "stderr": "droplet-set-nvr-media: that is the OS disk\n"}
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 422 and body["code"] == "os_disk" and body["error"]


@pytest.mark.parametrize("writer", [
    pytest.param({"rc": 1, "stdout": "", "stderr": "boom"}, id="rc1-no-json"),
    pytest.param({"rc": 3, "stdout": "not json", "stderr": ""}, id="rc3-text"),
    pytest.param({"rc": 0, "stdout": "all good, trust me", "stderr": ""}, id="rc0-no-json"),
    pytest.param({"rc": 0, "stdout": "[1]", "stderr": ""}, id="rc0-json-array"),
    pytest.param({"rc": None, "stdout": json.dumps(_WRITER_APPLY_OK), "stderr": ""}, id="rc-missing"),
    pytest.param({"rc": 1, "stdout": json.dumps({"ok": True}), "stderr": ""}, id="rc1-but-ok"),
    pytest.param({"rc": 1, "stdout": json.dumps({"ok": False, "code": "Not A Code!"}),
                  "stderr": ""}, id="malformed-code"),
    pytest.param({"rc": 1, "stdout": json.dumps({"ok": False, "code": 7}),
                  "stderr": ""}, id="non-string-code"),
])
def test_apply_unusable_writer_output_is_executor_failed(nvr, writer):
    nvr.host.writer = writer
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 502
    assert body["ok"] is False and body["code"] == "executor_failed"
    assert nvr.invalidations == []
    assert _spool_files(nvr) == []


def test_apply_unit_start_failure_is_executor_failed_and_cleans_the_request(nvr):
    nvr.host.start_rc = 1
    nvr.host.start_err = "Failed to start droplet-nvr-storage-apply.service: Access denied"
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 502
    assert body["code"] == "executor_failed"
    assert "denied" in body["error"].lower()
    # The unconsumed request must not be left for a later start to pick up.
    assert _spool_files(nvr) == []


def test_apply_executor_that_writes_no_result_is_executor_failed(nvr):
    nvr.host.write_result = False
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 502 and body["code"] == "executor_failed"


def test_apply_ignores_a_result_for_a_different_request(nvr):
    nvr.host.result_request_id = "someone-elses"
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 502 and body["code"] == "executor_failed"
    assert nvr.invalidations == []
    # ...and the stale result was discarded, not left to poison the next run.
    assert _spool_files(nvr) == []


def test_apply_removes_a_stale_request_result_pair_before_spooling(nvr):
    nvr.spool.mkdir(parents=True)
    (nvr.spool / "request.json").write_text('{"request_id": "old", "operation": "resize"}')
    (nvr.spool / "result.json").write_text(json.dumps(
        {"request_id": "old", "rc": 0, "stdout": json.dumps(_WRITER_APPLY_OK), "stderr": ""}))
    nvr.host.write_result = False        # the unit produces nothing this time
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full"})
    # Had the stale result survived it would have been reported as success.
    assert status == 502 and body["code"] == "executor_failed"
    [req] = nvr.host.requests
    assert req["operation"] == "apply" and req["request_id"] != "old"


def test_apply_never_raises_when_systemctl_blows_up(nvr, monkeypatch):
    def explode(cmd, timeout=15):
        raise OSError("systemctl not found")
    monkeypatch.setattr(nvr.bridge, "_run", explode)
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 502 and body["code"] == "executor_failed"
    assert _spool_files(nvr) == []


def test_apply_spool_failure_is_executor_failed(nvr):
    # The spool "directory" is a regular file: nothing can be written there.
    nvr.spool.parent.mkdir(parents=True, exist_ok=True)
    nvr.spool.write_text("in the way")
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 502 and body["code"] == "executor_failed"
    assert nvr.host.calls == [(["systemctl", "is-active", _MIGRATE_UNIT], 10)]


@pytest.mark.skipif(not _IS_POSIX, reason="POSIX permission bits")
def test_apply_spool_dir_is_tightened_to_0700_and_request_is_0600(nvr):
    nvr.spool.mkdir(parents=True)
    os.chmod(nvr.spool, 0o755)           # a looser umask from an older install
    status, _body = _post(nvr.bridge, "/host/nvr-storage",
                          {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 200
    assert stat.S_IMODE(nvr.spool.stat().st_mode) == 0o700
    assert nvr.host.request_modes == [0o600]


@pytest.mark.parametrize("state", ["active", "activating", "deactivating"])
def test_apply_refuses_while_a_migration_job_runs(nvr, state):
    nvr.host.unit_state = state
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 409
    assert body["ok"] is False and body["code"] == "migration_running"
    assert nvr.host.commands() == [["systemctl", "is-active", _MIGRATE_UNIT]]
    assert _spool_files(nvr) == []
    assert nvr.invalidations == []


@pytest.mark.parametrize("state", ["inactive", "failed", "unknown", ""])
def test_apply_proceeds_when_the_migration_unit_is_not_running(nvr, state):
    nvr.host.unit_state = state
    status, _body = _post(nvr.bridge, "/host/nvr-storage",
                          {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 200


def test_apply_busy_when_another_nvr_operation_holds_the_lock(nvr):
    assert nvr.bridge._NVR_LOCK.acquire(blocking=False)
    try:
        status, body = _post(nvr.bridge, "/host/nvr-storage",
                             {"fsUuid": _FS_UUID, "mode": "full"})
    finally:
        nvr.bridge._NVR_LOCK.release()
    assert status == 409
    assert body["ok"] is False and body["code"] == "busy"
    _no_side_effects(nvr)


def test_the_nvr_lock_is_independent_of_the_pool_lock(nvr):
    assert nvr.bridge._NVR_LOCK is not nvr.bridge._POOL_LOCK
    assert nvr.bridge._POOL_LOCK.acquire(blocking=False)
    try:
        status, _body = _post(nvr.bridge, "/host/nvr-storage",
                              {"fsUuid": _FS_UUID, "mode": "full"})
    finally:
        nvr.bridge._POOL_LOCK.release()
    assert status == 200


def test_concurrent_requests_second_caller_gets_busy(nvr):
    gate = threading.Event()
    nvr.host.hold = gate
    first: dict = {}

    def run_first():
        first["resp"] = _post(nvr.bridge, "/host/nvr-storage",
                              {"fsUuid": _FS_UUID, "mode": "full"})

    worker = threading.Thread(target=run_first)
    worker.start()
    try:
        assert nvr.host.entered.wait(10), "first request never reached the apply unit"
        # Every mutating NVR endpoint is refused while the first is in flight.
        for path, body in [
            ("/host/nvr-storage", {"fsUuid": _FS_UUID, "mode": "full"}),
            ("/host/nvr-storage/resize", {"limitBytes": 5}),
            ("/host/nvr-storage/migrate", {"fsUuid": _FS_UUID}),
            ("/host/nvr-storage/old/delete", {}),
        ]:
            status, resp = _post(nvr.bridge, path, body)
            assert (status, resp["code"]) == (409, "busy"), path
    finally:
        gate.set()
        worker.join(10)
    assert first["resp"][0] == 200
    # Only the first request ever reached the unit.
    assert len(nvr.host.requests) == 1


def test_the_lock_is_released_after_every_outcome(nvr, monkeypatch):
    # success, refusal, executor failure, validation failure, an exploding _run
    nvr.host.writer = {"rc": 1, "stdout": json.dumps({"ok": False, "code": "os_disk"}),
                       "stderr": ""}
    _post(nvr.bridge, "/host/nvr-storage", {"fsUuid": _FS_UUID, "mode": "full"})
    nvr.host.start_rc = 1
    _post(nvr.bridge, "/host/nvr-storage", {"fsUuid": _FS_UUID, "mode": "full"})
    _post(nvr.bridge, "/host/nvr-storage", {"fsUuid": "nope", "mode": "full"})
    monkeypatch.setattr(nvr.bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("boom")))
    _post(nvr.bridge, "/host/nvr-storage", {"fsUuid": _FS_UUID, "mode": "full"})
    assert nvr.bridge._NVR_LOCK.acquire(blocking=False), "lock leaked"
    nvr.bridge._NVR_LOCK.release()


def test_a_snapshot_refresh_failure_never_turns_success_into_an_error(nvr, monkeypatch):
    def broken(invalidate=False):
        raise RuntimeError("lsblk exploded")
    monkeypatch.setattr(nvr.bridge, "drives_snapshot", broken)
    status, body = _post(nvr.bridge, "/host/nvr-storage",
                         {"fsUuid": _FS_UUID, "mode": "full"})
    assert status == 200 and body["ok"] is True


# ---------------------------------------------------------------------------
# POST /host/nvr-storage/resize
# ---------------------------------------------------------------------------

def test_resize_goes_via_spool_and_the_apply_unit(nvr):
    nvr.host.writer = {"rc": 0, "stdout": json.dumps(_WRITER_RESIZE_OK), "stderr": ""}
    status, body = _post(nvr.bridge, "/host/nvr-storage/resize", {"limitBytes": 456})
    assert status == 200
    assert body == {"ok": True, "resized": _WRITER_RESIZE_OK}
    [req] = nvr.host.requests
    assert req["operation"] == "resize"
    assert req["params"] == {"limitBytes": 456}
    assert (["systemctl", "start", _APPLY_UNIT], 125) in nvr.host.calls
    assert _spool_files(nvr) == []
    assert nvr.invalidations == [True]


@pytest.mark.parametrize("limit", _BAD_LIMITS)
def test_resize_rejects_a_bad_limit_before_any_exec(nvr, limit):
    status, body = _post(nvr.bridge, "/host/nvr-storage/resize", {"limitBytes": limit})
    assert status == 400 and body["code"] == "bad_request"
    _no_side_effects(nvr)


def test_resize_requires_a_limit(nvr):
    status, body = _post(nvr.bridge, "/host/nvr-storage/resize", {})
    assert status == 400 and body["code"] == "bad_request"
    _no_side_effects(nvr)


@pytest.mark.parametrize("code", ["no_allocation", "below_used", "exceeds_fs", "quota_failed"])
def test_resize_writer_refusal_maps_on_the_machine_code(nvr, code):
    nvr.host.writer = {
        "rc": 1,
        "stdout": json.dumps({"ok": False, "code": code, "message": "nope, in progress"}),
        "stderr": ""}
    status, body = _post(nvr.bridge, "/host/nvr-storage/resize", {"limitBytes": 5})
    assert status == 422
    assert body == {"ok": False, "code": code, "error": "nope, in progress"}


def test_resize_executor_failure_is_a_502(nvr):
    nvr.host.start_rc = 1
    nvr.host.start_err = "unit not found"
    status, body = _post(nvr.bridge, "/host/nvr-storage/resize", {"limitBytes": 5})
    assert status == 502 and body["code"] == "executor_failed"
    assert _spool_files(nvr) == []


def test_resize_refuses_while_a_migration_job_runs(nvr):
    nvr.host.unit_state = "activating"
    status, body = _post(nvr.bridge, "/host/nvr-storage/resize", {"limitBytes": 5})
    assert status == 409 and body["code"] == "migration_running"
    assert _spool_files(nvr) == []


def test_resize_busy_when_another_nvr_operation_holds_the_lock(nvr):
    assert nvr.bridge._NVR_LOCK.acquire(blocking=False)
    try:
        status, body = _post(nvr.bridge, "/host/nvr-storage/resize", {"limitBytes": 5})
    finally:
        nvr.bridge._NVR_LOCK.release()
    assert status == 409 and body["code"] == "busy"
    _no_side_effects(nvr)


# ---------------------------------------------------------------------------
# POST /host/nvr-storage/migrate
# ---------------------------------------------------------------------------

def test_migrate_spools_a_request_and_starts_the_unit_without_blocking(nvr):
    status, body = _post(nvr.bridge, "/host/nvr-storage/migrate", {"fsUuid": _FS_UUID})
    assert status == 202
    assert body == {"ok": True, "state": "running"}
    [req] = nvr.host.migrate_requests
    assert req["operation"] == "migrate"
    assert req["params"] == {"fsUuid": _FS_UUID}
    assert set(req) == {"request_id", "operation", "params"}
    assert req["request_id"]
    # `systemctl start --no-block`: the job runs for as long as the copy takes.
    starts = [c for c in nvr.host.commands() if c[:2] == ["systemctl", "start"]]
    assert starts == [["systemctl", "start", "--no-block", _MIGRATE_UNIT]]
    # The root job — not the bridge — consumes the request, so it stays put;
    # the synchronous request/result pair is not involved.
    assert _spool_files(nvr) == ["migrate-request.json"]
    assert nvr.invalidations == [True]


def test_migrate_never_touches_the_apply_unit_or_the_writer(nvr):
    _post(nvr.bridge, "/host/nvr-storage/migrate", {"fsUuid": _FS_UUID})
    flat = " ".join(" ".join(c) for c in nvr.host.commands())
    assert _APPLY_UNIT not in flat and _SCRIPT not in flat
    for tool in ("rsync", "docker", "chattr", "setquota"):
        assert tool not in flat


@pytest.mark.skipif(not _IS_POSIX, reason="POSIX permission bits")
def test_migrate_request_is_0600_in_a_0700_spool(nvr):
    nvr.spool.mkdir(parents=True)
    os.chmod(nvr.spool, 0o755)
    _post(nvr.bridge, "/host/nvr-storage/migrate", {"fsUuid": _FS_UUID})
    assert stat.S_IMODE(nvr.spool.stat().st_mode) == 0o700
    assert stat.S_IMODE((nvr.spool / "migrate-request.json").stat().st_mode) == 0o600


@pytest.mark.parametrize("fs_uuid", _BAD_UUIDS)
def test_migrate_rejects_a_bad_fs_uuid_before_any_exec(nvr, fs_uuid):
    status, body = _post(nvr.bridge, "/host/nvr-storage/migrate", {"fsUuid": fs_uuid})
    assert status == 400 and body["code"] == "bad_request"
    _no_side_effects(nvr)


def test_migrate_requires_a_fs_uuid(nvr):
    status, body = _post(nvr.bridge, "/host/nvr-storage/migrate", {})
    assert status == 400 and body["code"] == "bad_request"
    _no_side_effects(nvr)


def test_migrate_does_not_forward_unknown_client_keys(nvr):
    status, _body = _post(nvr.bridge, "/host/nvr-storage/migrate",
                          {"fsUuid": _FS_UUID, "operation": "delete_old", "source": "/"})
    assert status == 202
    [req] = nvr.host.migrate_requests
    assert req["operation"] == "migrate"
    assert req["params"] == {"fsUuid": _FS_UUID}


@pytest.mark.parametrize("state", ["active", "activating"])
def test_migrate_refuses_while_a_job_runs(nvr, state):
    nvr.host.unit_state = state
    status, body = _post(nvr.bridge, "/host/nvr-storage/migrate", {"fsUuid": _FS_UUID})
    assert status == 409
    assert body["ok"] is False and body["code"] == "migration_running"
    assert nvr.host.commands() == [["systemctl", "is-active", _MIGRATE_UNIT]]
    assert _spool_files(nvr) == []
    assert nvr.invalidations == []


def test_migrate_busy_when_another_nvr_operation_holds_the_lock(nvr):
    assert nvr.bridge._NVR_LOCK.acquire(blocking=False)
    try:
        status, body = _post(nvr.bridge, "/host/nvr-storage/migrate", {"fsUuid": _FS_UUID})
    finally:
        nvr.bridge._NVR_LOCK.release()
    assert status == 409 and body["code"] == "busy"
    _no_side_effects(nvr)


def test_migrate_start_failure_is_a_502_and_removes_the_request(nvr):
    nvr.host.start_rc = 1
    nvr.host.start_err = "Failed to start droplet-nvr-migrate.service: Access denied"
    status, body = _post(nvr.bridge, "/host/nvr-storage/migrate", {"fsUuid": _FS_UUID})
    assert status == 502
    assert body["ok"] is False and body["code"] == "executor_failed"
    assert "denied" in body["error"].lower()
    assert _spool_files(nvr) == []
    assert nvr.invalidations == []


def test_migrate_clears_the_previous_jobs_state_and_stale_request(nvr):
    nvr.spool.mkdir(parents=True)
    (nvr.spool / "migrate-state.json").write_text(json.dumps(
        {"request_id": "old", "state": "done", "progressPct": 100}))
    (nvr.spool / "migrate-request.json").write_text('{"request_id": "old"}')
    status, _body = _post(nvr.bridge, "/host/nvr-storage/migrate", {"fsUuid": _FS_UUID})
    assert status == 202
    # A new job must never be reported as the previous job's `done`.
    assert _spool_files(nvr) == ["migrate-request.json"]
    assert nvr.host.migrate_requests[0]["request_id"] != "old"
    status, state = _get(nvr.bridge, "/host/nvr-storage/migrate")
    assert state["state"] == "idle"


def test_migrate_never_raises_when_systemctl_blows_up(nvr, monkeypatch):
    def explode(cmd, timeout=15):
        raise OSError("systemctl not found")
    monkeypatch.setattr(nvr.bridge, "_run", explode)
    status, body = _post(nvr.bridge, "/host/nvr-storage/migrate", {"fsUuid": _FS_UUID})
    assert status == 502 and body["code"] == "executor_failed"
    assert _spool_files(nvr) == []


# ---------------------------------------------------------------------------
# POST /host/nvr-storage/old/delete
# ---------------------------------------------------------------------------

def test_old_delete_spools_a_delete_old_request_and_starts_without_blocking(nvr):
    status, body = _post(nvr.bridge, "/host/nvr-storage/old/delete", {})
    assert status == 202 and body == {"ok": True, "state": "running"}
    [req] = nvr.host.migrate_requests
    assert req["operation"] == "delete_old"
    assert req["params"] == {}
    assert set(req) == {"request_id", "operation", "params"}
    starts = [c for c in nvr.host.commands() if c[:2] == ["systemctl", "start"]]
    assert starts == [["systemctl", "start", "--no-block", _MIGRATE_UNIT]]
    assert _spool_files(nvr) == ["migrate-request.json"]


def test_old_delete_takes_no_target_from_the_client(nvr):
    # What gets deleted is decided by the root-only migration record, never by
    # the (droplet-writable) request.
    status, _body = _post(nvr.bridge, "/host/nvr-storage/old/delete",
                          {"path": "/", "fsUuid": _FS_UUID, "source": "nvrdata"})
    assert status == 202
    assert nvr.host.migrate_requests[0]["params"] == {}


def test_old_delete_accepts_an_empty_body(nvr):
    h = _FakeHandler(nvr.bridge, {**_AUTH, "Content-Length": "0"},
                     "/host/nvr-storage/old/delete", b"")
    h.do_POST()
    assert h.sent[-1][0] == 202


def test_old_delete_does_not_refresh_the_drive_inventory(nvr):
    _post(nvr.bridge, "/host/nvr-storage/old/delete", {})
    assert nvr.invalidations == []


@pytest.mark.parametrize("state", ["active", "activating"])
def test_old_delete_refuses_while_a_job_runs(nvr, state):
    nvr.host.unit_state = state
    status, body = _post(nvr.bridge, "/host/nvr-storage/old/delete", {})
    assert status == 409 and body["code"] == "migration_running"
    assert _spool_files(nvr) == []


def test_old_delete_busy_when_another_nvr_operation_holds_the_lock(nvr):
    assert nvr.bridge._NVR_LOCK.acquire(blocking=False)
    try:
        status, body = _post(nvr.bridge, "/host/nvr-storage/old/delete", {})
    finally:
        nvr.bridge._NVR_LOCK.release()
    assert status == 409 and body["code"] == "busy"
    _no_side_effects(nvr)


def test_old_delete_start_failure_is_a_502_and_removes_the_request(nvr):
    nvr.host.start_rc = 1
    nvr.host.start_err = "unit not found"
    status, body = _post(nvr.bridge, "/host/nvr-storage/old/delete", {})
    assert status == 502 and body["code"] == "executor_failed"
    assert _spool_files(nvr) == []


# ---------------------------------------------------------------------------
# GET /host/nvr-storage/migrate
# ---------------------------------------------------------------------------

_IDLE = {
    "ok": True, "state": "idle", "job": None, "phase": None, "progressPct": 0,
    "bytesCopied": 0, "bytesTotal": 0, "startedAt": None, "finishedAt": None,
    "error": None, "errorCode": None, "oldSource": None,
}


def _write_state(nvr, state) -> None:
    nvr.spool.mkdir(parents=True, exist_ok=True)
    text = state if isinstance(state, str) else json.dumps(state)
    (nvr.spool / "migrate-state.json").write_text(text)


_RUNNING = {
    "request_id": "r1", "job": "migrate", "state": "running", "phase": "copy",
    "progressPct": 42, "bytesCopied": 420, "bytesTotal": 1000,
    "startedAt": "2026-10-03T10:00:00Z", "finishedAt": None, "error": None,
    "errorCode": None, "oldSource": {"kind": "volume", "source": "nvrdata",
                                      "bytes": 1000, "deleted": False},
}


def test_migrate_state_is_idle_when_no_job_ever_ran(nvr):
    status, body = _get(nvr.bridge, "/host/nvr-storage/migrate")
    assert status == 200
    assert body == _IDLE
    # Nothing to interpret, so nothing to ask systemd.
    assert nvr.host.calls == []


@pytest.mark.parametrize("unit_state", ["active", "activating"])
def test_migrate_state_running_is_reported_as_is(nvr, unit_state):
    _write_state(nvr, _RUNNING)
    nvr.host.unit_state = unit_state
    status, body = _get(nvr.bridge, "/host/nvr-storage/migrate")
    assert status == 200
    assert body == {**_RUNNING, "ok": True}
    assert nvr.host.commands() == [["systemctl", "is-active", _MIGRATE_UNIT]]


@pytest.mark.parametrize("unit_state", ["inactive", "failed", "unknown", ""])
def test_migrate_state_running_but_unit_gone_is_failed_interrupted(nvr, unit_state):
    _write_state(nvr, _RUNNING)
    nvr.host.unit_state = unit_state
    status, body = _get(nvr.bridge, "/host/nvr-storage/migrate")
    assert status == 200
    assert body["ok"] is True
    assert body["state"] == "failed"
    assert body["errorCode"] == "interrupted"
    assert body["error"]
    # How far it got is kept, so the UI can say so.
    assert body["progressPct"] == 42 and body["bytesCopied"] == 420
    assert body["bytesTotal"] == 1000 and body["phase"] == "copy"
    assert body["request_id"] == "r1" and body["job"] == "migrate"


def test_migrate_state_interrupted_keeps_an_existing_error_text(nvr):
    _write_state(nvr, {**_RUNNING, "error": "rsync said something"})
    status, body = _get(nvr.bridge, "/host/nvr-storage/migrate")
    assert body["errorCode"] == "interrupted"
    assert body["error"] == "rsync said something"


def test_migrate_state_done_passes_through_without_asking_systemd(nvr):
    done = {**_RUNNING, "state": "done", "phase": None, "progressPct": 100,
            "bytesCopied": 1000, "finishedAt": "2026-10-03T10:30:00Z"}
    _write_state(nvr, done)
    status, body = _get(nvr.bridge, "/host/nvr-storage/migrate")
    assert status == 200 and body == {**done, "ok": True}
    assert nvr.host.calls == []


def test_migrate_state_failed_passes_through_with_its_own_code(nvr):
    failed = {**_RUNNING, "state": "failed", "phase": "preflight", "progressPct": 0,
              "errorCode": "insufficient_space", "error": "need 11 GiB, have 4 GiB"}
    _write_state(nvr, failed)
    status, body = _get(nvr.bridge, "/host/nvr-storage/migrate")
    assert status == 200 and body == {**failed, "ok": True}
    assert nvr.host.calls == []


def test_migrate_state_missing_keys_get_idle_defaults(nvr):
    _write_state(nvr, {"state": "done", "job": "delete_old"})
    status, body = _get(nvr.bridge, "/host/nvr-storage/migrate")
    assert status == 200
    assert body == {**_IDLE, "state": "done", "job": "delete_old"}


@pytest.mark.parametrize("content", [
    pytest.param("{not json", id="malformed"),
    pytest.param("[1, 2]", id="array"),
    pytest.param("null", id="null"),
    pytest.param(json.dumps({"state": "weird"}), id="unknown-state"),
    pytest.param(json.dumps({"state": ["running"]}), id="unhashable-state"),
    pytest.param(json.dumps({"progressPct": 5}), id="no-state"),
    pytest.param("", id="empty-file"),
])
def test_migrate_state_unreadable_file_is_failed_internal(nvr, content):
    _write_state(nvr, content)
    status, body = _get(nvr.bridge, "/host/nvr-storage/migrate")
    assert status == 200
    assert body["ok"] is True and body["state"] == "failed"
    assert body["errorCode"] == "internal" and body["error"]


def test_migrate_state_read_never_raises_when_systemd_is_unavailable(nvr, monkeypatch):
    _write_state(nvr, _RUNNING)
    monkeypatch.setattr(nvr.bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("no systemctl")))
    status, body = _get(nvr.bridge, "/host/nvr-storage/migrate")
    assert status == 200 and body["state"] == "failed"
    assert body["errorCode"] == "interrupted"


def test_migrate_state_never_takes_the_lock(nvr):
    # Polling must keep working while a long operation holds the lock.
    _write_state(nvr, _RUNNING)
    nvr.host.unit_state = "active"
    assert nvr.bridge._NVR_LOCK.acquire(blocking=False)
    try:
        status, body = _get(nvr.bridge, "/host/nvr-storage/migrate")
    finally:
        nvr.bridge._NVR_LOCK.release()
    assert status == 200 and body["state"] == "running"


# ---------------------------------------------------------------------------
# Guard: the drive that holds the recordings is never ejected
# ---------------------------------------------------------------------------

_BAY_UUID = "ab12cd34-aaaa-bbbb-cccc-0123456789ab"
_USB_UUID = "ffff0000-aaaa-bbbb-cccc-0123456789ab"
_EJECT_REFUSAL = "this drive holds your camera recordings — it cannot be ejected"


@pytest.fixture
def automount(nvr):
    """A fake automount state file with the bay drive and an unrelated USB drive."""
    state = nvr.tmp / "mounts.json"
    state.write_text(json.dumps({"mounts": [
        {"uuid": _BAY_UUID, "mount": _BAY_MOUNT,
         "device": "/dev/mapper/droplet-bay-ab12cd34", "label": "bay"},
        {"uuid": _USB_UUID, "mount": "/mnt/droplet/usb-ffff0000",
         "device": "/dev/sdc1", "label": "usb"},
    ]}))
    nvr.bridge._AUTOMOUNT_STATE_PATH = str(state)
    nvr.state_path = state
    return nvr


def _eject(nvr, uuid):
    return _post(nvr.bridge, "/drives/{}/eject".format(uuid), {})


@_NEEDS_POSIX
def test_eject_of_the_recordings_drive_is_refused_with_a_409_and_a_code(automount):
    nvr = automount
    assert nvr.bridge.eject_drive(_BAY_UUID) == (False, _EJECT_REFUSAL)
    status, body = _eject(nvr, _BAY_UUID)
    assert status == 409
    assert body == {"ok": False, "error": _EJECT_REFUSAL,
                    "code": "recordings_drive_active"}
    # Nothing was unmounted, synced or forgotten.
    flat = [c[0] for c in nvr.host.commands()]
    assert "umount" not in flat and "sync" not in flat
    assert json.loads(nvr.state_path.read_text())["mounts"][0]["uuid"] == _BAY_UUID
    assert nvr.invalidations == []


@_NEEDS_POSIX
def test_eject_refusal_carries_a_machine_code_on_the_message_object(automount):
    ok, info = automount.bridge.eject_drive(_BAY_UUID)
    assert ok is False
    assert info.code == "recordings_drive_active"
    assert isinstance(info, str) and info == _EJECT_REFUSAL


@_NEEDS_POSIX
def test_eject_guard_also_matches_on_the_backing_device(automount):
    # The automount state's mount path can differ in spelling from the writer's
    # (trailing slash, bind): the device is an ancestor of the recordings fs.
    nvr = automount
    state = json.loads(nvr.state_path.read_text())
    state["mounts"][0]["mount"] = "/mnt/droplet/some-other-spelling"
    nvr.state_path.write_text(json.dumps(state))
    assert nvr.bridge.eject_drive(_BAY_UUID) == (False, _EJECT_REFUSAL)


@_NEEDS_POSIX
def test_eject_guard_matches_a_trailing_slash_mount_path(automount):
    nvr = automount
    state = json.loads(nvr.state_path.read_text())
    state["mounts"][0].update(mount=_BAY_MOUNT + "/", device="")
    nvr.state_path.write_text(json.dumps(state))
    assert nvr.bridge.eject_drive(_BAY_UUID) == (False, _EJECT_REFUSAL)


@_NEEDS_POSIX
def test_eject_of_another_drive_still_works(automount, monkeypatch):
    nvr = automount
    monkeypatch.setattr(nvr.bridge.os.path, "ismount", lambda p: True)
    status, body = _eject(nvr, _USB_UUID)
    assert status == 200 and body["ok"] is True and body["ejected"] == _USB_UUID
    flat = [c[0] for c in nvr.host.commands()]
    assert flat.count("umount") == 1
    assert json.loads(nvr.state_path.read_text())["mounts"][0]["uuid"] == _BAY_UUID
    assert nvr.invalidations == [True]


@_NEEDS_POSIX
@pytest.mark.parametrize("configure", [
    pytest.param(lambda h: setattr(h, "status_rc", 1), id="status-script-fails"),
    pytest.param(lambda h: setattr(h, "status_stdout", "garbage"), id="status-not-json"),
    pytest.param(lambda h: setattr(h, "status_stdout", "[]"), id="status-not-object"),
    pytest.param(lambda h: setattr(h, "status", {**_STATUS_ACTIVE, "kind": "volume"}),
                 id="source-is-the-named-volume"),
    pytest.param(lambda h: setattr(h, "status", {**_STATUS_ACTIVE, "mounted": False}),
                 id="bay-not-mounted"),
    pytest.param(lambda h: setattr(h, "status", {**_STATUS_ACTIVE, "mounted": "yes"}),
                 id="mounted-not-a-bool"),
    pytest.param(lambda h: setattr(h, "status", {"kind": "path", "mounted": True}),
                 id="no-mount-path-no-devices"),
])
def test_eject_guard_fails_open_when_the_active_drive_is_unknown(automount, monkeypatch,
                                                                 configure):
    nvr = automount
    configure(nvr.host)
    monkeypatch.setattr(nvr.bridge.os.path, "ismount", lambda p: True)
    status, body = _eject(nvr, _BAY_UUID)
    # Not blocked by the guard: the normal flow ran (and, here, succeeded).
    assert status == 200 and body["ok"] is True


@_NEEDS_POSIX
def test_eject_guard_fails_open_when_the_status_read_raises(automount, monkeypatch):
    nvr = automount
    real_host = nvr.host

    def flaky(cmd, timeout=15):
        if list(cmd) == [_SCRIPT, "--status"]:
            raise OSError("writer not installed")
        return real_host(cmd, timeout)

    monkeypatch.setattr(nvr.bridge, "_run", flaky)
    monkeypatch.setattr(nvr.bridge.os.path, "ismount", lambda p: True)
    status, body = _eject(nvr, _BAY_UUID)
    assert status == 200 and body["ok"] is True


@_NEEDS_POSIX
def test_eject_guard_reads_status_with_a_short_budget(automount):
    automount.bridge.eject_drive(_BAY_UUID)
    # eject itself is ~30 s worst case and the orchestrator waits on it; the
    # guard must not add the full 20 s status budget on top of that.
    [(_cmd, timeout)] = [c for c in automount.host.calls if c[0] == [_SCRIPT, "--status"]]
    assert timeout <= 10


@_NEEDS_POSIX
def test_other_eject_failures_keep_their_409_without_a_code(automount):
    nvr = automount
    status, body = _eject(nvr, "00000000-0000-0000-0000-000000000000")
    assert status == 409
    assert body == {"ok": False, "error": "no hot-plug drive with that uuid"}
    assert "code" not in body


@_NEEDS_POSIX
def test_eject_requires_auth_and_runs_nothing_without_it(automount):
    status, body = _post(automount.bridge, "/drives/{}/eject".format(_BAY_UUID), {},
                         headers={})
    assert status == 401
    assert automount.host.calls == []


# ---------------------------------------------------------------------------
# Guard: adopt / reclaim / pool ops never touch the recordings drive
# ---------------------------------------------------------------------------

def _stub_executor(nvr, monkeypatch):
    """Replace the pool executor: records whether the guard let a call through."""
    called: list[tuple] = []

    def fake(operation, params, refusal=None):
        called.append((operation, params))
        return True, {"ok": True, "operation": operation}

    monkeypatch.setattr(nvr.bridge, "_run_pool_via_executor", fake)
    return called


_POOL_PARAMS = {
    "pool_create": {"device": "md0", "level": "raid1",
                    "members": ["/dev/sda", "/dev/sdb"], "confirm_phrase": "ERASE sda sdb"},
    "pool_destroy": {"device": "md0", "confirm_phrase": "ERASE md0"},
    "pool_format": {"device": "md0", "fstype": "ext4", "confirm_phrase": "ERASE md0"},
    "pool_set_level": {"device": "md0", "level": "raid5", "confirm_phrase": "ERASE md0"},
    "pool_add_spare": {"device": "md0", "member": "/dev/sdb", "confirm_phrase": "ERASE sdb"},
    "pool_remove_disk": {"device": "md0", "member": "/dev/sdb", "confirm_phrase": "ERASE sdb"},
    "drive_adopt": {"device": "sdb", "fstype": "ext4", "wipe_method": "quick",
                    "confirm_phrase": "ERASE sdb"},
    "drive_reclaim": {"device": "sdb", "md": "md127", "fstype": "ext4",
                      "wipe_method": "quick", "confirm_phrase": "ERASE sdb"},
}


def test_every_pool_op_has_a_guard_test_case(nvr):
    # If a new op is added to _POOL_OPS the guard must be extended and tested.
    assert set(_POOL_PARAMS) == set(nvr.bridge._POOL_OPS)


@pytest.mark.parametrize("operation", sorted(_POOL_PARAMS))
def test_pool_ops_on_the_recordings_drive_are_refused_with_a_409(nvr, monkeypatch, operation):
    called = _stub_executor(nvr, monkeypatch)
    # The recordings live on a LUKS volume over a RAID1 pool (md0 on sdb+sdc):
    # every device in that chain is "the recordings drive", whichever one an
    # operation happens to name.
    nvr.host.status = {**_STATUS_ACTIVE, "physicalDisk": "sdb,sdc",
                       "backingDevices": ["md0", "sdb", "sdc", "droplet-bay-ab12cd34"]}
    params = _POOL_PARAMS[operation]
    ok, info = nvr.bridge.run_pool_command(operation, params)
    assert ok is False
    assert info.code == "recordings_drive_active"
    assert "camera recordings" in info
    status, body = _post(nvr.bridge, "/pools/command",
                         {"operation": operation, "params": params})
    assert status == 409
    assert body["ok"] is False and body["code"] == "recordings_drive_active"
    assert "camera recordings" in body["error"]
    assert called == []                      # the executor was never reached


@pytest.mark.parametrize("params", [
    pytest.param({"device": "sdb"}, id="bare-name"),
    pytest.param({"device": "/dev/sdb"}, id="dev-path"),
    pytest.param({"device": "sdb1"}, id="partition-of-the-bay"),
    pytest.param({"device": "/dev/mapper/droplet-bay-ab12cd34"}, id="mapper-path"),
    pytest.param({"device": "droplet-bay-ab12cd34"}, id="mapper-name"),
    pytest.param({"device": "sdc", "member": "/dev/sdb"}, id="member"),
    pytest.param({"device": "md0", "members": ["/dev/sdc", "/dev/sdb"]}, id="members-list"),
    pytest.param({"device": "md0", "members": "/dev/sdb"}, id="members-string"),
    pytest.param({"device": "sdc", "md": "droplet-bay-ab12cd34"}, id="md"),
])
def test_pool_guard_extracts_device_names_from_every_param_shape(nvr, monkeypatch, params):
    called = _stub_executor(nvr, monkeypatch)
    ok, info = nvr.bridge.run_pool_command("drive_adopt", params)
    assert ok is False and info.code == "recordings_drive_active"
    assert called == []


@pytest.mark.parametrize("params", [
    pytest.param({"device": "sdc"}, id="other-disk"),
    pytest.param({"device": "/dev/sdd", "members": ["/dev/sde", "/dev/sdf"]}, id="other-members"),
    pytest.param({"device": "sd"}, id="prefix-is-not-a-match"),
    pytest.param({"device": "sdb2"}, id="a-different-partition"),
    pytest.param({"device": "md0", "member": "/dev/sdc"}, id="other-member"),
    pytest.param({"device": 5, "members": [None, 7, {"a": 1}]}, id="non-string-values"),
    pytest.param({}, id="no-device-params"),
    pytest.param(None, id="no-params"),
])
def test_pool_ops_on_other_drives_are_not_blocked(nvr, monkeypatch, params):
    called = _stub_executor(nvr, monkeypatch)
    ok, info = nvr.bridge.run_pool_command("drive_adopt", params)
    assert ok is True
    assert len(called) == 1


def test_pool_guard_reads_nothing_when_no_device_is_named(nvr, monkeypatch):
    _stub_executor(nvr, monkeypatch)
    nvr.bridge.run_pool_command("pool_destroy", {})
    assert nvr.host.calls == []


@pytest.mark.parametrize("configure", [
    pytest.param(lambda h: setattr(h, "status_rc", 1), id="status-script-fails"),
    pytest.param(lambda h: setattr(h, "status_stdout", "garbage"), id="status-not-json"),
    pytest.param(lambda h: setattr(h, "status", {**_STATUS_ACTIVE, "kind": "volume"}),
                 id="source-is-the-named-volume"),
    pytest.param(lambda h: setattr(h, "status", {**_STATUS_ACTIVE, "mounted": False}),
                 id="bay-not-mounted"),
    pytest.param(lambda h: setattr(h, "status", {**_STATUS_ACTIVE, "backingDevices": None}),
                 id="no-backing-devices"),
    pytest.param(lambda h: setattr(h, "status", {**_STATUS_ACTIVE, "backingDevices": "sdb"}),
                 id="backing-devices-not-a-list"),
])
def test_pool_guard_fails_open_when_the_active_drive_is_unknown(nvr, monkeypatch, configure):
    # The orchestrator layer is the fail-closed one; the bridge must never turn
    # a flaky status read into a refusal of an owner-confirmed operation.
    called = _stub_executor(nvr, monkeypatch)
    configure(nvr.host)
    ok, _info = nvr.bridge.run_pool_command("drive_adopt", {"device": "sdb"})
    assert ok is True and len(called) == 1


def test_pool_guard_fails_open_when_the_status_read_raises(nvr, monkeypatch):
    called = _stub_executor(nvr, monkeypatch)
    monkeypatch.setattr(nvr.bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("no writer")))
    ok, _info = nvr.bridge.run_pool_command("drive_adopt", {"device": "sdb"})
    assert ok is True and len(called) == 1


def test_unknown_pool_op_is_refused_before_the_guard_reads_anything(nvr, monkeypatch):
    _stub_executor(nvr, monkeypatch)
    ok, info = nvr.bridge.run_pool_command("rm_rf_everything", {"device": "sdb"})
    assert ok is False
    assert getattr(info, "code", None) is None
    assert nvr.host.calls == []


def test_pool_guard_runs_before_the_pool_lock(nvr, monkeypatch):
    # A permanent condition (recordings drive) outranks transient contention.
    _stub_executor(nvr, monkeypatch)
    assert nvr.bridge._POOL_LOCK.acquire(blocking=False)
    try:
        ok, info = nvr.bridge.run_pool_command("drive_adopt", {"device": "sdb"})
    finally:
        nvr.bridge._POOL_LOCK.release()
    assert ok is False and info.code == "recordings_drive_active"


def test_extended_pool_command_keeps_the_active_recordings_refusal(nvr, monkeypatch):
    called = _stub_executor(nvr, monkeypatch)
    ok, info, code = nvr.bridge.run_pool_command_ex("drive_adopt", {"device": "sdb"})
    assert ok is False and code == "recordings_drive_active"
    assert info.code == code
    assert called == []


def test_recovery_key_operation_keeps_uuid_only_params_and_skips_the_disk_guard(nvr, monkeypatch):
    called = _stub_executor(nvr, monkeypatch)
    ok, _info, code = nvr.bridge.run_pool_command_ex(
        "recovery_key_regenerate", {"uuid": _BAY_UUID, "device": "sdb"})
    assert ok is True and code == ""
    assert called == [("recovery_key_regenerate", {"uuid": _BAY_UUID})]
    assert nvr.host.calls == []


def test_other_pool_refusals_keep_their_422(nvr, monkeypatch):
    # Lock contention / host-script refusals are unchanged: 422, no code.
    monkeypatch.setattr(nvr.bridge, "_run_pool_via_executor",
                        lambda op, params, refusal=None: (False, "refusing: /dev/sdc is mounted"))
    status, body = _post(nvr.bridge, "/pools/command",
                         {"operation": "drive_adopt", "params": {"device": "sdc"}})
    assert status == 422
    assert body == {"ok": False, "error": "refusing: /dev/sdc is mounted"}
    assert nvr.bridge._POOL_LOCK.acquire(blocking=False)
    try:
        status, body = _post(nvr.bridge, "/pools/command",
                             {"operation": "pool_destroy", "params": {"device": "md9"}})
    finally:
        nvr.bridge._POOL_LOCK.release()
    assert status == 422 and "code" not in body


def test_pool_command_still_goes_through_the_pool_spool_when_not_blocked(nvr, monkeypatch):
    # End-to-end through the REAL executor path: the NVR guard is read-only and
    # must leave the existing spool + start contract untouched.
    pool_spool = nvr.tmp / "pool-spool"
    monkeypatch.setattr(nvr.bridge, "POOL_SPOOL_DIR", str(pool_spool))
    real_host = nvr.host
    seen: dict = {}

    def run(cmd, timeout=15):
        cmd = list(cmd)
        if cmd[:2] == ["systemctl", "start"]:
            seen["cmd"] = cmd
            req = json.loads((pool_spool / "request.json").read_text())
            (pool_spool / "request.json").unlink()
            (pool_spool / "result.json").write_text(json.dumps({
                "request_id": req["request_id"], "rc": 0,
                "stdout": '{"ok": true, "device": "sdc"}', "stderr": ""}))
            return 0, "", ""
        if cmd and cmd[0] == "lsblk":
            return 1, "", "no lsblk"
        return real_host(cmd, timeout)

    monkeypatch.setattr(nvr.bridge, "_run", run)
    ok, info = nvr.bridge.run_pool_command("drive_adopt", {"device": "sdc"})
    assert ok is True and info["device"] == "sdc"
    assert seen["cmd"] == ["systemctl", "start", "droplet-storage-pool-apply.service"]
