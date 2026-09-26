import { describe, it, expect } from "vitest";
import createReminder from "../../../src/handlers/reminders/create-reminder.js";
import { json, orchestratorCtx } from "../../helpers/orchestrator-ctx.js";

describe("create_reminder", () => {
  it("rejects bad due_at without a hop", async () => {
    const o = orchestratorCtx();
    const r = await createReminder.handler({ title: "x", due_at: "garbage" }, o.ctx);
    expect(r.ok).toBe(false);
    expect(o.post).not.toHaveBeenCalled();
  });

  it("requires auth", async () => {
    const o = orchestratorCtx(null);
    const r = await createReminder.handler({ title: "x", due_at: "2026-04-01T08:00:00Z" }, o.ctx);
    expect(r).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(o.post).not.toHaveBeenCalled();
  });

  it("🔴 WARP-3101 creates the reminder through the orchestrator, which files it under the acting person", async () => {
    const o = orchestratorCtx();
    o.post.mockResolvedValueOnce(json(201, { reminder: { id: "r1", userId: "alice", dueAt: "2026-04-01T08:00:00.000Z" } }));
    const r = await createReminder.handler(
      { title: " Take pill ", body: "The blue one", due_at: "2026-04-01T08:00:00Z", calendar_event_id: "ev1" },
      o.ctx,
    );
    expect(r).toEqual({ ok: true, data: { id: "r1", due_at: "2026-04-01T08:00:00.000Z" } });
    expect(o.post).toHaveBeenCalledTimes(1);
    const [path, body] = o.post.mock.calls[0]!;
    expect(path).toBe("/api/reminders");
    // No owner in the body — the route decides whose reminder it is.
    expect(body).toEqual({ title: "Take pill", body: "The blue one", dueAt: "2026-04-01T08:00:00.000Z", calendarEventId: "ev1" });
  });

  it.each([
    [403, { error: "acting_user_required" }, "FORBIDDEN"],
    [403, { error: "forbidden_tool_for_role", tool: "create_reminder" }, "FORBIDDEN"],
    [400, { error: "invalid_request", details: { fieldErrors: { calendarEventId: ["Invalid uuid"] } } }, "INVALID_ARGS"],
    [500, {}, "CREATE_FAILED"],
  ])("%i %j → %s", async (status, body, code) => {
    const o = orchestratorCtx();
    o.post.mockResolvedValueOnce(json(status, body));
    const r = await createReminder.handler({ title: "x", due_at: "2026-04-01T08:00:00Z" }, o.ctx);
    expect(r).toMatchObject({ ok: false, error: { code } });
  });
});
