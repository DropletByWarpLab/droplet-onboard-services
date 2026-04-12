# OLED Display Service

Drives a **Waveshare 1.5" SSD1351 128x128 RGB OLED** via SPI on the Jetson GPIO headers.

## Hardware Wiring (Jetson SPI0)

| OLED Pin | Jetson Pin | Function |
|----------|------------|----------|
| VCC | Pin 1 (3.3V) | Power |
| GND | Pin 6 (GND) | Ground |
| DIN | Pin 19 (SPI0 MOSI) | Data |
| CLK | Pin 23 (SPI0 SCLK) | Clock |
| CS | Pin 24 (SPI0 CS0) | Chip Select |
| DC | Pin 18 (GPIO24) | Data/Command |
| RST | Pin 22 (GPIO25) | Reset |

## API (port 8082)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/display/status` | Current mode, brightness, cycling state |
| POST | `/display/stats` | Show device stats |
| POST | `/display/logo` | Show Droplet logo |
| POST | `/display/message` | Custom text `{title, lines}` |
| POST | `/display/custom` | Upload image (multipart) |
| POST | `/display/brightness` | Set brightness `{value: 0-255}` |
| POST | `/display/cycle/resume` | Resume auto-cycling |
| POST | `/display/cycle/stop` | Stop auto-cycling |
| GET | `/display/preview` | Download current frame PNG (sim mode) |

## Auto-Cycle

By default the display cycles: **logo (5s) -> stats (10s) -> repeat**.
When the LLM sends a message via `/display/message`, cycling pauses for 30 seconds then resumes.

## Simulated Mode

When no SPI hardware is detected, frames render to `/tmp/oled_preview.png` for preview.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8082` | Listen port |
| `DC_PIN` | `18` | Data/Command GPIO |
| `RST_PIN` | `22` | Reset GPIO |
| `SPI_DEVICE` | `/dev/spidev0.0` | SPI device |
| `SERVICE_SECRET` | _(empty)_ | Auth token |
| `SIM_OUTPUT` | `/tmp/oled_preview.png` | Simulated output path |
