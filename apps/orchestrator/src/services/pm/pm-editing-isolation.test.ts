import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";
import { archiveWorkItem, reorderStates, restoreWorkItem } from "./pm.service.js";
import {
  clearPropertyValue, createProperty, deleteProperty, listProperties,
  reorderProperties, setPropertyValue, updateProperty,
} from "./pm-properties.service.js";

function deskClient() {
  const project = { id: "desk", kind: "SERVICE_DESK" };
  const property = {
    id: "field", projectId: "desk", name: "Private", type: "text", options: null,
    sortOrder: 0, createdAt: new Date(), updatedAt: new Date(), project,
  };
  const db = {
    pmProject: { findUnique: vi.fn().mockResolvedValue(project) },
    pmState: { findMany: vi.fn().mockResolvedValue([{ id: "state" }]), update: vi.fn() },
    pmCustomProperty: {
      findUnique: vi.fn().mockResolvedValue(property), findMany: vi.fn().mockResolvedValue([property]),
      count: vi.fn().mockResolvedValue(0), aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 0 } }),
      create: vi.fn().mockResolvedValue(property), update: vi.fn().mockResolvedValue(property), delete: vi.fn(),
    },
    pmWorkItem: {
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: Prisma.PmWorkItemWhereInput }) =>
        where.project ? null : { id: "ticket", projectId: "desk", project }),
      updateMany: vi.fn().mockImplementation(async ({ where }: { where: Prisma.PmWorkItemWhereInput }) => ({ count: where.project ? 0 : 1 })),
    },
    pmWorkItemPropertyValue: {
      findUnique: vi.fn().mockResolvedValue({ id: "value", value: { text: "Private" } }),
      findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn(), delete: vi.fn(),
    },
    pmActivity: { create: vi.fn(), createMany: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "desk", kind: "SERVICE_DESK" }]),
    $transaction: vi.fn(),
  };
  db.$transaction = createTransactionSeam({ client: () => db }).$transaction;
  return db;
}

describe("PM editing preserves service-desk isolation", () => {
  it.each([
    ["list fields", (db: PrismaClient) => listProperties(db, "desk")],
    ["create field", (db: PrismaClient) => createProperty(db, "desk", { name: "Extra", type: "text" })],
    ["reorder fields", (db: PrismaClient) => reorderProperties(db, "desk", ["field"])],
    ["reorder states", (db: PrismaClient) => reorderStates(db, "desk", ["state"])],
  ] as const)("%s answers project_not_found without a write", async (_name, run) => {
    const db = deskClient();
    await expect(run(db as unknown as PrismaClient)).rejects.toThrow("project_not_found");
    expect(db.pmCustomProperty.create).not.toHaveBeenCalled();
    expect(db.pmCustomProperty.update).not.toHaveBeenCalled();
    expect(db.pmState.update).not.toHaveBeenCalled();
  });

  it.each([
    ["update field", (db: PrismaClient) => updateProperty(db, null, "field", { name: "Renamed" })],
    ["delete field", (db: PrismaClient) => deleteProperty(db, null, "field")],
  ] as const)("%s answers property_not_found without a write", async (_name, run) => {
    const db = deskClient();
    await expect(run(db as unknown as PrismaClient)).rejects.toThrow("property_not_found");
    expect(db.pmCustomProperty.update).not.toHaveBeenCalled();
    expect(db.pmCustomProperty.delete).not.toHaveBeenCalled();
  });

  it.each([
    ["set value", (db: PrismaClient) => setPropertyValue(db, null, "ticket", "field", { text: "Changed" })],
    ["clear value", (db: PrismaClient) => clearPropertyValue(db, null, "ticket", "field")],
    ["archive ticket", (db: PrismaClient) => archiveWorkItem(db, null, "ticket")],
    ["restore ticket", (db: PrismaClient) => restoreWorkItem(db, null, "ticket")],
  ] as const)("%s answers work_item_not_found without a write", async (_name, run) => {
    const db = deskClient();
    await expect(run(db as unknown as PrismaClient)).rejects.toThrow("work_item_not_found");
    expect(db.pmWorkItemPropertyValue.upsert).not.toHaveBeenCalled();
    expect(db.pmWorkItemPropertyValue.delete).not.toHaveBeenCalled();
    expect(db.pmActivity.create).not.toHaveBeenCalled();
  });
});
