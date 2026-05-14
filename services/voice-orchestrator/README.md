# voice-orchestrator

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
| **Production v2.6 (Jetson + I/O Brick)** | I²S codec on I/O Brick (TBD — Stefan's HW pass) | I²S codec output (or HDMI / USB) | The I/O Brick presents as a standard ALSA card; same discovery code path. |
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
| `WAKE_WORD` | `hey_jarvis` | Wake-word model name. openWakeWord ships several bundled models — `hey_jarvis`, `alexa`, `hey_mycroft`. To use a custom-trained model, drop `<name>.onnx` into `/app/models/` and set `WAKE_WORD=<name>`. The custom "Hey Droplet" model ships once Stefan's training data lands; until then the default is `hey_jarvis` for dev. Set to `__mock__` for a dev box with no real wake model. |
| `WAKE_THRESHOLD` | `0.5` | Detector confidence threshold (0 – 1). Raise to reduce false-positives. |
| `WAKE_DEBOUNCE_S` | `2.0` | Minimum seconds between wake events. A single utterance triggers many above-threshold frames; debounce coalesces them. |
| `LOG_LEVEL` | `INFO` | Standard Python logging level. |

## Control API

FastAPI app on port 8086 (internal-only; orchestrator + dashboard
reach it via the Docker network).

| Path | Method | Returns |
|---|---|---|
| `/health` | GET | `{ ok, inputAvailable, outputAvailable, wakeLoaded, sttLoaded, ttsLoaded }` |
| `/audio/devices` | GET | List of all detected ALSA devices with their score + the current pick |
| `/audio/test-tone` | POST | Play a 440 Hz sine wave through the picked output device for 1 s. For "is my speaker wired right" debug. |
| `/audio/test-record` | POST | Capture 2 s from the picked input, return RMS + peak level. For "is my mic working" debug. |
| `/voice/status` | GET | Wake pipeline snapshot: `state` ∈ `idle\|loading\|listening\|wake_detected\|error\|no_mic`, plus `wake_model`, `threshold`, `last_wake_at`, `last_wake_score`. Read-only; safe to poll. |

## Running on the POC box

The host's `droplet` user is not in the `audio` group by default. The
container fixes this by joining `audio` (GID 29 inside, mapped to
host's `/dev/snd` permissions via the compose `group_add`).

```
sudo docker compose up -d voice-orchestrator
sudo docker compose logs -f voice-orchestrator
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
2. **openWakeWord** (this commit) — wake-word detection loop on a
   background thread; `/voice/status` surfaces state. Default wake
   word `hey_jarvis` ships pre-baked in the image; custom
   "Hey Droplet" `.onnx` swaps in later once Stefan has training
   data ready.
3. **STT** — wyoming-faster-whisper integration, reusing the same
   model files `services/file-indexer` already has on disk.
4. **TTS** — Piper for the response audio.
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
