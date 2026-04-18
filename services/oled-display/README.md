# TFT Display Service

Drives the **Inland 3.5" RPi TFT LCD Touchscreen Shield** (ILI9481 controller,
480x320, XPT2046 resistive touch) on the Jetson 40-pin header. Directory is
still named `oled-display` for backwards compatibility with the orchestrator
client and docker-compose wiring.

Reference: [Inland RPI TFT 3.5" LCD Touchscreen Shield (Micro Center)](https://community.microcenter.com/kb/articles/650-inland-rpi-tft-3-5-lcd-touchscreen-shield).

## Panel Spec

| Item | Value |
|------|-------|
| Panel | 3.5" a-Si TFT, RGB stripes |
| Resolution | 480 x 320 |
| Active area | 48.96 x 73.44 mm |
| Controller | ILI9481 (ILI9486 command-set compatible) |
| Interface | SPI (bridge logic on shield) |
| Touch | XPT2046 resistive |
| Backlight | 6x white LEDs, parallel |

## Hardware Wiring (Jetson 40-pin, Pi-shield compatible)

The shield seats directly onto the Jetson 40-pin header; these are the pins it
uses.

| Shield signal | Jetson pin | Function |
|---------------|-----------|----------|
| VCC | 1 (3.3V) | Power |
| 5V | 2 (5V) | Backlight rail |
| GND | 6 (GND) | Ground |
| LCD MOSI | 19 (SPI0 MOSI) | LCD data |
| LCD MISO | 21 (SPI0 MISO) | (unused for panel; needed for XPT2046) |
| LCD SCLK | 23 (SPI0 SCLK) | LCD clock |
| LCD CS | 24 (SPI0 CS0) | LCD chip select |
| DC / RS | 18 (GPIO24) | Data/Command |
| RST | 22 (GPIO25) | Reset |
| Touch CS | 26 (SPI0 CS1) | XPT2046 chip select |
| Touch IRQ | 11 (GPIO17) | XPT2046 pen-interrupt |
| BL | 12 (PWM0) | Backlight PWM (optional) |

## Display backends

The service auto-selects the first available of these three backends:

1. **framebuffer** - opens `/dev/fb1` and writes packed RGB565 bytes. This is
   the recommended path on Jetson: load the `fbtft` kernel module with the
   `fb_ili9481` driver and the panel appears as a standard Linux framebuffer.
2. **SPI** - direct SPI via `luma.lcd`'s `ili9486` driver (register-compatible
   with ILI9481).
3. **simulated** - renders frames to `/tmp/tft_preview.png` for dev/CI.

Force a specific backend by setting `DISPLAY_BACKEND=framebuffer|spi|sim`.

### Jetson setup: fbtft framebuffer (recommended)

```bash
# Enable SPI and load the fb_ili9481 driver at boot
sudo modprobe fbtft_device name=flexfb gpios=dc:18,reset:22 speed=32000000 rotate=270
sudo modprobe flexfb width=480 height=320 regwidth=16 \
  init=-1,0x11,-2,120,-1,0x36,0x28,-1,0x3A,0x55,-1,0x29,-3

# Verify
ls /dev/fb*          # should show /dev/fb1
fbset -fb /dev/fb1   # should report 480x320-16
```

For persistence, add the `flexfb` modprobe lines to `/etc/modules-load.d/tft.conf`
and the options to `/etc/modprobe.d/tft.conf`.

### Touchscreen: ads7846 / xpt2046 kernel driver

```bash
sudo modprobe ads7846 spi_bus_num=0 cs=1 irq_gpio=17 \
  pressure_max=255 x_min=200 x_max=3900 y_min=200 y_max=3900 swap_xy=1
# event device appears at /dev/input/eventN - verify with evtest
```

If the kernel driver can't be loaded, the service falls back to reading the
XPT2046 directly over SPI (CE1 at 1 MHz).

## API (port 8082)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (reports backend + resolution) |
| GET | `/display/status` | Current mode, brightness, cycling state, backend |
| POST | `/display/stats` | Show 4-card device stats dashboard |
| POST | `/display/logo` | Show full-screen Droplet logo |
| POST | `/display/message` | Custom text `{title, lines[]}` - up to 10 lines |
| POST | `/display/custom` | Upload image (multipart, max 8MB) |
| POST | `/display/brightness` | Set brightness `{value: 0-255}` |
| POST | `/display/cycle/resume` | Resume auto-cycling |
| POST | `/display/cycle/stop` | Stop auto-cycling |
| GET | `/display/preview` | Download current frame PNG (sim mode only) |
| GET | `/touch/state` | Last touch coords + press/release counters |

## Auto-cycle

Logo (5s) -> stats (10s) -> repeat. When an LLM calls `/display/message`,
cycling pauses for 30 s then resumes.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8082` | Listen port |
| `DISPLAY_BACKEND` | `auto` | `auto` / `framebuffer` / `spi` / `sim` |
| `FB_DEVICE` | `/dev/fb1` | Framebuffer path (framebuffer backend) |
| `SPI_DEVICE` | `/dev/spidev0.0` | SPI device (spi backend) |
| `LCD_DRIVER` | `ili9486` | luma.lcd driver name (9481-compatible) |
| `LCD_WIDTH` / `LCD_HEIGHT` | `480` / `320` | Panel resolution |
| `LCD_ROTATE` | `0` | Rotation (0-3) |
| `SPI_HZ` | `32000000` | SPI bus speed |
| `DC_PIN` | `18` | Data/Command GPIO |
| `RST_PIN` | `22` | Reset GPIO |
| `BACKLIGHT_PIN` | `12` | Backlight PWM pin (informational) |
| `TOUCH_BACKEND` | `auto` | `auto` / `evdev` / `spi` / `sim` |
| `TOUCH_EVENT_DEVICE` | _(autodetect)_ | Explicit evdev path |
| `TOUCH_CS` | `1` | XPT2046 chip-select (CE1) |
| `TOUCH_IRQ_PIN` | `11` | Pen-interrupt GPIO |
| `TOUCH_CAL_X_MIN/MAX` | `200` / `3900` | Raw X calibration |
| `TOUCH_CAL_Y_MIN/MAX` | `200` / `3900` | Raw Y calibration |
| `TOUCH_SWAP_XY` | `1` | Swap X/Y axes |
| `TOUCH_INVERT_X` | `0` | Invert X axis |
| `TOUCH_INVERT_Y` | `1` | Invert Y axis |
| `SERVICE_SECRET` | _(empty)_ | Bearer token required on all non-`/health` routes |
| `SIM_OUTPUT` | `/tmp/tft_preview.png` | Simulated output path |
