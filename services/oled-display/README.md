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
| POST | `/display/home`        | Show the home tile grid |
| POST | `/display/stats`       | Show the 4-card device-stats dashboard |
| POST | `/display/logo`        | Show the full-screen Droplet logo |
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
| `SIM_OUTPUT` | `/tmp/tft_preview.png` | Simulated output path (also used as preview cache for PyPortal) |
