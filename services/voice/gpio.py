"""
GPIO abstraction for the voice service.

The Droplet hardware ships with three optional pins:
  - mic_mute    — gates a MOSFET on the microphone VDD line. HIGH = power
                  CUT to the mic, so software CANNOT capture audio. The
                  red LED is the user-visible signal that this is active.
  - mute_led    — drives a red LED that lights when the mic is muted.
  - ptt_button  — momentary push-to-talk. Active-low (button bridges to
                  ground). The button raises a "ptt_pressed" event.

This module is a thin abstraction with two backends:
  - `noop`  — does nothing. Default. Safe before pins are wired.
  - `jetson` — uses Jetson.GPIO. Stubbed import; real boards have the
              package installed via the Dockerfile.

The `JetsonGpio` class deliberately tolerates an `ImportError` so the
service can boot on dev machines without `Jetson.GPIO` installed and
without configured pins. Misconfiguration logs a warning, never a crash.
"""

from __future__ import annotations

import logging
from typing import Callable, Protocol

from config import VoiceConfig

logger = logging.getLogger("voice.gpio")


class GpioBackend(Protocol):
    """Surface every backend implements."""

    def set_mute_led(self, on: bool) -> None: ...
    def set_mic_power(self, on: bool) -> None: ...
    def on_ptt_press(self, callback: Callable[[], None]) -> None: ...
    def shutdown(self) -> None: ...


class NoopGpio:
    """Default backend — logs intent but touches nothing. Safe for dev,
    CI, and the period before pins are wired on the production unit."""

    def set_mute_led(self, on: bool) -> None:
        logger.debug("noop gpio: would set mute LED -> %s", "on" if on else "off")

    def set_mic_power(self, on: bool) -> None:
        logger.debug("noop gpio: would set mic power -> %s", "on" if on else "off")

    def on_ptt_press(self, callback: Callable[[], None]) -> None:
        # Without hardware the only PTT trigger is the HTTP API. The callback
        # is registered but will never fire from this backend. The voice
        # service's POST /listen endpoint calls it directly.
        logger.debug("noop gpio: PTT callback registered (HTTP-only)")

    def shutdown(self) -> None:
        pass


class JetsonGpio:
    """Real GPIO via Jetson.GPIO. Loaded lazily so dev machines can boot
    the service without the package installed."""

    def __init__(self, cfg: VoiceConfig):
        try:
            import Jetson.GPIO as GPIO  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "Jetson.GPIO is not installed. Either set VOICE_GPIO_BACKEND=noop "
                "for dev, or install the Jetson.GPIO package on the device."
            ) from e

        self._GPIO = GPIO
        self._cfg = cfg
        self._ptt_callback: Callable[[], None] | None = None

        GPIO.setmode(GPIO.BOARD)
        GPIO.setwarnings(False)

        if cfg.mute_led_gpio is not None:
            GPIO.setup(cfg.mute_led_gpio, GPIO.OUT, initial=GPIO.LOW)
            logger.info("jetson gpio: mute LED on pin %d", cfg.mute_led_gpio)

        if cfg.mic_mute_gpio is not None:
            # Initial state HIGH = mic powered. The MOSFET wiring inverts so
            # that the LOGICAL "muted=true" cuts power. See README for the
            # circuit diagram once it's drawn.
            GPIO.setup(cfg.mic_mute_gpio, GPIO.OUT, initial=GPIO.HIGH)
            logger.info("jetson gpio: mic mute on pin %d", cfg.mic_mute_gpio)

        if cfg.ptt_button_gpio is not None:
            GPIO.setup(cfg.ptt_button_gpio, GPIO.IN, pull_up_down=GPIO.PUD_UP)
            # Falling edge = press. 200 ms debounce.
            GPIO.add_event_detect(
                cfg.ptt_button_gpio,
                GPIO.FALLING,
                callback=self._on_button,
                bouncetime=200,
            )
            logger.info("jetson gpio: PTT button on pin %d", cfg.ptt_button_gpio)

    def _on_button(self, _channel: int) -> None:
        if self._ptt_callback:
            try:
                self._ptt_callback()
            except Exception as exc:
                logger.warning("PTT callback raised: %s", exc)

    def set_mute_led(self, on: bool) -> None:
        if self._cfg.mute_led_gpio is None:
            return
        self._GPIO.output(
            self._cfg.mute_led_gpio,
            self._GPIO.HIGH if on else self._GPIO.LOW,
        )

    def set_mic_power(self, on: bool) -> None:
        # Inverted: mic_mute pin HIGH = power CUT (mute), LOW = powered.
        if self._cfg.mic_mute_gpio is None:
            return
        self._GPIO.output(
            self._cfg.mic_mute_gpio,
            self._GPIO.LOW if on else self._GPIO.HIGH,
        )

    def on_ptt_press(self, callback: Callable[[], None]) -> None:
        self._ptt_callback = callback

    def shutdown(self) -> None:
        try:
            self._GPIO.cleanup()
        except Exception:
            pass


def make_gpio(cfg: VoiceConfig) -> GpioBackend:
    """Factory — returns the backend named by VOICE_GPIO_BACKEND. Falls
    back to noop on misconfiguration so the service still boots."""
    backend = (cfg.gpio_backend or "noop").lower()
    if backend == "noop":
        return NoopGpio()
    if backend == "jetson":
        try:
            return JetsonGpio(cfg)
        except RuntimeError as exc:
            logger.warning("jetson gpio init failed (%s) — falling back to noop", exc)
            return NoopGpio()
    logger.warning("unknown gpio backend %r — falling back to noop", backend)
    return NoopGpio()
