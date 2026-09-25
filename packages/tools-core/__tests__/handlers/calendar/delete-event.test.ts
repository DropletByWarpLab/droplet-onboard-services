import { describe, it, expect } from "vitest";
import deleteEvent from "../../../src/handlers/calendar/delete-event.js";
import { json, orchestratorCtx } from "../../helpers/orchestrator-ctx.js";

describe("delete_event", () => {
  it("rejects missing id without a hop", async () => {
    const o = orchestratorCtx();
    const r = await deleteEvent.handler({}, o.ctx);
    expect(r.ok).toBe(false);
    expect(o.delete).not.toHaveBeenCalled();
  });

  it("🔴 WARP-3101 deletes through the orchestrator, which knows whose event it is", async () => {
    const o = orchestratorCtx();
    o.delete.mockResolvedValueOnce(json(200, { deleted: "a/b" }));
    const r = await deleteEvent.handler({ id: "a/b" }, o.ctx);
    expect(r).toEqual({ ok: true, data: { id: "a/b", deleted: true } });
    expect(o.delete).toHaveBeenCalledTimes(1);
    // The id is a path segment, so it is encoded.
    expect(o.delete.mock.calls[0]![0]).toBe("/api/calendar/events/a%2Fb");
  });

  it.each([
    [404, { error: "event_not_found" }, "NOT_FOUND"],
    // The Calendar module gate: switched off is not "no such event".
    [404, { error: "module_disabled", module: "calendar" }, "MODULE_DISABLED"],
    [403, { error: "forbidden" }, "FORBIDDEN"],
    [403, { error: "acting_user_required" }, "FORBIDDEN"],
    [409, { error: "cannot delete externally-synced event (remove the source instead)" }, "EXTERNAL_SOURCE"],
    [500, {}, "DELETE_FAILED"],
  ])("%i %j → %s", async (status, body, code) => {
    const o = orchestratorCtx();
    o.delete.mockResolvedValueOnce(json(status, body));
    const r = await deleteEvent.handler({ id: "x" }, o.ctx);
    expect(r).toMatchObject({ ok: false, error: { code } });
  });
});
