import { describe, it, expect } from "vitest";
import createEvent from "../../../src/handlers/calendar/create-event.js";
import { json, orchestratorCtx } from "../../helpers/orchestrator-ctx.js";

const CREATED = { event: { id: "evt1", title: "Lunch", startsAt: "2026-04-01T12:00:00.000Z" } };

describe("create_event", () => {
  it("requires auth", async () => {
    const o = orchestratorCtx("");
    const r = await createEvent.handler(
      { title: "x", starts_at: "2026-04-01T00:00Z", ends_at: "2026-04-01T01:00Z" },
      o.ctx,
    );
    expect(r.ok).toBe(false);
    expect(o.post).not.toHaveBeenCalled();
  });

  it("rejects bad timestamps without a hop", async () => {
    const o = orchestratorCtx();
    const r = await createEvent.handler({ title: "x", starts_at: "garbage", ends_at: "2026-04-01T01:00Z" }, o.ctx);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(o.post).not.toHaveBeenCalled();
  });

  it("rejects ends_at <= starts_at without a hop", async () => {
    const o = orchestratorCtx();
    const r = await createEvent.handler(
      { title: "x", starts_at: "2026-04-01T01:00Z", ends_at: "2026-04-01T01:00Z" },
      o.ctx,
    );
    expect(r.ok).toBe(false);
    expect(o.post).not.toHaveBeenCalled();
  });

  it("🔴 WARP-3101 creates the event through the orchestrator, which files it under the acting person", async () => {
    const o = orchestratorCtx();
    o.post.mockResolvedValueOnce(json(201, CREATED));
    const r = await createEvent.handler(
      {
        title: "  Lunch  ",
        description: "With the team",
        location: "Canteen",
        starts_at: "2026-04-01T12:00:00Z",
        // Zone-less, as the model sometimes sends it: local time. A day
        // later, so it is after the start in any zone.
        ends_at: "2026-04-02T13:00",
        all_day: false,
      },
      o.ctx,
    );
    expect(r).toEqual({ ok: true, data: { id: "evt1", title: "Lunch", starts_at: "2026-04-01T12:00:00.000Z" } });
    expect(o.post).toHaveBeenCalledTimes(1);
    const [path, body] = o.post.mock.calls[0]!;
    expect(path).toBe("/api/calendar/events");
    // No owner in the body — the route decides whose calendar it is. Dates go
    // out as the strict ISO-8601 the route takes.
    expect(body).toEqual({
      title: "Lunch",
      description: "With the team",
      location: "Canteen",
      startsAt: "2026-04-01T12:00:00.000Z",
      endsAt: new Date("2026-04-02T13:00").toISOString(),
      allDay: false,
    });
  });

  it("a refusal to act for this person is FORBIDDEN, not a success", async () => {
    for (const error of ["acting_user_required", "forbidden_tool_for_role"]) {
      const o = orchestratorCtx();
      o.post.mockResolvedValueOnce(json(403, { error }));
      const r = await createEvent.handler(
        { title: "x", starts_at: "2026-04-01T12:00:00Z", ends_at: "2026-04-01T13:00:00Z" },
        o.ctx,
      );
      expect(r, error).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
  });

  it("a 400 names the fields the route refused", async () => {
    const o = orchestratorCtx();
    o.post.mockResolvedValueOnce(json(400, { error: "invalid_request", details: { fieldErrors: { description: ["too long"] } } }));
    const r = await createEvent.handler(
      { title: "x", description: "d".repeat(10001), starts_at: "2026-04-01T12:00:00Z", ends_at: "2026-04-01T13:00:00Z" },
      o.ctx,
    );
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_ARGS", message: "invalid description" } });
  });

  it("the Calendar module switched off (404 module_disabled) says so", async () => {
    const o = orchestratorCtx();
    o.post.mockResolvedValueOnce(json(404, { error: "module_disabled", module: "calendar" }));
    const r = await createEvent.handler(
      { title: "x", starts_at: "2026-04-01T12:00:00Z", ends_at: "2026-04-01T13:00:00Z" },
      o.ctx,
    );
    expect(r).toMatchObject({ ok: false, error: { code: "MODULE_DISABLED" } });
  });

  it("any other failure is CREATE_FAILED, whatever the body", async () => {
    const o = orchestratorCtx();
    o.post.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    const r = await createEvent.handler(
      { title: "x", starts_at: "2026-04-01T12:00:00Z", ends_at: "2026-04-01T13:00:00Z" },
      o.ctx,
    );
    expect(r).toMatchObject({ ok: false, error: { code: "CREATE_FAILED" } });
  });
});
