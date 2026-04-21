"""
GPIO shim so the TFT/touch code works on both Raspberry Pi and Jetson.

Background
----------
The 3.5" TFT shield is hardwired to fixed physical pins on the 40-pin header
(DC = pin 18, RST = pin 22, Touch CS = pin 26, Touch IRQ = pin 11, plus SPI0).
That pinout is identical on Pi and Jetson because the 40-pin header
specification is the same; only the underlying SoC-level pin labels differ.

luma.core expects to `import RPi.GPIO` and defaults to BCM numbering. On a
Jetson there is no RPi.GPIO, and BCM numbers wouldn't map correctly anyway.
NVIDIA's `Jetson.GPIO` package exposes the same API as RPi.GPIO and supports
`BOARD` mode where numbers match the physical 40-pin header labels.

What this module does
---------------------
Before any code that might `import RPi.GPIO` runs, we:

  1. Try `Jetson.GPIO` first (works on any Jetson).
  2. Fall back to `RPi.GPIO` (works on any Pi).
  3. Register whichever succeeded as `RPi.GPIO` in `sys.modules`, so luma.core
     picks it up unchanged.
  4. Set `BOARD` mode so `DC_PIN = 18` means "physical pin 18" on both boards.

Import this file *first* in main.py, before the display / touch modules.

If neither library is present (e.g. running the service on a dev laptop) we
just skip — the display code will fall back to the simulated backend that
writes PNGs to /tmp.
"""

from __future__ import annotations

import logging
import sys
from types import ModuleType
from typing import Any, Optional

logger = logging.getLogger("droplet.tft.gpio_shim")


def _install_as_rpi_gpio(gpio_module: Any, source_name: str) -> None:
    """Register `gpio_module` in sys.modules as `RPi.GPIO`.

    Anything that subsequently does `import RPi.GPIO as GPIO` will receive
    our shimmed module.
    """
    # Create an empty `RPi` package wrapper so `import RPi.GPIO` works.
    rpi_pkg = ModuleType("RPi")
    rpi_pkg.GPIO = gpio_module  # type: ignore[attr-defined]
    sys.modules["RPi"] = rpi_pkg
    sys.modules["RPi.GPIO"] = gpio_module

    # Set BOARD mode so pin numbers from env (DC_PIN=18, RST_PIN=22) match the
    # physical pin labels on the 40-pin header. Suppress "channel already in
    # use" warnings that fire when the service is restarted without the host
    # releasing the pins.
    try:
        gpio_module.setmode(gpio_module.BOARD)
        gpio_module.setwarnings(False)
    except Exception as exc:
        logger.warning("GPIO shim: setmode(BOARD) failed on %s: %s", source_name, exc)
        return

    logger.info("GPIO shim installed — source=%s, mode=BOARD", source_name)


def install() -> Optional[str]:
    """Install the GPIO shim. Returns the backend name if one was installed."""
    # 1. Prefer Jetson.GPIO on Jetson devices.
    try:
        import Jetson.GPIO as jgpio  # type: ignore[import-not-found]

        _install_as_rpi_gpio(jgpio, "Jetson.GPIO")
        return "Jetson.GPIO"
    except ImportError:
        pass
    except Exception as exc:
        logger.warning("Jetson.GPIO import raised unexpected error: %s", exc)

    # 2. Fall back to RPi.GPIO on actual Raspberry Pi hardware.
    try:
        import RPi.GPIO as rgpio  # type: ignore[import-not-found]

        # RPi.GPIO IS already RPi.GPIO, just set BOARD mode for consistency.
        try:
            rgpio.setmode(rgpio.BOARD)
            rgpio.setwarnings(False)
        except Exception as exc:
            logger.warning("RPi.GPIO setmode(BOARD) failed: %s", exc)
            return None

        logger.info("GPIO shim passthrough — source=RPi.GPIO, mode=BOARD")
        return "RPi.GPIO"
    except ImportError:
        pass

    logger.info("GPIO shim: no GPIO backend available (dev host?) — display will use sim backend")
    return None


# Install the moment this module is first imported. This MUST run before
# anything else imports luma.core.
_ACTIVE_BACKEND = install()
