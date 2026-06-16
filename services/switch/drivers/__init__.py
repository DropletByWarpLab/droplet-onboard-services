"""Switch driver factory.

This is the SINGLE decision point for which hardware driver to use.
Set SWITCH_DRIVER environment variable to select the implementation:

  - "lantronix"  (default) — SM8TAT2SA via HTTPS JSON API
  - "asic"       (future)  — Custom PCB via SPI/I2C registers

Everything above this layer (FastAPI endpoints, orchestrator, LLM tools,
dashboard) stays identical regardless of which driver is active.
"""

from __future__ import annotations

import os
import logging

from .base import SwitchDriver

logger = logging.getLogger("droplet.switch.factory")


def create_driver() -> SwitchDriver:
    """Create and return a switch driver instance based on SWITCH_DRIVER env var."""

    driver_type = os.environ.get("SWITCH_DRIVER", "lantronix").lower()

    if driver_type == "lantronix":
        from .lantronix import LantronixDriver

        host = os.environ.get("SWITCH_HOST", "192.168.1.77")
        port = int(os.environ.get("SWITCH_PORT", "443"))
        username = os.environ.get("SWITCH_USERNAME", "admin")
        password = os.environ.get("SWITCH_PASSWORD", "")
        # NET-07: optional CA bundle / cert path enabling TLS verification of
        # the switch. Empty/unset → driver keeps the insecure self-signed
        # default (with a warning). Honoured in LantronixDriver.connect().
        ca_cert = os.environ.get("SWITCH_CA_CERT", "").strip() or None

        # ADR-018 item 10: the WebStaX write shape (POST /config/<name>) is
        # pattern-inferred and NOT yet confirmed on firmware v1.04.0079. The
        # driver therefore runs PLAN-ONLY by default — writes compute the
        # intended change without POSTing. SWITCH_LIVE_WRITES must be explicitly
        # truthy to apply writes, and only after a one-time supervised
        # confirmation of the write shape per firmware. Default-safe posture
        # (matches SWITCH_AUTOPROVISION defaulting off).
        plan_only = os.environ.get("SWITCH_LIVE_WRITES", "0").strip().lower() not in (
            "1",
            "true",
            "yes",
            "on",
        )

        if not password:
            logger.warning("SWITCH_PASSWORD not set — switch auth may fail")

        logger.info(
            "Creating managed switch driver for %s:%d (user: %s, writes: %s)",
            host, port, username, "PLAN-ONLY" if plan_only else "LIVE",
        )
        return LantronixDriver(
            host=host,
            port=port,
            username=username,
            password=password,
            ca_cert=ca_cert,
            plan_only=plan_only,
        )

    # Future: custom ASIC driver
    # elif driver_type == "asic":
    #     from .asic import ASICDriver
    #     return ASICDriver(
    #         bus=os.environ.get("ASIC_BUS", "/dev/spidev0.0"),
    #         ...
    #     )

    else:
        raise ValueError(
            f"Unknown SWITCH_DRIVER: '{driver_type}'. "
            f"Supported: 'lantronix'. Future: 'asic'."
        )
