import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import deleteEvent from "../../../src/handlers/calendar/delete-event.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  findUnique: Mock,
  delFn: Mock,
  userId = "alice",
): ToolContext {
  return {
    prisma: {
      calendarEvent: { findUnique, delete: delFn },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

describe("delete_event", () => {
  it("rejects missing id", async () => {
    const r = await deleteEvent.handler({}, ctxWith(vi.fn(), vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("forbids cross-user delete", async () => {
    const findUnique = vi.fn().mockResolvedValue({ userId: "bob", source: "local" });
    const r = await deleteEvent.handler({ id: "x" }, ctxWith(findUnique, vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("rejects deleting externally-synced events", async () => {
    const findUnique = vi.fn().mockResolvedValue({ userId: "alice", source: "google" });
    const r = await deleteEvent.handler({ id: "x" }, ctxWith(findUnique, vi.fn()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL_SOURCE");
  });

  it("deletes a local event", async () => {
    const findUnique = vi.fn().mockResolvedValue({ userId: "alice", source: "local" });
    const delFn = vi.fn().mockResolvedValue({});
    const r = await deleteEvent.handler({ id: "x" }, ctxWith(findUnique, delFn));
    expect(r.ok).toBe(true);
    expect(delFn).toHaveBeenCalledWith({ where: { id: "x" } });
  });
});
