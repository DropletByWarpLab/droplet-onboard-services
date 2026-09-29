/**
 * ADR-055 (P4a) — the §9.7 door position and claims, as pure functions.
 *
 * The negative rule matters most: an alarm the product cannot derive must not
 * be one it advertises, so a door with no position source is not monitored and
 * claims neither a forced door nor a held-open time.
 */
import { describe, expect, it } from "vitest";
import { alarmClaimsFor, positionOf } from "./door-derivations.js";

describe("door position from the newest event (§9.7)", () => {
  it("never leaves an unheard-from door at 'closed'", () => {
    expect(positionOf("lock", null)).toBe("unknown");
    expect(positionOf("lock", { kind: "door_closed", troubleCode: null })).toBe("closed");
    expect(positionOf("lock", { kind: "door_open", troubleCode: null })).toBe("open");
    // A closed reading followed by the cartridge's position-unknown trouble is unknown, not closed.
    expect(positionOf("dp1", { kind: "trouble", troubleCode: "position_unknown" })).toBe("unknown");
  });

  it("a door with no position source is not monitored — a different answer from unknown", () => {
    expect(positionOf("none", null)).toBe("not_monitored");
    expect(positionOf("none", { kind: "door_open", troubleCode: null })).toBe("not_monitored");
  });
});

describe("alarmClaimsFor — what the UI may say a door can raise", () => {
  it("names the claim each source can make", () => {
    expect(alarmClaimsFor("lock")).toEqual({ forcedDoor: "latch_witnessed", heldOpen: true });
    expect(alarmClaimsFor("dp1")).toEqual({ forcedDoor: "unwitnessed_open", heldOpen: true });
  });

  it("a door with no position source claims nothing for the UI to advertise (§9.7, §14)", () => {
    expect(alarmClaimsFor("none")).toEqual({ forcedDoor: null, heldOpen: false });
  });
});
