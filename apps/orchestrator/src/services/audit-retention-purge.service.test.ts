import { describe, it, expect, vi } from "vitest";
import { purgeAuditLogs } from "./audit-retention-purge.service.js";

/**
 * WARP-586 — retention purge for ActivityRow / CommandAuditLog /
 * NotificationLog. Prisma's deleteMany is mocked; we assert the cutoff
 * date and the per-table `where` columns, and that <= 0 disables the
 * purge (the "keep forever" stance).
 */
function createPrismaMock(counts: {
  activity: number;
  commandAudit: number;
  notification: number;
}) {
  return {
    activityRow: {
      deleteMany: vi.fn().mockResolvedValue({ count: counts.activity }),
    },
    commandAuditLog: {
      deleteMany: vi.fn().mockResolvedValue({ count: counts.commandAudit }),
    },
    notificationLog: {
      deleteMany: vi.fn().mockResolvedValue({ count: counts.notification }),
    },
  };
}

describe("WARP-586 — purgeAuditLogs", () => {
  it("deletes rows older than the window from all three tables and returns counts", async () => {
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

    // ActivityRow filters on `at`; the log tables filter on `createdAt`.
    const activityArg = prisma.activityRow.deleteMany.mock.calls[0][0];
    const commandArg = prisma.commandAuditLog.deleteMany.mock.calls[0][0];
    const notifArg = prisma.notificationLog.deleteMany.mock.calls[0][0];

    const expectedCutoff = Date.now() - 90 * 86400_000;
    const activityCutoff = activityArg.where.at.lt as Date;
    const commandCutoff = commandArg.where.createdAt.lt as Date;
    const notifCutoff = notifArg.where.createdAt.lt as Date;

    expect(activityCutoff).toBeInstanceOf(Date);
    expect(commandCutoff).toBeInstanceOf(Date);
    expect(notifCutoff).toBeInstanceOf(Date);
    expect(Math.abs(activityCutoff.getTime() - expectedCutoff)).toBeLessThan(
      1000,
    );
    expect(Math.abs(commandCutoff.getTime() - expectedCutoff)).toBeLessThan(
      1000,
    );
    expect(Math.abs(notifCutoff.getTime() - expectedCutoff)).toBeLessThan(1000);
  });

  it("uses an `lt` cutoff so rows newer than the window survive", async () => {
    // The query is the contract: deleteMany only matches `< cutoff`, so
    // anything at/after the cutoff (newer rows) is never touched. We
    // assert the operator is `lt` (not `lte`/`gt`) on every table.
    const prisma = createPrismaMock({
      activity: 0,
      commandAudit: 0,
      notification: 0,
    });

    await purgeAuditLogs(prisma as any, 30);

    const activityWhere = prisma.activityRow.deleteMany.mock.calls[0][0].where;
    const commandWhere =
      prisma.commandAuditLog.deleteMany.mock.calls[0][0].where;
    const notifWhere =
      prisma.notificationLog.deleteMany.mock.calls[0][0].where;

    expect(Object.keys(activityWhere.at)).toEqual(["lt"]);
    expect(Object.keys(commandWhere.createdAt)).toEqual(["lt"]);
    expect(Object.keys(notifWhere.createdAt)).toEqual(["lt"]);
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
    expect(prisma.activityRow.deleteMany).not.toHaveBeenCalled();
  });
});
