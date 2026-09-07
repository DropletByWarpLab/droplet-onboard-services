/**
 * WARP-2739 (ADR-049 §4.1) — the provenance CHECK, against real Postgres.
 *
 * A mocked Prisma cannot prove a CHECK constraint. It will happily accept a
 * LOCAL row carrying a connection id, and every unit test above it will stay
 * green while the one thing the widening exists to prevent is possible.
 *
 * ── What the constraint is FOR ─────────────────────────────────────────────
 *
 * 🔴 A LOCAL row that borrowed a connection would be vendor-owned. On the CRM
 * side that means uneditable, archive-only, and overwritten by the next
 * landing tick — which for a document a person has to correct is not a
 * degradation, it is the feature not existing. "Mostly local, with a
 * connection for convenience" is exactly the shape that gets there, and this
 * constraint is what makes it unrepresentable rather than merely discouraged.
 *
 * The status pair is the other half: a LANDED row has the vendor's word and no
 * lifecycle of ours; a LOCAL row has our lifecycle and no vendor word. Kept in
 * one column, a query for unpaid invoices would silently match the vendor
 * string "Paid".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("ErpDocument provenance (WARP-2739)", () => {
  let prisma: PrismaClient;
  let connectionId: string;
  let companyId: string;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Namespaced: the pg-gated suites share one throwaway database and run in
  // the same lane, so an unscoped deleteMany would eat another suite's rows.
  const OURS = { startsWith: "warp2739-" } as const;

  beforeEach(async () => {
    // FK order: documents, then the company they point at, then the connection
    // they reference with RESTRICT.
    await prisma.erpDocument.deleteMany({ where: { counterpartyName: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    await prisma.integrationConnection.deleteMany({ where: { secretRef: OURS } });

    connectionId = (
      await prisma.integrationConnection.create({
        data: {
          provider: "warp2739-vendor",
          status: "CONNECTED",
          host: "warp2739-host",
          databaseName: "",
          secretRef: "warp2739-secret",
        },
        select: { id: true },
      })
    ).id;
    companyId = (
      await prisma.crmCompany.create({
        data: { name: "warp2739-customer" },
        select: { id: true },
      })
    ).id;
  });

  const landed = () => ({
    origin: "LANDED" as const,
    kind: "INVOICE" as const,
    connectionId,
    externalSystem: "warp2739-vendor",
    externalId: `warp2739-inv-${Math.random().toString(36).slice(2, 10)}`,
    counterpartyName: "warp2739-northgate",
    vendorStatus: "Open",
  });

  const local = () => ({
    origin: "LOCAL" as const,
    kind: "INVOICE" as const,
    companyId,
    status: "DRAFT" as const,
    counterpartyName: "warp2739-northgate",
  });

  it("accepts a local document with a customer and no connection", async () => {
    const doc = await prisma.erpDocument.create({ data: local() });
    expect(doc.origin).toBe("LOCAL");
    expect(doc.connectionId).toBeNull();
    expect(doc.externalId).toBeNull();
    expect(doc.status).toBe("DRAFT");
    expect(doc.vendorStatus).toBeNull();
  });

  it("🔴 refuses a LOCAL document that borrows a connection", async () => {
    await expect(
      prisma.erpDocument.create({ data: { ...local(), connectionId } }),
    ).rejects.toThrow(/ErpDocument_provenance/);
  });

  it("🔴 refuses a LOCAL document that carries a vendor id", async () => {
    await expect(
      prisma.erpDocument.create({
        data: { ...local(), externalSystem: "warp2739-vendor", externalId: "x" },
      }),
    ).rejects.toThrow(/ErpDocument_provenance/);
  });

  it("🔴 refuses a LOCAL document with no lifecycle", async () => {
    const { status: _drop, ...noStatus } = local();
    await expect(prisma.erpDocument.create({ data: noStatus })).rejects.toThrow(
      /ErpDocument_provenance/,
    );
  });

  it("accepts a landed document with complete provenance", async () => {
    const doc = await prisma.erpDocument.create({ data: landed() });
    expect(doc.origin).toBe("LANDED");
    expect(doc.status).toBeNull();
    expect(doc.vendorStatus).toBe("Open");
  });

  it("🔴 refuses a LANDED document missing any provenance field", async () => {
    for (const missing of ["connectionId", "externalSystem", "externalId"] as const) {
      const data: Record<string, unknown> = { ...landed() };
      delete data[missing];
      await expect(
        prisma.erpDocument.create({ data: data as never }),
      ).rejects.toThrow(/ErpDocument_provenance|violates not-null|Argument/);
    }
  });

  it("🔴 refuses a LANDED document that claims one of OUR lifecycle states", async () => {
    // The vendor owns its state. A landed row with `status: 'PAID'` would be
    // this box asserting something about a document it did not decide.
    await expect(
      prisma.erpDocument.create({ data: { ...landed(), status: "PAID" } }),
    ).rejects.toThrow(/ErpDocument_provenance/);
  });

  it("🔴 refuses a LOCAL document that also carries a vendor's word", async () => {
    await expect(
      prisma.erpDocument.create({ data: { ...local(), vendorStatus: "Open" } }),
    ).rejects.toThrow(/ErpDocument_provenance/);
  });

  it("lets two local documents coexist with no vendor id between them", async () => {
    // The reconcile unique index is `(connectionId, kind, externalId)`, and
    // Postgres treats NULLs as distinct. If that ever changed, the SECOND local
    // invoice on a box would fail to save — silently, and only in production.
    await prisma.erpDocument.create({ data: local() });
    await expect(prisma.erpDocument.create({ data: local() })).resolves.toBeDefined();
  });

  it("🔴 a customer with local documents cannot be deleted out from under them", async () => {
    // `companyId` is ON DELETE SET NULL, so the database will happily orphan
    // the document. The refusal lives in `deleteCompany` — and this asserts the
    // database behaviour it is compensating for, so that a future change to
    // RESTRICT is noticed here rather than assumed.
    const doc = await prisma.erpDocument.create({ data: local() });
    await prisma.crmCompany.delete({ where: { id: companyId } });
    const after = await prisma.erpDocument.findUnique({ where: { id: doc.id } });
    expect(after?.companyId).toBeNull();
  });

  it("the six-value kind enum is what the column holds", async () => {
    for (const kind of ["QUOTE", "ORDER", "INVOICE", "BILL", "CREDIT_NOTE", "RECEIPT"] as const) {
      const doc = await prisma.erpDocument.create({ data: { ...local(), kind } });
      expect(doc.kind).toBe(kind);
    }
    // And the direction words the old enum used are gone from the type.
    const values = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'ErpDocumentKind'`,
    );
    const labels = values.map((v) => v.enumlabel);
    expect(labels).not.toContain("RECEIVABLE");
    expect(labels).not.toContain("PAYABLE");
    expect(labels).toHaveLength(6);
  });
});
