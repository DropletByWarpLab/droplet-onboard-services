# Voice service

FastAPI app exposing speech-to-text, text-to-speech, and hardware-mute
control for the Droplet edge appliance. The orchestrator's LLM tool
registry wraps this service so the local model can speak responses, hear
the user (push-to-talk), and toggle the mic mute on demand.

## Architecture

```
┌──────────────┐    HTTP    ┌──────────────┐
│ orchestrator │──────────► │ voice (8090) │
│  LLM tools   │            │   FastAPI    │
└──────────────┘            └───┬────┬─────┘
                                │    │
                       ┌────────┘    └─────────┐
                       ▼                       ▼
                ┌──────────┐           ┌──────────────┐
                │  audio   │           │  STT / TTS   │
                │ (alsa /  │           │ (faster-     │
                │  mock)   │           │  whisper /   │
                └──────────┘           │  piper)      │
                       │               └──────────────┘
                       ▼
                ┌──────────┐
                │   GPIO   │
                │ (jetson  │
                │  / noop) │
                └──────────┘
```

Every backend has a `mock` / `noop` default so the service boots cleanly
on a fresh device with no sound card and no GPIO wired. Flip to real
hardware by setting env vars (see below).

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET  | `/health` | Liveness — returns active backends + state |
| GET  | `/state` | Current state machine (`idle`/`listening`/`processing`/`speaking`/`muted`) |
| POST | `/listen?seconds=5` | Capture mic for N seconds, transcribe, return text |
| POST | `/transcribe` | Transcribe an uploaded WAV (no capture) |
| POST | `/speak?play=true` | Synthesize text. `play=true` plays it; otherwise returns WAV blob |
| POST | `/mute` | Force `muted` state. Cuts mic VDD via GPIO if configured |
| POST | `/unmute` | Return to `idle` |

When `VOICE_TOKEN` is set in the env, all POST endpoints require
`Authorization: Bearer <token>`. GET endpoints stay public so the dashboard
can poll `/state` and `/health` without a token.

## State machine

```
       ┌───────────►  muted ◄───────────┐
       │                ▲               │
   /mute               /mute            /mute
       │                │               │
       │       /listen  │       /speak  │
     idle ──────────► listening    idle ──► speaking ──► idle
       ▲                  │
       │                  ▼
       │              processing
       └──────────────────┘
```

State transitions are validated. Mute is reachable from any state via
`force()` so the operator can always cut the mic regardless of what's in
flight.

## Configuration

All env vars optional. Defaults are the safe / mock options.

### Audio

| Var | Default | Description |
|---|---|---|
| `VOICE_AUDIO_BACKEND` | `mock` | `mock` or `alsa` |
| `VOICE_SAMPLE_RATE_HZ` | `16000` | Capture rate |
| `VOICE_MIC_DEVICE` | unset | ALSA device for mic, e.g. `hw:1,0`. From `arecord -l` |
| `VOICE_SPEAKER_DEVICE` | unset | ALSA device for speaker, from `aplay -l` |
| `VOICE_MIC_CHANNELS` | `1` | Mono only for v1 |

### STT (speech → text)

| Var | Default | Description |
|---|---|---|
| `VOICE_STT_BACKEND` | `mock` | `mock` or `whisper` |
| `VOICE_WHISPER_MODEL` | `tiny.en` | `tiny.en`/`base.en`/`small.en` or path |
| `VOICE_WHISPER_DEVICE` | `auto` | `cpu`/`cuda`/`auto` |

### TTS (text → speech)

| Var | Default | Description |
|---|---|---|
| `VOICE_TTS_BACKEND` | `mock` | `mock` or `piper` |
| `VOICE_PIPER_VOICE` | `en_US-amy-low` | Voice model name (file at `/data/voices/<name>.onnx`) |

### GPIO

| Var | Default | Description |
|---|---|---|
| `VOICE_GPIO_BACKEND` | `noop` | `noop` or `jetson` |
| `VOICE_MIC_MUTE_GPIO` | unset | Board-pin number for the MOSFET on the mic VDD line. **HIGH = power CUT (muted)**. Inverted on the wire so the safe state is "muted" if the pin floats |
| `VOICE_MUTE_LED_GPIO` | unset | Board-pin for the red mute LED |
| `VOICE_PTT_BUTTON_GPIO` | unset | Board-pin for the push-to-talk button (active-low, with pull-up) |

### Auth

| Var | Default | Description |
|---|---|---|
| `VOICE_TOKEN` | unset | When set, all POST endpoints require `Authorization: Bearer <token>` |

## Hardware wiring (when ready)

The software is built to be hardware-agnostic — the user maps physical pins
later. When you're ready:

1. **Mic** — recommend ReSpeaker 4-Mic Array via I2S (best for a noisy room)
   or Adafruit SPH0645 (single mic, cheaper). Both expose as ALSA devices on
   the Jetson once the I2S overlay is enabled. Set `VOICE_MIC_DEVICE` to
   the `hw:N,M` from `arecord -l`.

2. **Speaker** — MAX98357A I2S amp + 3W speaker. Same I2S bus as the mic
   (bidirectional). Set `VOICE_SPEAKER_DEVICE` from `aplay -l`.

3. **Mute MOSFET** — N-channel MOSFET (e.g. AO3400) in series with the mic's
   3.3V VDD line. Gate driven by `VOICE_MIC_MUTE_GPIO` board pin. Source to
   ground, drain to mic VDD. The wiring is INVERTED: pin HIGH cuts power
   (= muted). This is the safe-by-default choice — if the pin floats or the
   service crashes, the mic ends up unpowered.

4. **Mute LED** — red LED + 220Ω resistor between `VOICE_MUTE_LED_GPIO`
   board pin and ground. Lit = muted.

5. **PTT button** — momentary button between `VOICE_PTT_BUTTON_GPIO` board
   pin and ground. Internal pull-up enabled in software. 200ms debounce.

The mute MOSFET is the security-relevant piece — it ensures that "muted"
in the UI corresponds to actual physical power-cut to the microphone, not
just a software flag the LLM could conceivably bypass via a different code
path.

## Running locally (dev)

```bash
# Mock backends — no hardware needed
cd services/voice
pip install -r requirements.txt
uvicorn main:app --reload --port 8090

# Smoke test
curl http://localhost:8090/health
curl -X POST 'http://localhost:8090/listen?seconds=2'
curl -X POST http://localhost:8090/speak \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello from droplet"}' --output speech.wav
```

## Running in compose

```bash
COMPOSE_PROFILES=voice docker compose -f docker/docker-compose.yml up -d voice
docker compose logs -f voice
```

## Running natively on the Jetson (preferred for real hardware)

The systemd unit at `services/voice/droplet-voice.service` gives clean
access to `/dev/snd` and `/dev/gpiochip*` without container plumbing.

```bash
sudo cp -r services/voice /opt/droplet-voice
sudo cp services/voice/droplet-voice.service /etc/systemd/system/
sudo cp services/voice/voice.env.example /etc/droplet/voice.env  # then edit
sudo systemctl daemon-reload
sudo systemctl enable --now droplet-voice
journalctl -u droplet-voice -f
```

## Tests

```bash
cd services/voice
pip install -r requirements.txt
pytest tests/ -v
```

Tests run entirely on the mock backends — no audio hardware required.
