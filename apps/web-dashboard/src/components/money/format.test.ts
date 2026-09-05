/**
 * WARP-2581 — the money surface's two rules that are easy to break silently,
 * plus the guard that keeps a third date formatter from growing back.
 */
import { describe, expect, it } from "vitest";

import * as moneyFormat from "./format";
import { formatFigure, statusClassFor } from "./format";

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

describe("what this module deliberately does NOT own", () => {
  it("🔴 has no date or time-ago formatter of its own", () => {
    // `lib/erp-format.ts` owns both, for every surface that reads from a
    // connected system. The copies that used to live here had already drifted:
    // money's `formatDate` never inherited the calendar-date correction, so a
    // due date rendered a day early on any box behind UTC. This assertion is
    // what stops the fourth copy.
    const owned = Object.keys(moneyFormat).filter((name) =>
      /date|ago|relative|elapsed|since/i.test(name),
    );
    expect(owned).toEqual([]);
  });
});
