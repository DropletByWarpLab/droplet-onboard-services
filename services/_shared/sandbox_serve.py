"""Load the sandbox TLS identity before sealing customer filesystem access."""
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

from _shared import internal_tls
from _shared.sandbox_isolation import seal_sandbox
from _shared.serve import build_run_args


def cleanup_staged_tls() -> None:
    """Unlink only the private tmpfs copies made by privilege_drop.sh.

    The original host mount is never changed. An explicit staging-directory
    marker avoids globbing or deleting an operator-specified cert location.
    """
    marker = os.environ.pop("DROPLET_TLS_STAGING_DIR", None)
    if marker is None:
        return
    stage = Path(marker)
    if stage.parent != Path("/tmp") or not stage.name.startswith("droplet-service-tls.") or not stat.S_ISDIR(stage.lstat().st_mode):
        raise RuntimeError("sandbox TLS staging directory is invalid")
    descriptor = os.open(stage, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for name in ("key.pem", "cert.pem", "ca.pem"):
            os.unlink(name, dir_fd=descriptor)
    finally:
        os.close(descriptor)
    os.rmdir(stage)


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    # Before Config.load() imports the trusted app or loads any private key.
    # Same-uid workspace/extension execs cannot inspect this process's memory,
    # environment, fd table or /proc/<pid>/root while SSLContext retains it.
    sealing_required = internal_tls.enabled() or Path("/data/service-tls/key.pem").exists()
    if sealing_required:
        internal_tls.protect_process()
    app, kwargs = build_run_args(sys.argv[1:] if argv is None else argv)
    config = uvicorn.Config(app, workers=1, **kwargs)
    try:
        config.load()
    finally:
        cleanup_staged_tls()
    # Config.load() has retained SSLContext in memory. Server.run() uses the
    # already-loaded config; lifespan and all customer children start sealed.
    if sealing_required:
        seal_sandbox()
    uvicorn.Server(config).run()


if __name__ == "__main__":
    main()
