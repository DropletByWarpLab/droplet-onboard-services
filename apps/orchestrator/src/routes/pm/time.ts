/**
 * WARP-3526 (ADR-069 WS-10) — time tracking under /api/pm:
 *
 *   GET    /pm/work-items/:id/worklogs       an item's entries + totals
 *   POST   /pm/work-items/:id/worklogs       log time
 *   PATCH  /pm/worklogs/:id                  edit an entry
 *   DELETE /pm/worklogs/:id                  remove an entry
 *   GET    /pm/timer                         the caller's running timer
 *   POST   /pm/timer/start | /pm/timer/stop  start (stopping any other) / stop (logs it)
 *   GET    /pm/timesheet                     one person's Monday-to-Sunday week
 *   GET    /pm/time/report                   time over a window, by person | item | day (+ CSV)
 *
 * Its own router rather than more lines in routes/pm/native.ts, the way
 * routes/pm/relations.ts is: the paths are disjoint, the error vocabulary is its
 * own, and several concurrent changes edit native.ts. Mounted on the same `/api`
 * prefix in app.ts, immediately after the relations router, so `mountModuleGates`
 * and the MCP acting-user gate cover it through the `/api/pm` prefix exactly as
 * they cover every other PM route.
 *
 * Auth: mounted AFTER authMiddleware. Reads are open to any role the module gate
 * lets through — PM is household-shared — and an external guest is not one: the
 * `projects` tier floor answers 404 on the whole of `/api/pm` before a route here
 * runs, and `modules/guest-shares.ts` deliberately names NONE of these routes
 * (a guest's share is one work item's read, its comments and its state — not the
 * clock on it, and not anybody's hours).
 *
 * Writes take `requireRole(...WRITE)` and do NOT admit the MCP service principal,
 * unlike the work-item and comment writes in native.ts. Time belongs to a person
 * — an entry is hours somebody spent, a timer is somebody's running clock — and
 * `_service:mcp` is nobody (`actorOf` is null for it). Admitting it would only
 * create entries with no owner. If an assistant verb for time lands, that change
 * widens this guard and adds its TOOL_ROUTES hop in the same diff, as the note in
 * relations.ts says of relations.
 *
 * Whose entry it is is the SERVICE's decision (an entry is its writer's; an owner
 * or admin may change anyone's), so the route only tells it who is asking and
 * whether they may manage everyone's.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../../middleware/auth.js";
import { actorOf } from "./actor.js";
import { PM_ERRORS } from "../../services/pm/pm.service.js";
import * as time from "../../services/pm/pm-time.service.js";
import {
  PM_TIME_PARAM_ERRORS,
  WORKLOG_MAX_MINUTES,
  WORKLOG_MIN_MINUTES,
} from "../../services/pm/pm-time.js";
import { timeReportCsvLines } from "../../services/pm/pm-time-csv.js";

const WRITE = ["owner", "admin", "family"] as const;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ID = z.string().min(1).max(64);
/** `z.enum` here is a ROUTE validator, not a tool schema — nothing in this file
 *  is serialized into `tools[]` (see the same note in relations.ts). */
const GROUP_BY = z.enum(["user", "item", "day"]);

const MINUTES = z.number().int().min(WORKLOG_MIN_MINUTES).max(WORKLOG_MAX_MINUTES);
/** Offsets allowed (`+02:00`), as well as `Z`: an API client in another zone
 *  should not have to convert before it can log an hour. */
const INSTANT = z.string().datetime({ offset: true });
const NOTE = z.string().max(2000);

const worklogCreateSchema = z.object({
  minutes: MINUTES,
  started_at: INSTANT.optional(),
  note: NOTE.optional(),
  // Owner or admin only; the service refuses anyone else.
  user_id: ID.optional(),
});

const worklogPatchSchema = z
  .object({
    minutes: MINUTES.optional(),
    started_at: INSTANT.optional(),
    // `null` and "" both clear it.
    note: NOTE.nullable().optional(),
  })
  .refine((v) => v.minutes !== undefined || v.started_at !== undefined || v.note !== undefined, {
    message: "empty_patch",
  });

const timerStartSchema = z.object({ work_item_id: ID });

const timesheetQuerySchema = z.object({
  userId: ID.optional(),
  weekStart: z.string().regex(YMD).optional(),
  tz: z.string().min(1).max(64).optional(),
});

const reportQuerySchema = z.object({
  projectId: ID.optional(),
  from: z.string().regex(YMD),
  to: z.string().regex(YMD),
  groupBy: GROUP_BY.optional(),
  tz: z.string().min(1).max(64).optional(),
  format: z.enum(["json", "csv"]).optional(),
});

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

/**
 * Service code -> HTTP. Returns true if handled.
 *
 *   * 404 — the row is not there (item, project, entry, timer, person).
 *   * 403 — it is there and the caller can see it, but it is somebody else's.
 *   * 409 — the request is fine; the CURRENT state refuses it (archived work), or
 *     a double submit raced itself (nothing was applied; try again).
 *   * 422 — well-formed, but the choice is not processable (a start time in the
 *     future), the same class as `invalid_state` in native.ts.
 *   * 400 — a parameter the schema could not judge: a zone the runtime does not
 *     know, a date that is not on the calendar, a window that runs backwards.
 */
function mapTimeError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case PM_ERRORS.WORK_ITEM_NOT_FOUND:
    case PM_ERRORS.PROJECT_NOT_FOUND:
    case time.PM_TIME_ERRORS.WORKLOG_NOT_FOUND:
    case time.PM_TIME_ERRORS.TIMER_NOT_FOUND:
    case time.PM_TIME_ERRORS.USER_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case time.PM_TIME_ERRORS.WORKLOG_FORBIDDEN:
      res.status(403).json({ error: msg });
      return true;
    case time.PM_TIME_ERRORS.WORK_ITEM_ARCHIVED:
      res.status(409).json({ error: msg });
      return true;
    case PM_ERRORS.CONCURRENT_MUTATION:
      res.status(409).json({
        error: msg,
        code: "CONCURRENT_MUTATION",
        message: "Another request changed your timer at the same time. Nothing was applied — try again.",
      });
      return true;
    case time.PM_TIME_ERRORS.STARTED_AT_IN_FUTURE:
      res.status(422).json({ error: msg });
      return true;
    case time.PM_TIME_ERRORS.INVALID_MINUTES:
    case PM_TIME_PARAM_ERRORS.INVALID_TIMEZONE:
    case PM_TIME_PARAM_ERRORS.INVALID_WEEK_START:
    case PM_TIME_PARAM_ERRORS.INVALID_RANGE:
      res.status(400).json({ error: msg });
      return true;
    default:
      return false;
  }
}

/** The caller as the service sees them. Only reached behind `requireRole(...WRITE)`,
 *  so a person is present; the guard is for the type, not for a case that exists. */
function timeActor(req: Request): time.TimeActor {
  const role = req.user?.role;
  return { id: req.user?.id ?? "", canManageAll: role === "owner" || role === "admin" };
}

/** Roughly how much CSV is buffered before a write; keeps memory flat on a long report. */
const CSV_CHUNK_CHARS = 16 * 1024;

/**
 * Resolves when the response can take more bytes (`drain`) or can take none at
 * all (`close`, `error`). Every listener it adds it removes, whichever event
 * wins — `Promise.race` over `events.once` would leave the losers attached, one
 * set per chunk, for the life of a long export.
 */
function waitForDrain(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

/**
 * Write `lines` to the response as they are produced, honouring backpressure: a
 * slow client pauses the loop on `drain` instead of the process buffering the
 * whole export. Stops quietly if the client goes away.
 */
async function writeLines(res: Response, lines: Iterable<string>): Promise<void> {
  let buffer = "";
  const flush = async (): Promise<boolean> => {
    if (buffer === "") return true;
    const chunk = buffer;
    buffer = "";
    if (!res.write(chunk)) await waitForDrain(res);
    return !res.destroyed;
  };
  for (const line of lines) {
    buffer += line;
    if (buffer.length >= CSV_CHUNK_CHARS && !(await flush())) return;
  }
  await flush();
}

export function createPmTimeRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── Worklogs ──

  router.get("/pm/work-items/:id/worklogs", async (req, res, next) => {
    try {
      const list = await time.listWorklogs(prisma, req.params.id);
      res.json({
        worklogs: list.worklogs,
        total_minutes: list.totalMinutes,
        total_entries: list.totalEntries,
      });
    } catch (err) {
      if (mapTimeError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/work-items/:id/worklogs", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = worklogCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const d = parsed.data;
      const worklog = await time.createWorklog(prisma, timeActor(req), req.params.id, {
        minutes: d.minutes,
        startedAt: d.started_at === undefined ? undefined : new Date(d.started_at),
        note: d.note,
        userId: d.user_id,
      });
      res.status(201).json({ worklog });
    } catch (err) {
      if (mapTimeError(err, res)) return;
      next(err);
    }
  });

  router.patch("/pm/worklogs/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = worklogPatchSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const d = parsed.data;
      const worklog = await time.updateWorklog(prisma, timeActor(req), req.params.id, {
        minutes: d.minutes,
        startedAt: d.started_at === undefined ? undefined : new Date(d.started_at),
        // `null` clears, like "" — a note is never NULL in the table.
        note: d.note === null ? "" : d.note,
      });
      res.json({ worklog });
    } catch (err) {
      if (mapTimeError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/worklogs/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await time.deleteWorklog(prisma, timeActor(req), req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapTimeError(err, res)) return;
      next(err);
    }
  });

  // ── Timer ──
  // The caller's OWN clock. `actorOf` is null for the MCP principal, so there is
  // no timer to read for it — a 400, never somebody else's.

  router.get("/pm/timer", async (req, res, next) => {
    try {
      const userId = actorOf(req);
      if (!userId) return void res.status(400).json({ error: "user_required" });
      res.json({ timer: await time.getTimer(prisma, userId) });
    } catch (err) {
      if (mapTimeError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/timer/start", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = timerStartSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const result = await time.startTimer(prisma, timeActor(req).id, parsed.data.work_item_id);
      res.json(result);
    } catch (err) {
      if (mapTimeError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/timer/stop", requireRole(...WRITE), async (req, res, next) => {
    try {
      res.json(await time.stopTimer(prisma, timeActor(req).id));
    } catch (err) {
      if (mapTimeError(err, res)) return;
      next(err);
    }
  });

  // ── Timesheet ──

  router.get("/pm/timesheet", async (req, res, next) => {
    try {
      const parsed = timesheetQuerySchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed);
      const userId = parsed.data.userId ?? actorOf(req);
      if (!userId) return void res.status(400).json({ error: "user_required" });
      const timesheet = await time.getTimesheet(prisma, {
        userId,
        weekStart: parsed.data.weekStart,
        tz: parsed.data.tz,
      });
      res.json({ timesheet });
    } catch (err) {
      if (mapTimeError(err, res)) return;
      next(err);
    }
  });

  // ── Report ──

  router.get("/pm/time/report", async (req, res, next) => {
    try {
      const parsed = reportQuerySchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed);
      const q = parsed.data;
      const report = await time.getTimeReport(prisma, {
        projectId: q.projectId,
        from: q.from,
        to: q.to,
        groupBy: q.groupBy,
        tz: q.tz,
      });
      if (q.format !== "csv") {
        res.json({ report });
        return;
      }
      // Everything that can fail has already happened, so a CSV never starts
      // and then turns into an error: the headers go out only now. `from` and
      // `to` matched YYYY-MM-DD above, so the filename carries no quote or CR/LF.
      res.status(200);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="droplet-time-${report.groupBy}-${report.from}-to-${report.to}.csv"`,
      );
      res.setHeader("Cache-Control", "no-store");
      await writeLines(res, timeReportCsvLines(report.groupBy, report.rows));
      res.end();
    } catch (err) {
      if (res.headersSent) {
        // A write failed part-way: the bytes already sent cannot be taken back.
        res.destroy();
        return;
      }
      if (mapTimeError(err, res)) return;
      next(err);
    }
  });

  return router;
}
