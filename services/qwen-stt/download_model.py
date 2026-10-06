"""Build-time only: immutable upstream weights, verified before image assembly."""
import hashlib
from pathlib import Path
import urllib.request

REVISION = "7278e1e70fe206f11671096ffdd38061171dd6e5"
FILES = {
    "config.json": "2e74a751548b8ad7d7526d29365ad8144c345d8b412b1152d25dc6698452712f",
    "generation_config.json": "1da527824d81e07118facff437e03f2e24a23311e3bdeb2368973fe77e5f275c",
    "model.safetensors.index.json": "f994739fe38e5210b9e3e8ce6c6307315e2ceac3cb630e7b7414d69dce520f60",
    "model-00001-of-00002.safetensors": "a4cd1f1a04d90b757dc7f7dd26254e69a013b19e80efe590a83c6a3bde8608d6",
    "model-00002-of-00002.safetensors": "6e0b9d9e09e2e0238e7ef3cc8a484ab387e91b90f1900bedf88bc92d7929ccfc",
    "vocab.json": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
    "merges.txt": "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
}


def download(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in FILES.items():
        path = directory / name
        digest = hashlib.sha256()
        with urllib.request.urlopen(f"https://huggingface.co/Qwen/Qwen3-ASR-1.7B/resolve/{REVISION}/{name}", timeout=120) as response, path.open("wb") as out:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                digest.update(block)
                out.write(block)
        if digest.hexdigest() != expected:
            path.unlink()
            raise RuntimeError(f"Model asset hash mismatch: {name}")


if __name__ == "__main__":
    download(Path("/models/qwen3-asr-1.7b"))
