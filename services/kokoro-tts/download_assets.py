"""Build-only download of immutable, SHA-256 checked Kokoro assets."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import urllib.request


def download_assets(target: Path) -> None:
    import numpy as np

    source = Path(__file__).parent
    manifest = json.loads((source / "assets.json").read_text())
    catalog = json.loads((source / "voices.json").read_text())
    target.mkdir(parents=True, exist_ok=True)
    voices = {}
    for name, expected_hash in manifest["files"].items():
        url = (
            f"https://huggingface.co/{manifest['repository']}/resolve/"
            f"{manifest['revision']}/{name}"
        )
        destination = target / ("model.onnx" if name.endswith(".onnx") else Path(name).name)
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=120) as response, destination.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected_hash:
            destination.unlink()
            raise RuntimeError(f"SHA-256 mismatch for {name}")
        if name.endswith(".bin"):
            # HF stores raw little-endian float32; kokoro-onnx reads a NumPy archive.
            voices[destination.stem] = np.fromfile(destination, dtype="<f4").reshape(510, 1, 256)
            destination.unlink()
    if set(voices) != {voice["name"] for voice in catalog}:
        raise RuntimeError("Bundled voices must match the advertised catalog")
    np.savez(target / "voices.npz", **voices)
    (target / "assets.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    download_assets(Path(sys.argv[1]))
