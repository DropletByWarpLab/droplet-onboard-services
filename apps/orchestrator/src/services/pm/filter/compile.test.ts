/**
 * WARP-3522 — `compileFilter`: a filter in, a Prisma `where` out.
 *
 * Every (field, op) the grammar allows has a case here that pins the exact
 * `where` — and a matching case in `pm-filter-query.pg.test.ts` that runs it
 * against Postgres and checks the ROWS, because a `where` that reads right can
 * still lose the NULL rows to SQL's three-valued logic (`NOT (x IN (...))` is
 * NULL, not true, when x is NULL). The shapes below are what keeps those rows.
 *
 * The compiler is pure: `ctx` carries the clock, the viewer's zone and id, and
 * the department scopes that `resolve.ts` looked up beforehand.
 */
import { describe, it, expect } from "vitest";
import {
  PM_FILTER_FIELDS,
  PM_FILTER_MAX_DEPTH,
  type PmFilter,
} from "@droplet/shared-types";
import { compileFilter, type PmFilterContext } from "./compile.js";

const NOW = new Date("2026-10-03T12:00:00Z");
const ME = "user-me";

function ctx(over: Partial<PmFilterContext> = {}): PmFilterContext {
  return { now: NOW, tz: "UTC", userId: ME, departments: new Map(), ...over };
}
const c = (f: PmFilter, over: Partial<PmFilterContext> = {}) => compileFilter(f, ctx(over));
const leaf = (field: string, op: string, value?: unknown) =>
  (value === undefined ? { field, op } : { field, op, value }) as PmFilter;

const A = "id-a";
const B = "id-b";

describe("groups", () => {
  it("compiles 'no filter' to the empty where", () => {
    expect(c({ and: [] })).toEqual({});
  });

  it("returns a lone condition without a wrapper", () => {
    expect(c(leaf("priority", "is", "high"))).toEqual({ priority: { in: ["high"] } });
    expect(c({ and: [leaf("priority", "is", "high")] })).toEqual({ priority: { in: ["high"] } });
  });

  it("and → AND, or → OR, nested", () => {
    expect(
      c({
        and: [
          leaf("priority", "is", "high"),
          { or: [leaf("state", "isEmpty"), leaf("cycle", "isEmpty")] },
        ],
      }),
    ).toEqual({
      AND: [{ priority: { in: ["high"] } }, { OR: [{ stateId: null }, { cycleId: null }] }],
    });
  });

  it("flattens same-kind nesting before it compiles", () => {
    expect(
      c({ and: [leaf("priority", "is", "high"), { and: [leaf("state", "isEmpty"), leaf("cycle", "isEmpty")] }] }),
    ).toEqual({ AND: [{ priority: { in: ["high"] } }, { stateId: null }, { cycleId: null }] });
  });

  it("refuses an invalid filter rather than compiling a guess", () => {
    expect(() => c({ field: "color", op: "is", value: "red" } as unknown as PmFilter)).toThrow("invalid_filter");
    expect(() => c({ or: [] } as PmFilter)).toThrow("invalid_filter");
    let deep: PmFilter = leaf("priority", "is", "low");
    for (let i = 0; i < PM_FILTER_MAX_DEPTH + 2; i += 1) deep = { and: [deep, leaf("priority", "is", "high")] };
    expect(() => c(deep)).toThrow("invalid_filter");
  });
});

describe("single-value columns: state, cycle, parent, createdBy (nullable) and priority, project (not)", () => {
  const nullable: Array<[string, string]> = [
    ["state", "stateId"],
    ["cycle", "cycleId"],
    ["parent", "parentId"],
    ["createdBy", "createdById"],
  ];

  it.each(nullable)("%s: is / in → IN", (field, col) => {
    expect(c(leaf(field, "is", A))).toEqual({ [col]: { in: [A] } });
    expect(c(leaf(field, "in", [A, B]))).toEqual({ [col]: { in: [A, B] } });
  });

  // `NOT IN` alone drops the NULL rows (NULL NOT IN (...) is NULL). "Not in
  // Review" must still include the item that has no state at all.
  it.each(nullable)("%s: isNot / notIn → NULL OR NOT IN, so the empty rows stay", (field, col) => {
    expect(c(leaf(field, "isNot", A))).toEqual({ OR: [{ [col]: null }, { [col]: { notIn: [A] } }] });
    expect(c(leaf(field, "notIn", [A, B]))).toEqual({ OR: [{ [col]: null }, { [col]: { notIn: [A, B] } }] });
  });

  it.each(nullable)("%s: isEmpty / isNotEmpty", (field, col) => {
    expect(c(leaf(field, "isEmpty"))).toEqual({ [col]: null });
    expect(c(leaf(field, "isNotEmpty"))).toEqual({ [col]: { not: null } });
  });

  it("priority: is / isNot / in / notIn (the column is never null)", () => {
    expect(c(leaf("priority", "is", "urgent"))).toEqual({ priority: { in: ["urgent"] } });
    expect(c(leaf("priority", "isNot", "urgent"))).toEqual({ priority: { notIn: ["urgent"] } });
    expect(c(leaf("priority", "in", ["urgent", "high"]))).toEqual({ priority: { in: ["urgent", "high"] } });
    expect(c(leaf("priority", "notIn", ["low", "none"]))).toEqual({ priority: { notIn: ["low", "none"] } });
  });

  it("project: is / isNot / in / notIn", () => {
    expect(c(leaf("project", "is", A))).toEqual({ projectId: { in: [A] } });
    expect(c(leaf("project", "isNot", A))).toEqual({ projectId: { notIn: [A] } });
    expect(c(leaf("project", "in", [A, B]))).toEqual({ projectId: { in: [A, B] } });
    expect(c(leaf("project", "notIn", [A, B]))).toEqual({ projectId: { notIn: [A, B] } });
  });
});

describe("stateGroup", () => {
  it("in / is → the state's group is one of them", () => {
    expect(c(leaf("stateGroup", "in", ["started", "unstarted"]))).toEqual({
      state: { is: { group: { in: ["started", "unstarted"] } } },
    });
    expect(c(leaf("stateGroup", "is", "completed"))).toEqual({ state: { is: { group: { in: ["completed"] } } } });
  });

  it("notIn / isNot → no state at all, or a state in another group (open means 'not done', stateless included)", () => {
    expect(c(leaf("stateGroup", "notIn", ["completed", "cancelled"]))).toEqual({
      OR: [{ stateId: null }, { state: { is: { group: { notIn: ["completed", "cancelled"] } } } }],
    });
    expect(c(leaf("stateGroup", "isNot", "completed"))).toEqual({
      OR: [{ stateId: null }, { state: { is: { group: { notIn: ["completed"] } } } }],
    });
  });
});

describe("assignee", () => {
  it("is / in an id → some assignee is in the set", () => {
    expect(c(leaf("assignee", "is", A))).toEqual({ assignees: { some: { userId: { in: [A] } } } });
    expect(c(leaf("assignee", "in", [A, B]))).toEqual({ assignees: { some: { userId: { in: [A, B] } } } });
  });

  it("`me` is the requester", () => {
    expect(c(leaf("assignee", "is", "me"))).toEqual({ assignees: { some: { userId: { in: [ME] } } } });
    expect(c(leaf("assignee", "in", ["me", A]))).toEqual({ assignees: { some: { userId: { in: [ME, A] } } } });
    expect(c(leaf("assignee", "isNot", "me"))).toEqual({ assignees: { none: { userId: { in: [ME] } } } });
  });

  it("isNot / notIn an id → NO assignee is in the set (an unassigned item qualifies)", () => {
    expect(c(leaf("assignee", "isNot", A))).toEqual({ assignees: { none: { userId: { in: [A] } } } });
    expect(c(leaf("assignee", "notIn", [A, B]))).toEqual({ assignees: { none: { userId: { in: [A, B] } } } });
  });

  it("`none` is 'nobody': is none ≡ isEmpty, isNot none ≡ isNotEmpty", () => {
    expect(c(leaf("assignee", "is", "none"))).toEqual({ assignees: { none: {} } });
    expect(c(leaf("assignee", "isEmpty"))).toEqual({ assignees: { none: {} } });
    expect(c(leaf("assignee", "isNot", "none"))).toEqual({ assignees: { some: {} } });
    expect(c(leaf("assignee", "isNotEmpty"))).toEqual({ assignees: { some: {} } });
  });

  it("`none` mixed into a list: in → someone in the set OR nobody", () => {
    expect(c(leaf("assignee", "in", ["none", A]))).toEqual({
      OR: [{ assignees: { some: { userId: { in: [A] } } } }, { assignees: { none: {} } }],
    });
  });

  it("`none` mixed into a list: notIn → nobody in the set AND somebody assigned", () => {
    expect(c(leaf("assignee", "notIn", ["none", A]))).toEqual({
      AND: [{ assignees: { none: { userId: { in: [A] } } } }, { assignees: { some: {} } }],
    });
  });

  it("refuses `me` when there is no signed-in user (the assistant's service principal)", () => {
    expect(() => c(leaf("assignee", "is", "me"), { userId: null })).toThrow("me_unavailable");
    expect(() => c(leaf("createdBy", "is", "me"), { userId: null })).toThrow("me_unavailable");
  });
});

describe("createdBy", () => {
  it("resolves `me`", () => {
    expect(c(leaf("createdBy", "is", "me"))).toEqual({ createdById: { in: [ME] } });
    expect(c(leaf("createdBy", "isNot", "me"))).toEqual({
      OR: [{ createdById: null }, { createdById: { notIn: [ME] } }],
    });
  });
});

describe("label and module (many-to-many)", () => {
  const joins: Array<[string, string, string]> = [
    ["label", "labels", "labelId"],
    ["module", "modules", "moduleId"],
  ];

  it.each(joins)("%s: is / in → some link is in the set", (field, rel, col) => {
    expect(c(leaf(field, "is", A))).toEqual({ [rel]: { some: { [col]: { in: [A] } } } });
    expect(c(leaf(field, "in", [A, B]))).toEqual({ [rel]: { some: { [col]: { in: [A, B] } } } });
  });

  it.each(joins)("%s: isNot / notIn → no link is in the set (an item with none qualifies)", (field, rel, col) => {
    expect(c(leaf(field, "isNot", A))).toEqual({ [rel]: { none: { [col]: { in: [A] } } } });
    expect(c(leaf(field, "notIn", [A, B]))).toEqual({ [rel]: { none: { [col]: { in: [A, B] } } } });
  });

  it.each(joins)("%s: isEmpty / isNotEmpty", (field, rel) => {
    expect(c(leaf(field, "isEmpty"))).toEqual({ [rel]: { none: {} } });
    expect(c(leaf(field, "isNotEmpty"))).toEqual({ [rel]: { some: {} } });
  });
});

describe("department (the override-or-inherit rule lives in pm-department.ts, not here)", () => {
  const departments = new Map<string, readonly string[] | null>([
    ["Clinical", ["d-clinical", "d-hygiene"]],
    ["Front desk", ["d-front"]],
    ["none", null],
  ]);
  const withDepts = { departments };

  it("is → the item's own department, or — if it has none — its project's, in the scope", () => {
    expect(c(leaf("department", "is", "Clinical"), withDepts)).toEqual({
      OR: [
        { departmentId: { in: ["d-clinical", "d-hygiene"] } },
        { departmentId: null, project: { is: { departmentId: { in: ["d-clinical", "d-hygiene"] } } } },
      ],
    });
  });

  it("in → the union of the scopes", () => {
    expect(c(leaf("department", "in", ["Clinical", "Front desk"]), withDepts)).toEqual({
      OR: [
        { departmentId: { in: ["d-clinical", "d-hygiene", "d-front"] } },
        { departmentId: null, project: { is: { departmentId: { in: ["d-clinical", "d-hygiene", "d-front"] } } } },
      ],
    });
  });

  it("is none / isEmpty → neither the item nor its project has one", () => {
    const owned = { departmentId: null, project: { is: { departmentId: null } } };
    expect(c(leaf("department", "is", "none"), withDepts)).toEqual(owned);
    expect(c(leaf("department", "isEmpty"), withDepts)).toEqual(owned);
  });

  it("isNot → an effective department that is NOT in the scope, and an item with none at all qualifies", () => {
    expect(c(leaf("department", "isNot", "Front desk"), withDepts)).toEqual({
      OR: [
        { departmentId: { notIn: ["d-front"] } },
        {
          departmentId: null,
          project: { is: { OR: [{ departmentId: null }, { departmentId: { notIn: ["d-front"] } }] } },
        },
      ],
    });
  });

  it("isNotEmpty / isNot none → somebody owns it, the item or its project", () => {
    const has = { OR: [{ departmentId: { not: null } }, { project: { is: { departmentId: { not: null } } } }] };
    expect(c(leaf("department", "isNotEmpty"), withDepts)).toEqual(has);
    expect(c(leaf("department", "isNot", "none"), withDepts)).toEqual(has);
  });

  it("in with `none` → in the scope OR owned by nobody", () => {
    expect(c(leaf("department", "in", ["Front desk", "none"]), withDepts)).toEqual({
      OR: [
        {
          OR: [
            { departmentId: { in: ["d-front"] } },
            { departmentId: null, project: { is: { departmentId: { in: ["d-front"] } } } },
          ],
        },
        { departmentId: null, project: { is: { departmentId: null } } },
      ],
    });
  });

  it("notIn with `none` → not in the scope AND owned by somebody", () => {
    expect(c(leaf("department", "notIn", ["Front desk", "none"]), withDepts)).toEqual({
      AND: [
        {
          OR: [
            { departmentId: { notIn: ["d-front"] } },
            {
              departmentId: null,
              project: { is: { OR: [{ departmentId: null }, { departmentId: { notIn: ["d-front"] } }] } },
            },
          ],
        },
        { OR: [{ departmentId: { not: null } }, { project: { is: { departmentId: { not: null } } } }] },
      ],
    });
  });

  it("is case-insensitive about the `none` word, like resolveDepartmentFilter", () => {
    expect(c(leaf("department", "is", "None"), withDepts)).toEqual({
      departmentId: null,
      project: { is: { departmentId: null } },
    });
  });

  it("refuses a department the resolver did not resolve (a bug upstream, not a user error)", () => {
    expect(() => c(leaf("department", "is", "Ghost"))).toThrow("department_unresolved");
  });
});

describe("date columns (dueDate, startDate): a calendar date stored at 00:00Z", () => {
  const D = (iso: string) => new Date(iso);

  it("is → that day", () => {
    expect(c(leaf("dueDate", "is", "2026-10-05"))).toEqual({
      dueDate: { gte: D("2026-10-05T00:00:00Z"), lt: D("2026-10-06T00:00:00Z") },
    });
  });

  it("before → strictly before the day; after → strictly after the day", () => {
    expect(c(leaf("dueDate", "before", "2026-10-05"))).toEqual({ dueDate: { lt: D("2026-10-05T00:00:00Z") } });
    expect(c(leaf("dueDate", "after", "2026-10-05"))).toEqual({ dueDate: { gte: D("2026-10-06T00:00:00Z") } });
  });

  it("between → both days inclusive", () => {
    expect(c(leaf("dueDate", "between", ["2026-10-01", "2026-10-05"]))).toEqual({
      dueDate: { gte: D("2026-10-01T00:00:00Z"), lt: D("2026-10-06T00:00:00Z") },
    });
  });

  it("isEmpty / isNotEmpty", () => {
    expect(c(leaf("dueDate", "isEmpty"))).toEqual({ dueDate: null });
    expect(c(leaf("startDate", "isNotEmpty"))).toEqual({ startDate: { not: null } });
  });

  it("startDate uses its own column", () => {
    expect(c(leaf("startDate", "before", "2026-10-05"))).toEqual({ startDate: { lt: D("2026-10-05T00:00:00Z") } });
  });

  it("resolves relative tokens against today in the viewer's zone", () => {
    expect(c(leaf("dueDate", "before", "today"))).toEqual({ dueDate: { lt: D("2026-10-03T00:00:00Z") } });
    expect(c(leaf("dueDate", "between", ["today", "+7d"]))).toEqual({
      dueDate: { gte: D("2026-10-03T00:00:00Z"), lt: D("2026-10-11T00:00:00Z") },
    });
    expect(c(leaf("dueDate", "is", "tomorrow"))).toEqual({
      dueDate: { gte: D("2026-10-04T00:00:00Z"), lt: D("2026-10-05T00:00:00Z") },
    });
    // 12:00Z on Oct 3 is already Oct 4 in Auckland: "today" moves, the column's zone does not.
    expect(c(leaf("dueDate", "before", "today"), { tz: "Pacific/Auckland" })).toEqual({
      dueDate: { lt: D("2026-10-04T00:00:00Z") },
    });
    // 03:00Z on Oct 4 is still Oct 3 in Los Angeles.
    expect(
      c(leaf("dueDate", "before", "today"), { tz: "America/Los_Angeles", now: D("2026-10-04T03:00:00Z") }),
    ).toEqual({ dueDate: { lt: D("2026-10-03T00:00:00Z") } });
  });
});

describe("timestamp columns (createdAt, updatedAt): the viewer's local day", () => {
  const D = (iso: string) => new Date(iso);

  it("is → the local day, 24 hours in UTC", () => {
    expect(c(leaf("createdAt", "is", "2026-10-03"))).toEqual({
      createdAt: { gte: D("2026-10-03T00:00:00Z"), lt: D("2026-10-04T00:00:00Z") },
    });
  });

  it("is → the local day in Los Angeles (PDT, UTC-7)", () => {
    expect(c(leaf("createdAt", "is", "2026-10-03"), { tz: "America/Los_Angeles" })).toEqual({
      createdAt: { gte: D("2026-10-03T07:00:00Z"), lt: D("2026-10-04T07:00:00Z") },
    });
  });

  it("is → 25 hours on the day the clocks go back", () => {
    expect(c(leaf("updatedAt", "is", "2026-11-01"), { tz: "America/Los_Angeles" })).toEqual({
      updatedAt: { gte: D("2026-11-01T07:00:00Z"), lt: D("2026-11-02T08:00:00Z") },
    });
  });

  it("before / after / between mirror the date-column semantics", () => {
    expect(c(leaf("createdAt", "before", "2026-10-03"), { tz: "Pacific/Auckland" })).toEqual({
      createdAt: { lt: D("2026-10-02T11:00:00Z") },
    });
    expect(c(leaf("createdAt", "after", "2026-10-03"), { tz: "Pacific/Auckland" })).toEqual({
      createdAt: { gte: D("2026-10-03T11:00:00Z") },
    });
    expect(c(leaf("updatedAt", "between", ["-7d", "today"]))).toEqual({
      updatedAt: { gte: D("2026-09-26T00:00:00Z"), lt: D("2026-10-04T00:00:00Z") },
    });
  });

  it("'last 7 days' in Auckland starts at Auckland's midnight, not UTC's", () => {
    // now = 2026-10-03T12:00Z = 2026-10-04 01:00 NZDT, so today = 10-04 and -7d = 09-27 — the day NZ
    // went onto summer time, which started at 00:00 NZST (UTC+12), not at 00:00 NZDT.
    expect(c(leaf("createdAt", "between", ["-7d", "today"]), { tz: "Pacific/Auckland" })).toEqual({
      createdAt: { gte: D("2026-09-26T12:00:00Z"), lt: D("2026-10-04T11:00:00Z") },
    });
  });
});

describe("text", () => {
  it("name OR the plain-text description, case-insensitive", () => {
    expect(c(leaf("text", "contains", "login"))).toEqual({
      OR: [
        { name: { contains: "login", mode: "insensitive" } },
        { descriptionText: { contains: "login", mode: "insensitive" } },
      ],
    });
  });

  it("escapes LIKE wildcards: Prisma passes `%` and `_` through, so '100%' would match '100 anything'", () => {
    expect(c(leaf("text", "contains", "50%_off\\"))).toEqual({
      OR: [
        { name: { contains: "50\\%\\_off\\\\", mode: "insensitive" } },
        { descriptionText: { contains: "50\\%\\_off\\\\", mode: "insensitive" } },
      ],
    });
  });

  it("also finds an item by its key, because the search box always did", () => {
    expect(c(leaf("text", "contains", "inbox-42"))).toEqual({
      OR: [
        { name: { contains: "inbox-42", mode: "insensitive" } },
        { descriptionText: { contains: "inbox-42", mode: "insensitive" } },
        { sequenceId: 42, project: { is: { identifier: { equals: "inbox", mode: "insensitive" } } } },
      ],
    });
  });

  it("does not treat a number or a longer string as a key", () => {
    const arms = (v: string) => (c(leaf("text", "contains", v)) as { OR: unknown[] }).OR.length;
    expect(arms("42")).toBe(2);
    expect(arms("inbox-42 fix")).toBe(2);
    expect(arms("inbox-")).toBe(2);
  });
});

describe("isArchived", () => {
  it("is true / false", () => {
    expect(c(leaf("isArchived", "is", true))).toEqual({ isArchived: true });
    expect(c(leaf("isArchived", "is", false))).toEqual({ isArchived: false });
  });
});

describe("coverage", () => {
  it("every op of every field compiles (the table is the contract; the compiler must not lag it)", () => {
    const departments = new Map<string, readonly string[] | null>([["Front desk", ["d1"]]]);
    for (const [field, spec] of Object.entries(PM_FILTER_FIELDS)) {
      for (const op of spec.ops) {
        const value =
          op === "isEmpty" || op === "isNotEmpty"
            ? undefined
            : op === "in" || op === "notIn"
              ? [spec.kind === "enum" ? spec.options![0] : spec.kind === "ref" ? "Front desk" : A]
              : op === "between"
                ? ["-7d", "today"]
                : spec.kind === "enum"
                  ? spec.options![0]
                  : spec.kind === "date"
                    ? "today"
                    : spec.kind === "boolean"
                      ? true
                      : spec.kind === "text"
                        ? "x"
                        : spec.kind === "ref"
                          ? "Front desk"
                          : A;
        expect(() => c(leaf(field, op, value), { departments }), `${field}.${op}`).not.toThrow();
      }
    }
  });
});

describe("a zone that is not one", () => {
  it("is refused, not guessed", () => {
    expect(() => c(leaf("dueDate", "before", "today"), { tz: "Mars/Olympus" })).toThrow("invalid_timezone");
  });
});
