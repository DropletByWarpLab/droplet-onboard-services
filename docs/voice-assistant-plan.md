# Voice assistant (WARP-154) — design + commit plan

> Branch: `feat/voice-assistant` off `main`. Target: merge to `main`
> after the wizard branch lands and end-to-end voice works on the
> single-box deployment shape with a USB mic + speaker.

## Goals (from Stefan)

- Open-source. No licensing fees.
- Works with the LLM (already shipped — `/api/llm/chat` agent loop +
  50 tools in `packages/tools-core`).
- Mic and speaker live IN the device — the hardware abstraction must
  handle the single-box shape (x86 + onboard Realtek ALC662, no USB
  audio yet) AND the v2-6 hardware (the appliance + I/O-Brick I²S codec)
  AND any USB headset a dev plugs in.
- "Basically all functionality" — the voice loop talks to the existing
  agent runtime, so anything the LLM can do via text it can do via
  voice for free (file ops, camera control, smart home, VPN
  management, etc.).

## Stack (all MIT / Apache 2.0)

| Layer | Component | Why |
|---|---|---|
| Wake word | [openWakeWord](https://github.com/dscripka/openWakeWord) (Apache 2.0) | Pure Python, CPU-only, ~10 MB models. Custom-trainable. |
| Streaming STT | wyoming-faster-whisper (Apache 2.0) | Reuses the faster-whisper model `services/file-indexer` already loads for WARP-197. Same `small.en` weights, no duplicate disk footprint. |
| TTS | [Piper](https://github.com/rhasspy/piper) (MIT) | Sub-second first-audio on CPU, ~50 MB voice models, multiple voices. |
| Protocol | Wyoming (Apache 2.0) | TCP-based. Lets each component be a separate container, swappable. Home Assistant Voice's protocol — biggest OSS ecosystem in this space. |
| Audio I/O | sounddevice (MIT) + PortAudio | Cross-platform, clean shutdown, native numpy. Better API than PyAudio. |
| Glue | New `services/voice-io/` (this branch) | Captures audio, runs the wake loop, chains the Wyoming services, posts to `/api/llm/chat` (streaming), pipes response through TTS. |

**Privacy**: everything on-device. No cloud wake, no cloud STT, no
cloud TTS. Matches the wizard's AI step messaging.

## Hardware compatibility — the abstraction

`services/voice-io/voice/devices.py` discovers ALSA devices
at runtime, scores them by likely fit for voice (USB > I²S codec on
platform bus > onboard PCI codec > HDMI), and picks defaults. Full
docs in `services/voice-io/README.md` §"Hardware
compatibility".

Real configurations the abstraction explicitly handles (with unit
tests under `tests/test_devices.py::TestRealHardwareScenarios`):

1. **Single-box (x86 Ryzen)** — `aplay -l` shows 3 onboard PCI cards
   (HDMI dGPU, ALC662 codec, secondary AMD HDA). No USB mic plugged
   in yet. Resolution: picks ALC662 input + onboard analog output.
   Service runs in "no-mic mode" if the customer never plugs anything
   in (graceful failure, `/health` reports `inputAvailable: false`).
2. **Single-box + ReSpeaker 4-Mic USB array** — same hardware plus the
   USB array Stefan's ordered. Resolution: USB array wins for input on
   score, onboard codec wins for output (or USB speaker if also plugged
   in).
3. **v2-6 (appliance + I/O Brick)** — I²S codec on platform bus.
   Resolution: platform-bus codec wins both ways. Same code path, no
   special case.
4. **Generic dev box** — laptop with onboard audio + USB headset.
   Resolution: USB headset wins both ways.

Env overrides (`VOICE_INPUT_DEVICE` / `VOICE_OUTPUT_DEVICE`) skip the
auto-pick entirely — operators pin specific hardware for production.

## Commit plan

| # | Scope | Status |
|---|---|---|
| **1** | **Foundation**: device discovery, scoring, audio I/O wrappers, FastAPI shell with /health + /audio/devices + test-tone + test-record, Dockerfile (Python 3.12 + libportaudio2 + alsa-utils), docker-compose entry (linux profile, /dev/snd passthrough, audio group), README + this plan doc, comprehensive pytest coverage. | **THIS COMMIT** |
| 2 | openWakeWord integration. Default wake word ("hey_jarvis" — bundled with openWakeWord) for dev. Wake-word loop on a background thread. `/voice/status` endpoint. | next |
| 3 | STT via Wyoming-protocol faster-whisper. Reuses model files on disk from file-indexer. | next |
| 4 | TTS via Piper. Voice picker (Piper has multiple voices). | next |
| 5 | Pipeline glue. Capture → wake → STT → POST /api/llm/chat (stream:true) → TTS → playback. Plus 4 voice-control LLM tools per WARP-154's scope (`set_volume`, `mute_mic`, `change_voice`, `mic_status`). | next |
| 6 | Dashboard settings page (`/settings/voice` or similar). Mic test, speaker test, wake word selector, voice selector, volume, on/off. | next |
| 7 (separate, time-boxed) | Custom "Hey Droplet" wake word — train an openWakeWord model from Stefan's recordings. Swap in via `WAKE_WORD=hey_droplet` env. | when Stefan ships recordings |

## API surface (commit 1)

All routes mounted on the voice-io container at port 8086.
Not exposed to the host; orchestrator's `/api/voice/*` proxies (later
commit).

```
GET  /health
GET  /audio/devices[?refresh=1]
POST /audio/test-tone[?duration_s=1.0&frequency_hz=440]
POST /audio/test-record[?duration_s=2.0]
```

## What this commit deliberately does NOT do

- Run any wake-word, STT, or TTS code. Just the audio I/O foundation.
- Talk to the orchestrator. (Commits 5–6 wire it.)
- Expose anything via the dashboard. (Commit 6.)
- Train a custom wake word. (Separate workstream, gated on Stefan's
  recordings.)

## What it MUST do, and the tests that prove it

- Enumerate audio devices on any of the four target hardware configs
  without throwing. → `TestRealHardwareScenarios` (4 tests).
- Pick the right device on each config. → same 4 tests assert on the
  picked device's `bus` + `name`.
- Honour env overrides verbatim (no silent fallback if the override
  doesn't match). → `TestResolveDevices::test_env_override_miss_falls_through_to_none`.
- Survive sounddevice / PortAudio being unavailable. →
  `TestEnumerateDevices::test_returns_empty_list_when_sounddevice_missing`.
- Survive zero detected devices. →
  `TestResolveDevices::test_empty_device_list_resolves_cleanly`.
- Distinguish USB / PCI / platform / unknown buses. → `TestDetectBus`
  (5 tests).

## On-device verification (post-commit)

The single-box host (`droplet-sys`, x86 Ryzen, no USB mic plugged in yet):

1. SFTP `services/voice-io/` to the host.
2. `docker compose --profile linux build voice-io`.
3. `docker compose --profile linux up -d voice-io`.
4. `curl http://127.0.0.1:8086/health` → expect
   `{"ok": true, "inputAvailable": true, "outputAvailable": true, ...}` if
   the onboard ALC662 is unmuted and connected, or
   `inputAvailable: false` if not.
5. `curl http://127.0.0.1:8086/audio/devices` → expect the three onboard
   cards listed with scores, plus the resolution.
6. After ReSpeaker arrives: plug in, `curl /audio/devices?refresh=1`
   should show it with the highest input score.
