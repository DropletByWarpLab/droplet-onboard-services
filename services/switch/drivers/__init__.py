"""Switch driver factory.

This is the SINGLE decision point for which hardware driver to use.
Set SWITCH_DRIVER environment variable to select the implementation:

  - "openwrt"  (default) — a switch reflashed to the Droplet OpenWrt image
                (Zyxel GS1900 family), ubus-over-HTTP as `droplet-ai`
  - "asic"     (future)  — Custom PCB via SPI/I2C registers

The retired Lantronix SM8TAT2SA WebStaX driver was removed in WARP-1674:
managed switches are Zyxel units reflashed to the Droplet OpenWrt image
(droplet-edge-router switch/ subtree) — there is no stock-firmware protocol
to maintain.

Everything above this layer (FastAPI endpoints, orchestrator, LLM tools,
dashboard) stays identical regardless of which driver is active.
"""

from __future__ import annotations

import os
import logging

from .base import SwitchDriver

logger = logging.getLogger("droplet.switch.factory")


def _load_switch_password() -> str:
    """Load the managed-switch credential, preferring the Docker secret file.

    ADR-018 T1. Mirrors routing's ``_load_openwrt_password`` (WARP-37).
    Resolution order:

      1. ``SWITCH_PASSWORD_FILE`` (default ``/run/secrets/switch_password``) —
         the Docker Compose file-based secret, written by
         ``scripts/setup.sh --sync-secrets`` from the operator-supplied
         ``SWITCH_PASSWORD`` in ``.env``. Preferred.
      2. ``SWITCH_PASSWORD`` env var — deprecated, logged as a warning, kept for
         local dev and upgrades.

    Returns an empty string when nothing is configured. The factory then keeps
    the historical graceful posture: the driver still constructs and the switch
    reports ``disconnected`` at connect-time rather than crashing — so a box
    without a managed switch is unaffected.
    """
    secret_path = os.environ.get("SWITCH_PASSWORD_FILE", "/run/secrets/switch_password")
    try:
        with open(secret_path, "r", encoding="utf-8") as fh:
            value = fh.read().strip()
        if value:
            return value
        logger.warning(
            "Switch password secret file %s is empty — set SWITCH_PASSWORD in .env "
            "and re-run ./scripts/setup.sh --sync-secrets",
            secret_path,
        )
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("Could not read switch password from %s: %s", secret_path, exc)

    env_value = os.environ.get("SWITCH_PASSWORD", "")
    if env_value:
        logger.warning(
            "SWITCH_PASSWORD env var is deprecated — migrate to the Docker secret "
            "at /run/secrets/switch_password (ADR-018 T1). Falling back to env for now."
        )
    return env_value


def create_driver() -> SwitchDriver:
    """Create and return a switch driver instance based on SWITCH_DRIVER env var."""

    driver_type = os.environ.get("SWITCH_DRIVER", "openwrt").lower()

    if driver_type == "openwrt":
        # WARP-1674: a switch running the Droplet OpenWrt image (first target:
        # Zyxel GS1900-10HP on the edge-router shape — droplet-edge-router
        # switch/ subtree). ubus-over-HTTP as the per-unit `droplet-ai` rpcd
        # user; defaults mirror the committed image config (static 192.168.9.2,
        # plain-HTTP LAN-side rpcd on :80).
        from .openwrt import OpenWrtSwitchDriver

        host = os.environ.get("SWITCH_HOST", "192.168.9.2")
        port = int(os.environ.get("SWITCH_PORT", "80"))
        username = os.environ.get("SWITCH_USERNAME", "droplet-ai")
        password = _load_switch_password()
        # Default-safe write posture (ADR-018 item 10 discipline): the uci
        # write shapes are unconfirmed on flashed hardware (the lab unit is
        # still on stock firmware), so writes stay PLAN-ONLY until the
        # post-flash supervised confirmation flips SWITCH_LIVE_WRITES.
        plan_only = os.environ.get("SWITCH_LIVE_WRITES", "0").strip().lower() not in (
            "1",
            "true",
            "yes",
            "on",
        )

        if not password:
            logger.warning(
                "Switch password not configured (no /run/secrets/switch_password "
                "and no SWITCH_PASSWORD) — copy the switch's "
                "/etc/droplet/droplet-ai-password into the secret. The switch "
                "reports 'disconnected' until then."
            )

        logger.info(
            "Creating OpenWrt switch driver for %s:%d (user: %s, writes: %s)",
            host, port, username, "PLAN-ONLY" if plan_only else "LIVE",
        )
        return OpenWrtSwitchDriver(
            host=host,
            port=port,
            username=username,
            password=password,
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
            f"Supported: 'openwrt'. Future: 'asic'. "
            f"('lantronix' was removed in WARP-1674 — reflash the switch to "
            f"the Droplet OpenWrt image.)"
        )
