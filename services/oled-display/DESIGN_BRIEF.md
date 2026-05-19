# Front-panel TFT — design brief for redesign

This is the spec to hand to a designer (or Claude Design) when redesigning the
small 480×320 touch screen on the front of the Droplet appliance. The goal is
a **more modern look** without losing function. Everything below is either a
hard constraint or a redesign target — keep them straight.

## What it is

A **resistive-touch 480×320 TFT** mounted in the front of the Droplet box.
This is the only on-device surface the customer sees every day — phones and
laptops talk to the appliance through the web dashboard, but the box itself
says "I'm alive" through this screen. Brand-defining.

Hardware: **Adafruit PyPortal Titano** (SAMD51 Cortex-M4F @ 120 MHz, ILI9341
TFT controller, USB-CDC link to the Jetson). Firmware is CircuitPython 9.x.

Files that define the current design:

- [`preview.html`](./preview.html) — interactive 480×320 canvas mockup. Open
  it in a browser, swipe / tap / fire alerts. This is the canonical design
  artifact today.
- [`pyportal/code.py`](./pyportal/code.py) — the firmware that actually
  renders the design on the device. The preview was built to mirror it.
- [`display.py`](./display.py) — host-side renderer (PIL/Pillow). Used by the
  simulator and the `/display/preview` endpoint. Mirrors the same screens.

## Hard constraints — do NOT change

1. **Resolution: 480 × 320 px.** Hardware limit.
2. **Resistive touch, not capacitive.** Min tap target ≈ 44 × 44 px. No
   multi-touch, no gestures more complex than tap + horizontal swipe. Press
   accuracy is ±4 px on a good day. Don't crowd hit targets.
3. **Firmware rendering ceiling (CircuitPython + `displayio` + `vectorio`):**
   - Solid-fill rectangles, polygons, lines.
   - Bitmap text (no vector fonts). Three weights/sizes max per screen.
   - Palettes are reused → keep total unique colors ≤ ~16 per screen.
   - **No CSS gradients, no real anti-aliasing, no photo decode, no blur.**
     The "glow" in `preview.html` is a CSS shadow — it does NOT exist on the
     device. Treat the preview's glows/shadows as visual polish for the
     preview only; the firmware renders crisp, flat shapes.
   - Refresh budget: 5–10 fps for moving elements. Anything ticking faster
     drops frames.
   - Heap is tight (~18 KB panic threshold). No fancy off-screen buffers.
4. **Data contract — the host pushes these payloads (don't invent new
   fields):** see the docstring at the top of [`pyportal/code.py`](./pyportal/code.py).
   The data on each screen must come from one of `stats / wifi / cameras /
   drives / files / qr / alert / message`.
5. **Brand: stays Droplet.** Indigo accent family on dark surfaces. The
   faceted droplet mark geometry is in `drawMark()` in `preview.html` (and
   `apps/web-dashboard/src/components/DropletMark.tsx`). Don't redraw the
   mark from scratch — reuse it.
6. **Three screen roles must survive the redesign:**
   - An ambient / sleep screen (the screensaver).
   - A status / health overview screen.
   - A "join Wi-Fi" screen with the QR + SSID.
   How they look, how you get between them, what's grouped together — all
   open. The roles themselves are not.

## What's open — redesign targets

- **Visual language.** Currently "Ubiquiti-style: half-donut gauges +
  rolled-up cards." Free to throw that out. Tile grid, big-number cards,
  linear bars, sparkline-led, single-hero-metric — all on the table.
- **Information hierarchy.** What's the FIRST thing the customer should see
  on each screen? The current Stats screen treats all 4 gauges + 4 cards
  with equal weight. A "calmer" design with one or two hero metrics is
  welcome.
- **Navigation model.** Today: swipe carousel between Stats ⇄ Idle ⇄ QR,
  with a small pill tab bar at the bottom of active screens. Alternatives:
  drawer, persistent side rail, single home + drilldowns, etc.
- **Iconography.** Currently almost none. Bitmap icons are fine (drawn as
  polygons in firmware).
- **The idle / sleep screen.** Currently clock-centric. Could be ambient
  metric ticker, breathing brand mark, weather glance, last activity, etc.
  Whatever it is, it has to be readable at arm's length in an indoor room
  with mixed lighting.
- **Color usage.** Stay on the dark surface family + indigo brand, but how
  vibrant / muted / how much status color appears is open.
- **Density.** Phone-screen-density is fine. Apple-Watch-density is fine.
  Whatever serves the data best.
- **Typography.** Pick a single bitmap-friendly typeface family and 2–3
  sizes. We can pre-bake the font into firmware if needed.

## Design tokens (current — change deliberately)

```
BG            #050507   page background
PANEL         #0D0D12   headers, drawer chrome
SURFACE       #141420   card / chip fill
SURFACE_2     #1D1D2E   active card fill
SEPARATOR     #2A2A38   1px hairlines
SEPARATOR_2   #3A3A4A

TEXT          #FFFFFF   primary
LABEL_2       #C8C8D4   secondary
LABEL_3       #8B8B9C   tertiary
LABEL_4       #545466   quaternary

ACCENT        #8B93FF   indigo accent
ACCENT_PRI    #7C7FFF   primary droplet fill
ACCENT_LIGHT  #B4BAFF   droplet highlight
GAUGE_TRACK   #24243A

GREEN         #3DFF9F   OK
ORANGE        #FFB347   warn
RED           #FF5C7A   error / alert
```

Change them if the new direction calls for it — but stay within the
dark-mode + indigo brand. Don't introduce light mode (the screen is always
on, in a room, glare matters).

## Current screens — what they show today

**1. Idle (sleep / screensaver).** Droplet mark + giant HH:MM clock with
slow-blink colon + short date + two info pills at the bottom (IP, SSID).
Fades back here after 30s of no touch.

**2. Stats.** Header strip with hostname + IP + uptime, clock and alert
bubble in the top right. Row of 4 half-donut gauges (CPU / MEM / DISK /
TEMP) with mini sparklines underneath. Then two rows of two summary cards:
Network, Storage, Cameras, Wi-Fi. Each card has a small status dot. Tap the
red `!` bubble → alerts drawer slides in from the right.

**3. QR / Join Wi-Fi.** Header. Big white QR card on the left (~220 px),
right column shows SSID / SECURITY / BAND, a TTL chip if key rotation is
enabled, and a "⟳ Rotate now" pill button.

**Alerts drawer (overlay on Stats).** Right-side drawer over a dimmed
backdrop, list of alert rows (icon + title + detail + time), per-row clear
×, and a Clear-all button at the bottom.

## Deliverables I need back from the design step

One of, in priority order:

1. **A new `preview.html`-style mockup** (canvas-based, 480×320, JS-driven,
   no CSS effects that aren't reproducible in firmware). This is the cleanest
   hand-off because I can port it screen-for-screen into `pyportal/code.py`.
2. **Three flat 480×320 PNGs** — one per screen — plus a short spec for any
   state changes (alerts drawer open, swipe transition, dimmed idle).
3. **A Figma/sketch file** plus an explicit color + spacing token sheet. Less
   ideal because I have to reconstruct the geometry from measurements.

Whatever the format, the deliverable must answer:

- Exact pixel coordinates of every text + shape on each screen.
- Color of every fill / stroke (from the token sheet or hex).
- Hit regions for every interactive element (rect coords).
- Any state variation (idle vs active, OK vs warn vs error coloring,
  alert-bubble badge count > 1).

## Implementation path (after design lands)

When you bring back the redesigned screens, the port goes:

1. Update [`preview.html`](./preview.html) first — easiest to iterate, lets
   you sign off on pixels before firmware.
2. Mirror into [`display.py`](./display.py) — same screens via PIL so the
   `/display/preview` endpoint and the `sim` backend stay accurate.
3. Mirror into [`pyportal/code.py`](./pyportal/code.py) — the actual device
   firmware. Tighter constraints (palette reuse, heap budget).
4. Re-flash the PyPortal (drop `boot.py` + `code.py` onto the `CIRCUITPY`
   mount), or hot-reload over the REPL on `/dev/ttyACM0`.

The serial command schema in `code.py`'s docstring stays untouched — that's
how the host pushes data into the screens, and changing it breaks the
orchestrator client. Design freely on top of the same payloads.
