# voice-io

The Droplet's always-on voice assistant. Captures mic audio, runs a
wake-word detector, streams to local STT, hands the transcript to the
existing orchestrator agent loop (`/api/llm/chat` — the same agent loop
the dashboard chat uses, scoped to a curated voice tool set via
`VOICE_ALLOWED_TOOLS`; see Configuration), then pipes the streamed
response through local TTS to the speaker.

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
| `WAKE_ENGINE` | `vosk` | Which wake-word backend to use. `vosk` (default) recognizes the `WAKE_WORD` phrases out of the box via a grammar-constrained Vosk model — no per-phrase training, no licensing fee — so "droplet" and "hey droplet" both work on every box. `openwakeword` uses the bundled-ONNX engine (`hey_jarvis`/`alexa`/`hey_mycroft`) instead. If `vosk` is selected but its model dir is missing, the service automatically falls back to openWakeWord so wake stays armed. |
| `WAKE_WORD` | `hey droplet` | The wake phrase(s) — a **comma-separated list**; the box wakes on ANY of them (WARP-1431). Default wakes on "Hey Droplet" only. The bare one-word "droplet" is left out on purpose: grammar-forced decoding squeezes ambient speech into it at confidence up to 1.00, so no threshold filters it (~23 false wakes/hour on the bench, WARP-3128). Opt back in with `droplet,hey droplet`. Under the default `vosk` engine each phrase is recognized directly (underscores map to spaces: `hey_droplet` → "hey droplet"); any in-vocabulary English phrase works with no training. Under `openwakeword` (single-model) only the **first** phrase is used and must be a bundled model name (`hey_jarvis`, `alexa`, `hey_mycroft`) or a custom `<name>.onnx` in `/app/models/`. Set to `__mock__` for a dev box with no wake runtime. |
| `VOSK_MODEL_PATH` | `/app/models/vosk-model-small-en-us` | Directory of the Vosk model (baked into the image by the Dockerfile). Override to point at a larger/different Vosk model. |
| `WAKE_THRESHOLD` | engine-aware (`0.85` vosk / `0.3` openWakeWord) | Detector confidence threshold (0 – 1). Unset/empty picks a default that matches the engine's score semantics (`resolve_wake_threshold` in `main.py`). Under `vosk` the score is the **minimum per-word confidence** of the finalized phrase match — a partial-hypothesis match is flushed (`FinalResult`) and re-checked before it may fire, and a match with no per-word confidence evidence never fires — so a genuinely spoken "hey droplet" scores ~0.9+ while TV/ambient speech shoehorned into the grammar lands lower; `0.85` gates the false accepts (raised from `0.7` in WARP-3128 after ambient speech cleared it at 0.73–0.94). Lower it toward `0.5` if real wakes get missed at distance; raise it if false wakes persist. openWakeWord scores are sigmoid outputs — its default stays `0.3`. |
| `WAKE_DEBOUNCE_S` | `2.0` | Minimum seconds between wake events. A single utterance triggers many above-threshold frames; debounce coalesces them. |
| `STT_URL` | `tcp://wyoming-faster-whisper:10300` | Wyoming-protocol Whisper server. The compose stack ships `wyoming-faster-whisper` as a sibling container on this URL. Set to `__mock__` to disable STT (wake fires but no transcription). |
| `STT_LANGUAGE` | `en` | Language code for transcription. |
| `STT_MAX_RECORD_S` | `5.0` | **Hard cap** on seconds of audio captured per wake. The end-of-speech VAD ends the capture sooner once you stop talking; this cap guarantees it always stops — even in a room with continuous background audio where no silence is ever detected. `5.0` is the single source of truth (code default + compose + the overview doc all agree, and the box runs 5.0). |
| `WHISPER_CPUS` | `4.0` | **Whisper sidecar setting (WARP-3126).** voice-io does not read this; compose applies it as the `wyoming-faster-whisper` container's CPU quota. Raised from `2.0` because transcription runs after you stop talking and before the reply starts, so more cores shorten every turn. Keep it equal to `WHISPER_CPU_THREADS`. On a CPU-tight host lower both together, because Frigate and the inference runtime share the cores. STT is CPU-only. |
| `WHISPER_CPU_THREADS` | `4` | **Whisper sidecar setting (WARP-3126).** voice-io does not read this; it is the sidecar's CTranslate2 `--cpu-threads`. It must equal `WHISPER_CPUS` (WARP-1434): more threads than cores only adds context-switch churn, and fewer leaves part of the quota idle. |
| `VAD_SILENCE_S` | `0.6` | End-of-speech VAD: seconds of trailing silence that end the capture once the user has started talking, so the box stops the moment they finish rather than always holding the mic for the full `STT_MAX_RECORD_S`. Raise it if the box cuts people off during a natural mid-sentence pause. |
| `VAD_SPEECH_RMS` | `700` | int16 frame RMS above which a frame counts as "speech" — sits between a typical room floor (~400) and normal speech (~1000+). **The per-room tuning knob**: lower it in a quiet room where speech reads soft, raise it in a loud one where the floor creeps up. |
| `VAD_MIN_SPEECH_S` | `0.4` | Minimum cumulative speech (s) before end-of-speech may fire, so the wake-word tail plus a pause before the command doesn't end the turn early. |
| `WAKE_VISUAL_DECAY_S` | `2.0` | How long the `wake_detected` / `transcript_ready` UI hints linger on `/voice/status` before decaying back to `listening`, so the dashboard's wake + transcript pulse animations have time to play. |
| `TTS_URL` | `tcp://wyoming-piper:10200` | Wyoming-protocol Piper server. Set to `__mock__` for silent playback (dev box without a Piper container). |
| `TTS_VOICE` | `en_US-ryan-medium` | Piper voice name. ~70 MB per voice; downloads on first request and caches in the `piper-voices` volume. Other natural-sounding options: `en_US-lessac-medium`, `en_GB-jenny-medium`. |
| `VOICE_FLATLINE_WINDOW_S` | `240` | Flatline watchdog (WARP-1037): seconds of at/near-digital-zero input while `state=listening` before `/health` degrades to 503. The ReSpeaker XVF3800's XMOS DSP can wedge with the USB stream still open — the pipeline keeps "listening" while every frame is pure silence. The pipeline measures a rolling input RMS inside its own frame handler (never a second stream on the same hw device) and flags the wedge so the Docker healthcheck + ops-console see it. Recovery is automatic when audio returns. `0` disables. |
| `VOICE_FLATLINE_DBFS` | `-70.0` | Level (dBFS) below which a frame counts as "no signal" for the flatline watchdog. A healthy capture chain's noise floor sits ≈ -60…-50 dBFS; a wedged DSP emits exact zeros (-120 floor) or ±1-count dither (≈ -90). |
| `VOICE_MAX_TOKENS` | `1024` | **Voice turn shaping (WARP-1432).** Per-turn generation cap sent to the orchestrator on every reply. The box's `gpt-oss` voice model spends reasoning-channel tokens *before* visible content, so the default is deliberately generous — enough for reasoning + a short spoken sentence; too low empties the reply (WARP-854). The gateway hard-caps at 4096; a non-numeric or out-of-range value falls back to `1024`. Voice also always sends `ephemeral:true` (a constant, not an env — voice has no persisted chat session, so a per-utterance `ChatSession` would only litter the sidebar). |
| `VOICE_MAX_ITER` | `4` | **Agent-loop step budget (WARP-3316).** Sent to the orchestrator as `max_iter` on every reply. The last iteration is the spoken answer, so the old budget of 2 died on the *second* tool call with the orchestrator's "couldn't finish… within my step limit" fallback; 4 covers up to three tool calls before answering. Clamped to 1..10 (the orchestrator's cap); a non-numeric value falls back to `4`. |
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
| `/voice/status` | GET | Pipeline snapshot: `state` ∈ `idle\|loading\|listening\|wake_detected\|transcribing\|transcript_ready\|speaking\|error\|no_mic`, plus `wake_model`, `threshold`, `last_wake_at`, `last_wake_score`, `stt_loaded`, `last_transcript`, `last_transcript_at`, `tts_loaded`, `last_response`, `last_response_at`, `input_rms_dbfs` (rolling mic level over ~2 s, measured inside the pipeline's frame handler — safe to drive a live level meter), `last_audio_at`, `input_flatlined`, and the speaker volume: `output_level` (0-100), `output_muted`, `output_fault` (a storage fault on the volume file, or null). Read-only; safe to poll. |
| `/voice/say` | POST | `{"text":"hello world","voice":"en_US-ryan-medium"}` — synthesize + play through the picked speaker. Test endpoint until commit 7 wires the LLM-reply path. Returns `{ok, duration_s, sample_rate}`. Plays at the speaker volume; muted means nothing is played. |
| `/voice/volume` | GET | Speaker volume: `{level, muted, fault}`. Works with voice switched off or no mic. See [Speaker volume](#speaker-volume). |
| `/voice/volume` | POST | Exactly one of `{"level": 0-100}`, `{"change": -100..100}` or `{"muted": true\|false}` (strict: no strings, floats or extra keys; anything else is 422). Persists and applies from the next thing the box says; a level change also unmutes, and a negative `change` never lowers it below 10. Returns `{level, muted, fault, previous_level, previous_muted}`. |

## Speaker volume

One output level (0-100) and a mute flag, shared by the HTTP endpoints
above and spoken commands. `voice/volume.py` owns it.

- **Mechanism: software gain.** The int16 PCM is scaled in
  `WakePipeline._play_pcm` — the single playback choke point for replies,
  `/voice/say` and the spoken cues — right before `audio_io.play`. Gain is
  `(level/100)^2`: 100 is exactly today's pre-volume output, 50 is -12 dB,
  10 is -40 dB. It only attenuates, so it cannot clip, and there is no
  "louder than 100". No ALSA mixer is touched, so it behaves the same on
  every output device and survives a DSP reboot.
- **Mute** plays nothing at all (replies and cues), while the pipeline's
  state changes and post-speak cooldown run as usual. Mute never changes
  the level; unmute restores it. The only ways to silence the box are
  `muted: true` and an explicitly requested level 0: a relative decrease
  ("quieter", `{"change": -N}`) stops at 10, or holds a level that was
  explicitly set below 10.
- **Persistence**: `/data/voice-volume.json` (`{"level": 70, "muted":
  false}`) on the `voice-calibration` volume, atomic write, override with
  `VOICE_VOLUME_PATH`. No file means level 100, unmuted (boxes upgrading
  into this keep today's loudness). An unreadable file also means level
  100, unmuted, plus a `fault` on `/voice/volume` and `output_fault` on
  `/voice/status` — a storage fault never silently mutes the box. A factory
  reset sweeps the file, so volume returns to 100.
- **Timing**: the level is read per sentence, so a change during a long
  reply takes effect on the next sentence, not mid-word.
- **By voice** (`voice/intents.py`): whole-utterance commands are handled on
  the box before the LLM — no model round trip, and they work with the LLM
  down. "volume 40 percent" / "set volume to 40" (a bare 0-10 without
  "percent" is the 0-10 scale: "volume 5" is 50), "turn it up/down",
  "louder", "quieter", "softer", "volume up/down" (±10), "a lot louder"
  (±25), "max volume" (100), "minimum volume" (10), "mute", "unmute",
  "what's the volume". The box answers "Volume 40." at the new level, mutes
  silently, and says "Unmuted." at the restored level. Anything naming
  another object ("turn up the thermostat", "turn the TV down") goes to the
  normal turn, and "stop", "quiet", "shut up", "cancel" never mean mute.
- **Not an LLM tool.** There is no `set_volume` tool in the registry, so
  the assistant cannot change volume from a free-form request the
  classifier doesn't match. Adding one widens the voice principal's write
  set (`VOICE_WRITE_TOOLS`, today `{control_device}`) and needs an ADR-004
  amendment first.
- The dashboard reaches it through the orchestrator's owner/admin
  `GET/POST /api/voice/volume` (audited as a `voice` activity row); there
  is no dashboard control yet. `/audio/test-tone` and `/audio/echo-check`
  are hardware diagnostics and stay at their fixed levels.

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
   the branded "Droplet" and "Hey Droplet" phrases out of the box (no
   per-phrase training, no licensing fee) — it fires on either;
   `openwakeword` (`hey_jarvis` et al.) is available as an alternative
   and the automatic fallback. Pluggable `WakeWordDetector` backends live
   in `voice/wake.py`.
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
   out by WARP-154. (None of the four is built. Speaker volume shipped
   without a tool — see [Speaker volume](#speaker-volume).)
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
