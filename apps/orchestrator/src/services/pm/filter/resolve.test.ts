/**
 * WARP-3522 — the asynchronous half of a filter's meaning: which of the rows it
 * names still exist, and what a department reference expands to.
 *
 * Brief §3.9 ("Stale reference"): a saved view whose filter points at a label,
 * assignee, state … that was later deleted must STILL LOAD — it drops the
 * missing facet and says so. Never an error, never an empty-by-accident board
 * (an `in` over a deleted label matches nothing, and a board that is empty for
 * a reason nobody can see is the worst of the three outcomes).
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { PmFilter } from "@droplet/shared-types";
import { resolveFilterRefs } from "./resolve.js";

const leaf = (field: string, op: string, value?: unknown) =>
  (value === undefined ? { field, op } : { field, op, value }) as PmFilter;

type Existing = Partial<Record<"pmState" | "pmLabel" | "pmCycle" | "pmModule" | "pmWorkItem" | "pmProject" | "user", string[]>>;
interface Dept {
  id: string;
  name: string;
  slug: string;
  parentId?: string | null;
}

function fakeDb(existing: Existing = {}, departments: Dept[] = []) {
  const model = (ids: string[] = []) => ({
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      ids.filter((id) => where.id.in.includes(id)).map((id) => ({ id })),
    ),
  });
  const db = {
    pmState: model(existing.pmState),
    pmLabel: model(existing.pmLabel),
    pmCycle: model(existing.pmCycle),
    pmModule: model(existing.pmModule),
    pmWorkItem: model(existing.pmWorkItem),
    pmProject: model(existing.pmProject),
    user: model(existing.user),
    department: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        departments.find((d) => d.id === where.id) ? { id: where.id } : null,
      ),
      findFirst: vi.fn(async ({ where }: { where: { OR: Array<{ slug?: { equals: string }; name?: { equals: string } }> } }) => {
        const slug = where.OR[0].slug!.equals.toLowerCase();
        const name = where.OR[1].name!.equals.toLowerCase();
        const hit = departments.find((d) => d.slug.toLowerCase() === slug || d.name.toLowerCase() === name);
        return hit ? { id: hit.id } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { OR: Array<{ id?: string; parentId?: string }> } }) => {
        const id = where.OR[0].id!;
        return departments.filter((d) => d.id === id || d.parentId === id).map((d) => ({ id: d.id }));
      }),
    },
  };
  return db as unknown as PrismaClient & typeof db;
}

describe("resolveFilterRefs — nothing to look up", () => {
  it("returns the filter untouched and asks the database nothing", async () => {
    const db = fakeDb();
    const filter: PmFilter = { and: [leaf("priority", "is", "high"), leaf("assignee", "is", "me"), leaf("assignee", "isEmpty")] };
    const res = await resolveFilterRefs(db, filter);
    expect(res.filter).toEqual(filter);
    expect(res.stale).toEqual([]);
    expect(res.departments.size).toBe(0);
    for (const m of ["pmState", "pmLabel", "pmCycle", "pmModule", "pmWorkItem", "pmProject", "user"] as const) {
      expect(db[m].findMany).not.toHaveBeenCalled();
    }
  });

  it("never looks up a token: `me`, `none`", async () => {
    const db = fakeDb({ user: ["u1"] });
    await resolveFilterRefs(db, leaf("assignee", "in", ["me", "none", "u1"]));
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    expect(db.user.findMany.mock.calls[0][0].where.id.in).toEqual(["u1"]);
  });
});

describe("resolveFilterRefs — a reference to something that is gone", () => {
  it("drops a missing id from an in-list and keeps the rest", async () => {
    const db = fakeDb({ pmLabel: ["l1"] });
    const res = await resolveFilterRefs(db, leaf("label", "in", ["l1", "gone"]));
    expect(res.filter).toEqual(leaf("label", "in", ["l1"]));
    expect(res.stale).toEqual([{ field: "label", value: "gone" }]);
  });

  it("drops the condition when nothing it names exists", async () => {
    const db = fakeDb();
    const res = await resolveFilterRefs(
      db,
      { and: [leaf("priority", "is", "high"), leaf("label", "in", ["gone-1", "gone-2"])] },
    );
    expect(res.filter).toEqual(leaf("priority", "is", "high"));
    expect(res.stale).toEqual([
      { field: "label", value: "gone-1" },
      { field: "label", value: "gone-2" },
    ]);
  });

  it("drops an is / isNot on a missing id", async () => {
    const db = fakeDb();
    const res = await resolveFilterRefs(db, {
      and: [leaf("state", "is", "gone"), leaf("cycle", "isNot", "gone2"), leaf("priority", "is", "low")],
    });
    expect(res.filter).toEqual(leaf("priority", "is", "low"));
    expect(res.stale.map((s) => s.field)).toEqual(["state", "cycle"]);
  });

  it("an `and` that loses every condition becomes 'no filter', not 'nothing'", async () => {
    const db = fakeDb();
    const res = await resolveFilterRefs(db, { and: [leaf("label", "is", "gone"), leaf("state", "is", "gone")] });
    expect(res.filter).toEqual({ and: [] });
    expect(res.stale).toHaveLength(2);
  });

  it("an `or` that loses every arm is dropped from its parent rather than turning into 'false'", async () => {
    const db = fakeDb();
    const res = await resolveFilterRefs(db, {
      and: [leaf("priority", "is", "high"), { or: [leaf("label", "is", "gone"), leaf("module", "is", "gone")] }],
    });
    expect(res.filter).toEqual(leaf("priority", "is", "high"));
  });

  it("an `or` that keeps one arm keeps that arm", async () => {
    const db = fakeDb({ pmLabel: ["l1"] });
    const res = await resolveFilterRefs(db, {
      or: [leaf("label", "is", "gone"), leaf("label", "is", "l1")],
    });
    expect(res.filter).toEqual(leaf("label", "is", "l1"));
  });

  it("checks every referencing field: state, label, cycle, module, parent, project, assignee, createdBy", async () => {
    const db = fakeDb();
    const res = await resolveFilterRefs(db, {
      and: [
        leaf("state", "is", "x1"),
        leaf("label", "is", "x2"),
        leaf("cycle", "is", "x3"),
        leaf("module", "is", "x4"),
        leaf("parent", "is", "x5"),
        leaf("project", "is", "x6"),
        leaf("assignee", "is", "x7"),
        leaf("createdBy", "is", "x8"),
      ],
    });
    expect(res.stale.map((s) => s.field)).toEqual([
      "state",
      "label",
      "cycle",
      "module",
      "parent",
      "project",
      "assignee",
      "createdBy",
    ]);
    expect(res.filter).toEqual({ and: [] });
  });

  it("leaves everything that does exist exactly as written", async () => {
    const db = fakeDb({ pmState: ["s1", "s2"], user: ["u1"] });
    const filter: PmFilter = { and: [leaf("state", "in", ["s1", "s2"]), leaf("assignee", "isNot", "u1"), leaf("assignee", "isEmpty")] };
    const res = await resolveFilterRefs(db, filter);
    expect(res.filter).toEqual(filter);
    expect(res.stale).toEqual([]);
  });

  it("asks once per kind, however many conditions name it", async () => {
    const db = fakeDb({ pmLabel: ["l1", "l2", "l3"] });
    await resolveFilterRefs(db, {
      and: [leaf("label", "in", ["l1", "l2"]), { or: [leaf("label", "is", "l3"), leaf("label", "isNot", "l1")] }],
    });
    expect(db.pmLabel.findMany).toHaveBeenCalledTimes(1);
    expect(db.pmLabel.findMany.mock.calls[0][0].where.id.in.sort()).toEqual(["l1", "l2", "l3"]);
  });
});

describe("resolveFilterRefs — departments", () => {
  const DEPTS: Dept[] = [
    { id: "d-clin", name: "Clinical", slug: "clinical" },
    { id: "d-hyg", name: "Hygiene", slug: "hygiene", parentId: "d-clin" },
    { id: "d-front", name: "Front desk", slug: "front-desk" },
  ];

  it("resolves an id, a slug or a name, and expands a department to its teams", async () => {
    const db = fakeDb({}, DEPTS);
    const res = await resolveFilterRefs(
      db,
      { and: [leaf("department", "is", "Clinical"), leaf("department", "in", ["d-front", "hygiene"])] },
    );
    expect(res.stale).toEqual([]);
    expect([...res.departments.get("Clinical")!].sort()).toEqual(["d-clin", "d-hyg"]);
    expect(res.departments.get("d-front")).toEqual(["d-front"]);
    expect(res.departments.get("hygiene")).toEqual(["d-hyg"]);
  });

  it("resolves case-insensitively, like resolveDepartmentFilter", async () => {
    const db = fakeDb({}, DEPTS);
    const res = await resolveFilterRefs(db, leaf("department", "is", "FRONT DESK"));
    expect(res.departments.get("FRONT DESK")).toEqual(["d-front"]);
  });

  it("treats a department that does not exist as stale, not as an error", async () => {
    const db = fakeDb({}, DEPTS);
    const res = await resolveFilterRefs(db, {
      and: [leaf("department", "is", "Ghost"), leaf("priority", "is", "high")],
    });
    expect(res.filter).toEqual(leaf("priority", "is", "high"));
    expect(res.stale).toEqual([{ field: "department", value: "Ghost" }]);
    expect(res.departments.size).toBe(0);
  });

  it("does not look `none` up", async () => {
    const db = fakeDb({}, DEPTS);
    const res = await resolveFilterRefs(db, leaf("department", "is", "none"));
    expect(res.filter).toEqual(leaf("department", "is", "none"));
    expect(db.department.findUnique).not.toHaveBeenCalled();
    expect(db.department.findFirst).not.toHaveBeenCalled();
  });

  it("resolves a repeated reference once", async () => {
    const db = fakeDb({}, DEPTS);
    await resolveFilterRefs(db, {
      and: [leaf("department", "is", "Clinical"), leaf("department", "isNot", "Clinical")],
    });
    expect(db.department.findUnique).toHaveBeenCalledTimes(1);
  });
});
