/**
 * WARP-2581 — money at rest.
 *
 * The first test in this file is the one that matters most: a LAN track's
 * ledger is a patient ledger, and it must not reach this table.
 */
import { describe, expect, it, vi } from "vitest";

import { landMoneyDocuments, landsMoney, MONEY_ENTITIES } from "./land-money.js";

const NOW = new Date("2026-09-01T05:00:00.000Z");

function db(overrides: Record<string, Record<string, unknown>> = {}) {
  const client = {
    erpDocument: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({ id: "doc-1" })),
    },
    crmCompany: { findFirst: vi.fn(async () => null) },
  };
  for (const [name, methods] of Object.entries(overrides)) {
    Object.assign((client as Record<string, Record<string, unknown>>)[name], methods);
  }
  return client;
}

const land = (
  client: ReturnType<typeof db>,
  entity: string,
  rows: unknown[],
  provider = "quickbooks-online",
) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  landMoneyDocuments(client as any, {
    connection: { id: "conn-1", provider },
    entity,
    rows,
    now: NOW,
  });

const INVOICE = {
  invoice_id: "INV-1001",
  issued_at: "2026-08-10T00:00:00Z",
  due_at: "2026-09-10T00:00:00Z",
  customer_id: "cust-7",
  amount: "4210.55",
  balance: "1200.00",
  status: "Open",
  updated_at: "2026-08-21T00:00:00Z",
};

describe("🔴 only cloud accounting tracks land money", () => {
  it.each(["eaglesoft", "eaglesoft-api", "dentrix-export"])(
    "refuses the LAN track %s and writes nothing",
    async (provider) => {
      const client = db();
      const outcome = await land(client, "invoice", [INVOICE], provider);

      expect(outcome).toEqual({
        entity: "invoice",
        landed: 0,
        skipped: 1,
        reason: "not-cloud",
      });
      // A practice's receivables are a fact about a patient. PHI on this box is
      // read-through, behind the ERP router's own gate.
      expect(client.erpDocument.create).not.toHaveBeenCalled();
      expect(client.erpDocument.updateMany).not.toHaveBeenCalled();
    },
  );

  it("accepts the cloud ledgers", async () => {
    for (const provider of ["quickbooks-online", "stripe"]) {
      const client = db();
      const outcome = await land(client, "invoice", [INVOICE], provider);
      expect(outcome.landed).toBe(1);
    }
  });

  it("knows which datasets are money", () => {
    expect(MONEY_ENTITIES).toEqual(["invoice", "bill"]);
    expect(landsMoney("invoice")).toBe(true);
    expect(landsMoney("bill")).toBe(true);
    expect(landsMoney("account")).toBe(false);
    expect(landsMoney("company")).toBe(false);
  });
});

describe("an invoice becomes a RECEIVABLE", () => {
  it("lands with complete provenance and both figures", async () => {
    const client = db();
    await land(client, "invoice", [INVOICE]);

    expect(client.erpDocument.create).toHaveBeenCalledWith({
      data: {
        kind: "RECEIVABLE",
        issuedAt: new Date("2026-08-10T00:00:00Z"),
        dueAt: new Date("2026-09-10T00:00:00Z"),
        counterpartyExternalId: "cust-7",
        companyId: null,
        amount: "4210.55",
        balance: "1200.00",
        currency: null,
        status: "Open",
        vendorUpdatedAt: new Date("2026-08-21T00:00:00Z"),
        lastReadAt: NOW,
        connectionId: "conn-1",
        externalSystem: "quickbooks-online",
        externalId: "INV-1001",
      },
    });
  });

  it("keeps amount and balance apart — they are different numbers", async () => {
    const client = db();
    await land(client, "invoice", [{ ...INVOICE, amount: "4210.55", balance: "0.00" }]);
    const [[call]] = client.erpDocument.create.mock.calls as unknown as [
      [{ data: { amount: string; balance: string } }],
    ];
    expect(call.data.amount).toBe("4210.55");
    expect(call.data.balance).toBe("0.00");
  });

  it("holds the vendor's decimal EXACTLY, as a string", async () => {
    // Never Number(): 4210.55 is not representable in binary floating point,
    // and the value goes to a NUMERIC column that can hold it.
    const client = db();
    await land(client, "invoice", [{ ...INVOICE, amount: "90071992547409.93" }]);
    expect(client.erpDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: "90071992547409.93" }),
      }),
    );
  });

  it("lands NO figure rather than a guessed one", async () => {
    const client = db();
    await land(client, "invoice", [
      { ...INVOICE, amount: "4,210.55", balance: "$1200" },
    ]);
    expect(client.erpDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: null, balance: null }) }),
    );
  });

  it("reads a per-row currency when a track grows one, and normalises it", async () => {
    const client = db();
    await land(client, "invoice", [{ ...INVOICE, currency: "eur" }]);
    expect(client.erpDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currency: "EUR" }) }),
    );

    const bogus = db();
    await land(bogus, "invoice", [{ ...INVOICE, currency: "US$" }]);
    expect(bogus.erpDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currency: null }) }),
    );
  });

  it("attaches the customer only when THIS connection landed them", async () => {
    const client = db({ crmCompany: { findFirst: vi.fn(async () => ({ id: "co-1" })) } });
    await land(client, "invoice", [INVOICE]);

    expect(client.crmCompany.findFirst).toHaveBeenCalledWith({
      where: { connectionId: "conn-1", externalId: "cust-7" },
      select: { id: true },
    });
    expect(client.erpDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ companyId: "co-1" }) }),
    );
  });

  it("refuses an unparseable vendor date instead of writing Invalid Date", async () => {
    const client = db();
    await land(client, "invoice", [{ ...INVOICE, due_at: "whenever" }]);
    expect(client.erpDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dueAt: null }) }),
    );
  });
});

describe("a bill becomes a PAYABLE", () => {
  const BILL = {
    bill_id: "BILL-9",
    issued_at: "2026-08-01T00:00:00Z",
    due_at: "2026-08-31T00:00:00Z",
    vendor_id: "supplier-3",
    amount: "980.00",
    balance: "980.00",
    status: "Open",
  };

  it("reads the vendor id, not the customer id", async () => {
    const client = db();
    await land(client, "bill", [BILL]);
    expect(client.erpDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "PAYABLE",
          counterpartyExternalId: "supplier-3",
          externalId: "BILL-9",
        }),
      }),
    );
  });

  it("reconciles on connection + kind + id, so an invoice and a bill can share a number", async () => {
    const client = db();
    await land(client, "bill", [BILL]);
    expect(client.erpDocument.updateMany).toHaveBeenCalledWith({
      where: { connectionId: "conn-1", kind: "PAYABLE", externalId: "BILL-9" },
      data: expect.any(Object),
    });
  });
});

describe("re-reads and races", () => {
  it("updates an already-landed document instead of duplicating it", async () => {
    const client = db({ erpDocument: { updateMany: vi.fn(async () => ({ count: 1 })) } });
    const outcome = await land(client, "invoice", [INVOICE]);

    expect(outcome.landed).toBe(1);
    expect(client.erpDocument.create).not.toHaveBeenCalled();
  });

  it("survives a concurrent tick creating the same document", async () => {
    const conflict = Object.assign(new Error("unique"), { code: "P2002" });
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const client = db({
      erpDocument: {
        updateMany,
        create: vi.fn(async () => {
          throw conflict;
        }),
      },
    });

    expect((await land(client, "invoice", [INVOICE])).landed).toBe(1);
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("skips a document the vendor did not identify", async () => {
    const client = db();
    const outcome = await land(client, "invoice", [{ amount: "10.00" }]);
    expect(outcome).toEqual({
      entity: "invoice",
      landed: 0,
      skipped: 1,
      reason: "unidentified",
    });
  });
});
