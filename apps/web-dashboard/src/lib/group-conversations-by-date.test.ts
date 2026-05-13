import { describe, it, expect } from "vitest";
import { groupConversationsByDate, type DatedItem } from "./group-conversations-by-date";

const now = new Date("2026-05-13T12:00:00Z");

function row(id: string, daysAgo: number): DatedItem {
  const d = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return { id, title: `chat-${id}`, updatedAt: d.toISOString() };
}

describe("groupConversationsByDate", () => {
  it("returns an empty array when there are no items", () => {
    expect(groupConversationsByDate([], now)).toEqual([]);
  });

  it("groups items into Today / Yesterday / Previous 7 days / Previous 30 days / months", () => {
    const items = [
      row("a", 0), // today
      row("b", 1), // yesterday
      row("c", 3), // previous 7
      row("d", 15), // previous 30
      row("e", 60), // March 2026
      row("f", 400), // April 2025
    ];
    const groups = groupConversationsByDate(items, now);
    expect(groups.map((g) => g.label).slice(0, 4)).toEqual([
      "Today",
      "Yesterday",
      "Previous 7 days",
      "Previous 30 days",
    ]);
    expect(groups[4].label).toMatch(/\b2026\b/); // March 2026
    expect(groups[5].label).toMatch(/\b2025\b/); // April 2025
    expect(groups[0].items.map((i) => i.id)).toEqual(["a"]);
    expect(groups[4].items.map((i) => i.id)).toEqual(["e"]);
  });

  it("preserves input order within a group (callers pass items sorted newest-first)", () => {
    const items = [
      { id: "a", title: "a", updatedAt: new Date(now.getTime() - 1 * 60 * 1000).toISOString() }, // 1 min ago
      { id: "b", title: "b", updatedAt: new Date(now.getTime() - 2 * 60 * 1000).toISOString() }, // 2 min ago
      { id: "c", title: "c", updatedAt: new Date(now.getTime() - 3 * 60 * 1000).toISOString() }, // 3 min ago
    ];
    const groups = groupConversationsByDate(items, now);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("treats 'yesterday' as the calendar day before, not a 24h window", () => {
    // updatedAt is 25h ago: still yesterday by calendar, even though > 24h.
    const items = [
      { id: "x", title: "x", updatedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString() },
    ];
    const groups = groupConversationsByDate(items, now);
    expect(groups[0].label).toBe("Yesterday");
  });

  it("uses month-only labels for older years too (no double-counting)", () => {
    const items = [row("a", 365 + 30)]; // ~April 2025
    const groups = groupConversationsByDate(items, now);
    expect(groups[0].label).toMatch(/\b2025\b/);
  });

  it("skips items with unparseable updatedAt", () => {
    const items = [
      row("a", 0),
      { id: "bad", title: "bad", updatedAt: "not-a-date" },
      row("b", 1),
    ];
    const groups = groupConversationsByDate(items, now);
    const allIds = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(allIds).toEqual(["a", "b"]);
    expect(groups.some((g) => g.label === "Invalid Date")).toBe(false);
  });
});
