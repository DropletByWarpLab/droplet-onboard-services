# voice-orchestrator — testing

Three layers, all part of the project's standard check flow:

| Layer | What it covers | Where it runs |
|---|---|---|
| **Pytest unit tests** | `voice/devices.py` discovery + scoring + `resolve_devices()` with simulated hardware. No real audio needed. | Local (`pytest tests/`), in the container (`docker compose run voice-orchestrator pytest tests/`), and CI (`.github/workflows/voice-orchestrator-tests.yml`). |
| **Container healthcheck** | The service's `/health` endpoint replies 200 ok. Reported by `docker ps`. Interval 15 s, 3 retries before unhealthy. | The Docker engine on whatever host the service runs on. |
| **`scripts/verify.sh` smoke** | Curls the in-container `/health` end-to-end, asserts `inputAvailable` matches reality (passes when a mic IS connected, warns when not). | Locally via `./scripts/verify.sh`, or as part of `setup.sh --verify`. |

## Running pytest

### Locally (fast, no Docker)

```
cd services/voice-orchestrator
pip install -r requirements-dev.txt
pytest -v
```

27 tests across `tests/test_devices.py`. Sub-second total. No real
audio hardware required — the fixtures inject a fake `sounddevice`
module + a synthetic `/sys/class/sound` tree under `tmp_path`.

### Inside the same container that runs in production

```
docker compose --profile linux run --rm voice-orchestrator pytest -v
```

Pytest + the dev deps are baked into the image (cheap — ~3 MB).
Running tests against the same image you ship is the cleanest way
to catch deployment-environment drift (which Python is on PATH,
which libportaudio2 is actually loaded, etc.).

### CI

`.github/workflows/voice-orchestrator-tests.yml` runs the same suite
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
sudo docker exec droplet-pi-platform-voice-orchestrator-1 \
  curl -s http://localhost:8086/audio/devices | python3 -m json.tool
```
