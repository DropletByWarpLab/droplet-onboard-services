import type { PrismaClient } from "@prisma/client";
import type { CronRuntime } from "../cron-runtime.service.js";
import { registerOutboxConsumer } from "../pm/pm-outbox.js";
import { sweepTicketSlas, syncTicketSla } from "./sla-clock.service.js";
import type { SupportDeps } from "./requester.service.js";

export function registerSupportSlaRuntime(prisma: PrismaClient, cronRuntime: CronRuntime, deps: SupportDeps = {}): void {
  // Deadline passage needs a clock even when no activity is written. This is a
  // job on the existing runtime, with its existing replica lock and shutdown.
  cronRuntime.scheduleInterval(60_000, () => sweepTicketSlas(prisma, deps).then(() => undefined), {
    lockKey: "droplet:support-sla-clock", immediate: true,
  });
  // Repair a clock after another canonical Support writer commits a change.
  // Own writes are already materialised inside their transaction; this is idempotent.
  registerOutboxConsumer({ name: "support-sla", intervalMs: 60_000, handle: async (row) => {
    if (!["created", "state_changed", "updated", "commented"].includes(row.verb)) return;
    await prisma.$transaction((tx) => syncTicketSla(tx, row.workItemId, deps.now?.() ?? new Date(), "tick", deps));
  } }, { prisma, cronRuntime, now: deps.now });
}
