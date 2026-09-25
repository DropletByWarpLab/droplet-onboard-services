import { describe, it, expect } from "vitest";
import completeReminder from "../../../src/handlers/reminders/complete-reminder.js";
import { json, orchestratorCtx } from "../../helpers/orchestrator-ctx.js";

describe("complete_reminder", () => {
  it("rejects a missing id without a hop", async () => {
    const o = orchestratorCtx();
    const r = await completeReminder.handler({}, o.ctx);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(o.patch).not.toHaveBeenCalled();
  });

  it("🔴 WARP-3101 completes through the orchestrator by default", async () => {
    const o = orchestratorCtx();
    o.patch.mockResolvedValueOnce(json(200, { reminder: { id: "x" } }));
    const r = await completeReminder.handler({ id: "x" }, o.ctx);
    expect(r).toEqual({ ok: true, data: { id: "x", completed: true } });
    expect(o.patch).toHaveBeenCalledTimes(1);
    expect(o.patch.mock.calls[0]!.slice(0, 2)).toEqual(["/api/reminders/x", { completed: true }]);
  });

  it("re-opens with completed=false", async () => {
    const o = orchestratorCtx();
    o.patch.mockResolvedValueOnce(json(200, { reminder: { id: "x" } }));
    const r = await completeReminder.handler({ id: "x", completed: false }, o.ctx);
    expect(r).toEqual({ ok: true, data: { id: "x", completed: false } });
    expect(o.patch.mock.calls[0]![1]).toEqual({ completed: false });
  });

  it("someone else's reminder answers like a missing one: NOT_FOUND (the route's ORCH-008 404)", async () => {
    const o = orchestratorCtx();
    o.patch.mockResolvedValueOnce(json(404, { error: "reminder_not_found" }));
    const r = await completeReminder.handler({ id: "x" }, o.ctx);
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it.each([
    [403, { error: "acting_user_required" }, "FORBIDDEN"],
    [403, { error: "forbidden_tool_for_role", tool: "complete_reminder" }, "FORBIDDEN"],
    [500, {}, "UPDATE_FAILED"],
  ])("%i %j → %s", async (status, body, code) => {
    const o = orchestratorCtx();
    o.patch.mockResolvedValueOnce(json(status, body));
    const r = await completeReminder.handler({ id: "x" }, o.ctx);
    expect(r).toMatchObject({ ok: false, error: { code } });
  });
});
