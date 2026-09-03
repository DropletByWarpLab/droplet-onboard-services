/**
 * WARP-2581 — the money read path.
 *
 * The tests that matter here are the ones about NOT producing a number: two
 * ledgers are never added, a balance that could not be read is counted but not
 * summed, and nothing on this surface claims freshness.
 */
import { describe, expect, it, vi } from "vitest";

import { createMoneyService } from "./money.service.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");

/** A stand-in for `Prisma.Decimal` — the two methods the service uses. */
function dec(value: string | null) {
  if (value === null) return null;
  return {
    toString: () => value,
    isZero: () => Number.parseFloat(value) === 0,
  };
}

function doc(over: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    kind: "RECEIVABLE",
    externalId: "INV-1001",
    externalSystem: "quickbooks-online",
    connectionId: "conn-1",
    issuedAt: new Date("2026-08-01T00:00:00Z"),
    dueAt: new Date("2026-09-30T00:00:00Z"),
    counterpartyExternalId: "cust-7",
    counterpartyName: null,
    companyId: null,
    amount: dec("4210.55"),
    balance: dec("1200.00"),
    currency: null,
    status: "Open",
    vendorUpdatedAt: null,
    lastReadAt: new Date("2026-09-01T11:00:00Z"),
    ...over,
  };
}

function service(rows: unknown[]) {
  const prisma = {
    erpDocument: {
      findMany: vi.fn(async (args: { where?: { kind?: string } }) =>
        args?.where?.kind === undefined
          ? rows
          : rows.filter((r) => (r as { kind: string }).kind === args.where?.kind),
      ),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { svc: createMoneyService(prisma as any), prisma };
}

describe("summary", () => {
  it("adds balances within one ledger, exactly", async () => {
    const { svc } = service([
      doc({ balance: dec("1200.00") }),
      doc({ id: "doc-2", externalId: "INV-1002", balance: dec("0.55") }),
    ]);

    const summary = await svc.summary(NOW);

    expect(summary.receivable.ledgers).toHaveLength(1);
    expect(summary.receivable.ledgers[0]).toMatchObject({
      connectionId: "conn-1",
      balance: "1200.55",
      documentCount: 2,
    });
  });

  it("🔴 never adds two ledgers — they are separate rows in the answer", async () => {
    const { svc } = service([
      doc({ balance: dec("1200.00") }),
      doc({ id: "doc-2", connectionId: "conn-2", externalSystem: "stripe", balance: dec("300.00") }),
    ]);

    const summary = await svc.summary(NOW);

    // The mutation this pins: one `total` field summing both would produce a
    // confident wrong number, because neither ledger names its currency.
    expect(summary.receivable.ledgers.map((l) => l.balance)).toEqual(["1200.00", "300.00"]);
    expect(summary.receivable).not.toHaveProperty("total");
    expect(summary.receivable).not.toHaveProperty("balance");
  });

  it("keeps two currencies apart inside ONE connection too", async () => {
    const { svc } = service([
      doc({ currency: "USD", balance: dec("100.00") }),
      doc({ id: "doc-2", currency: "EUR", balance: dec("50.00") }),
    ]);

    const summary = await svc.summary(NOW);
    expect(summary.receivable.ledgers).toHaveLength(2);
    expect(summary.receivable.ledgers.map((l) => l.currency)).toEqual(["EUR", "USD"]);
  });

  it("counts a document whose balance it could not read, and does not sum it", async () => {
    const { svc } = service([
      doc({ balance: dec("100.00") }),
      doc({ id: "doc-2", balance: null }),
    ]);

    const summary = await svc.summary(NOW);

    // The count and the figure disagreeing IS the signal that one is
    // unreadable. Dropping the row would hide money somebody owes.
    expect(summary.receivable.ledgers[0]).toMatchObject({
      documentCount: 2,
      balance: "100.00",
    });
  });

  it("treats a zero balance as settled and leaves it out", async () => {
    const { svc } = service([doc({ balance: dec("0.00") })]);
    const summary = await svc.summary(NOW);
    expect(summary.receivable.documentCount).toBe(0);
    expect(summary.receivable.ledgers).toHaveLength(0);
  });

  it("separates what is owed from what is owed BY the business", async () => {
    const { svc } = service([
      doc({ balance: dec("100.00") }),
      doc({ id: "doc-2", kind: "PAYABLE", externalId: "BILL-9", balance: dec("40.00") }),
    ]);

    const summary = await svc.summary(NOW);
    expect(summary.receivable.documentCount).toBe(1);
    expect(summary.payable.documentCount).toBe(1);
    expect(summary.payable.ledgers[0].balance).toBe("40.00");
  });

  it("counts overdue on the due date and the balance together", async () => {
    const { svc } = service([
      doc({ dueAt: new Date("2026-08-01T00:00:00Z"), balance: dec("100.00") }),
      // Past due but settled — not overdue, because nothing is owed.
      doc({ id: "doc-2", dueAt: new Date("2026-08-01T00:00:00Z"), balance: dec("0.00") }),
      // Owed but not yet due.
      doc({ id: "doc-3", dueAt: new Date("2026-12-01T00:00:00Z"), balance: dec("100.00") }),
      // No due date at all: a vendor that never sent one cannot be late.
      doc({ id: "doc-4", dueAt: null, balance: dec("100.00") }),
    ]);

    const summary = await svc.summary(NOW);
    expect(summary.receivable.overdueCount).toBe(1);
    expect(summary.receivable.ledgers[0].overdueBalance).toBe("100.00");
  });

  it("reports both ends of the read window, and nothing about freshness", async () => {
    const { svc } = service([
      doc({ lastReadAt: new Date("2026-09-01T11:00:00Z") }),
      doc({ id: "doc-2", lastReadAt: new Date("2026-08-25T09:00:00Z") }),
    ]);

    const summary = await svc.summary(NOW);
    expect(summary.lastReadAt).toBe("2026-09-01T11:00:00.000Z");
    expect(summary.oldestReadAt).toBe("2026-08-25T09:00:00.000Z");
    // One number cannot describe a box whose Xero answered this morning and
    // whose Stripe has been failing for a week.
    expect(summary.lastReadAt).not.toBe(summary.oldestReadAt);
  });

  it("says nothing rather than zero when there is nothing landed", async () => {
    const { svc } = service([]);
    const summary = await svc.summary(NOW);
    expect(summary).toMatchObject({
      lastReadAt: null,
      oldestReadAt: null,
      receivable: { documentCount: 0, overdueCount: 0, ledgers: [] },
      payable: { documentCount: 0, overdueCount: 0, ledgers: [] },
    });
  });
});

describe("documents", () => {
  it("hands money across as STRINGS, never numbers", async () => {
    const { svc } = service([doc({ amount: dec("90071992547409.93") })]);
    const [view] = await svc.documents({ now: NOW });

    expect(view.amount).toBe("90071992547409.93");
    expect(typeof view.amount).toBe("string");
    // Number() would round this to ...92 — a wrong figure, not an error.
    expect(view.amount).not.toBe(String(Number("90071992547409.93")));
  });

  it("marks overdue per row", async () => {
    const { svc } = service([
      doc({ dueAt: new Date("2026-08-01T00:00:00Z") }),
      doc({ id: "doc-2", dueAt: new Date("2026-12-01T00:00:00Z") }),
    ]);
    const views = await svc.documents({ now: NOW });
    expect(views.map((v) => v.isOverdue)).toEqual([true, false]);
  });

  it("filters to one direction, at the database", async () => {
    const { svc, prisma } = service([doc({ kind: "PAYABLE" })]);
    await svc.documents({ kind: "PAYABLE", now: NOW });
    expect(prisma.erpDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: "PAYABLE" } }),
    );
  });

  it("lists only what is outstanding", async () => {
    const { svc } = service([doc({ balance: dec("0.00") }), doc({ id: "doc-2" })]);
    const views = await svc.documents({ now: NOW });
    expect(views.map((v) => v.id)).toEqual(["doc-2"]);
  });

  it("keeps a document whose balance is unknown", async () => {
    const { svc } = service([doc({ balance: null })]);
    const views = await svc.documents({ now: NOW });
    expect(views).toHaveLength(1);
    expect(views[0].balance).toBeNull();
  });

  it("filters to overdue only when asked", async () => {
    const { svc } = service([
      doc({ dueAt: new Date("2026-08-01T00:00:00Z") }),
      doc({ id: "doc-2", dueAt: null }),
    ]);
    const views = await svc.documents({ overdueOnly: true, now: NOW });
    expect(views.map((v) => v.id)).toEqual(["doc-1"]);
  });

  it("caps a page however large a caller asks", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => doc({ id: `doc-${i}`, externalId: `INV-${i}` }));
    const { svc } = service(rows);
    expect(await svc.documents({ limit: 5000, now: NOW })).toHaveLength(200);
  });
});
