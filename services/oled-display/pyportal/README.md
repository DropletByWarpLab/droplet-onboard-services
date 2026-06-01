# Droplet PyPortal Titano firmware

Front-panel display for the Droplet appliance. The PyPortal Titano is a
self-contained board (ATSAMD51 + 3.5" 480×320 TFT + resistive touch) running
CircuitPython 9.x. It connects to the Jetson over USB and exposes two USB CDC
serial endpoints:

| Endpoint | Path on Jetson | Purpose |
|---|---|---|
| `console` | `/dev/ttyACM0` | CircuitPython REPL (`screen /dev/ttyACM0 115200`) |
| `data` | `/dev/ttyACM1` | JSON command channel — the `oled-display` service talks here |

## What it shows

A three-screen swipe UI, plus two host-driven lifecycle screens:

- **Idle (sleep screen)** — big centered Droplet mark with a tiny HH:MM
  in the top-right corner, date in the top-left, and a subtle footer
  `hostname · ip · ssid`. Static colon (no per-second blink) — reads calm
  instead of busy. Auto-engages after 30 s of no touch; any tap wakes to
  Stats.
- **Stats** — hostname/IP/uptime header with a live clock; 4 half-donut
  gauges (CPU / MEM / DISK / TEMP) each with a short sparkline history
  band; two wider summary cards (Storage, Network+Wi-Fi). Camera health
  surfaces as a red `!` bubble in the header — tap it to open the alerts
  drawer with per-row clear + Clear-all.
- **QR (Join Wi-Fi)** — WPA QR for the `Droplet-AI` SSID + cleartext
  password. Rotation TTL chip + pill-shaped "Rotate now" button appear
  only when key rotation is enabled on the bridge.

Navigation at the bottom is a row of big rounded pills (active one
highlighted with an indigo halo dot). Swipe left/right between Stats and
QR, or tap a pill to jump; 30 s of inactivity returns to Idle.

### Lifecycle screens (boot / shutdown)

These are **modal** — they are not in the swipe carousel and the idle
timeout does not apply to them (a long cold boot won't self-drop to idle).
They stay up until the host pushes another mode.

- **Boot** — `main()` opens on this screen, so a cold power-on immediately
  reads **"Starting Droplet"**: big Droplet mark, the current startup stage
  as a caption (+ optional detail line), and a progress band (indeterminate
  when no `pct` is pushed, otherwise filled to `pct`). The host's
  oled-display service moves the panel off boot to the live UI once the
  system is healthy (or after its readiness timeout). The firmware still
  sends `READY` + `REQUEST_STATE` on boot as before.
- **Shutdown** — dimmed Droplet mark + **"Shutting down"** + an optional
  reason line. When the host pushes `phase: "halted"` the copy switches to
  **"Safe to power off"**. Pushed by the host's systemd ExecStop oneshot at
  teardown (see the service README).

## Clock behavior

The idle screen's HH:MM clock is anchored against `time.monotonic()` when
the host pushes `now` (and optionally `date`) on a stats frame. Between
pushes, the firmware derives the current minute from the anchor + elapsed
monotonic time, so the clock rolls over correctly even if the bridge
pauses. Drift stays bounded because every new `stats` push resets the
anchor. The idle tick loop writes the clock label *only when the minute
changes* — no per-second updates, no distracting blink.

## Resilience — boot-time resync

When `code.py` auto-reloads or the board reboots for any reason, the
firmware sends `READY` followed immediately by `REQUEST_STATE` on the data
serial channel. The host-side `display.py` reader loop reacts to either
message by pushing a full snapshot (stats + wifi + drives + cameras +
files) in a single burst instead of waiting for the next periodic tick.
That cuts post-reboot resync time from the worst-case periodic cadence
(up to ~30 s) down to well under a second — so the device never sits with
empty screens after a firmware drop.

## One-time setup — flash the PyPortal

1. **Install CircuitPython 9.x on the Titano.**
   - Plug the Titano into any computer via USB-C.
   - Double-click the reset button on the back. The board enters UF2
     bootloader mode and appears as a USB drive called `PORTALBOOT`.
   - Grab the latest stable `.uf2` for the *PyPortal Titano* from
     <https://circuitpython.org/board/pyportal_titano/>.
   - Drag the `.uf2` onto `PORTALBOOT`. The board reboots and a new drive
     called `CIRCUITPY` appears.

2. **Copy this directory onto `CIRCUITPY`.**
   - `boot.py` and `code.py` go at the root of the drive.
   - Copy the Adafruit bundle's `adafruit_display_text` folder and
     `adafruit_touchscreen.mpy` into `CIRCUITPY/lib/`.
     Bundle: <https://circuitpython.org/libraries>

3. **Eject and reset.** Press reset once. The PyPortal should boot into
   the idle clock screen within a few seconds and `/dev/ttyACM1` should
   appear on the host.

## Verify from the Jetson

```bash
ls /dev/ttyACM*                      # expect ttyACM0 and ttyACM1
python3 -c "import serial; s=serial.Serial('/dev/ttyACM1',115200,timeout=2); \
    s.write(b'{\"mode\":\"message\",\"data\":{\"title\":\"HELLO\",\"lines\":[\"via serial\"]}}\n'); \
    print(s.readline())"
# -> b'OK\n'
```

## Wire it to the oled-display service

Set `DISPLAY_BACKEND=pyportal` (or keep `auto`, which prefers the PyPortal
when `/dev/ttyACM1` exists) and make sure the compose service has
`/dev/ttyACM1` mounted into the container. Both are already wired in
`docker/docker-compose.yml`; the only toggle is in `.env`:

```
DISPLAY_BACKEND=pyportal
PYPORTAL_TTY=/dev/ttyACM1
```

Then `docker compose -f docker/docker-compose.yml up -d --force-recreate oled-display`.

## Protocol (JSON over /dev/ttyACM1, newline-delimited)

### Host → PyPortal

| Command | Payload | Effect |
|---|---|---|
| `{"mode":"idle"}` / `{"mode":"logo"}` / `{"mode":"home"}` | — | Navigate. `logo` → idle, `home` → stats. |
| `{"mode":"stats"}` / `{"mode":"qr"}` | — | Navigate to that screen. |
| `{"mode":"stats","data":{cpu,mem,disk,temp,ip,hostname,uptime,now,date}}` | metrics + optional `now` (HH:MM) + optional `date` | Render stats and (re-)anchor the local clock. |
| `{"mode":"wifi","data":{ssid,clients,channel,band,key_ttl_seconds,...}}` | Wi-Fi state | Populates the Wi-Fi card + QR sidebar. |
| `{"mode":"cameras","data":{online,total,events,error,source}}` | camera rollup + Frigate events | Populates the Cameras card and feeds the alerts drawer. |
| `{"mode":"drives","data":{drives:[...],count}}` | drive list | Populates the Storage card. |
| `{"mode":"files","data":{count,size_bytes,recent:[...]}}` | file rollup | (Reserved; not currently shown.) |
| `{"mode":"qr","data":{matrix,ssid,security,payload,version,ok,key,ttl_seconds,rotation_enabled,error}}` | QR payload | Renders the Join-Wi-Fi screen. |
| `{"mode":"alert","data":{type,title,detail,time}}` | system alert | Pushes a row into the alerts drawer. |
| `{"mode":"message","data":{title,lines:[...]}}` | title + lines | Full-screen message card. |
| `{"mode":"boot","data":{stage,detail,pct}}` | stage caption + optional detail + optional 0–100 pct | Boot/startup screen. Omit `pct` for an indeterminate band. Bare `{"mode":"boot"}` just navigates. |
| `{"mode":"shutdown","data":{reason,phase}}` | optional reason + `phase` (`stopping`\|`halted`) | Shutdown screen. `halted` shows "Safe to power off". Bare `{"mode":"shutdown"}` just navigates. |
| `{"mode":"brightness","value":0..255}` | 0–255 | Adjust backlight. |
| `{"mode":"ping"}` | — | Round-trip check. |

### PyPortal → Host

| Line | Meaning |
|---|---|
| `READY` | Sent once at firmware boot |
| `OK` | Command accepted |
| `ERR:<reason>` | Something went wrong (oom, heap_panic, tap error, unknown_mode) |
| `TOUCH:<x>,<y>,<pressure>` | Finger down / dragging |
| `TOUCH:release` | Finger lifted |
| `TAP:<screen>:<region>` | A named tap region fired (e.g. `TAP:stats:alert_bubble`) |
| `SWIPE:<left|right>:<from-screen>` | User swiped to a new screen |
| `NAV:<screen>` | The active screen changed (including host-initiated) |
| `ROTATE_KEY` | User tapped "Rotate now" on the QR screen (QR screen only, and only when rotation is enabled) |

## Debugging

- REPL on `/dev/ttyACM0`: `screen /dev/ttyACM0 115200` or
  `mpremote connect /dev/ttyACM0 repl`.
- On the PyPortal, a crashed `code.py` prints a traceback to the console and
  the TFT shows a red error screen.
- To reload after editing `code.py`: save the file while `CIRCUITPY` is
  mounted — CircuitPython auto-reloads.

## Why USB and not Wi-Fi

The Titano's ESP32 co-processor can do Wi-Fi, but USB serial is simpler for
this deployment: no credentials to configure, works when Wi-Fi is down, lower
latency (~50 ms round-trip vs. seconds for HTTP polling), and the Jetson just
needs one cable. Switching to Wi-Fi later is a drop-in swap — the JSON
protocol stays the same, only the transport changes.
