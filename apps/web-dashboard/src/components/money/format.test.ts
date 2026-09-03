/**
 * WARP-2581 — the money surface's two rules that are easy to break silently.
 */
import { describe, expect, it } from "vitest";

import { formatDate, formatFigure, relativeAge, statusClassFor } from "./format";

describe("formatFigure", () => {
  it("groups the integer part and leaves the fraction exactly as sent", () => {
    expect(formatFigure("4210.55", "USD")).toBe("4,210.55 USD");
    expect(formatFigure("1234567.5", "EUR")).toBe("1,234,567.5 EUR");
    // Three decimals from a dinar ledger survive; re-rounding for display is
    // how a page ends up disagreeing with the package it quotes.
    expect(formatFigure("1.500", "KWD")).toBe("1.500 KWD");
  });

  it("renders a figure whose currency nobody named, without inventing one", () => {
    expect(formatFigure("980.00", null)).toBe("980.00");
  });

  it("keeps precision a float would lose", () => {
    expect(formatFigure("90071992547409.93", "USD")).toBe("90,071,992,547,409.93 USD");
  });

  it("renders an em-dash for a figure that could not be read — never a zero", () => {
    expect(formatFigure(null, "USD")).toBe("—");
  });

  it("carries a negative sign outside the grouping", () => {
    expect(formatFigure("-1200.00", "USD")).toBe("-1,200.00 USD");
  });
});

describe("statusClassFor", () => {
  it("maps the vendor words it knows", () => {
    expect(statusClassFor("paid", false)).toBe("paid");
    expect(statusClassFor("Settled", false)).toBe("paid");
    expect(statusClassFor("VOID", false)).toBe("void");
    expect(statusClassFor("deleted", true)).toBe("void");
  });

  it("🔴 files an unrecognised word as open rather than guessing", () => {
    // A vendor word this map has not met is information, not an error.
    expect(statusClassFor("awaiting_approval", false)).toBe("open");
    expect(statusClassFor("submitted", false)).toBe("open");
  });

  it("overdue is a fact about the date, not a vendor word", () => {
    expect(statusClassFor("open", true)).toBe("overdue");
    expect(statusClassFor(null, true)).toBe("overdue");
    // A settled document is never overdue, whatever its due date says.
    expect(statusClassFor("paid", true)).toBe("paid");
  });
});

describe("relativeAge", () => {
  it("speaks in the unit a person would", () => {
    expect(relativeAge(30_000)).toBe("just now");
    expect(relativeAge(4 * 60_000)).toBe("4 min ago");
    expect(relativeAge(3 * 3_600_000)).toBe("3 hours ago");
    expect(relativeAge(1 * 3_600_000)).toBe("1 hour ago");
    expect(relativeAge(50 * 3_600_000)).toBe("2 days ago");
  });

  it("never claims the future", () => {
    expect(relativeAge(-5000)).toBe("just now");
    expect(relativeAge(Number.NaN)).toBe("just now");
  });
});

describe("formatDate", () => {
  it("renders an em-dash when the vendor gave no date", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("last tuesday")).toBe("—");
  });

  it("renders a real date", () => {
    expect(formatDate("2026-09-10T00:00:00.000Z")).toMatch(/2026/);
  });
});
