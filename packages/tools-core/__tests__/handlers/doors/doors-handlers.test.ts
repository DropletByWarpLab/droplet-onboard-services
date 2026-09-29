/**
 * ADR-055 (P4a) — `doors_list` and `doors_recent_events`.
 *
 * Two read-only tools over the orchestrator's `/api/doors` routes. What these
 * tests pin, beyond "it calls the right URL":
 *
 *   - the calls made (an injected orchestrator client, asserted on the paths
 *     and query strings — a handler that returns the right shape from the
 *     wrong endpoint is wrong);
 *   - §11.5: the tools are read-only by flag AND by construction — no POST,
 *     PATCH or DELETE is ever issued, whatever arguments a model invents;
 *   - a door with no position source is reported as "not_monitored", never
 *     as closed, and an unknown position is never read as closed;
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

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

function wireDoor(over: Record<string, unknown> = {}) {
  return {
    id: "door-1",
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
    doorId: "door-1",
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
    await doorsList.handler({ unlock: true, door_id: "door-1", action: "unlock" }, ctx);
    expect(get.mock.calls[0][0]).toBe("/api/doors");
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("names each door's position and what it can raise; a door with no position source is not_monitored", async () => {
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
          wireDoor({ id: "door-3", name: "Side gate", doorPositionSource: "dp1", position: "unknown" }),
        ],
      }),
    );
    const out = await doorsList.handler({}, ctx);
    expect(out.ok).toBe(true);
    const doors = dataOf(out).doors as Array<Record<string, unknown>>;
    expect(doors.map((d) => [d.name, d.position])).toEqual([
      ["Front door", "closed"],
      ["Back door", "not_monitored"],
      ["Side gate", "unknown"],
    ]);
    expect(doors[1].alarms).toEqual({ forced_door: null, held_open: false });
    expect(doors[0].alarms).toEqual({ forced_door: "latch_witnessed", held_open: true });
    expect(dataOf(out).count).toBe(3);
  });

  it("carries the caveats a model would otherwise get wrong, and says it cannot unlock", async () => {
    get.mockResolvedValue(res(true, 200, { doors: [wireDoor()] }));
    const note = String(dataOf(await doorsList.handler({}, ctx)).note);
    expect(note).toMatch(/unknown/i);
    expect(note).toMatch(/not_monitored/);
    expect(note).toMatch(/cannot (lock|unlock|open)/i);
  });

  it("reads a switched-off module as 'not switched on', not as an empty list of doors", async () => {
    get.mockResolvedValue(res(false, 404, { error: "module_disabled", module: "doors" }));
    const out = await doorsList.handler({}, ctx);
    expect(out.ok).toBe(false);
    expect(errorOf(out).code).toBe("DOORS_NOT_AVAILABLE");
  });

  it("maps 403 and 5xx to their own codes", async () => {
    get.mockResolvedValue(res(false, 403, { error: "forbidden" }));
    expect(errorOf(await doorsList.handler({}, ctx)).code).toBe("DOORS_FORBIDDEN");
    get.mockResolvedValue(res(false, 502, {}));
    expect(errorOf(await doorsList.handler({}, ctx)).code).toBe("DOORS_API_ERROR");
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
  });

  it("narrows to one door by id, url-encoded", async () => {
    get.mockResolvedValue(res(true, 200, { events: [], nextCursor: null }));
    await doorsRecentEvents.handler({ door_id: "a b/c", limit: 5 }, ctx);
    expect(get.mock.calls[0][0]).toBe("/api/doors/events?limit=5&door=a%20b%2Fc");
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

  it("reads a switched-off module as 'not switched on'", async () => {
    get.mockResolvedValue(res(false, 404, { error: "module_disabled", module: "doors" }));
    expect(errorOf(await doorsRecentEvents.handler({}, ctx)).code).toBe("DOORS_NOT_AVAILABLE");
  });
});
