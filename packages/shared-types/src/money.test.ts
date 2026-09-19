import { describe, expect, it } from "vitest";

import {
  DEFAULT_MINOR_UNIT_EXPONENT,
  formatMinorUnits,
  minorUnitExponent,
  toMinorUnits,
} from "./money";

describe("minorUnitExponent", () => {
  it("defaults to two for a code that is not an exception", () => {
    expect(minorUnitExponent("USD")).toBe(DEFAULT_MINOR_UNIT_EXPONENT);
    expect(minorUnitExponent("EUR")).toBe(2);
    // Not in the table and never will be — the default is the right answer for
    // a code this build has not heard of, and is what keeps the table small.
    expect(minorUnitExponent("XYZ")).toBe(2);
  });

  it("knows the zero-exponent and three-exponent currencies", () => {
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("KRW")).toBe(0);
    expect(minorUnitExponent("ISK")).toBe(0);
    expect(minorUnitExponent("KWD")).toBe(3);
    expect(minorUnitExponent("BHD")).toBe(3);
  });

  it("accepts a lowercase or padded code, because a vendor sends both", () => {
    expect(minorUnitExponent("jpy")).toBe(0);
    expect(minorUnitExponent(" usd ")).toBe(2);
  });

  it("returns null — not 2 — for something that is not a currency code", () => {
    // The distinction is the point: 0 is yen, null is "nobody said".
    expect(minorUnitExponent("")).toBeNull();
    expect(minorUnitExponent("US")).toBeNull();
    expect(minorUnitExponent("US$")).toBeNull();
    expect(minorUnitExponent("DOLLARS")).toBeNull();
  });
});

describe("toMinorUnits", () => {
  it("moves the point by the currency's own exponent", () => {
    expect(toMinorUnits("1234.50", "USD")).toBe(BigInt(123450));
    expect(toMinorUnits("1000", "JPY")).toBe(BigInt(1000));
    expect(toMinorUnits("1.500", "KWD")).toBe(BigInt(1500));
  });

  it("is exact where a float is not", () => {
    // 1234.56 * 100 === 123455.99999999999 in IEEE-754.
    expect(toMinorUnits("1234.56", "USD")).toBe(BigInt(123456));
    // Above 2^53, where Number() stops being able to hold the answer at all.
    expect(toMinorUnits("90071992547409.93", "USD")).toBe(BigInt("9007199254740993"));
  });

  it("fills a short fraction and accepts a surplus of zeros", () => {
    expect(toMinorUnits("1.5", "USD")).toBe(BigInt(150));
    expect(toMinorUnits("1", "USD")).toBe(BigInt(100));
    expect(toMinorUnits(".5", "USD")).toBe(BigInt(50));
    expect(toMinorUnits("1.500", "USD")).toBe(BigInt(150));
  });

  it("refuses precision it cannot hold rather than rounding it away", () => {
    // The whole reason this returns null: 1.505 USD is neither 150 nor 151,
    // and both of those are wrong answers that look like right ones.
    expect(toMinorUnits("1.505", "USD")).toBeNull();
    expect(toMinorUnits("1000.5", "JPY")).toBeNull();
    expect(toMinorUnits("1.5005", "KWD")).toBeNull();
  });

  it("carries a sign", () => {
    expect(toMinorUnits("-12.34", "USD")).toBe(BigInt(-1234));
    expect(toMinorUnits("+12.34", "USD")).toBe(BigInt(1234));
    expect(toMinorUnits("-0.00", "USD")).toBe(BigInt(0));
  });

  it("refuses anything that is not a plain decimal", () => {
    expect(toMinorUnits("1,234.50", "USD")).toBeNull();
    expect(toMinorUnits("1.2e3", "USD")).toBeNull();
    expect(toMinorUnits("USD 12", "USD")).toBeNull();
    expect(toMinorUnits("twelve", "USD")).toBeNull();
    expect(toMinorUnits("", "USD")).toBeNull();
    expect(toMinorUnits(".", "USD")).toBeNull();
    expect(toMinorUnits("-", "USD")).toBeNull();
    expect(toMinorUnits("1.2.3", "USD")).toBeNull();
  });

  it("refuses an amount whose currency nobody identified", () => {
    expect(toMinorUnits("10.00", "")).toBeNull();
    expect(toMinorUnits("10.00", "US$")).toBeNull();
  });
});

describe("formatMinorUnits", () => {
  it("round-trips through toMinorUnits", () => {
    for (const [major, code] of [
      ["1234.50", "USD"],
      ["1000", "JPY"],
      ["1.500", "KWD"],
      ["-12.34", "EUR"],
    ] as const) {
      const minor = toMinorUnits(major, code);
      expect(minor).not.toBeNull();
      expect(formatMinorUnits(minor as bigint, code)).toBe(
        // JPY has no point to render and KWD keeps three places.
        code === "JPY" ? "1000" : major,
      );
    }
  });

  it("pads a value shorter than the exponent", () => {
    expect(formatMinorUnits(BigInt(5), "USD")).toBe("0.05");
    expect(formatMinorUnits(BigInt(0), "USD")).toBe("0.00");
    expect(formatMinorUnits(BigInt(-5), "USD")).toBe("-0.05");
    expect(formatMinorUnits(BigInt(7), "KWD")).toBe("0.007");
  });

  it("takes a decimal string, because that is how the value crosses the API", () => {
    expect(formatMinorUnits("9007199254740993", "USD")).toBe("90071992547409.93");
  });

  it("returns null rather than a wrong denomination", () => {
    expect(formatMinorUnits(BigInt(100), "US$")).toBeNull();
    expect(formatMinorUnits("not-a-number", "USD")).toBeNull();
  });
});
