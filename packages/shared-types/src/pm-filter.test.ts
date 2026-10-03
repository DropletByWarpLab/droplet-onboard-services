/**
 * WARP-3522 (ADR-069 §8) — the one filter language for work items.
 *
 * This file pins the grammar itself: what a filter may say (the field table),
 * what it must refuse (`validatePmFilter`), the canonical shape it is reduced
 * to (`normalizePmFilter`) and the compact string it travels as in a URL
 * (`serializePmFilter` / `parsePmFilter`). The compiler that turns a filter
 * into a Prisma `where` lives in the orchestrator and has its own suite.
 */
import { describe, it, expect } from "vitest";
import {
  PM_FILTER_FIELDS,
  PM_FILTER_MAX_DEPTH,
  PM_FILTER_MAX_NODES,
  PM_FILTER_MAX_VALUES,
  PM_FILTER_TEXT_MAX,
  isPmDateToken,
  normalizePmFilter,
  parsePmFilter,
  pmFilterConditions,
  pmFiltersEqual,
  relativeDateOffsetDays,
  serializePmFilter,
  validatePmFilter,
  type PmFilter,
  type PmFilterField,
  type PmFilterOp,
} from "./pm-filter";

const UUID_A = "3f2b8c1e-9a44-4d3b-8f10-2a6c1b7d9e01";
const UUID_B = "7d1e5a90-0b3c-4c8a-9e22-5f4a8d6c3b12";

/** One representative, valid value per (field, op) — drives the table tests. */
function sample(field: PmFilterField, op: PmFilterOp): unknown {
  const spec = PM_FILTER_FIELDS[field];
  const scalar =
    spec.kind === "enum"
      ? spec.options![0]
      : spec.kind === "date"
        ? "2026-10-03"
        : spec.kind === "boolean"
          ? true
          : spec.kind === "text"
            ? "login bug"
            : spec.kind === "ref"
              ? "Front desk"
              : UUID_A;
  switch (op) {
    case "in":
    case "notIn":
      return [scalar, spec.kind === "enum" ? spec.options![1] : spec.kind === "date" ? "today" : spec.kind === "boolean" ? false : spec.kind === "text" ? "other" : UUID_B];
    case "between":
      return ["-7d", "today"];
    case "isEmpty":
    case "isNotEmpty":
      return undefined;
    default:
      return scalar;
  }
}

function leaf(field: PmFilterField, op: PmFilterOp, value?: unknown): PmFilter {
  return (value === undefined ? { field, op } : { field, op, value }) as PmFilter;
}

describe("PM_FILTER_FIELDS", () => {
  it("names every field the spec lists that exists on the schema, plus project", () => {
    expect(Object.keys(PM_FILTER_FIELDS).sort()).toEqual(
      [
        "assignee",
        "createdAt",
        "createdBy",
        "cycle",
        "department",
        "dueDate",
        "isArchived",
        "label",
        "module",
        "parent",
        "priority",
        "project",
        "startDate",
        "state",
        "stateGroup",
        "text",
        "updatedAt",
      ].sort(),
    );
  });

  it("gives every field at least one op and only known ops", () => {
    for (const [name, spec] of Object.entries(PM_FILTER_FIELDS)) {
      expect(spec.ops.length, name).toBeGreaterThan(0);
    }
  });
});

describe("validatePmFilter — accepts", () => {
  const cases: Array<[PmFilterField, PmFilterOp]> = [];
  for (const [field, spec] of Object.entries(PM_FILTER_FIELDS)) {
    for (const op of spec.ops) cases.push([field as PmFilterField, op]);
  }

  it.each(cases)("%s.%s with a representative value", (field, op) => {
    const input = leaf(field, op, sample(field, op));
    const res = validatePmFilter(input);
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });

  it("accepts the root-only empty `and` as 'no filter'", () => {
    expect(validatePmFilter({ and: [] })).toEqual({ ok: true, filter: { and: [] } });
  });

  it("accepts nested groups up to the depth limit", () => {
    let node: unknown = leaf("priority", "is", "high");
    for (let i = 0; i < PM_FILTER_MAX_DEPTH; i += 1) node = { [i % 2 ? "and" : "or"]: [node] };
    expect(validatePmFilter(node).ok).toBe(true);
  });

  it("returns a clean copy: trims text, dedupes in-lists, drops nothing else", () => {
    const res = validatePmFilter({
      and: [
        { field: "text", op: "contains", value: "  login  " },
        { field: "state", op: "in", value: [UUID_A, UUID_A, UUID_B] },
      ],
    });
    expect(res).toEqual({
      ok: true,
      filter: {
        and: [
          { field: "text", op: "contains", value: "login" },
          { field: "state", op: "in", value: [UUID_A, UUID_B] },
        ],
      },
    });
  });

  it("accepts the `me` and `none` tokens where the field defines them", () => {
    expect(validatePmFilter(leaf("assignee", "is", "me")).ok).toBe(true);
    expect(validatePmFilter(leaf("assignee", "in", ["me", "none", UUID_A])).ok).toBe(true);
    expect(validatePmFilter(leaf("createdBy", "is", "me")).ok).toBe(true);
    expect(validatePmFilter(leaf("department", "is", "none")).ok).toBe(true);
  });
});

describe("validatePmFilter — refuses", () => {
  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "state.is:x"],
    ["an array", []],
    ["an unknown field", { field: "color", op: "is", value: "red" }],
    ["an op the field does not take", { field: "priority", op: "before", value: "today" }],
    ["contains on a non-text field", { field: "state", op: "contains", value: "a" }],
    ["is on a list value", { field: "state", op: "is", value: [UUID_A] }],
    ["in on a scalar value", { field: "state", op: "in", value: UUID_A }],
    ["an empty in-list", { field: "state", op: "in", value: [] }],
    ["a value on isEmpty", { field: "assignee", op: "isEmpty", value: "me" }],
    ["a missing value on is", { field: "state", op: "is" }],
    ["an enum member that does not exist", { field: "priority", op: "is", value: "critical" }],
    ["an enum member that does not exist in a list", { field: "stateGroup", op: "in", value: ["started", "nope"] }],
    ["a non-calendar date", { field: "dueDate", op: "is", value: "2026-02-30" }],
    ["a malformed relative date", { field: "dueDate", op: "before", value: "+5000d" }],
    ["a relative date with a bad unit", { field: "dueDate", op: "before", value: "3y" }],
    ["between with one bound", { field: "dueDate", op: "between", value: ["today"] }],
    ["between with three bounds", { field: "dueDate", op: "between", value: ["today", "+1d", "+2d"] }],
    ["a boolean field with a string", { field: "isArchived", op: "is", value: "true" }],
    ["an empty id", { field: "state", op: "is", value: "" }],
    ["an id with a space", { field: "state", op: "is", value: "a b" }],
    ["an id longer than 64 chars", { field: "state", op: "is", value: "a".repeat(65) }],
    ["blank text", { field: "text", op: "contains", value: "   " }],
    ["text over the limit", { field: "text", op: "contains", value: "x".repeat(PM_FILTER_TEXT_MAX + 1) }],
    ["text with a control character", { field: "text", op: "contains", value: "a\u0000b" }],
    ["an empty `or`", { or: [] }],
    ["a nested empty `and`", { and: [{ and: [] }, leaf("priority", "is", "low")] }],
    ["a node with both and + or", { and: [leaf("priority", "is", "low")], or: [leaf("priority", "is", "low")] }],
    ["an unknown key on a leaf", { field: "priority", op: "is", value: "low", extra: 1 }],
    ["an unknown key on a group", { and: [leaf("priority", "is", "low")], extra: 1 }],
    ["a group whose children are not an array", { and: leaf("priority", "is", "low") }],
    ["a group child that is not an object", { and: ["priority"] }],
    ["a list over the value limit", { field: "label", op: "in", value: Array.from({ length: PM_FILTER_MAX_VALUES + 1 }, (_, i) => `l${i}`) }],
  ];

  it.each(bad)("%s", (_name, input) => {
    const res = validatePmFilter(input);
    expect(res.ok).toBe(false);
  });

  it("refuses a tree deeper than the limit, without recursing into it", () => {
    let node: unknown = leaf("priority", "is", "high");
    for (let i = 0; i < PM_FILTER_MAX_DEPTH + 2; i += 1) node = { and: [node, leaf("priority", "is", "low")] };
    const res = validatePmFilter(node);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("filter_too_deep");
  });

  it("refuses a pathologically deep tree (10 000 levels) with an error, not a stack overflow", () => {
    let node: unknown = leaf("priority", "is", "high");
    for (let i = 0; i < 10_000; i += 1) node = { and: [node] };
    const res = validatePmFilter(node);
    expect(res.ok).toBe(false);
  });

  it("refuses a self-referencing object", () => {
    const cyc: { and: unknown[] } = { and: [] };
    cyc.and.push(cyc);
    expect(validatePmFilter(cyc).ok).toBe(false);
  });

  it("refuses a tree over the node limit", () => {
    const kids = Array.from({ length: PM_FILTER_MAX_NODES + 1 }, () => leaf("priority", "is", "low"));
    const res = validatePmFilter({ and: kids });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("filter_too_large");
  });

  it("reports the path of the offending node", () => {
    const res = validatePmFilter({
      and: [leaf("priority", "is", "low"), { or: [leaf("state", "is", UUID_A), { field: "priority", op: "is", value: "x" }] }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.path).toEqual(["and", 1, "or", 1, "value"]);
  });

  it("does not let a `__proto__` key smuggle fields in", () => {
    const evil = JSON.parse('{"field":"priority","op":"is","value":"low","__proto__":{"op":"before"}}');
    expect(validatePmFilter(evil).ok).toBe(false);
  });
});

describe("normalizePmFilter", () => {
  const a = leaf("priority", "is", "high");
  const b = leaf("assignee", "is", "me");
  const c = leaf("label", "in", [UUID_A]);

  it("unwraps single-child groups", () => {
    expect(normalizePmFilter({ and: [a] })).toEqual(a);
    expect(normalizePmFilter({ or: [{ and: [a] }] })).toEqual(a);
  });

  it("flattens a group nested inside a group of the same kind", () => {
    expect(normalizePmFilter({ and: [a, { and: [b, c] }] })).toEqual({ and: [a, b, c] });
    expect(normalizePmFilter({ or: [a, { or: [b, c] }] })).toEqual({ or: [a, b, c] });
  });

  it("keeps a group nested inside a group of the other kind", () => {
    expect(normalizePmFilter({ and: [a, { or: [b, c] }] })).toEqual({ and: [a, { or: [b, c] }] });
  });

  it("leaves the empty root `and` alone", () => {
    expect(normalizePmFilter({ and: [] })).toEqual({ and: [] });
  });

  it("is idempotent", () => {
    const f: PmFilter = { and: [a, { and: [{ or: [b, { or: [c, a] }] }] }] };
    const once = normalizePmFilter(f);
    expect(normalizePmFilter(once)).toEqual(once);
  });
});

describe("pmFilterConditions", () => {
  it("yields every leaf depth-first, in order", () => {
    const f: PmFilter = {
      and: [leaf("priority", "is", "high"), { or: [leaf("assignee", "is", "me"), leaf("label", "in", [UUID_A])] }],
    };
    expect([...pmFilterConditions(f)].map((c) => c.field)).toEqual(["priority", "assignee", "label"]);
  });
});

describe("isPmDateToken / relativeDateOffsetDays", () => {
  it.each([
    "2026-10-03",
    "2024-02-29",
    "today",
    "yesterday",
    "tomorrow",
    "-7d",
    "+14d",
    "-2w",
    "+1w",
    "-3650d",
  ])("accepts %s", (t) => {
    expect(isPmDateToken(t)).toBe(true);
  });

  it.each(["", "2026-13-01", "2025-02-29", "2026-1-1", "26-10-03", "Today", "7d", "0d", "+3650d1", "+3651d", "+521w", "next week", "-d", "+ 7d", "2026-10-03T00:00:00Z"])(
    "refuses %j",
    (t) => {
      expect(isPmDateToken(t)).toBe(false);
    },
  );

  it("converts relative tokens to a day offset and leaves absolute dates alone", () => {
    expect(relativeDateOffsetDays("today")).toBe(0);
    expect(relativeDateOffsetDays("yesterday")).toBe(-1);
    expect(relativeDateOffsetDays("tomorrow")).toBe(1);
    expect(relativeDateOffsetDays("-7d")).toBe(-7);
    expect(relativeDateOffsetDays("+14d")).toBe(14);
    expect(relativeDateOffsetDays("-2w")).toBe(-14);
    expect(relativeDateOffsetDays("2026-10-03")).toBeNull();
  });
});

describe("serializePmFilter / parsePmFilter", () => {
  const corpus: Array<[string, PmFilter]> = [
    ["no filter", { and: [] }],
    ["one leaf", leaf("assignee", "is", "me")],
    ["a valueless leaf", leaf("assignee", "isEmpty")],
    ["a flat and", { and: [leaf("assignee", "is", "me"), leaf("priority", "in", ["urgent", "high"])] }],
    ["a list of one", leaf("state", "in", [UUID_A])],
    ["a between", leaf("dueDate", "between", ["-7d", "today"])],
    ["a plus offset", leaf("dueDate", "before", "+14d")],
    ["a boolean", leaf("isArchived", "is", true)],
    ["a false boolean", leaf("isArchived", "is", false)],
    ["a root or", { or: [leaf("priority", "is", "urgent"), leaf("assignee", "isEmpty")] }],
    [
      "and containing or",
      {
        and: [
          leaf("stateGroup", "notIn", ["completed", "cancelled"]),
          { or: [leaf("assignee", "is", "me"), leaf("createdBy", "is", "me")] },
        ],
      },
    ],
    ["a department name with a space", leaf("department", "is", "Front desk")],
    ["text with reserved characters", leaf("text", "contains", "a,b;c:d(e)f~g%h&i=j+k#l/m\\n")],
    ["text with unicode", leaf("text", "contains", "café 日本語 🚀")],
    ["text with a leading dash", leaf("text", "contains", "-7d")],
    ["a dotted id", leaf("state", "is", "a.b-c_d")],
  ];

  it.each(corpus)("round-trips %s", (_name, f) => {
    const s = serializePmFilter(f);
    const back = parsePmFilter(s);
    expect(back).not.toBeNull();
    expect(normalizePmFilter(back!)).toEqual(normalizePmFilter(f));
    // Canonical: serializing what came back gives the same string.
    expect(serializePmFilter(back!)).toBe(s);
  });

  it("writes the empty filter as the empty string and reads it back", () => {
    expect(serializePmFilter({ and: [] })).toBe("");
    expect(parsePmFilter("")).toEqual({ and: [] });
  });

  it("writes a flat and without a wrapper, so a URL stays readable", () => {
    expect(serializePmFilter({ and: [leaf("assignee", "is", "me"), leaf("priority", "in", ["urgent", "high"])] })).toBe(
      "assignee.is:me,priority.in:urgent;high",
    );
  });

  it("escapes anything outside the URL-safe set with ~HH", () => {
    expect(serializePmFilter(leaf("text", "contains", "a b"))).toBe("text.contains:a~20b");
    expect(serializePmFilter(leaf("dueDate", "before", "+14d"))).toBe("dueDate.before:~2B14d");
    expect(serializePmFilter(leaf("text", "contains", "~"))).toBe("text.contains:~7E");
  });

  it("only ever emits characters that need no URL encoding beyond the delimiters", () => {
    for (const [, f] of corpus) {
      expect(serializePmFilter(f)).toMatch(/^[A-Za-z0-9._~,;:()-]*$/);
    }
  });

  it("normalizes before writing, so equal filters write the same string", () => {
    const a = leaf("priority", "is", "high");
    expect(serializePmFilter({ and: [{ and: [a] }] })).toBe(serializePmFilter(a));
  });

  const malformed = [
    "assignee",
    "assignee.is",
    "assignee.is:",
    "assignee.isEmpty:me",
    "assignee.nope:me",
    "nope.is:x",
    "state.in:",
    "state.in:a;",
    "state.in:;a",
    "priority.is:high,",
    ",priority.is:high",
    "and()",
    "and(priority.is:high",
    "priority.is:high)",
    "or(priority.is:high,)",
    "xor(priority.is:high)",
    "priority.is:hi%67h",
    "priority.is:hi gh",
    "text.contains:~",
    "text.contains:~4",
    "text.contains:~ZZ",
    "text.contains:~C3",
    "dueDate.between:today",
    "dueDate.before:soon",
    "isArchived.is:yes",
    "priority.is:high priority.is:low",
  ];
  it.each(malformed)("rejects the malformed string %j", (s) => {
    expect(parsePmFilter(s)).toBeNull();
  });

  it("rejects an over-long string", () => {
    expect(parsePmFilter("text.contains:" + "a".repeat(5000))).toBeNull();
  });

  it("rejects a string nested past the depth limit without recursing into it", () => {
    const deep = "and(".repeat(10_000) + "priority.is:high" + ")".repeat(10_000);
    expect(parsePmFilter(deep)).toBeNull();
  });

  it("applies the same semantic validation as validatePmFilter (a legal shape with an illegal value)", () => {
    expect(parsePmFilter("priority.is:critical")).toBeNull();
    expect(parsePmFilter("dueDate.is:2026-02-30")).toBeNull();
  });
});

describe("pmFiltersEqual", () => {
  it("compares the normalized form", () => {
    const a = leaf("priority", "is", "high");
    expect(pmFiltersEqual({ and: [a] }, a)).toBe(true);
    expect(pmFiltersEqual({ and: [] }, { and: [] })).toBe(true);
    expect(pmFiltersEqual(a, leaf("priority", "is", "low"))).toBe(false);
  });
});
