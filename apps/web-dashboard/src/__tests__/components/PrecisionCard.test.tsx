/**
 * WARP-2980 (ADR-059 P5 PR-B, brief §4.4, §12) — "How often Droplet was
 * right", and the site-calendar formatters the expected-activity rows use.
 *
 * Pins: `precision: null` (anyone but owner/admin) renders nothing at all; no
 * marks yet says so; counts until day 30 ("3 marks so far"), then "Right 3 of
 * 4 times (75%)" — words and numbers, never a colour; "since" is the SITE's
 * date. hoursSpan wraps past midnight and says "All day" for 24 hours from
 * midnight only (a window belongs to the day it opens, so 24 hours from 5 PM
 * is never shown as the whole day);
 * siteDate is the site's calendar day and adds the year only when it differs
 * from the site's current year.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrecisionCard, precisionLine } from "@/components/security/PrecisionCard";
import { PRECISION_COPY as P, hoursSpan, siteDate } from "@/components/security/patterns-copy";
import type { SecurityPatternPrecision } from "@/lib/types";

const TZ = "America/New_York";
const NOW = new Date("2026-09-25T02:30:00.000Z");

const PRECISION: SecurityPatternPrecision = {
  showAfterDays: 30,
  codes: [
    // 02:00 UTC on Sep 1 is 22:00 on Aug 31 at the site.
    { code: "out_of_place", marked: 4, notExpected: 3, firstMarkedAt: "2026-09-01T02:00:00.000Z", percentRight: 75 },
    { code: "unusual_volume", marked: 3, notExpected: 1, firstMarkedAt: "2026-09-20T12:00:00.000Z", percentRight: null },
    { code: "long_dwell", marked: 1, notExpected: 0, firstMarkedAt: "2026-09-24T12:00:00.000Z", percentRight: null },
  ],
};

describe("PrecisionCard", () => {
  it("renders nothing when the server sent no precision (anyone but owner/admin)", () => {
    const { container } = render(<PrecisionCard precision={null} timezone={TZ} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing has been marked yet", () => {
    render(<PrecisionCard precision={{ showAfterDays: 30, codes: [] }} timezone={TZ} now={NOW} />);
    expect(screen.getByRole("region", { name: P.title })).toHaveTextContent(P.none);
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("names each flag, counts until day 30, then says how often it was right — since the site's date", () => {
    render(<PrecisionCard precision={PRECISION} timezone={TZ} now={NOW} />);
    const [oop, vol, dwell] = screen.getAllByRole("listitem");
    expect(oop).toHaveTextContent("Not usual at this time");
    expect(oop).toHaveTextContent("Right 3 of 4 times (75%) · since Aug 31");
    expect(vol).toHaveTextContent("Busier than usual");
    expect(vol).toHaveTextContent("3 marks so far · since Sep 20");
    expect(dwell).toHaveTextContent("Stayed longer than usual");
    expect(dwell).toHaveTextContent("1 mark so far");
  });

  it("precisionLine", () => {
    expect(precisionLine(PRECISION.codes[0])).toBe("Right 3 of 4 times (75%)");
    expect(precisionLine(PRECISION.codes[1])).toBe("3 marks so far");
    expect(precisionLine(PRECISION.codes[2])).toBe("1 mark so far");
    expect(precisionLine({ ...PRECISION.codes[0], notExpected: 0, percentRight: 0 })).toBe("Right 0 of 4 times (0%)");
  });
});

describe("hoursSpan", () => {
  it.each([
    [22, 2, "10 PM–12 AM"],
    [23, 1, "11 PM–12 AM"],
    [22, 6, "10 PM–4 AM"],
    [9, 8, "9 AM–5 PM"],
    [0, 1, "12 AM–1 AM"],
    [11, 1, "11 AM–12 PM"],
    [0, 24, "All day"],
    // Refused by route 33 and the table; if one were ever shown, it says what it is.
    [17, 24, "5 PM–5 PM"],
  ])("(%i, %i) → %s", (from, count, words) => {
    expect(hoursSpan(from, count)).toBe(words);
  });
});

describe("siteDate", () => {
  it("is the site's calendar day near midnight, not UTC's or the device's", () => {
    expect(siteDate("2026-10-25T03:30:00.000Z", "America/New_York", NOW)).toBe("Oct 24");
    expect(siteDate("2026-10-24T12:30:00.000Z", "Pacific/Auckland", NOW)).toBe("Oct 25");
    expect(siteDate(new Date("2026-10-25T03:30:00.000Z"), "UTC", NOW)).toBe("Oct 25");
  });

  it("adds the year only when it isn't the site's current year", () => {
    expect(siteDate("2027-09-25T12:00:00.000Z", TZ, NOW)).toBe("Sep 25, 2027");
    // 03:00 UTC on Jan 1 2027 is still Dec 31 2026 in Los Angeles: the site's
    // year is 2026, so a date in 2027 carries its year.
    const newYearsEveInLA = new Date("2027-01-01T03:00:00.000Z");
    expect(siteDate("2027-01-05T20:00:00.000Z", "America/Los_Angeles", newYearsEveInLA)).toBe("Jan 5, 2027");
    expect(siteDate("2026-12-31T20:00:00.000Z", "America/Los_Angeles", newYearsEveInLA)).toBe("Dec 31");
  });
});
