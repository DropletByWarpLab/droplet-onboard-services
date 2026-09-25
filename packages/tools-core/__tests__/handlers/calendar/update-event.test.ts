import { describe, it, expect } from "vitest";
import updateEvent from "../../../src/handlers/calendar/update-event.js";
import { json, orchestratorCtx } from "../../helpers/orchestrator-ctx.js";

describe("update_event", () => {
  it("rejects missing id without a hop", async () => {
    const o = orchestratorCtx();
    const r = await updateEvent.handler({}, o.ctx);
    expect(r.ok).toBe(false);
    expect(o.patch).not.toHaveBeenCalled();
  });

  it("rejects an unparseable time without a hop", async () => {
    const o = orchestratorCtx();
    const r = await updateEvent.handler({ id: "x", starts_at: "garbage" }, o.ctx);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(o.patch).not.toHaveBeenCalled();
  });

  it("🔴 WARP-3101 patches through the orchestrator, only the fields passed, dates as ISO-8601", async () => {
    const o = orchestratorCtx();
    o.patch.mockResolvedValueOnce(json(200, { event: { id: "x" } }));
    const r = await updateEvent.handler({ id: "x", title: "new", ends_at: "2026-04-28T11:30" }, o.ctx);
    expect(r).toEqual({ ok: true, data: { id: "x", updated: true } });
    expect(o.patch).toHaveBeenCalledTimes(1);
    const [path, body] = o.patch.mock.calls[0]!;
    expect(path).toBe("/api/calendar/events/x");
    expect(body).toEqual({ title: "new", endsAt: new Date("2026-04-28T11:30").toISOString() });
  });

  // The route now makes the checks this handler used to make itself: whose
  // event it is, whether it is local, and the range after the patch.
  it.each([
    [404, { error: "event_not_found" }, "NOT_FOUND"],
    // The Calendar module gate: switched off is not "no such event".
    [404, { error: "module_disabled", module: "calendar" }, "MODULE_DISABLED"],
    [403, { error: "forbidden" }, "FORBIDDEN"],
    [403, { error: "forbidden_tool_for_role", tool: "update_event" }, "FORBIDDEN"],
    [409, { error: "cannot modify externally-synced event" }, "EXTERNAL_SOURCE"],
    [400, { error: "endsAt must be after startsAt" }, "INVALID_RANGE"],
    [400, { error: "invalid_request", details: { fieldErrors: { title: ["too small"] } } }, "INVALID_ARGS"],
    [500, {}, "UPDATE_FAILED"],
  ])("%i %j → %s", async (status, body, code) => {
    const o = orchestratorCtx();
    o.patch.mockResolvedValueOnce(json(status, body));
    const r = await updateEvent.handler({ id: "x", title: "t" }, o.ctx);
    expect(r).toMatchObject({ ok: false, error: { code } });
  });
});
