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
 *   3. ACCESS gate (WARP-1580, WARP-1621) — resolves the spec's ATTRIBUTED
 *      principal and skips the fire when that identity may not invoke the
 *      spec's tools, on EITHER axis: the ADR-004 write tier or its §3
 *      per-role tool domains. See "WHOSE ACCESS" below.
 *   4. Otherwise dispatches via the imperative walker (WARP-462's
 *      `runToolSpec`) with `triggeredBy="scheduler"`.
 *   5. Advances `nextFireAt` via the RRULE parser. Malformed or
 *      unsupported rules → disable the schedule + emit ActivityRow,
 *      so a typo in the dashboard editor can't pin the ticker on
 *      `nextFireAt <= now()` forever.
 *
 * The ticker is mounted in `index.ts` via `cronRuntime.scheduleInterval`
 * with a pg advisory lock — multi-instance deploys (warm standby, K8s
 * replicas) only fire each due schedule once.
 *
 * ── WHOSE ACCESS (WARP-1580) ──────────────────────────────────────
 *
 * A scheduled fire has no session, no token and no `req.user`, so before
 * this it dispatched with NO principal — i.e. at the full registry reach of
 * the singleton MCP client. That made a schedule a laundering path around
 * the WARP-1529 (RBAC v2 T5) per-role narrowing that chat enforces: narrow a
 * person's role to `files` and their spec still fired `control_device` every
 * morning. It is not enough to narrow the interactive run-now path; a run
 * with no principal has nothing to narrow AGAINST.
 *
 * DECISION: a scheduled run executes as its spec's CREATOR (`ToolSpec.
 * ownerId`, stamped from `req.user.id` at POST /api/tools and, since
 * WARP-1580, at draft→live promotion for miner-suggested specs), and that
 * identity's CURRENT effective access is resolved at EVERY fire. A run that
 * cannot be attributed does not run.
 *
 * Why resolve at fire time, not schedule time: narrowing is dynamic. Grants,
 * tier and directory status all change after a schedule is written, so a
 * schedule-time check is stale by construction — and stale in the fail-OPEN
 * direction, which is the only direction that matters. Resolving per fire is
 * what makes "the creator was demoted last week" actually stop the run. It
 * costs one indexed read per due schedule, on a path that already does
 * several per row.
 *
 * Why NOT an explicit system principal: a system identity is by construction
 * un-narrowable, and any operator-authored spec could borrow it. That
 * re-opens this exact hole one hop further away, where it is harder to see.
 *
 * Why NOT refusing to SCHEDULE specs that touch narrowed domains: same
 * staleness problem, plus it would refuse at the wrong moment (an owner
 * scheduling an owner-reach spec is legitimate; the question is who it runs
 * as later).
 *
 * FAIL-CLOSED. `resolveAttributedToolAccess` answers DENY_ALL — never "no
 * narrowing" — for an absent ownerId, a deleted or deactivated creator, and
 * a failed read. The fire is then skipped, audited with the reason, and
 * `nextFireAt` still advances so a re-grant resumes the cadence cleanly
 * (the same skip-and-advance posture as the writes/!reversible gate).
 *
 * ── WHICH GATE (WARP-1621) ─────────────────────────────────────────
 *
 * A resolved creator still has TWO independent gates to clear, and a scope
 * alone cannot express the first: a creator with no AccessRole resolves to
 * `scope: null`, which means "axis B does not narrow this person", NOT "this
 * person may run anything". So the attributed TIER is carried alongside the
 * scope and the coarse ADR-004 write filter is applied to it — otherwise a
 * `family`-owned spec calling `control_device` fires unattended every morning
 * at reach the same person's chat turn never had. Since custom roles are new,
 * a role-less creator is the normal case on a deployed box, not an edge one.
 */
import type { PrismaClient } from "@prisma/client";
import {
  plannedToolNames,
  runToolSpec,
  type StepDispatcher,
} from "./tool-spec-runner.service.js";
import {
  firstToolDeniedForPrincipal,
  resolveAttributedToolAccess,
} from "./tool-access.service.js";
import { recordActivity } from "./activity.singleton.js";
import { nextFireFromRrule } from "../utils/rrule.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tool-schedule-ticker");

interface ScheduleRow {
  id: string;
  specId: string;
  rrule: string;
  /** WARP-2665 — IANA zone the rrule's wall-clock is read in. "UTC" for every
   *  row written before the column existed, which is the parser's fast path. */
  timezone: string;
  nextFireAt: Date;
  enabled: boolean;
}
interface SpecRow {
  id: string;
  slug: string;
  name: string;
  status: "live" | "draft" | "suggested";
  /** WARP-1580 — the attributed principal a scheduled fire runs as. */
  ownerId: string | null;
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
        actor: { type: "system" },
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

    // Access gate — see "WHOSE ACCESS" in the file header. Both axes, in one
    // pre-flight, against the SAME predicate chat and run-now use:
    //   A. ADR-004 write tier (WARP-1621), read off the creator's User row.
    //   B. WARP-1580 / §3 per-role tool domains.
    // Axis A matters most here precisely because axis B skips role-less
    // creators: without it a family-owned spec calling `control_device` fired
    // every morning at reach the same person's chat turn never had.
    const attributed = await resolveAttributedToolAccess(prisma, spec.ownerId);
    const denied =
      attributed.unresolved !== null
        ? null
        : firstToolDeniedForPrincipal(
            plannedToolNames(spec.steps),
            attributed.tier ?? undefined,
            attributed.scope,
          );
    if (attributed.unresolved !== null || denied !== null) {
      const reason = attributed.unresolved ?? "forbidden_tool_for_role";
      await recordActivity({
        kind: "tool_run",
        severity: "warn",
        sourceIcon: "shield",
        what: "Scheduled run skipped (access)",
        actor: { type: "system" },
        sub:
          denied === null
            ? `${spec.name} (no resolvable owner)`
            : `${spec.name} (${denied.tool} not permitted for its owner)`,
        refs: {
          specId: spec.id,
          scheduleId: schedule.id,
          reason,
          ownerId: spec.ownerId,
          // `axis` says WHICH gate refused — the coarse tier floor or a
          // missing per-role grant. Same fix, very different remediation.
          ...(denied !== null ? { tool: denied.tool, axis: denied.axis } : {}),
        },
      });
      logger.warn(
        {
          specId: spec.id,
          scheduleId: schedule.id,
          reason,
          ...(denied !== null ? { axis: denied.axis } : {}),
          ownerId: spec.ownerId,
        },
        "scheduled run skipped on access",
      );
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
        // The runner re-checks per step: `${prev}` substitution means the §3
        // lock rule can only see a step's real args at dispatch.
        scope: attributed.scope,
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
  // WARP-2665 — the zone is the third argument, not a default. Dropping it
  // here is what made a "07:00" routine a 07:00-UTC routine.
  const next = nextFireFromRrule(schedule.rrule, now, schedule.timezone ?? "UTC");
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
      actor: { type: "system" },
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
