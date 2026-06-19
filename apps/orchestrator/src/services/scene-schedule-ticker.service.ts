/**
 * feat/scene-schedules — scene-schedule-ticker.
 *
 * EXACT clone of the WARP-463 tool-schedule-ticker. Every 60s scans
 * SceneSchedule rows whose `nextFireAt <= now()` and:
 *   1. Resolves the parent Scene (with ordered actions). A missing
 *      Scene (FK CASCADE should prevent it; defensive) → disable the
 *      schedule + audit, so we don't loop on it.
 *   2. Fires the routine via the shared `executeScene` path with
 *      `triggeredBy="scheduler"` — the SAME walker the interactive
 *      `POST /scenes/:id/run` route uses, so the two can't drift.
 *   3. Sets `lastFiredAt` + advances `nextFireAt` via the RRULE parser
 *      in ONE update. Malformed / unsupported rules → disable the
 *      schedule + emit ActivityRow, so a typo in the dashboard editor
 *      can't pin the ticker on `nextFireAt <= now()` forever.
 *
 * SAFETY POSTURE — unattended runs bypass the per-run scene confirm-token.
 * That is OK ONLY because creating the schedule IS the owner/admin opt-in
 * (mirrors the ToolSchedule justification: "write-tier specs … pause
 * until accept" → here the accept happened at schedule-creation time).
 * Every fire is audited via `executeScene`'s `smart_home` row + the
 * ticker's own disable rows. We do NOT silently bypass the Tier-2 gate.
 *
 * The ticker is mounted in `index.ts` via `cronRuntime.scheduleInterval`
 * with a pg advisory lock — multi-instance deploys only fire each due
 * schedule once.
 */
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { recordActivity } from "./activity.singleton.js";
import { nextFireFromRrule } from "../utils/rrule.js";
import { executeScene } from "./scene-runner.service.js";
import type { MatterDispatcher } from "../routes/scenes.js";

const logger = pino({ name: "scene-schedule-ticker" });

interface ScheduleRow {
  id: string;
  sceneId: string;
  rrule: string;
  nextFireAt: Date;
  enabled: boolean;
}
interface SceneActionRow {
  idx: number;
  deviceNodeId: string;
  command: string;
  args: unknown;
}
interface SceneRow {
  id: string;
  name: string;
  actions: SceneActionRow[];
}

export interface SceneTickResult {
  inspected: number;
  fired: number;
  skipped: number;
  disabled: number;
}

/**
 * Run one scheduler tick. Pure function over (prisma, matter, now) so
 * tests can drive it with a fake clock without standing up cron-runtime.
 */
export async function tickSceneSchedules(
  prisma: PrismaClient,
  matter: MatterDispatcher,
  now: Date = new Date(),
): Promise<SceneTickResult> {
  const due = (await prisma.sceneSchedule.findMany({
    where: { enabled: true, nextFireAt: { lte: now } },
    orderBy: { nextFireAt: "asc" },
    take: 50,
  })) as unknown as ScheduleRow[];

  let fired = 0;
  let skipped = 0;
  let disabled = 0;

  for (const schedule of due) {
    const scene = (await prisma.scene.findUnique({
      where: { id: schedule.sceneId },
      include: { actions: { orderBy: { idx: "asc" } } },
    })) as unknown as SceneRow | null;

    if (!scene) {
      // Parent routine was deleted out-of-band but the schedule survived
      // (FK CASCADE should prevent this; defensive). Disable + audit so
      // we don't loop on it.
      await prisma.sceneSchedule.update({
        where: { id: schedule.id },
        data: { enabled: false },
      });
      await recordActivity({
        kind: "smart_home",
        severity: "warn",
        sourceIcon: "clock",
        what: "Scene schedule disabled (routine deleted)",
        sub: `schedule ${schedule.id}`,
        refs: { sceneId: schedule.sceneId, scheduleId: schedule.id },
      });
      disabled += 1;
      continue;
    }

    try {
      // Unattended fire — see file header. The schedule itself was the
      // owner/admin opt-in, so we bypass the per-run confirm-token and
      // run the routine through the shared executor. executeScene records
      // the audited `smart_home` row; partial device failures are
      // tolerated there and don't throw.
      await executeScene(prisma, matter, scene, { triggeredBy: "scheduler" });
      fired += 1;
    } catch (err) {
      // A throw here is infrastructure failure (the audit write inside
      // executeScene, etc.); log + move on. The schedule still advances
      // so we don't pin the ticker on a wedged schedule.
      logger.warn(
        { err, sceneId: scene.id, scheduleId: schedule.id },
        "scheduled scene run threw (advancing anyway)",
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
    // Malformed or unsupported rule. Disable + audit so an operator can
    // fix the editor input rather than the ticker silently spamming the
    // activity feed. NEVER leave it enabled on a stuck nextFireAt.
    await prisma.sceneSchedule.update({
      where: { id: schedule.id },
      data: { enabled: false },
    });
    await recordActivity({
      kind: "system",
      severity: "warn",
      sourceIcon: "clock",
      what: "Scene schedule disabled (RRULE parse failed)",
      sub: `schedule ${schedule.id}`,
      refs: {
        sceneId: schedule.sceneId,
        scheduleId: schedule.id,
        rrule: schedule.rrule,
      },
    });
    return;
  }
  // Set lastFiredAt + nextFireAt in one update (the fire just happened at
  // `now`; the next occurrence is `next`).
  await prisma.sceneSchedule.update({
    where: { id: schedule.id },
    data: { lastFiredAt: now, nextFireAt: next },
  });
}
