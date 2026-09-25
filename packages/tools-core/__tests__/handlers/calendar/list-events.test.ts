import { describe, it, expect, vi, afterEach } from "vitest";
import listEvents from "../../../src/handlers/calendar/list-events.js";
import { json, orchestratorCtx, queryOf } from "../../helpers/orchestrator-ctx.js";

const ROW = {
  id: "e1",
  userId: "alice",
  title: "Daily standup",
  startsAt: "2026-04-01T10:00:00.000Z",
  endsAt: "2026-04-01T10:15:00.000Z",
  allDay: false,
  location: null,
  meetingUrl: null,
  source: "local",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("list_events", () => {
  it("requires auth", async () => {
    const o = orchestratorCtx("");
    const r = await listEvents.handler({}, o.ctx);
    expect(r.ok).toBe(false);
    expect(o.get).not.toHaveBeenCalled();
  });

  it("🔴 WARP-3101 reads the acting person's calendar from the orchestrator and maps the rows", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { events: [ROW] }));
    const r = await listEvents.handler({ from: "2026-04-01T00:00:00Z", to: "2026-04-02T00:00:00Z", limit: 5 }, o.ctx);
    expect(o.get).toHaveBeenCalledTimes(1);
    const [path] = o.get.mock.calls[0]!;
    expect(path.split("?")[0]).toBe("/api/calendar/events");
    expect(queryOf(path)).toEqual({ from: "2026-04-01T00:00:00.000Z", to: "2026-04-02T00:00:00.000Z", limit: "5" });
    expect(r).toEqual({
      ok: true,
      data: {
        from: "2026-04-01T00:00:00.000Z",
        to: "2026-04-02T00:00:00.000Z",
        count: 1,
        events: [
          {
            id: "e1",
            title: "Daily standup",
            starts_at: "2026-04-01T10:00:00.000Z",
            ends_at: "2026-04-01T10:15:00.000Z",
            all_day: false,
            location: null,
            meeting_url: null,
            source: "local",
          },
        ],
      },
    });
  });

  it("defaults to the next 30 days and 50 events, and clamps the limit to 200", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00Z"));
    const o = orchestratorCtx();
    o.get.mockImplementation(async () => json(200, { events: [] }));
    await listEvents.handler({}, o.ctx);
    await listEvents.handler({ limit: 999 }, o.ctx);
    expect(queryOf(o.get.mock.calls[0]![0])).toEqual({
      from: "2026-04-01T09:00:00.000Z",
      to: "2026-05-01T09:00:00.000Z",
      limit: "50",
    });
    expect(queryOf(o.get.mock.calls[1]![0]).limit).toBe("200");
  });

  it("a refusal is FORBIDDEN and a failure an error — never an empty calendar", async () => {
    const denied = orchestratorCtx();
    denied.get.mockResolvedValueOnce(json(403, { error: "acting_user_required" }));
    expect(await listEvents.handler({}, denied.ctx)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const down = orchestratorCtx();
    down.get.mockResolvedValueOnce(json(500, {}));
    expect(await listEvents.handler({}, down.ctx)).toMatchObject({ ok: false, error: { code: "LIST_FAILED" } });

    // The Calendar module gate answers 404 module_disabled: say it is off.
    const off = orchestratorCtx();
    off.get.mockResolvedValueOnce(json(404, { error: "module_disabled", module: "calendar" }));
    expect(await listEvents.handler({}, off.ctx)).toMatchObject({ ok: false, error: { code: "MODULE_DISABLED" } });
  });
});
