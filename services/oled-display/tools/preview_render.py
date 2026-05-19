"""Local PIL sanity-render of the redesigned screens.

Standalone helper — not run by the service. Imports display.py with
DISPLAY_BACKEND=sim so no PyPortal is required, then renders each of
the three new screens to PNGs in /tmp so we can eyeball them next to
preview.html without flashing firmware.

Usage:
    cd services/oled-display
    DISPLAY_BACKEND=sim python tools/preview_render.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("DISPLAY_BACKEND", "sim")
os.environ.setdefault("AUTO_CYCLE", "0")
os.environ.setdefault("WIFI_HELPER_URL", "http://127.0.0.1:9099")  # unreachable, OK

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import display as d   # noqa: E402


def main() -> int:
    out_dir = Path(os.environ.get("PREVIEW_OUT", str(ROOT / "previews")))
    out_dir.mkdir(parents=True, exist_ok=True)

    tft = d.TFTDisplay()

    # Stub a QR snapshot so render_qr has something to draw without
    # the bridge running.
    tft._qr_snapshot = {
        "ok": True,
        "ssid": "Droplet-AI",
        "security": "psk2",
        "payload": "WIFI:S:Droplet-AI;T:WPA;P:hello-droplet-25;;",
        "key": "hello-droplet-25",
        "version": 5,
        "rotation_enabled": False,
        "ttl_seconds": 0,
        "matrix": None,
    }

    targets = [
        ("idle", "render_idle"),
        ("stats", "render_stats"),
        ("qr", "render_qr"),
    ]
    for name, method in targets:
        fn = getattr(tft, method, None)
        if fn is None:
            print(f"[skip] {name}: {method}() missing")
            continue
        img = fn()
        path = out_dir / f"{name}.png"
        img.save(str(path))
        print(f"[ok]   {name}: {path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
