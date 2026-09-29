/**
 * ADR-055 (P4a) — the §9.7 door position and claims, as pure functions.
 *
 * The negative rule matters most: an alarm the product cannot derive must not
 * be one it advertises, so a door with no position source is not monitored and
 * claims neither a forced door nor a held-open time.
 */
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_MISSES_FOR_UNKNOWN,
  HEARTBEAT_SECONDS,
  alarmClaimsFor,
  positionOf,
  positionUnknownDue,
} from "./door-derivations.js";

const T0 = Date.UTC(2026, 8, 29, 2, 0, 0);
const at = (sec: number) => new Date(T0 + sec * 1000);

describe("position unknown — third missed heartbeat (§6.4, §9.7)", () => {
  it("a lock (30 s heartbeat) is unknown at three misses, ~90 s, and not before", () => {
    expect(HEARTBEAT_SECONDS).toEqual({ lock: 30, dp1: 60 });
    expect(HEARTBEAT_MISSES_FOR_UNKNOWN).toBe(3);
    expect(positionUnknownDue({ source: "lock", lastHeartbeatAt: at(0), now: at(89) })).toBe(false);
    expect(positionUnknownDue({ source: "lock", lastHeartbeatAt: at(0), now: at(90) })).toBe(true);
  });

  it("a DP-1 sensor (60 s heartbeat) takes three of its own: 180 s", () => {
    expect(positionUnknownDue({ source: "dp1", lastHeartbeatAt: at(0), now: at(179) })).toBe(false);
    expect(positionUnknownDue({ source: "dp1", lastHeartbeatAt: at(0), now: at(180) })).toBe(true);
  });

  it("a door with no position source has no position to lose", () => {
    expect(positionUnknownDue({ source: "none", lastHeartbeatAt: at(0), now: at(99_999) })).toBe(false);
  });

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
