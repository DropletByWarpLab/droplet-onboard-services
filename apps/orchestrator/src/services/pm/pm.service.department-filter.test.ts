/**
 * WARP-2719 — the department filter, as the two readers that lacked one build it.
 *
 * ── What is actually at risk ───────────────────────────────────────────────
 *
 * Every failure this filter can have looks like a correct answer. A filter
 * written to `where.OR` returns "everything in Front Desk" for a question that
 * asked "what in Front Desk mentions tiles"; a filter dropped entirely returns
 * the whole board; a project filter borrowed from the work-item helper asks
 * whether a project's project has a department. None of the three throws, none
 * shows an error, and a model reports all of them as the answer.
 *
 * So these assert the `where` Prisma is HANDED, not the rows a fake returns.
 * A test that stubbed the result set could not tell any of the three apart.
 */
import { describe, it, expect } from "vitest";
import { listProjects, searchWorkItems } from "./pm.service.js";

const DEPT = "dept-front-desk";
const TEAM = "team-reception";

/**
 * Records every `where` the readers hand to Prisma.
 *
 * `department.findMany` answers the scope expansion: the target plus its child
 * teams, which is what makes tagging a DEPARTMENT reach its TEAMs.
 */
function makePrisma() {
  const seen: { project?: Record<string, unknown>; workItem?: Record<string, unknown> } = {};
  const prisma = {
    department: {
      findMany: async () => [{ id: DEPT }, { id: TEAM }],
    },
    pmProject: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        seen.project = args.where;
        return [];
      },
    },
    pmWorkItem: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        seen.workItem = args.where;
        return [];
      },
      groupBy: async () => [],
    },
  } as never;
  return { prisma, seen };
}

// ── listProjects ────────────────────────────────────────────────────────────

describe("listProjects — the department filter", () => {
  it("filters to the department AND its teams", async () => {
    const { prisma, seen } = makePrisma();
    await listProjects(prisma, { departmentId: DEPT });
    expect(seen.project?.departmentId).toEqual({ in: [DEPT, TEAM] });
  });

  it("🔴 does NOT use the work-item override rule", async () => {
    // A work item with no department of its own inherits its project's. A
    // project has nothing to inherit from, so borrowing
    // `departmentWorkItemWhere` here would ask whether the project's project
    // has a department — a question with no meaning that Prisma would answer
    // by throwing, or worse, by matching nothing.
    const { prisma, seen } = makePrisma();
    await listProjects(prisma, { departmentId: DEPT });
    expect(seen.project).not.toHaveProperty("OR");
    expect(seen.project).not.toHaveProperty("AND");
    expect(seen.project).not.toHaveProperty("project");
  });

  it("`none` filters to projects nobody owns", async () => {
    const { prisma, seen } = makePrisma();
    await listProjects(prisma, { departmentId: null });
    expect(seen.project?.departmentId).toBeNull();
  });

  it("MUTATION: no filter means NO key, not a null one", async () => {
    // `undefined` and `null` are different answers and the three-way encoding
    // is the whole contract. Writing `departmentId: null` for "no filter"
    // would return only the unowned projects — an empty board on most boxes,
    // read as "you have no projects".
    const { prisma, seen } = makePrisma();
    await listProjects(prisma, {});
    expect(seen.project).not.toHaveProperty("departmentId");
  });

  it("composes with the workspace and archive filters rather than replacing them", async () => {
    const { prisma, seen } = makePrisma();
    await listProjects(prisma, { departmentId: DEPT, workspaceSlug: "main" });
    expect(seen.project?.workspace).toEqual({ slug: "main" });
    expect(seen.project?.isArchived).toBe(false);
    expect(seen.project?.departmentId).toEqual({ in: [DEPT, TEAM] });
  });
});

// ── searchWorkItems ─────────────────────────────────────────────────────────

describe("searchWorkItems — the department filter", () => {
  it("🔴 answers a department-only query, where it used to return nothing", async () => {
    // "What is Front Desk working on?" carries no search term. This reader
    // hard-returned `[]` on an empty `q`, which was right while free text was
    // its only filter and became the reason the AC's own sentence could not be
    // answered. MUTATION: restore the unconditional `if (q.length === 0)
    // return []` and this is the only test that goes red.
    const { prisma, seen } = makePrisma();
    await searchWorkItems(prisma, { q: "", departmentId: DEPT });
    expect(seen.workItem).toBeDefined();
    expect(seen.workItem?.AND).toEqual([
      {
        OR: [
          { departmentId: { in: [DEPT, TEAM] } },
          { departmentId: null, project: { is: { departmentId: { in: [DEPT, TEAM] } } } },
        ],
      },
    ]);
  });

  it("still returns nothing for a query with no filter of any kind", async () => {
    // The short-circuit narrowed; it did not go away. An empty search with no
    // department is still a question with no content, and scanning every work
    // item on the box to answer it is not an improvement.
    const { prisma, seen } = makePrisma();
    const out = await searchWorkItems(prisma, { q: "   " });
    expect(out).toEqual([]);
    expect(seen.workItem).toBeUndefined();
  });

  it("🔴 does not run `contains: \"\"` when the department is the only filter", async () => {
    // The free-text `OR` used to be an unconditional member of the `where`
    // literal, safe only because an empty `q` was unreachable. With that guard
    // relaxed, leaving it unconditional runs `ILIKE '%%'` against name AND
    // descriptionHtml on every department-only query — a full scan that
    // returns the right rows, so nothing would ever look wrong.
    const { prisma, seen } = makePrisma();
    await searchWorkItems(prisma, { q: "", departmentId: DEPT });
    expect(seen.workItem).not.toHaveProperty("OR");
  });

  it("🔴 puts the department in AND, never in OR", async () => {
    // `where.OR` belongs to the free-text filter. Writing the department there
    // replaces it and turns "items in Front Desk matching tiles" into "items
    // in Front Desk" — more rows, all plausible, none of them the answer.
    const { prisma, seen } = makePrisma();
    await searchWorkItems(prisma, { q: "tiles", departmentId: DEPT });
    expect(seen.workItem?.OR).toEqual([
      { name: { contains: "tiles", mode: "insensitive" } },
      { descriptionHtml: { contains: "tiles", mode: "insensitive" } },
    ]);
    expect(Array.isArray(seen.workItem?.AND)).toBe(true);
  });

  it("honours the override rule: an item with none inherits its project's", async () => {
    const { prisma, seen } = makePrisma();
    await searchWorkItems(prisma, { q: "", departmentId: DEPT });
    const and = seen.workItem?.AND as Array<{ OR: Array<Record<string, unknown>> }>;
    expect(and[0].OR[1]).toHaveProperty("project");
  });

  it("`none` means neither level owns it", async () => {
    const { prisma, seen } = makePrisma();
    await searchWorkItems(prisma, { q: "", departmentId: null });
    expect(seen.workItem?.AND).toEqual([
      { departmentId: null, project: { is: { departmentId: null } } },
    ]);
  });

  it("composes with the workspace filter rather than replacing it", async () => {
    // `departmentWorkItemWhere`'s second arm reaches into `project`, and so
    // does the workspace filter. They must not clobber each other.
    const { prisma, seen } = makePrisma();
    await searchWorkItems(prisma, { q: "", departmentId: DEPT, workspaceSlug: "main" });
    expect(seen.workItem?.project).toEqual({ workspace: { slug: "main" } });
    expect(seen.workItem?.AND).toBeDefined();
  });
});
