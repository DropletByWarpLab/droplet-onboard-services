/**
 * WARP-3505 / WARP-3506 — the camera NAME is the Frigate key, so it is
 * normalised as the operator types instead of being rejected after the fact.
 *
 * Mixed-case names and hyphens were accepted by the form but are not what
 * Frigate keys cameras by in practice (the discovery service lowercases and
 * underscores everything it generates), so a "Front-Door" typed here produced a
 * name no other surface would ever produce. Lowercase letters, digits and
 * underscores only.
 */
import { describe, it, expect } from "vitest";
import { CAMERA_NAME_MAX, normalizeCameraName } from "./camera-name";

describe("normalizeCameraName", () => {
  it.each([
    ["front_door", "front_door"],
    ["Front Door", "front_door"],
    ["Front-Door", "front_door"],
    ["  front   door  ", "_front_door_"],
    ["front - door", "front_door"],
    ["XNV_C8083R", "xnv_c8083r"],
    ["xnv-c8083r", "xnv_c8083r"],
    ["cam #1!", "cam_1"],
    ["Éclair", "clair"],
    ["日本語", ""],
    ["", ""],
  ])("%j -> %j", (raw, expected) => {
    expect(normalizeCameraName(raw)).toBe(expected);
  });

  it("caps the length at what the server accepts", () => {
    expect(normalizeCameraName("a".repeat(100))).toHaveLength(CAMERA_NAME_MAX);
    expect(CAMERA_NAME_MAX).toBe(64);
  });

  it("is idempotent, so re-normalising a stored name never changes it", () => {
    for (const raw of ["Front Door-1", "XNV_C8083R", "a b-c_d"]) {
      const once = normalizeCameraName(raw);
      expect(normalizeCameraName(once)).toBe(once);
    }
  });

  it("only ever returns something the orchestrator's name rule accepts (or empty)", () => {
    for (const raw of ["Front Door-1", "XNV_C8083R", "cam #1!", "ÉCLAIR", "a".repeat(80)]) {
      const out = normalizeCameraName(raw);
      expect(out === "" || /^[a-z0-9_]{1,64}$/.test(out)).toBe(true);
    }
  });
});
