/**
 * WARP-3509 — the Events page named cameras by their Frigate key
 * ("warp lab office") while its own filter chip showed the name the household
 * gave ("Warp Lab Office"). One resolver, so a card and a chip cannot disagree.
 */
import { describe, it, expect } from "vitest";
import { cameraLabeler, prettifyCameraKey } from "./camera-display";

describe("prettifyCameraKey", () => {
  // The orchestrator derives a camera's default displayName from its key as
  // `name.replace(/_/g, " ").replace(/\b\w/g, upper)` (camera.service.ts
  // toDisplayName). Same rule here, so a key the cameras list does not carry
  // yet reads the way the list will name it a moment later.
  it.each([
    ["warp_lab_office", "Warp Lab Office"],
    ["front_door", "Front Door"],
    ["driveway", "Driveway"],
    ["cam_1", "Cam 1"],
    ["front-door", "Front-Door"],
    ["", ""],
  ])("%j → %j", (key, expected) => {
    expect(prettifyCameraKey(key)).toBe(expected);
  });
});

describe("cameraLabeler", () => {
  const cameras = [
    { name: "warp_lab_office", displayName: "Warp Lab Office" },
    { name: "front_door", displayName: "Lobby" },
    { name: "garage", displayName: "" },
  ];

  it("returns the name the household gave the camera", () => {
    expect(cameraLabeler(cameras)("front_door")).toBe("Lobby");
  });

  it("returns the same string the filter chip shows for that camera", () => {
    const label = cameraLabeler(cameras);
    for (const cam of cameras.filter((c) => c.displayName)) {
      expect(label(cam.name)).toBe(cam.displayName);
    }
  });

  it("falls back to the prettified key for a camera the list does not carry", () => {
    expect(cameraLabeler(cameras)("side_gate")).toBe("Side Gate");
  });

  it("falls back to the prettified key when the list has a blank name for it", () => {
    expect(cameraLabeler(cameras)("garage")).toBe("Garage");
  });

  it("falls back to the prettified key while the cameras list has not loaded", () => {
    expect(cameraLabeler([])("warp_lab_office")).toBe("Warp Lab Office");
  });
});
