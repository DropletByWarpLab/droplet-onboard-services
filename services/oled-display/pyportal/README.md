# Droplet PyPortal Titano firmware

Alternative display backend for the Droplet `oled-display` service. Replaces
the direct SPI / TFT-shield path with an Adafruit PyPortal Titano connected
over USB. The PyPortal is a self-contained board (ATSAMD51 + 3.5" 480×320
TFT + resistive touch) that runs CircuitPython and exposes two USB CDC
serial endpoints:

| Endpoint | Path on Jetson | Purpose |
|---|---|---|
| `console` | `/dev/ttyACM0` | CircuitPython REPL (drop into it with `screen /dev/ttyACM0 115200`) |
| `data` | `/dev/ttyACM1` | JSON command channel — the Droplet service talks here |

## One-time setup — flash the PyPortal

1. **Install CircuitPython 9.x on the PyPortal Titano.**
   - Connect the Titano to any computer via USB-C.
   - Double-click the reset button on the back. The board enters UF2
     bootloader mode and appears as a USB drive called `PORTALBOOT`.
   - Download the latest stable CircuitPython `.uf2` for the *PyPortal Titano*
     from <https://circuitpython.org/board/pyportal_titano/>.
   - Drag the `.uf2` onto `PORTALBOOT`. The board reboots and a new drive
     called `CIRCUITPY` appears.

2. **Copy this directory onto `CIRCUITPY`.**
   - Copy `boot.py` to `CIRCUITPY/boot.py` (root of the drive).
   - Copy `code.py` to `CIRCUITPY/code.py` (root of the drive).
   - Copy or unzip the Adafruit CircuitPython bundle's `adafruit_display_text`
     and `adafruit_touchscreen` libraries into `CIRCUITPY/lib/`.
     Bundle: <https://circuitpython.org/libraries>

3. **Eject and reset.** Press the reset button once. The PyPortal should
   display the Droplet logo a few seconds later, and a second USB serial
   device (`/dev/ttyACM1`) should appear on whatever host it's plugged into.

## Verify from the Jetson

```bash
ls /dev/ttyACM*                      # expect ttyACM0 and ttyACM1
python3 -c "import serial; s=serial.Serial('/dev/ttyACM1',115200,timeout=2); \
    s.write(b'{\"mode\":\"message\",\"data\":{\"title\":\"HELLO\",\"lines\":[\"via serial\"]}}\n'); \
    print(s.readline())"
# -> b'OK\n'
```

## Wire it to the oled-display service

Set `DISPLAY_BACKEND=pyportal` (or keep `auto`, which now prefers the
PyPortal over SPI if `/dev/ttyACM1` exists), and make sure the compose
service has `/dev/ttyACM1` mounted into the container. Both are already
wired up in `docker/docker-compose.yml`; the only change is flipping the
env in `.env`:

```
DISPLAY_BACKEND=pyportal
PYPORTAL_TTY=/dev/ttyACM1
```

Then `docker compose -p docker -f docker/docker-compose.yml up -d --force-recreate oled-display`.

## Protocol (JSON over /dev/ttyACM1, newline-delimited)

Host → PyPortal:

| Command | Payload | Effect |
|---|---|---|
| `{"mode":"logo"}` | — | Show the Droplet splash |
| `{"mode":"stats","data":{...}}` | cpu, mem, temp, ip, uptime | Render a stats panel |
| `{"mode":"message","data":{"title":"...","lines":[...]}}` | title + up to ~5 lines | Render a message card |
| `{"mode":"brightness","value":0..255}` | 0–255 | Adjust TFT backlight |
| `{"mode":"ping"}` | — | Round-trip check |

PyPortal → Host:

| Line | Meaning |
|---|---|
| `OK` | Command accepted and rendered |
| `ERR:<reason>` | Something went wrong |
| `READY` | Sent once at firmware boot |
| `TOUCH:<x>,<y>,<pressure>` | Unsolicited — finger down / dragging |
| `TOUCH:release` | Finger lifted |

## Debugging

- REPL still works on `/dev/ttyACM0`: `screen /dev/ttyACM0 115200` or
  `mpremote connect /dev/ttyACM0 repl`.
- On the PyPortal, a crashed `code.py` prints a traceback to the console
  and the TFT shows a red error screen.
- To reload after editing `code.py`: just save the file while `CIRCUITPY`
  is mounted — CircuitPython auto-reloads.

## Why USB and not WiFi

The Titano's ESP32 co-processor lets it do WiFi, but USB serial is simpler
for this prototype: no credentials to configure, works when WiFi is down,
lower latency (~50 ms round-trip vs. seconds for HTTP polling), and the
Jetson just needs one cable. Switching to WiFi later is a drop-in change
(the protocol stays the same — only the transport swaps from pyserial to
an HTTP client).
