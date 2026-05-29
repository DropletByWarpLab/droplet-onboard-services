/**
 * WARP-463 (C2) — tool-schedule-ticker.
 *
 * Every 60s scans ToolSchedule rows whose `nextFireAt <= now()` and:
 *   1. Resolves the parent spec (must be status=live).
 *   2. Safety gate — when `spec.writes && !spec.reversible` we DO NOT
 *      auto-fire; the run is skipped, an ActivityRow is emitted, and
 *      `nextFireAt` still advances so the schedule doesn't loop. This
 *      keeps "destructive + unreliable to undo" specs from running
 *      unattended; a future pending-confirmation queue can resurface
 *      them. Per the §7 contract: "write-tier specs that aren't
 *      `reversible:true && !writes` emit a confirm_action card and
 *      pause until accept" — v1 pause = skip + audit + advance.
 *   3. Otherwise dispatches via the imperative walker (WARP-462's
 *      `runToolSpec`) with `triggeredBy="scheduler"`.
 *   4. Advances `nextFireAt` via the RRULE parser. Malformed or
 *      unsupported rules → disable the schedule + emit ActivityRow,
 *      so a typo in the dashboard editor can't pin the ticker on
 *      `nextFireAt <= now()` forever.
 *
 * The ticker is mounted in `index.ts` via `cronRuntime.scheduleInterval`
 * with a pg advisory lock — multi-instance deploys (warm standby, K8s
 * replicas) only fire each due schedule once.
 */
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { runToolSpec, type StepDispatcher } from "./tool-spec-runner.service.js";
import { recordActivity } from "./activity.singleton.js";
import { nextFireFromRrule } from "../utils/rrule.js";

const logger = pino({ name: "tool-schedule-ticker" });

interface ScheduleRow {
  id: string;
  specId: string;
  rrule: string;
  nextFireAt: Date;
  enabled: boolean;
}
interface SpecRow {
  id: string;
  slug: string;
  name: string;
  status: "live" | "draft" | "suggested";
  writes: boolean;
  reversible: boolean;
}
interface StepRow {
  id: string;
  idx: number;
  kind: string;
  args: unknown;
}

export interface TickResult {
  inspected: number;
  fired: number;
  skipped: number;
  disabled: number;
}

/**
 * Run one scheduler tick. Pure function over (prisma, dispatcher,
 * now) so tests can drive it with a fake clock without standing up
 * cron-runtime.
 */
export async function tickToolSchedules(
  prisma: PrismaClient,
  dispatcher: StepDispatcher,
  now: Date = new Date(),
): Promise<TickResult> {
  const due = (await prisma.toolSchedule.findMany({
    where: { enabled: true, nextFireAt: { lte: now } },
    orderBy: { nextFireAt: "asc" },
    take: 50,
  })) as unknown as ScheduleRow[];

  let fired = 0;
  let skipped = 0;
  let disabled = 0;

  for (const schedule of due) {
    const spec = (await prisma.toolSpec.findUnique({
      where: { id: schedule.specId },
      include: { steps: { orderBy: { idx: "asc" } } },
    })) as unknown as (SpecRow & { steps: StepRow[] }) | null;

    if (!spec) {
      // Spec was deleted out-of-band but the schedule survived (FK
      // CASCADE should prevent this; defensive). Disable so we don't
      // loop on it.
      await prisma.toolSchedule.update({
        where: { id: schedule.id },
        data: { enabled: false },
      });
      disabled += 1;
      continue;
    }

    if (spec.status !== "live") {
      // Spec was demoted from live → draft after the schedule was
      // created. Skip the run but advance nextFireAt so a re-publish
      // resumes the cadence cleanly.
      await advanceOrDisable(prisma, schedule, now);
      skipped += 1;
      continue;
    }

    if (spec.writes && !spec.reversible) {
      // Safety gate — see file header. Skip + audit + advance.
      await recordActivity({
        kind: "tool_run",
        severity: "warn",
        sourceIcon: "shield",
        what: "Scheduled run skipped (needs confirmation)",
        sub: `${spec.name} (writes + !reversible)`,
        refs: {
          specId: spec.id,
          scheduleId: schedule.id,
          reason: "writes_and_not_reversible",
        },
      });
      await advanceOrDisable(prisma, schedule, now);
      skipped += 1;
      continue;
    }

    try {
      await runToolSpec(prisma, dispatcher, {
        specId: spec.id,
        specName: spec.name,
        steps: spec.steps,
        triggeredBy: "scheduler",
      });
      fired += 1;
    } catch (err) {
      // runToolSpec already records the failure ActivityRow + writes
      // the ToolRun row. A throw here means infrastructure failure
      // (DB write failed, etc.); log + move on. The schedule still
      // advances so we don't pin the ticker on a wedged schedule.
      logger.warn(
        { err, specId: spec.id, scheduleId: schedule.id },
        "scheduled run threw (advancing anyway)",
      );
    }
    await advanceOrDisable(prisma, schedule, now);
  }

  return { inspected: due.length, fired, skipped, disabled };
}

async function advanceOrDisable(
  prisma: PrismaClient,
  schedule: ScheduleRow,
  now: Date,
): Promise<void> {
  const next = nextFireFromRrule(schedule.rrule, now);
  if (next === null) {
    // Malformed or unsupported rule. Disable + audit so an operator
    // can fix the editor input rather than the ticker silently
    // spamming the activity feed.
    await prisma.toolSchedule.update({
      where: { id: schedule.id },
      data: { enabled: false },
    });
    await recordActivity({
      kind: "system",
      severity: "warn",
      sourceIcon: "clock",
      what: "Tool schedule disabled (RRULE parse failed)",
      sub: `schedule ${schedule.id}`,
      refs: {
        specId: schedule.specId,
        scheduleId: schedule.id,
        rrule: schedule.rrule,
      },
    });
    return;
  }
  await prisma.toolSchedule.update({
    where: { id: schedule.id },
    data: { nextFireAt: next },
  });
}
