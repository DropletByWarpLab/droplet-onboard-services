import { describe, it, expect, vi } from "vitest";
import { purgeScheduleEvents, purgeExpiredOverrides } from "./schedule-purge.js";

describe("schedule-purge", () => {
  it("purgeScheduleEvents deletes events older than cutoff", async () => {
    const prisma = {
      scheduleEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 42 }) },
    } as any;
    const count = await purgeScheduleEvents(prisma, 7);
    expect(count).toBe(42);
    const arg = prisma.scheduleEvent.deleteMany.mock.calls[0][0];
    expect(arg.where.occurredAt.lt).toBeInstanceOf(Date);
    const cutoff = arg.where.occurredAt.lt as Date;
    const expected = Date.now() - 7 * 86400_000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(1000);
  });

  it("purgeExpiredOverrides deletes overrides whose endAt is older than cutoff", async () => {
    const prisma = {
      scheduleOverride: { deleteMany: vi.fn().mockResolvedValue({ count: 7 }) },
    } as any;
    const count = await purgeExpiredOverrides(prisma, 24);
    expect(count).toBe(7);
    const arg = prisma.scheduleOverride.deleteMany.mock.calls[0][0];
    const cutoff = arg.where.endAt.lt as Date;
    const expected = Date.now() - 24 * 3600_000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(1000);
  });
});
