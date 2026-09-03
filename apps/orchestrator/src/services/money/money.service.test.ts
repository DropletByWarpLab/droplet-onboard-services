/**
 * WARP-2581 — the money read path.
 *
 * The tests that matter here are the ones about NOT producing a number: two
 * ledgers are never added, a balance that could not be read is counted but not
 * summed, and nothing on this surface claims freshness.
 *
 * Since the review, they are also about WHERE the number is produced. The
 * summary used to read every landed document and add them up in JavaScript,
 * on a five-minute poll per open tab. It now runs three bounded queries, and
 * `fakeErpDocumentTable` models the SQL semantics those depend on so the
 * arithmetic assertions below still mean what they meant before.
 */
import { describe, expect, it } from "vitest";

import {
  fakeDocument,
  fakeErpDocumentTable,
  type FakeDocumentInput,
} from "../../__tests__/helpers/fake-erp-documents.js";
import { createMoneyService } from "./money.service.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");

const doc = fakeDocument;

function service(rows: readonly FakeDocumentInput[]) {
  const erpDocument = fakeErpDocumentTable(rows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { svc: createMoneyService({ erpDocument } as any), erpDocument };
}

describe("summary", () => {
  it("adds balances within one ledger, exactly", async () => {
    const { svc } = service([
      doc({ balance: "1200.00" }),
      doc({ id: "doc-2", externalId: "INV-1002", balance: "0.55" }),
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
      doc({ balance: "1200.00" }),
      doc({ id: "doc-2", connectionId: "conn-2", externalSystem: "stripe", balance: "300.00" }),
    ]);

    const summary = await svc.summary(NOW);

    // The mutation this pins: one `total` field summing both would produce a
    // confident wrong number, because neither ledger names its currency.
    expect(summary.receivable.ledgers.map((l) => l.balance)).toEqual(["1200", "300"]);
    expect(summary.receivable).not.toHaveProperty("total");
    expect(summary.receivable).not.toHaveProperty("balance");
  });

  it("keeps two currencies apart inside ONE connection too", async () => {
    const { svc } = service([
      doc({ currency: "USD", balance: "100.00" }),
      doc({ id: "doc-2", currency: "EUR", balance: "50.00" }),
    ]);

    const summary = await svc.summary(NOW);
    expect(summary.receivable.ledgers).toHaveLength(2);
    expect(summary.receivable.ledgers.map((l) => l.currency)).toEqual(["EUR", "USD"]);
  });

  it("counts a document whose balance it could not read, and does not sum it", async () => {
    const { svc } = service([doc({ balance: "100.00" }), doc({ id: "doc-2", balance: null })]);

    const summary = await svc.summary(NOW);

    // The count and the figure disagreeing IS the signal that one is
    // unreadable. Dropping the row would hide money somebody owes.
    expect(summary.receivable.ledgers[0]).toMatchObject({
      documentCount: 2,
      balance: "100",
    });
  });

  it("says zero rather than nothing when a whole ledger is unreadable", async () => {
    // SUM() over an all-NULL group is NULL. A ledger with two documents and no
    // readable figure must still appear, and still count them.
    const { svc } = service([doc({ balance: null }), doc({ id: "doc-2", balance: null })]);

    const summary = await svc.summary(NOW);
    expect(summary.receivable.ledgers[0]).toMatchObject({ documentCount: 2, balance: "0" });
  });

  it("treats a zero balance as settled and leaves it out", async () => {
    const { svc } = service([doc({ balance: "0.00" })]);
    const summary = await svc.summary(NOW);
    expect(summary.receivable.documentCount).toBe(0);
    expect(summary.receivable.ledgers).toHaveLength(0);
  });

  it("separates what is owed from what is owed BY the business", async () => {
    const { svc } = service([
      doc({ balance: "100.00" }),
      doc({ id: "doc-2", kind: "PAYABLE", externalId: "BILL-9", balance: "40.00" }),
    ]);

    const summary = await svc.summary(NOW);
    expect(summary.receivable.documentCount).toBe(1);
    expect(summary.payable.documentCount).toBe(1);
    expect(summary.payable.ledgers[0].balance).toBe("40");
  });

  it("counts overdue on the due date and the balance together", async () => {
    const { svc } = service([
      doc({ dueAt: new Date("2026-08-01T00:00:00Z"), balance: "100.00" }),
      // Past due but settled — not overdue, because nothing is owed.
      doc({ id: "doc-2", dueAt: new Date("2026-08-01T00:00:00Z"), balance: "0.00" }),
      // Owed but not yet due.
      doc({ id: "doc-3", dueAt: new Date("2026-12-01T00:00:00Z"), balance: "100.00" }),
      // No due date at all: a vendor that never sent one cannot be late.
      doc({ id: "doc-4", dueAt: null, balance: "100.00" }),
    ]);

    const summary = await svc.summary(NOW);
    expect(summary.receivable.overdueCount).toBe(1);
    expect(summary.receivable.ledgers[0].overdueBalance).toBe("100");
  });

  it("reports zero overdue for a ledger that has none, rather than omitting it", async () => {
    const { svc } = service([doc({ dueAt: new Date("2026-12-01T00:00:00Z"), balance: "100.00" })]);
    const summary = await svc.summary(NOW);
    expect(summary.receivable.ledgers[0]).toMatchObject({
      overdueCount: 0,
      overdueBalance: "0",
    });
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

  it("🔴 aggregates in Postgres — it never reads the documents to add them up", async () => {
    // `useMoney.ts` polls /api/money every five minutes per open tab. An
    // unbounded findMany here bills a practice's whole ledger — over the wire
    // and into the heap — on a timer, and then adds it up in JavaScript.
    const { svc, erpDocument } = service([doc(), doc({ id: "doc-2", balance: "5.00" })]);

    await svc.summary(NOW);

    expect(erpDocument.findMany).not.toHaveBeenCalled();
    expect(erpDocument.groupBy).toHaveBeenCalledTimes(2);
    expect(erpDocument.aggregate).toHaveBeenCalledTimes(1);
    for (const call of erpDocument.groupBy.mock.calls) {
      expect(call[0]).toMatchObject({
        by: ["kind", "connectionId", "externalSystem", "currency"],
        _count: { _all: true },
        _sum: { balance: true },
      });
    }
  });
});

describe("documents", () => {
  it("hands money across as STRINGS, never numbers", async () => {
    const { svc } = service([doc({ amount: "90071992547409.93" })]);
    const [view] = await svc.documents({ now: NOW });

    expect(view.amount).toBe("90071992547409.93");
    expect(typeof view.amount).toBe("string");
    // Number() would round this to ...92 — a wrong figure, not an error.
    expect(view.amount).not.toBe(String(Number("90071992547409.93")));
  });

  it("marks overdue per row", async () => {
    const { svc } = service([
      doc({ dueAt: new Date("2026-08-01T00:00:00Z") }),
      doc({ id: "doc-2", externalId: "INV-2", dueAt: new Date("2026-12-01T00:00:00Z") }),
    ]);
    const views = await svc.documents({ now: NOW });
    expect(views.map((v) => v.isOverdue)).toEqual([true, false]);
  });

  it("filters to one direction, at the database", async () => {
    const { svc, erpDocument } = service([doc({ kind: "PAYABLE" })]);
    await svc.documents({ kind: "PAYABLE", now: NOW });
    expect(erpDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: "PAYABLE" }) }),
    );
  });

  it("lists only what is outstanding", async () => {
    const { svc } = service([
      doc({ balance: "0.00" }),
      doc({ id: "doc-2", externalId: "INV-2" }),
    ]);
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
      doc({ id: "doc-2", externalId: "INV-2", dueAt: null }),
    ]);
    const views = await svc.documents({ overdueOnly: true, now: NOW });
    expect(views.map((v) => v.id)).toEqual(["doc-1"]);
  });

  it("caps a page however large a caller asks", async () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      doc({ id: `doc-${i}`, externalId: `INV-${String(i).padStart(4, "0")}` }),
    );
    const { svc } = service(rows);
    expect(await svc.documents({ limit: 5000, now: NOW })).toHaveLength(200);
  });

  it("🔴 takes the page in SQL, rather than reading the table and slicing it", async () => {
    const { svc, erpDocument } = service([doc()]);

    await svc.documents({ limit: 25, now: NOW });

    expect(erpDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 25,
        orderBy: [{ dueAt: "asc" }, { externalId: "asc" }],
      }),
    );
    // The cap is applied to the query, not to the answer.
    await svc.documents({ limit: 5000, now: NOW });
    expect(erpDocument.findMany.mock.calls[1][0]).toMatchObject({ take: 200 });
  });

  it("🔴 excludes settled documents in SQL, under the same predicate the summary counts", async () => {
    const { svc, erpDocument } = service([doc()]);
    await svc.documents({ now: NOW });
    expect(erpDocument.findMany.mock.calls[0][0].where).toMatchObject({
      OR: [{ balance: null }, { balance: { not: 0 } }],
    });
  });
});
