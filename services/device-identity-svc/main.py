"""WARP-230 — device-identity-svc entrypoint.

Binds a gRPC server to /var/run/droplet/device-identity.sock. Backend
selected by DROPLET_TPM_BACKEND (default: mock for dev/CI; production
images set real via the Compose env). When DROPLET_AUTO_PROVISION=1
and the backend isn't yet provisioned, the server auto-provisions on
startup using DROPLET_DEVICE_ID + the canonical PCR set.
"""
from __future__ import annotations

import logging
import os
import signal
import sys
from concurrent import futures
from pathlib import Path

import grpc

from backends import make_backend
from grpc_generated import device_identity_pb2_grpc as pb_grpc
from grpc_server import DeviceIdentityServicer

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("device-identity-svc")

DEFAULT_SOCK = "/var/run/droplet/device-identity.sock"
DEFAULT_STORAGE = "/var/lib/droplet/tpm"
DEFAULT_SEALING_PCRS = [0, 2, 4, 7]
DEFAULT_GRPC_WORKERS = 4


def _parse_pcrs(raw: str) -> list[int]:
    return [int(x) for x in raw.split(",") if x.strip()]


def _run_fips_boot_self_test() -> None:
    """WARP-229: assert the OpenSSL FIPS provider is loaded + enforcing.

    Gating: ``DROPLET_FIPS_REQUIRED`` env var.
      ``true`` / ``1``      → enforce; exit 1 on failure
      ``false`` / unset     → skip with note (dev/CI default)
    """
    raw = os.environ.get("DROPLET_FIPS_REQUIRED")
    if raw is None or raw.lower() in ("false", "0", "no"):
        logger.info(
            "FIPS boot self-test skipped (DROPLET_FIPS_REQUIRED=%s)",
            raw if raw is not None else "<unset>",
        )
        return
    sys.path.insert(0, "/app")
    from _shared.fips_selftest import assert_fips_at_boot_or_exit  # noqa: WPS433
    assert_fips_at_boot_or_exit("device-identity-svc")


def main() -> int:
    _run_fips_boot_self_test()
    backend_name = os.environ.get("DROPLET_TPM_BACKEND", "mock")
    socket_path = os.environ.get("DROPLET_DI_SOCKET", DEFAULT_SOCK)
    storage_root = Path(os.environ.get("DROPLET_DI_STORAGE", DEFAULT_STORAGE))
    sealing_pcrs = _parse_pcrs(
        os.environ.get(
            "DROPLET_TPM_PCRS", ",".join(str(p) for p in DEFAULT_SEALING_PCRS)
        )
    )
    storage_root.mkdir(parents=True, exist_ok=True)
    Path(socket_path).parent.mkdir(parents=True, exist_ok=True)

    backend = make_backend(backend_name, storage_root=storage_root)
    logger.info("Loaded backend=%s storage=%s", backend.name, storage_root)
    if backend.name == "mock" and os.environ.get("DROPLET_ENV") == "production":
        logger.warning(
            "Mock device-identity backend in production. The 'real' TPM backend "
            "is an unimplemented scaffold (IDX-002) — do NOT set "
            "DROPLET_TPM_BACKEND=real until it lands (it fails closed by default)."
        )

    # Auto-provision on first start. Idempotent — backend.provision() is a
    # no-op when already provisioned.
    auto_provision = os.environ.get("DROPLET_AUTO_PROVISION", "0") in ("1", "true", "yes")
    if auto_provision and not backend.is_provisioned():
        device_id = os.environ.get("DROPLET_DEVICE_ID", "droplet")
        logger.info(
            "Auto-provisioning device_id=%s sealing_pcrs=%s",
            device_id,
            sealing_pcrs,
        )
        backend.provision(device_id=device_id, sealing_pcrs=sealing_pcrs)

    servicer = DeviceIdentityServicer(backend)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=DEFAULT_GRPC_WORKERS))
    pb_grpc.add_DeviceIdentityServiceServicer_to_server(servicer, server)
    if Path(socket_path).exists():
        Path(socket_path).unlink()
    server.add_insecure_port(f"unix://{socket_path}")
    server.start()
    try:
        os.chmod(socket_path, 0o660)
    except FileNotFoundError:
        pass
    logger.info("Listening on unix://%s", socket_path)

    def _shutdown(signum, _frame):
        logger.info("Received signal %s — shutting down", signum)
        server.stop(grace=3)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    server.wait_for_termination()
    return 0


if __name__ == "__main__":
    sys.exit(main())
