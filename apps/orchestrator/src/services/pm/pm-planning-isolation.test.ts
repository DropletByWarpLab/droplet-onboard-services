import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  completeCycle, createCycle, deleteCycle, getCycle, getCycleBurndown,
  listBacklog, listCycles, listCycleWorkItems, startCycle, updateCycle,
} from "./pm-cycles.service.js";
import {
  addModuleWorkItems, createModule, deleteModule, getModule, listModules,
  listModulesForWorkItem, listModuleWorkItems, removeModuleWorkItems, updateModule,
} from "./pm-modules.service.js";

function deskClient() {
  const project = { id: "desk", kind: "SERVICE_DESK" };
  const row = {
    id: "planning", projectId: "desk", project, name: "Private", status: "draft",
    startDate: new Date("2026-10-01"), endDate: new Date("2026-10-15"), createdAt: new Date(),
  };
  const model = () => ({
    findUnique: vi.fn().mockResolvedValue(row), findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue(row), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    delete: vi.fn(),
  });
  const db = {
    pmProject: { findUnique: vi.fn().mockResolvedValue(project) },
    pmCycle: model(), pmModule: model(),
    pmWorkItem: { findUnique: vi.fn().mockResolvedValue({ projectId: "desk", project }), findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    pmModuleWorkItem: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn(), deleteMany: vi.fn() },
    pmActivity: { createMany: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
  return db;
}

describe("PM planning preserves service-desk isolation", () => {
  const cases: Array<[string, string, (db: PrismaClient) => Promise<unknown>]> = [
    ["list cycles", "project_not_found", (db) => listCycles(db, "desk")],
    ["create cycle", "project_not_found", (db) => createCycle(db, "desk", { name: "Extra" })],
    ["backlog", "project_not_found", (db) => listBacklog(db, "desk", {})],
    ["get cycle", "cycle_not_found", (db) => getCycle(db, "planning")],
    ["cycle items", "cycle_not_found", (db) => listCycleWorkItems(db, "planning", {})],
    ["update cycle", "cycle_not_found", (db) => updateCycle(db, "planning", { name: "Renamed" })],
    ["delete cycle", "cycle_not_found", (db) => deleteCycle(db, null, "planning")],
    ["start cycle", "cycle_not_found", (db) => startCycle(db, "planning")],
    ["complete cycle", "cycle_not_found", (db) => completeCycle(db, null, "planning", { moveIncompleteTo: null })],
    ["burndown", "cycle_not_found", (db) => getCycleBurndown(db, "planning")],
    ["list modules", "project_not_found", (db) => listModules(db, "desk")],
    ["create module", "project_not_found", (db) => createModule(db, "desk", { name: "Extra" })],
    ["get module", "module_not_found", (db) => getModule(db, "planning")],
    ["module items", "module_not_found", (db) => listModuleWorkItems(db, "planning", {})],
    ["update module", "module_not_found", (db) => updateModule(db, "planning", { name: "Renamed" })],
    ["delete module", "module_not_found", (db) => deleteModule(db, null, "planning")],
    ["add module items", "module_not_found", (db) => addModuleWorkItems(db, null, "planning", ["ticket"])],
    ["remove module items", "module_not_found", (db) => removeModuleWorkItems(db, null, "planning", ["ticket"])],
    ["ticket modules", "work_item_not_found", (db) => listModulesForWorkItem(db, "ticket")],
  ];
  it.each(cases)("%s answers %s without a write", async (_name, error, run) => {
    const db = deskClient();
    await expect(run(db as unknown as PrismaClient)).rejects.toThrow(error);
    for (const model of [db.pmCycle, db.pmModule]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      expect(model.updateMany).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }
    expect(db.pmModuleWorkItem.createMany).not.toHaveBeenCalled();
    expect(db.pmModuleWorkItem.deleteMany).not.toHaveBeenCalled();
  });
});
