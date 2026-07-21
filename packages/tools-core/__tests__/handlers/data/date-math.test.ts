/**
 * WARP-1424 — `date_math` (UTC calendar arithmetic: add/subtract with
 * month-end clamping, signed date diff, next weekday). Tier-1 read,
 * pure computation, no ToolContext dependencies.
 */
import { describe, it, expect } from "vitest";
import dateMath from "../../../src/handlers/data/date-math.js";
import type { ToolContext, ToolError, ToolResult } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

interface DateMathData {
  type: string;
  operation: string;
  input?: string;
  result?: string;
  weekday?: string;
  date?: string;
  otherDate?: string;
  totalDays?: number;
  totalHours?: number;
  totalMinutes?: number;
  breakdown?: { days: number; hours: number; minutes: number };
  direction?: string;
}

function okData(res: ToolResult): DateMathData {
  expect(res.ok).toBe(true);
  if (!res.ok) {
    throw new Error(`expected success, got ${res.error.code}: ${res.error.message}`);
  }
  return res.data as DateMathData;
}

function errOf(res: ToolResult): ToolError {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected an error result");
  return res.error;
}

describe("date_math — add / subtract", () => {
  it("adds days across a month boundary (date-only in → date-only out)", async () => {
    const data = okData(
      await dateMath.handler({ operation: "add", date: "2025-01-30", amount: { days: 5 } }, ctx),
    );
    expect(data.type).toBe("date_math");
    expect(data.operation).toBe("add");
    expect(data.input).toBe("2025-01-30");
    expect(data.result).toBe("2025-02-04");
  });

  it("clamps to month-end: 2025-01-31 + 1 month = 2025-02-28", async () => {
    const data = okData(
      await dateMath.handler({ operation: "add", date: "2025-01-31", amount: { months: 1 } }, ctx),
    );
    expect(data.result).toBe("2025-02-28");
  });

  it("clamps to the leap day: 2024-01-31 + 1 month = 2024-02-29", async () => {
    const data = okData(
      await dateMath.handler({ operation: "add", date: "2024-01-31", amount: { months: 1 } }, ctx),
    );
    expect(data.result).toBe("2024-02-29");
  });

  it("clamps a leap day forward: 2024-02-29 + 1 year = 2025-02-28", async () => {
    const data = okData(
      await dateMath.handler({ operation: "add", date: "2024-02-29", amount: { years: 1 } }, ctx),
    );
    expect(data.result).toBe("2025-02-28");
  });

  it("subtracts 2 weeks", async () => {
    const data = okData(
      await dateMath.handler({ operation: "subtract", date: "2025-03-15", amount: { weeks: 2 } }, ctx),
    );
    expect(data.operation).toBe("subtract");
    expect(data.result).toBe("2025-03-01");
  });

  it("clamps on subtract too: 2025-03-31 - 1 month = 2025-02-28", async () => {
    const data = okData(
      await dateMath.handler({ operation: "subtract", date: "2025-03-31", amount: { months: 1 } }, ctx),
    );
    expect(data.result).toBe("2025-02-28");
  });

  it("adds hours and minutes to a datetime (full ISO UTC out)", async () => {
    const data = okData(
      await dateMath.handler(
        { operation: "add", date: "2025-06-10T22:30:00Z", amount: { hours: 3, minutes: 45 } },
        ctx,
      ),
    );
    expect(data.input).toBe("2025-06-10T22:30:00.000Z");
    expect(data.result).toBe("2025-06-11T02:15:00.000Z");
  });

  it("normalizes an offset datetime to UTC", async () => {
    const data = okData(
      await dateMath.handler(
        { operation: "add", date: "2025-01-01T01:00:00+02:00", amount: { hours: 1 } },
        ctx,
      ),
    );
    expect(data.input).toBe("2024-12-31T23:00:00.000Z");
    expect(data.result).toBe("2025-01-01T00:00:00.000Z");
  });

  it("promotes a date-only input to a full datetime when hours/minutes land off midnight", async () => {
    const data = okData(
      await dateMath.handler({ operation: "add", date: "2025-01-01", amount: { hours: 25 } }, ctx),
    );
    expect(data.result).toBe("2025-01-02T01:00:00.000Z");
  });
});

describe("date_math — diff", () => {
  it("returns positive totals and direction 'future' when other_date is later", async () => {
    const data = okData(
      await dateMath.handler(
        { operation: "diff", date: "2025-01-01", other_date: "2025-01-02T12:00:00Z" },
        ctx,
      ),
    );
    expect(data.date).toBe("2025-01-01");
    expect(data.otherDate).toBe("2025-01-02T12:00:00.000Z");
    expect(data.totalDays).toBe(1.5);
    expect(data.totalHours).toBe(36);
    expect(data.totalMinutes).toBe(2160);
    expect(data.breakdown).toEqual({ days: 1, hours: 12, minutes: 0 });
    expect(data.direction).toBe("future");
  });

  it("returns negative totals and direction 'past' when other_date is earlier", async () => {
    const data = okData(
      await dateMath.handler({ operation: "diff", date: "2025-01-10", other_date: "2025-01-08" }, ctx),
    );
    expect(data.totalDays).toBe(-2);
    expect(data.totalHours).toBe(-48);
    expect(data.totalMinutes).toBe(-2880);
    expect(data.breakdown).toEqual({ days: 2, hours: 0, minutes: 0 });
    expect(data.direction).toBe("past");
  });

  it("returns direction 'same' for the same instant across shapes", async () => {
    const data = okData(
      await dateMath.handler(
        { operation: "diff", date: "2025-03-05T00:00:00Z", other_date: "2025-03-05" },
        ctx,
      ),
    );
    expect(data.totalDays).toBe(0);
    expect(data.totalHours).toBe(0);
    expect(data.totalMinutes).toBe(0);
    expect(data.breakdown).toEqual({ days: 0, hours: 0, minutes: 0 });
    expect(data.direction).toBe("same");
  });

  it("treats a naive datetime as UTC", async () => {
    const data = okData(
      await dateMath.handler(
        { operation: "diff", date: "2025-01-01T06:00:00", other_date: "2025-01-01T08:30:00Z" },
        ctx,
      ),
    );
    expect(data.totalMinutes).toBe(150);
    expect(data.totalHours).toBe(2.5);
    expect(data.direction).toBe("future");
  });
});

describe("date_math — next_weekday", () => {
  it("finds the next weekday mid-week (Tuesday 2025-06-10 → Friday 2025-06-13)", async () => {
    const data = okData(
      await dateMath.handler({ operation: "next_weekday", date: "2025-06-10", weekday: "friday" }, ctx),
    );
    expect(data.input).toBe("2025-06-10");
    expect(data.result).toBe("2025-06-13");
    expect(data.weekday).toBe("friday");
  });

  it("jumps a full week when the date already falls on the weekday", async () => {
    const data = okData(
      await dateMath.handler({ operation: "next_weekday", date: "2025-06-13", weekday: "friday" }, ctx),
    );
    expect(data.result).toBe("2025-06-20");
  });

  it("matches the weekday case-insensitively and returns the resolved name", async () => {
    const data = okData(
      await dateMath.handler({ operation: "next_weekday", date: "2025-06-10", weekday: "FriDay" }, ctx),
    );
    expect(data.result).toBe("2025-06-13");
    expect(data.weekday).toBe("friday");
  });

  it("keeps the datetime shape of the input", async () => {
    const data = okData(
      await dateMath.handler(
        { operation: "next_weekday", date: "2025-06-10T15:30:00Z", weekday: "friday" },
        ctx,
      ),
    );
    expect(data.result).toBe("2025-06-13T15:30:00.000Z");
  });
});

describe("date_math — validation errors", () => {
  it("rejects an unknown operation", async () => {
    const err = errOf(
      await dateMath.handler({ operation: "multiply", date: "2025-01-01" }, ctx),
    );
    expect(err.code).toBe("INVALID_OPERATION");
  });

  it("rejects a missing operation", async () => {
    const err = errOf(await dateMath.handler({ date: "2025-01-01" }, ctx));
    expect(err.code).toBe("INVALID_OPERATION");
  });

  it("rejects an unparseable date", async () => {
    const err = errOf(
      await dateMath.handler({ operation: "add", date: "not-a-date", amount: { days: 1 } }, ctx),
    );
    expect(err.code).toBe("INVALID_DATE");
  });

  it("rejects an impossible calendar day", async () => {
    const err = errOf(
      await dateMath.handler({ operation: "add", date: "2025-02-30", amount: { days: 1 } }, ctx),
    );
    expect(err.code).toBe("INVALID_DATE");
  });

  it("names other_date when it is the unparseable one", async () => {
    const err = errOf(
      await dateMath.handler({ operation: "diff", date: "2025-01-01", other_date: "banana" }, ctx),
    );
    expect(err.code).toBe("INVALID_DATE");
    expect(err.message).toContain("other_date");
  });

  it("returns MISSING_AMOUNT when add has no amount", async () => {
    const err = errOf(await dateMath.handler({ operation: "add", date: "2025-01-01" }, ctx));
    expect(err.code).toBe("MISSING_AMOUNT");
  });

  it("returns EMPTY_AMOUNT for an amount object with no components", async () => {
    const err = errOf(
      await dateMath.handler({ operation: "add", date: "2025-01-01", amount: {} }, ctx),
    );
    expect(err.code).toBe("EMPTY_AMOUNT");
  });

  it("returns INVALID_AMOUNT for a non-integer component", async () => {
    const err = errOf(
      await dateMath.handler({ operation: "add", date: "2025-01-01", amount: { days: 1.5 } }, ctx),
    );
    expect(err.code).toBe("INVALID_AMOUNT");
  });

  it("returns INVALID_AMOUNT for a string component", async () => {
    const err = errOf(
      await dateMath.handler({ operation: "add", date: "2025-01-01", amount: { days: "3" } }, ctx),
    );
    expect(err.code).toBe("INVALID_AMOUNT");
  });

  it("returns AMOUNT_OUT_OF_RANGE beyond ±10000", async () => {
    const err = errOf(
      await dateMath.handler({ operation: "add", date: "2025-01-01", amount: { days: 10001 } }, ctx),
    );
    expect(err.code).toBe("AMOUNT_OUT_OF_RANGE");
  });

  it("returns MISSING_OTHER_DATE for diff without other_date", async () => {
    const err = errOf(await dateMath.handler({ operation: "diff", date: "2025-01-01" }, ctx));
    expect(err.code).toBe("MISSING_OTHER_DATE");
  });

  it("returns MISSING_WEEKDAY for next_weekday without weekday", async () => {
    const err = errOf(await dateMath.handler({ operation: "next_weekday", date: "2025-01-01" }, ctx));
    expect(err.code).toBe("MISSING_WEEKDAY");
  });

  it("returns INVALID_WEEKDAY for a bad weekday string", async () => {
    const err = errOf(
      await dateMath.handler({ operation: "next_weekday", date: "2025-01-01", weekday: "funday" }, ctx),
    );
    expect(err.code).toBe("INVALID_WEEKDAY");
  });
});

describe("date_math — tool metadata", () => {
  it("is named date_math and is Tier-1 (no write, no confirm)", () => {
    expect(dateMath.name).toBe("date_math");
    expect(dateMath.requiresWrite).toBe(false);
    expect(dateMath.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false schema requiring operation and date", () => {
    const schema = dateMath.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["operation", "date"]);
  });
});
