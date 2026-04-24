"""
Touch stub for the PyPortal-only display.

Touch events on the PyPortal come back over the USB-serial link as
`TOUCH:x,y,pressure` lines and are parsed directly by `display.py`'s
cycle loop. The local `TouchReader` no longer reads any kernel input
device or SPI controller — it's kept as a thin shim so `main.py` can
keep its existing `TouchReader(...).start()/stop()/get_state()` calls
without conditional wiring.

The direct-XPT2046 (spidev) and evdev paths, plus the calibration env
vars, were removed when we dropped the direct-SPI TFT backend.
"""

class TouchReader:
    """No-op touch reader.

    Kept so `main.py`'s lifespan hook stays unchanged. Returns a state
    dict that always reports "not pressed"; real touches come from the
    PyPortal over serial and are dispatched by `TFTDisplay.handle_touch`.
    """

    def __init__(self, width: int = 480, height: int = 320):
        self.width = width
        self.height = height
        self._backend = "none"

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass

    def get_state(self) -> dict:
        return {
            "backend": self._backend,
            "pressed": False,
            "x": None,
            "y": None,
            "press_count": 0,
            "release_count": 0,
        }
