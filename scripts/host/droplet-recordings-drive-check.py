#!/usr/bin/env python3
"""Fail-closed check used by the root storage-pool executor under the topology lock."""

import json
import os
import posixpath
import re
import subprocess
import sys

ACTIVE = 77
UNAVAILABLE = 78
UUID_RE = re.compile(r"[0-9A-Fa-f][0-9A-Fa-f-]{6,35}")
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_+.-]{0,127}")
VOLUME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")


def fail(code: int, message: str) -> None:
    sys.stdout.write(message + "\n")
    raise SystemExit(code)


def device_name(value: object) -> str:
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if value.startswith("/dev/"):
        value = value[5:]
    if value.startswith("mapper/"):
        value = value[7:]
    return value if NAME_RE.fullmatch(value) else ""


def normalized_absolute(value: object) -> bool:
    return (isinstance(value, str) and value.startswith("/")
            and not value.startswith("//")
            and not any(ord(ch) < 32 or ord(ch) == 127 for ch in value)
            and posixpath.normpath(value) == value)


def main() -> None:
    try:
        params = json.loads(sys.argv[1])
        if not isinstance(params, dict):
            fail(UNAVAILABLE, "recording storage could not be verified")
        names = {
            name for value in (
                params.get("device"), params.get("member"), params.get("md"),
                *(params.get("members") if isinstance(params.get("members"), list)
                  else [params.get("members")]),
            )
            if (name := device_name(value))
        }
        if not names:
            fail(UNAVAILABLE, "recording storage could not be verified")
        # The env override is a root-owned deployment/test seam, not a request
        # field. Production defaults to the absolute helper installed by the
        # root installer; request.json never supplies this executable path.
        command = os.environ.get(
            "DROPLET_NVR_STATUS_SCRIPT",
            "/usr/local/sbin/droplet-set-nvr-media.sh",
        )
        result = subprocess.run(
            [command, "--status"],  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-tainted-env-args.dangerous-subprocess-use-tainted-env-args -- process-environment-only deployment/test seam; production default is fixed root-owned helper and request data cannot set it
            capture_output=True, text=True,
            timeout=15, check=False,
        )
        if result.returncode != 0:
            fail(UNAVAILABLE, "recording storage could not be verified")
        status = json.loads(result.stdout)
        if not isinstance(status, dict):
            fail(UNAVAILABLE, "recording storage could not be verified")

        kind = status.get("kind")
        source = status.get("source")
        if kind == "volume":
            if not isinstance(source, str) or not VOLUME_RE.fullmatch(source):
                fail(UNAVAILABLE, "recording storage could not be verified")
            return
        if kind != "path" or status.get("mounted") is not True:
            fail(UNAVAILABLE, "recording storage could not be verified")

        mount = status.get("mountPath")
        fs_uuid = status.get("fsUuid")
        raw_devices = status.get("backingDevices")
        raw_physical = status.get("physicalDisk")
        if (not normalized_absolute(source) or not normalized_absolute(mount)
                or mount == "/" or not isinstance(fs_uuid, str)
                or not UUID_RE.fullmatch(fs_uuid)
                or not isinstance(raw_devices, list) or not raw_devices
                or not isinstance(raw_physical, str) or not raw_physical):
            fail(UNAVAILABLE, "recording storage could not be verified")
        if source != mount and not source.startswith(mount.rstrip("/") + "/"):
            fail(UNAVAILABLE, "recording storage could not be verified")
        if (any(not isinstance(value, str) or not NAME_RE.fullmatch(value)
                for value in raw_devices)
                or len(set(raw_devices)) != len(raw_devices)):
            fail(UNAVAILABLE, "recording storage could not be verified")
        devices = set(raw_devices)
        physical = raw_physical.split(",")
        if (any(not NAME_RE.fullmatch(value) for value in physical)
                or not set(physical).issubset(devices)):
            fail(UNAVAILABLE, "recording storage could not be verified")
        if names & devices:
            fail(ACTIVE, "this drive holds the camera recordings and cannot be changed")
    except SystemExit:
        raise
    except Exception:
        fail(UNAVAILABLE, "recording storage could not be verified")


if __name__ == "__main__":
    main()
