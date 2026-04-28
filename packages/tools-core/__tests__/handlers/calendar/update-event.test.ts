import { describe, it, expect, vi } from "vitest";
import updateEvent from "../../../src/handlers/calendar/update-event.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  findUnique: ReturnType<typeof vi.fn>,
  update: ReturnType<typeof vi.fn>,
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
    const findUnique = vi.fn().mockResolvedValue({ userId: "alice", source: "local" });
    const update = vi.fn().mockResolvedValue({ id: "x" });
    await updateEvent.handler({ id: "x", title: "new" }, ctxWith(findUnique, update));
    expect(update).toHaveBeenCalledWith({ where: { id: "x" }, data: { title: "new" } });
  });
});
