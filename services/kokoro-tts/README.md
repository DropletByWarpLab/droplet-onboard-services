# Kokoro CPU TTS

Offline Wyoming TTS sidecar for Droplet. It replaces the speaking half of the
voice pipeline; speech recognition and the wake word are separate services.
Kokoro 82M v1.0 uses the fp32 ONNX export (326 MB) and eight bundled
English voices. No CUDA, GPU packages, device mounts or VRAM are needed.
The fp32 export is deliberate: the int8 `model_quantized.onnx` export runs
onnxruntime's dynamic-quantization path, which on the appliance (Ryzen 7
7700X) synthesizes at real-time speed (RTF 1.0, ~2.2 s per spoken sentence)
and does not scale with threads; the fp32 model runs the same sentences in
~0.5 s (RTF 0.22) on 4 threads with ~520 MiB resident.

Build from the repository root:

```sh
docker build -f services/kokoro-tts/Dockerfile -t droplet-kokoro-tts .
docker run --rm --network none --read-only --tmpfs /tmp:rw,exec,nosuid,size=64m droplet-kokoro-tts python smoke_test.py
```

`assets.json` pins an immutable Hugging Face revision and SHA-256 for each
weight/voice file. The build downloads and validates them, then packages them
inside the image. Startup fails if assets are missing or the voice catalog
differs. Runtime does not contain the download script or use a model hub client.
The ONNX session explicitly requests **only `CPUExecutionProvider`** and checks
the active provider list. The container runs as UID/GID 10001 and supports a
read-only root filesystem with a bounded executable `/tmp` tmpfs: phonemizer
loads a private copy of eSpeak's shared library from that directory. Keep the
exec permission specific to this sidecar; `noexec` makes synthesis fail.
Do not publish its TCP port outside the internal
voice network.

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TTS_VOICE` | `af_heart` | Server default; must be a bundled voice ID. |
| `KOKORO_CPU_THREADS` | `4` | ONNX intra-op threads, 1–16; inter-op is always 1. Keep equal to the container's CPU quota (`KOKORO_CPUS`). |
| `KOKORO_MODEL_DIR` | `/app/models` | Directory containing the bundled assets. |

CPU latency and peak RAM depend on the processor and text. The model file
size is not a runtime RAM estimate: the fp32 model sits at ~520 MiB resident
on the appliance, so the 1 GiB container ceiling stands. Measured on the
7700X appliance at 4 threads, one spoken sentence (1-3 s of audio) takes
0.3-0.7 s to synthesize. Speech requests are serialized in
arrival order: a request that arrives mid-synthesis waits up to 30 s for the
slot, then receives `error`/`busy`. At most
16 connections are retained, idle/slow socket operations expire after 10 s,
event headers/data are each capped at 16 KiB, and text is capped at 2,000
characters. Synthesis splits text at sentence/word boundaries into batches of
at most 300 characters so audio can begin before a long reply finishes. The
caller should allow at least 60 s for a CPU batch on slower boxes.

## Wyoming contract

On TCP port 10200, `describe` returns `info.data.tts[0]` with program name
`kokoro`, `installed: true`, `default_voice`, attribution and the live
`voices` catalog. `voices.json` is the catalog source; the client should use
the advertised IDs when populating a selector.

| ID | Label |
| --- | --- |
| `af_heart` | Heart (American, female) — default |
| `af_bella` | Bella (American, female) |
| `af_sarah` | Sarah (American, female) |
| `am_michael` | Michael (American, male) |
| `am_fenrir` | Fenrir (American, male) |
| `am_puck` | Puck (American, male) |
| `bf_emma` | Emma (British, female) |
| `bm_george` | George (British, male) |

Send `synthesize` with `data: {"text":"Hello", "voice":{"name":"bf_emma"}}`.
Omit `voice` to use the server default. Both inline `data` and Wyoming's
separate `data_length` encoding are accepted. The server returns
`audio-start`, binary `audio-chunk` events, then `audio-stop`: 24 kHz mono,
16-bit signed little-endian PCM. Unknown voices, malformed/oversized events
and synthesis failures return a Wyoming `error` and close the connection.
Spoken text is not logged. No voice cloning or external voice files are accepted.

Run the dependency-free protocol/provider regression suite:

```sh
python -m unittest discover -s services/kokoro-tts/tests -v
```

The smoke test uses the actual packaged model, voices, phonemizer and CPU
provider. Run it with `--network none` to verify offline behavior. See
`THIRD_PARTY_NOTICES.md` for model, runtime and phonemizer licensing.
