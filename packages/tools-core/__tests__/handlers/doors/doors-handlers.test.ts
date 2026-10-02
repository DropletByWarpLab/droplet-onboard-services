/**
 * ADR-055 (P4b) — `doors_list` and `doors_recent_events`.
 *
 * Two read-only tools over the orchestrator's `/api/doors` routes. What these
 * tests pin, beyond "it calls the right URL":
 *
 *   - the calls made (an injected orchestrator client, asserted on the paths
 *     and query strings — a handler that returns the right shape from the
 *     wrong endpoint is wrong);
 *   - §11.5: the tools are read-only by flag AND by construction — no POST,
 *     PATCH or DELETE is ever issued, whatever arguments a model invents;
 *   - a position is the door's LAST report and never travels without its time:
 *     an open/closed report with no usable time reads as unknown, never as
 *     current (the /doors page's rule, so the assistant cannot say what the
 *     page would not);
 *   - a door with no position source is reported as "not_monitored", never
 *     as closed, and an unknown position is never read as closed;
 *   - an empty or failed log is never a quiet night: the result says so;
 *   - a module that is off reads as "not switched on", not as an empty list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ToolContext } from "../../../src/types.js";
import doorsList from "../../../src/handlers/doors/list.js";
import doorsRecentEvents from "../../../src/handlers/doors/recent-events.js";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
const ctx = {
  http: { orchestrator: { get, post, patch, delete: del } },
} as unknown as ToolContext;

const DOOR_ID = "5b1d2f7e-3a44-4c0e-9d41-2f6c1a7e9b10";

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

function wireDoor(over: Record<string, unknown> = {}) {
  return {
    id: DOOR_ID,
    name: "Front door",
    doorPositionSource: "lock",
    heldOpenSeconds: 30,
    status: "active",
    retiredAt: null,
    position: "closed",
    positionSince: "2026-09-29T01:00:00.000Z",
    claims: { forcedDoor: "latch_witnessed", heldOpen: true },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function wireEvent(over: Record<string, unknown> = {}) {
  return {
    id: "41",
    doorId: DOOR_ID,
    doorName: "Front door",
    kind: "door_open",
    occurredAt: "2026-09-29T02:00:00.000Z",
    forcedClaim: null,
    troubleCode: null,
    derivedFromId: null,
    correlationKey: null,
    ...over,
  };
}

function dataOf(out: unknown): Record<string, unknown> {
  return (out as { data: Record<string, unknown> }).data;
}
function errorOf(out: unknown): { code: string; message: string } {
  return (out as { error: { code: string; message: string } }).error;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shape — §11.5 read-only", () => {
  it.each([doorsList, doorsRecentEvents])("$name is read-only, ungated, and in the doors_ namespace", (tool) => {
    expect(tool.name.startsWith("doors_")).toBe(true);
    expect(tool.requiresWrite).toBe(false);
    expect(tool.requiresConfirmation).toBe(false);
  });

  it("neither tool's schema offers a way to say lock, unlock, open, grant or credential", () => {
    for (const tool of [doorsList, doorsRecentEvents]) {
      const props = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const p of props) expect(p).not.toMatch(/lock|unlock|open|grant|credential|command|action/i);
    }
  });
});

describe("doors_list", () => {
  it("reads GET /api/doors and issues nothing else", async () => {
    get.mockResolvedValue(res(true, 200, { doors: [wireDoor()] }));
    await doorsList.handler({}, ctx);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe("/api/doors");
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("ignores any argument a model invents — a guessed `unlock: true` reaches nothing", async () => {
    get.mockResolvedValue(res(true, 200, { doors: [] }));
    await doorsList.handler({ unlock: true, door_id: DOOR_ID, action: "unlock", include: "retired" }, ctx);
    // No query string at all: not even `include=retired` is passed through.
    expect(get.mock.calls[0][0]).toBe("/api/doors");
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("names each door's position WITH when it reported it, and what the door can flag; no position source is not_monitored", async () => {
    get.mockResolvedValue(
      res(true, 200, {
        doors: [
          wireDoor(),
          wireDoor({
            id: "door-2",
            name: "Back door",
            doorPositionSource: "none",
            position: "not_monitored",
            positionSince: null,
            claims: { forcedDoor: null, heldOpen: false },
          }),
          wireDoor({
            id: "door-3",
            name: "Side gate",
            doorPositionSource: "dp1",
            position: "unknown",
            positionSince: null,
            claims: { forcedDoor: "unwitnessed_open", heldOpen: true },
          }),
        ],
      }),
    );
    const out = await doorsList.handler({}, ctx);
    expect(out.ok).toBe(true);
    const doors = dataOf(out).doors as Array<Record<string, unknown>>;
    expect(doors.map((d) => [d.name, d.position, d.since, d.position_from])).toEqual([
      ["Front door", "closed", "2026-09-29T01:00:00.000Z", "lock"],
      ["Back door", "not_monitored", null, "none"],
      ["Side gate", "unknown", null, "door_sensor"],
    ]);
    expect(doors[0].can_flag).toEqual({ forced_door: "latch_witnessed", held_open: true });
    expect(doors[1].can_flag).toEqual({ forced_door: null, held_open: false });
    expect(doors[2].can_flag).toEqual({ forced_door: "unwitnessed_open", held_open: true });
    expect(dataOf(out).count).toBe(3);
  });

  it("an OLD position is still the last report, with its age, and is not aged into unknown (the box does not do that either)", async () => {
    get.mockResolvedValue(res(true, 200, { doors: [wireDoor({ position: "open", positionSince: "2026-01-02T03:04:05.000Z" })] }));
    const [door] = dataOf(await doorsList.handler({}, ctx)).doors as Array<Record<string, unknown>>;
    expect(door.position).toBe("open");
    expect(door.since).toBe("2026-01-02T03:04:05.000Z");
  });

  it.each([
    ["no time at all", null],
    ["a time that does not parse", "yesterday-ish"],
    ["an empty time", ""],
  ])("an open or closed report with %s reads as unknown, never as current", async (_label, positionSince) => {
    for (const position of ["open", "closed"]) {
      get.mockResolvedValue(res(true, 200, { doors: [wireDoor({ position, positionSince })] }));
      const [door] = dataOf(await doorsList.handler({}, ctx)).doors as Array<Record<string, unknown>>;
      expect(door.position, `${position} / ${String(positionSince)}`).toBe("unknown");
      expect(door.since).toBeNull();
    }
  });

  it("carries the caveats a model would otherwise get wrong: age, unknown is not closed, not_monitored, and cannot unlock", async () => {
    get.mockResolvedValue(res(true, 200, { doors: [wireDoor()] }));
    const note = String(dataOf(await doorsList.handler({}, ctx)).note);
    expect(note).toMatch(/last report/i);
    expect(note).toMatch(/never 'now' or 'currently'/);
    expect(note).toMatch(/unknown: no report yet, or the door stopped reporting/);
    expect(note).toMatch(/never read it as closed/i);
    expect(note).toMatch(/not_monitored/);
    expect(note).toMatch(/unwitnessed_open/);
    expect(note).toMatch(/cannot (lock|unlock|open)/i);
    // The page never says Droplet raises an alarm, monitors, or makes anything safe.
    expect(note).not.toMatch(/\b(alarms?|monitor(s|ed|ing)?|secure|armed)\b/i);
  });

  it("reads a switched-off module as 'not switched on', not as an empty list of doors", async () => {
    get.mockResolvedValue(res(false, 404, { error: "module_disabled", module: "doors" }));
    const out = await doorsList.handler({}, ctx);
    expect(out.ok).toBe(false);
    expect(errorOf(out).code).toBe("DOORS_NOT_AVAILABLE");
  });

  it("maps 403 and 5xx to their own codes, and a failed read is never an empty list", async () => {
    get.mockResolvedValue(res(false, 403, { error: "forbidden" }));
    expect(errorOf(await doorsList.handler({}, ctx)).code).toBe("DOORS_FORBIDDEN");
    get.mockResolvedValue(res(false, 503, { error: { code: "DOORS_UNAVAILABLE", message: "Doors are unavailable right now" } }));
    const failed = await doorsList.handler({}, ctx);
    expect(failed.ok).toBe(false);
    expect(errorOf(failed).code).toBe("DOORS_API_ERROR");
    expect(failed).not.toHaveProperty("data");
  });
});

describe("doors_recent_events", () => {
  it("reads GET /api/doors/events with a bounded limit, and issues nothing else", async () => {
    get.mockResolvedValue(res(true, 200, { events: [wireEvent()], nextCursor: null }));
    await doorsRecentEvents.handler({ limit: 10 }, ctx);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe("/api/doors/events?limit=10");
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("defaults to 20 and never asks for more than 50", async () => {
    get.mockResolvedValue(res(true, 200, { events: [], nextCursor: null }));
    await doorsRecentEvents.handler({}, ctx);
    expect(get.mock.calls[0][0]).toBe("/api/doors/events?limit=20");
    await doorsRecentEvents.handler({ limit: 5000 }, ctx);
    expect(get.mock.calls[1][0]).toBe("/api/doors/events?limit=50");
    await doorsRecentEvents.handler({ limit: -3 }, ctx);
    expect(get.mock.calls[2][0]).toBe("/api/doors/events?limit=20");
    await doorsRecentEvents.handler({ limit: "abc" }, ctx);
    expect(get.mock.calls[3][0]).toBe("/api/doors/events?limit=20");
    // A small model writes the integer as a string; that is still a count.
    await doorsRecentEvents.handler({ limit: "7" }, ctx);
    expect(get.mock.calls[4][0]).toBe("/api/doors/events?limit=7");
    await doorsRecentEvents.handler({ limit: 2.5 }, ctx);
    expect(get.mock.calls[5][0]).toBe("/api/doors/events?limit=20");
  });

  it("narrows to one door by id", async () => {
    get.mockResolvedValue(res(true, 200, { events: [], nextCursor: null }));
    await doorsRecentEvents.handler({ door_id: DOOR_ID, limit: 5 }, ctx);
    expect(get.mock.calls[0][0]).toBe(`/api/doors/events?limit=5&door=${DOOR_ID}`);
  });

  it("refuses a door_id that is not an id (a name, a guess, an injection) without reading anything, and says what to do", async () => {
    for (const bad of ["Front door", "a b/c", "1; DROP TABLE", "../doors", "5b1d2f7e"]) {
      const out = await doorsRecentEvents.handler({ door_id: bad }, ctx);
      expect(out.ok, bad).toBe(false);
      expect(errorOf(out).code).toBe("DOORS_INVALID_REQUEST");
      expect(errorOf(out).message).toMatch(/doors_list/);
    }
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("an empty door_id means every door", async () => {
    get.mockResolvedValue(res(true, 200, { events: [], nextCursor: null }));
    await doorsRecentEvents.handler({ door_id: "" }, ctx);
    expect(get.mock.calls[0][0]).toBe("/api/doors/events?limit=20");
  });

  it("returns compact events and no paging cursor (a model asks for 'recent', not for page 2)", async () => {
    get.mockResolvedValue(
      res(true, 200, {
        events: [
          wireEvent({ id: "42", kind: "forced_door", forcedClaim: "latch_witnessed", derivedFromId: "41" }),
          wireEvent({ id: "41" }),
          wireEvent({ id: "40", kind: "trouble", troubleCode: "position_unknown" }),
        ],
        nextCursor: "1790000000000_40",
      }),
    );
    const out = await doorsRecentEvents.handler({}, ctx);
    const data = dataOf(out);
    expect(data).not.toHaveProperty("nextCursor");
    expect(data).not.toHaveProperty("cursor");
    expect(data.count).toBe(3);
    const events = data.events as Array<Record<string, unknown>>;
    expect(events[0]).toEqual({
      time: "2026-09-29T02:00:00.000Z",
      door: "Front door",
      kind: "forced_door",
      claim: "latch_witnessed",
    });
    expect(events[1]).toEqual({ time: "2026-09-29T02:00:00.000Z", door: "Front door", kind: "door_open" });
    expect(events[2]).toEqual({
      time: "2026-09-29T02:00:00.000Z",
      door: "Front door",
      kind: "trouble",
      trouble: "position_unknown",
    });
    // Ids and correlation keys are plumbing, not something to quote to a person.
    expect(JSON.stringify(events)).not.toMatch(/derivedFromId|correlationKey|"id"/);
  });

  it("says when the list was cut short, so a model does not read a full page as the whole history", async () => {
    get.mockResolvedValue(res(true, 200, { events: [wireEvent()], nextCursor: "1790000000000_40" }));
    expect(dataOf(await doorsRecentEvents.handler({}, ctx)).more_available).toBe(true);
    get.mockResolvedValue(res(true, 200, { events: [wireEvent()], nextCursor: null }));
    expect(dataOf(await doorsRecentEvents.handler({}, ctx)).more_available).toBe(false);
  });

  it("an empty log is not a quiet night, and the weaker forced-door claim is not worded as 'forced'", async () => {
    get.mockResolvedValue(res(true, 200, { events: [], nextCursor: null }));
    const data = dataOf(await doorsRecentEvents.handler({}, ctx));
    expect(data.count).toBe(0);
    const note = String(data.note);
    expect(note).toMatch(/empty list does not mean nothing happened/i);
    expect(note).toMatch(/unwitnessed_open/);
    expect(note).toMatch(/not 'forced'/);
    expect(note).toMatch(/cannot (lock|unlock|open)/i);
    expect(note).not.toMatch(/\b(alarms?|monitor(s|ed|ing)?|secure|armed)\b/i);
  });

  it("reads a switched-off module as 'not switched on'", async () => {
    get.mockResolvedValue(res(false, 404, { error: "module_disabled", module: "doors" }));
    expect(errorOf(await doorsRecentEvents.handler({}, ctx)).code).toBe("DOORS_NOT_AVAILABLE");
  });

  it("a failed read is an error, never an empty list that reads as nothing happening", async () => {
    get.mockResolvedValue(res(false, 503, { error: { code: "DOORS_UNAVAILABLE", message: "Doors are unavailable right now" } }));
    const failed = await doorsRecentEvents.handler({}, ctx);
    expect(failed.ok).toBe(false);
    expect(errorOf(failed).code).toBe("DOORS_API_ERROR");
    expect(failed).not.toHaveProperty("data");
  });
});
