/**
 * WARP-1424 — `unit_convert` (length / mass / temperature / volume /
 * area / speed / data-size conversions). Tier-1 read, pure computation,
 * no ToolContext dependencies.
 */
import { describe, it, expect } from "vitest";
import unitConvert from "../../../src/handlers/data/unit-convert.js";
import type { ToolContext, ToolResult } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

interface ConvertData {
  type: string;
  value: number;
  from: string;
  to: string;
  result: number;
  category: string;
}

function dataOf(res: ToolResult): ConvertData {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("expected ok result");
  return res.data as ConvertData;
}

describe("unit_convert — linear categories", () => {
  it("converts km to mi", async () => {
    const res = await unitConvert.handler({ value: 10, from: "km", to: "mi" }, ctx);
    const data = dataOf(res);
    expect(data.type).toBe("unit_convert");
    expect(data.category).toBe("length");
    expect(data.from).toBe("km");
    expect(data.to).toBe("mi");
    expect(data.value).toBe(10);
    expect(data.result).toBeCloseTo(6.21371, 4);
  });

  it("converts kg to lb", async () => {
    const res = await unitConvert.handler({ value: 1, from: "kg", to: "lb" }, ctx);
    const data = dataOf(res);
    expect(data.category).toBe("mass");
    expect(data.result).toBeCloseTo(2.20462, 4);
  });

  it("converts l to gal (US)", async () => {
    const res = await unitConvert.handler({ value: 1, from: "l", to: "gal" }, ctx);
    const data = dataOf(res);
    expect(data.category).toBe("volume");
    expect(data.result).toBeCloseTo(0.264172, 5);
  });

  it("converts ha to acre", async () => {
    const res = await unitConvert.handler({ value: 1, from: "ha", to: "acre" }, ctx);
    const data = dataOf(res);
    expect(data.category).toBe("area");
    expect(data.result).toBeCloseTo(2.4711, 4);
  });

  it("converts kmh to mph", async () => {
    const res = await unitConvert.handler({ value: 100, from: "kmh", to: "mph" }, ctx);
    const data = dataOf(res);
    expect(data.category).toBe("speed");
    expect(data.result).toBeCloseTo(62.1371, 3);
  });
});

describe("unit_convert — temperature (affine)", () => {
  it("100 C is exactly 212 F", async () => {
    const res = await unitConvert.handler({ value: 100, from: "c", to: "f" }, ctx);
    const data = dataOf(res);
    expect(data.category).toBe("temperature");
    expect(data.result).toBeCloseTo(212, 10);
  });

  it("32 F is exactly 0 C", async () => {
    const res = await unitConvert.handler({ value: 32, from: "f", to: "c" }, ctx);
    const data = dataOf(res);
    expect(data.result).toBeCloseTo(0, 10);
  });

  it("0 C is exactly 273.15 K", async () => {
    const res = await unitConvert.handler({ value: 0, from: "c", to: "k" }, ctx);
    const data = dataOf(res);
    expect(data.result).toBeCloseTo(273.15, 10);
  });
});

describe("unit_convert — data sizes (decimal vs binary)", () => {
  it("1 GB (decimal) is ~0.93132 GiB (binary)", async () => {
    const res = await unitConvert.handler({ value: 1, from: "gb", to: "gib" }, ctx);
    const data = dataOf(res);
    expect(data.category).toBe("data");
    expect(data.result).toBeCloseTo(0.93132, 5);
  });
});

describe("unit_convert — alias tolerance", () => {
  it("accepts long plural names: meters -> feet", async () => {
    const res = await unitConvert.handler({ value: 1, from: "meters", to: "feet" }, ctx);
    const data = dataOf(res);
    expect(data.from).toBe("m");
    expect(data.to).toBe("ft");
    expect(data.result).toBeCloseTo(3.28084, 4);
  });

  it("accepts pounds -> kilograms", async () => {
    const res = await unitConvert.handler({ value: 10, from: "pounds", to: "kilograms" }, ctx);
    const data = dataOf(res);
    expect(data.from).toBe("lb");
    expect(data.to).toBe("kg");
    expect(data.result).toBeCloseTo(4.53592, 4);
  });

  it("is case-insensitive (Celsius -> FAHRENHEIT)", async () => {
    const res = await unitConvert.handler({ value: 0, from: "Celsius", to: "FAHRENHEIT" }, ctx);
    const data = dataOf(res);
    expect(data.from).toBe("c");
    expect(data.to).toBe("f");
    expect(data.result).toBeCloseTo(32, 10);
  });
});

describe("unit_convert — errors", () => {
  it("rejects a cross-category conversion (m -> kg)", async () => {
    const res = await unitConvert.handler({ value: 1, from: "m", to: "kg" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("CATEGORY_MISMATCH");
      expect(res.error.message).toContain("length");
      expect(res.error.message).toContain("mass");
    }
  });

  it("rejects an unknown unit", async () => {
    const res = await unitConvert.handler({ value: 1, from: "furlong", to: "m" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("UNKNOWN_UNIT");
      expect(res.error.message).toContain("furlong");
    }
  });

  it("rejects a non-finite value", async () => {
    const res = await unitConvert.handler({ value: Infinity, from: "m", to: "ft" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("INVALID_VALUE");
    }
  });

  it("rejects a missing / non-numeric value", async () => {
    const res = await unitConvert.handler({ from: "m", to: "ft" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("INVALID_VALUE");
    }
  });
});

describe("unit_convert — tool metadata", () => {
  it("is named unit_convert and is Tier-1 (no write, no confirm)", () => {
    expect(unitConvert.name).toBe("unit_convert");
    expect(unitConvert.requiresWrite).toBe(false);
    expect(unitConvert.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema requiring value/from/to", () => {
    const schema = unitConvert.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["value", "from", "to"]);
  });
});
