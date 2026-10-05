"""Hermetic tests for docker/nextcloud-init.sh (WARP-1338 AC1).

The post-installation hook must enable the bundled `files_external` app
idempotently next to the groupfolders enable. files_external is the namespace
every drive/pool registration lands in (`occ files_external:create`, invoked
from services/automount/droplet-automount.sh and
scripts/host/droplet-storage-pool.sh on the host) — without it the dashboard's
drive tiles deep-link into a WebDAV 404 that renders as a false "This folder
is empty".

Same PATH-stub approach as test_automount_script.py: `php` (the only binary
the hook shells occ through) is replaced by a stub that logs every invocation
to $CMD_LOG, so no Nextcloud container, appstore, or docker is ever needed.
Unlike groupfolders/onlyoffice, files_external SHIPS INSIDE the Nextcloud
image. Its enable and share registration retry transient startup failures
briefly and must never abort the hook's `set -euo pipefail`.
"""

from __future__ import annotations

import os
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[3] / "docker" / "nextcloud-init.sh"
)
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")


def _posix(p: Path) -> str:
    # Git-Bash on Windows handles C:/-style paths; backslashes don't survive
    # bash quoting (same trick as test_automount_script.py).
    return str(p).replace("\\", "/")


# A stateful occ double: successful creates/config changes survive retries
# and container starts, including a create saved before returning an error.
# Where available, actual PHP executes the hook's JSON parser; Windows hosts
# without PHP use the small matching parser double for the shell control flow.
_PHP_STUB = r"""
if [ "$1" = "-r" ]; then
  case "$2" in
    *'$matches = [];'*) exec "$TEST_PYTHON" "$TEST_STUB" "$@" ;;
    *) cat >/dev/null; exit 0 ;;
  esac
fi
case " $* " in
  *" files_external:"*|*" app:enable files_external "*) exec "$TEST_PYTHON" "$TEST_STUB" "$@" ;;
esac
printf 'php %s\n' "$*" >> "$CMD_LOG"
exit 0
"""

_OCC_STUB = r'''
import json
import os
import re
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
state = Path(os.environ["STUB_EXT_STATE"])
log = Path(os.environ["CMD_LOG"])
if args and args[0] == "-r":
    data = sys.stdin.read()
    if os.environ.get("TEST_REAL_PHP"):
        result = subprocess.run([os.environ["TEST_REAL_PHP"], *args], input=data, text=True)
        sys.exit(result.returncode)
    if "$matches = [];" not in args[1]:
        sys.exit(0)
    try:
        mounts = json.loads(data)
        if not isinstance(mounts, list) or any(not isinstance(m, dict) for m in mounts):
            raise ValueError()
        matches = [m for m in mounts if m.get("mount_point") == "/Droplet"]
        if matches:
            mount = matches[0]
            mid = str(mount.get("mount_id", ""))
            if (len(matches) != 1 or mount.get("storage") != "\\OC\\Files\\Storage\\Local"
                    or not re.fullmatch(r"[0-9]+", mid) or int(mid) < 1):
                raise ValueError()
            print(mid, end="")
    except (ValueError, TypeError):
        sys.exit(1)
    sys.exit(0)

with log.open("a", encoding="utf-8") as handle:
    handle.write("php " + " ".join(args) + "\n")
command = args[1] if len(args) > 1 else ""
countfile = state.with_suffix("." + command.replace(":", "_") + ".count")
count = int(countfile.read_text()) + 1 if countfile.exists() else 1
countfile.write_text(str(count))

if command == "app:enable" and args[2] == "files_external":
    # app:enable groupfolders also increments the same count, hence use a
    # separate counter for just this app.
    countfile = state.with_suffix(".files_external_enable.count")
    count = int(countfile.read_text()) + 1 if countfile.exists() else 1
    countfile.write_text(str(count))
    if count <= int(os.environ.get("STUB_EXT_ENABLE_FAILURES", "0")):
        sys.exit(1)
    sys.exit(int(os.environ.get("STUB_FILES_EXTERNAL_RC", "0")))
if command == "files_external:list":
    if count <= int(os.environ.get("STUB_EXT_LIST_FAILURES", "0")):
        sys.exit(1)
    print(state.read_text() if state.exists() else os.environ.get("STUB_EXT_LIST_JSON", "[]"))
elif command == "files_external:create":
    failed = count <= int(os.environ.get("STUB_EXT_CREATE_FAILURES", "0"))
    if not failed or os.environ.get("STUB_EXT_CREATE_SAVED_ON_ERROR"):
        datadir = next(a[8:] for a in args if a.startswith("datadir="))
        state.write_text(json.dumps([{
            "mount_id": 7, "mount_point": "/Droplet", "storage": "\\OC\\Files\\Storage\\Local",
            "configuration": {"datadir": datadir}, "options": {},
            "applicable_users": [], "applicable_groups": [],
        }]))
    print(os.environ.get("STUB_EXT_CREATE_OUTPUT", "7"))
    sys.exit(1 if failed else 0)
elif command in ("files_external:config", "files_external:option"):
    variable = "STUB_EXT_CONFIG_FAILURES" if command.endswith(":config") else "STUB_EXT_OPTION_FAILURES"
    if count <= int(os.environ.get(variable, "0")):
        sys.exit(1)
    mounts = json.loads(state.read_text() if state.exists() else os.environ["STUB_EXT_LIST_JSON"])
    mount = next(m for m in mounts if str(m["mount_id"]) == args[2])
    bucket = "configuration" if command.endswith(":config") else "options"
    value = int(args[4]) if command.endswith(":option") else args[4]
    mount.setdefault(bucket, {})[args[3]] = value
    state.write_text(json.dumps(mounts))
'''


def _run_hook(tmp_path: Path, extra_env: dict | None = None):
    stub_dir = tmp_path / "stub-bin"
    stub_dir.mkdir(exist_ok=True)
    php = stub_dir / "php"
    php.write_text("#!/usr/bin/env bash\n" + _PHP_STUB.lstrip("\n"),
                   encoding="utf-8", newline="\n")
    os.chmod(php, 0o755)
    helper = stub_dir / "occ-stub.py"
    helper.write_text(_OCC_STUB, encoding="utf-8", newline="\n")
    # Stub `sleep` too: with the php stub, every appstore-install check
    # "fails", so the hook's bounded retry loops (groupfolders, the
    # richdocuments/onlyoffice connector) run to exhaustion and their real
    # sleeps add up to ~3 minutes per run — past the 120 s subprocess
    # timeout on a slow runner. The sleeps carry no semantics any test
    # asserts on; stubbing them makes every run fast and deterministic.
    slp = stub_dir / "sleep"
    slp.write_text("#!/usr/bin/env bash\nexit 0\n",
                   encoding="utf-8", newline="\n")
    os.chmod(slp, 0o755)

    log = tmp_path / "cmd-log.txt"
    if not log.exists():
        log.write_text("", encoding="utf-8")
    env = dict(os.environ)
    # The OnlyOffice block must stay un-entered (it su's to www-data): no JWT
    # secret means the hook skips it, matching a box with no docs engine.
    env.pop("ONLYOFFICE_JWT_SECRET", None)
    env.update({
        "CMD_LOG": _posix(log),
        "STUB_EXT_STATE": _posix(tmp_path / "external-mounts.json"),
        "TEST_PYTHON": _posix(Path(sys.executable)),
        "TEST_STUB": _posix(helper),
        "PATH": str(stub_dir) + os.pathsep + env.get("PATH", ""),
        "DOCS_ENABLED": "0",
        "DROPLET_SHARE_DIR": _posix(tmp_path / "missing-share"),
        "MSYS2_ARG_CONV_EXCL": "*",
    })
    real_php = shutil.which("php")
    if real_php:
        env["TEST_REAL_PHP"] = _posix(Path(real_php))
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [BASH, str(SCRIPT)],
        env=env, capture_output=True, text=True, timeout=120,
    )
    cmds = [ln for ln in log.read_text(encoding="utf-8").splitlines() if ln]
    return proc, cmds


def test_hook_passes_bash_syntax_check():
    proc = subprocess.run([BASH, "-n", str(SCRIPT)],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr


def test_hook_enables_files_external_next_to_groupfolders(tmp_path):
    proc, cmds = _run_hook(tmp_path)
    assert proc.returncode == 0, proc.stderr
    joined = "\n".join(cmds)
    # Control: the pre-existing groupfolders enable still runs.
    assert "app:enable groupfolders" in joined, joined
    # WARP-1338 AC1: files_external is enabled in the same hook.
    assert "app:enable files_external" in joined, joined


def test_files_external_enable_failure_is_never_fatal(tmp_path):
    # A transient occ failure on the files_external enable must not abort the
    # hook under `set -euo pipefail` — the household provisioning after it
    # still runs, and the hook still exits 0 (the entrypoint treats a hook
    # failure as fatal and would crash-loop the first-boot container).
    proc, cmds = _run_hook(tmp_path, {"STUB_FILES_EXTERNAL_RC": "1"})
    assert proc.returncode == 0, proc.stderr
    joined = "\n".join(cmds)
    # The steps after the enable still executed (bootstrap owner group add).
    assert "group:adduser" in joined, joined


def test_network_drive_registers_droplet_external_mount(tmp_path):
    # With the droplet-share volume present, the hook registers the "/Droplet"
    # files_external local mount and asserts filesystem_check_changes so
    # SMB-side writes appear in the web Files UI without a manual files:scan.
    share = tmp_path / "droplet-share"
    share.mkdir()
    proc, cmds = _run_hook(tmp_path, {"DROPLET_SHARE_DIR": _posix(share)})
    assert proc.returncode == 0, proc.stderr
    joined = "\n".join(cmds)
    assert "files_external:create /Droplet local null::null" in joined, joined
    assert f"files_external:config 7 datadir {_posix(share)}" in joined, joined
    assert "files_external:option 7 filesystem_check_changes 1" in joined, joined


def test_network_drive_skips_create_when_mount_exists(tmp_path):
    # Re-run with an existing "/Droplet" mount in the files_external listing:
    # the hook must NOT create a duplicate, only re-assert the option.
    share = tmp_path / "droplet-share"
    share.mkdir()
    existing = json.dumps([{
        "mount_id": 7, "mount_point": "/Droplet", "storage": "\\OC\\Files\\Storage\\Local",
        "configuration": {"datadir": "/stale-path"},
        "options": {"filesystem_check_changes": 0, "enable_sharing": False},
        "applicable_users": ["owner"], "applicable_groups": ["staff"],
    }])
    proc, cmds = _run_hook(tmp_path, {
        "DROPLET_SHARE_DIR": _posix(share),
        "STUB_EXT_LIST_JSON": existing,
    })
    assert proc.returncode == 0, proc.stderr
    joined = "\n".join(cmds)
    assert "files_external:create" not in joined, joined
    assert f"files_external:config 7 datadir {_posix(share)}" in joined, joined
    assert "files_external:option 7 filesystem_check_changes 1" in joined, joined
    mount = json.loads((tmp_path / "external-mounts.json").read_text())[0]
    assert mount["configuration"]["datadir"] == _posix(share)
    assert mount["options"]["filesystem_check_changes"] == 1
    assert mount["options"]["enable_sharing"] is False
    assert mount["applicable_users"] == ["owner"]
    assert mount["applicable_groups"] == ["staff"]


def test_network_drive_absent_volume_skips_block(tmp_path):
    # No /droplet-share mount (e.g. a dev bring-up without the volume): the
    # block must skip cleanly and never abort the hook.
    proc, cmds = _run_hook(
        tmp_path, {"DROPLET_SHARE_DIR": _posix(tmp_path / "missing")}
    )
    assert proc.returncode == 0, proc.stderr
    assert "files_external:create" not in "\n".join(cmds)


@pytest.mark.parametrize("failure_key,command", [
    ("STUB_EXT_ENABLE_FAILURES", "app:enable files_external"),
    ("STUB_EXT_LIST_FAILURES", "files_external:list"),
    ("STUB_EXT_CREATE_FAILURES", "files_external:create"),
    ("STUB_EXT_CONFIG_FAILURES", "files_external:config"),
    ("STUB_EXT_OPTION_FAILURES", "files_external:option"),
])
def test_network_drive_recovers_from_transient_startup_failure(tmp_path, failure_key, command):
    share = tmp_path / "droplet-share"
    share.mkdir()
    proc, cmds = _run_hook(tmp_path, {
        "DROPLET_SHARE_DIR": _posix(share), failure_key: "1",
    })
    assert proc.returncode == 0, proc.stderr
    assert len([c for c in cmds if command in c]) == 2
    assert "filesystem_check_changes 1" in "\n".join(cmds)
    assert "checks desktop changes on access" in proc.stdout
    # A config/option retry re-lists the saved mount instead of duplicating it.
    if failure_key in ("STUB_EXT_CONFIG_FAILURES", "STUB_EXT_OPTION_FAILURES"):
        assert len([c for c in cmds if "files_external:create" in c]) == 1


@pytest.mark.parametrize("failure_key,command", [
    ("STUB_EXT_ENABLE_FAILURES", "app:enable files_external"),
    ("STUB_EXT_LIST_FAILURES", "files_external:list"),
    ("STUB_EXT_CREATE_FAILURES", "files_external:create"),
    ("STUB_EXT_CONFIG_FAILURES", "files_external:config"),
    ("STUB_EXT_OPTION_FAILURES", "files_external:option"),
])
def test_network_drive_failure_is_bounded_and_explicit(tmp_path, failure_key, command):
    share = tmp_path / "droplet-share"
    share.mkdir()
    proc, cmds = _run_hook(tmp_path, {
        "DROPLET_SHARE_DIR": _posix(share), failure_key: "99",
    })
    assert proc.returncode == 0, proc.stderr
    assert len([c for c in cmds if command in c]) == 3
    assert "/Droplet mount is NOT ready" in proc.stderr
    assert "checks desktop changes on access" not in proc.stdout
    assert "group:adduser" in "\n".join(cmds)


def test_network_drive_failed_create_with_saved_mount_does_not_duplicate(tmp_path):
    share = tmp_path / "droplet-share"
    share.mkdir()
    proc, cmds = _run_hook(tmp_path, {
        "DROPLET_SHARE_DIR": _posix(share),
        "STUB_EXT_CREATE_FAILURES": "1",
        "STUB_EXT_CREATE_SAVED_ON_ERROR": "1",
        "STUB_EXT_CREATE_OUTPUT": "database error 503",
    })
    assert proc.returncode == 0, proc.stderr
    assert len([c for c in cmds if "files_external:create" in c]) == 1
    assert "files_external:option 7 filesystem_check_changes 1" in "\n".join(cmds)
    assert "checks desktop changes on access" in proc.stdout


def test_network_drive_invalid_create_output_is_not_used_as_mount_id(tmp_path):
    share = tmp_path / "droplet-share"
    share.mkdir()
    proc, cmds = _run_hook(tmp_path, {
        "DROPLET_SHARE_DIR": _posix(share),
        "STUB_EXT_CREATE_OUTPUT": "warning 503, storage 7",
    })
    assert proc.returncode == 0, proc.stderr
    assert "returned an invalid mount id" in proc.stderr
    assert "files_external:config 7 datadir" in "\n".join(cmds)
    assert "files_external:config 5037" not in "\n".join(cmds)
    assert len([c for c in cmds if "files_external:create" in c]) == 1


@pytest.mark.parametrize("listing", [
    "unavailable", "null", "{}", "[null]",
    json.dumps([{"mount_id": 7, "mount_point": "/Droplet", "storage": "\\OC\\Files\\Storage\\SMB"}]),
    json.dumps([{"mount_id": "7;delete", "mount_point": "/Droplet", "storage": "\\OC\\Files\\Storage\\Local"}]),
    json.dumps([
        {"mount_id": 7, "mount_point": "/Droplet", "storage": "\\OC\\Files\\Storage\\Local"},
        {"mount_id": 8, "mount_point": "/Droplet", "storage": "\\OC\\Files\\Storage\\Local"},
    ]),
])
def test_network_drive_does_not_mutate_invalid_or_conflicting_mounts(tmp_path, listing):
    share = tmp_path / "droplet-share"
    share.mkdir()
    proc, cmds = _run_hook(tmp_path, {
        "DROPLET_SHARE_DIR": _posix(share), "STUB_EXT_LIST_JSON": listing,
    })
    assert proc.returncode == 0, proc.stderr
    assert "invalid listing or conflicting /Droplet mount" in proc.stderr
    assert "/Droplet mount is NOT ready" in proc.stderr
    assert not any("files_external:create" in c or "files_external:config" in c
                   or "files_external:option" in c or "files_external:delete" in c for c in cmds)


def test_network_drive_registered_mount_survives_container_restart(tmp_path):
    share = tmp_path / "droplet-share"
    share.mkdir()
    env = {"DROPLET_SHARE_DIR": _posix(share)}
    first, _ = _run_hook(tmp_path, env)
    second, cmds = _run_hook(tmp_path, env)
    assert first.returncode == second.returncode == 0, second.stderr
    assert len([c for c in cmds if "files_external:create" in c]) == 1
    assert len([c for c in cmds if "filesystem_check_changes 1" in c]) == 2


def test_hook_rerun_is_idempotent(tmp_path):
    # The hook re-runs on every bring-up (WARP-990 reconcile) — a second run
    # must succeed and re-issue the same idempotent enables, never duplicate
    # state or fail.
    proc1, _ = _run_hook(tmp_path)
    assert proc1.returncode == 0, proc1.stderr
    proc2, cmds = _run_hook(tmp_path)
    assert proc2.returncode == 0, proc2.stderr
    assert (
        "\n".join(cmds).count("app:enable files_external") == 2
    ), "expected the enable to be re-issued (occ no-ops when already enabled)"
