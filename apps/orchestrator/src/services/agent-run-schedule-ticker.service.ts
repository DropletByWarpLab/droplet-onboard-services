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
 *
 * WARP-2877 — A SCHEDULE NEVER STACKS ON TOP OF ITSELF. Each enqueued run
 * carries `AgentRun.scheduleId`, and a due schedule whose previous fire is
 * still in an active status is SKIPPED: `nextFireAt` advances (the slot is
 * gone, not owed), `lastFiredAt` does not, and one line is logged. Without
 * it a job that outran its period piled up — N copies of one goal, each
 * holding an inference slot, racing each other over the same files — and a
 * run parked on an unanswered Tier-2 approval did it every single tick.
 */
import type { PrismaClient } from "@prisma/client";
import { ACTIVE_AGENT_RUN_STATUSES, enqueueAgentRun } from "./agent-run-worker.service.js";
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
  /** A fire that threw and was rolled back; the next tick retries it. */
  skipped: number;
  /** WARP-2877 — a fire suppressed because the previous one is still going. */
  skippedOverlap: number;
}

/**
 * WARP-2877 — what one due schedule did this tick. `overlap` is not an error
 * and not a failure to retry, so it cannot be folded into either: the slot
 * passed while the previous run was still working, `nextFireAt` advanced, and
 * nothing was enqueued.
 */
type FireOutcome =
  | { kind: "fired"; runId: string }
  | { kind: "owner_missing" }
  | { kind: "overlap"; activeRunId: string };

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
  let skippedOverlap = 0;
  for (const schedule of due) {
    // Enqueue and advance in ONE transaction. Done as two statements, a
    // failed advance after a successful enqueue left the schedule still due
    // and the next tick fired it again — a second run for the same slot.
    // Inside one transaction a failure anywhere leaves nothing behind, and
    // the next tick retries the whole fire.
    const next = nextFireFromRrule(schedule.rrule, now, schedule.timezone);
    // Read BEFORE the advance below overwrites it: `runAfter` is this slot's
    // fire time, not the next one's, so a ticker that wakes late still orders
    // the runs it creates correctly.
    const fireAt = schedule.nextFireAt;
    let outcome: FireOutcome;
    try {
      outcome = await prisma.$transaction<FireOutcome>(async (tx) => {
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
          return { kind: "owner_missing" };
        }
        // WARP-2877 — DO NOT STACK A SCHEDULE ON TOP OF ITSELF.
        //
        // Every due tick enqueued a run and advanced `nextFireAt` regardless
        // of the previous fire. A daily sweep that outruns its period — a
        // long job on a busy box, or one parked on a Tier-2 approval nobody
        // has answered — therefore piled up: N copies of one goal, each
        // holding an inference slot, racing each other over the same files.
        //
        // Inside the same transaction as the advance, so the probe cannot
        // read a state the advance then invalidates. The index
        // `AgentRun(scheduleId, status)` is what keeps this cheap.
        const active = (await tx.agentRun.findFirst({
          where: { scheduleId: schedule.id, status: { in: [...ACTIVE_AGENT_RUN_STATUSES] } },
          select: { id: true },
        })) as { id: string } | null;
        // `nextFireAt` advances either way. A skipped slot is GONE, not owed:
        // leaving the schedule due would pin the ticker on it forever, and
        // firing the backlog once the long run ends is the same pile-up
        // arriving late. `lastFiredAt` is NOT touched — it records when this
        // schedule last actually fired, and this time it did not.
        await tx.agentRunSchedule.update({
          where: { id: schedule.id },
          data: {
            ...(next === null ? { enabled: false } : { nextFireAt: next }),
            ...(active ? {} : { lastFiredAt: now }),
          },
        });
        if (active) return { kind: "overlap", activeRunId: active.id };
        const created = await enqueueAgentRun(tx, {
          userId: schedule.userId,
          goal: schedule.goal,
          model: schedule.model,
          maxIter: schedule.maxIter,
          runAfter: fireAt,
          scheduleId: schedule.id,
        });
        return { kind: "fired", runId: created.id };
      });
    } catch (err) {
      logger.warn({ err, scheduleId: schedule.id }, "agent_run_schedule_fire_failed");
      skipped += 1;
      continue;
    }
    if (outcome.kind === "overlap") {
      // ONE line, ids only: a schedule that overlaps once usually overlaps
      // every tick until the long run ends, and a goal is user-authored free
      // text that has no business in the log stream.
      logger.warn(
        { scheduleId: schedule.id, activeRunId: outcome.activeRunId },
        "agent_run_schedule_skipped_overlap",
      );
      skippedOverlap += 1;
      // Falls through to the RRULE check below: a skipped fire whose rule no
      // longer parses was still just disabled, and that must be announced.
    }
    if (outcome.kind === "owner_missing") {
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
    if (outcome.kind === "fired") {
      fired += 1;
      logger.info({ scheduleId: schedule.id, runId: outcome.runId }, "agent_run_schedule_fired");
    }
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
  return { inspected: due.length, fired, disabled, skipped, skippedOverlap };
}
