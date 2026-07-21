/**
 * WARP-1424 — `calculate` (safe arithmetic/scientific expression
 * evaluator; hand-rolled parser, no code execution). Tier-1 read, pure
 * computation, no ToolContext dependencies.
 */
import { describe, it, expect } from "vitest";
import calculate from "../../../src/handlers/data/calculate.js";
import type { ToolContext, ToolResult } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

async function run(args: Record<string, unknown>): Promise<ToolResult> {
  return calculate.handler(args, ctx);
}

async function expectResult(expression: string, expected: number): Promise<void> {
  const res = await run({ expression });
  expect(res.ok).toBe(true);
  if (res.ok) {
    const data = res.data as { type: string; expression: string; result: number; formatted: string };
    expect(data.type).toBe("calculate");
    expect(data.expression).toBe(expression);
    expect(data.result).toBe(expected);
    expect(Number.isFinite(data.result)).toBe(true);
    expect(typeof data.formatted).toBe("string");
  }
}

async function expectCloseTo(expression: string, expected: number): Promise<void> {
  const res = await run({ expression });
  expect(res.ok).toBe(true);
  if (res.ok) {
    const data = res.data as { result: number };
    expect(data.result).toBeCloseTo(expected, 10);
    expect(Number.isFinite(data.result)).toBe(true);
  }
}

async function expectErrorCode(args: Record<string, unknown>, code: string): Promise<void> {
  const res = await run(args);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
    expect(res.error.message.length).toBeGreaterThan(0);
  }
}

describe("calculate — arithmetic", () => {
  it("applies operator precedence (`2+3*4` → 14)", async () => {
    await expectResult("2+3*4", 14);
  });

  it("lets parentheses override precedence (`(2+3)*4` → 20)", async () => {
    await expectResult("(2+3)*4", 20);
  });

  it("treats power as right-associative (`2^3^2` → 512)", async () => {
    await expectResult("2^3^2", 512);
  });

  it("binds unary minus looser than power (`-2^2` → -4, `(-2)^2` → 4)", async () => {
    await expectResult("-2^2", -4);
    await expectResult("(-2)^2", 4);
  });

  it("supports a negative exponent (`2^-3` → 0.125)", async () => {
    await expectResult("2^-3", 0.125);
  });

  it("computes modulo (`10 % 3` → 1, `7.5 % 2` → 1.5)", async () => {
    await expectResult("10 % 3", 1);
    await expectResult("7.5 % 2", 1.5);
  });

  it("divides into non-integers (`10/4` → 2.5)", async () => {
    await expectResult("10/4", 2.5);
  });

  it("tolerates arbitrary whitespace", async () => {
    await expectResult("  2 +\t3 * 4  ", 14);
  });
});

describe("calculate — functions and constants", () => {
  it("computes sqrt(16) → 4", async () => {
    await expectResult("sqrt(16)", 4);
  });

  it("computes sin(pi/2) ≈ 1 (radians)", async () => {
    await expectCloseTo("sin(pi/2)", 1);
  });

  it("computes log base 10 and natural log (`log(100)` → 2, `ln(e)` ≈ 1)", async () => {
    await expectResult("log(100)", 2);
    await expectCloseTo("ln(e)", 1);
  });

  it("computes rounding helpers (`round(2.6)` → 3, `floor(2.6)` → 2, `ceil(2.1)` → 3, `abs(-5)` → 5)", async () => {
    await expectResult("round(2.6)", 3);
    await expectResult("floor(2.6)", 2);
    await expectResult("ceil(2.1)", 3);
    await expectResult("abs(-5)", 5);
  });

  it("supports variadic min/max with 2+ args (`min(3,1,2)` → 1, `max(3,1,2)` → 3)", async () => {
    await expectResult("min(3,1,2)", 1);
    await expectResult("max(3,1,2)", 3);
  });

  it("exposes the constants pi and e", async () => {
    await expectCloseTo("pi", Math.PI);
    await expectCloseTo("e", Math.E);
  });

  it("matches function and constant names case-insensitively", async () => {
    await expectResult("SQRT(16)", 4);
    await expectCloseTo("Sin(PI/2)", 1);
  });
});

describe("calculate — precision", () => {
  it("rounds the result and formatted string to `precision` decimals", async () => {
    const res = await run({ expression: "2/3", precision: 4 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { result: number; formatted: string };
      expect(data.result).toBe(0.6667);
      expect(data.formatted).toBe("0.6667");
    }
  });

  it("supports precision 0 (round to integer)", async () => {
    const res = await run({ expression: "2/3", precision: 0 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { result: number; formatted: string };
      expect(data.result).toBe(1);
      expect(data.formatted).toBe("1");
    }
  });

  it("rejects an out-of-range or non-integer precision", async () => {
    await expectErrorCode({ expression: "1+1", precision: 16 }, "INVALID_ARGS");
    await expectErrorCode({ expression: "1+1", precision: -1 }, "INVALID_ARGS");
    await expectErrorCode({ expression: "1+1", precision: 2.5 }, "INVALID_ARGS");
    await expectErrorCode({ expression: "1+1", precision: "4" }, "INVALID_ARGS");
  });
});

describe("calculate — errors", () => {
  it("returns DIVISION_BY_ZERO for `1/0`", async () => {
    await expectErrorCode({ expression: "1/0" }, "DIVISION_BY_ZERO");
  });

  it("returns DIVISION_BY_ZERO for `5 % 0`", async () => {
    await expectErrorCode({ expression: "5 % 0" }, "DIVISION_BY_ZERO");
  });

  it("returns NOT_FINITE for sqrt(-1)", async () => {
    await expectErrorCode({ expression: "sqrt(-1)" }, "NOT_FINITE");
  });

  it("returns NOT_FINITE for ln(-5) and for overflow (`10^400`)", async () => {
    await expectErrorCode({ expression: "ln(-5)" }, "NOT_FINITE");
    await expectErrorCode({ expression: "10^400" }, "NOT_FINITE");
  });

  it("returns SYNTAX_ERROR for malformed operators (`2++*3`)", async () => {
    await expectErrorCode({ expression: "2++*3" }, "SYNTAX_ERROR");
  });

  it("returns SYNTAX_ERROR for an unbalanced `(1+2`", async () => {
    await expectErrorCode({ expression: "(1+2" }, "SYNTAX_ERROR");
  });

  it("returns SYNTAX_ERROR for trailing garbage (`1+2)`)", async () => {
    await expectErrorCode({ expression: "1+2)" }, "SYNTAX_ERROR");
  });

  it("returns SYNTAX_ERROR for an unknown identifier (`foo + 1`)", async () => {
    await expectErrorCode({ expression: "foo + 1" }, "SYNTAX_ERROR");
  });

  it("returns UNKNOWN_FUNCTION for an unknown function (`frobnicate(2)`)", async () => {
    await expectErrorCode({ expression: "frobnicate(2)" }, "UNKNOWN_FUNCTION");
  });

  it("returns SYNTAX_ERROR for wrong arity (`sqrt(1,2)`, `min(3)`)", async () => {
    await expectErrorCode({ expression: "sqrt(1,2)" }, "SYNTAX_ERROR");
    await expectErrorCode({ expression: "min(3)" }, "SYNTAX_ERROR");
  });

  it("returns EXPRESSION_TOO_LONG above 512 chars", async () => {
    const expression = "1+".repeat(256) + "1"; // 513 chars, otherwise valid
    expect(expression.length).toBe(513);
    await expectErrorCode({ expression }, "EXPRESSION_TOO_LONG");
  });

  it("rejects a missing, empty, or non-string expression", async () => {
    await expectErrorCode({}, "INVALID_ARGS");
    await expectErrorCode({ expression: "   " }, "INVALID_ARGS");
    await expectErrorCode({ expression: 42 }, "INVALID_ARGS");
  });
});

describe("calculate — no code execution", () => {
  it("rejects injection-shaped input with a clean parse error", async () => {
    for (const expression of [
      "process.exit(1)",
      'require("fs")',
      "globalThis.x = 1",
      "constructor + 1",
      "__proto__ + 1",
    ]) {
      const res = await run({ expression });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe("error");
        expect(["SYNTAX_ERROR", "UNKNOWN_FUNCTION"]).toContain(res.error.code);
      }
    }
  });
});

describe("calculate — tool metadata", () => {
  it("is named calculate and is Tier-1 (no write, no confirm)", () => {
    expect(calculate.name).toBe("calculate");
    expect(calculate.requiresWrite).toBe(false);
    expect(calculate.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema requiring `expression`", () => {
    const schema = calculate.inputSchema as { additionalProperties?: boolean; required?: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("expression");
  });
});
