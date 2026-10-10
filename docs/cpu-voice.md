# English CPU voice for Droplet

The Linux appliance voice path is **Vosk “Hey Droplet” → Qwen3-ASR 0.6B →
the existing orchestrator/LLM → Kokoro → speaker**. Dashboard dictation uses
the same Qwen service. Speech processing uses CPU and system RAM; the LLM
retains its GPU. No speech container receives `/dev/dri`, NVIDIA devices,
ROCm devices, a GPU runtime, or GPU inference dependencies.

## Models and licenses

| Role | Model/runtime | Reason |
|---|---|---|
| Wake phrase | Bundled `vosk-model-small-en-us-0.15`, Vosk | Apache-2.0 English model; existing exact configured phrase recognition, no custom wake model training |
| Recognition | Qwen3-ASR 0.6B weights (unquantized BF16 decoder, float32 encoder in RAM), antirez native C/OpenBLAS runtime | Apache-2.0 weights, MIT runtime; strong English recognition without a GPU Python stack. The 0.6B rather than the 1.7B: on the appliance the 1.7B BF16 decoder is memory-bandwidth bound, and the 0.6B answers a short command about a third faster while the container holds about 2.9 GiB instead of 4.6 GiB |
| Speaking | Kokoro 82M v1.0, fp32 ONNX CPU runtime | Apache-2.0 model and voice vectors; eight bundled US/UK voices share one model. The fp32 export, not the int8 one: onnxruntime's dynamic-quantization path synthesizes at real-time speed on the appliance and ignores extra threads, the fp32 model is ~4.6x faster (RTF 0.22) |

Sources: [Qwen model](https://huggingface.co/Qwen/Qwen3-ASR-0.6B),
[native runtime](https://github.com/antirez/qwen-asr),
[Vosk models](https://alphacephei.com/vosk/models),
[Kokoro model](https://huggingface.co/hexgrad/Kokoro-82M),
[voice provenance](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md).
These models are free for commercial use under their license terms. Kokoro's
phonemizer/eSpeak dependencies are GPL; retain their notices and corresponding
source when distributing images. See the service's `THIRD_PARTY_NOTICES.md`.

Qwen is the first candidate to qualify because its published English
recognition accuracy is stronger than the existing `small.en` model. The
October 2 common eight-dataset public average is 5.05% WER for Qwen3-ASR-0.6B
(4.31% for the 1.7B it replaced), versus 5.78% for Whisper large-v3 in the
[pinned leaderboard dataset](https://huggingface.co/datasets/hf-audio/open-asr-leaderboard-results/blob/c23ca4f10e5f1a77c9fd3b41e17cd06a04f0f56c/english_short_latest.csv)
(rows Qwen/Qwen3-ASR-0.6B-hf and Qwen/Qwen3-ASR-1.7B-hf). The 0.6B trades
accuracy for speed: it trails the 1.7B on every subset of that dataset
(LibriSpeech clean 1.70% vs 1.26%, LibriSpeech other 4.01% vs 2.94%, AMI 9.33%
vs 8.31%, Earnings-22 7.83% vs 5.84%), widest on the far-field and noisy
subsets, while staying ahead of Whisper large-v3 on the average. Those results
use the official inference implementations. They do not measure this native
CPU adapter, a Droplet microphone, or end-to-end response latency. Do not infer
CPU speed or on-box quality from GPU benchmark throughput.

Our own 0.6B evidence is synthetic Kokoro speech through the production
Wyoming clients: the eight smoke phrases and one 30 s utterance transcribed
exactly, and on a 40-phrase set the 0.6B made 5 word errors against the 1.7B's
3 on the 35 rows both decoded, mostly number and time formatting ("10:15",
"8 P.M."); the other 5 rows were lost to a workstation bind-mount artefact,
not the model. There is no far-field, noisy, Bluetooth or real-microphone
evidence yet. The microphone check below (English names, distant and noisy
speech, Bluetooth 8 kHz dictation, dangerous-action confirmation phrases) is
the acceptance gate before accuracy is claimed beyond that, and the 1.7B
rebuild under Rollback is the fallback if it regresses.

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
input, connection counts, and request deadlines; a request that arrives while
one is running queues for the slot in arrival order (up to 60 s for recognition,
30 s for speech) before it is refused as `busy`, so appliance voice and
dashboard dictation share each model without failing each other's turns. STT
clients default to a 90-second transcript deadline; TTS defaults to 60
seconds. Audio/transcripts are not saved by either speech sidecar.

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
| Qwen STT | 4 / 4 native and OpenBLAS | 4 GiB (~2.9 GiB charged after a 30 s decode: ~1.5 GiB anonymous = float32 encoder, fused gate/up copy, KV cache; ~1.5 GiB of mapped BF16 weight pages, ~0.76 GiB of them hot decoder/embeddings and ~0.7 GiB read once at load) |
| Kokoro TTS | 4 / 4 ONNX | 1 GiB (~520 MiB resident) |
| Voice I/O + Vosk | 1 | 512 MiB (existing) |

Measured on the lab appliance (2026-10-10, through the production Wyoming
clients) with the 1.7B it replaced: a 1-3 s command in 1.8 s median / 2.3 s
p95 and a 30 s utterance in 11.6 s, no better with 8 threads — the 1.7B BF16
decoder is memory-bandwidth bound, so the lever was a smaller model.
Qwen3-ASR-0.6B against 1.7B on the same workstation (4 threads): 2.04 s vs
3.0 s median, 2.45 s vs 3.3 s p95, 13.5 s vs 15.7 s for the 30 s clip, every
smoke phrase exact for both; the container is charged about 2.9 GiB instead
of 4.6 GiB (an earlier 1.38 GiB figure counted anonymous memory only, not the
mapped weight pages, so the like-for-like saving is about 1.7 GiB). The on-box
0.6B figures are still to be recorded. Kokoro synthesizes a spoken sentence in
0.3-0.7 s with the fp32 export (2.2 s with the int8 export it replaced), and
the first chunk handed to it is the answer's first clause when that clause is
at least 24 characters long (WARP-3729), so first audio no longer waits for
the whole first sentence to be synthesized. A real answered turn on the box
(with the 1.7B) broke down as: wake→capture 66 ms, capture 0.96 s (0.4 s
speech + the 0.6 s end-of-speech silence; since WARP-3729 a short command's
tail is 0.48 s), STT 1.9 s, LLM first token 0.7 s, first spoken audio 3.6 s
after the transcript with the int8 Kokoro.

Qwen requires at least 8 GiB `MemAvailable` **before loading**, and refuses
a container RAM limit below 4 GiB. The startup check budgets the model's 4 GiB
ceiling plus a 4 GiB appliance reserve, and the floor equals the ceiling
because below it the ~1.5 GiB heap and the 1.75 GiB memory-mapped weights no
longer fit side by side: with the weights charged to the container, a 30 s
decode peaked at 3.08 GB under a 3 GiB cap (142 MB left, reclaim already
starting) and at 2.96 GB under 4 GiB (~1.1 GiB headroom, no reclaim, no OOM).
It is not a sustained host reservation: other services can consume RAM later.
Current live appliance headroom and recognition latency have not been measured
by this PR. Never lower the startup guard merely to make a resource-constrained
deployment turn green. The service decodes one second of silence after loading
and before it listens, so a ready healthcheck means the decoder pages are
resident: loading touches only ~0.7 GiB of the weights, and without the
warm-up the first turn after a restart paged in the other ~0.8 GiB itself
(3.1 s instead of 1.9 s for a 1 s clip with the weights on the workstation
VM's disk, 5-10 s through a slow mount; the warm-up itself took 4-6 s cold
there, inside the 180 s healthcheck start period).

Before deploying to a box, measure with the main LLM, Frigate cameras, indexing
and normal services running. Require at least 4 GiB `MemAvailable` after model
warmup and during repeated 30-second utterances, no swap growth/OOM events,
healthy model readiness, and unchanged GPU VRAM consumption attributable to
speech. For the Qwen container, record `/proc/<server pid>/status` (`VmHWM`,
`RssAnon`, `RssFile`) and `/sys/fs/cgroup/memory.stat` (`pgscan_direct`,
`workingset_refault_file`) before and after 20 repeated 30-second utterances
plus one concurrent pair: pass is `VmHWM` at most 3.0 GiB, no
`workingset_refault_file` growth, `pgscan_direct` 0 at the 4 GiB cap,
`OOMKilled=false`, and the `MemAvailable` floor above. `memory.peak` alone is
not an acceptance number: it depends on which cgroup the weight pages were
charged to when they were first read (1.58-2.87 GiB observed for the same
workload). Also record the first turn after a container restart. Check cold
startup and repeated turns, missed/false “Hey Droplet” wakes, English names,
noisy/distant speech, Bluetooth dictation, selected-voice persistence,
previews, and dangerous-action confirmation. Record median/p95 STT time and
end-of-speech-to-first-spoken-reply time on the actual box. Local synthetic
speech smoke tests establish integration, not microphone acceptance or a
latency guarantee.

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

The image no longer carries the 1.7B weights: returning to Qwen3-ASR-1.7B is a
rebuild from the commit before this switch (its `download_model.py` pins,
`QWEN_MEM_LIMIT=10g`, `QWEN_MIN_AVAILABLE_GIB=14`), not an environment change;
the Whisper profile remains the runtime rollback.
