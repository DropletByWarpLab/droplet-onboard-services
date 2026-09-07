/**
 * WARP-2825 (ADR-051) — the receivables ageing detector, against real Postgres.
 *
 * 🔴 THIS FILE IS THE PROOF, and it has to be. The detector is ONE raw SQL
 * statement: a CTE with a FILTER aggregate, a self-join back to `ErpDocument`,
 * an `IN (anchor, latest)` over dates, `IS NOT DISTINCT FROM` for a nullable
 * currency, and a `<> ALL(text[])` array parameter. A mocked `$queryRaw`
 * returns whatever it was handed and cannot tell you whether any of that
 * parses, whether the parameters have inferable types, or whether the join
 * counts the rows it claims to.
 *
 * This is not a hypothetical. `money-overdue.ts` shipped a query naming an enum
 * value that no longer existed and stayed green, because its unit test handed
 * it a `findMany` mock that ignores `where` (WARP-2773/2754). The same mistake
 * in this file would be invisible in exactly the same way.
 *
 * What these cases pin, beyond "the SQL runs":
 *
 *   overdue-as-of-day  — a document counts at an endpoint only if it was
 *                        already past due ON THAT DAY. Evaluating overdue as
 *                        of today at both ends would report a rise every time
 *                        an invoice crosses its due date, which is most weeks.
 *   short series       — a span under MIN_SERIES_DAYS produces NOTHING. This
 *                        is the honesty guard: a three-day-old box must not
 *                        compare Tuesday with Friday and call it a month.
 *   historical status  — the settled filter reads the SNAPSHOT's status, not
 *                        the document's today, so an invoice paid last week
 *                        was still outstanding a month ago.
 *   per currency       — USD and EUR are separate findings and are never
 *                        summed. A cross-currency total is wrong invisibly.
 *   both gates         — ratio AND absolute increase must clear.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL like every other `*.pg.test.ts`.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 *
 * FIXTURE SCOPING — this DB is shared and the lane runs --no-file-parallelism.
 * `ErpDocument` rows are namespaced `warp2825-`. `MoneySnapshot` rows cannot be
 * namespaced (every column is a value), so this suite owns the 2033-2034 era —
 * distinct from money-snapshot.pg.test.ts's 2030-2031 — and cleanup is scoped
 * to that range. Never an unscoped deleteMany, never a TRUNCATE.
 *
 * 🔴 The detector's `bounds` CTE takes MIN/MAX over EVERY `erp_document`
 * snapshot, because in production that is the whole point. So a stray row from
 * another suite outside this era would move `latest` and these assertions would
 * FAIL rather than pass wrongly — loud, which is the right failure.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { receivablesAgeing, MIN_SERIES_DAYS } from "../services/brain/detectors/receivables-ageing";
import { SUBJECT_ERP_DOCUMENT } from "../services/erp-sync/money-snapshot.service";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const P = "warp2825-";
const OURS = { startsWith: P } as const;

const ERA_START = new Date("2033-01-01T00:00:00.000Z");
const ERA_END = new Date("2034-01-01T00:00:00.000Z");

/** The two endpoints. 40 days apart, comfortably over MIN_SERIES_DAYS and
 *  inside the 90-day daily-retention window. */
const THEN = new Date("2033-05-01T00:00:00.000Z");
const NOW = new Date("2033-06-10T00:00:00.000Z");

describe.skipIf(!RUN)("receivables ageing — real Postgres (WARP-2825)", () => {
  let prisma: PrismaClient;
  let connectionId: string;
  let companyId: string;
  let seq = 0;

  beforeAll(async () => {
    // `setup.ts` mocks `@prisma/client` GLOBALLY for the DB-less lane, so a
    // plain `new PrismaClient()` would return the mock and every assertion
    // below would be vacuous. The money-snapshot.pg.test.ts pattern.
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup() {
    await prisma.moneySnapshot.deleteMany({
      where: { capturedOn: { gte: ERA_START, lt: ERA_END } },
    });
    await prisma.erpDocument.deleteMany({ where: { counterpartyName: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    await prisma.integrationConnection.deleteMany({ where: { secretRef: OURS } });
  }

  beforeEach(async () => {
    await cleanup();
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

  /** A vendor-synced receivable. `dueAt` decides which endpoints it counts at. */
  async function invoice(dueAt: Date, currency = "USD") {
    return prisma.erpDocument.create({
      data: {
        origin: "LANDED",
        kind: "INVOICE",
        connectionId,
        externalSystem: `${P}quickbooks`,
        externalId: `${P}ext-${seq++}`,
        counterpartyName: `${P}northgate`,
        vendorStatus: "Open",
        dueAt,
        amount: "50000.00",
        balance: "50000.00",
        currency,
      },
      select: { id: true },
    });
  }

  /** A bill — money the business OWES. Must never appear in receivables. */
  async function bill(dueAt: Date) {
    return prisma.erpDocument.create({
      data: {
        origin: "LANDED",
        kind: "BILL",
        connectionId,
        externalSystem: `${P}quickbooks`,
        externalId: `${P}ext-${seq++}`,
        counterpartyName: `${P}northgate`,
        vendorStatus: "Open",
        dueAt,
        amount: "90000.00",
        balance: "90000.00",
        currency: "USD",
      },
      select: { id: true },
    });
  }

  /** A document this box wrote. Born DRAFT, never chased as a vendor debt. */
  async function localInvoice(dueAt: Date) {
    return prisma.erpDocument.create({
      data: {
        origin: "LOCAL",
        kind: "INVOICE",
        companyId,
        status: "SENT",
        counterpartyName: `${P}northgate`,
        dueAt,
        amount: "70000.00",
        balance: "70000.00",
        currency: "USD",
      },
      select: { id: true },
    });
  }

  /** Write one day's snapshot row directly — the detector reads the series, it
   *  does not care which writer produced it, and this lets a case place an
   *  exact balance on an exact day. */
  async function snap(
    docId: string,
    day: Date,
    balance: string,
    over: { currency?: string; status?: string | null } = {},
  ) {
    await prisma.moneySnapshot.create({
      data: {
        capturedOn: day,
        subjectType: SUBJECT_ERP_DOCUMENT,
        subjectId: docId,
        amount: balance,
        balance,
        currency: over.currency ?? "USD",
        status: over.status === undefined ? "Open" : over.status,
      },
    });
  }

  const run = () => receivablesAgeing.run(prisma, NOW);

  it("reports a growing overdue book, with the INCREASE as its impact", async () => {
    // Overdue on both days (due before THEN), and the balance grew.
    const a = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(a.id, THEN, "10000.00");
    await snap(a.id, NOW, "30000.00");

    const found = await run();
    expect(found).toHaveLength(1);
    const f = found[0]!;
    expect(f.subjectKey).toBe("USD");
    expect(f.kind).toBe("risk");
    // +20,000.00 USD, in minor units.
    expect(f.impactMinor).toBe(2_000_000n);
    expect(f.currency).toBe("USD");
    expect(f.title).toContain("200%");
    // Both endpoints are cited, so a reviewer can re-query the series.
    expect(f.evidence.sources).toHaveLength(2);
    expect(f.evidence.sources[0]!.sourceId).toContain("2033-05-01");
    expect(f.evidence.sources[1]!.sourceId).toContain("2033-06-10");
  });

  it("does NOT count a document that was not yet overdue at the anchor", async () => {
    // Due AFTER the anchor day: it belongs to the NOW total only. Without the
    // as-of-day rule this would be counted at both ends and the book would look
    // flat; with it, the rise is real and attributable.
    const old = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(old.id, THEN, "10000.00");
    await snap(old.id, NOW, "10000.00");

    const fresh = await invoice(new Date("2033-06-01T00:00:00.000Z"));
    await snap(fresh.id, THEN, "40000.00"); // present in the series, NOT yet due
    await snap(fresh.id, NOW, "40000.00");

    const found = await run();
    expect(found).toHaveLength(1);
    // then = 10,000 (old only) ; now = 50,000 (both) -> +40,000.00
    expect(found[0]!.impactMinor).toBe(4_000_000n);
  });

  it("returns NOTHING when the series is shorter than MIN_SERIES_DAYS", async () => {
    // The honesty guard. Both endpoints exist and the book tripled, but three
    // days is not a trend and must not be described as one.
    const near = new Date(NOW.getTime() - 3 * 86_400_000);
    const a = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(a.id, near, "10000.00");
    await snap(a.id, NOW, "90000.00");

    expect(MIN_SERIES_DAYS).toBeGreaterThan(3);
    await expect(run()).resolves.toEqual([]);
  });

  it("reads the SNAPSHOT's status, not the document's today", async () => {
    // Settled on the anchor day, open now: it contributed nothing then and
    // everything now. Reading today's word at both ends would erase the past.
    const a = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(a.id, THEN, "10000.00", { status: "Paid" });
    await snap(a.id, NOW, "10000.00", { status: "Open" });

    const b = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(b.id, THEN, "8000.00");
    await snap(b.id, NOW, "8000.00");

    const found = await run();
    expect(found).toHaveLength(1);
    // then = 8,000 (b only, a was Paid) ; now = 18,000 -> +10,000.00
    expect(found[0]!.impactMinor).toBe(1_000_000n);
  });

  it("keeps currencies apart — never one summed total", async () => {
    const usd = await invoice(new Date("2033-04-01T00:00:00.000Z"), "USD");
    await snap(usd.id, THEN, "10000.00", { currency: "USD" });
    await snap(usd.id, NOW, "30000.00", { currency: "USD" });

    const eur = await invoice(new Date("2033-04-01T00:00:00.000Z"), "EUR");
    await snap(eur.id, THEN, "5000.00", { currency: "EUR" });
    await snap(eur.id, NOW, "20000.00", { currency: "EUR" });

    const found = await run();
    expect(found).toHaveLength(2);
    const keys = found.map((f) => f.subjectKey).sort();
    expect(keys).toEqual(["EUR", "USD"]);
    const byKey = Object.fromEntries(found.map((f) => [f.subjectKey, f]));
    expect(byKey.USD!.impactMinor).toBe(2_000_000n); // +20,000.00
    expect(byKey.EUR!.impactMinor).toBe(1_500_000n); // +15,000.00
  });

  it("ignores BILLs — those are money owed BY the business", async () => {
    const a = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(a.id, THEN, "10000.00");
    await snap(a.id, NOW, "10000.00");

    const b = await bill(new Date("2033-04-01T00:00:00.000Z"));
    await snap(b.id, THEN, "1000.00");
    await snap(b.id, NOW, "90000.00");

    // Receivables were flat. Only the payable moved, and it is not this
    // detector's subject.
    await expect(run()).resolves.toEqual([]);
  });

  it("ignores LOCAL documents, like its sibling does", async () => {
    const a = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(a.id, THEN, "10000.00");
    await snap(a.id, NOW, "10000.00");

    const l = await localInvoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(l.id, THEN, "1000.00");
    await snap(l.id, NOW, "80000.00");

    await expect(run()).resolves.toEqual([]);
  });

  it("stays silent when the book SHRANK", async () => {
    const a = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(a.id, THEN, "40000.00");
    await snap(a.id, NOW, "10000.00");
    await expect(run()).resolves.toEqual([]);
  });

  it("stays silent on a rise below the ratio gate", async () => {
    // +10%: a book breathing, not a book ageing.
    const a = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(a.id, THEN, "100000.00");
    await snap(a.id, NOW, "110000.00");
    await expect(run()).resolves.toEqual([]);
  });

  it("stays silent on a big ratio whose absolute increase is trivial", async () => {
    // Up 300% — and by four dollars. Both gates must clear, and this is why.
    const a = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(a.id, THEN, "2.00");
    await snap(a.id, NOW, "8.00");
    await expect(run()).resolves.toEqual([]);
  });

  it("skips a zero-balance snapshot row", async () => {
    const a = await invoice(new Date("2033-04-01T00:00:00.000Z"));
    await snap(a.id, THEN, "0.00");
    await snap(a.id, NOW, "0.00");
    await expect(run()).resolves.toEqual([]);
  });

  it("returns nothing at all when there is no series", async () => {
    // A box that has never synced. Not an error, not a zero — nothing.
    await expect(run()).resolves.toEqual([]);
  });
});
