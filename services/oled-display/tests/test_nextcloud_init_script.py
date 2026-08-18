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
image, so a plain (retry-free) enable is the correct shape — but it must
never be fatal under the hook's `set -euo pipefail`.
"""

from __future__ import annotations

import os
import shutil
import subprocess
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


# php answers every occ call with success and logs it. STUB_FILES_EXTERNAL_RC
# lets the never-fatal test force just the files_external enable to fail.
_PHP_STUB = r"""
printf 'php %s\n' "$*" >> "$CMD_LOG"
case " $* " in
  *" app:enable files_external "*) exit "${STUB_FILES_EXTERNAL_RC:-0}" ;;
  *" files_external:list "*) printf '%s' "${STUB_EXT_LIST_JSON:-[]}"; exit 0 ;;
  *" files_external:create "*) echo "Storage created with id 7"; exit 0 ;;
  " -r"*)
    # Inline `php -r` parse helpers (both call sites pipe a JSON listing on
    # stdin). Emulate just enough: emit the /Droplet mount id when the piped
    # listing contains it, else nothing — mirroring the real parser's output.
    input="$(cat)"
    case "$input" in *'"mount_point": "/Droplet"'*) printf 7 ;; esac
    exit 0 ;;
esac
exit 0
"""


def _run_hook(tmp_path: Path, extra_env: dict | None = None):
    stub_dir = tmp_path / "stub-bin"
    stub_dir.mkdir(exist_ok=True)
    php = stub_dir / "php"
    php.write_text("#!/usr/bin/env bash\n" + _PHP_STUB.lstrip("\n"),
                   encoding="utf-8", newline="\n")
    os.chmod(php, 0o755)
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
        "PATH": str(stub_dir) + os.pathsep + env.get("PATH", ""),
    })
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
    assert "files_external:option 7 filesystem_check_changes 1" in joined, joined


def test_network_drive_skips_create_when_mount_exists(tmp_path):
    # Re-run with an existing "/Droplet" mount in the files_external listing:
    # the hook must NOT create a duplicate, only re-assert the option.
    share = tmp_path / "droplet-share"
    share.mkdir()
    existing = '[{"mount_id": 7, "mount_point": "/Droplet", "storage": "Local"}]'
    proc, cmds = _run_hook(tmp_path, {
        "DROPLET_SHARE_DIR": _posix(share),
        "STUB_EXT_LIST_JSON": existing,
    })
    assert proc.returncode == 0, proc.stderr
    joined = "\n".join(cmds)
    assert "files_external:create" not in joined, joined
    assert "files_external:option 7 filesystem_check_changes 1" in joined, joined


def test_network_drive_absent_volume_skips_block(tmp_path):
    # No /droplet-share mount (e.g. a dev bring-up without the volume): the
    # block must skip cleanly and never abort the hook.
    proc, cmds = _run_hook(
        tmp_path, {"DROPLET_SHARE_DIR": _posix(tmp_path / "missing")}
    )
    assert proc.returncode == 0, proc.stderr
    assert "files_external:create" not in "\n".join(cmds)


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
