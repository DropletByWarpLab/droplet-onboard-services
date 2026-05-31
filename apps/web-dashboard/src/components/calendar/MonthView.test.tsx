import { describe, it, expect } from "vitest";
import { monthGridDays, monthGridRange } from "./MonthView";

describe("monthGridDays", () => {
  it("returns 42 days starting on the Sunday on/before the 1st", () => {
    const days = monthGridDays(new Date(2026, 4, 15)); // May 2026
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(0); // grid always starts on a Sunday

    const first = new Date(2026, 4, 1);
    expect(days[0].getTime()).toBeLessThanOrEqual(first.getTime());
    expect(first.getTime() - days[0].getTime()).toBeLessThan(7 * 86_400_000);
  });

  it("includes every day of the cursor's month", () => {
    const days = monthGridDays(new Date(2026, 4, 15));
    const keys = new Set(days.map((d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`));
    expect(keys.has("2026-4-1")).toBe(true); // May 1
    expect(keys.has("2026-4-31")).toBe(true); // May 31
  });

  it("is contiguous (each day is +1 of the previous)", () => {
    const days = monthGridDays(new Date(2026, 1, 10)); // Feb 2026
    for (let i = 1; i < days.length; i++) {
      const diff = (days[i].getTime() - days[i - 1].getTime()) / 86_400_000;
      expect(Math.round(diff)).toBe(1);
    }
  });
});

describe("monthGridRange", () => {
  it("covers the full visible grid and starts on a Sunday", () => {
    const { from, to } = monthGridRange(new Date(2026, 4, 15));
    expect(from.getDay()).toBe(0);
    expect((to.getTime() - from.getTime()) / 86_400_000).toBeGreaterThan(40);
    expect(from.getHours()).toBe(0);
  });
});
