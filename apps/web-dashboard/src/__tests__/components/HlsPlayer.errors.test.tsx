import { describe, it, expect } from "vitest";

import { translateError } from "@/lib/friendly-errors";

/**
 * WARP-294 — Unit test for the media-domain translation HlsPlayer now
 * uses on its fatal-error path (replacing the raw
 * `${data.details ?? data.type}` string interpolation).
 *
 * Rationale for not driving HlsPlayer end-to-end: the player
 * dynamically imports hls.js and attaches to MSE / native HLS, neither
 * of which is available in jsdom. The fatal-error site in HlsPlayer
 * is a one-liner now:
 *
 *     onError?.(translateError({ code: data.details ?? data.type }, "media"));
 *
 * so the contract that matters — "the enum never reaches the parent's
 * setPlayerError" — is fully covered by exercising translateError with
 * representative hls.js enum values.
 */
describe("HlsPlayer fatal-error translation (WARP-294)", () => {
  const FATAL_ENUMS = [
    "bufferStalledError",
    "bufferAppendError",
    "bufferNudgeOnStall",
    "manifestLoadError",
    "manifestLoadTimeOut",
    "manifestParsingError",
    "levelLoadError",
    "levelLoadTimeOut",
    "fragLoadError",
    "fragLoadTimeOut",
    "fragParsingError",
    "internalException",
    "mediaError",
    "networkError",
  ];

  it("never surfaces an hls.js enum value verbatim", () => {
    for (const enumValue of FATAL_ENUMS) {
      const result = translateError({ code: enumValue }, "media");
      expect(result, `enum=${enumValue}`).not.toContain(enumValue);
    }
  });

  it("returns a non-empty playback-oriented string for every fatal enum", () => {
    for (const enumValue of FATAL_ENUMS) {
      const result = translateError({ code: enumValue }, "media");
      expect(result, `enum=${enumValue}`).toBeTypeOf("string");
      expect(result.length, `enum=${enumValue}`).toBeGreaterThan(0);
    }
  });

  it("falls back to a fixed friendly playback string for unknown details", () => {
    // hls.js has dozens of enum values; the helper is only required
    // to know the popular ones. Unknowns must NOT leak.
    const result = translateError({ code: "someBrandNewHlsEnumValue" }, "media");
    expect(result).not.toContain("someBrandNewHlsEnumValue");
    expect(result.toLowerCase()).toMatch(/play|video|recording|stream/);
  });
});
