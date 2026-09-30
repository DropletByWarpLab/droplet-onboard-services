/**
 * WARP-2549 — disconnecting a connector must not delete what a person wrote.
 */
import { describe, expect, it, vi } from "vitest";

import { detachLandedRecords, purgeLandedDocuments, purgeLandedRecords } from "./landed-purge.js";

const NOW = new Date("2026-09-01T04:00:00.000Z");

function db(opts: {
  deals?: { id: string }[];
  contacts?: { id: string }[];
  companies?: { id: string }[];
  /** Ids that carry a note, call or meeting a human typed. */
  withLocalActivity?: string[];
  pipeline?: { id: string } | null;
} = {}) {
  const local = new Set(opts.withLocalActivity ?? []);
  const table = (rows: { id: string }[]) => ({
    findMany: vi.fn(async () => rows),
    delete: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  });
  return {
    crmDeal: table(opts.deals ?? []),
    contact: table(opts.contacts ?? []),
    crmCompany: table(opts.companies ?? []),
    crmPipeline: {
      findFirst: vi.fn(async () => opts.pipeline ?? null),
      delete: vi.fn(async () => ({})),
    },
    crmPipelineStage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    crmActivity: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const id = (args.where.companyId ?? args.where.contactId ?? args.where.dealId) as string;
        return local.has(id) ? { id: "act-1" } : null;
      }),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const purge = (client: ReturnType<typeof db>) => purgeLandedRecords(client as any, "conn-1", NOW);

describe("purgeLandedRecords", () => {
  it("deletes a landed record nobody wrote against", async () => {
    const client = db({ companies: [{ id: "co-1" }] });

    const outcome = await purge(client);

    expect(outcome).toMatchObject({ deleted: 1, archived: 0 });
    expect(client.crmCompany.delete).toHaveBeenCalledWith({ where: { id: "co-1" } });
    expect(client.crmCompany.update).not.toHaveBeenCalled();
  });

  it("🔴 ARCHIVES a record carrying local activity, because the cascade would take it", async () => {
    const client = db({ companies: [{ id: "co-1" }], withLocalActivity: ["co-1"] });

    const outcome = await purge(client);

    expect(outcome).toMatchObject({ deleted: 0, archived: 1 });
    expect(client.crmCompany.delete).not.toHaveBeenCalled();
    expect(client.crmCompany.update).toHaveBeenCalledWith({
      where: { id: "co-1" },
      data: { isArchived: true, archivedAt: NOW },
    });
  });

  it("asks about LOCAL activity specifically — a SYNCED row is not the owner's prose", async () => {
    const client = db({ contacts: [{ id: "ct-1" }] });
    await purge(client);
    expect(client.crmActivity.findFirst).toHaveBeenCalledWith({
      where: { origin: "LOCAL", contactId: "ct-1" },
      select: { id: true },
    });
  });

  it("scopes every read to the CONNECTION, never to the provider", async () => {
    // The mutation this pins: `{ externalSystem: "hubspot" }` here would purge
    // a second HubSpot portal's customers along with this one's.
    const client = db();
    await purge(client);

    for (const table of [client.crmDeal, client.contact, client.crmCompany]) {
      expect(table.findMany).toHaveBeenCalledWith({
        where: { connectionId: "conn-1" },
        select: { id: true },
      });
    }
  });

  it("removes the synced pipeline once no deal is left standing in it", async () => {
    const client = db({ deals: [{ id: "d-1" }], pipeline: { id: "pl-1" } });

    const outcome = await purge(client);

    expect(outcome.pipelineRemoved).toBe(true);
    expect(client.crmPipelineStage.deleteMany).toHaveBeenCalledWith({
      where: { pipelineId: "pl-1" },
    });
    expect(client.crmPipeline.delete).toHaveBeenCalledWith({ where: { id: "pl-1" } });
  });

  it("keeps the pipeline when a deal survived — the stage relation is RESTRICT", async () => {
    // Deleting it would throw inside the disconnect transaction and take the
    // credential purge down with it.
    const client = db({
      deals: [{ id: "d-1" }],
      withLocalActivity: ["d-1"],
      pipeline: { id: "pl-1" },
    });

    const outcome = await purge(client);

    expect(outcome).toMatchObject({ archived: 1, pipelineRemoved: false });
    expect(client.crmPipeline.delete).not.toHaveBeenCalled();
    expect(client.crmPipelineStage.deleteMany).not.toHaveBeenCalled();
  });

  it("walks deals before companies, so a SetNull cannot orphan a live stage", async () => {
    const client = db({ deals: [{ id: "d-1" }], companies: [{ id: "co-1" }] });
    await purge(client);

    const dealOrder = client.crmDeal.findMany.mock.invocationCallOrder[0];
    const companyOrder = client.crmCompany.findMany.mock.invocationCallOrder[0];
    expect(dealOrder).toBeLessThan(companyOrder);
  });

  it("reports zero on a connection that landed nothing", async () => {
    const client = db();
    expect(await purge(client)).toEqual({ deleted: 0, archived: 0, pipelineRemoved: false });
  });
});

describe("detachLandedRecords (WARP-3375 keep)", () => {
  const table = (count: number) => ({ updateMany: vi.fn(async () => ({ count })) });

  it("clears the whole provenance triple AND flips origin, in ONE update per table", async () => {
    // Mutation: drop `origin: "LOCAL"` → the CHECK arm "all three set AND
    // EXTERNAL" no longer applies, but the row stays uneditable EXTERNAL.
    // Mutation: drop any one link column → the `*_provenance_complete` CHECK
    // rejects the row at runtime.
    const client = {
      crmDeal: table(2),
      contact: table(3),
      crmCompany: table(4),
      crmPipeline: table(1),
    };

    const detached = await detachLandedRecords(client as never, "conn-1");

    const data = { connectionId: null, externalSystem: null, externalId: null, origin: "LOCAL" };
    for (const t of [client.crmDeal, client.contact, client.crmCompany]) {
      expect(t.updateMany).toHaveBeenCalledTimes(1);
      expect(t.updateMany).toHaveBeenCalledWith({ where: { connectionId: "conn-1" }, data });
    }
    expect(client.crmPipeline.updateMany).toHaveBeenCalledWith({
      where: { connectionId: "conn-1" },
      data: { connectionId: null },
    });
    // Pipelines are not "records" in the audit count.
    expect(detached).toBe(9);
  });

  it("never writes isArchived — that is owner state", async () => {
    const client = {
      crmDeal: table(0),
      contact: table(0),
      crmCompany: table(0),
      crmPipeline: table(0),
    };

    await detachLandedRecords(client as never, "conn-1");

    for (const t of [client.crmDeal, client.contact, client.crmCompany]) {
      const arg = (t.updateMany.mock.calls[0] as unknown as [{ data: object }])[0];
      expect(arg.data).not.toHaveProperty("isArchived");
    }
  });
});

describe("purgeLandedDocuments (WARP-3375 delete)", () => {
  it("removes the money history, then only this connection's LANDED documents", async () => {
    const client = {
      $executeRaw: vi.fn(async () => 5),
      erpDocument: { deleteMany: vi.fn(async () => ({ count: 7 })) },
    };

    const deleted = await purgeLandedDocuments(client as never, "conn-1");

    expect(deleted).toBe(7);
    expect(client.erpDocument.deleteMany).toHaveBeenCalledWith({
      where: { connectionId: "conn-1", origin: "LANDED" },
    });
    expect(client.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(
      client.erpDocument.deleteMany.mock.invocationCallOrder[0]!,
    );
  });
});
