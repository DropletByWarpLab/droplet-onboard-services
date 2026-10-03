/**
 * WARP-3506 — one definition of a camera's Frigate key.
 *
 * `POST /api/cameras` stored the operator's name verbatim while `addCamera`
 * filed the camera in Frigate under a lower-cased, sanitised key, and the
 * reconcile that follows every add compared the two case-sensitively — so
 * `Warp_Lab_Office` was added and pruned in the same request. The key is now
 * computed in exactly one place; these cases pin it against the rule
 * camera-discovery's `frigate_client.py::add_camera` applies to its names.
 */
import { describe, it, expect } from "vitest";
import { isFrigateKey, toDisplayName, toFrigateKey } from "./camera-key.js";

describe("toFrigateKey", () => {
  it.each([
    ["Warp_Lab_Office", "warp_lab_office"],
    ["Front-Door", "front_door"],
    ["FRONT_DOOR", "front_door"],
    ["front_door", "front_door"],
    ["a--b", "a__b"],
    ["cam 1", "cam_1"],
    ["cam.1", "cam_1"],
    ["__edge__", "edge"],
    ["-lead-trail-", "lead_trail"],
    ["xnv_c8083r_e43022502afd", "xnv_c8083r_e43022502afd"],
    ["Cam_01", "cam_01"],
  ])("%s -> %s", (typed, key) => {
    expect(toFrigateKey(typed)).toBe(key);
  });

  it("is idempotent — a key is its own key", () => {
    for (const typed of ["Warp_Lab_Office", "Front-Door", "a b c", "__x__"]) {
      const key = toFrigateKey(typed);
      expect(toFrigateKey(key)).toBe(key);
    }
  });

  it("collapses non-ASCII letters to underscores rather than keeping them", () => {
    expect(toFrigateKey("Café-1")).toBe("caf__1");
    expect(toFrigateKey("日本")).toBe("");
  });

  it("returns an empty key for a name with no letter or digit in it", () => {
    expect(toFrigateKey("---")).toBe("");
    expect(toFrigateKey("_")).toBe("");
  });
});

describe("isFrigateKey", () => {
  it("is true only for a non-empty name that is already its own key", () => {
    expect(isFrigateKey("front_door")).toBe(true);
    expect(isFrigateKey("Front_Door")).toBe(false);
    expect(isFrigateKey("front-door")).toBe(false);
    expect(isFrigateKey("_front")).toBe(false);
    expect(isFrigateKey("")).toBe(false);
    expect(isFrigateKey("---")).toBe(false);
  });
});

describe("toDisplayName", () => {
  it("keeps the household label derivation for a key-like name", () => {
    expect(toDisplayName("front_door")).toBe("Front Door");
  });

  it("derives the label from what the operator TYPED, so their hyphens and capitals survive", () => {
    expect(toDisplayName("Warp_Lab_Office")).toBe("Warp Lab Office");
    expect(toDisplayName("Front-Door")).toBe("Front-Door");
  });
});
