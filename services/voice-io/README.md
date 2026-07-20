# voice-io

The Droplet's always-on voice assistant. Captures mic audio, runs a
wake-word detector, streams to local STT, hands the transcript to the
existing orchestrator agent loop (`/api/llm/chat` — same 50-tool
surface the dashboard chat uses), then pipes the streamed response
through local TTS to the speaker.

**Everything on-device.** No cloud wake-word service, no cloud STT, no
cloud TTS. Matches the same privacy positioning the wizard's AI step
makes (*"Your conversations stay on this Droplet"*).

Jira: [WARP-154](https://warp-lab.atlassian.net/browse/WARP-154).

## Hardware compatibility

The service is built to run on any Linux host with ALSA-accessible
audio. The hardware-detection layer (`voice/devices.py`) discovers
devices at runtime and picks defaults — no compile-time config tied
to a specific board.

### Tested / supported configurations

| Setup | Mic | Speaker | Notes |
|---|---|---|---|
| **POC box (x86 Ryzen)** | Onboard Realtek ALC662 3.5mm mic jack, OR USB headset / mic plugged in | Onboard line-out / HDMI audio out / USB speaker | 3 ALSA cards visible (HDMI dGPU, ALC662 onboard, secondary AMD HDA). Service auto-prefers USB if present. |
| **POC + ReSpeaker 4-Mic USB array** | ReSpeaker (4 mics, hardware echo cancellation) | Any USB or 3.5mm speaker | The intended POC config. Auto-detected by USB vendor + name match. |
| **Production v2.6 (appliance + I/O Brick)** | I²S codec on I/O Brick (TBD — Stefan's HW pass) | I²S codec output (or HDMI / USB) | The I/O Brick presents as a standard ALSA card; same discovery code path. |
| **Generic Linux dev box** | Any USB headset | Built-in or USB speaker | Works out of the box. Useful for component-level testing on a laptop. |

### Why hardware-agnostic

- POC and v2.6 production have different audio paths. Hardcoding either
  would mean two voice services.
- Customer-supplied USB mics (we don't control what they plug in) need
  to "just work".
- Future revisions may swap codecs without rewriting voice code.

### Device-selection algorithm

`voice/devices.py:resolve_devices()` runs at startup:

1. Enumerate every ALSA device via `sounddevice.query_devices()`.
2. Cross-reference each ALSA card with `/sys/class/sound/cardN/` to
   discover whether it's a USB device (has `device/idVendor`), a PCI
   device, or something else.
3. Score each candidate input (mic-side):
   - **+200** if the card is on USB bus (USB headsets, ReSpeaker, etc.)
   - **+100** if the device name matches `/respeaker|mic.array|webcam|headset/i`
   - **+50** if the device name contains "mic"
   - **0** otherwise (typical line-in / onboard codec)
   - **-100** if name matches `/hdmi|monitor|loopback|null/i` (clearly not mics)
4. Score each candidate output (speaker-side):
   - **+150** if the card is on USB bus
   - **+50** if name contains "speaker" or "headphone"
   - **0** otherwise
   - **-100** if HDMI (we don't drive monitors as speakers in this app)
5. Pick the highest-scored input + output as defaults.
6. **Env overrides win**: `VOICE_INPUT_DEVICE=hw:2,0` or
   `VOICE_OUTPUT_DEVICE=plughw:1,0` skip the auto-pick entirely. Useful
   when an operator wants to pin specific hardware (production v2.6).

If no input device is available — service starts in "no-mic" mode:
- `/health` reports `inputAvailable: false`.
- `/audio/devices` lists what was seen so the dashboard can suggest
  plugging in a mic.
- No wake-word loop runs; the rest of the service stays up so a hot-
  plugged mic can flip the state without a restart.

### Hot-plug support

`sounddevice` re-enumerates devices on each `query_devices()` call.
The service polls the device list every 5 s (`DEVICE_RESCAN_INTERVAL`
env). When a new input appears that beats the current pick, the
capture loop restarts against it. Useful for the customer plugging a
USB mic in after the box has already booted.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `VOICE_INPUT_DEVICE` | *(auto)* | Pin a specific ALSA device for input (e.g. `hw:2,0`, `default`, or the integer index from `/audio/devices`). |
| `VOICE_OUTPUT_DEVICE` | *(auto)* | Same, for output. |
| `VOICE_SAMPLE_RATE` | `16000` | Mic capture rate. 16 kHz is what faster-whisper expects natively. |
| `VOICE_FRAME_MS` | `30` | Frame duration in ms for capture buffers. 30 ms is the sweet spot for openWakeWord. |
| `DEVICE_RESCAN_INTERVAL` | `5` | Seconds between hot-plug rescans. |
| `ORCHESTRATOR_URL` | `http://orchestrator:3000` | Where to POST chat turns. |
| `ORCHESTRATOR_TOKEN` | *(empty)* | Bearer token for orchestrator. Set in compose from the same secret the rest of the stack uses. |
| `WAKE_ENGINE` | `vosk` | Which wake-word backend to use. `vosk` (default) recognizes the `WAKE_WORD` phrase out of the box via a grammar-constrained Vosk model — no per-phrase training, no licensing fee — so "hey droplet" works on every box. `openwakeword` uses the bundled-ONNX engine (`hey_jarvis`/`alexa`/`hey_mycroft`) instead. If `vosk` is selected but its model dir is missing, the service automatically falls back to openWakeWord so wake stays armed. |
| `WAKE_WORD` | `hey_droplet` | The wake phrase. Under the default `vosk` engine it's recognized directly (underscores map to spaces: `hey_droplet` → "hey droplet"); any in-vocabulary English phrase works with no training. Under `openwakeword` it must be a bundled model name (`hey_jarvis`, `alexa`, `hey_mycroft`) or a custom `<name>.onnx` in `/app/models/`. Set to `__mock__` for a dev box with no wake runtime. |
| `VOSK_MODEL_PATH` | `/app/models/vosk-model-small-en-us` | Directory of the Vosk model (baked into the image by the Dockerfile). Override to point at a larger/different Vosk model. |
| `WAKE_THRESHOLD` | engine-aware (`0.7` vosk / `0.3` openWakeWord) | Detector confidence threshold (0 – 1). Unset/empty picks a default that matches the engine's score semantics (`resolve_wake_threshold` in `main.py`). Under `vosk` the score is the **minimum per-word confidence** of the finalized phrase match — a partial-hypothesis match is flushed (`FinalResult`) and re-checked before it may fire, and a match with no per-word confidence evidence never fires — so a genuinely spoken "hey droplet" scores ~0.9+ while TV/ambient speech shoehorned into the grammar lands lower; `0.7` gates the false accepts. Lower it toward `0.5` if real wakes get missed at distance; raise it if false wakes persist. openWakeWord scores are sigmoid outputs — its default stays `0.3`. |
| `WAKE_DEBOUNCE_S` | `2.0` | Minimum seconds between wake events. A single utterance triggers many above-threshold frames; debounce coalesces them. |
| `STT_URL` | `tcp://wyoming-faster-whisper:10300` | Wyoming-protocol Whisper server. The compose stack ships `wyoming-faster-whisper` as a sibling container on this URL. Set to `__mock__` to disable STT (wake fires but no transcription). |
| `STT_LANGUAGE` | `en` | Language code for transcription. |
| `STT_MAX_RECORD_S` | `3.0` | **Hard cap** on seconds of audio captured per wake. The end-of-speech VAD ends the capture sooner once you stop talking; this cap guarantees it always stops — even in a room with continuous background audio where no silence is ever detected. Kept short so the box doesn't feel like it "keeps listening". |
| `TTS_URL` | `tcp://wyoming-piper:10200` | Wyoming-protocol Piper server. Set to `__mock__` for silent playback (dev box without a Piper container). |
| `TTS_VOICE` | `en_US-ryan-medium` | Piper voice name. ~70 MB per voice; downloads on first request and caches in the `piper-voices` volume. Other natural-sounding options: `en_US-lessac-medium`, `en_GB-jenny-medium`. |
| `VOICE_FLATLINE_WINDOW_S` | `240` | Flatline watchdog (WARP-1037): seconds of at/near-digital-zero input while `state=listening` before `/health` degrades to 503. The ReSpeaker XVF3800's XMOS DSP can wedge with the USB stream still open — the pipeline keeps "listening" while every frame is pure silence. The pipeline measures a rolling input RMS inside its own frame handler (never a second stream on the same hw device) and flags the wedge so the Docker healthcheck + ops-console see it. Recovery is automatic when audio returns. `0` disables. |
| `VOICE_FLATLINE_DBFS` | `-70.0` | Level (dBFS) below which a frame counts as "no signal" for the flatline watchdog. A healthy capture chain's noise floor sits ≈ -60…-50 dBFS; a wedged DSP emits exact zeros (-120 floor) or ±1-count dither (≈ -90). |
| `VOICE_MAX_TOKENS` | `1024` | **Voice turn shaping (WARP-1432).** Per-turn generation cap sent to the orchestrator on every reply. The box's `gpt-oss` voice model spends reasoning-channel tokens *before* visible content, so the default is deliberately generous — enough for reasoning + a short spoken sentence; too low empties the reply (WARP-854). The gateway hard-caps at 4096; a non-numeric or out-of-range value falls back to `1024`. Voice also always sends `ephemeral:true` (a constant, not an env — voice has no persisted chat session, so a per-utterance `ChatSession` would only litter the sidebar). |
| `VOICE_ALLOWED_TOOLS` | *(curated default)* | **Voice turn shaping (WARP-1432).** Comma-separated tool names the assistant may use on tool-enabled turns. Empty (default) sends a curated scope — box health, cameras, network, files, smart devices + `control_device`, calendar, reminders — instead of the full ~43-tool set, cutting schema prefill from ~5k to ~1–1.5k tokens/turn. Whitespace and empty segments are ignored; an all-empty value falls back to the default. The greeting fast path (`tool_choice="none"`) sends zero tools regardless. |
| `LOG_LEVEL` | `INFO` | Standard Python logging level. |

## Control API

FastAPI app on port 8086 (internal-only; orchestrator + dashboard
reach it via the Docker network).

| Path | Method | Returns |
|---|---|---|
| `/health` | GET | `{ ok, inputAvailable, outputAvailable, state, wakeLoaded, sttLoaded, ttsLoaded, llmLoaded, inputRmsDbfs, lastAudioAt, inputFlatlined }`. Returns 503 with `ok:false` when the pipeline is stuck-and-deaf: `state` ∈ `error\|no_mic`, or `inputFlatlined` (input at/near digital zero for `VOICE_FLATLINE_WINDOW_S` while listening — the wedged-DSP signature). |
| `/audio/devices` | GET | List of all detected ALSA devices with their score + the current pick |
| `/audio/test-tone` | POST | Play a 440 Hz sine wave through the picked output device for 1 s. For "is my speaker wired right" debug. |
| `/audio/test-record` | POST | Capture 2 s from the picked input, return RMS + peak level. For "is my mic working" debug. |
| `/voice/status` | GET | Pipeline snapshot: `state` ∈ `idle\|loading\|listening\|wake_detected\|transcribing\|transcript_ready\|speaking\|error\|no_mic`, plus `wake_model`, `threshold`, `last_wake_at`, `last_wake_score`, `stt_loaded`, `last_transcript`, `last_transcript_at`, `tts_loaded`, `last_response`, `last_response_at`, `input_rms_dbfs` (rolling mic level over ~2 s, measured inside the pipeline's frame handler — safe to drive a live level meter), `last_audio_at`, `input_flatlined`. Read-only; safe to poll. |
| `/voice/say` | POST | `{"text":"hello world","voice":"en_US-ryan-medium"}` — synthesize + play through the picked speaker. Test endpoint until commit 7 wires the LLM-reply path. Returns `{ok, duration_s, sample_rate}`. |

## Running on the POC box

The host's `droplet` user is not in the `audio` group by default. The
container fixes this by joining `audio` (GID 29 inside, mapped to
host's `/dev/snd` permissions via the compose `group_add`).

```
sudo docker compose up -d voice-io
sudo docker compose logs -f voice-io
curl http://127.0.0.1:8086/audio/devices
```

The orchestrator proxies a dashboard-facing `/api/voice/*` shell so
you don't expose 8086 externally.

## What lands in each commit

This README ships in commit 1; the layered functionality is broken
into stacked commits per `docs/voice-assistant-plan.md`:

1. **Foundation** — hardware detection, audio I/O, FastAPI shell,
   Docker. `/audio/devices`, `/audio/test-tone`, `/audio/test-record`
   work without any wake/STT/TTS.
2. **Wake word** — wake-word detection loop on a background thread;
   `/voice/status` surfaces state. The default `vosk` engine recognizes
   the branded "hey droplet" phrase out of the box (no per-phrase
   training, no licensing fee); `openwakeword` (`hey_jarvis` et al.) is
   available as an alternative and the automatic fallback. Pluggable
   `WakeWordDetector` backends live in `voice/wake.py`.
3. **STT** — wyoming-faster-whisper sidecar container speaks Wyoming
   protocol over TCP. After wake, voice-io streams the next
   5 s of mic audio (fixed window — VAD-based cutoff in a follow-up),
   receives the transcript, exposes it via
   `/voice/status.last_transcript`.
4. **TTS** (this commit) — wyoming-piper sidecar speaks Wyoming
   protocol on TCP/10200. `pipeline.speak(text)` synthesizes + plays
   through the picked speaker; surface via `POST /voice/say` (testing)
   and `pipeline.speak()` (commit 7 wires it to the LLM reply).
5. **Agent glue** — pipeline.py wires capture → wake → STT → LLM →
   TTS → playback. Adds the four voice-control LLM tools
   (`set_volume`, `mute_mic`, `change_voice`, `mic_status`) called
   out by WARP-154.
6. **Dashboard UI** — voice settings page in `apps/web-dashboard`.
   Mic-test button, wake-word selector, volume, voice picker.

## Why no PulseAudio / PipeWire

We could route through PulseAudio or PipeWire for higher-level mixing.
We don't, on purpose:

- Adds a system-wide daemon to manage with `systemctl`.
- Mixing isn't a feature we need — exactly one process (this service)
  is responsible for capture + playback.
- ALSA-direct is simpler for `docker run` + `/dev/snd` passthrough.

If a future feature needs a shared audio surface (multiple processes
playing simultaneously) we'll add PipeWire as a sidecar.
