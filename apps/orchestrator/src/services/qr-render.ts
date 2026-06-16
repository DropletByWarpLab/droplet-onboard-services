/**
 * QR code → PNG buffer for the status display screen.
 *
 * The status display is 480×320. The QR is sized at QR_SIZE (280) px
 * and left-aligned with a 20 px inset, leaving ~164 px to the right
 * for a caption strip. Both compose into one PNG so the display
 * service's `POST /display/custom` (which takes a single image) can
 * render it without needing a new endpoint.
 *
 * Module is small + dependency-light by design: `qrcode` for the QR
 * encoding plus `pngjs` for the caption-strip compose. `pngjs` is
 * pinned as a direct dependency in apps/orchestrator/package.json
 * (rather than relying on `qrcode`'s transitive pngjs@5) so its major
 * version stays predictable across future `qrcode` bumps. `@types/pngjs`
 * is still pinned to 6.x; the PNG.sync.read/write surface we use is
 * API-compatible between pngjs 5 and 6.
 *
 * Used by `screen-qr.service.ts` which owns the "what should be on
 * the screen right now" state machine. This module is just the
 * render primitive.
 */
import QRCode from "qrcode";

/** Target dimensions for the status display. */
export const SCREEN_WIDTH = 480;
export const SCREEN_HEIGHT = 320;

/** Size of the QR square in pixels — fits the screen height with a small inset. */
const QR_SIZE = 280;

/** Margin (quiet zone) inside the QR itself, in QR modules. 2 is the recommended minimum. */
const QR_MARGIN = 2;

export interface QRRender {
  /** Raw PNG bytes ready for `POST /display/custom`. */
  png: Buffer;
  /** Width × height of the produced PNG. */
  width: number;
  height: number;
}

/**
 * Encode `payload` as a QR code, centered on a black 480×320 canvas
 * sized for the status display. Returns the composed PNG.
 *
 * `caption` is rendered to the right of the QR if provided — useful
 * for "Scan to set up" or "VPN peer added" labels.
 */
export async function renderQRToScreenPng(
  payload: string,
  options: { caption?: string } = {},
): Promise<QRRender> {
  if (!payload || !payload.trim()) {
    throw new Error("QR payload cannot be empty");
  }

  // qrcode.toBuffer with type:"png" returns just the QR — square, with
  // the configured margin baked into the pixel count. We then composite
  // it onto a 480×320 canvas with the caption.
  const qrPng = await QRCode.toBuffer(payload, {
    type: "png",
    width: QR_SIZE,
    margin: QR_MARGIN,
    errorCorrectionLevel: "M", // medium — survives a smudged screen
    color: { dark: "#000000", light: "#FFFFFF" },
  });

  // Composite onto the full screen via pngjs (direct dep — see the
  // module docstring for why it's pinned independently of qrcode).
  const composed = await composeOnCanvas(qrPng, options.caption || "");
  return { png: composed, width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
}

/**
 * Composite the QR PNG onto a 480×320 black canvas. The QR is left-
 * aligned with a 20 px inset; the caption (if any) is rendered to its
 * right in a simple bitmap font produced inline.
 *
 * We avoid Canvas / Sharp / node-gd because they pull native deps.
 * pngjs is pure JS and is plenty for our needs: we just need to place
 * pixels. Pinned directly in package.json (see module docstring).
 */
async function composeOnCanvas(qrPng: Buffer, caption: string): Promise<Buffer> {
  // Dynamic import so the test suite that mocks out qrcode doesn't
  // also need pngjs in the module graph.
  const { PNG } = await import("pngjs");

  const canvas = new PNG({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT });
  // Black background by default — PNG ctor zeroes the buffer.
  // Set alpha to 255 so the display backend's PIL Image.open() reads
  // it as opaque black (PIL treats alpha-zero pixels as undefined).
  for (let i = 3; i < canvas.data.length; i += 4) {
    canvas.data[i] = 255;
  }

  // Parse the QR into a PNG we can read pixel-by-pixel.
  const qr = PNG.sync.read(qrPng);

  // Place QR left-aligned with 20 px inset, vertically centered.
  const qrX = 20;
  const qrY = Math.floor((SCREEN_HEIGHT - qr.height) / 2);
  blitPng(qr, canvas, qrX, qrY);

  // Caption to the right of the QR. Simple wrap at ~12 chars per line.
  if (caption.trim()) {
    const captionX = qrX + qr.width + 16;
    const captionY = Math.max(20, qrY);
    renderCaption(canvas, caption.trim(), captionX, captionY, SCREEN_WIDTH - captionX - 8);
  }

  return PNG.sync.write(canvas);
}

/**
 * Copy `src` PNG pixels into `dst` PNG at offset (x, y). Both must be
 * RGBA. Pixels outside the dst bounds are skipped (clamping, not
 * wrapping) so a too-wide QR won't corrupt memory.
 */
function blitPng(
  src: import("pngjs").PNG,
  dst: import("pngjs").PNG,
  x: number,
  y: number,
): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const sIdx = (sy * src.width + sx) * 4;
      const dIdx = (dy * dst.width + dx) * 4;
      dst.data[dIdx] = src.data[sIdx];
      dst.data[dIdx + 1] = src.data[sIdx + 1];
      dst.data[dIdx + 2] = src.data[sIdx + 2];
      dst.data[dIdx + 3] = src.data[sIdx + 3];
    }
  }
}

/**
 * Draw `text` onto the canvas using a tiny built-in 5×7 bitmap font.
 *
 * We don't pull a typeface or canvas library — a 5×7 font is enough
 * for "Scan to set up" / "VPN peer added" / SSID display, which are
 * the only captions this surface needs. Renders white-on-black,
 * wrapping at word boundaries when the line exceeds `maxWidth`.
 *
 * The font glyphs are encoded as 7 bytes per character (one byte per
 * row, 5 LSBs are the row pixels). Only ASCII printable range —
 * unknown chars render as a filled block.
 */
function renderCaption(
  canvas: import("pngjs").PNG,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
): void {
  const GLYPH_W = 5;
  const GLYPH_H = 7;
  const SCALE = 4; // ~20×28 px per char — readable from across a desk
  const GLYPH_PX_W = GLYPH_W * SCALE;
  const SPACING_PX = 4;
  const LINE_HEIGHT = GLYPH_H * SCALE + 8;
  const CHARS_PER_LINE = Math.max(1, Math.floor(
    (maxWidth + SPACING_PX) / (GLYPH_PX_W + SPACING_PX),
  ));

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  const pushCurrent = () => {
    if (current) {
      lines.push(current);
      current = "";
    }
  };
  for (const w of words) {
    // A single word longer than CHARS_PER_LINE (e.g. a 12-char SSID
    // or peer label) used to get pushed as a too-long line and then
    // character-clipped at the canvas edge — invisibly dropping the
    // tail. Fall back to character-level wrapping for that word so
    // the full text remains readable across multiple lines.
    if (w.length > CHARS_PER_LINE) {
      pushCurrent();
      for (let i = 0; i < w.length; i += CHARS_PER_LINE) {
        lines.push(w.slice(i, i + CHARS_PER_LINE));
      }
      continue;
    }
    if (!current) {
      current = w;
    } else if ((current + " " + w).length <= CHARS_PER_LINE) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  pushCurrent();

  let cursorY = y;
  for (const line of lines) {
    let cursorX = x;
    for (const ch of line) {
      drawGlyph(canvas, ch, cursorX, cursorY, SCALE);
      cursorX += GLYPH_PX_W + SPACING_PX;
      if (cursorX + GLYPH_PX_W > canvas.width) break;
    }
    cursorY += LINE_HEIGHT;
    if (cursorY + GLYPH_H * SCALE > canvas.height) break;
  }
}

/** Draw a single character `ch` at (x, y) scaled by `scale`. */
function drawGlyph(
  canvas: import("pngjs").PNG,
  ch: string,
  x: number,
  y: number,
  scale: number,
): void {
  const glyph = FONT[ch.toUpperCase()] || FONT[""];
  for (let row = 0; row < 7; row++) {
    const bits = glyph[row];
    for (let col = 0; col < 5; col++) {
      if ((bits >> (4 - col)) & 1) {
        // Fill a scale×scale block of white pixels.
        for (let sy = 0; sy < scale; sy++) {
          const py = y + row * scale + sy;
          if (py < 0 || py >= canvas.height) continue;
          for (let sx = 0; sx < scale; sx++) {
            const px = x + col * scale + sx;
            if (px < 0 || px >= canvas.width) continue;
            const idx = (py * canvas.width + px) * 4;
            canvas.data[idx] = 255;
            canvas.data[idx + 1] = 255;
            canvas.data[idx + 2] = 255;
            canvas.data[idx + 3] = 255;
          }
        }
      }
    }
  }
}

/**
 * 5×7 bitmap font, ASCII uppercase + digits + a handful of punctuation.
 * Each glyph is 7 bytes; lower 5 bits of each byte are the row's pixels
 * (bit 4 = leftmost column). Captions are short labels — full ASCII
 * coverage isn't needed.
 *
 * Unknown chars render via the empty key `""` (filled block) so we
 * never silently drop characters.
 */
const FONT: Record<string, number[]> = {
  "": [0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F], // unknown — solid block
  " ": [0, 0, 0, 0, 0, 0, 0],
  "A": [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  "B": [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
  "C": [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
  "D": [0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C],
  "E": [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
  "F": [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
  "G": [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0E],
  "H": [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  "I": [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
  "J": [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
  "K": [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  "L": [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
  "M": [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
  "N": [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  "O": [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  "P": [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
  "Q": [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
  "R": [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
  "S": [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
  "T": [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  "U": [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  "V": [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
  "W": [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A],
  "X": [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
  "Y": [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
  "Z": [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
  "0": [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
  "1": [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
  "2": [0x0E, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1F],
  "3": [0x1F, 0x02, 0x04, 0x06, 0x01, 0x11, 0x0E],
  "4": [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
  "5": [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
  "6": [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
  "7": [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
  "9": [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
  ".": [0, 0, 0, 0, 0, 0x06, 0x06],
  ",": [0, 0, 0, 0, 0, 0x06, 0x04],
  "-": [0, 0, 0, 0x0E, 0, 0, 0],
  ":": [0, 0x06, 0x06, 0, 0x06, 0x06, 0],
  "/": [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  "?": [0x0E, 0x11, 0x01, 0x02, 0x04, 0, 0x04],
  "!": [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04],
};
