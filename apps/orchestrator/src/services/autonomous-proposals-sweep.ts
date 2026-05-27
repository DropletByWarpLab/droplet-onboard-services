/**
 * Expiry sweep for `AutonomousProposal` rows (WARP-399).
 *
 * The Prisma model + migration both promise that "the cron-runtime
 * sweep marks anything past `expiresAt` as `expired`" (default 1 h).
 * Without an actual wired sweep, expired proposals sit at `pending`
 * forever and the `?status=expired` filter in the ops-console inbox
 * returns zero rows. This module provides the sweep; `index.ts` wires
 * it via `cronRuntime.scheduleInterval` so the multi-instance advisory
 * lock prevents two replicas from racing on the same flip.
 *
 * Returns the number of rows flipped so the cron handler can log one
 * summary line — same shape as `purgeScheduleEvents` etc.
 */
import type { PrismaClient } from "@prisma/client";

export async function expirePendingProposals(
  prisma: PrismaClient,
): Promise<number> {
  const result = await prisma.autonomousProposal.updateMany({
    where: {
      status: "pending",
      expiresAt: { lt: new Date() },
    },
    data: { status: "expired" },
  });
  return result.count;
}
