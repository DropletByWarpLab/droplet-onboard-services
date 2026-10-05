/**
 * WARP-3522 (ADR-069 §8) — what the filter DSL's SQL actually returns.
 *
 * `compile.test.ts` pins the `where` each (field, op) compiles to. That proves
 * the compiler says what we meant; it cannot prove Postgres hears it. The one
 * thing that goes wrong between the two is SQL's three-valued logic —
 * `x NOT IN (...)` is NULL, not true, when x is NULL — and it only shows against
 * rows that HAVE a NULL: an item with no state, no assignee, no due date. So the
 * fixture below is deliberately null-heavy, and every case asserts ROWS.
 *
 * Also proven here, because none of it is observable from a mock: the plain-text
 * projection trigger (`descriptionText`), the trigram indexes being real and
 * usable, the offset cursor walking a result set with no repeat and no gap, the
 * three sort rules a keyset could not serve (NULLS LAST both ways, enum order,
 * joined-row order), exact group counts, and the stale-reference drop.
 *
 * Gated like every other `*.pg.test.ts`: real Postgres, RUN_PG_INTEGRATION=1.
 * Fixtures are namespaced `ws6q-` — the pg-gated suites share one throwaway DB,
 * so an unscoped delete would eat another suite's rows.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PM_FILTER_FIELDS, pmFilterConditions, type PmFilter, type PmGroupByField, type PmSortSpec } from "@droplet/shared-types";
import {
  queryWorkItems,
  findWorkItemByKey,
  type PmQueryRequest,
  type PmQueryResult,
} from "../services/pm/filter/query.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const NOW = new Date("2026-10-03T12:00:00Z");
const D = (iso: string) => new Date(iso);
const PREFIX = "ws6q-";

describe.skipIf(!RUN)("PM filter DSL → SQL (WARP-3522)", () => {
  let prisma: PrismaClient;

  // ── fixture handles ──
  let wsSlug: string;
  const id: Record<string, string> = {};

  const leaf = (field: string, op: string, value?: unknown) =>
    (value === undefined ? { field, op } : { field, op, value }) as PmFilter;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    await cleanup();
    await build();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup() {
    // FK order: the workspace takes its projects, their items, states, labels and
    // cycles with it; departments and users are pointed AT, so they go last.
    await prisma.pmWorkspace.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.department.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  }

  async function build() {
    wsSlug = `${PREFIX}ws`;
    const ws = await prisma.pmWorkspace.create({ data: { slug: wsSlug, name: "ws6q" } });

    for (const n of ["ana", "ben", "cy"]) {
      const u = await prisma.user.create({ data: { username: `${PREFIX}${n}`, displayName: n } });
      id[n] = u.id;
    }

    const dept = (key: string, name: string, kind: "DEPARTMENT" | "TEAM", parentId?: string) =>
      prisma.department.create({
        data: { name: `${PREFIX}${name}`, slug: `${PREFIX}${key}`, createdBy: "ws6q-actor", kind, state: "active", parentId },
      });
    const clin = await dept("clinical", "Clinical", "DEPARTMENT");
    const hyg = await dept("hygiene", "Hygiene", "TEAM", clin.id);
    const front = await dept("front", "Front desk", "DEPARTMENT");
    id.clin = clin.id;
    id.hyg = hyg.id;
    id.front = front.id;

    const proj = (key: string, name: string, over: { departmentId?: string; isArchived?: boolean } = {}) =>
      prisma.pmProject.create({
        data: { workspaceId: ws.id, name: `${PREFIX}${name}`, identifier: key, ...over },
      });
    const p1 = await proj("W6A", "p1", { departmentId: clin.id });
    const p2 = await proj("W6B", "p2");
    const p3 = await proj("W6C", "p3-archived", { isArchived: true });
    id.p1 = p1.id;
    id.p2 = p2.id;
    id.p3 = p3.id;

    const state = async (projectId: string, key: string, name: string, group: "backlog" | "unstarted" | "started" | "completed" | "cancelled", sortOrder: number) => {
      const s = await prisma.pmState.create({ data: { projectId, name, group, sortOrder } });
      id[key] = s.id;
    };
    await state(p1.id, "sB", "Backlog", "backlog", 0);
    await state(p1.id, "sT", "Todo", "unstarted", 1);
    await state(p1.id, "sD", "Doing", "started", 2);
    await state(p1.id, "sDone", "Done", "completed", 3);
    await state(p1.id, "sC", "Cancelled", "cancelled", 4);
    await state(p2.id, "s2T", "Todo", "unstarted", 1);
    await state(p2.id, "s2Done", "Done", "completed", 2);
    await state(p3.id, "s3T", "Todo", "unstarted", 1);

    const label = async (projectId: string, key: string, name: string) => {
      id[key] = (await prisma.pmLabel.create({ data: { projectId, name } })).id;
    };
    await label(p1.id, "lBug", "Bug");
    await label(p1.id, "lDocs", "Docs");
    await label(p2.id, "l2Bug", "Bug");

    id.cycle = (await prisma.pmCycle.create({ data: { projectId: p1.id, name: "Sprint 1" } })).id;
    id.module = (await prisma.pmModule.create({ data: { projectId: p1.id, name: "Epic 1" } })).id;

    const seq: Record<string, number> = {};
    const item = async (
      key: string,
      projectId: string,
      name: string,
      o: Partial<{
        stateId: string | null;
        priority: "urgent" | "high" | "medium" | "low" | "none";
        assignees: string[];
        labelIds: string[];
        dueDate: Date;
        startDate: Date;
        cycleId: string;
        parentId: string;
        departmentId: string;
        createdById: string;
        descriptionHtml: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
      }> = {},
    ) => {
      const sequenceId = (seq[projectId] = (seq[projectId] ?? 0) + 1);
      const created = o.createdAt ?? D("2026-08-01T12:00:00Z");
      const row = await prisma.pmWorkItem.create({
        data: {
          projectId,
          sequenceId,
          name: `${PREFIX}${name}`,
          sortOrder: sequenceId,
          stateId: o.stateId === undefined ? null : o.stateId,
          priority: o.priority ?? "none",
          dueDate: o.dueDate,
          startDate: o.startDate,
          cycleId: o.cycleId,
          parentId: o.parentId,
          departmentId: o.departmentId,
          createdById: o.createdById,
          descriptionHtml: o.descriptionHtml,
          isArchived: o.isArchived ?? false,
          createdAt: created,
          updatedAt: o.updatedAt ?? created,
          assignees: o.assignees?.length ? { create: o.assignees.map((userId) => ({ userId })) } : undefined,
          labels: o.labelIds?.length ? { create: o.labelIds.map((labelId) => ({ labelId })) } : undefined,
        },
      });
      id[key] = row.id;
      return row;
    };

    // ── P1: the null-heavy set the shapes are proven against ──
    await item("alpha", p1.id, "alpha", {
      stateId: id.sT,
      priority: "high",
      assignees: [id.ana],
      labelIds: [id.lBug],
      dueDate: D("2026-10-02T00:00:00Z"),
      startDate: D("2026-09-20T00:00:00Z"),
      cycleId: id.cycle,
      createdById: id.ana,
      descriptionHtml: "<p>Fix the <strong>login</strong> flow</p>",
      createdAt: D("2026-09-01T10:00:00Z"),
    });
    await item("bravo", p1.id, "bravo", {
      stateId: id.sD,
      priority: "urgent",
      assignees: [id.ben],
      labelIds: [id.lBug, id.lDocs],
      dueDate: D("2026-10-03T00:00:00Z"),
      createdById: id.ben,
      descriptionHtml: "<p>R&amp;D notes</p>",
      createdAt: D("2026-10-03T06:30:00Z"),
    });
    await item("charlie", p1.id, "charlie", {
      stateId: id.sDone,
      priority: "low",
      assignees: [id.ana, id.ben],
      dueDate: D("2026-10-05T00:00:00Z"),
      startDate: D("2026-10-01T00:00:00Z"),
      createdAt: D("2026-10-02T23:30:00Z"),
    });
    await item("delta", p1.id, "delta", {
      stateId: null, // NO state: the row a naive NOT IN loses
      labelIds: [id.lDocs],
      createdById: id.cy,
      createdAt: D("2026-09-15T12:00:00Z"),
    });
    await item("echo", p1.id, "echo", {
      stateId: id.sB,
      priority: "medium",
      dueDate: D("2026-09-30T00:00:00Z"),
      parentId: id.alpha,
      departmentId: id.front, // overrides the project's Clinical
      createdById: id.ana,
      createdAt: D("2026-09-20T12:00:00Z"),
      updatedAt: D("2026-10-03T00:00:00Z"), // EXACTLY midnight: a day boundary
    });
    await item("foxtrot", p1.id, "foxtrot", {
      stateId: id.sC,
      assignees: [id.cy],
      dueDate: D("2026-09-29T00:00:00Z"),
      createdAt: D("2026-09-25T12:00:00Z"),
    });
    await item("golf", p1.id, "golf", { stateId: id.sT, priority: "high", isArchived: true });
    await item("pct", p1.id, "100% done", { stateId: id.sT });
    await item("p1000", p1.id, "1000 done", { stateId: id.sT });
    await item("us", p1.id, "a_b item", { stateId: id.sT });
    await item("ax", p1.id, "axb item", { stateId: id.sT });
    await item("html", p1.id, "html", {
      stateId: id.sT,
      descriptionHtml: '<p class="note"><a href="http://x.example/strong">link</a></p>',
    });

    // ── P2: no department; one item overrides to a department, one to a team ──
    await item("hotel", p2.id, "hotel", {
      stateId: id.s2T,
      priority: "medium",
      assignees: [id.ana],
      dueDate: D("2026-10-10T00:00:00Z"),
      createdById: id.ana,
    });
    await item("india", p2.id, "india", {
      stateId: id.s2Done,
      priority: "low",
      departmentId: id.front,
      dueDate: D("2026-10-03T00:00:00Z"),
    });
    await item("juliet", p2.id, "juliet", { stateId: id.s2T, departmentId: id.hyg });

    // ── P3: an ARCHIVED project — its work is not "the workspace's work" ──
    await item("kilo", p3.id, "kilo", { stateId: id.s3T });

    await prisma.pmModuleWorkItem.create({ data: { moduleId: id.module, workItemId: id.alpha } });
  }

  // ── helpers ──
  const ME = () => id.ana;

  /** Every (field, op) a query below filtered on — see the last test. */
  const exercised = new Set<string>();

  async function run(filter: PmFilter | undefined, over: Partial<PmQueryRequest> = {}, userId: string | null = ME()): Promise<PmQueryResult> {
    if (filter) for (const c of pmFilterConditions(filter)) exercised.add(`${c.field}.${c.op}`);
    return queryWorkItems(
      prisma,
      { userId },
      { projectId: id.p1, filter, tz: "UTC", limit: 500, ...over },
      NOW,
    );
  }

  /** An item's display name without the namespace, and its fixture handle. */
  const short = (name: string) => name.slice(PREFIX.length);
  const handleOf = (rowId: string): string => Object.entries(id).find(([, v]) => v === rowId)![0];
  /** The fixture HANDLES (alpha, pct, …) of the rows a query returns, sorted. */
  async function names(filter: PmFilter | undefined, over: Partial<PmQueryRequest> = {}, userId: string | null = ME()): Promise<string[]> {
    const res = await run(filter, over, userId);
    return res.work_items.map((w) => handleOf(w.id)).sort();
  }
  const cross = { projectId: null as string | null, workspace: `${PREFIX}ws` };

  /** The P1 set with a few names removed — most "not" cases are "everyone except". */
  const P1_ALL = ["alpha", "ax", "bravo", "charlie", "delta", "echo", "foxtrot", "html", "pct", "p1000", "us"].sort();
  const except = (...gone: string[]) => P1_ALL.filter((n) => !gone.includes(n));
  /** The names the 'unassigned', 'unlabelled' … fillers share. */
  const FILLERS = ["ax", "html", "pct", "p1000", "us"];

  // ───────────────────────────────────────────────────────────────────────────

  describe("the default: archived items hidden, 'no filter' is everything", () => {
    it("returns every live item of the project and not the archived one", async () => {
      expect(await names(undefined)).toEqual(P1_ALL);
      expect(await names({ and: [] })).toEqual(P1_ALL);
    });

    it("isArchived is true / false", async () => {
      expect(await names(leaf("isArchived", "is", true))).toEqual(["golf"]);
      expect(await names(leaf("isArchived", "is", false))).toEqual(P1_ALL);
    });

    it("saying anything about isArchived lifts the default — an `or` can reach both", async () => {
      expect(
        await names({ or: [leaf("isArchived", "is", true), leaf("state", "is", id.sB)] }),
      ).toEqual(["echo", "golf"]);
    });
  });

  describe("state", () => {
    it("is / isNot / in / notIn — and the stateless item is NOT lost by the negations", async () => {
      expect(await names(leaf("state", "is", id.sT))).toEqual(["alpha", "ax", "html", "pct", "p1000", "us"].sort());
      expect(await names(leaf("state", "isNot", id.sT))).toEqual(["bravo", "charlie", "delta", "echo", "foxtrot"]);
      expect(await names(leaf("state", "in", [id.sT, id.sD]))).toEqual(["alpha", "ax", "bravo", "html", "pct", "p1000", "us"].sort());
      expect(await names(leaf("state", "notIn", [id.sT, id.sD]))).toEqual(["charlie", "delta", "echo", "foxtrot"]);
    });

    it("isEmpty / isNotEmpty", async () => {
      expect(await names(leaf("state", "isEmpty"))).toEqual(["delta"]);
      expect(await names(leaf("state", "isNotEmpty"))).toEqual(except("delta"));
    });
  });

  describe("stateGroup", () => {
    it("in / is → the state's group", async () => {
      expect(await names(leaf("stateGroup", "in", ["started", "unstarted"]))).toEqual(
        ["alpha", "ax", "bravo", "html", "pct", "p1000", "us"].sort(),
      );
      expect(await names(leaf("stateGroup", "is", "completed"))).toEqual(["charlie"]);
    });

    it("notIn / isNot → everything not in the group, the stateless item included", async () => {
      expect(await names(leaf("stateGroup", "notIn", ["completed", "cancelled"]))).toEqual(except("charlie", "foxtrot"));
      expect(await names(leaf("stateGroup", "isNot", "completed"))).toEqual(except("charlie"));
    });
  });

  describe("priority", () => {
    it("is / isNot / in / notIn", async () => {
      expect(await names(leaf("priority", "is", "high"))).toEqual(["alpha"]);
      expect(await names(leaf("priority", "isNot", "high"))).toEqual(except("alpha"));
      expect(await names(leaf("priority", "in", ["urgent", "high"]))).toEqual(["alpha", "bravo"]);
      expect(await names(leaf("priority", "notIn", ["none"]))).toEqual(["alpha", "bravo", "charlie", "echo"]);
    });
  });

  describe("assignee (me = ana)", () => {
    it("is / in — `me` resolves to the requester", async () => {
      expect(await names(leaf("assignee", "is", "me"))).toEqual(["alpha", "charlie"]);
      expect(await names(leaf("assignee", "is", id.ben))).toEqual(["bravo", "charlie"]);
      expect(await names(leaf("assignee", "in", ["me", id.cy]))).toEqual(["alpha", "charlie", "foxtrot"]);
    });

    it("`me` is whoever is asking", async () => {
      expect(await names(leaf("assignee", "is", "me"), {}, id.ben)).toEqual(["bravo", "charlie"]);
    });

    it("isNot / notIn → nobody in the set; an unassigned item qualifies", async () => {
      expect(await names(leaf("assignee", "isNot", "me"))).toEqual(except("alpha", "charlie"));
      expect(await names(leaf("assignee", "notIn", [id.ana, id.ben]))).toEqual(except("alpha", "bravo", "charlie"));
    });

    it("`none` / isEmpty → unassigned; isNot none / isNotEmpty → assigned", async () => {
      const unassigned = ["delta", "echo", ...FILLERS].sort();
      expect(await names(leaf("assignee", "is", "none"))).toEqual(unassigned);
      expect(await names(leaf("assignee", "isEmpty"))).toEqual(unassigned);
      expect(await names(leaf("assignee", "isNot", "none"))).toEqual(["alpha", "bravo", "charlie", "foxtrot"]);
      expect(await names(leaf("assignee", "isNotEmpty"))).toEqual(["alpha", "bravo", "charlie", "foxtrot"]);
    });

    it("`none` inside a list", async () => {
      expect(await names(leaf("assignee", "in", ["none", id.cy]))).toEqual(["delta", "echo", "foxtrot", ...FILLERS].sort());
      // Somebody is assigned AND nobody in {cy} is: alpha, bravo, charlie — foxtrot has cy.
      expect(await names(leaf("assignee", "notIn", ["none", id.cy]))).toEqual(["alpha", "bravo", "charlie"]);
    });
  });

  describe("label", () => {
    it("is / in / isNot / notIn / isEmpty / isNotEmpty", async () => {
      expect(await names(leaf("label", "is", id.lBug))).toEqual(["alpha", "bravo"]);
      expect(await names(leaf("label", "in", [id.lBug, id.lDocs]))).toEqual(["alpha", "bravo", "delta"]);
      expect(await names(leaf("label", "isNot", id.lBug))).toEqual(except("alpha", "bravo"));
      expect(await names(leaf("label", "notIn", [id.lBug, id.lDocs]))).toEqual(except("alpha", "bravo", "delta"));
      expect(await names(leaf("label", "isEmpty"))).toEqual(except("alpha", "bravo", "delta"));
      expect(await names(leaf("label", "isNotEmpty"))).toEqual(["alpha", "bravo", "delta"]);
    });
  });

  describe("cycle / module / parent", () => {
    it("cycle", async () => {
      expect(await names(leaf("cycle", "is", id.cycle))).toEqual(["alpha"]);
      expect(await names(leaf("cycle", "in", [id.cycle]))).toEqual(["alpha"]);
      expect(await names(leaf("cycle", "isNot", id.cycle))).toEqual(except("alpha"));
      expect(await names(leaf("cycle", "notIn", [id.cycle]))).toEqual(except("alpha"));
      expect(await names(leaf("cycle", "isEmpty"))).toEqual(except("alpha"));
      expect(await names(leaf("cycle", "isNotEmpty"))).toEqual(["alpha"]);
    });

    it("module (many-to-many)", async () => {
      expect(await names(leaf("module", "is", id.module))).toEqual(["alpha"]);
      expect(await names(leaf("module", "in", [id.module]))).toEqual(["alpha"]);
      expect(await names(leaf("module", "notIn", [id.module]))).toEqual(except("alpha"));
      expect(await names(leaf("module", "isNot", id.module))).toEqual(except("alpha"));
      expect(await names(leaf("module", "isEmpty"))).toEqual(except("alpha"));
      expect(await names(leaf("module", "isNotEmpty"))).toEqual(["alpha"]);
    });

    it("parent", async () => {
      expect(await names(leaf("parent", "is", id.alpha))).toEqual(["echo"]);
      expect(await names(leaf("parent", "in", [id.alpha]))).toEqual(["echo"]);
      expect(await names(leaf("parent", "notIn", [id.alpha]))).toEqual(except("echo"));
      expect(await names(leaf("parent", "isNot", id.alpha))).toEqual(except("echo"));
      expect(await names(leaf("parent", "isEmpty"))).toEqual(except("echo"));
      expect(await names(leaf("parent", "isNotEmpty"))).toEqual(["echo"]);
    });
  });

  describe("createdBy", () => {
    it("is / isNot / in / notIn / isEmpty / isNotEmpty (null creators = the assistant and imports)", async () => {
      expect(await names(leaf("createdBy", "is", "me"))).toEqual(["alpha", "echo"]);
      expect(await names(leaf("createdBy", "isNot", "me"))).toEqual(except("alpha", "echo"));
      expect(await names(leaf("createdBy", "in", [id.ben, id.cy]))).toEqual(["bravo", "delta"]);
      expect(await names(leaf("createdBy", "notIn", [id.ben, id.cy]))).toEqual(except("bravo", "delta"));
      expect(await names(leaf("createdBy", "isEmpty"))).toEqual(["charlie", "foxtrot", ...FILLERS].sort());
      expect(await names(leaf("createdBy", "isNotEmpty"))).toEqual(["alpha", "bravo", "delta", "echo"]);
    });
  });

  describe("project (workspace scope)", () => {
    it("is / isNot / in / notIn", async () => {
      const p2 = ["hotel", "india", "juliet"];
      expect(await names(leaf("project", "is", id.p2), cross)).toEqual(p2);
      expect(await names(leaf("project", "isNot", id.p1), cross)).toEqual(p2);
      expect(await names(leaf("project", "in", [id.p2]), cross)).toEqual(p2);
      expect(await names(leaf("project", "notIn", [id.p2]), cross)).toEqual(P1_ALL);
    });

    it("a workspace-wide query leaves out the archived project's items", async () => {
      expect(await names(undefined, cross)).toEqual([...P1_ALL, "hotel", "india", "juliet"].sort());
      // …while asking for that project by id is allowed: it is how Restore is reached.
      expect(await names(undefined, { projectId: id.p3 })).toEqual(["kilo"]);
    });
  });

  describe("department (override-or-inherit, workspace scope)", () => {
    const front = `${PREFIX}Front desk`;
    const clinical = `${PREFIX}Clinical`;
    const hygiene = `${PREFIX}Hygiene`;
    const EVERYTHING = [...P1_ALL, "hotel", "india", "juliet"].sort();
    const inClinical = [...except("echo"), "juliet"].sort();

    it("is → the item's own department, else its project's; a DEPARTMENT includes its TEAMs", async () => {
      expect(await names(leaf("department", "is", clinical), cross)).toEqual(inClinical);
      expect(await names(leaf("department", "is", front), cross)).toEqual(["echo", "india"]);
    });

    it("is a TEAM → only that team", async () => {
      expect(await names(leaf("department", "is", hygiene), cross)).toEqual(["juliet"]);
    });

    it("accepts an id and a slug as well as a name", async () => {
      expect(await names(leaf("department", "is", id.front), cross)).toEqual(["echo", "india"]);
      expect(await names(leaf("department", "is", `${PREFIX}front`), cross)).toEqual(["echo", "india"]);
      expect(await names(leaf("department", "is", front.toUpperCase()), cross)).toEqual(["echo", "india"]);
    });

    it("is none / isEmpty → owned by nobody (neither the item nor its project)", async () => {
      expect(await names(leaf("department", "is", "none"), cross)).toEqual(["hotel"]);
      expect(await names(leaf("department", "isEmpty"), cross)).toEqual(["hotel"]);
    });

    it("isNot → an effective department that is not in the scope; the item with none at all qualifies", async () => {
      expect(await names(leaf("department", "isNot", front), cross)).toEqual(EVERYTHING.filter((n) => n !== "echo" && n !== "india"));
      expect(await names(leaf("department", "isNot", clinical), cross)).toEqual(["echo", "hotel", "india"]);
    });

    it("isNotEmpty / isNot none → somebody owns it", async () => {
      const owned = EVERYTHING.filter((n) => n !== "hotel");
      expect(await names(leaf("department", "isNotEmpty"), cross)).toEqual(owned);
      expect(await names(leaf("department", "isNot", "none"), cross)).toEqual(owned);
    });

    it("lists, with `none` mixed in", async () => {
      expect(await names(leaf("department", "in", [front, "none"]), cross)).toEqual(["echo", "hotel", "india"]);
      expect(await names(leaf("department", "in", [front, hygiene]), cross)).toEqual(["echo", "india", "juliet"]);
      expect(await names(leaf("department", "notIn", [front, "none"]), cross)).toEqual(inClinical);
    });

    it("an inherited department filters a single project too", async () => {
      expect(await names(leaf("department", "is", clinical))).toEqual(except("echo"));
      expect(await names(leaf("department", "is", "none"))).toEqual([]);
    });
  });

  describe("dueDate / startDate (calendar dates, now = 2026-10-03 UTC)", () => {
    it("is", async () => {
      expect(await names(leaf("dueDate", "is", "today"))).toEqual(["bravo"]);
      expect(await names(leaf("dueDate", "is", "2026-10-02"))).toEqual(["alpha"]);
      expect(await names(leaf("dueDate", "is", "yesterday"))).toEqual(["alpha"]);
    });

    it("before / after are strict", async () => {
      expect(await names(leaf("dueDate", "before", "today"))).toEqual(["alpha", "echo", "foxtrot"]);
      expect(await names(leaf("dueDate", "after", "today"))).toEqual(["charlie"]);
      expect(await names(leaf("dueDate", "before", "2026-10-02"))).toEqual(["echo", "foxtrot"]);
      expect(await names(leaf("dueDate", "after", "2026-09-30"))).toEqual(["alpha", "bravo", "charlie"]);
    });

    it("between is inclusive at both ends", async () => {
      expect(await names(leaf("dueDate", "between", ["2026-09-30", "2026-10-03"]))).toEqual(["alpha", "bravo", "echo"]);
      expect(await names(leaf("dueDate", "between", ["-7d", "today"]))).toEqual(["alpha", "bravo", "echo", "foxtrot"]);
      expect(await names(leaf("dueDate", "between", ["today", "+2d"]))).toEqual(["bravo", "charlie"]);
    });

    it("isEmpty / isNotEmpty", async () => {
      expect(await names(leaf("dueDate", "isEmpty"))).toEqual(["delta", ...FILLERS].sort());
      expect(await names(leaf("dueDate", "isNotEmpty"))).toEqual(["alpha", "bravo", "charlie", "echo", "foxtrot"]);
    });

    it("startDate", async () => {
      expect(await names(leaf("startDate", "before", "today"))).toEqual(["alpha", "charlie"]);
      expect(await names(leaf("startDate", "after", "2026-09-20"))).toEqual(["charlie"]);
      expect(await names(leaf("startDate", "is", "2026-09-20"))).toEqual(["alpha"]);
      expect(await names(leaf("startDate", "between", ["2026-09-01", "2026-09-30"]))).toEqual(["alpha"]);
      expect(await names(leaf("startDate", "isEmpty"))).toEqual(except("alpha", "charlie"));
      expect(await names(leaf("startDate", "isNotEmpty"))).toEqual(["alpha", "charlie"]);
    });

    it("`today` is the VIEWER's today: 12:00Z on Oct 3 is already Oct 4 in Auckland", async () => {
      expect(await names(leaf("dueDate", "is", "today"), { tz: "Pacific/Auckland" })).toEqual([]);
      expect(await names(leaf("dueDate", "before", "today"), { tz: "Pacific/Auckland" })).toEqual([
        "alpha",
        "bravo",
        "echo",
        "foxtrot",
      ]);
    });

    it("the overdue built-in: open and due before today — a done or cancelled item is not overdue", async () => {
      const overdue: PmFilter = {
        and: [leaf("dueDate", "before", "today"), leaf("stateGroup", "notIn", ["completed", "cancelled"])],
      };
      expect(await names(overdue)).toEqual(["alpha", "echo"]);
    });
  });

  describe("createdAt / updatedAt (instants: the viewer's local day)", () => {
    it("is — the same two items fall on different local days in different zones", async () => {
      expect(await names(leaf("createdAt", "is", "2026-10-03"), { tz: "UTC" })).toEqual(["bravo"]);
      // Auckland is UTC+13 in October: Oct 3 there is [Oct 2 11:00Z, Oct 3 11:00Z).
      expect(await names(leaf("createdAt", "is", "2026-10-03"), { tz: "Pacific/Auckland" })).toEqual(["bravo", "charlie"]);
      // Los Angeles is UTC-7: Oct 3 there starts at 07:00Z, after bravo's 06:30Z.
      expect(await names(leaf("createdAt", "is", "2026-10-03"), { tz: "America/Los_Angeles" })).toEqual([]);
      expect(await names(leaf("createdAt", "is", "2026-10-02"), { tz: "America/Los_Angeles" })).toEqual(["bravo", "charlie"]);
    });

    it("before / after / between", async () => {
      expect(await names(leaf("createdAt", "between", ["2026-09-15", "2026-09-25"]))).toEqual(["delta", "echo", "foxtrot"]);
      expect(await names(leaf("createdAt", "after", "2026-10-02"))).toEqual(["bravo"]);
      expect(await names(leaf("createdAt", "before", "2026-09-02"))).toEqual(["alpha", ...FILLERS].sort());
    });

    it("midnight belongs to the day it starts: echo (updated at exactly 00:00Z)", async () => {
      expect(await names(leaf("updatedAt", "is", "2026-10-03"))).toEqual(["bravo", "echo"]);
      expect(await names(leaf("updatedAt", "before", "2026-10-03"))).toEqual(except("bravo", "echo"));
      expect(await names(leaf("updatedAt", "after", "2026-10-02"))).toEqual(["bravo", "echo"]);
    });

    it("'last 7 days' is whole local days back from today", async () => {
      expect(await names(leaf("updatedAt", "between", ["-7d", "today"]))).toEqual(["bravo", "charlie", "echo"]);
    });
  });

  describe("text", () => {
    it("searches the name, case-insensitively", async () => {
      expect(await names(leaf("text", "contains", "ALPHA"))).toEqual(["alpha"]);
      expect(await names(leaf("text", "contains", "item"))).toEqual(["ax", "us"]);
    });

    it("searches the description's TEXT — what a person typed, not the markup around it", async () => {
      expect(await names(leaf("text", "contains", "login"))).toEqual(["alpha"]);
      expect(await names(leaf("text", "contains", "LOGIN FLOW"))).toEqual(["alpha"]);
      expect(await names(leaf("text", "contains", "link"))).toEqual(["html"]);
    });

    it("does NOT match tag or attribute names (an ILIKE over the raw HTML would)", async () => {
      expect(await names(leaf("text", "contains", "strong"))).toEqual([]);
      expect(await names(leaf("text", "contains", "class"))).toEqual([]);
      expect(await names(leaf("text", "contains", "href"))).toEqual([]);
      expect(await names(leaf("text", "contains", "x.example"))).toEqual([]);
    });

    it("decodes the entities the sanitizer writes", async () => {
      expect(await names(leaf("text", "contains", "R&D"))).toEqual(["bravo"]);
    });

    it("treats % and _ as the characters they are, not as wildcards", async () => {
      expect(await names(leaf("text", "contains", "100%"))).toEqual(["pct"]);
      expect(await names(leaf("text", "contains", "a_b"))).toEqual(["us"]);
    });

    it("finds an item by its key", async () => {
      expect(await names(leaf("text", "contains", "w6a-1"))).toEqual(["alpha"]);
      expect(await names(leaf("text", "contains", "W6A-2"))).toEqual(["bravo"]);
      expect(await names(leaf("text", "contains", "W6B-1"))).toEqual([]); // that is another project's number
      expect(await names(leaf("text", "contains", "W6B-1"), cross)).toEqual(["hotel"]);
    });
  });

  describe("groups and nesting", () => {
    it("and / or / nested", async () => {
      expect(
        await names({
          and: [
            leaf("stateGroup", "in", ["unstarted", "started"]),
            { or: [leaf("priority", "is", "urgent"), leaf("assignee", "is", "me")] },
          ],
        }),
      ).toEqual(["alpha", "bravo"]);
      expect(await names({ or: [leaf("priority", "is", "high"), leaf("state", "isEmpty")] })).toEqual(["alpha", "delta"]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  describe("the description projection (trigger)", () => {
    // A scratch row in the ARCHIVED project, deleted afterwards: these tests
    // WRITE, and a write through Prisma stamps updatedAt — which would reorder
    // every fixture row the sorting tests depend on if it touched one.
    async function withScratch(html: string | null, fn: (rowId: string) => Promise<void>) {
      const row = await prisma.pmWorkItem.create({
        data: { projectId: id.p3, sequenceId: 900, name: `${PREFIX}scratch`, descriptionHtml: html },
      });
      try {
        await fn(row.id);
      } finally {
        await prisma.pmWorkItem.delete({ where: { id: row.id } });
      }
    }

    it("is filled on insert and refreshed when the description changes", async () => {
      await withScratch("<p>Fix the <strong>login</strong> flow</p>", async (rowId) => {
        const row = await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: rowId } });
        expect(row.descriptionText).toBe("Fix the login flow");

        const upd = await prisma.pmWorkItem.update({
          where: { id: rowId },
          data: { descriptionHtml: "<ul><li>one</li><li>two &amp; three</li></ul>" },
        });
        expect(upd.descriptionText).toBe("one two & three");

        const cleared = await prisma.pmWorkItem.update({ where: { id: rowId }, data: { descriptionHtml: null } });
        expect(cleared.descriptionText).toBeNull();

        const back = await prisma.pmWorkItem.update({
          where: { id: rowId },
          data: { descriptionHtml: "<p>Fix the <strong>login</strong> flow</p>" },
        });
        expect(back.descriptionText).toBe("Fix the login flow");
      });
    });

    it("is NULL for a description with no text in it, and cannot be set by hand", async () => {
      await withScratch(null, async (rowId) => {
        const empty = await prisma.pmWorkItem.update({ where: { id: rowId }, data: { descriptionHtml: "<p></p>" } });
        expect(empty.descriptionText).toBeNull();
        // A writer that names descriptionText is overruled by the trigger.
        const forced = await prisma.pmWorkItem.update({
          where: { id: rowId },
          data: { descriptionHtml: "<p>real</p>", descriptionText: "forged" },
        });
        expect(forced.descriptionText).toBe("real");
      });
    });

    it("does not recompute when a statement does not set the description", async () => {
      await withScratch("<p>kept</p>", async (rowId) => {
        // Written behind the trigger's back (it is UPDATE OF "descriptionHtml").
        await prisma.$executeRawUnsafe(`UPDATE "PmWorkItem" SET "descriptionText" = 'sentinel' WHERE id = '${rowId}'`);
        await prisma.pmWorkItem.update({ where: { id: rowId }, data: { name: `${PREFIX}scratch-renamed` } });
        const row = await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: rowId } });
        expect(row.descriptionText).toBe("sentinel");
      });
    });

    it("has trigram indexes on name and descriptionText that the planner can use", async () => {
      const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'PmWorkItem' AND indexname IN ('PmWorkItem_name_idx', 'PmWorkItem_descriptionText_idx')`,
      );
      expect(idx.map((r) => r.indexname).sort()).toEqual(["PmWorkItem_descriptionText_idx", "PmWorkItem_name_idx"]);
      for (const r of idx) expect(r.indexdef).toMatch(/USING gin .*gin_trgm_ops/i);

      // A seq scan is the right plan for a table this small; forbid it to prove
      // the index COULD serve the predicate the compiler emits.
      const plans = await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`),
        prisma.$queryRawUnsafe<Array<Record<string, string>>>(
          `EXPLAIN SELECT id FROM "PmWorkItem" WHERE name ILIKE '%login%' OR "descriptionText" ILIKE '%login%'`,
        ),
      ]);
      const text = (plans[1] as Array<Record<string, string>>).map((r) => Object.values(r)[0]).join("\n");
      expect(text).toMatch(/PmWorkItem_name_idx/);
      expect(text).toMatch(/PmWorkItem_descriptionText_idx/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────

  describe("paging (offset cursor)", () => {
    it("walks the whole result set: no repeat, no gap, an exact total, a final null cursor", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let total = -1;
      do {
        const res: PmQueryResult = await run(undefined, { limit: 4, cursor });
        pages += 1;
        total = res.total;
        seen.push(...res.work_items.map((w) => handleOf(w.id)));
        cursor = res.nextCursor;
        expect(res.work_items.length).toBeLessThanOrEqual(4);
      } while (cursor && pages < 10);
      expect(total).toBe(P1_ALL.length);
      expect(pages).toBe(Math.ceil(P1_ALL.length / 4));
      expect([...seen].sort()).toEqual(P1_ALL);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("the last page has no cursor even when it is exactly full", async () => {
      const res = await run(undefined, { limit: P1_ALL.length });
      expect(res.work_items).toHaveLength(P1_ALL.length);
      expect(res.nextCursor).toBeNull();
    });

    it("limit 0 returns no rows — only the counts", async () => {
      const res = await run(undefined, { limit: 0, counts: { mine: leaf("assignee", "is", "me") } });
      expect(res.work_items).toEqual([]);
      expect(res.nextCursor).toBeNull();
      expect(res.total).toBe(P1_ALL.length);
      expect(res.counts).toEqual({ mine: 2 });
    });

    it("refuses a cursor from a different query", async () => {
      const first = await run(undefined, { limit: 2 });
      await expect(run(leaf("priority", "is", "high"), { limit: 2, cursor: first.nextCursor })).rejects.toThrow("invalid_cursor");
      await expect(run(undefined, { limit: 2, cursor: first.nextCursor, tz: "Pacific/Auckland" })).rejects.toThrow("invalid_cursor");
      await expect(run(undefined, { limit: 2, cursor: first.nextCursor, sort: [{ field: "name", dir: "asc" }] })).rejects.toThrow(
        "invalid_cursor",
      );
    });
  });

  describe("sorting", () => {
    const order = async (sort: PmSortSpec[], over: Partial<PmQueryRequest> = {}, filter?: PmFilter) =>
      (await run(filter, { sort, ...over })).work_items.map((w) => short(w.name));

    it("the project default is its manual order (sortOrder, then number)", async () => {
      expect(await order([{ field: "sortOrder", dir: "asc" }])).toEqual([
        "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "100% done", "1000 done", "a_b item", "axb item", "html",
      ]);
      expect((await run(undefined)).work_items.map((w) => short(w.name))).toEqual(
        (await order([{ field: "sortOrder", dir: "asc" }])),
      );
      expect((await order([{ field: "sortOrder", dir: "desc" }]))[0]).toBe("html");
    });

    it("a date puts the items with none LAST, ascending or descending", async () => {
      const asc = await order([{ field: "dueDate", dir: "asc" }]);
      expect(asc.slice(0, 5)).toEqual(["foxtrot", "echo", "alpha", "bravo", "charlie"]);
      const desc = await order([{ field: "dueDate", dir: "desc" }]);
      expect(desc.slice(0, 5)).toEqual(["charlie", "bravo", "alpha", "echo", "foxtrot"]);
      // The six with no due date trail, in manual order, in both directions.
      const rest = ["delta", "100% done", "1000 done", "a_b item", "axb item", "html"];
      expect(asc.slice(5)).toEqual(rest);
      expect(desc.slice(5)).toEqual(rest);
    });

    it("priority follows the enum's order: urgent first when ascending", async () => {
      const asc = await order([{ field: "priority", dir: "asc" }]);
      expect(asc.slice(0, 4)).toEqual(["bravo", "alpha", "echo", "charlie"]);
      const desc = await order([{ field: "priority", dir: "desc" }]);
      expect(desc.slice(-4)).toEqual(["charlie", "echo", "alpha", "bravo"]);
    });

    it("state orders by the column's position, then name", async () => {
      const asc = await order([{ field: "state", dir: "asc" }]);
      // Backlog(0) echo · Todo(1) alpha + fillers · Doing(2) bravo · Done(3) charlie · Cancelled(4) foxtrot · none: delta
      expect(asc[0]).toBe("echo");
      expect(asc.indexOf("alpha")).toBeLessThan(asc.indexOf("bravo"));
      expect(asc.indexOf("bravo")).toBeLessThan(asc.indexOf("charlie"));
      expect(asc.indexOf("charlie")).toBeLessThan(asc.indexOf("foxtrot"));
    });

    it("key orders by project identifier, then number", async () => {
      const res = await run(undefined, { ...cross, sort: [{ field: "key", dir: "asc" }] });
      const keys = res.work_items.map((w) => w.key);
      expect(keys.slice(0, 3)).toEqual(["W6A-1", "W6A-2", "W6A-3"]);
      expect(keys.slice(-3)).toEqual(["W6B-1", "W6B-2", "W6B-3"]);
    });

    it("name, createdAt, updatedAt, startDate", async () => {
      // Compared by names that differ in their first letter: how "100% done" and
      // "1000 done" order depends on the database's collation, and is not ours to pin.
      const byName = await order([{ field: "name", dir: "asc" }]);
      expect(byName.indexOf("alpha")).toBeLessThan(byName.indexOf("bravo"));
      expect(byName.indexOf("bravo")).toBeLessThan(byName.indexOf("charlie"));
      const byNameDesc = await order([{ field: "name", dir: "desc" }]);
      expect(byNameDesc.indexOf("charlie")).toBeLessThan(byNameDesc.indexOf("bravo"));
      expect((await order([{ field: "createdAt", dir: "desc" }]))[0]).toBe("bravo");
      expect((await order([{ field: "updatedAt", dir: "desc" }]))[0]).toBe("bravo");
      expect((await order([{ field: "startDate", dir: "asc" }])).slice(0, 2)).toEqual(["alpha", "charlie"]);
    });

    it("a compound sort breaks ties with the next key, and is total (ties never reorder between pages)", async () => {
      const full = await order([
        { field: "priority", dir: "asc" },
        { field: "name", dir: "asc" },
      ]);
      const pages: string[] = [];
      let cursor: string | null = null;
      do {
        const res: PmQueryResult = await run(undefined, {
          sort: [
            { field: "priority", dir: "asc" },
            { field: "name", dir: "asc" },
          ],
          limit: 3,
          cursor,
        });
        pages.push(...res.work_items.map((w) => short(w.name)));
        cursor = res.nextCursor;
      } while (cursor);
      expect(pages).toEqual(full);
    });

    it("a workspace query defaults to the newest change first", async () => {
      const res = await run(undefined, cross);
      expect(res.work_items[0].name).toBe(`${PREFIX}bravo`);
    });
  });

  describe("counts (the saved-view chips)", () => {
    it("one number per named filter, for the whole scope and not the page", async () => {
      const res = await run(undefined, {
        limit: 2,
        counts: {
          all: { and: [] },
          mine: leaf("assignee", "is", "me"),
          active: leaf("stateGroup", "in", ["backlog", "unstarted", "started"]),
          overdue: { and: [leaf("dueDate", "before", "today"), leaf("stateGroup", "notIn", ["completed", "cancelled"])] },
          noassignee: leaf("assignee", "isEmpty"),
          archived: leaf("isArchived", "is", true),
        },
      });
      expect(res.counts).toEqual({ all: 11, mine: 2, active: 8, overdue: 2, noassignee: 7, archived: 1 });
      expect(res.work_items).toHaveLength(2);
      expect(res.total).toBe(11);
    });

    it("a count's filter is not narrowed by the request's own filter", async () => {
      const res = await run(leaf("priority", "is", "high"), { counts: { all: { and: [] } } });
      expect(res.total).toBe(1);
      expect(res.counts).toEqual({ all: 11 });
    });
  });

  describe("groupBy (exact counts over the whole result)", () => {
    const groups = async (groupBy: PmGroupByField, over: Partial<PmQueryRequest> = {}, filter?: PmFilter) =>
      Object.fromEntries(
        ((await run(filter, { groupBy, limit: 1, ...over })).groups ?? []).map((g) => [g.key ?? "none", g.count]),
      );

    it("state", async () => {
      expect(await groups("state")).toEqual({ [id.sB]: 1, [id.sT]: 6, [id.sD]: 1, [id.sDone]: 1, [id.sC]: 1, none: 1 });
    });

    it("stateGroup folds the states into what they mean", async () => {
      expect(await groups("stateGroup")).toEqual({ backlog: 1, unstarted: 6, started: 1, completed: 1, cancelled: 1, none: 1 });
    });

    it("priority", async () => {
      expect(await groups("priority")).toEqual({ high: 1, urgent: 1, low: 1, medium: 1, none: 7 });
    });

    it("assignee counts an item once per assignee and the unassigned under none", async () => {
      expect(await groups("assignee")).toEqual({ [id.ana]: 2, [id.ben]: 2, [id.cy]: 1, none: 7 });
    });

    it("label / module / cycle", async () => {
      expect(await groups("label")).toEqual({ [id.lBug]: 2, [id.lDocs]: 2, none: 8 });
      expect(await groups("module")).toEqual({ [id.module]: 1, none: 10 });
      expect(await groups("cycle")).toEqual({ [id.cycle]: 1, none: 10 });
    });

    it("department resolves the override-or-inherit rule", async () => {
      expect(await groups("department", cross)).toEqual({
        [id.clin]: 10, // the ten P1 items that do not override
        [id.front]: 2, // echo (override) + india
        [id.hyg]: 1, // juliet
        none: 1, // hotel
      });
    });

    it("project", async () => {
      expect(await groups("project", cross)).toEqual({ [id.p1]: 11, [id.p2]: 3 });
    });

    it("is computed over the filtered set", async () => {
      expect(await groups("priority", {}, leaf("assignee", "is", "me"))).toEqual({ high: 1, low: 1 });
    });
  });

  describe("stale references (brief §3.9)", () => {
    const ghost = "00000000-0000-4000-8000-000000000000";

    it("drops a deleted label, still answers, and says what it dropped", async () => {
      const res = await run(leaf("label", "in", [id.lBug, ghost]));
      expect(res.work_items.map((w) => short(w.name)).sort()).toEqual(["alpha", "bravo"]);
      expect(res.stale).toEqual([{ field: "label", value: ghost }]);
      expect(res.filter).toEqual(leaf("label", "in", [id.lBug]));
    });

    it("never turns a view whose every reference is gone into an empty board", async () => {
      const res = await run({ and: [leaf("label", "is", ghost), leaf("assignee", "is", ghost)] });
      expect(res.total).toBe(P1_ALL.length);
      expect(res.stale).toHaveLength(2);
      expect(res.filter).toEqual({ and: [] });
    });

    it("an unknown department is stale too, not an error", async () => {
      const res = await run(leaf("department", "is", `${PREFIX}Ghost`));
      expect(res.total).toBe(P1_ALL.length);
      expect(res.stale).toEqual([{ field: "department", value: `${PREFIX}Ghost` }]);
    });

    it("reports nothing when nothing is stale", async () => {
      const res = await run(leaf("label", "in", [id.lBug]));
      expect(res.stale).toBeUndefined();
      expect(res.filter).toBeUndefined();
    });
  });

  describe("errors", () => {
    it("an unknown project is project_not_found", async () => {
      await expect(run(undefined, { projectId: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow("project_not_found");
    });

    it("`me` without a person is me_unavailable", async () => {
      await expect(run(leaf("assignee", "is", "me"), {}, null)).rejects.toThrow("me_unavailable");
    });

    it("a zone that is not one is invalid_timezone", async () => {
      await expect(run(undefined, { tz: "Mars/Olympus" })).rejects.toThrow("invalid_timezone");
    });
  });

  describe("findWorkItemByKey", () => {
    it("finds an item by its key, case-insensitively, archived items included", async () => {
      expect((await findWorkItemByKey(prisma, "W6A-1", wsSlug)).id).toBe(id.alpha);
      expect((await findWorkItemByKey(prisma, "w6a-2", wsSlug)).id).toBe(id.bravo);
      expect((await findWorkItemByKey(prisma, "W6A-7", wsSlug)).id).toBe(id.golf); // archived
      expect((await findWorkItemByKey(prisma, "W6C-1", wsSlug)).id).toBe(id.kilo); // archived project
    });

    it("answers one thing for a bad key, an unknown project and an unknown number", async () => {
      for (const k of ["nonsense", "W6A-999", "ZZZ-1", "W6A-", ""]) {
        await expect(findWorkItemByKey(prisma, k, wsSlug)).rejects.toThrow("work_item_not_found");
      }
    });

    it("does not cross workspaces", async () => {
      await expect(findWorkItemByKey(prisma, "W6A-1", "home")).rejects.toThrow("work_item_not_found");
    });
  });

  // After every case that filters, on purpose (a file's tests run in order): the
  // AC is "every DSL op has a pg test", and the field table is where ops are
  // added. A new field or op with no case above fails HERE, by name, instead of
  // shipping unproven.
  describe("coverage", () => {
    it("has run every op of every field of the grammar against Postgres", () => {
      const missing: string[] = [];
      for (const [field, spec] of Object.entries(PM_FILTER_FIELDS)) {
        for (const op of spec.ops) if (!exercised.has(`${field}.${op}`)) missing.push(`${field}.${op}`);
      }
      expect(missing).toEqual([]);
    });
  });

  describe("the response shape", () => {
    it("returns the same work-item shape as every other read, with the key and the effective department", async () => {
      const res = await run(leaf("text", "contains", "echo"));
      expect(res.work_items).toHaveLength(1);
      const w = res.work_items[0];
      expect(w.key).toBe("W6A-5");
      expect(w.department).toMatchObject({ id: id.front, source: "item" });
      expect(w.descriptionHtml).toBeNull();
      expect(w).not.toHaveProperty("descriptionText");
      expect(w.state?.name).toBe("Backlog");
      expect(w.parentId).toBe(id.alpha);
    });
  });
});
