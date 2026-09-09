import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import updateEvent from "../../../src/handlers/calendar/update-event.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  findUnique: Mock,
  update: Mock,
  userId = "alice",
): ToolContext {
  return {
    prisma: {
      calendarEvent: { findUnique, update },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

describe("update_event", () => {
  it("rejects missing id", async () => {
    const r = await updateEvent.handler({}, ctxWith(vi.fn(), vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("404s when event not found", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const r = await updateEvent.handler({ id: "missing" }, ctxWith(findUnique, vi.fn()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  it("forbids editing another user's event", async () => {
    const findUnique = vi.fn().mockResolvedValue({ userId: "bob", source: "local" });
    const r = await updateEvent.handler({ id: "x" }, ctxWith(findUnique, vi.fn()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("FORBIDDEN");
  });

  it("rejects edits to externally-synced events", async () => {
    const findUnique = vi.fn().mockResolvedValue({ userId: "alice", source: "google" });
    const r = await updateEvent.handler({ id: "x" }, ctxWith(findUnique, vi.fn()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL_SOURCE");
  });

  it("updates only provided fields", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      userId: "alice",
      source: "local",
      startsAt: new Date("2026-04-28T10:00:00Z"),
      endsAt: new Date("2026-04-28T11:00:00Z"),
    });
    const update = vi.fn().mockResolvedValue({ id: "x" });
    await updateEvent.handler({ id: "x", title: "new" }, ctxWith(findUnique, update));
    expect(update).toHaveBeenCalledWith({ where: { id: "x" }, data: { title: "new" } });
  });

  // Range validation parity with the legacy calendar.service patch path.
  // Reviewer flagged that the bulk port silently dropped this check —
  // a partial update could create a backwards or zero-length range.
  it("rejects ends_at <= starts_at when both are patched", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      userId: "alice",
      source: "local",
      startsAt: new Date("2026-04-28T10:00:00Z"),
      endsAt: new Date("2026-04-28T11:00:00Z"),
    });
    const r = await updateEvent.handler(
      {
        id: "x",
        starts_at: "2026-04-28T14:00:00Z",
        ends_at: "2026-04-28T13:00:00Z",
      },
      ctxWith(findUnique, vi.fn()),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_RANGE");
  });

  it("rejects partial patch that would invert the range against the existing endsAt", async () => {
    // Existing event 10:00–11:00. Patch starts_at to 12:00 only — ends_at
    // (11:00, unchanged) is now before the new starts_at.
    const findUnique = vi.fn().mockResolvedValue({
      userId: "alice",
      source: "local",
      startsAt: new Date("2026-04-28T10:00:00Z"),
      endsAt: new Date("2026-04-28T11:00:00Z"),
    });
    const r = await updateEvent.handler(
      { id: "x", starts_at: "2026-04-28T12:00:00Z" },
      ctxWith(findUnique, vi.fn()),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_RANGE");
  });

  it("accepts a partial patch that keeps the range valid", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      userId: "alice",
      source: "local",
      startsAt: new Date("2026-04-28T10:00:00Z"),
      endsAt: new Date("2026-04-28T11:00:00Z"),
    });
    const update = vi.fn().mockResolvedValue({ id: "x" });
    const r = await updateEvent.handler(
      { id: "x", ends_at: "2026-04-28T11:30:00Z" },
      ctxWith(findUnique, update),
    );
    expect(r.ok).toBe(true);
    expect(update).toHaveBeenCalled();
  });
});
