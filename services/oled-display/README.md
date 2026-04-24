# TFT Display Service

Drives the Droplet front-panel 480x320 TFT via an **Adafruit PyPortal Titano**
connected over USB-serial. The PyPortal has its own SAMD51 + ILI9341 touch
panel, so this service streams JSON commands over `/dev/ttyACM*` and the
PyPortal renders locally.

The directory is still named `oled-display` for backwards compatibility with
the orchestrator client (`apps/orchestrator/src/services/display.client.ts`)
and docker-compose wiring.

> **History:** an earlier version of this service also supported a direct-SPI
> path (`luma.lcd` ILI9486 over `/dev/spidev0.0`) and an `fbtft` framebuffer
> path (`/dev/fb1`) for Pi-shield TFTs. Both were removed because Tegra's
> GPIO/SPI driver stack on L4T is incompatible with the Pi-form-factor TFT
> shields we originally targeted (see WARP-127). The PyPortal pivot sidesteps
> that entirely — a stock Jetson just enumerates the Titano as USB-ACM and
> we drive it over serial, no GPIO/kernel module required.

## Display backends

| Backend | When it runs | Notes |
|---|---|---|
| `pyportal` | A PyPortal Titano is reachable at `/dev/ttyACM*` | Primary on the device. |
| `sim` | No PyPortal on USB | Renders each frame to `SIM_OUTPUT` (default `/tmp/tft_preview.png`). Used for dev / CI and by `/display/preview`. |

`DISPLAY_BACKEND=auto` (default) probes the PyPortal on startup and falls back
to `sim`. If the container starts before USB enumeration finishes, the cycle
loop re-probes every 5 s and promotes `sim → pyportal` as soon as the device
appears. Force a specific backend with `DISPLAY_BACKEND=pyportal|sim`.

## PyPortal setup (one-time, on the host)

```bash
# 1. Flash CircuitPython 9.x UF2 to the PyPortal Titano (double-press reset).
# 2. Drop our firmware + libs onto CIRCUITPY:
cp services/oled-display/pyportal/{boot.py,code.py} /media/$USER/CIRCUITPY/
cp -r ~/Adafruit_CircuitPython_Bundle/lib/adafruit_display_text /media/$USER/CIRCUITPY/lib/
cp ~/Adafruit_CircuitPython_Bundle/lib/adafruit_touchscreen.mpy /media/$USER/CIRCUITPY/lib/
# 3. Reset the PyPortal, plug into any USB-A on the host.
# 4. docker compose -p docker -f docker/docker-compose.yml --profile full up -d oled-display
```

Full protocol and debugging notes: [`pyportal/README.md`](./pyportal/README.md).

## API (port 8082)

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/health`              | Health check (reports backend + resolution) |
| GET  | `/display/status`      | Current mode, brightness, cycling state, backend |
| POST | `/display/home`        | Navigate to the Stats screen |
| POST | `/display/stats`       | Navigate to the Stats screen (4 half-donut gauges + rollup cards) |
| POST | `/display/logo`        | Navigate to the Idle screen (clock + mark + info chips) |
| POST | `/display/message`     | Custom text `{title, lines[]}` — up to 10 lines |
| POST | `/display/custom`      | Upload image (multipart, max 8 MB) |
| POST | `/display/brightness`  | Set brightness `{value: 0–255}` (PyPortal only) |
| POST | `/display/cycle/resume`| Resume auto-cycling (when `AUTO_CYCLE=1`) |
| POST | `/display/cycle/stop`  | Stop auto-cycling |
| GET  | `/display/preview`     | Download the last rendered frame as PNG |
| GET  | `/touch/state`         | Last touch coords + press/release counters |
| POST | `/touch/tap`           | Simulate a tap at `(x, y)` (preview / e2e tests) |
| GET  | `/touch/regions`       | List the currently-active tap targets |
| GET  | `/wifi/scan`           | Latest scan snapshot from the device-bridge helper |
| POST | `/wifi/connect`        | `{ssid, password}` — join a network via the helper |

## Auto-cycle

Disabled by default on the touch build (a touch display is for interaction,
not a billboard). Set `AUTO_CYCLE=1` to restore the logo → stats carousel for
headless demos. When an LLM calls `/display/message`, cycling pauses for 30 s
before resuming.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8082` | Listen port |
| `DISPLAY_BACKEND` | `auto` | `auto` / `pyportal` / `sim` |
| `LCD_WIDTH` / `LCD_HEIGHT` | `480` / `320` | Panel resolution (PyPortal Titano native) |
| `PYPORTAL_TTY` | `/dev/ttyACM1` | Host-side serial path. Titano enumerates as two ACM endpoints; we use the second (data) one so the REPL on ACM0 stays free. |
| `PYPORTAL_BAUD` | `115200` | PyPortal serial baud rate |
| `DISPLAY_TIMEZONE` | `America/Los_Angeles` | Timezone for the wall-clock pushed to the PyPortal |
| `SERVICE_SECRET` | _(empty)_ | Bearer token required on all non-`/health` routes |
| `BRIDGE_AUTH_TOKEN` | falls back to `SERVICE_SECRET` | Token the container sends to `device-bridge` when calling `POST /openwrt/wifi/rotate` |
| `SIM_OUTPUT` | `/tmp/tft_preview.png` | Simulated output path (also used as preview cache for PyPortal) |

## Wi-Fi QR (static password, default)

The PyPortal's "Join Wi-Fi" screen shows a WPA-QR for the `Droplet-AI`
SSID plus the cleartext password underneath for users who want to type
it manually. Scan it with a phone camera or read it off the screen —
they're the same string (both sourced from UCI `wireless.default_radio4.key`
on the router via `GET /openwrt/qr`).

The password is **static by default**. Rotating it would kick every
joined station and break "auto-connect when I get home" on phones, so
the default production posture is: set a memorable key once, let guests
rejoin from saved credentials, done.

To change the password, SSH to the router and:
```bash
ssh root@192.168.50.1
uci set wireless.default_radio4.key='your-new-password'
uci commit wireless
wifi down radio4 && wifi up radio4   # force hostapd to pick it up
```

### Optional: key rotation

If you do want rotating credentials (shared-office deployments,
visitor-kiosk mode), flip `WIFI_KEY_ROTATION_ENABLED=true` in
`/etc/droplet/device-bridge.env` and run `sudo
./scripts/install-device-bridge.sh` again. That unmasks the 24 h
`droplet-wifi-rotate.timer` and lights up the "Rotate now" button + TTL
chip on the PyPortal.

When enabled, the rotation path is:

1. PyPortal sends `ROTATE_KEY` on the serial data channel.
2. `display.py` POSTs `http://127.0.0.1:9090/openwrt/wifi/rotate` with
   an `X-Droplet-Auth: <token>` header.
3. `device-bridge.py` validates the token, generates a 16-char random
   passphrase (first char forced to a digit so Android auto-capitalize
   can't mangle manual entry), pushes it to the router via SSH + UCI,
   and runs `wifi down radioN && wifi up radioN` so hostapd picks up
   the change immediately (plain `wifi reload` leaves a stale PSK in
   memory).
4. The bridge stores only the rotation timestamp + sha256 digest in
   `/var/lib/droplet-bridge/state.json` — the cleartext key is only
   ever readable via `GET /openwrt/qr`.

Rotation is rate-limited to 30 s between calls and serialized by an
in-process lock. With rotation disabled, the endpoint returns `410
Gone` and the PyPortal UI hides the Rotate button + TTL chip entirely.

### Install on the Jetson

```bash
sudo ./scripts/install-device-bridge.sh
```

This installs the three systemd units, seeds
`/etc/droplet/device-bridge.env` (0600, root-only) with
`BRIDGE_AUTH_TOKEN` mirrored from the repo's `.env`, and enables both
`droplet-device-bridge.service` and `droplet-wifi-rotate.timer`. Idempotent.

`scripts/factory-reset.sh` wipes the bridge's state directory and env
file as part of a factory reset; `install-device-bridge.sh` (called
again via `setup.sh --reinstall`) re-provisions them cleanly.
