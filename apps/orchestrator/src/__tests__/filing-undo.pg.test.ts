/**
 * WARP-2731 (ADR-048) — undo, against a real Postgres.
 *
 * 🔴 THE ARCHIVE-VS-DELETE BRANCH CANNOT BE PROVEN WITH A MOCK, and the ticket
 * says so for a reason with a scar on it. Every `CrmActivity` subject relation
 * is `onDelete: Cascade` and must be — the exactly-one-subject CHECK forbids an
 * orphan, so `SetNull` is unavailable — which makes deleting a company
 * silently a delete of every note a human typed against it.
 * `crm-activity-cascade.pg.test.ts` established that against real Postgres.
 *
 * A mocked Prisma has no cascade. The branch would "work" in a unit test with
 * the delete arm taking a human's notes with it every time, and the first
 * person to find out would be an owner who clicked Undo and lost a month of
 * their own writing.
 *
 * So the two cases here are:
 *
 *   only the machine's own CREATED row  → DELETE, and the row is gone.
 *   a human NOTE has since been added   → ARCHIVE, and the note SURVIVES.
 *
 * The second assertion — that the note is still readable afterwards — is the
 * one that matters. "It archived" is a status; "their words are still there"
 * is the promise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("undo, against a real database (WARP-2731)", () => {
  let prisma: PrismaClient;
  let undoProposal: typeof import("../services/filing/undo.service.js").undoProposal;
  let applyProposal: typeof import("../services/filing/apply.service.js").applyProposal;
  let FILING_ERRORS: typeof import("../services/filing/apply.service.js").FILING_ERRORS;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    ({ undoProposal } = await import("../services/filing/undo.service.js"));
    ({ applyProposal, FILING_ERRORS } = await import("../services/filing/apply.service.js"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const P = "warp2731-";

  async function cleanup() {
    await prisma.entityLink.deleteMany({ where: { filePath: { startsWith: `/${P}` } } });
    await prisma.filingDecision.deleteMany({ where: { keyValue: { startsWith: P } } });
    await prisma.crmActivity.deleteMany({ where: { summary: { startsWith: P } } });
    await prisma.ingestProposal.deleteMany({ where: { sourceRef: { startsWith: P } } });
    await prisma.crmCompany.deleteMany({ where: { name: { startsWith: P } } });
  }
  beforeEach(cleanup);
  afterAll(cleanup);

  const FILE = {
    ncFileId: 991100,
    filePath: `/${P}Customers/acme-invoice.pdf`,
    fileSpace: "files",
  };
  const ctx = { actorId: "u-owner", resolveFileId: async () => FILE.ncFileId };

  /** Apply a CREATE_CUSTOMER through the real service, so undo reverses
   *  exactly what the feature actually writes rather than a fixture's guess. */
  async function fileACustomer(suffix: string) {
    const row = await prisma.ingestProposal.create({
      data: {
        sourceKind: "FILE",
        sourceRef: `${P}file:${FILE.ncFileId}${suffix}`,
        ncFileId: FILE.ncFileId,
        kind: "CREATE_CUSTOMER",
        policyClass: "REVIEW",
        confidence: 93,
        phiVerdict: "CLEAN",
        matchKind: "NONE",
        payload: { name: `${P}ACME ${suffix}`, file: FILE },
        evidence: [{ quote: "ACME" }],
        extractorVersion: "filing-1",
        dedupeKey: `${P}acme-${suffix}`,
        requestedById: "u-owner",
      },
      select: { id: true },
    });
    // The applied result whole — it already carries `proposalId` alongside the
    // back-pointers, which is exactly what undo reverses through.
    return await applyProposal(prisma, row.id, ctx);
  }

  it("🔴 undo DELETES a customer that carries only the machine's own row", async () => {
    const { proposalId, createdCompanyId } = await fileACustomer("a");

    const result = await undoProposal(prisma, proposalId, "u-owner");
    expect(result.mode).toBe("delete");
    expect(result.companyRemoved).toBe(true);

    expect(
      await prisma.crmCompany.findUnique({ where: { id: createdCompanyId! } }),
    ).toBeNull();

    const after = await prisma.ingestProposal.findUniqueOrThrow({ where: { id: proposalId } });
    expect(after.status).toBe("UNDONE");
    expect(after.undoMode).toBe("delete");
    expect(after.undoneById).toBe("u-owner");
    // 🔴 `decidedById` SURVIVES. An undone proposal was applied by somebody
    // first, and undoing it does not unmake that — the schema's
    // `IngestProposal_decided_has_actor` CHECK includes UNDONE for this reason.
    expect(after.decidedById).toBe("u-owner");
    expect(after.evidence).toBeNull();
  });

  it("🔴 undo ARCHIVES when a human has written on it — and their note survives", async () => {
    const { proposalId, createdCompanyId } = await fileACustomer("b");

    // The owner adds a note the day after Droplet filed the customer.
    await prisma.crmActivity.create({
      data: {
        subjectType: "COMPANY",
        companyId: createdCompanyId!,
        kind: "NOTE",
        summary: `${P}rang them about the March order`,
        origin: "LOCAL",
        actorId: "u-owner",
      },
    });

    const result = await undoProposal(prisma, proposalId, "u-owner");
    expect(result.mode).toBe("archive");

    const company = await prisma.crmCompany.findUnique({ where: { id: createdCompanyId! } });
    expect(company).not.toBeNull();
    expect(company!.isArchived).toBe(true);

    // 🔴 THE ASSERTION THAT MATTERS. Not "it archived" — that is a status.
    // "Their words are still there" is the promise, and the delete arm would
    // have taken them via the cascade.
    const note = await prisma.crmActivity.findFirst({
      where: { companyId: createdCompanyId!, kind: "NOTE" },
    });
    expect(note).not.toBeNull();
    expect(note!.summary).toContain("rang them about the March order");
  });

  it("MUTATION: read the machine's own CREATED row as human prose — undo never deletes", async () => {
    // The CREATED row filing writes is `origin: EXTRACTED` (WARP-2730). At the
    // `LOCAL` default it would look like a human note on every filed customer,
    // the archive branch would always win, and undo could never clean up.
    const { createdCompanyId } = await fileACustomer("c");
    const created = await prisma.crmActivity.findFirstOrThrow({
      where: { companyId: createdCompanyId!, kind: "CREATED" },
    });
    expect(created.origin).toBe("EXTRACTED");
  });

  it("archives the link rather than deleting it, and remembers the correction", async () => {
    const { proposalId, createdEntityLinkId } = await fileACustomer("d");
    const result = await undoProposal(prisma, proposalId, "u-owner");

    const link = await prisma.entityLink.findUniqueOrThrow({
      where: { id: createdEntityLinkId! },
    });
    // The link row is the record that Droplet once filed this document here,
    // which the Rules page needs to explain itself. `isArchived` and
    // `archivedAt` move together (WARP-884).
    expect(link.isArchived).toBe(true);
    expect(link.archivedAt).not.toBeNull();

    // A CREATE_CUSTOMER's record is gone or archived, so there is nothing for
    // a NOT_SAME rule to point at — and a rule pointing at nothing is one the
    // owner finds later and cannot explain.
    expect(result.ruleWritten).toBe(false);
  });

  it("undoing twice is a 409, not a second reversal", async () => {
    const { proposalId } = await fileACustomer("e");
    await undoProposal(prisma, proposalId, "u-owner");
    await expect(undoProposal(prisma, proposalId, "u-owner")).rejects.toThrow(
      FILING_ERRORS.NOT_APPLIED,
    );
  });

  it("undo of a PENDING proposal is refused — there is nothing to reverse", async () => {
    const row = await prisma.ingestProposal.create({
      data: {
        sourceKind: "FILE",
        sourceRef: `${P}file:999`,
        ncFileId: 999,
        kind: "CREATE_CUSTOMER",
        policyClass: "REVIEW",
        confidence: 90,
        phiVerdict: "CLEAN",
        matchKind: "NONE",
        payload: { name: `${P}Never Applied` },
        extractorVersion: "filing-1",
        dedupeKey: `${P}never`,
        requestedById: "u-owner",
      },
      select: { id: true },
    });
    await expect(undoProposal(prisma, row.id, "u-owner")).rejects.toThrow(
      FILING_ERRORS.NOT_APPLIED,
    );
  });
});
