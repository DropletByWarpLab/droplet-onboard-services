/**
 * WARP-2751 (ADR-051) — the money time axis, against real Postgres.
 *
 * 🔴 THIS FILE IS THE PROOF. `money-snapshot.test.ts` pins the control flow
 * around two raw SQL statements; a mocked `$executeRaw` returns what it was
 * told and cannot tell you whether the SQL parses, whether the parameters have
 * inferable types, whether `ON CONFLICT` names the right index, or whether the
 * window function keeps the row it claims to keep. Every one of those is a way
 * this feature can be silently dead, and only a real database refuses.
 *
 * What these cases pin:
 *
 *   idempotency   — the 15-minute cadence must produce ONE row per day, and
 *                   the row must converge on the day's LAST-SEEN value. This
 *                   is the whole reason `@@unique([capturedOn, ...])` exists.
 *   the point     — yesterday's balance must survive today's in-place
 *                   overwrite of `ErpDocument`. If it does not, the table has
 *                   no reason to exist.
 *   status split  — `vendorStatus` on a LANDED row, `status` on a LOCAL one,
 *                   mutually exclusive by `ErpDocument_provenance`. A snapshot
 *                   that read only one column would leave half the ledger's
 *                   history blank, and the brain epic already shipped exactly
 *                   that bug once.
 *   downsample    — beyond the window the MONTH'S LAST row survives. Keeping
 *                   the first instead would shift every historical series by
 *                   up to a month, which is the kind of wrong that looks right.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL like every other `*.pg.test.ts`.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 *
 * FIXTURE SCOPING — this DB is shared and the lane runs --no-file-parallelism.
 * `ErpDocument` rows are namespaced `warp2751-`. `MoneySnapshot` cannot be
 * namespaced the same way (its columns are all values, and an UNSCOPED capture
 * deliberately snapshots every document in the database, including other
 * suites'), so every date this file uses is in 2030-2031 and cleanup is scoped
 * to that range. Never an unscoped deleteMany, never a TRUNCATE.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  captureMoneySnapshots,
  trimMoneySnapshots,
  SUBJECT_ERP_DOCUMENT,
} from "../services/erp-sync/money-snapshot.service";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const P = "warp2751-";
const OURS = { startsWith: P } as const;

/** Every date this suite touches lives here, so cleanup can be scoped by date
 *  without an unscoped delete. */
const ERA_START = new Date("2030-01-01T00:00:00.000Z");
const ERA_END = new Date("2032-01-01T00:00:00.000Z");

const DAY_1 = new Date("2031-06-15T09:00:00.000Z");
const DAY_1_LATER = new Date("2031-06-15T23:45:00.000Z");
const DAY_2 = new Date("2031-06-16T09:00:00.000Z");

describe.skipIf(!RUN)("MoneySnapshot — real Postgres (WARP-2751)", () => {
  let prisma: PrismaClient;
  let connectionId: string;
  let companyId: string;
  let seq = 0;

  beforeAll(async () => {
    // `setup.ts` mocks `@prisma/client` GLOBALLY for the DB-less lane, so a
    // plain `new PrismaClient()` returns the mock and every assertion below
    // would be vacuous. The `entity-link.pg.test.ts` pattern.
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

  /** A vendor-synced document. The provenance CHECK requires the whole landed
   *  triple and forbids the box's own lifecycle on it. */
  async function landed(over: { balance?: string; vendorStatus?: string | null } = {}) {
    return prisma.erpDocument.create({
      data: {
        origin: "LANDED",
        kind: "INVOICE",
        connectionId,
        externalSystem: `${P}quickbooks`,
        externalId: `${P}ext-${seq++}`,
        counterpartyName: `${P}northgate`,
        vendorStatus: over.vendorStatus === undefined ? "Open" : over.vendorStatus,
        dueAt: DAY_1,
        amount: "5000.00",
        balance: over.balance ?? "4000.00",
        currency: "USD",
      },
      select: { id: true },
    });
  }

  /** A document this box created: no connection, no vendor word, our own
   *  lifecycle REQUIRED. */
  async function local(status: "SENT" | "PAID" = "SENT") {
    return prisma.erpDocument.create({
      data: {
        origin: "LOCAL",
        kind: "INVOICE",
        companyId,
        status,
        counterpartyName: `${P}northgate`,
        dueAt: DAY_1,
        amount: "900.00",
        balance: "900.00",
        currency: "USD",
      },
      select: { id: true },
    });
  }

  const rowsFor = async (subjectId: string) =>
    prisma.moneySnapshot.findMany({
      where: { subjectId },
      orderBy: { capturedOn: "asc" },
    });

  // ── the statement runs at all ────────────────────────────────────────────

  it("captures a row, which proves the SQL parses and every parameter has a type", async () => {
    // A bare placeholder in a SELECT list has nothing to infer from and
    // Postgres answers "could not determine data type of parameter" rather
    // than guessing; gen_random_uuid() is a uuid and the column is TEXT. Both
    // are invisible to a mock and fatal here.
    const doc = await landed();
    const out = await captureMoneySnapshots(prisma as never, { now: DAY_1 });
    expect(out.error).toBeNull();
    expect(out.captured).toBeGreaterThan(0);

    const rows = await rowsFor(doc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectType).toBe(SUBJECT_ERP_DOCUMENT);
    expect(String(rows[0]!.balance)).toBe("4000");
    expect(rows[0]!.currency).toBe("USD");
  });

  // ── idempotency: the AC ──────────────────────────────────────────────────

  it("twelve ticks in ONE day produce exactly ONE row", async () => {
    const doc = await landed();
    for (let i = 0; i < 12; i++) {
      await captureMoneySnapshots(prisma as never, { now: DAY_1, connectionId });
    }
    expect(await rowsFor(doc.id)).toHaveLength(1);
  });

  it("the day's row converges on the LAST-SEEN value, not the first", async () => {
    // The sync tick overwrites ErpDocument in place all day. The snapshot for
    // that day must be the day's closing value — which is what ON CONFLICT DO
    // UPDATE buys. DO NOTHING would freeze the morning's number instead.
    const doc = await landed({ balance: "4000.00" });
    await captureMoneySnapshots(prisma as never, { now: DAY_1, connectionId });

    await prisma.erpDocument.update({
      where: { id: doc.id },
      data: { balance: "2500.00", vendorStatus: "Part paid" },
    });
    await captureMoneySnapshots(prisma as never, { now: DAY_1_LATER, connectionId });

    const rows = await rowsFor(doc.id);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.balance)).toBe("2500");
    expect(rows[0]!.status).toBe("Part paid");
  });

  // ── the point of the table ───────────────────────────────────────────────

  it("YESTERDAY survives today's in-place overwrite — the reason this table exists", async () => {
    const doc = await landed({ balance: "4000.00" });
    await captureMoneySnapshots(prisma as never, { now: DAY_1, connectionId });

    // The next day's tick destroys the old number on ErpDocument.
    await prisma.erpDocument.update({ where: { id: doc.id }, data: { balance: "1000.00" } });
    await captureMoneySnapshots(prisma as never, { now: DAY_2, connectionId });

    const rows = await rowsFor(doc.id);
    expect(rows).toHaveLength(2);
    expect(String(rows[0]!.balance)).toBe("4000");
    expect(String(rows[1]!.balance)).toBe("1000");
    // And the live row really was overwritten — otherwise this test would pass
    // for the wrong reason.
    const live = await prisma.erpDocument.findUnique({ where: { id: doc.id } });
    expect(String(live!.balance)).toBe("1000");
  });

  it("answers a 90-day series for one subject in ONE query", async () => {
    const doc = await landed();
    for (let d = 0; d < 5; d++) {
      const at = new Date(DAY_1.getTime() + d * 86_400_000);
      await prisma.erpDocument.update({
        where: { id: doc.id },
        data: { balance: `${1000 * (d + 1)}.00` },
      });
      await captureMoneySnapshots(prisma as never, { now: at, connectionId });
    }
    const series = await prisma.moneySnapshot.findMany({
      where: {
        subjectType: SUBJECT_ERP_DOCUMENT,
        subjectId: doc.id,
        capturedOn: { gte: DAY_1 },
      },
      orderBy: { capturedOn: "asc" },
      select: { capturedOn: true, balance: true },
    });
    expect(series).toHaveLength(5);
    expect(series.map((r) => String(r.balance))).toEqual([
      "1000",
      "2000",
      "3000",
      "4000",
      "5000",
    ]);
  });

  // ── the two status columns ───────────────────────────────────────────────

  it("takes the VENDOR's word on a landed row and the BOX's lifecycle on a local one", async () => {
    // They are mutually exclusive by `ErpDocument_provenance`, so COALESCE is
    // exact. Reading only `status` would leave every landed row's history
    // blank; reading only `vendorStatus` would blank every local one.
    const landedDoc = await landed({ vendorStatus: "Open" });
    const localDoc = await local("SENT");
    await captureMoneySnapshots(prisma as never, { now: DAY_1 });

    expect((await rowsFor(landedDoc.id))[0]!.status).toBe("Open");
    expect((await rowsFor(localDoc.id))[0]!.status).toBe("SENT");
  });

  it("records a NULL status rather than inventing one", async () => {
    const doc = await landed({ vendorStatus: null });
    await captureMoneySnapshots(prisma as never, { now: DAY_1 });
    expect((await rowsFor(doc.id))[0]!.status).toBeNull();
  });

  // ── scoping ──────────────────────────────────────────────────────────────

  it("a connection-scoped capture does NOT reach a local document", async () => {
    const localDoc = await local();
    await captureMoneySnapshots(prisma as never, { now: DAY_1, connectionId });
    expect(await rowsFor(localDoc.id)).toHaveLength(0);
  });

  it("an UNSCOPED capture does — the only path a local document has to history", async () => {
    const localDoc = await local();
    await captureMoneySnapshots(prisma as never, { now: DAY_1 });
    expect(await rowsFor(localDoc.id)).toHaveLength(1);
  });

  // ── the downsample ───────────────────────────────────────────────────────

  /** Write a snapshot row directly, so a multi-month history can exist without
   *  simulating a year of ticks. */
  async function snapshotOn(subjectId: string, day: string, balance: string) {
    await prisma.moneySnapshot.create({
      data: {
        capturedOn: new Date(`${day}T00:00:00.000Z`),
        subjectType: SUBJECT_ERP_DOCUMENT,
        subjectId,
        balance,
        currency: "USD",
      },
    });
  }

  it("collapses each old month to its LAST row and leaves the window untouched", async () => {
    const doc = await landed();
    // Two old months, three rows each.
    for (const [day, bal] of [
      ["2030-01-05", "100"],
      ["2030-01-15", "200"],
      ["2030-01-28", "300"],
      ["2030-02-03", "400"],
      ["2030-02-19", "500"],
      ["2030-02-27", "600"],
    ] as const) {
      await snapshotOn(doc.id, day, bal);
    }
    // Two rows INSIDE the 90-day window ending 2031-06-15.
    await snapshotOn(doc.id, "2031-05-20", "700");
    await snapshotOn(doc.id, "2031-06-01", "800");

    const out = await trimMoneySnapshots(prisma as never, 90, DAY_1);
    expect(out.skipped).toBe(false);
    expect(out.deleted).toBe(4);

    const left = (await rowsFor(doc.id)).map((r) => String(r.balance));
    // January keeps the 28th, February keeps the 27th — the months' CLOSING
    // values. Keeping the first of each month instead would shift the series.
    expect(left).toEqual(["300", "600", "700", "800"]);
  });

  it("keeps every daily row when the window is 0 — the explicit keep-forever stance", async () => {
    const doc = await landed();
    await snapshotOn(doc.id, "2030-01-05", "100");
    await snapshotOn(doc.id, "2030-01-15", "200");

    const out = await trimMoneySnapshots(prisma as never, 0, DAY_1);
    expect(out).toEqual({ deleted: 0, skipped: true });
    expect(await rowsFor(doc.id)).toHaveLength(2);
  });

  it("downsamples each SUBJECT independently", async () => {
    // A PARTITION BY that forgot the subject would keep one row per month
    // across the whole box and delete most of every other document's history.
    const a = await landed();
    const b = await landed();
    for (const id of [a.id, b.id]) {
      await snapshotOn(id, "2030-01-05", "100");
      await snapshotOn(id, "2030-01-25", "200");
    }
    await trimMoneySnapshots(prisma as never, 90, DAY_1);
    expect(await rowsFor(a.id)).toHaveLength(1);
    expect(await rowsFor(b.id)).toHaveLength(1);
  });

  it("is idempotent — a second trim over an already-thin tail deletes nothing", async () => {
    const doc = await landed();
    await snapshotOn(doc.id, "2030-01-05", "100");
    await snapshotOn(doc.id, "2030-01-25", "200");
    await trimMoneySnapshots(prisma as never, 90, DAY_1);
    const second = await trimMoneySnapshots(prisma as never, 90, DAY_1);
    expect(second.deleted).toBe(0);
    expect(await rowsFor(doc.id)).toHaveLength(1);
  });

  it("respects maxRows so one run cannot blow the advisory-lock budget", async () => {
    const doc = await landed();
    for (const day of ["2030-01-05", "2030-01-10", "2030-01-15", "2030-01-20", "2030-01-25"]) {
      await snapshotOn(doc.id, day, "100");
    }
    // Four are redundant; the cap stops after two and the rest drains later.
    const out = await trimMoneySnapshots(prisma as never, 90, DAY_1, {
      batchSize: 1,
      maxRows: 2,
    });
    expect(out.deleted).toBe(2);
    expect(await rowsFor(doc.id)).toHaveLength(3);
  });
});
