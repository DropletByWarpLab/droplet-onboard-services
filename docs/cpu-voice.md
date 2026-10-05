# English CPU voice for Droplet

The Linux appliance voice path is **Vosk “Hey Droplet” → Qwen3-ASR 1.7B →
the existing orchestrator/LLM → Kokoro → speaker**. Dashboard dictation uses
the same Qwen service. Speech processing uses CPU and system RAM; the LLM
retains its GPU. No speech container receives `/dev/dri`, NVIDIA devices,
ROCm devices, a GPU runtime, or GPU inference dependencies.

## Models and licenses

| Role | Model/runtime | Reason |
|---|---|---|
| Wake phrase | Bundled `vosk-model-small-en-us-0.15`, Vosk | Apache-2.0 English model; existing exact configured phrase recognition, no custom wake model training |
| Recognition | Full Qwen3-ASR 1.7B weights, antirez native C/OpenBLAS runtime | Apache-2.0 weights, MIT runtime; strong English recognition without a GPU Python stack |
| Speaking | Kokoro 82M v1.0, quantized ONNX CPU runtime | Apache-2.0 model and voice vectors; eight bundled US/UK voices share one model |

Sources: [Qwen model](https://huggingface.co/Qwen/Qwen3-ASR-1.7B),
[native runtime](https://github.com/antirez/qwen-asr),
[Vosk models](https://alphacephei.com/vosk/models),
[Kokoro model](https://huggingface.co/hexgrad/Kokoro-82M),
[voice provenance](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md).
These models are free for commercial use under their license terms. Kokoro's
phonemizer/eSpeak dependencies are GPL; retain their notices and corresponding
source when distributing images. See the service's `THIRD_PARTY_NOTICES.md`.

Qwen is the first candidate to qualify because its published English
recognition accuracy is stronger than the existing `small.en` model. The
October 2 common eight-dataset public average is 4.31% WER for Qwen 1.7B,
versus 5.78% for Whisper large-v3 in the
[pinned leaderboard dataset](https://huggingface.co/datasets/hf-audio/open-asr-leaderboard-results/blob/c23ca4f10e5f1a77c9fd3b41e17cd06a04f0f56c/english_short_latest.csv).
Those results use the official inference implementations. They do not measure
this native CPU adapter, a Droplet microphone, or end-to-end response latency.
Do not infer CPU speed or on-box quality from GPU benchmark throughput.

## Operation

`linux` enables `qwen-stt` and `kokoro-tts`. Both images bundle immutable
upstream assets with SHA-256 verification at build time. Runtime downloads
are disabled/absent, and both services join only the internal `droplet-speech`
compose network, shared with their orchestrator/voice-io clients and isolated
from the untrusted code sandbox's `droplet-internal` network.
Their Wyoming ports are exposed internally, never published to the LAN.
Both run as UID 10001, with read-only filesystems and all capabilities dropped.
Kokoro uses a bounded executable `/tmp` tmpfs because phonemizer loads an
eSpeak shared library from a temporary file.

The wake detector remains Vosk with `WAKE_WORD=hey droplet`. Capture finishes
after the existing end-of-speech silence detector or a 30-second hard cap.
The exact configured wake phrase is removed only from the beginning of a
transcript. Dictation accepts mono signed 16-bit PCM at 8–48 kHz, normalizing
it to Qwen's 16 kHz input. Each model runs one inference at a time, with bounded
input, connection counts, and request deadlines. STT clients default to a
90-second transcript deadline; TTS defaults to 60 seconds. Audio/transcripts
are not saved by either speech sidecar.

An owner/admin can select and preview a voice in **Voice & microphone**.
Preview speaks through the appliance speaker and does not save the choice.
The saved choice applies to replies, streamed reply segments, confirmation
prompts, and spoken cues. It lives at `/data/speaking-voice.json` on the existing
voice-calibration volume, survives recreation, and resets with factory reset.
Only installed voices from the running service can be selected. An unavailable
service exposes no invented choices; legacy Piper overrides do not receive a
saved Kokoro voice ID.

## Resource budget and acceptance on the appliance

The documented target is a Ryzen 7 7700X, 32 GB RAM appliance. Defaults:

| Service | CPU quota / threads | RAM ceiling |
|---|---|---|
| Qwen STT | 4 / 4 native and OpenBLAS | 10 GiB |
| Kokoro TTS | 2 / 2 ONNX | 1 GiB |
| Voice I/O + Vosk | 1 | 512 MiB (existing) |

Qwen requires at least 14 GiB `MemAvailable` **before loading**, and refuses
a container RAM limit below 10 GiB. The startup check budgets the model's
ceiling plus a 4 GiB appliance reserve. It is not a sustained host reservation:
other services can consume RAM later. Current live appliance headroom and
recognition latency have not been measured by this PR. Never lower the startup
guard merely to make a resource-constrained deployment turn green.

Before deploying to a box, measure with the main LLM, Frigate cameras, indexing
and normal services running. Require at least 4 GiB `MemAvailable` after model
warmup and during repeated 30-second utterances, no swap growth/OOM events,
healthy model readiness, and unchanged GPU VRAM consumption attributable to
speech. Check cold startup and repeated turns, missed/false “Hey Droplet” wakes,
English names, noisy/distant speech, Bluetooth dictation, selected-voice
persistence, previews, and dangerous-action confirmation. Record median/p95
STT time and end-of-speech-to-first-spoken-reply time on the actual box.
Local synthetic speech smoke tests establish integration, not microphone
acceptance or a latency guarantee.

## Rollback

The pinned Whisper and Piper services remain in optional `voice-whisper` and
`voice-piper` profiles. Profiles are additive: stop the replaced Qwen/Kokoro
service explicitly to recover its resources. To restore both legacy services,
add the two profiles to the box's existing `COMPOSE_PROFILES`, set
`STT_URL=tcp://wyoming-faster-whisper:10300`,
`TTS_URL=tcp://wyoming-piper:10200`, and `TTS_VOICE=en_US-ryan-medium` (or the
installed licensed Piper voice), then recreate the orchestrator/voice-io and
start the legacy sidecars through the normal deployment flow. Do not change
the LLM/GPU configuration. Returning to Kokoro restores the saved Kokoro choice.
Piper voice licenses differ by voice; the legacy default is not represented
as an Apache-licensed model.
