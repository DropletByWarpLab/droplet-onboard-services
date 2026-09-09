/**
 * WARP-2180 — agent-run-schedule ticker.
 *
 * Every 60 s scans `AgentRunSchedule` rows whose `nextFireAt <= now()` and
 * ENQUEUES an `AgentRun` for each — it never runs the model itself. The
 * agent-run worker claims the queued row like any other, re-resolving the
 * creator's reach at claim (WARP-1580), so a schedule cannot outlive its
 * creator's role. `nextFireAt` then advances from the RRULE; a rule that no
 * longer parses disables the schedule and writes a `system` row, so a bad
 * edit cannot pin the ticker on `nextFireAt <= now()` forever. The same
 * shape as the ToolSchedule (WARP-463) and SceneSchedule tickers, on the
 * same clock (`cronRuntime.scheduleInterval`, lock key
 * `droplet:agent-run-schedule-ticker`).
 *
 * `runAfter` on the enqueued run is the fire time, so a ticker that wakes
 * late still orders the runs it creates correctly.
 */
import type { PrismaClient } from "@prisma/client";
import { enqueueAgentRun } from "./agent-run-worker.service.js";
import { recordActivity } from "./activity.singleton.js";
import { nextFireFromRrule } from "../utils/rrule.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("agent-run-schedule-ticker");

export const AGENT_RUN_SCHEDULE_LOCK_KEY = "droplet:agent-run-schedule-ticker";

interface ScheduleRow {
  id: string;
  userId: string;
  goal: string;
  model: string;
  maxIter: number;
  rrule: string;
  timezone: string;
  nextFireAt: Date;
  enabled: boolean;
}

export interface AgentRunScheduleTickResult {
  inspected: number;
  fired: number;
  disabled: number;
  skipped: number;
}

export async function tickAgentRunSchedules(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<AgentRunScheduleTickResult> {
  const due = (await prisma.agentRunSchedule.findMany({
    where: { enabled: true, nextFireAt: { lte: now } },
    orderBy: { nextFireAt: "asc" },
    take: 50,
  })) as unknown as ScheduleRow[];

  let fired = 0;
  let disabled = 0;
  let skipped = 0;
  for (const schedule of due) {
    // Enqueue and advance in ONE transaction. Done as two statements, a
    // failed advance after a successful enqueue left the schedule still due
    // and the next tick fired it again — a second run for the same slot.
    // Inside one transaction a failure anywhere leaves nothing behind, and
    // the next tick retries the whole fire.
    const next = nextFireFromRrule(schedule.rrule, now, schedule.timezone);
    // `null` = the owner is gone and the schedule was disabled instead of fired.
    let runId: string | null;
    try {
      runId = await prisma.$transaction(async (tx) => {
        // WARP-2744 item 4 — `AgentRunSchedule.userId` carries no FK, so a
        // deleted account's schedule would fire every slot and every run
        // would fail as attribution_failed:user_missing. Disable it here,
        // once, in the same transaction, with a system row below.
        const owner = await tx.user.findUnique({
          where: { id: schedule.userId },
          select: { id: true },
        });
        if (!owner) {
          await tx.agentRunSchedule.update({
            where: { id: schedule.id },
            data: { enabled: false, lastFiredAt: now },
          });
          return null;
        }
        const created = await enqueueAgentRun(tx, {
          userId: schedule.userId,
          goal: schedule.goal,
          model: schedule.model,
          maxIter: schedule.maxIter,
          runAfter: schedule.nextFireAt,
        });
        await tx.agentRunSchedule.update({
          where: { id: schedule.id },
          data:
            next === null
              ? { enabled: false, lastFiredAt: now }
              : { nextFireAt: next, lastFiredAt: now },
        });
        return created.id;
      });
    } catch (err) {
      logger.warn({ err, scheduleId: schedule.id }, "agent_run_schedule_fire_failed");
      skipped += 1;
      continue;
    }
    if (runId === null) {
      await recordActivity({
        kind: "system",
        severity: "warn",
        sourceIcon: "clock",
        what: "Agent run schedule disabled (owner no longer exists)",
        actor: { type: "system" },
        sub: `schedule ${schedule.id}`,
        refs: { agentRunScheduleId: schedule.id, userId: schedule.userId, reason: "user_missing" },
      });
      logger.warn({ scheduleId: schedule.id, userId: schedule.userId }, "agent_run_schedule_owner_missing");
      disabled += 1;
      continue;
    }
    fired += 1;
    logger.info({ scheduleId: schedule.id, runId }, "agent_run_schedule_fired");
    if (next === null) {
      await recordActivity({
        kind: "system",
        severity: "warn",
        sourceIcon: "clock",
        what: "Agent run schedule disabled (RRULE parse failed)",
        actor: { type: "system" },
        sub: `schedule ${schedule.id}`,
        refs: { agentRunScheduleId: schedule.id, rrule: schedule.rrule },
      });
      disabled += 1;
    }
  }
  return { inspected: due.length, fired, disabled, skipped };
}
