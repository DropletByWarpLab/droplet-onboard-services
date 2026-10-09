"""Kernel isolation tests run in the real child, never seal the pytest process."""
import base64
import sys

import pytest

from main import AnalysisRequest, run_transform

REAL_GLOBALS = "g = emit_csv.__func__.__globals__\n"
REAL_OPEN = REAL_GLOBALS + "real_open = g['sys'].modules['builtins'].open\n"
LIBC = REAL_GLOBALS + "c = g['seal_analysis'].__globals__['ctypes']\nlibc = c.CDLL(None, use_errno=True)\n"


def execute(code, inputs=None):
    return run_transform(AnalysisRequest(code=code, inputs=inputs or {}), True)


@pytest.mark.skipif(sys.platform.startswith("linux"), reason="unsupported-platform refusal is for non-Linux hosts")
def test_unsupported_host_fails_closed_before_code_executes():
    result = execute("output='unsafe execution happened'")
    assert "requires Linux with Landlock" in result["error"]
    assert "output" not in result


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real Landlock/seccomp filesystem tests require Linux")
def test_object_introspection_escape_cannot_read_or_list_another_workspace(tmp_path):
    private = tmp_path / "other-users-workspace"
    private.mkdir()
    secret = private / "credential.txt"
    secret.write_text("another persons private data")
    result = execute(REAL_OPEN + "output = real_open(inputs['secret']).read()", {"secret": str(secret)})
    assert "PermissionError" in result["error"] and "output" not in result
    result = execute(REAL_GLOBALS + "output=g['sys'].modules['os'].listdir(inputs['workspace'])", {"workspace": str(private)})
    assert "PermissionError" in result["error"]


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real path metadata/O_PATH denial requires Linux")
def test_object_introspection_escape_cannot_inspect_known_path_metadata(tmp_path):
    private = tmp_path / "another-workspace"
    private.mkdir()
    secret = private / "secret.txt"
    secret.write_text("private size and timestamps")
    link = tmp_path / "private-link"
    link.symlink_to(secret)
    prefix = REAL_GLOBALS + "os=g['sys'].modules['os']\n"
    for code, path in [
        ("output=os.stat(inputs['path']).st_size", secret),
        ("output=os.lstat(inputs['path']).st_mtime_ns", link),
        ("output=os.readlink(inputs['path'])", link),
        ("output=os.open(inputs['path'], os.O_PATH)", secret),
        ("os.chdir(inputs['path'])\noutput=os.getcwd()", private),
    ]:
        result = execute(prefix + code, {"path": str(path)})
        assert "PermissionError" in result["error"] and "output" not in result, result
    result = execute(prefix + "output=os.access(inputs['path'], os.F_OK)", {"path": str(secret)})
    assert result["output"] is False


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real native metadata syscall denial requires Linux")
def test_native_introspection_cannot_bypass_metadata_filter_with_statx_or_openat2(tmp_path):
    import platform

    secret = tmp_path / "private-file"
    secret.write_text("private metadata")
    statx = 332 if platform.machine().lower() in ("x86_64", "amd64") else 291
    code = LIBC + "path=c.create_string_buffer(inputs['path'].encode())\nbuf=c.create_string_buffer(256)\n"
    code += f"output=[libc.syscall({statx},-100,path,0,0xFFF,buf),c.get_errno(),libc.syscall(437,-100,path,0,0),c.get_errno()]"
    result = execute(code, {"path": str(secret)})
    assert result["output"] == [-1, 13, -1, 13]


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real file metadata mutation denial requires Linux")
def test_native_escape_cannot_change_another_workspaces_metadata_or_truncate_its_file(tmp_path):
    secret = tmp_path / "other-person-file"
    secret.write_text("leave this person's data alone")
    before = secret.stat()
    prefix = REAL_GLOBALS + "os=g['sys'].modules['os']\n"
    for code in [
        "os.chmod(inputs['path'], 0o777)\noutput=1",
        "os.utime(inputs['path'], (1,1))\noutput=1",
        "os.truncate(inputs['path'], 0)\noutput=1",
        "os.setxattr(inputs['path'], 'user.analysis', b'private')\noutput=1",
        "output=os.listxattr(inputs['path'])",
    ]:
        result = execute(prefix + code, {"path": str(secret)})
        assert "PermissionError" in result["error"] and "output" not in result, result
    after = secret.stat()
    assert secret.read_text() == "leave this person's data alone"
    assert (after.st_mode, after.st_mtime_ns) == (before.st_mode, before.st_mtime_ns)


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real /proc denial requires Linux")
def test_object_introspection_escape_cannot_read_server_or_extension_environment():
    result = execute(REAL_OPEN + "output=real_open('/proc/1/environ','rb').read().decode()")
    assert "PermissionError" in result["error"] and "output" not in result


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real seccomp syscall restrictions require Linux")
def test_native_introspection_escape_cannot_make_network_or_inspect_kill_spawn_processes():
    result = execute(LIBC + "output={'socket':libc.socket(2,1,0),'socket_errno':c.get_errno(),'kill':libc.kill(1,0),'kill_errno':c.get_errno()}\n")
    assert result["output"] == {"socket": -1, "socket_errno": 13, "kill": -1, "kill_errno": 13}
    # Native syscall, rather than the Python import guard, must refuse this.
    import platform
    number = 310 if platform.machine().lower() in ("x86_64", "amd64") else 270
    result = execute(LIBC + f"output=[libc.syscall({number},1,0,0,0,0,0),c.get_errno()]\n")
    assert result["output"] == [-1, 13]


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real default-deny syscall boundary requires Linux")
def test_native_alternate_process_ipc_and_unknown_syscalls_are_denied():
    import platform

    index = 0 if platform.machine().lower() in ("x86_64", "amd64") else 1
    # Invalid signal targets and null pointers make these probes harmless even
    # if the filter regresses. prlimit queries our own limits without changing
    # them; inotify_init1 would only allocate a child-local descriptor.
    calls = [
        ("queued_signal", (129, 138), (-1, 0, 0)),
        ("queued_thread_signal", (297, 240), (-1, -1, 0, 0)),
        ("own_prlimit", (302, 261), (0, 7, 0, 0)),
        ("peer_prlimit", (302, 261), (1, 7, 0, 0)),
        ("setrlimit", (160, 164), (7, 0)),
        ("inotify", (294, 26), (0,)),
        ("inotify_watch", (254, 27), (-1, 0, 0)),
        ("keyring", (250, 219), (0, 0, 0)),
        ("message_queue", (240, 180), (0, 0, 0, 0)),
        ("bpf", (321, 280), (0, 0, 0)),
        ("exec", (59, 221), (0, 0, 0)),
        ("clone3", (435, 435), (0, 0)),
        ("new_xattr_api", (463, 463), (0, 0, 0, 0, 0)),
        ("new_fileattr_api", (468, 468), (0, 0, 0, 0)),
        ("unknown_future_call", (10000, 10000), (0,)),
    ]
    probes = [(name, pair[index], arguments) for name, pair, arguments in calls]
    code = LIBC + "output={}\n"
    code += "for name,number,args in inputs['probes']:\n output[name]=[libc.syscall(number,*args),c.get_errno()]\n"
    result = execute(code, {"probes": probes})
    assert result["output"] == {name: [-1, 13] for name, _, _ in probes}, result


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real scalar open flag filtering requires Linux")
def test_read_only_truncating_open_is_denied_without_changing_scratch():
    code = REAL_OPEN + "os=g['sys'].modules['os']\n"
    code += "PermissionError=g['sys'].modules['builtins'].PermissionError\n"
    code += "file=real_open('retained.txt','w')\nfile.write('retain these bytes')\nfile.close()\n"
    code += "try:\n os.open('retained.txt',os.O_RDONLY|os.O_TRUNC)\n output='unexpected open'\n"
    code += "except PermissionError:\n output=real_open('retained.txt').read()\n"
    result = execute(code)
    assert result.get("output") == "retain these bytes", result


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real pre-seal memory ceiling requires Linux")
def test_memory_ceiling_is_installed_before_resource_syscalls_are_denied():
    # malloc reserves address space without touching the pages. The default
    # 256 MiB hard limit must reject this after seccomp has denied prlimit64.
    code = LIBC + "libc.malloc.restype=c.c_void_p\noutput=libc.malloc(512*1024*1024) is None\n"
    assert execute(code)["output"] is True


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="real scratch scope requires Linux")
def test_child_can_only_write_and_read_its_own_ephemeral_scratch():
    result = execute(REAL_OPEN + "file=real_open('scratch.txt','w')\nfile.write('private scratch')\nfile.close()\noutput=real_open('scratch.txt').read()")
    assert result["output"] == "private scratch"
    import main
    result = execute(REAL_OPEN + "output=real_open(inputs['server']).read()", {"server": main.__file__})
    assert "PermissionError" in result["error"]
    # fd-only native fstat remains available. Some libc releases implement
    # Python os.fstat through pathname fstatat instead; do not allow that
    # broader syscall as a workaround. Ordinary file bytes still read/write.
    import platform
    fstat = 5 if platform.machine().lower() in ("x86_64", "amd64") else 80
    code = REAL_OPEN + LIBC + "file=real_open('local.txt','w+')\nfile.write('abc')\nfile.flush()\nfile.seek(0)\nbuf=c.create_string_buffer(256)\n"
    code += f"output={{'contents':file.read(),'fstat':libc.syscall({fstat},file.fileno(),buf)}}\nfile.close()"
    result = execute(code)
    assert result["output"] == {"contents": "abc", "fstat": 0}, result
    getdents = 217 if platform.machine().lower() in ("x86_64", "amd64") else 61
    code = LIBC + "os=g['sys'].modules['os']\nfd=os.open('.',os.O_RDONLY|os.O_DIRECTORY)\nbuf=c.create_string_buffer(4096)\n"
    code += f"output=libc.syscall({getdents},fd,buf,4096)>0\nos.close(fd)"
    assert execute(code)["output"] is True


def test_artifact_helpers_remain_portable_and_escape_markup():
    # Pure byte generation needs no execution privilege; this remains verified
    # on Windows even though Linux-kernel execution cannot be verified here.
    from analysis_runner import Artifacts

    artifacts = Artifacts()
    artifacts.csv("safe.csv", ["value"], [["=2+2"], [-2]])
    assert b"'=2+2" in base64.b64decode(artifacts.items[0]["contentBase64"])
    artifacts.chart("plot.svg", "<script>alert(1)</script>", ["A & B"], [-1], "line")
    assert b"&lt;script&gt;" in base64.b64decode(artifacts.items[1]["contentBase64"])
