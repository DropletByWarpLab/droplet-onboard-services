/**
 * WARP-2737 — a filed invoice, against real Postgres.
 *
 * A mocked Prisma cannot prove any of this. It will accept a LOCAL row with a
 * connection id, it has no CHECK to violate, and it cannot show what a
 * `SetNull` cascade does to an invoice when its customer is deleted. Those are
 * exactly the three things that decide whether this slice is safe.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("a filed money document (WARP-2737)", () => {
  let prisma: PrismaClient;
  let companyId: string;
  let documents: typeof import("../services/money/document-status.js");

  beforeAll(async () => {
    const { PrismaClient: Real } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new Real();
    await prisma.$connect();
    documents = await import("../services/money/document-status.js");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const OURS = { startsWith: "warp2737-" } as const;

  beforeEach(async () => {
    await prisma.erpDocument.deleteMany({ where: { counterpartyName: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    companyId = (
      await prisma.crmCompany.create({
        data: { name: "warp2737-customer" },
        select: { id: true },
      })
    ).id;
  });

  const input = () => ({
    kind: "INVOICE" as const,
    companyId,
    documentNumber: "warp2737-INV-1042",
    currency: "USD",
    total: "4250.00",
    counterpartyName: "warp2737-acme",
  });

  it("🔴 lands as a DRAFT that borrows nothing from a vendor", async () => {
    const { id } = await prisma.$transaction((tx) => documents.createLocalDocument(tx, input()));
    const row = await prisma.erpDocument.findUniqueOrThrow({ where: { id } });

    expect(row.origin).toBe("LOCAL");
    expect(row.status).toBe("DRAFT");
    expect(row.connectionId).toBeNull();
    expect(row.externalSystem).toBeNull();
    expect(row.externalId).toBeNull();
    expect(row.vendorStatus).toBeNull();
    // The number went to its own column, never to the vendor's key.
    expect(row.documentNumber).toBe("warp2737-INV-1042");
  });

  it("🔴 holds the figure EXACTLY — the whole reason money is a string", async () => {
    const big = "90071992547409.93";
    const { id } = await prisma.$transaction((tx) =>
      documents.createLocalDocument(tx, { ...input(), total: big }),
    );
    const row = await prisma.erpDocument.findUniqueOrThrow({ where: { id } });
    // NUMERIC(20,6) round-trips it; a JS number would not have.
    expect(row.amount?.toString()).toBe(big);
    expect(row.balance?.toString()).toBe(big);
    expect(String(Number(big))).not.toBe(big);
  });

  it("refuses a document with no customer before it reaches the database", async () => {
    await expect(
      prisma.$transaction((tx) => documents.createLocalDocument(tx, { ...input(), companyId: "" })),
    ).rejects.toThrow(documents.DOCUMENT_ERRORS.NEEDS_PARTY);
  });

  it("🔴 undo deletes it while DRAFT", async () => {
    const { id } = await prisma.$transaction((tx) => documents.createLocalDocument(tx, input()));
    const removed = await prisma.$transaction((tx) => documents.deleteDraftDocument(tx, id));
    expect(removed).toBe(true);
    expect(await prisma.erpDocument.findUnique({ where: { id } })).toBeNull();
  });

  it("🔴 undo REFUSES once the document has been sent, and says it refused", async () => {
    const { id } = await prisma.$transaction((tx) => documents.createLocalDocument(tx, input()));
    await documents.moveDocumentStatus(prisma, id, "SENT", null);

    const removed = await prisma.$transaction((tx) => documents.deleteDraftDocument(tx, id));
    // A sent invoice has left the building — somebody has it. Undo must report
    // that it did NOT take the document back rather than claim a deletion.
    expect(removed).toBe(false);
    expect(await prisma.erpDocument.findUnique({ where: { id } })).not.toBeNull();
  });

  it("🔴 deleting the customer ORPHANS the invoice rather than removing it", async () => {
    // The behaviour undo's ordering exists to work around, pinned so a future
    // change from SetNull to Cascade is noticed here rather than assumed.
    //
    // `deleteCompany` refuses a customer holding LOCAL documents, so this is
    // the raw database behaviour beneath that refusal — not a path the product
    // offers.
    const { id } = await prisma.$transaction((tx) => documents.createLocalDocument(tx, input()));
    await prisma.crmCompany.delete({ where: { id: companyId } });

    const row = await prisma.erpDocument.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row?.companyId).toBeNull();
    // And the orphan is LEGAL: the provenance CHECK's LOCAL arm deliberately
    // omits `companyId IS NOT NULL`, which is why the invariant is enforced in
    // `deleteCompany` and in `createLocalDocument` instead.
    expect(row?.origin).toBe("LOCAL");
  });

  it("🔴 the CHECK still refuses a LOCAL row that borrows a connection", async () => {
    // Belt and braces: `createLocalDocument` writes NULLs, but the constraint
    // is what makes the shape unrepresentable rather than merely unwritten.
    await expect(
      prisma.erpDocument.create({
        data: {
          origin: "LOCAL",
          kind: "INVOICE",
          status: "DRAFT",
          companyId,
          currency: "USD",
          amount: "1.00",
          counterpartyName: "warp2737-bad",
          externalSystem: "quickbooks-online",
          externalId: "x",
        },
      }),
    ).rejects.toThrow(/ErpDocument_provenance/);
  });
});
