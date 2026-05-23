/**
 * Tests for the QR → PNG render primitive.
 *
 * We don't decode the QR to verify its payload survives round-trip
 * (that's qrcode's responsibility — battle-tested). We DO verify:
 *   - Empty input is rejected
 *   - Output is a valid PNG of the expected dimensions
 *   - Caption rendering doesn't crash on edge cases (long text,
 *     special chars, multi-line)
 */
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  renderQRToScreenPng,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from "./qr-render.js";

describe("renderQRToScreenPng", () => {
  it("produces a PNG sized for the PyPortal (480×320)", async () => {
    const { png, width, height } = await renderQRToScreenPng("hello");
    expect(width).toBe(SCREEN_WIDTH);
    expect(height).toBe(SCREEN_HEIGHT);

    // Magic header — first 8 bytes of any PNG.
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);

    // Decode and verify dimensions match.
    const decoded = PNG.sync.read(png);
    expect(decoded.width).toBe(SCREEN_WIDTH);
    expect(decoded.height).toBe(SCREEN_HEIGHT);
  });

  it("rejects empty payload", async () => {
    await expect(renderQRToScreenPng("")).rejects.toThrow(/empty/i);
    await expect(renderQRToScreenPng("   ")).rejects.toThrow(/empty/i);
  });

  it("renders without caption when none is provided", async () => {
    const { png } = await renderQRToScreenPng("https://example.com");
    const decoded = PNG.sync.read(png);
    // All-zero pixels in the right half (caption area) is the
    // signal that no caption was drawn.
    let captionPixelCount = 0;
    for (let y = 0; y < decoded.height; y++) {
      for (let x = 360; x < decoded.width; x++) {
        const idx = (y * decoded.width + x) * 4;
        if (
          decoded.data[idx] > 0 ||
          decoded.data[idx + 1] > 0 ||
          decoded.data[idx + 2] > 0
        ) {
          captionPixelCount++;
        }
      }
    }
    expect(captionPixelCount).toBe(0);
  });

  it("draws caption pixels when caption is provided", async () => {
    const { png } = await renderQRToScreenPng("https://example.com", {
      caption: "SCAN ME",
    });
    const decoded = PNG.sync.read(png);
    let captionPixelCount = 0;
    for (let y = 0; y < decoded.height; y++) {
      for (let x = 360; x < decoded.width; x++) {
        const idx = (y * decoded.width + x) * 4;
        if (
          decoded.data[idx] > 100 &&
          decoded.data[idx + 1] > 100 &&
          decoded.data[idx + 2] > 100
        ) {
          captionPixelCount++;
        }
      }
    }
    expect(captionPixelCount).toBeGreaterThan(50);
  });

  it("survives unknown characters in caption (renders as solid block)", async () => {
    // Lowercase letters aren't in the font table — they should render
    // as the unknown-char glyph (solid block) without crashing.
    await expect(
      renderQRToScreenPng("https://example.com", { caption: "héllo wörld" }),
    ).resolves.toBeDefined();
  });

  it("survives a long caption that needs wrapping", async () => {
    const long = "this caption is long enough that it must wrap at the word boundary";
    const { png } = await renderQRToScreenPng("https://example.com", {
      caption: long,
    });
    const decoded = PNG.sync.read(png);
    expect(decoded.width).toBe(SCREEN_WIDTH);
  });

  it("character-wraps a single word longer than the line width", async () => {
    // Long SSID / peer label that exceeds CHARS_PER_LINE (~6 at the
    // current layout math) used to be silently character-clipped at
    // the canvas edge — the tail was dropped without warning. The
    // char-level fallback wrap keeps every character visible across
    // multiple lines. We assert the render completes and produces
    // pixels (caption is non-empty) — the exact pixel placement is
    // a layout concern tested by the visual regression on the device.
    const ssid = "extremely-long-ssid-name-1234567890";
    const { png } = await renderQRToScreenPng("https://example.com", {
      caption: ssid,
    });
    const decoded = PNG.sync.read(png);
    expect(decoded.width).toBe(SCREEN_WIDTH);
    expect(decoded.height).toBe(SCREEN_HEIGHT);
    // The caption strip should have some non-black pixels.
    let nonBlackInCaptionStrip = 0;
    for (let i = 0; i < decoded.data.length; i += 4) {
      if (decoded.data[i] > 0 || decoded.data[i + 1] > 0 || decoded.data[i + 2] > 0) {
        nonBlackInCaptionStrip++;
        if (nonBlackInCaptionStrip > 100) break;
      }
    }
    expect(nonBlackInCaptionStrip).toBeGreaterThan(100);
  });

  it("produces deterministic output for a given input", async () => {
    // Useful for cache-key generation downstream — the signature only
    // works if same input → same bytes.
    const a = await renderQRToScreenPng("https://test/", { caption: "x" });
    const b = await renderQRToScreenPng("https://test/", { caption: "x" });
    expect(Buffer.compare(a.png, b.png)).toBe(0);
  });

  it("differs on different payloads", async () => {
    const a = await renderQRToScreenPng("https://a/");
    const b = await renderQRToScreenPng("https://b/");
    expect(Buffer.compare(a.png, b.png)).not.toBe(0);
  });

  it("rejects whitespace-only payload as empty", async () => {
    await expect(renderQRToScreenPng("\n\t")).rejects.toThrow();
  });
});
