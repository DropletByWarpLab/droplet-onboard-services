"""Hermetic tests for the NVR storage ROOT executor (WARP-3514 section 3.1).

scripts/host/droplet-nvr-storage-apply.sh is the ExecStart of the root oneshot
droplet-nvr-storage-apply.service. The sandboxed device-bridge spools ONE
request ({request_id, operation, params}) into its own StateDirectory and
starts that unit; this script consumes the request as root, runs the NVR writer
(droplet-set-nvr-media.sh) and writes a result file the bridge reads back.
Same split as droplet-storage-pool-apply.sh, and the same exit-code contract:

  * exit 0 once a request was consumed and a result written, REGARDLESS of the
    writer's own rc -- a refusal must not leave a failed unit behind;
  * non-zero ONLY for executor-level breakage: no request, malformed request,
    unknown operation (and a handful of tamper cases that are the same class).

What carries the weight here is the trust boundary. request.json lives in a
droplet-writable directory, so for a ROOT script it is UNTRUSTED input
(WARP-843 invariant): every param is re-validated (UUID regex, mode enum,
integer range) BEFORE the writer is exec'd, the writer is exec'd with an argv
ARRAY (never a shell string, never eval), and a request that fails validation
is turned into a synthesized refusal -- the writer never runs. The mutation
tests at the bottom prove the validators are load-bearing rather than decor.

Driven via subprocess with DROPLET_NVR_SPOOL_DIR / DROPLET_NVR_WRITER pointed
at a tmp spool and a recording stub, so nothing here needs root, a block
device or a real writer. Skipped automatically if bash isn't on PATH.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
from _topology_lock_test_support import add_trusted_stat_env

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "host" / "droplet-nvr-storage-apply.sh"
UNIT = (REPO_ROOT / "services" / "oled-display"
        / "droplet-nvr-storage-apply.service")
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")

# Symlink / FIFO / mode / chown semantics are POSIX-shaped; on a Windows
# checkout those fixtures would error in setup rather than exercise the script.
posix_only = pytest.mark.skipif(os.name == "nt", reason="POSIX-only fixture")
root_only = pytest.mark.skipif(
    not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="needs root to chown the spool dir to a foreign uid")

FS_UUID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"

# Stand-in for droplet-set-nvr-media.sh. Records its argv (first line = argc)
# and replays canned stdout/stderr/rc from the environment, so one stub serves
# every scenario and no path ever has to be spliced into shell source.
WRITER_STUB = """#!/usr/bin/env bash
{ printf '%s\\n' "$#"; for a in "$@"; do printf '%s\\n' "$a"; done; } > "$WRITER_ARGV_LOG"
printf '%s' "${WRITER_STDOUT:-}"
[ -z "${WRITER_STDERR:-}" ] || printf '%s\\n' "$WRITER_STDERR" >&2
exit "${WRITER_RC:-0}"
"""


class Rig:
    """A tmp spool dir + recording writer stub + the env to drive the script."""

    def __init__(self, tmp_path: Path):
        # Several rigs may live under one test's tmp_path (one per scenario),
        # so each creates its own root.
        self.tmp = tmp_path
        self.tmp.mkdir(parents=True, exist_ok=True)
        self.spool = tmp_path / "spool"
        self.spool.mkdir()
        self.writer = tmp_path / "writer-stub.sh"
        self.writer.write_text(WRITER_STUB, encoding="utf-8", newline="\n")
        os.chmod(self.writer, 0o700)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions -- owner-only executable fixture in a private pytest temporary directory; subprocess execution requires the owner's execute bit
        self.argv_log = tmp_path / "writer-argv.txt"
        self.topology_lock = tmp_path / "recordings-topology.lock"
        self.topology_lock.touch()
        # Created ONLY if an injected payload actually got executed.
        self.sentinel = tmp_path / "SENTINEL"

    # -- request ---------------------------------------------------------
    def request(self, operation="apply", params=None, request_id="req-test-1",
                raw: str | None = None):
        if raw is not None:
            (self.spool / "request.json").write_text(raw, encoding="utf-8")
            return
        body = {"request_id": request_id, "operation": operation}
        if params is not None:
            body["params"] = params
        (self.spool / "request.json").write_text(json.dumps(body),
                                                 encoding="utf-8")

    # -- run -------------------------------------------------------------
    def env(self, **extra) -> dict:
        env = dict(os.environ)
        env.update({
            "DROPLET_NVR_SPOOL_DIR": str(self.spool),
            "DROPLET_NVR_WRITER": str(self.writer),
            "DROPLET_STORAGE_TOPOLOGY_LOCK_FILE": str(self.topology_lock),
            "WRITER_ARGV_LOG": str(self.argv_log),
        })
        env.update({k: str(v) for k, v in extra.items()})
        return add_trusted_stat_env(env, self.tmp / "bin", self.topology_lock)

    def run(self, script: Path = SCRIPT, **env_extra):
        return subprocess.run([BASH, str(script)], env=self.env(**env_extra),
                              capture_output=True, text=True, timeout=30)

    # -- observations ----------------------------------------------------
    def writer_args(self):
        """The argv the writer saw, or None when it never ran."""
        if not self.argv_log.exists():
            return None
        argc, *args = self.argv_log.read_text(encoding="utf-8").splitlines()
        assert int(argc) == len(args), "an argument was split or merged"
        return args

    def result(self) -> dict:
        return json.loads((self.spool / "result.json").read_text())

    def request_left(self) -> bool:
        return (self.spool / "request.json").exists()

    def assert_refused_bad_request(self, proc):
        """The request was syntactically fine but carried an invalid param:
        it must surface as the writer's own refusal contract, exit 0, and the
        writer must never have been exec'd."""
        assert proc.returncode == 0, proc.stderr
        res = self.result()
        assert res["rc"] == 1
        refusal = json.loads(res["stdout"])
        assert refusal["ok"] is False
        assert refusal["code"] == "bad_request"
        assert isinstance(refusal["message"], str) and refusal["message"]
        assert "droplet-nvr-storage-apply" in res["stderr"]
        assert not self.request_left(), "the request must still be consumed"
        assert self.writer_args() is None, "writer ran on a refused request"
        assert not self.sentinel.exists(), "an injected payload executed"
        return res


# --------------------------------------------------------------------------
# Shape
# --------------------------------------------------------------------------

def test_script_exists_and_is_bash():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    first = SCRIPT.read_text(encoding="utf-8").splitlines()[0]
    assert first == "#!/usr/bin/env bash"


def test_script_is_strict_lf_and_parses():
    data = SCRIPT.read_bytes()
    assert b"\r" not in data, "CRLF line endings"
    assert b"set -euo pipefail" in data
    proc = subprocess.run([BASH, "-n", str(SCRIPT)], capture_output=True,
                          text=True)
    assert proc.returncode == 0, proc.stderr


@pytest.mark.skipif(shutil.which("shellcheck") is None,
                    reason="shellcheck not installed")
def test_script_is_shellcheck_clean():
    proc = subprocess.run(["shellcheck", "--severity=warning", str(SCRIPT)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_script_never_evals_or_builds_shell_strings():
    """The request is untrusted: nothing may be re-parsed by a shell."""
    code = [ln for ln in SCRIPT.read_text(encoding="utf-8").splitlines()
            if not ln.lstrip().startswith("#")]
    body = "\n".join(code)
    assert not re.search(r"(^|[\s;&|(])eval(\s|$)", body), "eval in script"
    assert not re.search(r"\b(bash|sh)\s+-c\b", body), "shell -c in script"
    assert "while true" not in body


def test_script_pins_the_contract_paths_and_hooks():
    body = SCRIPT.read_text(encoding="utf-8")
    assert "/var/lib/droplet-bridge/nvr-spool" in body
    assert "/usr/local/sbin/droplet-set-nvr-media.sh" in body
    assert "DROPLET_NVR_SPOOL_DIR" in body
    assert "DROPLET_NVR_WRITER" in body


# --------------------------------------------------------------------------
# Happy paths: the writer argv is built exactly, as an array
# --------------------------------------------------------------------------

def test_apply_reserved_builds_the_exact_writer_argv(tmp_path):
    rig = Rig(tmp_path)
    rig.request("apply", {"fsUuid": FS_UUID, "mode": "reserved",
                          "limitBytes": 123456789})
    proc = rig.run(WRITER_STDOUT='{"ok":true,"operation":"apply"}')
    assert proc.returncode == 0, proc.stderr
    assert rig.writer_args() == [
        "--apply", "--fs-uuid", FS_UUID, "--mode", "reserved",
        "--limit-bytes", "123456789"]
    assert rig.result() == {
        "request_id": "req-test-1", "rc": 0,
        "stdout": '{"ok":true,"operation":"apply"}', "stderr": ""}
    # The request was consumed -- it must never be re-applied.
    assert not rig.request_left()


@posix_only
def test_apply_refuses_while_shared_topology_lock_is_held(tmp_path):
    import fcntl

    rig = Rig(tmp_path)
    rig.request("apply", {"fsUuid": FS_UUID, "mode": "full"})
    fd = os.open(rig.topology_lock, os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        proc = rig.run()
    finally:
        os.close(fd)

    assert proc.returncode == 0, proc.stderr
    result = rig.result()
    assert result["rc"] == 1
    assert json.loads(result["stdout"])["code"] == "busy"
    assert rig.writer_args() is None, "writer ran while topology was locked"
    assert not rig.request_left()


def test_apply_full_never_forwards_a_limit(tmp_path):
    """`full` means limit = filesystem size, computed by the writer. A limit
    smuggled alongside must not be forwarded, nor may unknown keys."""
    rig = Rig(tmp_path)
    rig.request("apply", {"fsUuid": FS_UUID, "mode": "full",
                          "limitBytes": 5000, "evil": "--rm-rf"})
    proc = rig.run()
    assert proc.returncode == 0, proc.stderr
    assert rig.writer_args() == ["--apply", "--fs-uuid", FS_UUID,
                                 "--mode", "full"]


@pytest.mark.parametrize("params", [
    {"fsUuid": FS_UUID, "mode": "full"},
    {"fsUuid": FS_UUID, "mode": "full", "limitBytes": None},
], ids=["absent", "null"])
def test_apply_full_accepts_an_absent_or_null_limit(tmp_path, params):
    rig = Rig(tmp_path)
    rig.request("apply", params)
    proc = rig.run()
    assert proc.returncode == 0, proc.stderr
    assert rig.writer_args() == ["--apply", "--fs-uuid", FS_UUID,
                                 "--mode", "full"]


def test_resize_builds_the_exact_writer_argv(tmp_path):
    rig = Rig(tmp_path)
    rig.request("resize", {"limitBytes": 987654321})
    proc = rig.run(WRITER_STDOUT='{"ok":true,"operation":"resize"}')
    assert proc.returncode == 0, proc.stderr
    assert rig.writer_args() == ["--resize", "987654321"]
    assert rig.result()["rc"] == 0
    assert not rig.request_left()


@pytest.mark.parametrize("limit", [1, 2 ** 62], ids=["lower-bound", "upper-bound"])
def test_limit_boundaries_are_accepted(tmp_path, limit):
    rig = Rig(tmp_path)
    rig.request("resize", {"limitBytes": limit})
    proc = rig.run()
    assert proc.returncode == 0, proc.stderr
    assert rig.writer_args() == ["--resize", str(limit)]


def test_uppercase_and_short_uuids_within_the_regex_are_accepted(tmp_path):
    """The contract regex is ^[0-9A-Fa-f][0-9A-Fa-f-]{6,35}$ -- a 7-char and a
    36-char value are both legal (ext4 short serials, full RFC 4122)."""
    for uuid in ("ABCDEF1", "A" * 36, "1234-ABCD"):
        rig = Rig(tmp_path / uuid)
        rig.request("apply", {"fsUuid": uuid, "mode": "full"})
        proc = rig.run()
        assert proc.returncode == 0, proc.stderr
        assert rig.writer_args()[2] == uuid


# --------------------------------------------------------------------------
# The writer's rc/stdout/stderr travel in result.json; refusals exit 0
# --------------------------------------------------------------------------

def test_writer_refusal_travels_in_result_with_exit_zero(tmp_path):
    """A refusal is the OP failing, not the executor: rc/stdout/stderr go into
    result.json and the unit exits 0 so it does not land in `failed` on every
    refused apply."""
    rig = Rig(tmp_path)
    rig.request("apply", {"fsUuid": FS_UUID, "mode": "full"})
    refusal = '{"ok":false,"code":"os_disk","message":"that is the OS disk"}'
    proc = rig.run(WRITER_RC=1, WRITER_STDOUT=refusal,
                   WRITER_STDERR="droplet-set-nvr-media: that is the OS disk")
    assert proc.returncode == 0, proc.stderr
    res = rig.result()
    assert res["rc"] == 1
    assert json.loads(res["stdout"])["code"] == "os_disk"
    assert "OS disk" in res["stderr"]
    assert not rig.request_left()


def test_writer_streams_are_captured_verbatim_including_unicode(tmp_path):
    rig = Rig(tmp_path)
    rig.request("resize", {"limitBytes": 4096})
    proc = rig.run(WRITER_RC=7, WRITER_STDOUT="line1\nline2 — café",
                   WRITER_STDERR="boom ü")
    assert proc.returncode == 0, proc.stderr
    res = rig.result()
    assert res["rc"] == 7
    assert res["stdout"] == "line1\nline2 — café"
    assert res["stderr"] == "boom ü\n"


def test_missing_writer_surfaces_as_a_nonzero_rc_not_a_crash(tmp_path):
    """Executor wiring broken (writer not installed): the bridge still gets an
    honest result instead of a hung start."""
    rig = Rig(tmp_path)
    rig.request("resize", {"limitBytes": 4096})
    proc = rig.run(DROPLET_NVR_WRITER=str(tmp_path / "no-such-writer"))
    assert proc.returncode == 0, proc.stderr
    assert rig.result()["rc"] != 0
    assert not rig.request_left()


def test_no_temp_files_are_left_behind(tmp_path):
    rig = Rig(tmp_path)
    rig.request("resize", {"limitBytes": 4096})
    assert rig.run().returncode == 0
    assert sorted(p.name for p in rig.spool.iterdir()) == ["result.json"]


# --------------------------------------------------------------------------
# Hardened result write (PR #554 class): 0600, owned like the spool, and a
# planted symlink is never followed
# --------------------------------------------------------------------------

@posix_only
def test_result_is_private_to_its_owner(tmp_path):
    rig = Rig(tmp_path)
    rig.request("resize", {"limitBytes": 4096})
    assert rig.run().returncode == 0
    mode = stat.S_IMODE(os.stat(rig.spool / "result.json").st_mode)
    assert mode == 0o600, oct(mode)


@posix_only
@root_only
def test_result_is_chowned_to_the_spool_directorys_owner(tmp_path):
    """The bridge runs as `droplet` and must be able to read the result back;
    the root script chowns it through the fd to whoever owns the spool."""
    rig = Rig(tmp_path)
    os.chown(rig.spool, 4242, 4343)
    rig.request("resize", {"limitBytes": 4096})
    assert rig.run().returncode == 0
    st = os.stat(rig.spool / "result.json")
    assert (st.st_uid, st.st_gid) == (4242, 4343)


@posix_only
def test_a_preplanted_tmp_symlink_is_never_followed(tmp_path):
    """The spool dir is droplet-owned and the temp name is fixed. A planted
    result.json.tmp -> <root-owned file> must not turn the root write into an
    arbitrary-file clobber."""
    rig = Rig(tmp_path)
    victim = tmp_path / "victim.txt"
    victim.write_text("do not touch")
    os.symlink(victim, rig.spool / "result.json.tmp")
    rig.request("resize", {"limitBytes": 4096})
    proc = rig.run()
    assert proc.returncode == 0, proc.stderr
    assert victim.read_text() == "do not touch"
    assert rig.result()["rc"] == 0
    assert not (rig.spool / "result.json.tmp").exists()


@posix_only
def test_a_preplanted_result_symlink_is_replaced_not_followed(tmp_path):
    rig = Rig(tmp_path)
    victim = tmp_path / "victim.txt"
    victim.write_text("do not touch")
    os.symlink(victim, rig.spool / "result.json")
    rig.request("resize", {"limitBytes": 4096})
    proc = rig.run()
    assert proc.returncode == 0, proc.stderr
    assert victim.read_text() == "do not touch"
    assert not (rig.spool / "result.json").is_symlink()
    assert rig.result()["rc"] == 0


# --------------------------------------------------------------------------
# Executor-level breakage: non-zero, NO result, writer never runs
# --------------------------------------------------------------------------

def _assert_executor_breakage(rig: Rig, proc, needle: str):
    assert proc.returncode != 0, "must fail the unit honestly"
    assert needle in proc.stderr, proc.stderr
    assert not (rig.spool / "result.json").exists()
    assert rig.writer_args() is None
    assert not rig.sentinel.exists()


def test_no_spooled_request_is_executor_level_breakage(tmp_path):
    rig = Rig(tmp_path)
    _assert_executor_breakage(rig, rig.run(), "no spooled request")


def test_missing_spool_directory_is_the_same_breakage(tmp_path):
    rig = Rig(tmp_path)
    shutil.rmtree(rig.spool)
    _assert_executor_breakage(rig, rig.run(), "no spooled request")


@pytest.mark.parametrize("raw", ["{not json", "", "[]", '"a string"', "42",
                                 "null", '{"request_id": "r1"'],
                         ids=["truncated", "empty", "array", "string",
                              "number", "null", "unterminated"])
def test_malformed_request_is_executor_level_breakage(tmp_path, raw):
    rig = Rig(tmp_path)
    rig.request(raw=raw)
    proc = rig.run()
    _assert_executor_breakage(rig, proc, "malformed")
    # Fail-closed: the bad request is left for inspection.
    assert rig.request_left()


@pytest.mark.parametrize("operation", [
    "migrate", "delete_old", "pool_create", "Apply", "apply ", "apply\n",
    "apply;reboot", "../apply", "$(touch {sentinel})", "rm -rf /", 7, ["apply"],
])
def test_unknown_operation_is_executor_level_breakage(tmp_path, operation):
    rig = Rig(tmp_path)
    if isinstance(operation, str):
        operation = operation.format(sentinel=rig.sentinel)
    rig.request(operation, {"fsUuid": FS_UUID, "mode": "full",
                            "limitBytes": 1000})
    proc = rig.run()
    assert proc.returncode != 0
    assert "operation" in proc.stderr, proc.stderr
    assert not (rig.spool / "result.json").exists()
    assert rig.writer_args() is None
    assert not rig.sentinel.exists()
    assert rig.request_left()


def test_request_without_an_operation_is_refused(tmp_path):
    rig = Rig(tmp_path)
    rig.request(raw=json.dumps({"request_id": "r1", "params": {}}))
    _assert_executor_breakage(rig, rig.run(), "no operation")


@pytest.mark.parametrize("request_id", [
    None, "", 12345, ["r1"], "has space", "line\nbreak", "semi;colon",
    "x" * 129, "$(id)", "../r1",
], ids=["null", "empty", "int", "list", "space", "newline", "semicolon",
        "too-long", "subshell", "traversal"])
def test_a_request_id_that_cannot_be_echoed_safely_is_refused(tmp_path, request_id):
    """request_id is echoed into the result and the journal; anything outside
    a conservative charset is breakage (the bridge could not correlate it)."""
    rig = Rig(tmp_path)
    rig.request(raw=json.dumps({
        "request_id": request_id, "operation": "resize",
        "params": {"limitBytes": 4096}}))
    proc = rig.run()
    assert proc.returncode != 0
    assert "malformed" in proc.stderr
    assert not (rig.spool / "result.json").exists()
    assert rig.writer_args() is None


def test_an_oversized_request_is_refused(tmp_path):
    rig = Rig(tmp_path)
    rig.request("resize", {"limitBytes": 4096, "pad": "x" * 70000})
    proc = rig.run()
    _assert_executor_breakage(rig, proc, "malformed")


@posix_only
def test_a_symlinked_request_is_refused_even_if_its_target_is_valid(tmp_path):
    rig = Rig(tmp_path)
    real = tmp_path / "elsewhere.json"
    real.write_text(json.dumps({"request_id": "r1", "operation": "resize",
                                "params": {"limitBytes": 4096}}))
    os.symlink(real, rig.spool / "request.json")
    proc = rig.run()
    assert proc.returncode != 0
    assert "symlink" in proc.stderr
    assert not (rig.spool / "result.json").exists()
    assert rig.writer_args() is None


@posix_only
def test_a_symlinked_spool_directory_is_refused(tmp_path):
    """Root writes result.json into the spool dir; if the droplet user could
    swap that directory for a symlink, root would write into any directory it
    points at."""
    rig = Rig(tmp_path)
    real = tmp_path / "real-spool"
    real.mkdir()
    (real / "request.json").write_text(json.dumps({
        "request_id": "r1", "operation": "resize",
        "params": {"limitBytes": 4096}}))
    link = tmp_path / "spool-link"
    os.symlink(real, link)
    proc = rig.run(DROPLET_NVR_SPOOL_DIR=str(link))
    assert proc.returncode != 0
    assert "symlink" in proc.stderr
    assert sorted(p.name for p in real.iterdir()) == ["request.json"]
    assert rig.writer_args() is None


@posix_only
def test_a_fifo_in_place_of_the_request_cannot_hang_the_unit(tmp_path):
    rig = Rig(tmp_path)
    os.mkfifo(rig.spool / "request.json")
    proc = rig.run()  # subprocess timeout would raise if it blocked
    assert proc.returncode != 0
    assert "droplet-nvr-storage-apply" in proc.stderr, proc.stderr
    assert not (rig.spool / "result.json").exists()


# --------------------------------------------------------------------------
# UNTRUSTED params: every invalid value becomes a synthesized refusal and the
# writer is never exec'd
# --------------------------------------------------------------------------

BAD_FS_UUIDS = [
    pytest.param(None, id="null"),
    pytest.param("", id="empty"),
    pytest.param("abcdef", id="six-chars"),
    pytest.param("a" * 37, id="thirty-seven-chars"),
    pytest.param("abcdefg1", id="non-hex"),
    pytest.param("-abcdef12", id="leading-dash"),
    pytest.param("abcdef12\n", id="trailing-newline"),
    pytest.param("abcdef12 --mode full", id="smuggled-argv"),
    pytest.param("abcdef12; touch {sentinel}", id="semicolon-cmd"),
    pytest.param("$(touch {sentinel})", id="command-subst"),
    pytest.param("`touch {sentinel}`", id="backtick"),
    pytest.param("abcdef12|touch {sentinel}", id="pipe"),
    pytest.param("../../etc/passwd", id="traversal"),
    pytest.param("/dev/sda1", id="device-path"),
    pytest.param("ａｂｃｄｅｆ１２",
                 id="fullwidth-unicode"),
    pytest.param(123456789, id="int"),
    pytest.param(["abcdef12"], id="list"),
    pytest.param({"a": 1}, id="object"),
    pytest.param(True, id="bool"),
]


def _format(value, rig: Rig):
    return value.format(sentinel=rig.sentinel) if isinstance(value, str) else value


@pytest.mark.parametrize("bad", BAD_FS_UUIDS)
def test_invalid_fs_uuid_is_refused_before_the_writer(tmp_path, bad):
    rig = Rig(tmp_path)
    rig.request("apply", {"fsUuid": _format(bad, rig), "mode": "reserved",
                          "limitBytes": 1000})
    rig.assert_refused_bad_request(rig.run())


def test_missing_fs_uuid_is_refused(tmp_path):
    rig = Rig(tmp_path)
    rig.request("apply", {"mode": "reserved", "limitBytes": 1000})
    rig.assert_refused_bad_request(rig.run())


BAD_MODES = [
    pytest.param(None, id="null"),
    pytest.param("", id="empty"),
    pytest.param("RESERVED", id="uppercase"),
    pytest.param("reserved ", id="trailing-space"),
    pytest.param("full\n", id="trailing-newline"),
    pytest.param("auto_reserved", id="api-enum-not-cli-enum"),
    pytest.param("reserved; touch {sentinel}", id="semicolon-cmd"),
    pytest.param(["reserved"], id="list"),
    pytest.param(1, id="int"),
    pytest.param(True, id="bool"),
]


@pytest.mark.parametrize("bad", BAD_MODES)
def test_invalid_mode_is_refused_before_the_writer(tmp_path, bad):
    rig = Rig(tmp_path)
    rig.request("apply", {"fsUuid": FS_UUID, "mode": _format(bad, rig),
                          "limitBytes": 1000})
    rig.assert_refused_bad_request(rig.run())


def test_missing_mode_is_refused(tmp_path):
    rig = Rig(tmp_path)
    rig.request("apply", {"fsUuid": FS_UUID, "limitBytes": 1000})
    rig.assert_refused_bad_request(rig.run())


BAD_LIMITS = [
    pytest.param(None, id="null"),
    pytest.param(0, id="zero"),
    pytest.param(-1, id="negative"),
    pytest.param(2 ** 62 + 1, id="above-2^62"),
    pytest.param(10 ** 30, id="huge"),
    pytest.param(True, id="bool-true"),
    pytest.param(False, id="bool-false"),
    pytest.param(1.5, id="float"),
    pytest.param(1000.0, id="integral-float"),
    pytest.param(float("nan"), id="nan"),
    pytest.param(float("inf"), id="infinity"),
    pytest.param("1000", id="numeric-string"),
    pytest.param("1; touch {sentinel}", id="string-cmd"),
    pytest.param([1000], id="list"),
    pytest.param({"v": 1000}, id="object"),
]


@pytest.mark.parametrize("bad", BAD_LIMITS)
def test_invalid_limit_is_refused_for_reserved(tmp_path, bad):
    rig = Rig(tmp_path)
    rig.request("apply", {"fsUuid": FS_UUID, "mode": "reserved",
                          "limitBytes": _format(bad, rig)})
    rig.assert_refused_bad_request(rig.run())


def test_a_missing_limit_is_refused_for_reserved(tmp_path):
    rig = Rig(tmp_path)
    rig.request("apply", {"fsUuid": FS_UUID, "mode": "reserved"})
    rig.assert_refused_bad_request(rig.run())


@pytest.mark.parametrize("bad", [b for b in BAD_LIMITS if b.values[0] is not None])
def test_a_present_but_junk_limit_is_refused_even_for_full(tmp_path, bad):
    """`full` ignores a VALID limit; a present-but-junk one still says the
    caller is not our bridge, so it is refused rather than silently dropped."""
    rig = Rig(tmp_path)
    rig.request("apply", {"fsUuid": FS_UUID, "mode": "full",
                          "limitBytes": _format(bad, rig)})
    rig.assert_refused_bad_request(rig.run())


@pytest.mark.parametrize("bad", BAD_LIMITS)
def test_invalid_limit_is_refused_for_resize(tmp_path, bad):
    rig = Rig(tmp_path)
    rig.request("resize", {"limitBytes": _format(bad, rig)})
    rig.assert_refused_bad_request(rig.run())


@pytest.mark.parametrize("params", [None, [], "limitBytes", 5, {}],
                         ids=["absent", "list", "string", "int", "empty-object"])
def test_resize_without_usable_params_is_refused(tmp_path, params):
    rig = Rig(tmp_path)
    rig.request("resize", params)
    rig.assert_refused_bad_request(rig.run())


@pytest.mark.parametrize("params", [None, [], "x", 5, {}],
                         ids=["absent", "list", "string", "int", "empty-object"])
def test_apply_without_usable_params_is_refused(tmp_path, params):
    rig = Rig(tmp_path)
    rig.request("apply", params)
    rig.assert_refused_bad_request(rig.run())


def test_the_refusal_never_echoes_the_hostile_value(tmp_path):
    """The message lands in the journal and in the owner-facing error text."""
    rig = Rig(tmp_path)
    payload = f"zz; touch {rig.sentinel}"
    rig.request("apply", {"fsUuid": payload, "mode": "full"})
    proc = rig.run()
    res = rig.assert_refused_bad_request(proc)
    assert "touch" not in res["stdout"] + res["stderr"] + proc.stderr


def test_a_hostile_payload_cannot_run_a_command_through_any_param(tmp_path):
    """Belt and braces for the headline claim: whichever field carries the
    payload, nothing is ever evaluated by a shell."""
    for field in ("fsUuid", "mode", "limitBytes"):
        rig = Rig(tmp_path / field)
        params = {"fsUuid": FS_UUID, "mode": "reserved", "limitBytes": 1000}
        params[field] = f"$(touch {rig.sentinel}) `touch {rig.sentinel}`"
        rig.request("apply", params)
        rig.assert_refused_bad_request(rig.run())


# --------------------------------------------------------------------------
# Mutation checks -- prove the validators are load-bearing, not decorative
# --------------------------------------------------------------------------

def _mutant(tmp_path: Path, needle: str, replacement: str) -> Path:
    src = SCRIPT.read_text(encoding="utf-8")
    assert needle in src, f"validator shape changed - update this test: {needle}"
    mutated = tmp_path / "mutated.sh"
    mutated.write_text(src.replace(needle, replacement), encoding="utf-8",
                       newline="\n")
    (tmp_path / "droplet-storage-topology-lock.sh").write_text(
        (REPO_ROOT / "scripts" / "host" / "droplet-storage-topology-lock.sh").read_text(
            encoding="utf-8"), encoding="utf-8", newline="\n")
    return mutated


def test_mutation_removing_the_uuid_regex_lets_a_hostile_uuid_reach_the_writer(tmp_path):
    needle = 'UUID_RE = re.compile(r"[0-9A-Fa-f][0-9A-Fa-f-]{6,35}")'
    mutated = _mutant(tmp_path, needle, 'UUID_RE = re.compile(r".+", re.S)')
    hostile = "abcdef12 --mode full; $(id)"
    real = Rig(tmp_path / "real")
    real.request("apply", {"fsUuid": hostile, "mode": "full"})
    real.assert_refused_bad_request(real.run())

    mut = Rig(tmp_path / "mut")
    mut.request("apply", {"fsUuid": hostile, "mode": "full"})
    proc = mut.run(script=mutated)
    assert proc.returncode == 0, proc.stderr
    args = mut.writer_args()
    assert args is not None, (
        "mutant should have forwarded the hostile uuid; if it did not, the "
        "regex is not what stops it")
    # ...and even then the value stays ONE argv element: the array boundary is
    # the second line of defence behind the regex.
    assert args == ["--apply", "--fs-uuid", hostile, "--mode", "full"]


def test_mutation_widening_the_limit_range_lets_an_oversized_limit_through(tmp_path):
    mutated = _mutant(tmp_path, "MAX_LIMIT = 2 ** 62", "MAX_LIMIT = 2 ** 200")
    oversized = 2 ** 62 + 1
    real = Rig(tmp_path / "real")
    real.request("resize", {"limitBytes": oversized})
    real.assert_refused_bad_request(real.run())

    mut = Rig(tmp_path / "mut")
    mut.request("resize", {"limitBytes": oversized})
    proc = mut.run(script=mutated)
    assert proc.returncode == 0, proc.stderr
    assert mut.writer_args() == ["--resize", str(oversized)]


def test_mutation_removing_the_mode_enum_lets_an_arbitrary_mode_through(tmp_path):
    mutated = _mutant(tmp_path, 'MODES = ("reserved", "full")',
                      'MODES = ("reserved", "full", "reserved; reboot")')
    real = Rig(tmp_path / "real")
    real.request("apply", {"fsUuid": FS_UUID, "mode": "reserved; reboot",
                           "limitBytes": 1000})
    real.assert_refused_bad_request(real.run())

    mut = Rig(tmp_path / "mut")
    mut.request("apply", {"fsUuid": FS_UUID, "mode": "reserved; reboot",
                          "limitBytes": 1000})
    assert mut.run(script=mutated).returncode == 0
    assert mut.writer_args() == ["--apply", "--fs-uuid", FS_UUID,
                                 "--mode", "reserved; reboot"]


# --------------------------------------------------------------------------
# The systemd unit
# --------------------------------------------------------------------------

def _parse_unit(path: Path) -> dict[str, list[tuple[str, str]]]:
    sections: dict[str, list[tuple[str, str]]] = {}
    current = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1]
            sections.setdefault(current, [])
            continue
        key, _, value = line.partition("=")
        assert current is not None, f"directive outside a section: {raw}"
        sections[current].append((key.strip(), value.strip()))
    return sections


def _values(unit, section, key):
    return [v for k, v in unit.get(section, []) if k == key]


def _comments(path: Path) -> str:
    return "\n".join(ln.strip().lstrip("#; ").strip()
                     for ln in path.read_text(encoding="utf-8").splitlines()
                     if ln.strip().startswith(("#", ";")))


def test_unit_file_exists_and_is_lf():
    assert UNIT.exists(), f"missing {UNIT}"
    assert b"\r" not in UNIT.read_bytes()


def test_unit_runs_the_installed_script_as_a_oneshot():
    unit = _parse_unit(UNIT)
    assert _values(unit, "Service", "Type") == ["oneshot"]
    assert _values(unit, "Service", "ExecStart") == [
        "/usr/local/sbin/droplet-nvr-storage-apply.sh"]


def test_unit_times_out_before_the_bridge_gives_up():
    """The bridge blocks on `systemctl start` for 125 s; systemd must fail the
    unit first so the bridge gets an answer instead of its own timeout."""
    unit = _parse_unit(UNIT)
    assert _values(unit, "Service", "TimeoutStartSec") == ["110"]


def test_unit_carries_the_repo_root_placeholder_and_a_known_good_path():
    unit = _parse_unit(UNIT)
    env = _values(unit, "Service", "Environment")
    assert "REPO_ROOT=@REPO_ROOT@" in env
    path = [v for v in env if v.startswith("PATH=")]
    assert len(path) == 1
    assert "/usr/local/sbin" in path[0].split("=", 1)[1].split(":")
    # The installer's sed must leave no placeholder behind.
    rendered = UNIT.read_text(encoding="utf-8").replace(
        "@REPO_ROOT@", "/home/droplet/edge-platform")
    assert "@REPO_ROOT@" not in rendered
    assert "REPO_ROOT=/home/droplet/edge-platform" in rendered


def test_unit_is_on_demand_only_with_no_install_section():
    unit = _parse_unit(UNIT)
    assert "Install" not in unit, "this unit must never be enabled"


def test_unit_has_the_safe_hardening_subset():
    unit = _parse_unit(UNIT)
    svc = dict(unit["Service"])
    for key, want in [
        ("PrivateNetwork", "true"), ("ProtectKernelTunables", "true"),
        ("ProtectKernelModules", "true"), ("ProtectKernelLogs", "true"),
        ("ProtectControlGroups", "true"), ("RestrictAddressFamilies", "AF_UNIX"),
        ("LockPersonality", "true"), ("RestrictRealtime", "true"),
    ]:
        assert svc.get(key) == want, f"{key}={want} missing"


def test_unit_omits_the_directives_that_would_break_it_and_says_why():
    """ProtectHome would hide <repo>/.env (under /home), ProtectSystem would
    make the bay mounts and /var/lib state read-only, PrivateDevices would hide
    the block devices the writer's quota ioctl needs. None may be present as a
    directive, and the unit must explain the omission so nobody 'fixes' it."""
    unit = _parse_unit(UNIT)
    keys = {k for _, kv in unit.items() for k, _v in kv}
    assert not keys & {"ProtectHome", "ProtectSystem", "PrivateDevices"}
    why = _comments(UNIT)
    for name in ("ProtectHome", "ProtectSystem", "PrivateDevices"):
        assert name in why, f"the unit does not explain why {name} is absent"


def test_unit_never_loads_an_environment_file():
    """A droplet-writable EnvironmentFile on a root unit is the WARP-843 LPE;
    this unit needs none (the repo .env is read by the writer, not loaded)."""
    unit = _parse_unit(UNIT)
    assert not _values(unit, "Service", "EnvironmentFile")


def test_unit_has_no_hard_dependencies():
    unit = _parse_unit(UNIT)
    keys = {k for _, kv in unit.items() for k, _v in kv}
    assert not keys & {"Requires", "BindsTo", "PartOf", "Requisite"}
