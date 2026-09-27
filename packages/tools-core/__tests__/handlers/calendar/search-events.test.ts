import { describe, it, expect } from "vitest";
import searchEvents from "../../../src/handlers/calendar/search-events.js";
import { json, orchestratorCtx, queryOf } from "../../helpers/orchestrator-ctx.js";

const DENTIST = {
  id: "e1",
  userId: "alice",
  title: "Dentist appointment",
  startsAt: "2026-08-01T10:00:00.000Z",
  endsAt: "2026-08-01T11:00:00.000Z",
  allDay: false,
  location: "Downtown clinic",
  meetingUrl: null,
  source: "local",
};

describe("search_calendar_events", () => {
  it("requires auth", async () => {
    const o = orchestratorCtx("");
    const r = await searchEvents.handler({ query: "standup" }, o.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(o.get).not.toHaveBeenCalled();
  });

  it("🔴 WARP-3101 searches the acting person's calendar through the orchestrator, range and limit threaded", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { events: [DENTIST] }));
    const r = await searchEvents.handler(
      { query: "  dentist ", from: "2026-08-01T00:00:00Z", to: "2026-08-31T00:00:00Z", limit: 5 },
      o.ctx,
    );
    expect(o.get).toHaveBeenCalledTimes(1);
    const [path] = o.get.mock.calls[0]!;
    expect(path.split("?")[0]).toBe("/api/calendar/events");
    expect(queryOf(path)).toEqual({
      q: "dentist",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T00:00:00.000Z",
      limit: "5",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { type: string; count: number; query: string; events: Array<Record<string, unknown>> };
      expect(data.type).toBe("search_calendar_events");
      expect(data.count).toBe(1);
      expect(data.query).toBe("dentist");
      // Event shape mirrors list_events so the two tools stay interchangeable.
      expect(data.events[0]).toEqual({
        id: "e1",
        title: "Dentist appointment",
        starts_at: "2026-08-01T10:00:00.000Z",
        ends_at: "2026-08-01T11:00:00.000Z",
        all_day: false,
        location: "Downtown clinic",
        meeting_url: null,
        source: "local",
      });
    }
  });

  it("sends no range when none is given, and defaults the limit to 25", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { events: [] }));
    const r = await searchEvents.handler({ query: "standup" }, o.ctx);
    expect(r.ok).toBe(true);
    expect(queryOf(o.get.mock.calls[0]![0])).toEqual({ q: "standup", limit: "25" });
  });

  it("threads a one-sided range (from only)", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { events: [] }));
    await searchEvents.handler({ query: "standup", from: "2026-08-01T00:00:00Z" }, o.ctx);
    expect(queryOf(o.get.mock.calls[0]![0])).toEqual({ q: "standup", from: "2026-08-01T00:00:00.000Z", limit: "25" });
  });

  it("rejects a range-only call: query is required", async () => {
    const o = orchestratorCtx();
    const r = await searchEvents.handler({ from: "2026-08-01T00:00:00Z", to: "2026-08-31T00:00:00Z" }, o.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(o.get).not.toHaveBeenCalled();
  });

  it("rejects an over-long query without a hop", async () => {
    const o = orchestratorCtx();
    const r = await searchEvents.handler({ query: "x".repeat(201) }, o.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(o.get).not.toHaveBeenCalled();
  });

  it("rejects invalid dates without a hop", async () => {
    const o = orchestratorCtx();
    for (const args of [
      { query: "standup", from: "garbage" },
      { query: "standup", to: "not-a-date" },
    ]) {
      const r = await searchEvents.handler(args, o.ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(o.get).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range or non-integer limit without a hop", async () => {
    const o = orchestratorCtx();
    for (const limit of [0, 101, 2.5, "ten"]) {
      const r = await searchEvents.handler({ query: "standup", limit }, o.ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(o.get).not.toHaveBeenCalled();
  });

  it("returns an empty result cleanly", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { events: [] }));
    const r = await searchEvents.handler({ query: "nothing-matches" }, o.ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { count: number; events: unknown[] };
      expect(data.count).toBe(0);
      expect(data.events).toEqual([]);
    }
  });

  it("a refusal is FORBIDDEN and a failure an error — never an empty result", async () => {
    const denied = orchestratorCtx();
    denied.get.mockResolvedValueOnce(json(403, { error: "forbidden_tool_for_role", tool: "search_calendar_events" }));
    expect(await searchEvents.handler({ query: "x" }, denied.ctx)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const down = orchestratorCtx();
    down.get.mockResolvedValueOnce(json(503, {}));
    expect(await searchEvents.handler({ query: "x" }, down.ctx)).toMatchObject({ ok: false, error: { code: "SEARCH_FAILED" } });

    const off = orchestratorCtx();
    off.get.mockResolvedValueOnce(json(404, { error: "module_disabled", module: "calendar" }));
    expect(await searchEvents.handler({ query: "x" }, off.ctx)).toMatchObject({ ok: false, error: { code: "MODULE_DISABLED" } });
  });

  it("metadata: Tier-1 read-only, query required, no extra args", () => {
    expect(searchEvents.name).toBe("search_calendar_events");
    expect(searchEvents.requiresWrite).toBe(false);
    expect(searchEvents.requiresConfirmation).toBe(false);
    const schema = searchEvents.inputSchema as {
      required?: readonly string[];
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["query"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["from", "limit", "query", "to"]);
    // The calendar has no attendee data — the description must say so, or
    // the model will try to search by attendee and misread empty results.
    expect(searchEvents.description).toMatch(/attendee/i);
  });
});
