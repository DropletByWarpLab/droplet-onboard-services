/**
 * WARP-1425 — `set_timer`: server-side relative countdown timer backed by
 * a Reminder row. The due time is computed on the box from a frozen
 * `Date.now()` here, never from an LLM-supplied timestamp. Cancel/list are
 * deliberately consolidated onto `complete_reminder` / `list_reminders`.
 *
 * WARP-3101 — the row is created by the orchestrator (`POST /api/reminders`),
 * which files it under the acting person; the tool sends what, and when.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import setTimer from "../../../src/handlers/reminders/set-timer.js";
import { json, orchestratorCtx } from "../../helpers/orchestrator-ctx.js";

const NOW = new Date("2026-07-19T12:00:00Z");

/** `POST /api/reminders` echoing the reminder it was asked to create. */
function timerCtx(userId: string | null = "alice") {
  const o = orchestratorCtx(userId);
  o.post.mockImplementation(async (_path: string, body?: unknown) =>
    json(201, { reminder: { id: "t1", userId: "alice", ...(body as Record<string, unknown>) } }),
  );
  return o;
}

const sent = (o: ReturnType<typeof timerCtx>) => o.post.mock.calls[0]![1] as { title: string; dueAt: string };

describe("set_timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("🔴 WARP-3101 asks the orchestrator for a reminder due exactly 90s from now for {minutes: 1, seconds: 30}", async () => {
    const o = timerCtx();
    const r = await setTimer.handler({ minutes: 1, seconds: 30 }, o.ctx);
    expect(r.ok).toBe(true);
    expect(o.post).toHaveBeenCalledTimes(1);
    expect(o.post.mock.calls[0]![0]).toBe("/api/reminders");
    // No owner in the body — the route decides whose timer it is.
    expect(sent(o)).toEqual({ title: "Timer", dueAt: new Date(NOW.getTime() + 90_000).toISOString() });
    if (r.ok) {
      const data = r.data as {
        type: string;
        id: string;
        title: string;
        due_at: string;
        duration_seconds: number;
      };
      expect(data.type).toBe("set_timer");
      expect(data.id).toBe("t1");
      expect(data.title).toBe("Timer");
      expect(data.due_at).toBe(new Date(NOW.getTime() + 90_000).toISOString());
      expect(data.duration_seconds).toBe(90);
    }
  });

  it("combines hours and minutes", async () => {
    const o = timerCtx();
    const r = await setTimer.handler({ hours: 2, minutes: 15 }, o.ctx);
    expect(r.ok).toBe(true);
    const expectedMs = (2 * 3600 + 15 * 60) * 1000;
    expect(sent(o).dueAt).toBe(new Date(NOW.getTime() + expectedMs).toISOString());
    if (r.ok) {
      expect((r.data as { duration_seconds: number }).duration_seconds).toBe(8100);
    }
  });

  it("trims a custom label", async () => {
    const o = timerCtx();
    const r = await setTimer.handler({ label: "  pasta  ", minutes: 10 }, o.ctx);
    expect(r.ok).toBe(true);
    expect(sent(o).title).toBe("pasta");
    if (r.ok) {
      expect((r.data as { title: string }).title).toBe("pasta");
    }
  });

  it("falls back to the default label when label is blank", async () => {
    const o = timerCtx();
    const r = await setTimer.handler({ label: "   ", seconds: 30 }, o.ctx);
    expect(r.ok).toBe(true);
    expect(sent(o).title).toBe("Timer");
  });

  it("requires auth", async () => {
    const o = timerCtx(null);
    const r = await setTimer.handler({ minutes: 5 }, o.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(o.post).not.toHaveBeenCalled();
  });

  it("rejects a call with no duration components", async () => {
    const o = timerCtx();
    const r = await setTimer.handler({}, o.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(o.post).not.toHaveBeenCalled();
  });

  it("rejects a zero total duration", async () => {
    const o = timerCtx();
    const r = await setTimer.handler({ hours: 0, minutes: 0, seconds: 0 }, o.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(o.post).not.toHaveBeenCalled();
  });

  it("rejects a negative component, naming the field", async () => {
    const o = timerCtx();
    const r = await setTimer.handler({ minutes: -5 }, o.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toContain("minutes");
    }
    expect(o.post).not.toHaveBeenCalled();
  });

  it("rejects a non-integer component, naming the field", async () => {
    const o = timerCtx();
    const r = await setTimer.handler({ seconds: 1.5 }, o.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toContain("seconds");
    }
    expect(o.post).not.toHaveBeenCalled();
  });

  it("rejects a total over 7 days but allows exactly 7 days", async () => {
    const tooLong = await setTimer.handler({ hours: 169 }, timerCtx().ctx);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error.code).toBe("DURATION_TOO_LONG");

    const o = timerCtx();
    const exact = await setTimer.handler({ hours: 168 }, o.ctx);
    expect(exact.ok).toBe(true);
    expect(sent(o).dueAt).toBe(new Date(NOW.getTime() + 168 * 3600 * 1000).toISOString());
  });

  it("rejects a label over 200 characters", async () => {
    const o = timerCtx();
    const r = await setTimer.handler({ label: "x".repeat(201), minutes: 5 }, o.ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(o.post).not.toHaveBeenCalled();
  });

  it.each([
    [403, { error: "forbidden_tool_for_role", tool: "set_timer" }, "FORBIDDEN"],
    [403, { error: "acting_user_required" }, "FORBIDDEN"],
    [500, {}, "CREATE_FAILED"],
  ])("a %i %j is %s — never a timer the model reports as set", async (status, body, code) => {
    const o = orchestratorCtx();
    o.post.mockResolvedValueOnce(json(status, body));
    const r = await setTimer.handler({ minutes: 5 }, o.ctx);
    expect(r).toMatchObject({ ok: false, error: { code } });
  });
});

describe("set_timer — tool metadata", () => {
  it("is named set_timer and is a write tool without confirmation", () => {
    expect(setTimer.name).toBe("set_timer");
    expect(setTimer.requiresWrite).toBe(true);
    expect(setTimer.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema", () => {
    expect(
      (setTimer.inputSchema as { additionalProperties?: boolean }).additionalProperties,
    ).toBe(false);
  });
});
