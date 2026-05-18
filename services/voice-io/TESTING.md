# voice-io — testing

Three layers, all part of the project's standard check flow:

| Layer | What it covers | Where it runs |
|---|---|---|
| **Pytest unit tests** | `voice/devices.py` discovery + scoring + `resolve_devices()` with simulated hardware. No real audio needed. | Local (`pytest tests/`), in the container (`docker compose run voice-io pytest tests/`), and CI (`.github/workflows/voice-io-tests.yml`). |
| **Container healthcheck** | The service's `/health` endpoint replies 200 ok. Reported by `docker ps`. Interval 15 s, 3 retries before unhealthy. | The Docker engine on whatever host the service runs on. |
| **`scripts/verify.sh` smoke** | Curls the in-container `/health` end-to-end, asserts `inputAvailable` matches reality (passes when a mic IS connected, warns when not). | Locally via `./scripts/verify.sh`, or as part of `setup.sh --verify`. |

## Running pytest

### Locally (fast, no Docker)

```
cd services/voice-io
pip install -r requirements-dev.txt
pytest -v
```

141 tests across `tests/test_devices.py`, `tests/test_wake.py`,
`tests/test_pipeline.py`, `tests/test_stt.py`, `tests/test_tts.py`.
Sub-second to ~10 s total. No real audio hardware or Wyoming servers
required — the fixtures inject:

  - a fake `sounddevice` module + a synthetic `/sys/class/sound` tree
    under `tmp_path` (device discovery tests)
  - mock detectors that replay scripted scores (wake tests)
  - a scripted fake sounddevice stream (pipeline _loop tests)
  - an in-process Wyoming-protocol server on an ephemeral port that
    speaks the real wire format (STT and TTS tests; both share the
    JSON-frame parser in stt.py)
  - a monkeypatched `voice.audio_io.play` recorder for speak() tests
    (no actual PortAudio call)

### Inside the same container that runs in production

```
docker compose --profile linux run --rm voice-io pytest -v
```

Pytest + the dev deps are baked into the image (cheap — ~3 MB).
Running tests against the same image you ship is the cleanest way
to catch deployment-environment drift (which Python is on PATH,
which libportaudio2 is actually loaded, etc.).

### CI

`.github/workflows/voice-io-tests.yml` runs the same suite
on a fresh Ubuntu runner with `libportaudio2` apt-installed.
Currently `workflow_dispatch:` only — matches all other Droplet
service workflows pending the GitHub-Actions-minutes restoration.

## What the tests cover

`TestParseCardNumber` (4)
  Card-number extraction from ALSA device names like
  `(hw:1,0)`. Edge cases: 2-digit indices, missing `hw:` clause,
  empty string, None.

`TestDetectBus` (5)
  Bus classification from `/sys/class/sound/cardN/` sysfs paths.
  USB (controller name `usbN` anywhere in resolved path), PCI
  (`pci0000:...` prefix), platform (Jetson I²S codec), unknown
  (card not in sysfs, or card number None).

`TestScoring` (5)
  Score weights: USB mic array > onboard codec, HDMI penalised
  as input, zero-channel devices score 0, platform-bus treated
  as intended primary, loopback penalised.

`TestEnumerateDevices` (3)
  Skips 0-in/0-out devices, attaches bus + card number, returns
  empty list when sounddevice is unavailable.

`TestResolveDevices` (6)
  Highest-scored input + output picked. Env override by index,
  by name substring, miss → no fallback (operator pinned, respect
  intent). Zero-input + zero-everything edge cases.

`TestRealHardwareScenarios` (4)
  Full-stack scenario per README compatibility table:
    - POC box (x86 Ryzen, 3 onboard PCI cards, no USB)
    - POC + ReSpeaker 4-Mic USB array
    - Production v2.6 (Jetson + I/O Brick I²S codec)
    - Generic dev box (USB headset)

`tests/test_wake.py` (18) — wake-word detector contract:
  - `MockWakeWordDetector` replays scripted scores, then 0.0 once
    exhausted. Drives pipeline tests deterministically.
  - `DisabledWakeWordDetector` is `loaded=False`, `predict()` returns
    `{}`. The "voice degraded" fallback when openwakeword fails to
    load — pipeline still pumps audio so `/audio/test-record` keeps
    working.
  - `OpenWakeWordDetector` lazy-loads (construction never imports
    openwakeword), and on import failure returns `{}` from predict
    rather than raising. Load attempts are one-shot (`_load_attempted`)
    so a missing wheel doesn't spam 80 ImportErrors/sec.
  - `build_detector_from_env` routes `WAKE_WORD=__mock__` to the
    mock; anything else to openWakeWord. Whitespace stripped
    defensively (env arrives from docker-compose with stray
    newlines occasionally).

`tests/test_pipeline.py` (25) — wake pipeline state machine:
  - Construction lands in `state='idle'` with all wake fields None.
  - `start()` with `input_device_index=None` transitions to
    `'no_mic'` and never spawns a worker thread.
  - `stop()` is idempotent; calling it without `start()` is safe.
  - Sub-threshold frames don't fire the callback or move state.
  - Above-threshold frames fire `on_wake` exactly once, record the
    wake event in status atomically.
  - Detector + callback exceptions are caught — detector errors
    transition to `'error'` state with `error_message` set; callback
    errors are logged but never propagate.
  - Debounce window coalesces rapid frames (one wake event per
    `WAKE_DEBOUNCE_S`); re-fires once the window passes.
  - Visual-decay computes at read-time: `'wake_detected'` reverts
    to `'listening'` after `WAKE_VISUAL_DECAY_S` without any
    background timer thread.
  - `status()` snapshot is lock-coherent under concurrent reader +
    writer threads (smoke test with 3 readers + 1 writer × 200
    iterations).
  - `_loop()` end-to-end with an injected fake sounddevice module
    pumps a scripted frame sequence through, fires the callback,
    exits cleanly when the fake stream signals EOF.

## Adding a test

`tests/conftest.py` provides two factories:

- `make_sounddevice(devices, hostapis=None)` — returns a fake
  `sounddevice` module preloaded with the given device dicts.
  Device dict shape matches the real `sounddevice.query_devices()`
  return: `{name, max_input_channels, max_output_channels,
  default_samplerate, hostapi}`.
- `make_sysfs_root(cards)` — builds a fake `/sys/class/sound`
  tree under pytest's `tmp_path`. `cards` is `{N: bus_type}` where
  `bus_type` is `"usb" | "pci" | "platform" | "unknown"`. The
  fixture mirrors real Linux structure so the same tests pass
  on POSIX and Windows (developer dev boxes).

Pattern:

```python
def test_my_thing(self, make_sounddevice, make_sysfs_root):
    sd = make_sounddevice([
        {"name": "...", "max_input_channels": ..., ...},
    ])
    root = make_sysfs_root({0: "usb"})
    r = resolve_devices(env={}, sys_root=root, sd_module=sd)
    assert r.input_device is not None
```

## On-device debug endpoints

Not unit tests, but useful when wiring real hardware:

```
curl http://127.0.0.1:8086/audio/devices       # what did we detect?
curl http://127.0.0.1:8086/audio/devices?refresh=1   # force re-pick (hot-plug)
curl -X POST http://127.0.0.1:8086/audio/test-record?duration_s=2.0
                                                # record 2 s, return level
curl -X POST http://127.0.0.1:8086/audio/test-tone?duration_s=1.0
                                                # play 440 Hz sine 1 s
```

Container is internal-only (port 8086 not host-exposed), so curl
from inside the container or via `docker exec`:

```
sudo docker exec droplet-pi-platform-voice-io-1 \
  curl -s http://localhost:8086/audio/devices | python3 -m json.tool
```
