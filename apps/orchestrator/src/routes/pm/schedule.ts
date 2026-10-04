/**
 * WARP-3523 (ADR-069 WS-7) — the two reads behind the Timeline and My Work views
 * of /projects:
 *
 *   GET /api/pm/projects/:id/timeline?from&to   one project, one date window
 *   GET /api/pm/my-work?section&today&limit&offset   the caller's cross-project lists
 *
 * Its own router rather than more lines in routes/pm/native.ts, for the reason
 * routes/pm/relations.ts gives: the paths are disjoint and several slices edit
 * native.ts concurrently. Mounted on the same `/api` prefix right after the
 * relations router. Neither path collides with a `:param` route there
 * (`/pm/projects/:id` has no sub-path `timeline`; `/pm/my-work` is a literal).
 *
 * Auth: mounted AFTER authMiddleware, and covered by the `projects` module gate
 * (`/api/pm` prefix) like every PM route. Both are reads, open to any role that
 * passes the gate. They are deliberately NOT in modules/guest-shares.ts: an
 * external guest sees exactly the one work item shared with them, and a window
 * of a project's schedule or a cross-project list is not that.
 *
 * `my-work` takes its subject from the session and from nothing else — no query
 * parameter can name another user. The caller's own "today" arrives as `today`
 * because the VIEWER's calendar day, not the server's, decides what is overdue.
 */

import { Router, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { PM_ERRORS } from "../../services/pm/pm.service.js";
import {
  MY_WORK_MAX_LIMIT,
  MY_WORK_MAX_OFFSET,
  MY_WORK_SECTIONS,
  TIMELINE_MAX_RANGE_DAYS,
  diffDaysUtc,
  getMyWork,
  getProjectTimeline,
  isRealDateOnly,
  utcToday,
} from "../../services/pm/pm-schedule.service.js";

const dateOnly = z.string().refine(isRealDateOnly, { message: "must be a calendar date, YYYY-MM-DD" });

const timelineQuerySchema = z
  .object({ from: dateOnly, to: dateOnly })
  .superRefine((v, ctx) => {
    if (v.from > v.to) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "must not be before from" });
    } else if (diffDaysUtc(v.from, v.to) + 1 > TIMELINE_MAX_RANGE_DAYS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `range must not exceed ${TIMELINE_MAX_RANGE_DAYS} days` });
    }
  });

// `z.coerce.number()` turns the query string into a number; `.int()` rejects NaN
// and floats before anything reaches Prisma's skip/take (the NaN -> 500 class
// native.ts's paginationQuerySchema documents).
const myWorkQuerySchema = z.object({
  section: z.enum(MY_WORK_SECTIONS),
  today: dateOnly.optional(),
  limit: z.coerce.number().int().positive().max(MY_WORK_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).max(MY_WORK_MAX_OFFSET).optional(),
});

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

export function createPmScheduleRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/pm/projects/:id/timeline", async (req, res, next) => {
    try {
      const parsed = timelineQuerySchema.safeParse({ from: req.query.from, to: req.query.to });
      if (!parsed.success) return badRequest(res, parsed);
      res.json(await getProjectTimeline(prisma, req.params.id, parsed.data));
    } catch (err) {
      if (err instanceof Error && err.message === PM_ERRORS.PROJECT_NOT_FOUND) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/pm/my-work", async (req, res, next) => {
    try {
      const userId = req.user?.id;
      // Same body the floor and `ownAssignments` answer for "no one to list for".
      if (!userId) {
        res.status(404).json({ error: "module_disabled", module: "projects" });
        return;
      }
      const parsed = myWorkQuerySchema.safeParse({
        section: req.query.section,
        today: req.query.today,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      if (!parsed.success) return badRequest(res, parsed);
      const { section, today, limit, offset } = parsed.data;
      res.json(await getMyWork(prisma, userId, { section, today: today ?? utcToday(), limit, offset }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
