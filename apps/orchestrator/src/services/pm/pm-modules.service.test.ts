/**
 * WARP-3521 — pm-modules.service unit cover.
 *
 * The fake models the database behaviours the service leans on: the unique
 * (moduleId, workItemId) pair, ON DELETE CASCADE from module to its links, and
 * transaction atomicity through the shared seam (WARP-1570). The same-project
 * trigger and the CHECK are real-Postgres facts — pm-cycles-modules.pg.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
} from "../../__tests__/helpers/prisma-tx-harness.js";
import * as pmService from "./pm.service.js";
import {
  addModuleWorkItems,
  createModule,
  deleteModule,
  getModule,
  listModuleWorkItems,
  listModules,
  listModulesForWorkItem,
  removeModuleWorkItems,
  updateModule,
} from "./pm-modules.service.js";

vi.mock("./pm.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pm.service.js")>();
  return { ...actual, listWorkItemsWhere: vi.fn() };
});

type Row = Record<string, unknown>;

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

function prismaError(code: string): Error & { code: string } {
  const e = new Error(`Prisma ${code}`) as Error & { code: string };
  e.name = "PrismaClientKnownRequestError";
  e.code = code;
  return e;
}

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface ModuleRow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  leadId: string | null;
  status: string;
  startDate: Date | null;
  targetDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface LinkRow {
  id: string;
  moduleId: string;
  workItemId: string;
}
interface ItemRow {
  id: string;
  projectId: string;
  isArchived: boolean;
  estimate: number | null;
  stateId: string | null;
  project: { kind: "PROJECT" };
}
interface ActRow {
  workItemId: string;
  actorId: string | null;
  verb: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
}

function makeFake() {
  const projects = [{ id: "p1" }, { id: "p2" }];
  const states = [
    { id: "s-todo", group: "unstarted" },
    { id: "s-done", group: "completed" },
    { id: "s-cancelled", group: "cancelled" },
  ];
  const users: Array<{ id: string; role: string }> = [
    { id: "u-member", role: "family" },
    { id: "u-guest", role: "guest" },
  ];
  const modules: ModuleRow[] = [];
  const links: LinkRow[] = [];
  const items: ItemRow[] = [];
  const activity: ActRow[] = [];
  const calls: string[] = [];

  const addModule = (over: Partial<ModuleRow> = {}): ModuleRow => {
    const row: ModuleRow = {
      id: uid("mo"),
      projectId: "p1",
      name: "Epic",
      description: null,
      leadId: null,
      status: "backlog",
      startDate: null,
      targetDate: null,
      createdAt: new Date(2026, 9, 1, 0, 0, seq),
      updatedAt: new Date(2026, 9, 1),
      ...over,
    };
    modules.push(row);
    return row;
  };
  const addItem = (over: Partial<ItemRow> = {}): ItemRow => {
    const row: ItemRow = {
      id: uid("wi"),
      projectId: "p1",
      isArchived: false,
      estimate: null,
      stateId: "s-todo",
      project: { kind: "PROJECT" },
      ...over,
    };
    items.push(row);
    return row;
  };
  const link = (moduleId: string, workItemId: string) => {
    links.push({ id: uid("ln"), moduleId, workItemId });
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const o = v as { in?: unknown[]; not?: unknown };
        if (o.in) return o.in.includes(row[k]);
        if ("not" in o) return row[k] !== o.not;
        return row[k] !== null && typeof row[k] === "object" && matches(row[k] as Row, v as Row);
      }
      return row[k] === v;
    });

  const self: Record<string, unknown> = {
    pmProject: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        projects.find((p) => p.id === where.id) ?? null,
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((u) => u.id === where.id) ?? null,
    },

    pmModule: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const m = modules.find((x) => x.id === where.id);
        return m ? { ...m } : null;
      },
      findMany: async ({ where }: { where: Row }) =>
        modules.filter((m) => matches(m as unknown as Row, where)).map((m) => ({ ...m })),
      create: async ({ data }: { data: Partial<ModuleRow> }) => {
        const row = {
          id: uid("mo"),
          description: null,
          leadId: null,
          status: "backlog",
          startDate: null,
          targetDate: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as ModuleRow;
        modules.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<ModuleRow> }) => {
        const m = modules.find((x) => x.id === where.id);
        if (!m) throw prismaError("P2025");
        Object.assign(m, data, { updatedAt: new Date() });
        return { ...m };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        calls.push("pmModule.delete");
        const i = modules.findIndex((x) => x.id === where.id);
        if (i < 0) throw prismaError("P2025");
        const [gone] = modules.splice(i, 1);
        for (let j = links.length - 1; j >= 0; j -= 1) if (links[j].moduleId === gone.id) links.splice(j, 1); // CASCADE
        return { ...gone };
      },
    },

    pmModuleWorkItem: {
      findMany: async ({ where, select }: { where: Row; select?: Row }) => {
        const inItemWhere = where.workItem as { isArchived?: boolean } | undefined;
        return links
          .filter((l) => {
            const base = { moduleId: l.moduleId, workItemId: l.workItemId } as Row;
            const { workItem: _w, ...rest } = where;
            void _w;
            if (!matches(base, rest)) return false;
            if (inItemWhere?.isArchived === false) {
              const it = items.find((i) => i.id === l.workItemId);
              if (!it || it.isArchived) return false;
            }
            return true;
          })
          .map((l) => {
            const it = items.find((i) => i.id === l.workItemId)!;
            const m = modules.find((x) => x.id === l.moduleId)!;
            return {
              ...l,
              workItem: { estimate: it?.estimate ?? null, state: it?.stateId ? { group: states.find((s) => s.id === it.stateId)?.group ?? null } : null },
              module: select ? { id: m.id, name: m.name, status: m.status } : m,
            };
          });
      },
      createMany: async ({ data }: { data: Array<{ moduleId: string; workItemId: string }> }) => {
        calls.push("pmModuleWorkItem.createMany");
        for (const r of data) {
          if (links.some((l) => l.moduleId === r.moduleId && l.workItemId === r.workItemId)) throw prismaError("P2002");
        }
        for (const r of data) links.push({ id: uid("ln"), ...r });
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        calls.push("pmModuleWorkItem.deleteMany");
        let n = 0;
        for (let j = links.length - 1; j >= 0; j -= 1) {
          if (matches(links[j] as unknown as Row, where)) {
            links.splice(j, 1);
            n += 1;
          }
        }
        return { count: n };
      },
    },

    pmWorkItem: {
      findUnique: async ({ where }: { where: { id: string } }) => items.find((i) => i.id === where.id) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        items.filter((i) => matches(i as unknown as Row, where)).map((i) => ({ ...i })),
    },

    pmActivity: {
      createMany: async ({ data }: { data: ActRow[] }) => {
        calls.push("pmActivity.createMany");
        for (const r of data) activity.push({ ...r });
        return { count: data.length };
      },
    },
  };

  const seam = createTransactionSeam({ client: () => self, stores: { modules, links, activity } });
  self.$transaction = seam.$transaction;

  return { prisma: self as never, modules, links, items, activity, calls, seam, addModule, addItem, link };
}

beforeEach(() => {
  seq = 0;
  vi.mocked(pmService.listWorkItemsWhere).mockReset();
});

describe("createModule", () => {
  it("creates a module in the backlog status with null optionals and empty progress", async () => {
    const f = makeFake();
    const m = await createModule(f.prisma, "p1", { name: "Launch" });
    expect(m).toMatchObject({
      projectId: "p1",
      name: "Launch",
      description: null,
      leadId: null,
      status: "backlog",
      startDate: null,
      targetDate: null,
    });
    expect(m.progress.total).toBe(0);
  });

  it("takes a lead, a status and calendar dates (answered as YYYY-MM-DD)", async () => {
    const f = makeFake();
    const m = await createModule(f.prisma, "p1", {
      name: "Launch",
      description: "Go live",
      leadId: "u-member",
      status: "in_progress",
      startDate: d("2026-10-05"),
      targetDate: d("2026-12-01"),
    });
    expect(m).toMatchObject({
      leadId: "u-member",
      status: "in_progress",
      startDate: "2026-10-05",
      targetDate: "2026-12-01",
    });
  });

  it("an external guest cannot lead a module (same rule as a project)", async () => {
    const f = makeFake();
    await expect(createModule(f.prisma, "p1", { name: "x", leadId: "u-guest" })).rejects.toThrow("lead_is_guest");
    expect(f.modules).toHaveLength(0);
  });

  it("target before start is invalid_dates", async () => {
    const f = makeFake();
    const err = await createModule(f.prisma, "p1", {
      name: "x",
      startDate: d("2026-12-01"),
      targetDate: d("2026-10-05"),
    }).catch((e) => e);
    expect(err.message).toBe("invalid_dates");
    expect(err.details).toMatchObject({ reason: "target_before_start" });
  });

  it("project_not_found", async () => {
    const f = makeFake();
    await expect(createModule(f.prisma, "nope", { name: "x" })).rejects.toThrow("project_not_found");
  });
});

describe("updateModule", () => {
  it("changes only what it is given; null clears", async () => {
    const f = makeFake();
    const m = f.addModule({ name: "Old", description: "keep", leadId: "u-member", status: "planned" });
    const out = await updateModule(f.prisma, m.id, { name: "New", leadId: null });
    expect(out).toMatchObject({ name: "New", description: "keep", leadId: null, status: "planned" });
  });

  it("validates the MERGED dates", async () => {
    const f = makeFake();
    const m = f.addModule({ startDate: d("2026-10-05"), targetDate: d("2026-12-01") });
    await expect(updateModule(f.prisma, m.id, { targetDate: d("2026-09-01") })).rejects.toThrow("invalid_dates");
  });

  it("refuses a guest lead and an unknown module", async () => {
    const f = makeFake();
    const m = f.addModule();
    await expect(updateModule(f.prisma, m.id, { leadId: "u-guest" })).rejects.toThrow("lead_is_guest");
    await expect(updateModule(f.prisma, "nope", { name: "x" })).rejects.toThrow("module_not_found");
  });
});

describe("deleteModule", () => {
  it("audits every member with module_removed BEFORE the cascade takes the links", async () => {
    const f = makeFake();
    const m = f.addModule();
    const a = f.addItem();
    const b = f.addItem();
    f.link(m.id, a.id);
    f.link(m.id, b.id);

    await deleteModule(f.prisma, "u1", m.id);

    expect(f.modules).toHaveLength(0);
    expect(f.links).toHaveLength(0);
    expect(f.activity.map((r) => r.workItemId).sort()).toEqual([a.id, b.id].sort());
    for (const r of f.activity) {
      expect(r).toMatchObject({ actorId: "u1", verb: "module_removed", field: "module", oldValue: m.id, newValue: null });
    }
    expect(f.calls.indexOf("pmActivity.createMany")).toBeLessThan(f.calls.indexOf("pmModule.delete"));
    expectAllTransactionsAt(f.seam, SERIALIZABLE_TX);
  });

  it("module_not_found", async () => {
    const f = makeFake();
    await expect(deleteModule(f.prisma, "u1", "nope")).rejects.toThrow("module_not_found");
  });
});

describe("addModuleWorkItems", () => {
  it("links the items and writes one module_added row per NEW link", async () => {
    const f = makeFake();
    const m = f.addModule();
    const a = f.addItem();
    const b = f.addItem();
    const out = await addModuleWorkItems(f.prisma, "u1", m.id, [a.id, b.id]);
    expect(out.added).toBe(2);
    expect(out.module.progress.total).toBe(2);
    expect(f.links.map((l) => l.workItemId).sort()).toEqual([a.id, b.id].sort());
    expect(f.activity).toHaveLength(2);
    for (const r of f.activity) {
      expect(r).toMatchObject({ actorId: "u1", verb: "module_added", field: "module", oldValue: null, newValue: m.id });
    }
    expectAllTransactionsAt(f.seam, SERIALIZABLE_TX);
  });

  it("is idempotent: an item already in the module is skipped and NOT audited again", async () => {
    const f = makeFake();
    const m = f.addModule();
    const a = f.addItem();
    const b = f.addItem();
    f.link(m.id, a.id);
    const out = await addModuleWorkItems(f.prisma, "u1", m.id, [a.id, b.id]);
    expect(out.added).toBe(1);
    expect(f.links).toHaveLength(2);
    expect(f.activity.map((r) => r.workItemId)).toEqual([b.id]);
  });

  it("duplicates in the request count once", async () => {
    const f = makeFake();
    const m = f.addModule();
    const a = f.addItem();
    const out = await addModuleWorkItems(f.prisma, "u1", m.id, [a.id, a.id]);
    expect(out.added).toBe(1);
  });

  it("an item of ANOTHER project is invalid_work_item and nothing is linked", async () => {
    const f = makeFake();
    const m = f.addModule();
    const mine = f.addItem();
    const foreign = f.addItem({ projectId: "p2" });
    await expect(addModuleWorkItems(f.prisma, "u1", m.id, [mine.id, foreign.id])).rejects.toThrow("invalid_work_item");
    expect(f.links).toHaveLength(0);
    expect(f.activity).toHaveLength(0);
  });

  it("a missing item is work_item_not_found, naming the ids", async () => {
    const f = makeFake();
    const m = f.addModule();
    const mine = f.addItem();
    const err = await addModuleWorkItems(f.prisma, "u1", m.id, [mine.id, "ghost"]).catch((e) => e);
    expect(err.message).toBe("work_item_not_found");
    expect(err.details).toEqual({ missingIds: ["ghost"] });
    expect(f.links).toHaveLength(0);
  });

  it("module_not_found", async () => {
    const f = makeFake();
    const a = f.addItem();
    await expect(addModuleWorkItems(f.prisma, "u1", "nope", [a.id])).rejects.toThrow("module_not_found");
  });

  it("a serialization loser applied nothing and says concurrent_mutation", async () => {
    const f = makeFake();
    const m = f.addModule();
    const a = f.addItem();
    f.seam.$transaction.mockImplementationOnce(async () => {
      throw prismaError("P2034");
    });
    await expect(addModuleWorkItems(f.prisma, "u1", m.id, [a.id])).rejects.toThrow("concurrent_mutation");
  });

  it("a link somebody else inserted a moment ago (unique violation) is concurrent_mutation, not a 500", async () => {
    const f = makeFake();
    const m = f.addModule();
    const a = f.addItem();
    (f.prisma as unknown as { pmModuleWorkItem: { createMany: () => Promise<never> } }).pmModuleWorkItem.createMany =
      async () => {
        throw prismaError("P2002");
      };
    await expect(addModuleWorkItems(f.prisma, "u1", m.id, [a.id])).rejects.toThrow("concurrent_mutation");
    expect(f.activity).toHaveLength(0);
  });
});

describe("removeModuleWorkItems", () => {
  it("unlinks the items and writes one module_removed row per link that existed", async () => {
    const f = makeFake();
    const m = f.addModule();
    const a = f.addItem();
    const b = f.addItem();
    const c = f.addItem();
    f.link(m.id, a.id);
    f.link(m.id, b.id);
    const out = await removeModuleWorkItems(f.prisma, "u1", m.id, [a.id, c.id]);
    // c was never in the module: skipped, not an error, not audited
    expect(out.removed).toBe(1);
    expect(f.links.map((l) => l.workItemId)).toEqual([b.id]);
    expect(f.activity).toHaveLength(1);
    expect(f.activity[0]).toMatchObject({
      workItemId: a.id,
      verb: "module_removed",
      field: "module",
      oldValue: m.id,
      newValue: null,
    });
    expectAllTransactionsAt(f.seam, SERIALIZABLE_TX);
  });

  it("removing nothing is a quiet success", async () => {
    const f = makeFake();
    const m = f.addModule();
    const a = f.addItem();
    const out = await removeModuleWorkItems(f.prisma, "u1", m.id, [a.id]);
    expect(out.removed).toBe(0);
    expect(f.activity).toHaveLength(0);
  });

  it("module_not_found", async () => {
    const f = makeFake();
    await expect(removeModuleWorkItems(f.prisma, "u1", "nope", ["x"])).rejects.toThrow("module_not_found");
  });
});

describe("listModules / getModule — progress", () => {
  it("counts each module's own items by state group, with estimates, archived excluded", async () => {
    const f = makeFake();
    const m1 = f.addModule({ name: "One" });
    const m2 = f.addModule({ name: "Two" });
    const done = f.addItem({ stateId: "s-done", estimate: 5 });
    const cancelled = f.addItem({ stateId: "s-cancelled", estimate: 2 });
    const open = f.addItem({ stateId: "s-todo", estimate: 3 });
    const hidden = f.addItem({ stateId: "s-todo", estimate: 99, isArchived: true });
    f.link(m1.id, done.id);
    f.link(m1.id, cancelled.id);
    f.link(m1.id, open.id);
    f.link(m1.id, hidden.id);
    f.link(m2.id, open.id); // an item may sit in several modules

    const list = await listModules(f.prisma, "p1");
    const byName = Object.fromEntries(list.map((m) => [m.name, m]));
    expect(byName.One.progress).toEqual({
      total: 3,
      completed: 1,
      cancelled: 1,
      totalEstimate: 10,
      completedEstimate: 5,
      cancelledEstimate: 2,
    });
    expect(byName.Two.progress.total).toBe(1);
    expect((await getModule(f.prisma, m1.id)).progress.total).toBe(3);
  });

  it("lists in creation order", async () => {
    const f = makeFake();
    f.addModule({ name: "first" });
    f.addModule({ name: "second" });
    expect((await listModules(f.prisma, "p1")).map((m) => m.name)).toEqual(["first", "second"]);
  });

  it("project_not_found / module_not_found", async () => {
    const f = makeFake();
    await expect(listModules(f.prisma, "nope")).rejects.toThrow("project_not_found");
    await expect(getModule(f.prisma, "nope")).rejects.toThrow("module_not_found");
  });
});

describe("listModuleWorkItems", () => {
  it("scopes the work-item list to the module's items, in the module's project", async () => {
    const f = makeFake();
    const m = f.addModule({ projectId: "p1" });
    vi.mocked(pmService.listWorkItemsWhere).mockResolvedValue({ items: [], total: 7 });
    const out = await listModuleWorkItems(f.prisma, m.id, { perPage: 25, page: 1 });
    expect(out).toEqual({ work_items: [], total: 7 });
    expect(pmService.listWorkItemsWhere).toHaveBeenCalledWith(
      f.prisma,
      "p1",
      { modules: { some: { moduleId: m.id } } },
      { perPage: 25, page: 1 },
    );
  });

  it("module_not_found", async () => {
    const f = makeFake();
    await expect(listModuleWorkItems(f.prisma, "nope", {})).rejects.toThrow("module_not_found");
  });
});

describe("listModulesForWorkItem", () => {
  it("answers the modules an item is in, for the drawer's picker", async () => {
    const f = makeFake();
    const a = f.addModule({ name: "Alpha", status: "in_progress" });
    const b = f.addModule({ name: "Beta" });
    f.addModule({ name: "Gamma" });
    const it = f.addItem();
    f.link(b.id, it.id);
    f.link(a.id, it.id);
    const out = await listModulesForWorkItem(f.prisma, it.id);
    expect(out).toEqual([
      { id: a.id, name: "Alpha", status: "in_progress" },
      { id: b.id, name: "Beta", status: "backlog" },
    ]);
  });

  it("work_item_not_found", async () => {
    const f = makeFake();
    await expect(listModulesForWorkItem(f.prisma, "nope")).rejects.toThrow("work_item_not_found");
  });
});
