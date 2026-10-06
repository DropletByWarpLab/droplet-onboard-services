# Qwen CPU STT

Resident full Qwen3-ASR 1.7B weights, served through Wyoming on internal TCP
10300. The pinned native C library is compiled for x86-64-v3 (AVX2/FMA,
supported by the target Ryzen 7700X), with OpenBLAS and no CUDA/HIP backend.
Original BF16 decoder weights and float32 encoder calculations are preserved;
this is not a smaller model or an int8 STT conversion.

Build from the repository root:

```sh
docker build -f services/qwen-stt/Dockerfile -t droplet-qwen-stt .
python -m pip install -r services/qwen-stt/requirements-dev.txt
python -m pytest services/qwen-stt/tests
```

The Dockerfile pins the runtime commit/archive hash and Python image digest.
`download_model.py` pins the upstream model revision and verifies every file's
SHA-256 at build time. Assets are baked into the image (about 4.7 GB of weights),
never fetched at runtime. Python has no production pip dependencies.
Qwen weights are Apache-2.0; the native runtime is MIT (included in the image).
OpenBLAS/OS notices remain in the installed packages. The complete model
license and provenance accompany the image.

Protocol: `describe` → `info`, or `transcribe` → `audio-start` → chunks →
`audio-stop` → `transcript`. Both Wyoming JSON framing versions are accepted.
English is forced; signed 16-bit mono PCM at 8–48 kHz is accepted and normalized
to 16 kHz, with a 30-second input maximum. Eight concurrent connections are
bounded, and only one native decode can run; a busy peer receives an error.
A disconnected/timed-out client cannot release the native inference lock
while its worker is still running. Audio/text are kept in request memory only.

Defaults: four native/BLAS threads, 10 GiB container cap, a pre-load 14 GiB
host `MemAvailable` requirement. Health becomes ready only after the real
model is loaded, via a Wyoming `describe` round trip. See
[appliance qualification](../../docs/cpu-voice.md) for sustained headroom,
CPU latency, microphone accuracy checks and the legacy Whisper rollback.
