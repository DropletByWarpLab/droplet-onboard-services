/**
 * ADR-055 (P4a) — the §9.7 door-state derivations, as pure functions.
 *
 * Every rule below is a sentence of brief §9.7. The negative ones matter most:
 * an alarm the product cannot derive must not be one it advertises, so a door
 * with no position source gets no forced-door and no held-open claim, however
 * its (impossible) event stream is arranged.
 */
import { describe, expect, it } from "vitest";
import type { AccessEventKind } from "@prisma/client";
import {
  HEARTBEAT_MISSES_FOR_UNKNOWN,
  HEARTBEAT_SECONDS,
  INITIAL_DOOR_STATE,
  advanceDoorState,
  alarmClaimsFor,
  assessDoorOpen,
  deriveAlarms,
  foldDoorState,
  heldOpenDue,
  positionOf,
  positionUnknownDue,
  type DoorEventLike,
} from "./door-derivations.js";

const T0 = Date.UTC(2026, 8, 29, 2, 0, 0);
let nextId = 1;
/** One event `sec` seconds after T0. Ids are strings, as a BigInt column reads back. */
function ev(kind: AccessEventKind, sec: number): DoorEventLike {
  return { id: String(nextId++), kind, at: new Date(T0 + sec * 1000) };
}
const at = (sec: number) => new Date(T0 + sec * 1000);

describe("forced door — brief §9.7", () => {
  it("lock door: door open while the latch still reports extended, with no grant, REX or key override, is forced", () => {
    const open = ev("door_open", 10);
    const alarms = deriveAlarms("lock", 30, [ev("latch_extended", 0), open], at(11));
    expect(alarms).toEqual([
      {
        kind: "forced_door",
        forcedClaim: "latch_witnessed",
        derivedFromId: open.id,
        occurredAt: open.at,
        dedupeKey: `derived:forced_door:${open.id}`,
      },
    ]);
  });

  it.each(["unlock_granted", "rex", "key_override"] as const)(
    "lock door: a preceding %s makes the open expected, not forced",
    (kind) => {
      const events = [ev("latch_extended", 0), ev(kind, 5), ev("door_open", 10)];
      expect(deriveAlarms("lock", 30, events, at(11)).map((a) => a.kind)).toEqual([]);
    },
  );

  it("lock door: a latch that is retracted (or never reported) is not 'still extended' — no forced claim", () => {
    const retracted = [ev("latch_extended", 0), ev("latch_retracted", 4), ev("door_open", 10)];
    expect(deriveAlarms("lock", 30, retracted, at(11))).toEqual([]);
    const silent = [ev("door_open", 10)];
    expect(deriveAlarms("lock", 30, silent, at(11))).toEqual([]);
  });

  it("dp1 door has no latch term: open with no preceding grant or REX is the weaker, labelled claim", () => {
    const open = ev("door_open", 10);
    const [alarm] = deriveAlarms("dp1", 30, [open], at(11));
    expect(alarm).toMatchObject({ kind: "forced_door", forcedClaim: "unwitnessed_open", derivedFromId: open.id });
  });

  it("dp1 door: a grant or REX precedes the open; a key override does not count (no latch term, no key sensor)", () => {
    expect(deriveAlarms("dp1", 30, [ev("unlock_granted", 1), ev("door_open", 10)], at(11))).toEqual([]);
    expect(deriveAlarms("dp1", 30, [ev("rex", 1), ev("door_open", 10)], at(11))).toEqual([]);
    const [alarm] = deriveAlarms("dp1", 30, [ev("key_override", 1), ev("door_open", 10)], at(11));
    expect(alarm?.forcedClaim).toBe("unwitnessed_open");
  });

  it("a second door_open while the door is already open is the same opening, not a second alarm", () => {
    const events = [ev("latch_extended", 0), ev("door_open", 10), ev("door_open", 12)];
    expect(deriveAlarms("lock", 30, events, at(13)).filter((a) => a.kind === "forced_door")).toHaveLength(1);
  });

  it("assessDoorOpen reads the state BEFORE the open", () => {
    const secure = foldDoorState("lock", [ev("latch_extended", 0)]);
    expect(assessDoorOpen("lock", secure)).toBe("latch_witnessed");
    const authorised = foldDoorState("lock", [ev("latch_extended", 0), ev("rex", 3)]);
    expect(assessDoorOpen("lock", authorised)).toBeNull();
  });
});

describe("doorPositionSource = none — no forced-door or held-open claim (§9.7, §14)", () => {
  // A `none` door cannot produce position events at all; if one is fed in
  // anyway (bad data, a source changed later) the derivations must still say
  // nothing rather than advertise an alarm they cannot stand behind.
  const hostile = [
    ev("latch_extended", 0),
    ev("door_open", 10),
    ev("door_open", 11),
    ev("unlock_granted", 12),
    ev("door_open", 13),
  ];

  it("derives no forced_door and no held_open, however the events are arranged and however late it is", () => {
    for (const now of [at(14), at(14 + 60), at(14 + 86_400)]) {
      expect(deriveAlarms("none", 30, hostile, now)).toEqual([]);
    }
  });

  it("assessDoorOpen and heldOpenDue both refuse", () => {
    const state = foldDoorState("lock", [ev("latch_extended", 0)]);
    expect(assessDoorOpen("none", state)).toBeNull();
    const open = foldDoorState("lock", [ev("unlock_granted", 0), ev("door_open", 1)]);
    expect(heldOpenDue("none", 30, open, at(9_999))).toBe(false);
  });

  it("claims nothing for the UI to advertise", () => {
    expect(alarmClaimsFor("none")).toEqual({ forcedDoor: null, heldOpen: false });
  });
});

describe("held open — brief §9.7", () => {
  const granted = () => [ev("latch_extended", 0), ev("unlock_granted", 1), ev("latch_retracted", 2)];

  it("open past the held-open time after a grant is held open, referencing its door_open row", () => {
    const open = ev("door_open", 10);
    const events = [...granted(), open];
    expect(deriveAlarms("lock", 30, events, at(10 + 31))).toEqual([
      {
        kind: "held_open",
        derivedFromId: open.id,
        occurredAt: at(40),
        dedupeKey: `derived:held_open:${open.id}`,
      },
    ]);
  });

  it("not before the time has passed, and not exactly at it", () => {
    const events = [...granted(), ev("door_open", 10)];
    expect(deriveAlarms("lock", 30, events, at(10 + 29))).toEqual([]);
    expect(deriveAlarms("lock", 30, events, at(10 + 30))).toEqual([]);
  });

  it("after a REX too (any authorisation), on either position source", () => {
    expect(
      deriveAlarms("dp1", 20, [ev("rex", 1), ev("door_open", 5)], at(5 + 21)).map((a) => a.kind),
    ).toEqual(["held_open"]);
  });

  it("not once the door has closed", () => {
    const events = [...granted(), ev("door_open", 10), ev("door_closed", 20)];
    expect(deriveAlarms("lock", 30, events, at(500))).toEqual([]);
  });

  it("an unauthorised open is a forced door, never also held open", () => {
    const events = [ev("latch_extended", 0), ev("door_open", 10)];
    expect(deriveAlarms("lock", 30, events, at(500)).map((a) => a.kind)).toEqual(["forced_door"]);
  });
});

describe("relock — door-closed + latch-extended, not a timer (§9.7)", () => {
  const entry = [
    ev("latch_extended", 0),
    ev("unlock_granted", 1),
    ev("latch_retracted", 2),
    ev("door_open", 3),
  ];

  it("a lock relocks when the door is closed AND the latch is extended, and only then", () => {
    let state = foldDoorState("lock", entry);
    expect(state.authorized).toBe(true);

    const closed = advanceDoorState("lock", state, ev("door_closed", 10));
    // Closed but the latch is still retracted: not secure, authorisation stands.
    expect(closed.relock).toBe(false);
    expect(closed.state.authorized).toBe(true);

    const latched = advanceDoorState("lock", closed.state, ev("latch_extended", 11));
    expect(latched.relock).toBe(true);
    expect(latched.state.authorized).toBe(false);
    state = latched.state;
    expect(assessDoorOpen("lock", state)).toBe("latch_witnessed");
  });

  it("the latch can extend first and the door close after: the relock fires on the second of the pair", () => {
    const opened = foldDoorState("lock", entry);
    const first = advanceDoorState("lock", opened, ev("latch_extended", 10));
    // Door still open: not secure.
    expect(first.relock).toBe(false);
    const second = advanceDoorState("lock", first.state, ev("door_closed", 11));
    expect(second.relock).toBe(true);
  });

  it("has no clock: elapsed time cannot relock, and a later forced entry is caught after a real relock", () => {
    // The advance function takes no `now`; an hour of silence between two
    // events changes nothing about the state it returns.
    expect(advanceDoorState.length).toBe(3);
    const events = [
      ...entry,
      ev("door_closed", 10),
      ev("latch_extended", 11),
      ev("door_open", 4000), // no grant this time
    ];
    expect(deriveAlarms("lock", 30, events, at(4001)).map((a) => a.kind)).toEqual(["forced_door"]);
  });

  it("a grant on a door that is already closed and latched is not spent by the state it arrives into", () => {
    const secure = foldDoorState("lock", [ev("latch_extended", 0), ev("door_closed", 1)]);
    const granted = advanceDoorState("lock", secure, ev("unlock_granted", 2));
    expect(granted.relock).toBe(false);
    expect(granted.state.authorized).toBe(true);
  });

  it("a strike-only door has no latch term: closing the door is its relock", () => {
    const opened = foldDoorState("dp1", [ev("unlock_granted", 1), ev("door_open", 3)]);
    expect(advanceDoorState("dp1", opened, ev("door_closed", 9)).relock).toBe(true);
  });

  it("a door with no position source never relocks", () => {
    const state = foldDoorState("none", [ev("unlock_granted", 1)]);
    expect(advanceDoorState("none", state, ev("door_closed", 9)).relock).toBe(false);
  });
});

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
    expect(alarmClaimsFor("none")).toEqual({ forcedDoor: null, heldOpen: false });
  });
});

describe("state fold", () => {
  it("starts with nothing known", () => {
    expect(INITIAL_DOOR_STATE).toEqual({
      open: null,
      latch: null,
      authorized: false,
      openedAt: null,
      openedAuthorized: false,
    });
  });
});
