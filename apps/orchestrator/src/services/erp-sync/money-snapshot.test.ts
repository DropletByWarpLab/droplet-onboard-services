/**
 * WARP-2751 — the money time axis, at the level a mock can actually prove.
 *
 * 🔴 READ THIS BEFORE TRUSTING A GREEN RUN HERE. The capture and the
 * downsample are single SQL statements, and a mocked `$executeRaw` returns
 * whatever it was told regardless of what the SQL says. These cases pin the
 * CONTROL FLOW around the statements — the never-throw contract, the skip
 * sentinel, the batch loop's termination, the registration's lock key — and
 * they cannot prove the SQL is correct. That proof is in
 * `money-snapshot.pg.test.ts`, against a real Postgres, and the two files are
 * not interchangeable.
 *
 * The brain epic already paid for confusing the two once: a fixture claimed a
 * column shape the schema had stopped having, thirty-four mocked cases stayed
 * green, and both money detectors were dead in production.
 */
import { describe, it, expect, vi } from "vitest";
import {
  captureMoneySnapshots,
  trimMoneySnapshots,
  registerMoneySnapshotMaintenance,
  toUtcDateString,
  MONEY_SNAPSHOT_RETENTION_CRON,
  MONEY_SNAPSHOT_RETENTION_LOCK_KEY,
} from "./money-snapshot.service";

const NOW = new Date("2026-06-15T04:05:06.000Z");

function db(exec: (n: number) => number | Promise<number>) {
  let calls = 0;
  const $executeRaw = vi.fn(async () => exec(calls++));
  return { prisma: { $executeRaw } as never, $executeRaw };
}

describe("toUtcDateString (WARP-2751)", () => {
  it("is UTC, not local", () => {
    // The day a row lands on must not depend on which timezone the container
    // booted in — a box moved between coasts would otherwise write two rows
    // for one day, or none.
    expect(toUtcDateString(new Date("2026-06-15T23:59:59.000Z"))).toBe("2026-06-15");
    expect(toUtcDateString(new Date("2026-06-16T00:00:01.000Z"))).toBe("2026-06-16");
  });
});

describe("captureMoneySnapshots — the never-throw contract (WARP-2751)", () => {
  it("returns the row count on the ordinary path", async () => {
    const { prisma } = db(() => 42);
    expect(await captureMoneySnapshots(prisma, { now: NOW })).toEqual({
      captured: 42,
      error: null,
    });
  });

  it("SWALLOWS a database failure and reports it, rather than throwing", async () => {
    // 🔴 The contract that matters. This runs after the landing transaction
    // commits; a throw here would propagate into the sync tick and turn a lost
    // day of history into a lost page of invoices.
    const prisma = {
      $executeRaw: vi.fn(async () => {
        throw new Error("relation does not exist");
      }),
    } as never;
    const out = await captureMoneySnapshots(prisma, { now: NOW });
    expect(out.captured).toBe(0);
    expect(out.error).toContain("relation does not exist");
  });

  it("reports a non-Error rejection as a string rather than [object Object]", async () => {
    const prisma = {
      $executeRaw: vi.fn(async () => {
        throw "pg went away";
      }),
    } as never;
    expect((await captureMoneySnapshots(prisma, { now: NOW })).error).toBe("pg went away");
  });

  it("passes the UTC day and the connection filter as PARAMETERS, never inlined", async () => {
    // Interpolating either into the SQL text would be an injection seam on a
    // value that reaches this function from vendor-shaped data.
    const { prisma, $executeRaw } = db(() => 1);
    await captureMoneySnapshots(prisma, { now: NOW, connectionId: "conn-1" });
    const values = $executeRaw.mock.calls[0]!.slice(1);
    expect(values).toContain("2026-06-15");
    expect(values).toContain("conn-1");
  });

  it("passes NULL for the connection when unscoped — the LOCAL-document path", async () => {
    const { prisma, $executeRaw } = db(() => 1);
    await captureMoneySnapshots(prisma, { now: NOW });
    expect($executeRaw.mock.calls[0]!.slice(1)).toContain(null);
  });
});

describe("trimMoneySnapshots — skip sentinel and batch loop (WARP-2751)", () => {
  it("treats 0 as the EXPLICIT keep-forever stance, not a missing value", async () => {
    const { prisma, $executeRaw } = db(() => 0);
    expect(await trimMoneySnapshots(prisma, 0, NOW)).toEqual({ deleted: 0, skipped: true });
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it("skips on a negative or non-finite window rather than deleting everything", async () => {
    const { prisma, $executeRaw } = db(() => 0);
    expect((await trimMoneySnapshots(prisma, -1, NOW)).skipped).toBe(true);
    expect((await trimMoneySnapshots(prisma, Number.NaN, NOW)).skipped).toBe(true);
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it("stops immediately when the first batch deletes nothing", async () => {
    const { prisma, $executeRaw } = db(() => 0);
    expect(await trimMoneySnapshots(prisma, 90, NOW)).toEqual({ deleted: 0, skipped: false });
    expect($executeRaw).toHaveBeenCalledOnce();
  });

  it("stops on a SHORT batch rather than spinning on a set that cannot shrink", async () => {
    // A full batch means there may be more; a short one means the tail is
    // exhausted. Looping again on a short batch is how a nightly job turns
    // into a hot loop against an empty result.
    const { prisma, $executeRaw } = db((n) => (n === 0 ? 10 : 0));
    const out = await trimMoneySnapshots(prisma, 90, NOW, { batchSize: 100, maxRows: 1000 });
    expect(out.deleted).toBe(10);
    expect($executeRaw).toHaveBeenCalledOnce();
  });

  it("keeps going while batches come back FULL, and honours maxRows", async () => {
    const { prisma, $executeRaw } = db(() => 10);
    const out = await trimMoneySnapshots(prisma, 90, NOW, { batchSize: 10, maxRows: 30 });
    expect(out.deleted).toBe(30);
    expect($executeRaw).toHaveBeenCalledTimes(3);
  });

  it("never asks for more than the remaining budget in the last batch", async () => {
    // Otherwise the final statement can overshoot maxRows and blow the
    // advisory-lock budget the cap exists to protect.
    const { prisma, $executeRaw } = db(() => 10);
    await trimMoneySnapshots(prisma, 90, NOW, { batchSize: 10, maxRows: 25 });
    const takes = $executeRaw.mock.calls.map((c) => c.slice(1).at(-1));
    expect(takes).toEqual([10, 10, 5]);
  });

  it("computes the cutoff from the window, exclusive of the boundary day", async () => {
    const { prisma, $executeRaw } = db(() => 0);
    await trimMoneySnapshots(prisma, 90, NOW);
    // 2026-06-15 minus 90 days.
    expect($executeRaw.mock.calls[0]!.slice(1)).toContain("2026-03-17");
  });
});

describe("registerMoneySnapshotMaintenance (WARP-2751)", () => {
  function runtime() {
    const scheduleCron = vi.fn();
    return { cron: { scheduleCron } as never, scheduleCron };
  }

  it("schedules on its own leg and its own lock key", async () => {
    // The spec and the lock key are contract, not detail: a shared lock key
    // would let this leg block the drift trim, and a shared leg would spend
    // from the daily purge's 60 s transaction budget.
    const { cron, scheduleCron } = runtime();
    registerMoneySnapshotMaintenance(cron, db(() => 0).prisma, { dailyDays: 90 });
    expect(scheduleCron).toHaveBeenCalledOnce();
    const [spec, , opts] = scheduleCron.mock.calls[0]!;
    expect(spec).toBe(MONEY_SNAPSHOT_RETENTION_CRON);
    expect(opts).toEqual({ lockKey: MONEY_SNAPSHOT_RETENTION_LOCK_KEY });
    // 03:45 — off the 03:00 / 03:15 / 03:30 legs.
    expect(spec).toBe("45 3 * * *");
  });

  it("CAPTURES BEFORE IT TRIMS, so a trim failure cannot cost a day of history", async () => {
    const order: string[] = [];
    const prisma = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
        order.push(strings.join(" ").includes("INSERT") ? "capture" : "trim");
        return 0;
      }),
    } as never;
    const { cron, scheduleCron } = runtime();
    registerMoneySnapshotMaintenance(cron, prisma, { dailyDays: 90, now: () => NOW });
    await scheduleCron.mock.calls[0]![1]();
    expect(order).toEqual(["capture", "trim"]);
  });

  it("hands the caller both results so neither failure can be silent", async () => {
    const onRun = vi.fn();
    const { cron, scheduleCron } = runtime();
    registerMoneySnapshotMaintenance(cron, db(() => 7).prisma, {
      dailyDays: 0,
      now: () => NOW,
      onRun,
    });
    await scheduleCron.mock.calls[0]![1]();
    expect(onRun).toHaveBeenCalledWith({
      capture: { captured: 7, error: null },
      trim: { deleted: 0, skipped: true },
    });
  });

  it("still trims when the capture failed — one broken half does not stop the other", async () => {
    let first = true;
    const prisma = {
      $executeRaw: vi.fn(async () => {
        if (first) {
          first = false;
          throw new Error("capture boom");
        }
        return 0;
      }),
    } as never;
    const onRun = vi.fn();
    const { cron, scheduleCron } = runtime();
    registerMoneySnapshotMaintenance(cron, prisma, { dailyDays: 90, now: () => NOW, onRun });
    await scheduleCron.mock.calls[0]![1]();
    expect(onRun.mock.calls[0]![0].capture.error).toContain("capture boom");
    expect(onRun.mock.calls[0]![0].trim.skipped).toBe(false);
  });
});
