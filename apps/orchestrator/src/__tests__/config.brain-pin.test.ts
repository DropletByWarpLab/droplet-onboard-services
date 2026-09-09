/**
 * WARP-2838 — `resolveBrainPin`: is the brain switch pinned by the operator?
 *
 * The whole point of this predicate is the case an obvious implementation gets
 * wrong. `BRAIN_ENABLED=` and `${BRAIN_ENABLED:-}` both reach the process as a
 * defined-but-empty string; `raw !== undefined` reads that as a pin, which
 * removes the owner's on-switch from `/brief` on a box nobody meant to pin and
 * replaces it with a line about a configuration nobody set.
 */
import { describe, it, expect } from "vitest";
import { resolveBrainPin } from "../config.js";

describe("resolveBrainPin (WARP-2838)", () => {
  it("is not pinned when the variable is absent", () => {
    expect(resolveBrainPin(undefined)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
  ])("is not pinned when the value is %s — compose interpolates ${VAR:-} to this", (_l, raw) => {
    expect(resolveBrainPin(raw)).toBe(false);
  });

  it.each([
    ["on", "1"],
    ["on, spelled", "true"],
    // 🔴 The OFF pin is a pin. `BRAIN_ENABLED=0` is fleet policy — this box
    // must not read documents — and it has to outrank the owner's row, so it
    // cannot be treated as "not set" just because it resolves to false.
    ["off", "0"],
    ["off, spelled", "false"],
    // Anything else is off per the schema's transform, but it is still an
    // operator who wrote a line, so it still pins.
    ["nonsense", "yes-please"],
  ])("is pinned when the operator wrote %s", (_l, raw) => {
    expect(resolveBrainPin(raw)).toBe(true);
  });
});
