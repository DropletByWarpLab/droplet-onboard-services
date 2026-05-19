"""Sanity-check the Wi-Fi QR pipeline end-to-end.

Mirrors device-bridge.py's `_wifi_payload` + `_qr_encode` (now ECC_H)
and renders the result two ways:

    previews/qr_clean.png     — plain QR, scannable
    previews/qr_with_mark.png — QR with the 30 px Droplet mark inset,
                                replicating the new pair-screen design

For the WPA payload format see
https://github.com/zxing/zxing/wiki/Barcode-Contents#wi-fi-network-config

Run with:
    python tools/verify_qr.py [SSID] [PASSWORD]
"""

from __future__ import annotations

import sys
from pathlib import Path

import qrcode
from qrcode.constants import ERROR_CORRECT_H
from PIL import Image, ImageDraw


def wifi_payload(ssid: str, key: str, encryption: str = "psk2") -> str:
    """Mirror device-bridge.py's `_wifi_payload`."""
    sec = "nopass"
    enc = (encryption or "").lower()
    if any(k in enc for k in ("wpa3", "wpa2", "wpa", "psk", "sae")):
        sec = "WPA"
    elif "wep" in enc:
        sec = "WEP"

    def esc(s: str) -> str:
        return (s.replace("\\", "\\\\")
                 .replace(";", "\\;")
                 .replace(",", "\\,")
                 .replace(":", "\\:")
                 .replace('"', '\\"'))

    return "WIFI:S:{};T:{};P:{};;".format(
        esc(ssid), sec, esc(key) if sec != "nopass" else "")


def main(ssid: str, password: str) -> int:
    payload = wifi_payload(ssid, password)
    print(f"Payload:  {payload}")
    print(f"Length:   {len(payload)} chars")

    q = qrcode.QRCode(
        error_correction=ERROR_CORRECT_H,
        border=0,
        box_size=1,
    )
    q.add_data(payload)
    q.make(fit=True)
    matrix = q.get_matrix()
    n = len(matrix)
    print(f"Version:  {q.version}  ({n}x{n} modules)")
    print(f"ECC:      H  (~30% recovery)")

    img = q.make_image(fill_color="black", back_color="white").convert("RGB")
    target_px = 200
    img = img.resize((target_px, target_px), Image.NEAREST)
    cell_px = target_px // n
    print(f"At {target_px}px: cell = {cell_px}px  ({n}*{cell_px} = {n*cell_px}px)")

    out_dir = Path(__file__).resolve().parent.parent / "previews"
    out_dir.mkdir(parents=True, exist_ok=True)
    plain = out_dir / "qr_clean.png"
    img.save(str(plain))
    print(f"[ok] plain QR -> {plain}")

    # Re-create the design's center-mark inset on a white rounded card.
    with_mark = img.copy()
    d = ImageDraw.Draw(with_mark)
    mark = 30
    pad = 3
    cx = target_px // 2
    cy = target_px // 2
    # White rounded card behind the mark (matches drawQR in preview.html)
    d.rounded_rectangle(
        [(cx - mark // 2 - pad, cy - mark // 2 - pad),
         (cx + mark // 2 + pad, cy + mark // 2 + pad)],
        radius=6, fill="white")
    # Cheap droplet-mark — same proportions as DropletMark.tsx
    vw, vh = 52, 60
    scale = mark / vh
    mx = cx - int(vw * scale) // 2
    my = cy - mark // 2
    def proj(pts):
        return [(mx + int(px * scale), my + int(py * scale)) for px, py in pts]

    d.polygon(proj([(26, 0), (44, 28), (36, 48), (16, 48), (8, 28)]),
              fill=(124, 127, 255))
    d.polygon(proj([(26, 0), (44, 28), (26, 36)]),
              fill=(180, 186, 255))

    mark_path = out_dir / "qr_with_mark.png"
    with_mark.save(str(mark_path))
    print(f"[ok] QR + mark inset -> {mark_path}")

    # Cutout area as fraction — ECC_H survives ~30% damage. The mark
    # occupies (mark+2*pad)^2 / target_px^2.
    cutout = ((mark + 2 * pad) ** 2) / (target_px ** 2)
    print(f"Cutout area: {cutout*100:.1f}%  (ECC_H tolerates ~30%)")

    # Decode it back with opencv's QR detector. Pads a 4-module quiet
    # zone around the matrix — required by the QR spec and matches the
    # white card around the QR on the actual pair screen.
    try:
        import cv2
        import numpy as np

        def _with_quiet_zone(im: Image.Image, modules: int = 4) -> Image.Image:
            pad = (cell_px * modules) * (600 // target_px)
            big = im.resize((600, 600), Image.NEAREST)
            framed = Image.new("RGB", (600 + 2*pad, 600 + 2*pad), "white")
            framed.paste(big, (pad, pad))
            return framed

        det = cv2.QRCodeDetector()
        for label, im in (("clean", img), ("inset", with_mark)):
            framed = _with_quiet_zone(im)
            arr = np.array(framed.convert("L"))
            data, bbox, _ = det.detectAndDecode(arr)
            if not data:
                print(f"[fail] {label}: opencv could not decode")
                continue
            ok = data == payload
            print(f"[{'ok' if ok else 'fail'}] {label}: "
                  f"decoded -> {data!r} {'==' if ok else '!='} payload")
            # Save the framed version too so we have a phone-scannable PNG.
            framed_path = out_dir / f"qr_{label}_framed.png"
            framed.save(str(framed_path))
            print(f"       framed -> {framed_path}")
    except ImportError:
        print("[skip] opencv not installed - scan the PNGs with a phone "
              "camera to confirm scannability")

    return 0


if __name__ == "__main__":
    ssid = sys.argv[1] if len(sys.argv) > 1 else "Droplet-AI"
    password = sys.argv[2] if len(sys.argv) > 2 else "hello-droplet-25"
    raise SystemExit(main(ssid, password))
