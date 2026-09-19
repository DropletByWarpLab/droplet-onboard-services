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
> path (`/dev/fb1`) for GPIO-header TFT shields. Both were removed because the
> appliance host's GPIO/SPI driver stack was incompatible with the header-mount
> TFT shields we originally targeted (see WARP-127). The PyPortal pivot sidesteps
> that entirely — a stock appliance host just enumerates the Titano as USB-ACM and
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
# 4. docker compose -f docker/docker-compose.yml --profile full up -d oled-display
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
| POST | `/display/boot`        | Boot screen `{stage, detail?, pct?}` — omit `pct` for an indeterminate band |
| POST | `/display/shutdown`    | Shutdown screen `{reason?, phase?}` — `phase=halted` shows "Safe to power off" |
| POST | `/display/claim`       | Onboarding claim screen `{code, setup_url, wifi_*?}` (WARP-632 / ADR-017). Design-handoff two-column layout: code hero + link steps left, scan QR card right. The QR is the host-encoded setup deep link (`<setup_url>?c=<CODE>`) or, when the optional Wi-Fi creds are supplied (WARP-819), the Wi-Fi join QR with readable SSID/PSK |
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

## Boot & shutdown screens

The panel has two host-driven lifecycle screens (modal — not part of the
swipe carousel):

- **Boot** — the service constructs in boot mode, so the first frame on a
  cold start is "Starting Droplet" rather than a live screen. A bounded
  readiness check (hosted on the existing display cycle thread — no separate
  scheduler) flips the panel to the live UI once the system is healthy. It
  probes `BOOT_READINESS_URL` (default: the same-host orchestrator behind the
  gateway, on loopback) about every 2 s; a `2xx` means ready. If readiness is
  never observed within `BOOT_MAX_SECONDS` (default 90) the live UI is
  surfaced anyway so a degraded stack still shows something. `POST
  /display/boot` lets the host's startup orchestration push finer-grained
  stage/progress while the stack comes up.
- **Shutdown** — `POST /display/shutdown` shows "Shutting down" and freezes
  the panel on that frame (the cycle loop is stopped so nothing overwrites
  it). `phase=halted` switches the copy to "Safe to power off".

The shutdown screen is driven at teardown by a systemd oneshot,
`droplet-shutdown-screen.service`, whose `ExecStop` runs the host script
`/usr/local/sbin/droplet-shutdown-screen.sh`. The unit is ordered
`After=docker.service` so systemd stops it **before** the docker stack on
shutdown — while the `oled-display` container is still alive to receive the
POST. The script is best-effort and time-bounded (`curl -m 5`), so it can
never block the shutdown sequence. `scripts/install-device-bridge.sh`
installs the unit + script and enables the unit; `scripts/factory-reset.sh`
removes them.

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
| `DROPLET_AP_MODE` | `uci` | Pairing-QR creds source: `uci` (multi-box, read SSID/PSK over SSH), `hostapd` (single-box, read from env / `/etc/hostapd.conf`), or `auto` |
| `DROPLET_AP_SSID` | _(empty)_ | hostapd-mode AP SSID. When set, used directly (and forces `auto` to hostapd) |
| `DROPLET_AP_PSK` | _(empty)_ | hostapd-mode AP passphrase (paired with `DROPLET_AP_SSID`) |
| `DROPLET_AP_CONTAINER` | `droplet-openwrt` | Container the hostapd.conf fallback reads via `docker exec` |
| `DROPLET_AP_HOSTAPD_CONF` | `/etc/hostapd.conf` | hostapd.conf path inside that container |
| `BOOT_READINESS_URL` | `http://127.0.0.1/api/health` | Health endpoint polled to leave the boot screen (loopback orchestrator behind the gateway) |
| `BOOT_MAX_SECONDS` | `90` | Timeout fallback — surface the live UI even if readiness never reports healthy |
| `SIM_OUTPUT` | `/tmp/tft_preview.png` | Simulated output path (also used as preview cache for PyPortal) |
| `PANEL_RAIL_WIFI_QR` | `1` | Rack panel only. `0` removes the rail's Wi-Fi QR face — see below |
| `PANEL_RAIL_WIFI_SECONDS` | `45` | How long the rail's Wi-Fi face stays up before reverting on its own |
| `PANEL_ORCHESTRATOR_URL` | `http://127.0.0.1` | Rack panel only. Orchestrator origin behind the loopback gateway, read for the STORAGE cell (WARP-2668). Distinct from the bridge's own `ORCHESTRATOR_URL`, which defaults to `:3000` |
| `STORAGE_REFRESH_SECONDS` | `60` | How often that read happens. Slow on purpose — a capacity total is not a hot-plug event |

## The rack panel's QR rail has two faces (WARP-1782)

On the wide rack panel, tapping the right-hand rail flips the QR between:

| Face | Payload | Caption |
|---|---|---|
| Dashboard *(resting)* | `https://<public_host>/dashboard` | `SCAN TO OPEN` |
| Wi-Fi | `WIFI:T:WPA;S:<ssid>;P:<psk>;;` | `JOIN WI-FI` |

Two dots above the QR card mark which face is up. Tap again to go straight
back; otherwise the panel reverts on its own after `PANEL_RAIL_WIFI_SECONDS`.

**Why this is not the thing the design brief §8 forbids.** That rule — never
render the PSK in LIVE state — is about a credential *sitting* on a rack front
in a shared room. This one is *revealed*: it is not on the glass until someone
standing at the rack asks for it, and it takes itself back off. Three
properties make that hold, and none of them is optional:

- **The passphrase is never drawn as text.** It exists only inside the QR,
  which has to be scanned from roughly 25 cm. Text on a rack front is readable
  across the room and already in frame of whatever camera points at the rack.
  The rail's typed-fallback line carries the SSID and the way back, nothing else.
- **The window is derived from a deadline, not a timer.** `rail_face()`
  recomputes on every call, so the revert cannot be missed — and the face also
  drops instantly if the Wi-Fi feed goes away mid-reveal.
- **`PANEL_RAIL_WIFI_QR=0` removes it entirely**, restoring the single-face
  rail exactly as it was, for a deployment that will not take the trade.

Residual risk, stated plainly: anyone who can touch the panel can photograph
the code and decode it. Anyone who can touch the panel is already standing at
the rack.

The face refuses to arm at all when there is no passphrase, when the AP is
disabled or unreachable, or when the payload exceeds the ~62-byte budget that
keeps the code above the 4 px/module scan floor (a 32-char SSID plus a 16-char
passphrase clears it). A rail that stays on the dashboard is the honest
failure; a card nobody can scan is the one the brief calls worse than no QR.

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

### Deployment shapes: where the QR creds come from (`DROPLET_AP_MODE`)

The two shipping deployment shapes broadcast the pairing AP differently,
so the bridge sources the QR creds differently per `DROPLET_AP_MODE`:

| Mode | Shape | Source |
|------|-------|--------|
| `uci` (default) | multi-box | OpenWrt router's UCI `wireless.*` over SSH (`OPENWRT_*`) |
| `hostapd` | single-box | `DROPLET_AP_SSID` / `DROPLET_AP_PSK` from the bridge env; falls back to parsing `/etc/hostapd.conf` inside the `droplet-openwrt` container |
| `auto` | either | hostapd when `DROPLET_AP_SSID` is set or UCI wireless is empty/unreachable; otherwise uci |

`DROPLET_AP_MODE` gates the **Wi-Fi scan** behind `GET /wifi` as well, not
just the QR creds (WARP-1830). Only the `uci` shape has a router to ask, so
only it opens the SSH `iwinfo` scan; the other shapes go straight to the host
`nmcli` fallback. When neither can answer, the two cases are reported
differently on purpose:

| `state` | Meaning |
|---------|---------|
| `unavailable` | a router we were right to ask did not answer — a **fault**, with `error` set |
| `not-applicable` | this shape has no router of its own to scan; Wi-Fi is served by the external AP. `error` is `null` and `detail` says so |

That distinction matters on the `edge-router` shape (ADR-033 §3), where the
box is a wired DHCP client with its radio deactivated and an **empty network
list is the correct answer** — not a degraded one.

> **`sshpass` is a runtime dependency of the `uci` shape only.** When
> `OPENWRT_PASS` is set the bridge wraps `ssh` in `sshpass`, and that binary
> is not installed by `install-device-bridge.sh` or any image build. Install
> it (`apt-get install sshpass`) on a multi-box appliance, or leave
> `OPENWRT_PASS` empty and give the `droplet` user a key-based login to the
> router — the bridge already builds a plain `ssh` argv in that case. If it
> is missing, `GET /wifi` and `GET /openwrt/qr` say so in `error` rather than
> surfacing a bare `[Errno 2] ... 'sshpass'`.

The single-box shape runs a **raw hostapd AP on the host** (via the
`droplet-openwrt-attach` script), not OpenWrt/UCI — so `uci show wireless`
is empty there and the multi-box lookup returns "no active AP", leaving
the pairing QR blank. Set `DROPLET_AP_MODE=hostapd` in
`/etc/droplet/device-bridge.env` on a single-box install so `GET
/openwrt/qr` builds the QR from the hostapd creds instead (WARP-654):

```bash
# /etc/droplet/device-bridge.env (single-box)
DROPLET_AP_MODE=hostapd
DROPLET_AP_SSID=Droplet          # or omit to read /etc/hostapd.conf
DROPLET_AP_PSK=T3stCamPw!
```

**Rotation is always disabled in hostapd mode** (there's no UCI to push a
new PSK to). `GET /openwrt/qr` returns `rotation_enabled: false` and
`POST /openwrt/wifi/rotate` returns `rotation_disabled` as before, so the
PyPortal hides the Rotate pill + TTL chip. The dict shape is otherwise
identical to the multi-box path, so the PyPortal client is shape-agnostic.

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

### Install on the appliance

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
