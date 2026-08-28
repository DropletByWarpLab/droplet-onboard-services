/**
 * WARP-2463 — the stored drift report.
 *
 * Three cases carry this story and none of them may be weakened:
 *
 *   "writes a row when the sweep was CLEAN"  — absence of a row must never be
 *     the signal. A table that only records misses cannot distinguish "the
 *     incremental path was trustworthy" from "no sweep ever ran", which are
 *     the two answers the whole story exists to keep apart.
 *   "never stores a record identifier"       — the PHI-free rule, tested with
 *     a vendor whose ORDERING KEY IS the invoice number. That is not a
 *     contrived fixture: Stripe's cursors are object ids.
 *   "resets the streak on a miss"            — the cadence is money (WARP-2383
 *     prices a naive Xero cadence at ~$2,676 AUD/mo for 200 orgs), and a
 *     streak that does not reset would keep lengthening the interval on a
 *     connection that is actively dropping records.
 *
 * Prisma is a `vi.fn()` store throughout — the team rule against mock-database
 * integration tests, after the mock/prod divergence incident.
 */
import { describe, it, expect, vi } from "vitest";

import {
  CLEAN_SWEEPS_PER_STEP,
  ERP_DRIFT_RETENTION_CRON,
  ERP_DRIFT_RETENTION_LOCK_KEY,
  classifyEntityDrift,
  cleanSweepStreak,
  driftForConnection,
  driftRowFor,
  recordEntityDrift,
  registerErpDriftRetention,
  sweepIntervalMsFor,
  trimErpDriftRecords,
  type ErpDriftPrisma,
} from "./drift-record.service.js";
import { diffForDrift, type ErpEntityDrift, type RecordIdentity } from "./reconcile.js";
import { isoInstant } from "./watermark.js";

const NOW = new Date("2026-08-28T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** A drift shape with everything defaulted, so each case states only its point. */
function drift(over: Partial<ErpEntityDrift> = {}): ErpEntityDrift {
  return {
    entity: "invoice",
    fullCount: 3,
    incrementalCount: 3,
    missedCount: 0,
    watermarkBehind: false,
    classes: [],
    earliestMissedAt: null,
    ...over,
  };
}

function driftPrisma(rows: Array<Record<string, unknown>> = []) {
  const store = rows.map((r) => ({ ...r }));
  const prisma = {
    __rows: store,
    erpDriftRecord: {
      create: vi.fn(async (args: any) => {
        store.push({ id: `d-${store.length + 1}`, ...args.data });
        return args.data;
      }),
      findMany: vi.fn(async (args: any) => {
        const w = args?.where ?? {};
        let out = store.filter((r) => {
          if (w.connectionId && r.connectionId !== w.connectionId) return false;
          const at = r.sweepAt as Date;
          if (w.sweepAt?.lt && !(at < w.sweepAt.lt)) return false;
          if (w.sweepAt?.gte && !(at >= w.sweepAt.gte)) return false;
          return true;
        });
        const dir = args?.orderBy?.sweepAt ?? "asc";
        out = out.sort((a, b) =>
          dir === "desc"
            ? (b.sweepAt as Date).getTime() - (a.sweepAt as Date).getTime()
            : (a.sweepAt as Date).getTime() - (b.sweepAt as Date).getTime(),
        );
        if (typeof args?.take === "number") out = out.slice(0, args.take);
        return out;
      }),
      deleteMany: vi.fn(async (args: any) => {
        const ids: string[] = args?.where?.id?.in ?? [];
        let count = 0;
        for (const id of ids) {
          const i = store.findIndex((r) => r.id === id);
          if (i >= 0) {
            store.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
  return prisma as unknown as ErpDriftPrisma & {
    __rows: Array<Record<string, unknown>>;
    erpDriftRecord: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
  };
}

/** One sweep's worth of rows, all sharing an instant. */
function sweepRows(
  sweepAt: Date,
  classifications: string[],
  connectionId = "conn-1",
): Array<Record<string, unknown>> {
  return classifications.map((classification, i) => ({
    id: `${sweepAt.getTime()}-${i}`,
    connectionId,
    provider: "xero",
    entity: i === 0 ? "invoice" : "bill",
    sweepAt,
    classification,
    missedCount: classification === "NONE" ? 0 : 1,
    fullCount: 3,
    incrementalCount: classification === "NONE" ? 3 : 2,
    watermarkAt: null,
    earliestMissedAt: null,
  }));
}

// ---------------------------------------------------------------------------
// Classification — one column that fully determines what the sweep found
// ---------------------------------------------------------------------------

describe("classifyEntityDrift", () => {
  it("maps a clean pass to the explicit NONE member", () => {
    expect(classifyEntityDrift(drift())).toBe("NONE");
  });

  it("maps each single class to its own member", () => {
    expect(classifyEntityDrift(drift({ classes: ["missed-newer"] }))).toBe("MISSED_NEWER");
    expect(classifyEntityDrift(drift({ classes: ["watermark-behind"] }))).toBe(
      "WATERMARK_BEHIND",
    );
  });

  it("keeps BOTH classes distinguishable from either one alone", () => {
    // MUTATION: fold the co-occurrence onto MISSED_NEWER ("close enough") →
    // red. The two classes have DIFFERENT remedies — missed-newer says the
    // vendor's filter lied about a specific record (HubSpot/Stripe),
    // watermark-behind says our position trails the account (Xero) — so a
    // reader told only half is being given the wrong instruction.
    expect(classifyEntityDrift(drift({ classes: ["missed-newer", "watermark-behind"] }))).toBe(
      "MISSED_NEWER_AND_WATERMARK_BEHIND",
    );
  });

  it("is driven by the classes reconcile.ts actually emits, not by a count", () => {
    // Guards against the classifier and `diffForDrift` drifting apart: the
    // input here is a REAL diff, not a hand-built shape.
    const real = diffForDrift(
      "invoice",
      "2026-08-15T00:00:00Z",
      [{ sourceKey: "A", marker: "2026-08-10T00:00:00Z", updatedAt: null }],
      [
        { sourceKey: "A", marker: "2026-08-10T00:00:00Z", updatedAt: null },
        { sourceKey: "B", marker: "2026-08-26T00:00:00Z", updatedAt: null },
      ],
    );
    expect(real.missedCount).toBe(1);
    expect(classifyEntityDrift(real)).toBe("MISSED_NEWER_AND_WATERMARK_BEHIND");
  });
});

// ---------------------------------------------------------------------------
// The PHI-free rule, made structural
// ---------------------------------------------------------------------------

// `markerTimestamp` was this module's own copy of the ISO gate until
// WARP-2495 unified it with `watermark.ts`'s `isoInstant`. The assertions are
// unchanged — what they guard is the PERSISTENCE side of that one gate, which
// is why they stay here rather than moving to `watermark.test.ts`.
describe("isoInstant — the coercion this table's PHI rule rests on", () => {
  it("accepts a real ISO timestamp", () => {
    expect(isoInstant("2026-08-26T00:00:00Z")?.toISOString()).toBe("2026-08-26T00:00:00.000Z");
    expect(isoInstant("2026-08-26")?.toISOString()).toBe("2026-08-26T00:00:00.000Z");
  });

  it("rejects a record identifier used as an ordering key", () => {
    // MUTATION: store the marker verbatim, or coerce with a bare `new Date()`
    // → red. `new Date("1001")` is the YEAR 1001, so a bare numeric invoice
    // number would otherwise parse as a plausible timestamp and land in a
    // column an operator reads as one.
    expect(isoInstant("INV-1003")).toBeNull();
    expect(isoInstant("1001")).toBeNull();
    expect(isoInstant("in_1PxyzABC123")).toBeNull();
    expect(isoInstant(null)).toBeNull();
    expect(isoInstant(undefined)).toBeNull();
  });
});

describe("the stored row carries no customer content", () => {
  it("never stores a record identifier, even when the vendor ORDERS BY one", async () => {
    // The seeded invoice number. A vendor is free to order by its own record
    // key — Stripe cursors ARE object ids — so this is the realistic shape,
    // not a contrived one.
    //
    // MUTATION: keep `watermarkAt` / `earliestMissedAt` as the raw marker
    // string "for debugging" → "INV-1003" appears in the row → red.
    //
    // The row is MISSED on its `updated_at` (WARP-2464's column, which this
    // vendor does populate) while still being ORDERED by its invoice number.
    // That pairing is what keeps this test honest after WARP-2495: the gap has
    // to be genuinely detected for the redaction to be asserting anything, and
    // an opaque marker can no longer produce one on its own — `isWatermarkAhead`
    // refuses to order two tokens, so a fixture ordered end-to-end by invoice
    // number now yields `missedCount: 0` and every assertion below would pass
    // vacuously.
    const prisma = driftPrisma();
    const real = diffForDrift(
      "invoice",
      "2026-08-15T00:00:00Z",
      [{ sourceKey: "INV-1001", marker: "INV-1001", updatedAt: "2026-08-10T00:00:00Z" }],
      [
        { sourceKey: "INV-1001", marker: "INV-1001", updatedAt: "2026-08-10T00:00:00Z" },
        { sourceKey: "INV-1003", marker: "INV-1003", updatedAt: "2026-08-26T00:00:00Z" },
      ],
    );
    expect(real.missedCount).toBe(1); // the gap is genuinely detected...
    // ...and DATED, off the `updated_at` it was detected on, even though the
    // record's own ordering key is an invoice number. Before WARP-2495 this
    // was `null`: the row was judged missed on its `updated_at` and then dated
    // on its marker, so the forensic answer contradicted the finding.
    // MUTATION: `isoInstant(r.marker)` instead of `isoInstant(value)` → null → red.
    expect(real.earliestMissedAt?.toISOString()).toBe("2026-08-26T00:00:00.000Z");

    const row = await recordEntityDrift(prisma, {
      connectionId: "conn-1",
      provider: "stripe",
      sweepAt: NOW,
      watermark: "2026-08-15T00:00:00Z",
      drift: real,
    });

    // ...and none of the identifiers survive into storage.
    const stored = JSON.stringify(prisma.erpDriftRecord.create.mock.calls[0][0]);
    expect(stored).not.toContain("INV-1003");
    expect(stored).not.toContain("INV-1001");
    expect(row.earliestMissedAt?.toISOString()).toBe("2026-08-26T00:00:00.000Z");
    // The diagnosis itself is intact — this is not "safe because it stored
    // nothing".
    expect(row.classification).toBe("MISSED_NEWER_AND_WATERMARK_BEHIND");
    expect(row.missedCount).toBe(1);
  });

  it("stores no date at all when a missed record's only position is an id", async () => {
    // The other side of the flip above, so "dates the gap off the judged-on
    // value" never becomes "coerces whatever it was handed". A null watermark
    // filtered nothing, so this row is missed on the ABSENCE itself and the
    // predicate never orders anything — yet its only position is still an
    // invoice number, and `isoInstant` is what keeps that out of a DateTime
    // column.
    //
    // MUTATION: coerce with a bare `new Date(value)` → "INV-1003" lands as an
    // Invalid Date rather than null → red.
    const prisma = driftPrisma();
    const real = diffForDrift(
      "invoice",
      null,
      [],
      [{ sourceKey: "INV-1003", marker: "INV-1003", updatedAt: null }],
    );
    expect(real.missedCount).toBe(1);
    expect(real.earliestMissedAt).toBeNull();

    const row = await recordEntityDrift(prisma, {
      connectionId: "conn-1",
      provider: "stripe",
      sweepAt: NOW,
      watermark: null,
      drift: real,
    });
    expect(row.earliestMissedAt).toBeNull();
    expect(JSON.stringify(prisma.erpDriftRecord.create.mock.calls[0][0])).not.toContain("INV-1003");
  });

  it("never stores a watermark the vendor expressed as a record id", async () => {
    // The other half of the same rule, split out because it cannot share a
    // fixture with the case above: an opaque watermark is unorderable, so no
    // record can be reported missed against it, and a single test asserting
    // both would have to choose which half to make vacuous.
    //
    // MUTATION: `watermarkAt: new Date(watermark)` → "INV-1000" reaches the
    // column as an Invalid Date, or a numeric invoice id as the year 1001 →
    // red.
    const prisma = driftPrisma();
    const row = await recordEntityDrift(prisma, {
      connectionId: "conn-1",
      provider: "stripe",
      sweepAt: NOW,
      watermark: "INV-1000",
      drift: drift({ classes: [] }),
    });
    expect(row.watermarkAt).toBeNull();
    expect(JSON.stringify(prisma.erpDriftRecord.create.mock.calls[0][0])).not.toContain("INV-1000");
  });

  it("keeps a genuine timestamp marker, so the redaction is not blanket", async () => {
    const real = diffForDrift(
      "invoice",
      "2026-08-15T00:00:00Z",
      [],
      [{ sourceKey: "INV-1003", marker: "2026-08-26T00:00:00Z", updatedAt: null }],
    );
    const row = driftRowFor({
      connectionId: "conn-1",
      provider: "xero",
      sweepAt: NOW,
      watermark: "2026-08-15T00:00:00Z",
      drift: real,
    });
    expect(row.watermarkAt?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(row.earliestMissedAt?.toISOString()).toBe("2026-08-26T00:00:00.000Z");
    expect(JSON.stringify(row)).not.toContain("INV-1003");
  });

  it("reports the EARLIEST missed marker under EITHER page order", () => {
    // MUTATION: take the first missed record's marker, or the last, instead of
    // the minimum → red.
    //
    // BOTH orders are asserted deliberately. A single fixture is vacuously
    // green here: with the newest row first, "keep the last one I saw" happens
    // to end on the right answer, and the mutation survives. This is the same
    // trap WARP-2218's state-fold test fell into — a vendor page has no
    // guaranteed order (Stripe explicitly does not promise one), so neither
    // order may be the one that works.
    const earliest = (full: RecordIdentity[]) =>
      diffForDrift("invoice", "2026-08-15T00:00:00Z", [], full).earliestMissedAt?.toISOString();

    const NEWEST = { sourceKey: "B", marker: "2026-08-26T00:00:00Z", updatedAt: null };
    const OLDEST = { sourceKey: "A", marker: "2026-08-20T00:00:00Z", updatedAt: null };

    expect(earliest([NEWEST, OLDEST])).toBe("2026-08-20T00:00:00.000Z");
    expect(earliest([OLDEST, NEWEST])).toBe("2026-08-20T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Absence is never the signal
// ---------------------------------------------------------------------------

describe("recordEntityDrift", () => {
  it("writes a row when the sweep found NOTHING", async () => {
    // MUTATION: guard the write with `if (missedCount > 0)` → no row → red.
    // Without this row the table cannot distinguish "the incremental path was
    // trustworthy" from "no sweep ever ran".
    const prisma = driftPrisma();
    const row = await recordEntityDrift(prisma, {
      connectionId: "conn-1",
      provider: "xero",
      sweepAt: NOW,
      watermark: "2026-08-15T00:00:00Z",
      drift: drift(),
    });

    expect(prisma.erpDriftRecord.create).toHaveBeenCalledTimes(1);
    expect(row.classification).toBe("NONE");
    expect(row.missedCount).toBe(0);
    // The denominator is stored too: 0 missed out of 3 and 0 missed out of
    // 40,000 are not the same evidence for lengthening a cadence.
    expect(row.fullCount).toBe(3);
    expect(row.incrementalCount).toBe(3);
  });

  it("lets a write failure propagate to cron-runtime's safeRun", async () => {
    const prisma = driftPrisma();
    prisma.erpDriftRecord.create.mockRejectedValue(new Error("prisma down"));
    await expect(
      recordEntityDrift(prisma, {
        connectionId: "conn-1",
        provider: "xero",
        sweepAt: NOW,
        watermark: null,
        drift: drift(),
      }),
    ).rejects.toThrow("prisma down");
  });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe("trimErpDriftRecords", () => {
  it("deletes rows past the window and KEEPS a row just inside it", async () => {
    // MUTATION: use `lte` instead of `lt` on the cutoff, or drop the trim
    // entirely → the boundary row disappears / the old row survives → red.
    const prisma = driftPrisma([
      ...sweepRows(new Date(NOW.getTime() - 91 * DAY), ["NONE"]),
      // Exactly at the boundary: inside the window, must survive.
      ...sweepRows(new Date(NOW.getTime() - 90 * DAY), ["NONE"]),
      ...sweepRows(new Date(NOW.getTime() - 1 * DAY), ["MISSED_NEWER"]),
    ]);

    const res = await trimErpDriftRecords(prisma, 90, NOW);

    expect(res.skipped).toBe(false);
    expect(res.deleted).toBe(1);
    const remaining = (prisma as any).__rows.map((r: any) => r.sweepAt.getTime());
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain(NOW.getTime() - 90 * DAY);
    expect(remaining).toContain(NOW.getTime() - 1 * DAY);
  });

  it("treats a window of 0 as an EXPLICIT keep-forever, not a sentinel", async () => {
    const prisma = driftPrisma(sweepRows(new Date(NOW.getTime() - 900 * DAY), ["NONE"]));
    const res = await trimErpDriftRecords(prisma, 0, NOW);
    expect(res).toEqual({ deleted: 0, skipped: true });
    expect(prisma.erpDriftRecord.deleteMany).not.toHaveBeenCalled();
  });

  it("caps the work one run may do, so a deep backlog cannot wedge the cron", async () => {
    // The 60 s advisory-lock transaction is a hard budget; one unbounded
    // deleteMany over months of rows raises P2028, rolls back, and re-attempts
    // the same oversized set every night forever.
    const old = new Date(NOW.getTime() - 200 * DAY);
    const prisma = driftPrisma(
      Array.from({ length: 25 }, (_, i) => ({
        id: `old-${i}`,
        connectionId: "conn-1",
        provider: "xero",
        entity: "invoice",
        sweepAt: old,
        classification: "NONE",
        missedCount: 0,
        fullCount: 1,
        incrementalCount: 1,
      })),
    );
    const res = await trimErpDriftRecords(prisma, 90, NOW, { batchSize: 4, maxRows: 10 });
    expect(res.deleted).toBe(10);
    expect((prisma as any).__rows).toHaveLength(15);
  });
});

describe("registerErpDriftRetention", () => {
  it("schedules through cron-runtime with a lock key — never a bare loop", async () => {
    // MUTATION: remove the cron registration (or swap it for a `while (true)`
    // / bare setInterval) → nothing is captured and the handler never runs →
    // red. A missing lockKey lets a multi-instance box run the trim twice.
    const prisma = driftPrisma(sweepRows(new Date(NOW.getTime() - 200 * DAY), ["NONE"]));
    const captured: Array<{ spec: string; handler: () => unknown; opts: any }> = [];
    const cronRuntime = {
      scheduleCron: (spec: string, handler: () => unknown, opts?: any) =>
        captured.push({ spec, handler, opts }),
    };

    registerErpDriftRetention(cronRuntime as never, prisma, {
      retentionDays: 90,
      now: () => NOW,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].spec).toBe(ERP_DRIFT_RETENTION_CRON);
    expect(captured[0].opts?.lockKey).toBe(ERP_DRIFT_RETENTION_LOCK_KEY);
    expect(String(captured[0].opts?.lockKey ?? "")).not.toBe("");

    await captured[0].handler();
    expect(prisma.erpDriftRecord.deleteMany).toHaveBeenCalled();
    expect((prisma as any).__rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The cadence hook
// ---------------------------------------------------------------------------

describe("cleanSweepStreak", () => {
  it("counts consecutive fully-clean sweeps, newest first", async () => {
    const prisma = driftPrisma([
      ...sweepRows(new Date(NOW.getTime() - 3 * DAY), ["NONE", "NONE"]),
      ...sweepRows(new Date(NOW.getTime() - 2 * DAY), ["NONE", "NONE"]),
      ...sweepRows(new Date(NOW.getTime() - 1 * DAY), ["NONE", "NONE"]),
    ]);
    expect(await cleanSweepStreak(prisma, "conn-1")).toBe(3);
  });

  it("RESETS on a miss rather than skipping past it", async () => {
    // MUTATION: `continue` instead of `break` on a drifted sweep (or count
    // clean rows rather than clean sweeps) → 2 → red.
    const prisma = driftPrisma([
      ...sweepRows(new Date(NOW.getTime() - 3 * DAY), ["NONE", "NONE"]),
      ...sweepRows(new Date(NOW.getTime() - 2 * DAY), ["MISSED_NEWER", "NONE"]),
      ...sweepRows(new Date(NOW.getTime() - 1 * DAY), ["NONE", "NONE"]),
    ]);
    expect(await cleanSweepStreak(prisma, "conn-1")).toBe(1);
  });

  it("treats a sweep as clean only when EVERY entity was clean", async () => {
    // One drifted entity means the incremental path was untrustworthy for that
    // connection on that pass. Lengthening the cadence because the OTHER
    // dataset was fine reads the evidence backwards.
    const prisma = driftPrisma(
      sweepRows(new Date(NOW.getTime() - 1 * DAY), ["NONE", "WATERMARK_BEHIND"]),
    );
    expect(await cleanSweepStreak(prisma, "conn-1")).toBe(0);
  });

  it("does not count a sweep whose rows were truncated by the row limit", async () => {
    // The oldest group may be half-read. Counting it inflates the streak and
    // lengthens the cadence on evidence that was never actually looked at.
    const prisma = driftPrisma([
      ...sweepRows(new Date(NOW.getTime() - 2 * DAY), ["NONE", "MISSED_NEWER"]),
      ...sweepRows(new Date(NOW.getTime() - 1 * DAY), ["NONE", "NONE"]),
    ]);
    // rowLimit 3 stops mid-way through the older sweep, holding only its
    // clean row.
    expect(await cleanSweepStreak(prisma, "conn-1", { rowLimit: 3 })).toBe(1);
  });

  it("is 0 for a connection that has never been swept", async () => {
    // Not "clean" — unmeasured. The two must not produce the same cadence.
    expect(await cleanSweepStreak(driftPrisma(), "conn-1")).toBe(0);
  });

  it("does not let another connection's clean run lengthen this one", async () => {
    const prisma = driftPrisma([
      ...sweepRows(new Date(NOW.getTime() - 1 * DAY), ["NONE", "NONE"], "conn-2"),
    ]);
    expect(await cleanSweepStreak(prisma, "conn-1")).toBe(0);
  });
});

describe("sweepIntervalMsFor", () => {
  const BASE = 24 * 60 * 60 * 1000;

  it("holds at the base interval until the evidence is in", () => {
    for (let streak = 0; streak < CLEAN_SWEEPS_PER_STEP; streak += 1) {
      expect(sweepIntervalMsFor(BASE, streak)).toBe(BASE);
    }
  });

  it("GROWS the interval after N clean sweeps in a row", () => {
    // MUTATION: ignore the drift-free counter (return `baseMs` unconditionally)
    // → red. This is the line that turns stored drift into saved money:
    // WARP-2383 prices a naive 15-minute Xero cadence at ~$2,676 AUD/mo for
    // 200 orgs, and drift history is the only thing that can justify skipping
    // a sweep.
    expect(sweepIntervalMsFor(BASE, CLEAN_SWEEPS_PER_STEP)).toBe(BASE * 2);
    expect(sweepIntervalMsFor(BASE, CLEAN_SWEEPS_PER_STEP * 2)).toBe(BASE * 4);
  });

  it("resets to base the moment the streak does", () => {
    expect(sweepIntervalMsFor(BASE, 0)).toBe(BASE);
  });

  it("caps the multiplier so a long clean run cannot stop reconciling", () => {
    // Past the cap the sweep stops being a reconciliation and becomes an
    // audit — a vendor that starts dropping records would go unnoticed for
    // longer than the incremental path's own failure would take to notice.
    expect(sweepIntervalMsFor(BASE, 1000)).toBe(BASE * 8);
  });
});

// ---------------------------------------------------------------------------
// The read model
// ---------------------------------------------------------------------------

describe("driftForConnection", () => {
  it("summarises a window and reports the streak alongside it", async () => {
    const prisma = driftPrisma([
      ...sweepRows(new Date(NOW.getTime() - 5 * DAY), ["MISSED_NEWER", "NONE"]),
      ...sweepRows(new Date(NOW.getTime() - 1 * DAY), ["NONE", "NONE"]),
    ]);
    const out = await driftForConnection(prisma, "conn-1", 30, NOW);

    expect(out.connectionId).toBe("conn-1");
    expect(out.windowDays).toBe(30);
    expect(out.summary.rowsRecorded).toBe(4);
    expect(out.summary.driftedRows).toBe(1);
    expect(out.summary.totalMissed).toBe(1);
    expect(out.summary.cleanSweepStreak).toBe(1);
    // Newest first, so the hub renders the most recent evidence at the top.
    expect(out.entries[0].sweepAt).toBe(new Date(NOW.getTime() - 1 * DAY).toISOString());
  });

  it("excludes rows outside the requested window", async () => {
    const prisma = driftPrisma([
      ...sweepRows(new Date(NOW.getTime() - 40 * DAY), ["MISSED_NEWER"]),
      ...sweepRows(new Date(NOW.getTime() - 2 * DAY), ["NONE"]),
    ]);
    const out = await driftForConnection(prisma, "conn-1", 30, NOW);
    expect(out.summary.rowsRecorded).toBe(1);
    expect(out.summary.driftedRows).toBe(0);
  });

  it("says 'never measured' rather than implying a clean bill of health", async () => {
    const out = await driftForConnection(driftPrisma(), "conn-unknown", 30, NOW);
    expect(out.entries).toEqual([]);
    expect(out.summary.rowsRecorded).toBe(0);
    expect(out.summary.cleanSweepStreak).toBe(0);
  });
});
