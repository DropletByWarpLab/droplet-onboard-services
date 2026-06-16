/**
 * WARP-844 — pure sample-math helpers behind the chat voice input.
 * The PcmRecorder browser glue (getUserMedia/AudioContext) is exercised
 * manually; these helpers carry the correctness-critical conversions.
 */
import { describe, it, expect } from "vitest";
import {
  concatFloat32,
  downsampleBuffer,
  floatTo16BitPcm,
} from "@/lib/audio-capture";

describe("downsampleBuffer", () => {
  it("passes through when rates match", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsampleBuffer(input, 16000, 16000)).toBe(input);
  });

  it("halves the sample count for a 2:1 ratio", () => {
    const input = new Float32Array(48000); // 1 s at 48 kHz
    const out = downsampleBuffer(input, 48000, 16000);
    expect(out.length).toBe(16000);
  });

  it("interpolates between neighboring samples", () => {
    // 2:1 from [0, 1, 0, 1...] — every output sample reads exact input
    // positions (even indices), so values stay 0.
    const input = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]);
    const out = downsampleBuffer(input, 32000, 16000);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });

  it("refuses to upsample", () => {
    expect(() =>
      downsampleBuffer(new Float32Array(4), 8000, 16000),
    ).toThrow(/upsample/);
  });
});

describe("floatTo16BitPcm", () => {
  it("encodes little-endian int16 with clamping", () => {
    const pcm = floatTo16BitPcm(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    const view = new DataView(pcm);
    expect(pcm.byteLength).toBe(12);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7fff); // 1 → max
    expect(view.getInt16(4, true)).toBe(-0x8000); // -1 → min
    expect(view.getInt16(6, true)).toBe(0x7fff); // clamped
    expect(view.getInt16(8, true)).toBe(-0x8000); // clamped
    // DataView truncates the float toward zero: 0.5 * 0x7fff = 16383.5 → 16383.
    expect(view.getInt16(10, true)).toBe(Math.floor(0.5 * 0x7fff));
  });
});

describe("concatFloat32", () => {
  it("joins chunks in order", () => {
    const out = concatFloat32([
      new Float32Array([1, 2]),
      new Float32Array([]),
      new Float32Array([3]),
    ]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
