/**
 * WARP-1372 — shared undeclared-content text sniffer used by `read-file.ts`
 * and `summarize-file.ts`.
 */
import { describe, it, expect } from "vitest";
import { sniffIsText, SNIFF_BYTES } from "../../../src/handlers/files/_sniff.js";

const enc = new TextEncoder();

describe("sniffIsText", () => {
  it("accepts plain ASCII text", () => {
    expect(sniffIsText(enc.encode("hello, world\nsecond line\n"))).toBe(true);
  });

  it("accepts multibyte UTF-8 text", () => {
    expect(sniffIsText(enc.encode("héllo wörld ✓ — naïve café"))).toBe(true);
  });

  it("rejects content with a NUL byte in the sniff window", () => {
    expect(sniffIsText(new Uint8Array([0x61, 0x62, 0x63, 0x00, 0x64]))).toBe(false);
  });

  it("rejects invalid UTF-8 away from the sniff boundary", () => {
    // 0xFF can never appear in UTF-8; it sits mid-content, so no amount of
    // boundary trimming (up to 3 trailing bytes) forgives it.
    const bytes = new Uint8Array([...enc.encode("hello"), 0xff, ...enc.encode("world")]);
    expect(sniffIsText(bytes)).toBe(false);
  });

  it("tolerates a multibyte char split at the sniff boundary", () => {
    // 'é' (0xC3 0xA9) straddles the SNIFF_BYTES cut: only its first byte
    // lands in the head. A truncated char is not evidence of binary content.
    const bytes = new Uint8Array(SNIFF_BYTES + 1);
    bytes.fill(0x61, 0, SNIFF_BYTES - 1);
    bytes.set([0xc3, 0xa9], SNIFF_BYTES - 1);
    expect(sniffIsText(bytes)).toBe(true);
  });

  it("ignores binary content beyond the sniff window", () => {
    const bytes = new Uint8Array(SNIFF_BYTES + 8);
    bytes.fill(0x61, 0, SNIFF_BYTES);
    bytes.set([0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff], SNIFF_BYTES);
    expect(sniffIsText(bytes)).toBe(true);
  });

  it("treats empty input as not text (existing behavior)", () => {
    expect(sniffIsText(new Uint8Array(0))).toBe(false);
  });
});
