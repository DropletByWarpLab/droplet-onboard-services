# Qwen CPU STT

Resident Qwen3-ASR 0.6B weights, served through Wyoming on internal TCP
10300. The pinned native C library is compiled for x86-64-v3 (AVX2/FMA,
supported by the target Ryzen 7700X), with OpenBLAS and no CUDA/HIP backend.
Original BF16 decoder weights and float32 encoder calculations are preserved;
this is the upstream 0.6B checkpoint, not an int8 STT conversion. It replaced
the 1.7B, whose BF16 decoder is memory-bandwidth bound on the appliance and
held 4.6 GiB. In RAM the runtime converts the encoder to float32 and keeps a
fused copy of the decoder gate/up projections (about 1.5 GiB anonymous, KV
cache included) beside the memory-mapped BF16 weights (about 1.5 GiB of the
1.75 GiB file resident), about 2.9 GiB charged to the container after a 30 s
decode.

Build from the repository root:

```sh
docker build -f services/qwen-stt/Dockerfile -t droplet-qwen-stt .
python -m pip install -r services/qwen-stt/requirements-dev.txt
python -m pytest services/qwen-stt/tests
```

The Dockerfile pins the runtime commit/archive hash and Python image digest.
`download_model.py` pins the upstream model revision and verifies every file's
SHA-256 at build time. Assets are baked into the image (about 1.9 GB of weights),
never fetched at runtime. Python has no production pip dependencies.
Qwen weights are Apache-2.0; the native runtime is MIT (included in the image).
OpenBLAS/OS notices remain in the installed packages. The complete model
license and provenance accompany the image.

Protocol: `describe` → `info`, or `transcribe` → `audio-start` → chunks →
`audio-stop` → `transcript`. Both Wyoming JSON framing versions are accepted.
English is forced; signed 16-bit mono PCM at 8–48 kHz is accepted and normalized
to 16 kHz, with a 30-second input maximum. Eight concurrent connections are
bounded, and only one native decode runs at a time: a request that arrives
while one is running waits for the slot in arrival order (up to 60 s), then
receives a `busy` error. A disconnected/timed-out client cannot release the
native inference lock while its worker is still running; a client that gives
up while merely queued leaves the queue at once. Audio/text are kept in
request memory only.

Defaults: four native/BLAS threads, 4 GiB container cap (also the floor the
startup check refuses below), a pre-load 8 GiB host `MemAvailable`
requirement. Health becomes ready only after the real model is loaded and has
decoded one second of silence, so the first turn after a restart does not pay
the weight page-in; readiness is a Wyoming `describe` round trip. See
[appliance qualification](../../docs/cpu-voice.md) for sustained headroom,
CPU latency, microphone accuracy checks and the legacy Whisper rollback.
