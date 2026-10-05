/**
 * WARP-3527 — the date formats trackers write, and the day-first / month-first
 * question that cannot be answered per row.
 */

import { describe, it, expect } from "vitest";
import { inferDateOrder, parseImportDate, toDateOnlyUtc, toInstantUtc } from "./dates.js";

const day = (raw: string, order: "DMY" | "MDY" | "YMD" = "MDY") => {
  const p = parseImportDate(raw, order);
  return p ? toDateOnlyUtc(p).toISOString().slice(0, 10) : null;
};

describe("parseImportDate", () => {
  it.each([
    ["2024-03-12", "2024-03-12"],
    ["2024-3-5", "2024-03-05"],
    ["2024-03-12T09:41:00Z", "2024-03-12"],
    ["2024-03-12 09:41", "2024-03-12"],
    ["2024/03/12", "2024-03-12"],
    ["12/Mar/24 9:41 AM", "2024-03-12"], // Jira
    ["12-Mar-2024", "2024-03-12"],
    ["12 March 2024", "2024-03-12"],
    ["Mar 12, 2024", "2024-03-12"],
    ["March 12th, 2024", "2024-03-12"],
    ["31/Dec/99", "1999-12-31"], // two-digit years window at 70
    ["1/Jan/05", "2005-01-01"],
  ])("reads %s as %s whatever the numeric order", (raw, expected) => {
    expect(day(raw)).toBe(expected);
    expect(day(raw, "DMY")).toBe(expected);
  });

  it("reads numeric dates by the order given", () => {
    expect(day("03/04/2024", "MDY")).toBe("2024-03-04");
    expect(day("03/04/2024", "DMY")).toBe("2024-04-03");
    expect(day("12.03.2024", "DMY")).toBe("2024-03-12");
    expect(day("13/03/2024", "DMY")).toBe("2024-03-13");
  });

  it("refuses impossible calendar dates and non-dates", () => {
    for (const raw of ["2024-02-30", "31/04/2024", "2024-13-01", "99/99/9999", "tomorrow", "", "  "]) {
      expect(parseImportDate(raw, "DMY")).toBeNull();
    }
    expect(day("29/02/2024", "DMY")).toBe("2024-02-29"); // leap year
    expect(parseImportDate("29/02/2023", "DMY")).toBeNull();
  });

  it("reads 12-hour clocks, midnight and noon correctly", () => {
    const at = (raw: string) => toInstantUtc(parseImportDate(raw, "MDY") as never).toISOString();
    expect(at("12/Mar/24 12:00 AM")).toBe("2024-03-12T00:00:00.000Z");
    expect(at("12/Mar/24 12:00 PM")).toBe("2024-03-12T12:00:00.000Z");
    expect(at("12/Mar/24 9:41 PM")).toBe("2024-03-12T21:41:00.000Z");
  });

  it("applies an explicit offset to an instant but never moves a calendar date", () => {
    const p = parseImportDate("2024-03-12T23:30:00-08:00") as never;
    expect(toInstantUtc(p).toISOString()).toBe("2024-03-13T07:30:00.000Z");
    // a due date is the day AS WRITTEN: 00:00:00Z of the 12th, not the 13th
    expect(toDateOnlyUtc(p).toISOString()).toBe("2024-03-12T00:00:00.000Z");
  });
});

describe("inferDateOrder", () => {
  it("a first part over 12 proves day-first", () => {
    expect(inferDateOrder(["03/04/2024", "25/04/2024"])).toEqual({ order: "DMY", ambiguous: false });
  });
  it("a second part over 12 proves month-first", () => {
    expect(inferDateOrder(["03/04/2024", "04/25/2024"])).toEqual({ order: "MDY", ambiguous: false });
  });
  it("all parts 12 or under cannot be settled: ambiguous, month-first", () => {
    expect(inferDateOrder(["03/04/2024", "05/06/2024"])).toEqual({ order: "MDY", ambiguous: true });
  });
  it("a contradictory column is ambiguous rather than half mis-dated", () => {
    expect(inferDateOrder(["25/04/2024", "04/25/2024"]).ambiguous).toBe(true);
  });
  it("ISO and named-month dates never make a column ambiguous", () => {
    expect(inferDateOrder(["2024-03-04", "12/Mar/24", "Mar 4, 2024"])).toEqual({ order: "MDY", ambiguous: false });
    expect(inferDateOrder([])).toEqual({ order: "MDY", ambiguous: false });
  });
});
