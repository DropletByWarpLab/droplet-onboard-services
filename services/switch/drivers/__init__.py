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

        if not password:
            logger.warning("SWITCH_PASSWORD not set — switch auth may fail")

        logger.info(
            "Creating Lantronix driver for %s:%d (user: %s)", host, port, username
        )
        return LantronixDriver(
            host=host,
            port=port,
            username=username,
            password=password,
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
