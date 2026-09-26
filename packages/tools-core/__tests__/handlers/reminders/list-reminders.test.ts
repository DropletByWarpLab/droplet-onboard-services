import { describe, it, expect } from "vitest";
import listReminders from "../../../src/handlers/reminders/list-reminders.js";
import { json, orchestratorCtx, queryOf } from "../../helpers/orchestrator-ctx.js";

const ROWS = [
  { id: "r1", userId: "alice", title: "Pill", body: null, dueAt: "2026-04-01T08:00:00.000Z", completedAt: null },
  { id: "r2", userId: "alice", title: "Bins", body: "Blue", dueAt: "2026-04-01T09:00:00.000Z", completedAt: "2026-04-01T09:01:00.000Z" },
];

describe("list_reminders", () => {
  it("🔴 WARP-3101 reads the acting person's active reminders from the orchestrator by default", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { reminders: [ROWS[0]] }));
    const r = await listReminders.handler({}, o.ctx);
    expect(o.get).toHaveBeenCalledTimes(1);
    const [path] = o.get.mock.calls[0]!;
    expect(path.split("?")[0]).toBe("/api/reminders");
    expect(queryOf(path)).toEqual({ limit: "50", completed: "false" });
    expect(r).toEqual({
      ok: true,
      data: { count: 1, reminders: [{ id: "r1", title: "Pill", body: null, due_at: "2026-04-01T08:00:00.000Z", completed: false }] },
    });
  });

  it("includes completed reminders when the flag is set, and threads due_before and the limit", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { reminders: ROWS }));
    const r = await listReminders.handler({ include_completed: true, due_before: "2026-04-02T00:00:00Z", limit: 7 }, o.ctx);
    expect(queryOf(o.get.mock.calls[0]![0])).toEqual({ limit: "7", due_before: "2026-04-02T00:00:00.000Z" });
    expect(r.ok && (r.data as { reminders: Array<{ completed: boolean }> }).reminders.map((x) => x.completed)).toEqual([false, true]);
  });

  it("drops an unparseable due_before rather than sending it", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { reminders: [] }));
    await listReminders.handler({ due_before: "whenever" }, o.ctx);
    expect(queryOf(o.get.mock.calls[0]![0])).toEqual({ limit: "50", completed: "false" });
  });

  it("a refusal is FORBIDDEN and a failure an error — never an empty list", async () => {
    const denied = orchestratorCtx();
    denied.get.mockResolvedValueOnce(json(403, { error: "acting_user_required" }));
    expect(await listReminders.handler({}, denied.ctx)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const down = orchestratorCtx();
    down.get.mockResolvedValueOnce(json(500, {}));
    expect(await listReminders.handler({}, down.ctx)).toMatchObject({ ok: false, error: { code: "LIST_FAILED" } });
  });
});
