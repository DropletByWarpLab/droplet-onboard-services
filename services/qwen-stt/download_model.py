"""Build-time only: immutable upstream weights, verified before image assembly."""
import hashlib
from pathlib import Path
import urllib.request

# WARP-3729: Qwen3-ASR-0.6B replaced the 1.7B. On the appliance the 1.7B BF16
# decoder is memory-bandwidth bound (8 threads gained nothing), so the only
# lever left was a model that reads a third of the bytes per token. The 0.6B
# ships as one safetensors file; the native runtime detects its shapes from
# the weights and never reads config.json, which stays here for provenance.
REVISION = "5eb144179a02acc5e5ba31e748d22b0cf3e303b0"
FILES = {
    "config.json": "76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c",
    "generation_config.json": "1da527824d81e07118facff437e03f2e24a23311e3bdeb2368973fe77e5f275c",
    "model.safetensors": "79d6cbd4c98c7bbffe9db2edac07f56cd6637d0d5944b27f6c2b8353840323ea",
    "vocab.json": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
    "merges.txt": "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
}


def download(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in FILES.items():
        path = directory / name
        digest = hashlib.sha256()
        with urllib.request.urlopen(f"https://huggingface.co/Qwen/Qwen3-ASR-0.6B/resolve/{REVISION}/{name}", timeout=120) as response, path.open("wb") as out:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                digest.update(block)
                out.write(block)
        if digest.hexdigest() != expected:
            path.unlink()
            raise RuntimeError(f"Model asset hash mismatch: {name}")


if __name__ == "__main__":
    download(Path("/models/qwen3-asr-0.6b"))
