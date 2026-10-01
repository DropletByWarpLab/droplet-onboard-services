/**
 * WARP-3400 — `major-units.ts`, the converter every model-facing money field
 * goes through.
 *
 * The lab-box report was a $10,000.00 deal ("1000000" minor units, USD) quoted
 * as "USD 1,000,000". These pin the conversion itself; each tool's own test
 * pins that it uses it.
 */
import { describe, it, expect } from "vitest";

import { displayMajor, majorFromMinor } from "../src/major-units.js";

describe("majorFromMinor", () => {
  it.each([
    // The reported bug.
    ["1000000", "USD", "10000.00", "$10,000.00"],
    ["1000000", "EUR", "10000.00", "€10,000.00"],
    ["1000000", "GBP", "10000.00", "£10,000.00"],
    // Exponent 0: ¥1,000,000 is 1000000 minor units, not 10000.
    ["1000000", "JPY", "1000000", "¥1,000,000"],
    // Exponent 3: 1000.000, not 10000.00.
    ["1000000", "KWD", "1000.000", "KWD 1,000.000"],
    ["1000000", "CHF", "10000.00", "CHF 10,000.00"],
    // Under a unit, and zero.
    ["5", "USD", "0.05", "$0.05"],
    ["0", "USD", "0.00", "$0.00"],
    ["-250", "USD", "-2.50", "-$2.50"],
    // Past 2^53, where Number() rounds to …992.
    ["9007199254740993", "USD", "90071992547409.93", "$90,071,992,547,409.93"],
  ])("%s minor %s -> %s (%s)", (minor, currency, amount, display) => {
    expect(majorFromMinor(minor, currency)).toEqual({ amount, display });
  });

  it("accepts a bigint", () => {
    expect(majorFromMinor(BigInt("1000000"), "USD")).toEqual({
      amount: "10000.00",
      display: "$10,000.00",
    });
  });

  it("is case-insensitive about the currency code", () => {
    expect(majorFromMinor("1000000", "usd")?.display).toBe("$10,000.00");
  });

  it.each([
    [null, "USD"],
    [undefined, "USD"],
    ["1000000", null],
    ["1000000", undefined],
    ["1000000", ""],
    ["1000000", "dollars"],
    ["12.5", "USD"],
    ["abc", "USD"],
  ])("returns null for %s / %s rather than guessing", (minor, currency) => {
    expect(majorFromMinor(minor as string | null | undefined, currency as string | null | undefined)).toBeNull();
  });
});

describe("displayMajor", () => {
  it("groups thousands and pads to the exponent", () => {
    expect(displayMajor("1234567.5", "USD")).toBe("$1,234,567.50");
  });

  it("keeps sub-unit precision a ledger sent instead of truncating it", () => {
    expect(displayMajor("1.505", "USD")).toBe("$1.505");
  });

  it("refuses anything that is not a plain decimal", () => {
    expect(displayMajor("1,234.50", "USD")).toBeNull();
    expect(displayMajor("1e3", "USD")).toBeNull();
    expect(displayMajor("$12", "USD")).toBeNull();
  });
});
