import { describe, it, expect, vi } from "vitest";
import { purgeAuditLogs } from "./audit-retention-purge.service.js";

/**
 * WARP-586 — retention purge for ActivityRow / CommandAuditLog /
 * NotificationLog.
 *
 * Two flavours of mock live here:
 *   - `createPrismaMock` is a thin stub that records call args; used by
 *     the cutoff/where-column and disabled-state tests, which only care
 *     about the query shape.
 *   - `createInMemoryPrisma` is a small in-memory table simulation used
 *     by the chain-integrity (clock-skew) and batching tests, which need
 *     to observe what actually survives a real loop of find → delete.
 *
 * Finding-2 (PR #623): the daily purge runs inside a 60 s advisory-lock
 * `$transaction`. A first-run/long-idle box with months of rows could
 * exceed that wall-clock on a single unbounded `deleteMany`, P2028, roll
 * back, and retry the same oversized set every night forever. The fix is
 * bounded batched deletes with a per-run cap, so each nightly run is
 * provably short and the backlog drains over nights.
 *
 * Finding-3 (PR #623): ActivityRow is hash-chained and `at` is
 * `@default(now())` with no DB ordering guarantee. Under NTP step / clock
 * skew a higher-`id` row can carry an earlier `at`, so an `at < cutoff`
 * delete could punch a mid-chain hole. We purge ActivityRow by a
 * contiguous oldest-`id` prefix (boundary = max id whose `at < cutoff`,
 * then delete `id <= boundary`) so only a tail-truncation ever happens.
 */
function createPrismaMock(counts: {
  activity: number;
  commandAudit: number;
  notification: number;
}) {
  return {
    activityRow: {
      // Boundary lookup. The service asks for the first survivor
      // (`at >= cutoff`, orderBy id asc) first, then falls back to the
      // last old row (`at < cutoff`, orderBy id desc) when there is no
      // survivor. This stub takes the "no survivor → truncate whole old
      // prefix" path: the survivor lookup returns null, the fallback
      // hands back a synthetic boundary so the batch loop runs
      // `counts.activity` rows' worth of deletes in one batch.
      findFirst: vi.fn(async (args: any) => {
        if (args.where.at.gte !== undefined) return null; // no survivor
        return counts.activity > 0 ? { id: 1000n } : null; // last old row
      }),
      // First call returns the id batch, second returns empty to end loop.
      findMany: vi
        .fn()
        .mockResolvedValueOnce(
          Array.from({ length: counts.activity }, (_, i) => ({
            id: BigInt(i + 1),
          })),
        )
        .mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: counts.activity }),
    },
    commandAuditLog: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(
          Array.from({ length: counts.commandAudit }, (_, i) => ({
            id: `cmd-${i}`,
          })),
        )
        .mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: counts.commandAudit }),
    },
    notificationLog: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(
          Array.from({ length: counts.notification }, (_, i) => ({
            id: `notif-${i}`,
          })),
        )
        .mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: counts.notification }),
    },
  };
}

/**
 * In-memory table sim. Each table is an array of rows. We implement the
 * subset of the Prisma surface the service uses: `findFirst` (with
 * orderBy id desc + where.at.lt), `findMany` (with orderBy + take +
 * select id + a where on id/createdAt), and `deleteMany` (with
 * where.id.in). Counts are real, so a test can assert exactly which rows
 * survive.
 */
type ActivityRecord = { id: bigint; at: Date };
type LogRecord = { id: string; createdAt: Date };

function makeActivityTable(rows: ActivityRecord[]) {
  let store = [...rows];
  return {
    get rows() {
      return store;
    },
    findFirst: vi.fn(async (args: any) => {
      // Primary boundary lookup: first survivor (min id, at >= cutoff).
      // Fallback (no survivor): last old row (max id, at < cutoff).
      const at = args.where.at;
      const desc = args.orderBy?.id === "desc";
      let matching: ActivityRecord[];
      if (at.gte !== undefined) {
        matching = store.filter((r) => r.at.getTime() >= at.gte.getTime());
      } else {
        matching = store.filter((r) => r.at.getTime() < at.lt.getTime());
      }
      if (matching.length === 0) return null;
      const picked = matching.reduce((m, r) => {
        if (desc) return r.id > m.id ? r : m;
        return r.id < m.id ? r : m;
      }, matching[0]);
      return { id: picked.id };
    }),
    findMany: vi.fn(async (args: any) => {
      // Service selects the next id-ordered batch with id < / <= boundary.
      const idArg = args.where.id;
      const take: number = args.take;
      const match =
        idArg.lt !== undefined
          ? (r: ActivityRecord) => r.id < idArg.lt
          : (r: ActivityRecord) => r.id <= idArg.lte;
      return store
        .filter(match)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, take)
        .map((r) => ({ id: r.id }));
    }),
    deleteMany: vi.fn(async (args: any) => {
      const ids: bigint[] = args.where.id.in;
      const before = store.length;
      store = store.filter((r) => !ids.includes(r.id));
      return { count: before - store.length };
    }),
  };
}

function makeLogTable(rows: LogRecord[]) {
  let store = [...rows];
  return {
    get rows() {
      return store;
    },
    findMany: vi.fn(async (args: any) => {
      const lt: Date = args.where.createdAt.lt;
      const take: number = args.take;
      return store
        .filter((r) => r.createdAt.getTime() < lt.getTime())
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, take)
        .map((r) => ({ id: r.id }));
    }),
    deleteMany: vi.fn(async (args: any) => {
      const ids: string[] = args.where.id.in;
      const before = store.length;
      store = store.filter((r) => !ids.includes(r.id));
      return { count: before - store.length };
    }),
  };
}

describe("WARP-586 — purgeAuditLogs", () => {
  it("deletes the prefix from all three tables and returns counts", async () => {
    const prisma = createPrismaMock({
      activity: 11,
      commandAudit: 5,
      notification: 3,
    });

    const result = await purgeAuditLogs(prisma as any, 90);

    expect(result).toEqual({
      activityDeleted: 11,
      commandAuditDeleted: 5,
      notificationDeleted: 3,
      skipped: false,
    });
  });

  it("computes a `< cutoff` boundary at olderThanDays back for every table", async () => {
    const prisma = createPrismaMock({
      activity: 1,
      commandAudit: 1,
      notification: 1,
    });

    await purgeAuditLogs(prisma as any, 90);

    const expectedCutoff = Date.now() - 90 * 86400_000;

    // ActivityRow's cutoff lands on the boundary lookup (findFirst),
    // filtering on `at` — NOT on the deleteMany (which is id-based now).
    // The primary boundary lookup is the first-survivor query
    // (`at >= cutoff`, orderBy id asc); both edges of the comparison use
    // the same cutoff timestamp.
    const activityArg = prisma.activityRow.findFirst.mock.calls[0][0];
    expect(activityArg.orderBy).toEqual({ id: "asc" });
    const activityCutoff = activityArg.where.at.gte as Date;
    expect(activityCutoff).toBeInstanceOf(Date);
    expect(Math.abs(activityCutoff.getTime() - expectedCutoff)).toBeLessThan(
      1000,
    );

    // The log tables select their id batch with a `createdAt < cutoff`
    // filter on findMany.
    const commandArg = prisma.commandAuditLog.findMany.mock.calls[0][0];
    const notifArg = prisma.notificationLog.findMany.mock.calls[0][0];
    const commandCutoff = commandArg.where.createdAt.lt as Date;
    const notifCutoff = notifArg.where.createdAt.lt as Date;
    expect(Math.abs(commandCutoff.getTime() - expectedCutoff)).toBeLessThan(
      1000,
    );
    expect(Math.abs(notifCutoff.getTime() - expectedCutoff)).toBeLessThan(1000);
  });

  it("deletes ActivityRow by id boundary, never by `at` directly", async () => {
    // The deleteMany on the hash-chained table must key on `id` (a
    // contiguous prefix), not on `at` — the whole point of Finding 3.
    const prisma = createPrismaMock({
      activity: 4,
      commandAudit: 0,
      notification: 0,
    });

    await purgeAuditLogs(prisma as any, 30);

    const delArg = prisma.activityRow.deleteMany.mock.calls[0][0];
    // No `at` filter on the delete — only an id set.
    expect(delArg.where.at).toBeUndefined();
    expect(delArg.where.id).toBeDefined();
  });

  it("skips entirely when the window is 0 (keep-forever / disabled)", async () => {
    const prisma = createPrismaMock({
      activity: 99,
      commandAudit: 99,
      notification: 99,
    });

    const result = await purgeAuditLogs(prisma as any, 0);

    expect(result).toEqual({
      activityDeleted: 0,
      commandAuditDeleted: 0,
      notificationDeleted: 0,
      skipped: true,
    });
    expect(prisma.activityRow.deleteMany).not.toHaveBeenCalled();
    expect(prisma.activityRow.findFirst).not.toHaveBeenCalled();
    expect(prisma.commandAuditLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.notificationLog.deleteMany).not.toHaveBeenCalled();
  });

  it("skips when the window is negative (treated as disabled, not a future cutoff)", async () => {
    const prisma = createPrismaMock({
      activity: 7,
      commandAudit: 7,
      notification: 7,
    });

    const result = await purgeAuditLogs(prisma as any, -5);

    expect(result.skipped).toBe(true);
    expect(prisma.activityRow.findFirst).not.toHaveBeenCalled();
    expect(prisma.activityRow.deleteMany).not.toHaveBeenCalled();
  });

  it("no-ops on ActivityRow when no row is old enough (boundary lookup is null)", async () => {
    const activity = makeActivityTable([
      { id: 1n, at: new Date(Date.now() - 1 * 86400_000) },
      { id: 2n, at: new Date(Date.now() - 2 * 86400_000) },
    ]);
    const prisma = {
      activityRow: activity,
      commandAuditLog: makeLogTable([]),
      notificationLog: makeLogTable([]),
    };

    const result = await purgeAuditLogs(prisma as any, 90);

    expect(result.activityDeleted).toBe(0);
    // Boundary lookup ran; the delete loop never did (no row < cutoff).
    expect(activity.findFirst).toHaveBeenCalledTimes(1);
    expect(activity.deleteMany).not.toHaveBeenCalled();
    expect(activity.rows).toHaveLength(2);
  });

  it("Finding 3: purges a contiguous oldest-id prefix and spares a higher-id row whose `at` is skewed older than a surviving lower-id row", async () => {
    // Cutoff = 30 days ago. Build a chain where `at` is NON-monotonic
    // with `id` to simulate an NTP step:
    //
    //   id 1  → 40 d old (clearly past cutoff)
    //   id 2  → 35 d old (past cutoff)
    //   id 3  → 10 d old (SURVIVES — newer than cutoff)
    //   id 4  → 50 d old (clock skew! older `at` than its predecessor id 3)
    //   id 5  →  5 d old (survives)
    //
    // A naive `at < cutoff` deleteMany would delete id 1, 2, AND 4 —
    // punching a hole at id 4 between survivors id 3 and id 5, severing
    // the hash chain. The id-boundary purge must delete ONLY the
    // contiguous oldest prefix up to the boundary id (= max id whose
    // `at < cutoff` = id 4), i.e. id 1..4 — wait, that would delete the
    // surviving id 3. So the boundary must be the LAST id of the
    // contiguous old prefix, which here is id 2 (id 3 is the first
    // survivor). The contract: we never delete a row newer than the
    // first survivor. Concretely: survivors must be a suffix → id 3, 4,
    // 5 all survive; only id 1, 2 are purged.
    const now = Date.now();
    const d = (days: number) => new Date(now - days * 86400_000);
    const activity = makeActivityTable([
      { id: 1n, at: d(40) },
      { id: 2n, at: d(35) },
      { id: 3n, at: d(10) }, // first survivor (newer than 30 d cutoff)
      { id: 4n, at: d(50) }, // skewed-old but AFTER a survivor → must live
      { id: 5n, at: d(5) },
    ]);
    const prisma = {
      activityRow: activity,
      commandAuditLog: makeLogTable([]),
      notificationLog: makeLogTable([]),
    };

    const result = await purgeAuditLogs(prisma as any, 30);

    const survivingIds = activity.rows.map((r) => r.id).sort();
    // id 4 must NOT be deleted even though its `at` is 50 d old, because
    // a contiguous-prefix purge stops at the first survivor (id 3).
    expect(survivingIds).toContain(4n);
    // The contiguous oldest prefix (id 1, id 2) is gone.
    expect(survivingIds).not.toContain(1n);
    expect(survivingIds).not.toContain(2n);
    // Survivors form a suffix of the id space: 3, 4, 5.
    expect(survivingIds).toEqual([3n, 4n, 5n]);
    expect(result.activityDeleted).toBe(2);
  });

  it("Finding 2: drains a backlog larger than one batch via multiple bounded deletes (no single oversized statement)", async () => {
    // 25 old ActivityRows, batchSize 10 → must take 3 delete batches
    // (10 + 10 + 5) rather than one 25-row deleteMany. Proves the loop
    // chunks the work so no single statement scans the whole backlog.
    const now = Date.now();
    const oldAt = new Date(now - 60 * 86400_000);
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: BigInt(i + 1),
      at: oldAt,
    }));
    const activity = makeActivityTable(rows);
    const prisma = {
      activityRow: activity,
      commandAuditLog: makeLogTable([]),
      notificationLog: makeLogTable([]),
    };

    const result = await purgeAuditLogs(prisma as any, 30, { batchSize: 10 });

    expect(result.activityDeleted).toBe(25);
    expect(activity.rows).toHaveLength(0);
    // 3 delete batches, each bounded to <= batchSize rows.
    expect(activity.deleteMany).toHaveBeenCalledTimes(3);
    for (const call of activity.deleteMany.mock.calls) {
      expect(call[0].where.id.in.length).toBeLessThanOrEqual(10);
    }
  });

  it("Finding 2: a per-run cap bounds total work so a huge first-run backlog can't wedge the 60s transaction", async () => {
    // 100 old rows, batchSize 10, maxRowsPerTable 30 → the run stops
    // after 30 rows (3 batches), leaving 70 for the next night. This is
    // what prevents a months-deep backlog from running the single
    // advisory-lock transaction past 60 s → P2028 → permanent loop.
    const now = Date.now();
    const oldAt = new Date(now - 60 * 86400_000);
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: BigInt(i + 1),
      at: oldAt,
    }));
    const activity = makeActivityTable(rows);
    const prisma = {
      activityRow: activity,
      commandAuditLog: makeLogTable([]),
      notificationLog: makeLogTable([]),
    };

    const result = await purgeAuditLogs(prisma as any, 30, {
      batchSize: 10,
      maxRowsPerTable: 30,
    });

    expect(result.activityDeleted).toBe(30);
    // 70 rows remain for subsequent nightly runs → drains over nights.
    expect(activity.rows).toHaveLength(70);
    // Capped at 3 batches (30 / 10), not 10 (100 / 10).
    expect(activity.deleteMany).toHaveBeenCalledTimes(3);
  });

  it("Finding 2: log tables (CommandAuditLog/NotificationLog) also batch + cap", async () => {
    const now = Date.now();
    const oldAt = new Date(now - 60 * 86400_000);
    const cmds = Array.from({ length: 14 }, (_, i) => ({
      id: `cmd-${i}`,
      createdAt: oldAt,
    }));
    const notifs = Array.from({ length: 14 }, (_, i) => ({
      id: `notif-${i}`,
      createdAt: oldAt,
    }));
    const command = makeLogTable(cmds);
    const notification = makeLogTable(notifs);
    const prisma = {
      activityRow: makeActivityTable([]),
      commandAuditLog: command,
      notificationLog: notification,
    };

    const result = await purgeAuditLogs(prisma as any, 30, { batchSize: 5 });

    expect(result.commandAuditDeleted).toBe(14);
    expect(result.notificationDeleted).toBe(14);
    expect(command.rows).toHaveLength(0);
    expect(notification.rows).toHaveLength(0);
    // 14 rows / batch 5 → 3 batches each (5 + 5 + 4).
    expect(command.deleteMany).toHaveBeenCalledTimes(3);
    expect(notification.deleteMany).toHaveBeenCalledTimes(3);
  });
});
