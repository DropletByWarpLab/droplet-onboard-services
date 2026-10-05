"""Fail-closed status validation for the root pool executor's final guard."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CHECKER = REPO_ROOT / "scripts" / "host" / "droplet-recordings-drive-check.py"
SH = shutil.which("bash") or shutil.which("sh")

pytestmark = pytest.mark.skipif(SH is None, reason="shell unavailable")
posix_only = pytest.mark.skipif(os.name == "nt", reason="requires POSIX process execution")


def _check(tmp_path: Path, status: object, params=None):
    status_file = tmp_path / "status.json"
    status_file.write_text(json.dumps(status), encoding="utf-8")
    command = tmp_path / "status.sh"
    command.write_text(
        '#!/bin/sh\ncat "$STATUS_FILE"\n', encoding="utf-8", newline="\n")
    os.chmod(command, 0o700)
    env = dict(os.environ)
    env.update({"DROPLET_NVR_STATUS_SCRIPT": str(command),
                "STATUS_FILE": str(status_file)})
    return subprocess.run([sys.executable, str(CHECKER), json.dumps(
        params if params is not None else {"device": "sdb"})],
        env=env, capture_output=True, text=True, timeout=20)


@posix_only
def test_named_volume_and_unrelated_path_are_allowed(tmp_path):
    volume = _check(tmp_path, {"kind": "volume", "source": "nvrdata"})
    assert volume.returncode == 0
    path = _check(tmp_path, {
        "kind": "path", "source": "/srv/nvr/bay/nvr", "mounted": True,
        "fsUuid": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
        "mountPath": "/srv/nvr/bay", "physicalDisk": "nvme1n1",
        "backingDevices": ["nvme1n1", "nvme1n1p1", "droplet-bay-crypt"],
    }, {"device": "sdc"})
    assert path.returncode == 0


@posix_only
def test_active_device_chain_is_refused(tmp_path):
    status = {
        "kind": "path", "source": "/mnt/droplet/bay/nvr", "mounted": True,
        "fsUuid": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
        "mountPath": "/mnt/droplet/bay", "physicalDisk": "sdb,sdc",
        "backingDevices": ["md0", "sdb", "sdc", "droplet-bay-crypt"],
    }
    proc = _check(tmp_path, status, {"device": "md0"})
    assert proc.returncode == 77


@pytest.mark.parametrize("status", [
    {"kind": "path", "source": "nvrdata", "mounted": True,
     "fsUuid": "0a1b2c3d", "mountPath": "/mnt/bay",
     "physicalDisk": "sdb", "backingDevices": ["sdb"]},
    {"kind": "path", "source": "/mnt/bay/nvr", "mounted": True,
     "fsUuid": "0a1b2c3d", "mountPath": "/",
     "physicalDisk": "sdb", "backingDevices": ["sdb"]},
    {"kind": "path", "source": "/mnt/bay/nvr", "mounted": True,
     "fsUuid": "0a1b2c3d", "mountPath": "/mnt/bay",
     "physicalDisk": "sdb", "backingDevices": ["sdb", "sdb"]},
    {"kind": "path", "source": "/mnt/bay/nvr", "mounted": True,
     "fsUuid": "0a1b2c3d", "mountPath": "/mnt/bay",
     "physicalDisk": "sdb", "backingDevices": ["/dev/sdb"]},
    {"kind": "path", "source": "/mnt/bay/nvr\n", "mounted": True,
     "fsUuid": "0a1b2c3d", "mountPath": "/mnt/bay",
     "physicalDisk": "sdb", "backingDevices": ["sdb"]},
])
@posix_only
def test_malformed_path_status_fails_closed(tmp_path, status):
    proc = _check(tmp_path, status)
    assert proc.returncode == 78
