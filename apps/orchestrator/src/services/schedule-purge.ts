/**
 * Phase 2 retention jobs (WARP-93).
 *
 * Two small deleteMany helpers driven by the daily 03:00 cron in
 * `index.ts`:
 *   - `purgeScheduleEvents` drops audit-log rows older than
 *     `olderThanDays` (default 7). Seven days is enough for the "why
 *     is this blocked?" UI to show recent history without letting the
 *     table grow unbounded.
 *   - `purgeExpiredOverrides` drops one-shot overrides whose `endAt`
 *     passed more than `olderThanHours` ago (default 24). The ticker
 *     already ignores expired overrides via its `where` clause, so this
 *     is purely row-count hygiene, not correctness.
 *
 * Both return the number of rows deleted so the cron handler can log a
 * single summary line.
 */
import type { PrismaClient } from "@prisma/client";

export async function purgeScheduleEvents(
  prisma: PrismaClient,
  olderThanDays = 7,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
  const res = await (prisma as any).scheduleEvent.deleteMany({
    where: { occurredAt: { lt: cutoff } },
  });
  return res.count;
}

export async function purgeExpiredOverrides(
  prisma: PrismaClient,
  olderThanHours = 24,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000);
  const res = await (prisma as any).scheduleOverride.deleteMany({
    where: { endAt: { lt: cutoff } },
  });
  return res.count;
}
