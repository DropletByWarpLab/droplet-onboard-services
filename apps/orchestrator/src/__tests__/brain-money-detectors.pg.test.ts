/**
 * WARP-2754 (ADR-051) — the money detectors, against real Postgres.
 *
 * 🔴 WHY THIS FILE EXISTS, in one sentence: a mocked Prisma accepts an enum
 * value that does not exist, and that is exactly how both money detectors
 * shipped to stage dead.
 *
 * The sequence is worth keeping, because nothing in it was anybody being
 * careless. #2033 wrote `where: { kind: "RECEIVABLE" }` when RECEIVABLE was a
 * real member of `ErpDocumentKind`. #2023 then widened that enum to the six
 * real document types and moved receivable/payable to a derived DIRECTION. Both
 * PRs were green on their own branch; only their merge was broken, and the
 * stage push does not re-run the unit lane. At runtime Prisma refuses an
 * unknown enum member, so every nightly pass threw and the loss-catching
 * feature caught nothing — silently, because a detector that throws is caught
 * by the pass runner and recorded as a `lastError` nobody reads.
 *
 * The mocked detector tests could not have caught any of it. `vi.fn()` returns
 * whatever it was told to return no matter what filter it was handed. Only a
 * real database refuses a real bad query, which is why these cases live here.
 *
 * The three regressions each case pins:
 *
 *   kind drift      the detectors name INVOICE and BILL, which are members
 *                   `ErpDocumentKind` actually has. The version that shipped
 *                   named RECEIVABLE and PAYABLE, which the enum had stopped
 *                   having hours earlier — and Prisma refuses an unknown enum
 *                   member at RUNTIME, so both detectors threw on every pass
 *                   and the loss-catching feature caught nothing. If anyone
 *                   re-inlines a stale literal, the cases below fail against a
 *                   real schema instead of shipping quietly.
 *   status rename   WARP-2739 gave `status` to the box's own lifecycle and
 *                   moved the vendor's word to `vendorStatus`. Reading the old
 *                   name still TYPE-CHECKS — the column exists, it just means
 *                   something else and is NULL on every landed row — so the
 *                   paid-invoice cases are the only thing standing between an
 *                   operator and a confident loss claim about money they have
 *                   already collected.
 *   allow-list      QUOTE and ORDER are not money owed. An unaccepted quote
 *                   inside a loss total is the most misleading number this
 *                   feature could produce.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL like every other `*.pg.test.ts`.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 *
 * FIXTURE SCOPING — this DB is shared by the pg suites and the lane runs
 * --no-file-parallelism. Every row is namespaced `warp2754-` and every cleanup
 * is scoped to that prefix. Never an unscoped deleteMany, never a TRUNCATE
 * (the access-role.pg.test.ts rule). Assertions look their own subject up by id
 * rather than asserting a total, so another suite's leftover row cannot turn a
 * real pass into a spurious failure.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { overdueReceivables, overduePayables } from "../services/brain/detectors/money-overdue";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const P = "warp2754-";
const OURS = { startsWith: P } as const;

/** Fixed clock. `Date.now()` in a fixture makes a test that passes today and
 *  fails on the day the machine's timezone shifts the boundary. */
const NOW = new Date("2026-06-01T00:00:00.000Z");
/** 90 days before NOW — comfortably past due, so `days > 0` is never a
 *  rounding argument. */
const LONG_PAST_DUE = new Date("2026-03-03T00:00:00.000Z");

describe.skipIf(!RUN)("Money detectors — real Postgres (WARP-2754)", () => {
  let prisma: PrismaClient;
  let connectionId: string;
  let companyId: string;
  let seq = 0;

  beforeAll(async () => {
    // `setup.ts` mocks `@prisma/client` GLOBALLY for the DB-less lane, so a
    // plain `new PrismaClient()` here returns the mock and every assertion
    // below would be vacuous. This is the `entity-link.pg.test.ts` pattern.
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.erpDocument.deleteMany({ where: { counterpartyName: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    await prisma.integrationConnection.deleteMany({ where: { secretRef: OURS } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // FK order: documents, then the company they point at, then the connection
    // they reference with RESTRICT.
    await prisma.erpDocument.deleteMany({ where: { counterpartyName: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    await prisma.integrationConnection.deleteMany({ where: { secretRef: OURS } });

    connectionId = (
      await prisma.integrationConnection.create({
        data: {
          provider: `${P}quickbooks`,
          status: "CONNECTED",
          host: `${P}host`,
          databaseName: "",
          secretRef: `${P}secret`,
        },
        select: { id: true },
      })
    ).id;
    companyId = (
      await prisma.crmCompany.create({ data: { name: `${P}customer` }, select: { id: true } })
    ).id;
  });

  /** A vendor-synced document. `ErpDocument_provenance` requires the whole
   *  landed triple and forbids our own lifecycle on it. */
  async function landed(over: {
    kind: "INVOICE" | "BILL" | "QUOTE" | "ORDER" | "CREDIT_NOTE" | "RECEIPT";
    vendorStatus?: string | null;
    balance?: string;
    currency?: string | null;
  }): Promise<string> {
    const doc = await prisma.erpDocument.create({
      data: {
        origin: "LANDED",
        kind: over.kind,
        connectionId,
        externalSystem: `${P}quickbooks`,
        externalId: `${P}ext-${seq++}`,
        counterpartyName: `${P}northgate`,
        vendorStatus: over.vendorStatus ?? null,
        dueAt: LONG_PAST_DUE,
        balance: over.balance ?? "4000.00",
        currency: over.currency === undefined ? "USD" : over.currency,
      },
      select: { id: true },
    });
    return doc.id;
  }

  /** A document this box created. No connection, no vendor word, and our own
   *  lifecycle is REQUIRED — again per the provenance CHECK. */
  async function local(status: "DRAFT" | "SENT" | "PART_PAID" | "PAID"): Promise<string> {
    const doc = await prisma.erpDocument.create({
      data: {
        origin: "LOCAL",
        kind: "INVOICE",
        companyId,
        status,
        counterpartyName: `${P}northgate`,
        dueAt: LONG_PAST_DUE,
        balance: "4000.00",
        currency: "USD",
      },
      select: { id: true },
    });
    return doc.id;
  }

  const subjects = async (which: typeof overdueReceivables) =>
    (await which.run(prisma, NOW)).map((f) => f.subjectKey);

  // ── the drift guard ──────────────────────────────────────────────────────

  it("finds an overdue LANDED invoice — the case that proves the query runs at all", async () => {
    // If anyone re-inlines a `kind` literal that the enum no longer has,
    // Prisma throws here rather than quietly returning nothing. That is the
    // whole point of this file: the mocked suite stayed green through exactly
    // that defect.
    const id = await landed({ kind: "INVOICE" });
    expect(await subjects(overdueReceivables)).toContain(id);
  });

  it("files an overdue BILL as a payable, not a receivable", async () => {
    const id = await landed({ kind: "BILL" });
    expect(await subjects(overduePayables)).toContain(id);
    expect(await subjects(overdueReceivables)).not.toContain(id);
  });

  it("calls a bill a RISK and an invoice a LOSS", async () => {
    // Money leaving late is not a loss; folding it into the loss total makes
    // the number on /brief meaningless.
    const invoice = await landed({ kind: "INVOICE" });
    const bill = await landed({ kind: "BILL" });
    const r = (await overdueReceivables.run(prisma, NOW)).find((f) => f.subjectKey === invoice);
    const p = (await overduePayables.run(prisma, NOW)).find((f) => f.subjectKey === bill);
    expect(r?.kind).toBe("loss");
    expect(p?.kind).toBe("risk");
  });

  // ── the status rename ────────────────────────────────────────────────────

  it("EXCLUDES an invoice the vendor says is paid", async () => {
    // 🔴 The regression that matters most. `status` is NULL on every landed
    // row since WARP-2739, so a detector reading it sees "no status = open"
    // and reports money the business already collected as an outstanding loss.
    const id = await landed({ kind: "INVOICE", vendorStatus: "Paid" });
    expect(await subjects(overdueReceivables)).not.toContain(id);
  });

  it("matches the vendor's word case-insensitively", async () => {
    // Vendor prose, not an enum: QuickBooks, Xero and Stripe disagree on caps.
    const id = await landed({ kind: "INVOICE", vendorStatus: "VOIDED" });
    expect(await subjects(overdueReceivables)).not.toContain(id);
  });

  it("still reports an invoice the vendor gave no status word", async () => {
    const id = await landed({ kind: "INVOICE", vendorStatus: null });
    expect(await subjects(overdueReceivables)).toContain(id);
  });

  it("EXCLUDES a LOCAL document entirely, whatever its lifecycle says", async () => {
    // 🔴 A DELIBERATE PRODUCT DECISION, not an oversight, and it is worth
    // stating because the obvious reading is that it is a gap. WARP-2773
    // scoped these detectors to `origin: LANDED` — vendor-synced money only.
    // A LOCAL document is one a person on this box wrote; it is born DRAFT,
    // and reporting it back to its own author as an unchased debt is the box
    // nagging someone about their own unfinished paperwork.
    //
    // The cost is real: a LOCAL invoice that WAS sent and IS 90 days overdue
    // produces no finding today. That is a separate detector — it has to key
    // on the send, which nothing records yet — and not a reason to widen this
    // one until it does.
    for (const status of ["SENT", "PART_PAID", "DRAFT", "PAID"] as const) {
      const id = await local(status);
      expect(
        await subjects(overdueReceivables),
        `local status ${status} must not be reported`,
      ).not.toContain(id);
    }
  });

  // ── the allow-list ───────────────────────────────────────────────────────

  it("EXCLUDES an overdue QUOTE from the loss total", async () => {
    // An unaccepted quote is a number the business has no claim to. Adding it
    // to "what you are owed" is the most misleading thing this feature could
    // say — money.service.ts makes the same argument for its own surface.
    const id = await landed({ kind: "QUOTE" });
    expect(await subjects(overdueReceivables)).not.toContain(id);
    expect(await subjects(overduePayables)).not.toContain(id);
  });

  it("EXCLUDES an overdue ORDER from both directions", async () => {
    const id = await landed({ kind: "ORDER" });
    expect(await subjects(overdueReceivables)).not.toContain(id);
    expect(await subjects(overduePayables)).not.toContain(id);
  });

  // ── prose and money, on real rows ────────────────────────────────────────

  it("names the vendor it came from, on a row that always has one", async () => {
    // `ErpDocument_provenance` makes `externalSystem` NON-NULL on every LANDED
    // row, and LANDED is all these detectors read — so the null-provenance
    // prose bug cannot occur here. Pinned anyway: if the origin filter is ever
    // widened, this is the case that starts failing instead of shipping "An
    // invoice from null fell due 90 days ago".
    const id = await landed({ kind: "INVOICE" });
    const f = (await overdueReceivables.run(prisma, NOW)).find((x) => x.subjectKey === id);
    expect(f?.rationale).not.toContain("null");
    expect(f?.rationale).toContain(P);
  });

  it("converts the vendor's decimal to minor units with the row's own currency", async () => {
    // JPY has no minor unit: 4000 yen is 4000 minor, not 400000. A hardcoded
    // hundredths conversion is wrong by 100x here and right for the USD case
    // beside it, which is why both are asserted.
    const usd = await landed({ kind: "INVOICE", balance: "4000.00", currency: "USD" });
    const jpy = await landed({ kind: "INVOICE", balance: "4000", currency: "JPY" });
    const found = await overdueReceivables.run(prisma, NOW);
    expect(found.find((f) => f.subjectKey === usd)?.impactMinor).toBe(400_000n);
    expect(found.find((f) => f.subjectKey === jpy)?.impactMinor).toBe(4_000n);
  });

  it("reports an overdue invoice with NO currency, without inventing an amount", async () => {
    // The debt is real; only the amount is unknowable. Dropping the finding
    // would hide a genuine overdue invoice, and guessing the exponent would
    // fabricate the number this module refuses to fabricate.
    const id = await landed({ kind: "INVOICE", currency: null });
    const f = (await overdueReceivables.run(prisma, NOW)).find((x) => x.subjectKey === id);
    expect(f).toBeDefined();
    expect(f?.impactMinor).toBeNull();
    expect(f?.currency).toBeNull();
  });

  it("skips a settled-but-unreaped row carrying a zero balance", async () => {
    // money.service.ts records that a document the vendor stops serving is not
    // reaped, so a zero-balance row can linger forever.
    const id = await landed({ kind: "INVOICE", balance: "0.00" });
    expect(await subjects(overdueReceivables)).not.toContain(id);
  });

  it("skips a document that is not yet due", async () => {
    const doc = await prisma.erpDocument.create({
      data: {
        origin: "LANDED",
        kind: "INVOICE",
        connectionId,
        externalSystem: `${P}quickbooks`,
        externalId: `${P}ext-future-${seq++}`,
        counterpartyName: `${P}northgate`,
        dueAt: new Date("2026-09-01T00:00:00.000Z"),
        balance: "4000.00",
        currency: "USD",
      },
      select: { id: true },
    });
    expect(await subjects(overdueReceivables)).not.toContain(doc.id);
  });
});
