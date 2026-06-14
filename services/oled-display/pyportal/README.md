# Droplet PyPortal Titano firmware

Front-panel display for the Droplet appliance. The PyPortal Titano is a
self-contained board (ATSAMD51 + 3.5" 480×320 TFT + resistive touch) running
CircuitPython 9.x. It connects to the appliance over USB and exposes two USB CDC
serial endpoints:

| Endpoint | Path on the appliance | Purpose |
|---|---|---|
| `console` | `/dev/ttyACM0` | CircuitPython REPL (`screen /dev/ttyACM0 115200`) |
| `data` | `/dev/ttyACM1` | JSON command channel — the `oled-display` service talks here |

## What it shows

The py-v3 editorial UI: **two live states** (idle clock ⇄ combined
System+Wi-Fi) plus host-driven power sequences. Every coordinate/color is a
1:1 port of the design handoff (`README.md` + `preview.html`); the on-canvas
reference renders at the native 480×320.

- **Idle clock** — an editorial hero clock (132px, weight ~800, −6 tracking)
  with a **blinking colon**, a tappable **12/24 segmented toggle**
  (top-right, **persisted on-device**), the droplet mark + `DROPLET` eyebrow
  (top-left), a 56×3 accent rule under the clock, the date bottom-left, a
  green-dot + SSID bottom-right, and a full-width seconds-progress hairline
  along the very bottom edge. In 12-hour mode the hour drops its leading zero
  and an AM/PM suffix is drawn in accent. Auto-engages after 30 s of no
  touch; any tap (except the toggle) wakes to the System screen.
- **System + Wi-Fi** — ONE combined screen (this replaces the old separate
  Stats and QR screens). A header band (SYSTEM eyebrow left; clock + a green
  `OK` pill or a red `!` alert badge right; hairline at y=32) sits over a
  two-column body split by a vertical divider at x=288. **Left** is system:
  a `CPU LOAD` eyebrow + a 52px CPU hero + a 48-sample CPU sparkline (accent
  polyline + filled area) + a 4-column tabular row (MEM / DISK / TEMP / CAM,
  with CAM in green) + a detail line (`WAN … · UP … · LAN …`) + a
  `hostname · ip` strip. **Right** is Wi-Fi pairing: a `PAIR · WI-FI` accent
  eyebrow + a 132×132 white QR card with the droplet mark inset dead-centre +
  NETWORK/SSID + PASSWORD + a full-width **KEY rotate pill** (`KEY mm:ss`;
  orange when <60 s; tap rotates). The QR matrix is supplied by the host —
  the firmware never encodes a QR on-device.
- **Alerts drawer** — open alerts surface as the red `!` badge in the System
  header; tapping it slides a 300px panel in from the right (up to 4 rows,
  per-row dismiss, Clear all, empty state). Tap the `×` close or wait out the
  idle timeout to dismiss it.

Navigation is touch-first and there is a **single** non-idle screen, so swipe
just wakes idle → System (and rubber-bands on System); 30 s of inactivity
returns to Idle and closes any open drawer.

### Power sequences (boot / shutdown / standby)

These are **modal** — not in the swipe nav, and the idle timeout does not
apply to them. They stay up until the host pushes another mode.

- **Boot** — `main()` opens on this screen, so a cold power-on immediately
  plays the boot sequence: the droplet "vessel" **fills** with accent liquid,
  a `DROPLET` wordmark, a 4-stage status line
  (`Mounting storage → Starting network → Loading models → Ready`, the last
  in green), a 184px progress bar, and a `Droplet OS · v2.4` footer. The fill
  self-animates on a bare `{"mode":"boot"}`; a host-pushed `pct` drives it
  directly. The host's oled-display service moves the panel off boot to the
  live UI once the system is healthy (or after its readiness timeout). The
  firmware still sends `READY` + `REQUEST_STATE` on boot as before.
- **Shutdown** — the liquid **drains** with a status line
  (`Stopping services → Unmounting storage → Powering off`), then a **CRT
  collapse** (content thins to a bright phosphor line → a dot → black). When
  the host pushes `phase: "halted"` it jumps to the fully-collapsed
  safe-to-power-off frame. Pushed by the host's systemd ExecStop oneshot.
- **Standby** — a dim mark + `STANDBY` + `tap to power on` (host-pushed via
  `{"mode":"standby"}`); a tap asks the host to power on.

## Clock behavior

The hero clock's minute is anchored against `time.monotonic()` when the host
pushes `now` (and optionally `date`) on a stats frame. Between pushes the
firmware derives the current minute from the anchor + elapsed monotonic time,
so it rolls over correctly even if the bridge pauses; every new `stats` push
resets the anchor so drift stays bounded. The idle tick loop blinks the colon
each second (cheap — it rewrites the single hero label) and honors the 12/24
toggle.

### 12/24 toggle persistence

The toggle state is persisted on-device to `/clock_mode.txt` so it survives a
reboot. The CIRCUITPY filesystem is **read-only to CircuitPython whenever the
host has it mounted over USB-MSC**, so the write can fail with
`OSError(EROFS)`; the firmware handles that gracefully — it always keeps an
in-RAM copy (default `'24'`) and just emits `ERR:clock_persist:readonly_fs`
instead of crashing. In that state the choice simply doesn't survive a reboot.

## Hero font

The editorial hero numerals (idle clock + CPU hero) use a bundled bitmap
subset font, `lib/fonts/Inter-Hero-66.bdf` (digits, colon, AM/PM, `°`, `%`,
space), loaded via `adafruit_bitmap_font` — terminalio scaled to 132px is too
blocky for this look. The load is **best-effort**: if the library or the asset
is missing, or the font fails to parse, the firmware falls back to
terminalio-scaled heroes, so a font problem never bricks the panel. Regenerate
the BDF with `services/oled-display/tools/make_hero_font.py` if the glyph set
or base size changes.

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
   - Copy the Adafruit bundle's `adafruit_display_text` folder,
     `adafruit_touchscreen.mpy`, and the `adafruit_bitmap_font` folder into
     `CIRCUITPY/lib/`. Bundle: <https://circuitpython.org/libraries>
   - Copy this repo's `pyportal/lib/fonts/` folder onto
     `CIRCUITPY/lib/fonts/` — it holds `Inter-Hero-66.bdf`, the bundled hero
     numeral font for the editorial clock + CPU hero. (If it's missing the
     firmware still boots; it just falls back to terminalio-scaled heroes.)
   - Or just run `scripts/flash-pyportal.sh` from the repo root, which copies
     `code.py`, `boot.py`, **and** `lib/fonts/Inter-Hero-66.bdf` for you.

3. **Eject and reset.** Press reset once. The PyPortal should boot into
   the idle clock screen within a few seconds and `/dev/ttyACM1` should
   appear on the host.

## Verify from the appliance

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

The wire contract is **unchanged** from the previous firmware — the host's
`device-bridge.py` / `display.py` push the same modes. The redesign folds the
old separate `stats` and `qr` screens into ONE combined `system` screen, so
`stats` / `qr` / `wifi` / `cameras` / `drives` / `home` all render there
(`logo` → idle). Data-laden frames still update state and re-render the active
screen; bare-mode frames navigate.

| Command | Payload | Effect |
|---|---|---|
| `{"mode":"idle"}` / `{"mode":"logo"}` | — | Navigate to the idle clock. |
| `{"mode":"system"}` / `{"mode":"stats"}` / `{"mode":"qr"}` / `{"mode":"home"}` | — | Navigate to the combined System+Wi-Fi screen. |
| `{"mode":"stats","data":{cpu,mem,disk,temp,ip,hostname,uptime,now,date,wan_latency_ms,lan_clients}}` | metrics + optional `now` (HH:MM) + optional `date` + optional `wan_latency_ms`/`lan_clients` for the detail line | Updates system metrics and (re-)anchors the local clock. |
| `{"mode":"wifi","data":{ssid,clients,channel,band,key_ttl_seconds,password,...}}` | Wi-Fi state (incl. `password` for the pairing column) | Populates the Wi-Fi pairing column + KEY pill. |
| `{"mode":"cameras","data":{online,total,events,error,source}}` | camera rollup + Frigate events | Drives the CAM tabular value and feeds the alerts drawer. |
| `{"mode":"drives","data":{drives:[...],count}}` | drive list | Ingested (kept for back-compat). |
| `{"mode":"files","data":{count,size_bytes,recent:[...]}}` | file rollup | Ingested (reserved). |
| `{"mode":"qr","data":{matrix,ssid,security,payload,version,ok,...}}` | QR payload — **host-supplied matrix** | Renders the QR into the System screen's white card. The firmware never encodes the QR itself. |
| `{"mode":"alert","data":{type,title,detail,time}}` | system alert | Pushes a row into the alerts drawer. |
| `{"mode":"message","data":{title,lines:[...]}}` | title + lines | Full-screen message card. |
| `{"mode":"boot","data":{stage,detail,pct}}` | optional stage caption + detail + 0–100 pct | Boot sequence. `pct` drives the vessel fill; omit it and the fill self-animates. Bare `{"mode":"boot"}` just navigates. |
| `{"mode":"shutdown","data":{reason,phase}}` | optional reason + `phase` (`stopping`\|`halted`) | Shutdown sequence (drain → CRT collapse). `halted` jumps to the collapsed safe-to-power-off frame. Bare `{"mode":"shutdown"}` just navigates. |
| `{"mode":"standby"}` | — | Powered-off standby ("tap to power on"). |
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
| `TAP:<screen>:<region>` | A named tap region fired (e.g. `TAP:system:alert_badge`, `TAP:idle:toggle_12`, `TAP:system:key_rotate`) |
| `SWIPE:<left|right>:<from-screen>` | User swiped (idle → system; rubber-bands on system) |
| `NAV:<screen>` | The active screen changed (including host-initiated). `NAV:power_on` is sent when a standby tap asks the host to power on. |
| `ROTATE_KEY` | User tapped the KEY rotate pill on the System screen |
| `REQUEST_QR` | Sent on entry to the System screen to pull a fresh QR matrix |
| `REQUEST_STATE` | Sent right after `READY` to request a full state resync |

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
latency (~50 ms round-trip vs. seconds for HTTP polling), and the appliance just
needs one cable. Switching to Wi-Fi later is a drop-in swap — the JSON
protocol stays the same, only the transport changes.
