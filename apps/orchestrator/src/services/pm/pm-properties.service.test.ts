/**
 * WARP-3520 — the pure half of pm-properties.service.ts: option validation, value
 * validation per field type, and the display strings the activity feed uses. No
 * database; everything that needs one is in
 * src/__tests__/pm-custom-properties.pg.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  NUMBER_VALUE_MAX,
  OPTIONS_PER_PROPERTY_LIMIT,
  OPTION_LABEL_MAX,
  PROPERTIES_PER_PROJECT_LIMIT,
  PM_PROPERTY_ERRORS,
  PropertyValueError,
  TEXT_VALUE_MAX,
  displayValue,
  hasOptions,
  readOptions,
  validateOptions,
  validateValue,
  type ApiPropertyOption,
  type ApiPropertyType,
} from "./pm-properties.service.js";

const OPTS: ApiPropertyOption[] = [
  { id: "o-low", label: "Low", color: null },
  { id: "o-high", label: "High", color: "#ef4444" },
];

const prop = (type: ApiPropertyType, options: ApiPropertyOption[] | null = null) => ({ type, options });

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PropertyValueError);
    return (err as PropertyValueError).userMessage;
  }
  throw new Error("expected a PropertyValueError");
}

describe("limits", () => {
  it("states the bounds the contract promises", () => {
    expect(PROPERTIES_PER_PROJECT_LIMIT).toBe(30);
    expect(OPTIONS_PER_PROPERTY_LIMIT).toBe(50);
    expect(OPTION_LABEL_MAX).toBe(60);
    expect(TEXT_VALUE_MAX).toBe(2000);
    expect(NUMBER_VALUE_MAX).toBe(1e12);
  });

  it("gives options to select and multi_select and to nothing else", () => {
    expect(hasOptions("select")).toBe(true);
    expect(hasOptions("multi_select")).toBe(true);
    for (const t of ["text", "number", "date", "boolean", "member"] as const) expect(hasOptions(t)).toBe(false);
  });
});

describe("validateOptions", () => {
  it("assigns an id to every new option and trims labels", () => {
    const out = validateOptions([{ label: "  Low " }, { label: "High", color: "#ef4444" }]);
    expect(out.map((o) => o.label)).toEqual(["Low", "High"]);
    expect(out[0].color).toBeNull();
    expect(out[1].color).toBe("#ef4444");
    expect(new Set(out.map((o) => o.id)).size).toBe(2);
    for (const o of out) expect(o.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the id of an existing option and may rename or recolour it", () => {
    const out = validateOptions([{ id: "o-low", label: "Minor", color: "#22c55e" }], OPTS);
    expect(out).toEqual([{ id: "o-low", label: "Minor", color: "#22c55e" }]);
  });

  it("accepts an empty list (a select field with no options yet)", () => {
    expect(validateOptions([])).toEqual([]);
  });

  it.each([
    ["an empty label", [{ label: "   " }]],
    ["a label over the limit", [{ label: "x".repeat(OPTION_LABEL_MAX + 1) }]],
    ["duplicate labels, ignoring case", [{ label: "Low" }, { label: "low" }]],
    ["an id the server never issued", [{ id: "o-made-up", label: "Low" }]],
    ["the same id twice", [{ id: "o-low", label: "A" }, { id: "o-low", label: "B" }]],
    ["an empty colour", [{ label: "A", color: "" }]],
    ["a colour over 32 characters", [{ label: "A", color: "c".repeat(33) }]],
  ])("refuses %s", (_name, raw) => {
    expect(() => validateOptions(raw, OPTS)).toThrow(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
  });

  it("refuses more than the option limit", () => {
    const many = Array.from({ length: OPTIONS_PER_PROPERTY_LIMIT + 1 }, (_, i) => ({ label: `option ${i}` }));
    expect(() => validateOptions(many)).toThrow(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
    expect(validateOptions(many.slice(0, OPTIONS_PER_PROPERTY_LIMIT))).toHaveLength(OPTIONS_PER_PROPERTY_LIMIT);
  });

  it("refuses ANY id on create, where there is nothing to match it against", () => {
    expect(() => validateOptions([{ id: "o-low", label: "Low" }])).toThrow(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
  });
});

describe("readOptions", () => {
  it("reads a well-formed column", () => {
    expect(readOptions([{ id: "a", label: "A", color: "#fff" }, { id: "b", label: "B" }])).toEqual([
      { id: "a", label: "A", color: "#fff" },
      { id: "b", label: "B", color: null },
    ]);
  });

  it("drops entries that are not {id, label} strings rather than casting through them", () => {
    expect(readOptions([{ id: 1, label: "A" }, null, "x", [], { id: "ok", label: "OK" }])).toEqual([
      { id: "ok", label: "OK", color: null },
    ]);
  });

  it("is null for a column that is not an array", () => {
    for (const bad of [null, undefined, {}, "x", 3]) expect(readOptions(bad as never)).toBeNull();
  });
});

describe("validateValue — text", () => {
  it("accepts and trims", () => {
    expect(validateValue(prop("text"), { text: "  hello " })).toEqual({ text: "hello" });
  });

  it("refuses empty, whitespace-only and over-long text with a sentence the editor can show", () => {
    for (const text of ["", "   ", "x".repeat(TEXT_VALUE_MAX + 1)]) {
      expect(messageOf(() => validateValue(prop("text"), { text }))).toMatch(/2000 characters/);
    }
    expect(validateValue(prop("text"), { text: "x".repeat(TEXT_VALUE_MAX) })).toEqual({
      text: "x".repeat(TEXT_VALUE_MAX),
    });
  });
});

describe("validateValue — number", () => {
  it("accepts finite numbers up to the bound, negative and fractional included", () => {
    for (const number of [0, -3, 2.5, NUMBER_VALUE_MAX, -NUMBER_VALUE_MAX]) {
      expect(validateValue(prop("number"), { number })).toEqual({ number });
    }
  });

  it("refuses NaN, Infinity and anything past 1e12", () => {
    for (const number of [Number.NaN, Number.POSITIVE_INFINITY, NUMBER_VALUE_MAX * 10, -NUMBER_VALUE_MAX * 10]) {
      expect(messageOf(() => validateValue(prop("number"), { number }))).toMatch(/between/);
    }
  });

  it("refuses a numeric string — the shape is part of the contract", () => {
    expect(messageOf(() => validateValue(prop("number"), { number: "3" }))).toBe("Enter a number.");
  });
});

describe("validateValue — date", () => {
  it("accepts a real calendar date", () => {
    expect(validateValue(prop("date"), { date: "2024-02-29" })).toEqual({ date: "2024-02-29" });
  });

  it.each(["2026-02-30", "2025-02-29", "2026-13-01", "10/04/2026", "2026-10-04T00:00:00Z", ""])(
    "refuses %s",
    (date) => {
      expect(messageOf(() => validateValue(prop("date"), { date }))).toMatch(/real date/);
    },
  );
});

describe("validateValue — boolean", () => {
  it("accepts true and false", () => {
    expect(validateValue(prop("boolean"), { boolean: false })).toEqual({ boolean: false });
    expect(validateValue(prop("boolean"), { boolean: true })).toEqual({ boolean: true });
  });

  it("refuses a truthy non-boolean", () => {
    expect(messageOf(() => validateValue(prop("boolean"), { boolean: "true" }))).toBe("Choose yes or no.");
  });
});

describe("validateValue — select / multi_select", () => {
  it("select takes exactly one option of THIS field", () => {
    expect(validateValue(prop("select", OPTS), { optionIds: ["o-low"] })).toEqual({ optionIds: ["o-low"] });
    expect(messageOf(() => validateValue(prop("select", OPTS), { optionIds: [] }))).toMatch(/one of/);
    expect(messageOf(() => validateValue(prop("select", OPTS), { optionIds: ["o-low", "o-high"] }))).toMatch(/one of/);
    expect(messageOf(() => validateValue(prop("select", OPTS), { optionIds: ["nope"] }))).toMatch(/isn't available/);
  });

  it("multi_select takes 1..50 distinct options of this field", () => {
    expect(validateValue(prop("multi_select", OPTS), { optionIds: ["o-low", "o-high"] })).toEqual({
      optionIds: ["o-low", "o-high"],
    });
    expect(messageOf(() => validateValue(prop("multi_select", OPTS), { optionIds: [] }))).toMatch(/Pick from/);
    expect(messageOf(() => validateValue(prop("multi_select", OPTS), { optionIds: ["o-low", "o-low"] }))).toMatch(
      /Pick from/,
    );
    expect(messageOf(() => validateValue(prop("multi_select", OPTS), { optionIds: ["o-low", "gone"] }))).toMatch(
      /isn't available/,
    );
  });

  it("refuses ids that are not strings, and a field with no options at all", () => {
    expect(messageOf(() => validateValue(prop("select", OPTS), { optionIds: [1] }))).toMatch(/one of/);
    expect(messageOf(() => validateValue(prop("select", []), { optionIds: ["o-low"] }))).toMatch(/isn't available/);
  });
});

describe("validateValue — member", () => {
  it("takes exactly one user id (the active-user check is the writer's, after this)", () => {
    expect(validateValue(prop("member"), { userIds: ["u1"] })).toEqual({ userIds: ["u1"] });
    expect(messageOf(() => validateValue(prop("member"), { userIds: [] }))).toBe("Pick a person.");
    expect(messageOf(() => validateValue(prop("member"), { userIds: ["u1", "u2"] }))).toBe("Pick a person.");
  });
});

describe("validateValue — shape is strict for every type", () => {
  it.each([
    ["text", { text: "a", extra: 1 }],
    ["number", { number: 1, text: "a" }],
    ["date", { date: "2026-10-04", x: 1 }],
    ["boolean", { boolean: true, x: 1 }],
    ["select", { optionIds: ["o-low"], x: 1 }],
    ["member", { userIds: ["u1"], x: 1 }],
  ] as const)("refuses an unknown key on %s", (type, raw) => {
    expect(() => validateValue(prop(type, OPTS), raw)).toThrow(PropertyValueError);
  });

  it.each([null, undefined, "x", 3, [], true])("refuses the non-object %o for every type", (raw) => {
    for (const t of ["text", "number", "date", "boolean", "select", "multi_select", "member"] as const) {
      expect(() => validateValue(prop(t, OPTS), raw)).toThrow(PropertyValueError);
    }
  });

  it("refuses the right value tagged for the WRONG type", () => {
    expect(() => validateValue(prop("number"), { text: "3" })).toThrow(PropertyValueError);
    expect(() => validateValue(prop("text"), { number: 3 })).toThrow(PropertyValueError);
    expect(() => validateValue(prop("select", OPTS), { userIds: ["u1"] })).toThrow(PropertyValueError);
  });
});

describe("displayValue — the strings the activity feed shows", () => {
  it("shows option LABELS, not ids", () => {
    expect(displayValue(prop("select", OPTS), { optionIds: ["o-high"] })).toBe("High");
    expect(displayValue(prop("multi_select", OPTS), { optionIds: ["o-low", "o-high"] })).toBe("Low, High");
  });

  it("falls back to the id for an option that is no longer in the list", () => {
    expect(displayValue(prop("select", OPTS), { optionIds: ["gone"] })).toBe("gone");
  });

  it("shows the plain value for the scalar types and ids for members", () => {
    expect(displayValue(prop("number"), { number: 2.5 })).toBe("2.5");
    expect(displayValue(prop("date"), { date: "2026-10-04" })).toBe("2026-10-04");
    expect(displayValue(prop("boolean"), { boolean: false })).toBe("false");
    expect(displayValue(prop("member"), { userIds: ["u1"] })).toBe("u1");
  });

  it("cuts text at 200 characters", () => {
    expect(displayValue(prop("text"), { text: "x".repeat(500) })).toHaveLength(200);
  });

  it("is null for a value of an unknown shape", () => {
    for (const v of [null, "x", 3, [], {}]) expect(displayValue(prop("text"), v as never)).toBeNull();
  });
});
