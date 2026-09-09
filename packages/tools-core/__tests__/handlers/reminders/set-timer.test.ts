/**
 * WARP-1425 — `set_timer`: server-side relative countdown timer backed by
 * a Reminder row. The due time is computed on the box from a frozen
 * `Date.now()` here, never from an LLM-supplied timestamp. Cancel/list are
 * deliberately consolidated onto `complete_reminder` / `list_reminders`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import setTimer from "../../../src/handlers/reminders/set-timer.js";
import type { ToolContext } from "../../../src/types.js";

const NOW = new Date("2026-07-19T12:00:00Z");

function ctxWith(create: Mock, userId?: string): ToolContext {
  return {
    prisma: { reminder: { create } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

/** prisma.reminder.create mock that echoes the row it was given. */
function echoCreate(): Mock {
  return vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "t1", ...data }),
  );
}

describe("set_timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a reminder due exactly 90s from now for {minutes: 1, seconds: 30}", async () => {
    const create = echoCreate();
    const r = await setTimer.handler({ minutes: 1, seconds: 30 }, ctxWith(create, "alice"));
    expect(r.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "alice",
        title: "Timer",
        dueAt: new Date(NOW.getTime() + 90_000),
      }),
    });
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
    const create = echoCreate();
    const r = await setTimer.handler({ hours: 2, minutes: 15 }, ctxWith(create, "alice"));
    expect(r.ok).toBe(true);
    const expectedMs = (2 * 3600 + 15 * 60) * 1000;
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ dueAt: new Date(NOW.getTime() + expectedMs) }),
    });
    if (r.ok) {
      expect((r.data as { duration_seconds: number }).duration_seconds).toBe(8100);
    }
  });

  it("trims a custom label", async () => {
    const create = echoCreate();
    const r = await setTimer.handler(
      { label: "  pasta  ", minutes: 10 },
      ctxWith(create, "alice"),
    );
    expect(r.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ title: "pasta" }),
    });
    if (r.ok) {
      expect((r.data as { title: string }).title).toBe("pasta");
    }
  });

  it("falls back to the default label when label is blank", async () => {
    const create = echoCreate();
    const r = await setTimer.handler({ label: "   ", seconds: 30 }, ctxWith(create, "alice"));
    expect(r.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ title: "Timer" }),
    });
  });

  it("requires auth", async () => {
    const create = echoCreate();
    const r = await setTimer.handler({ minutes: 5 }, ctxWith(create, undefined));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a call with no duration components", async () => {
    const create = echoCreate();
    const r = await setTimer.handler({}, ctxWith(create, "alice"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a zero total duration", async () => {
    const create = echoCreate();
    const r = await setTimer.handler({ hours: 0, minutes: 0, seconds: 0 }, ctxWith(create, "alice"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a negative component, naming the field", async () => {
    const create = echoCreate();
    const r = await setTimer.handler({ minutes: -5 }, ctxWith(create, "alice"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toContain("minutes");
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a non-integer component, naming the field", async () => {
    const create = echoCreate();
    const r = await setTimer.handler({ seconds: 1.5 }, ctxWith(create, "alice"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toContain("seconds");
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a total over 7 days but allows exactly 7 days", async () => {
    const tooLong = await setTimer.handler({ hours: 169 }, ctxWith(echoCreate(), "alice"));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error.code).toBe("DURATION_TOO_LONG");

    const create = echoCreate();
    const exact = await setTimer.handler({ hours: 168 }, ctxWith(create, "alice"));
    expect(exact.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dueAt: new Date(NOW.getTime() + 168 * 3600 * 1000),
      }),
    });
  });

  it("rejects a label over 200 characters", async () => {
    const create = echoCreate();
    const r = await setTimer.handler(
      { label: "x".repeat(201), minutes: 5 },
      ctxWith(create, "alice"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(create).not.toHaveBeenCalled();
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
