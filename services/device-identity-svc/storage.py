"""WARP-230 — atomic file storage for the TPM sidecar's persistent state.

All writes go to a sibling .tmp file, fsync the file + parent directory,
then rename atomically. A crash mid-write either leaves the previous
version intact (rename hasn't happened yet) or the complete new file.
Never a half-written sealed blob.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

_PROVISIONED_FILENAME = "provisioned.json"


class Storage:
    """Atomic file-store rooted at a single directory.

    All artifacts (EK cert, SRK pub, device-id pub/cert/sealed-blob,
    provisioned.json) live here. The directory is created on first use
    so the sidecar's main entry point doesn't need to prepare it.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def write(self, name: str, data: bytes) -> None:
        target = self.root / name
        tmp = self.root / f"{name}.tmp"
        with tmp.open("wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)
        # fsync the directory so the rename hits the disk too. On some
        # platforms (notably macOS) directories can't be fsync'd; we
        # tolerate that — the rename itself is atomic, the directory
        # fsync is an extra durability guarantee on Linux.
        try:
            fd = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError:
            pass

    def read(self, name: str) -> bytes:
        return (self.root / name).read_bytes()

    def exists(self, name: str) -> bool:
        return (self.root / name).exists()

    def write_provisioned(self, info: dict[str, Any]) -> None:
        self.write(_PROVISIONED_FILENAME, json.dumps(info, sort_keys=True).encode())

    def read_provisioned(self) -> Optional[dict[str, Any]]:
        path = self.root / _PROVISIONED_FILENAME
        if not path.exists():
            return None
        return json.loads(path.read_bytes())

    def is_provisioned(self) -> bool:
        return self.read_provisioned() is not None
