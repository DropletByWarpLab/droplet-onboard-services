"""Metadata shim for exercising the root-only topology lock as an unprivileged CI user."""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def install_trusted_stat_shim(bin_dir: Path, lock_path: Path,
                              real_stat: str | None = None) -> Path:
    """Return a PATH-first stat shim for an isolated temporary lock fixture.

    The production helper still enforces root ownership/modes unconditionally.
    This shim models tmpfiles-provisioned root metadata while keeping tests
    hermetic on CI runners that cannot chown their temporary directories.
    """
    real_stat = real_stat or shutil.which("stat")
    if not real_stat:
        raise RuntimeError("stat is required by the topology-lock test helper")
    bin_dir.mkdir(parents=True, exist_ok=True)
    shim = bin_dir / "stat"
    lock_path = lock_path.resolve()
    lock_dir = lock_path.parent
    trusted_dirs = []
    parent = lock_dir
    while True:
        trusted_dirs.append(str(parent))
        if parent == parent.parent:
            break
        parent = parent.parent
    source = r'''#!/usr/bin/env bash
target="${@: -1}"
case "$target" in
  "$LOCK_FILE"|*/fd/8) printf 'regular empty file|0|0|660|1|1|202\n' ;;
  "$LOCK_DIR"|*/fd/7) printf 'directory|0|0|750|2|1|101\n' ;;
  *)
    case ":$TOPOLOGY_TRUSTED_DIRS:" in
      *":$target:"*) printf 'directory|0|0|755|2|1|100\n' ;;
      *) exec "$REAL_STAT" "$@" ;;
    esac
    ;;
esac
'''
    shim.write_text(source, encoding="utf-8", newline="\n")
    os.chmod(shim, 0o755)
    return shim


def add_trusted_stat_env(env: dict[str, str], bin_dir: Path, lock_path: Path) -> dict[str, str]:
    original_path = env.get("PATH", "")
    real_stat = shutil.which("stat", path=original_path)
    if not real_stat:
        raise RuntimeError("stat is required by the topology-lock test helper")
    overlay = bin_dir / "topology-lock-stat"
    install_trusted_stat_shim(overlay, lock_path, real_stat=real_stat)
    env.update({
        "PATH": str(overlay) + os.pathsep + original_path,
        "REAL_STAT": real_stat,
        "LOCK_FILE": str(lock_path.resolve()),
        "LOCK_DIR": str(lock_path.resolve().parent),
        "TOPOLOGY_TRUSTED_DIRS": ":".join(
            str(p) for p in [lock_path.resolve().parent, *lock_path.resolve().parents]),
    })
    return env
