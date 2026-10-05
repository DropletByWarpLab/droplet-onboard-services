/**
 * WARP-3524 (WS-8) — GET /api/pm/insights: throughput, created vs finished,
 * cycle and lead time, cumulative flow, workload and aging work in progress for
 * one project (`projectId`) or the whole workspace.
 *
 * Its own router, not more lines in routes/pm/native.ts, for the reason
 * routes/pm/relations.ts gives: several slices edit native.ts at once, and this
 * path (`/pm/insights`) is disjoint from everything there. Mounted on the same
 * `/api` prefix in app.ts next to it.
 *
 * Auth: mounted AFTER authMiddleware, behind the `projects` module gate that
 * `mountModuleGates` puts on the `/api/pm` prefix. Reads in PM are open to any
 * authenticated role the gate admits, and so is this: insights say nothing the
 * board does not already show, only counted. An external guest never gets here —
 * `modules/guest-shares.ts` names the five requests a guest may make inside
 * Projects, and this is not one of them (pinned in insights.test.ts).
 *
 * The numbers' definitions, and what history can and cannot be rebuilt, are in
 * services/pm/pm-insights.service.ts. The response is cached there for five
 * minutes; `meta.generatedAt` says how fresh it is.
 */

import { Router, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { PM_ERRORS } from "../../services/pm/pm.service.js";
import {
  getInsights,
  isInsightsDate,
  INSIGHTS_ERRORS,
  INSIGHTS_GROUP_BY,
} from "../../services/pm/pm-insights.service.js";

/** `YYYY-MM-DD` and a real calendar day: `2026-02-30` is a 400, not a Postgres error. */
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isInsightsDate, "date is outside the supported range");

// Every field is a bare string. Express hands `?from=a&from=b` over as an
// array, which fails `z.string()` and so is a 400 rather than a coerced guess.
const insightsQuerySchema = z.object({
  projectId: z.string().min(1).max(64).optional(),
  // Which workspace when no project is named. The same `?workspace=` the
  // summary takes; defaults to the home workspace.
  workspace: z.string().min(1).max(100).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  // The size of the buckets the two time series are counted in.
  groupBy: z.enum(INSIGHTS_GROUP_BY).optional(),
});

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: "invalid_request", details: error.flatten() });
}

export function createPmInsightsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/pm/insights", async (req, res, next) => {
    try {
      const parsed = insightsQuerySchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed.error);
      const q = parsed.data;
      const insights = await getInsights(prisma, {
        projectId: q.projectId,
        workspaceSlug: q.workspace,
        from: q.from,
        to: q.to,
        groupBy: q.groupBy,
      });
      res.json({ insights });
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      if (code === PM_ERRORS.PROJECT_NOT_FOUND) {
        res.status(404).json({ error: code });
        return;
      }
      if (code === INSIGHTS_ERRORS.INVALID_RANGE) {
        res.status(400).json({ error: code });
        return;
      }
      next(err);
    }
  });

  return router;
}
