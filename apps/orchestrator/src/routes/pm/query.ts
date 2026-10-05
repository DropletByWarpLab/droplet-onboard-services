/**
 * WARP-3522 (ADR-069 §8) — `POST /api/pm/work-items/query` and
 * `GET /api/pm/work-items/by-key/:key`.
 *
 * The query endpoint is how the board, the list and a saved view's chip counts
 * ask "which work items?": a filter in the shared DSL, a sort, an optional
 * group-by, a cursor. The old `GET /api/pm/projects/:id/work-items` and its
 * ad-hoc `?state=&assignee=&…` stay exactly as they are for the callers that
 * use them (the mobile clients and `business_find`); this is the additive
 * second door, not a replacement.
 *
 * Its own router rather than more lines in routes/pm/native.ts — the paths are
 * disjoint, the error vocabulary is its own (`filter/errors.ts`), and several
 * slices are editing native.ts. Mounted on `/api` in app.ts BEFORE the native
 * router: `/pm/work-items/query` is a literal under a prefix native.ts reserves
 * for `/:id`, and specific paths go first (droplet-pr-review-patterns P16).
 *
 * Auth: mounted AFTER authMiddleware, behind the `projects` module gate by its
 * `/api/pm` prefix. A read, so any role the gate admits may call it — and the
 * gate admits an external guest only for the six requests in
 * `modules/guest-shares.ts`, none of which is either of these. Both routes are
 * on the list `__tests__/guest-company-data.test.ts` probes, so a guest is
 * proven refused through the real mount, not asserted here.
 *
 * `me` in a filter is the caller. The assistant's service principal has no
 * `userId` (`actorOf` is null for it), so a filter that says `me` is a 422 for
 * it rather than a silent "no one".
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { PmFilterSchema, PmGroupBySchema, PmSortSchema } from "@droplet/shared-types";
import { actorOf } from "./actor.js";
import { PM_ERRORS } from "../../services/pm/pm.service.js";
import { PM_QUERY_ERRORS } from "../../services/pm/filter/errors.js";
import {
  QUERY_MAX_COUNTS,
  QUERY_MAX_LIMIT,
  findWorkItemByKey,
  queryWorkItems,
} from "../../services/pm/filter/query.js";

const countsSchema = z
  .record(z.string().min(1).max(40), PmFilterSchema)
  .refine((r) => Object.keys(r).length <= QUERY_MAX_COUNTS, { message: "too_many_counts" });

/**
 * Strict: an unknown key is a 400, not a silently ignored typo — `groupby` that
 * quietly does nothing is the kind of bug a caller finds a month later.
 */
const queryBodySchema = z
  .object({
    projectId: z.string().min(1).max(64).nullable().optional(),
    workspace: z.string().min(1).max(100).optional(),
    filter: PmFilterSchema.optional(),
    sort: PmSortSchema.optional(),
    groupBy: PmGroupBySchema.optional(),
    cursor: z.string().min(1).max(512).nullable().optional(),
    limit: z.number().int().min(0).max(QUERY_MAX_LIMIT).optional(),
    tz: z.string().min(1).max(64).optional(),
    counts: countsSchema.optional(),
  })
  .strict();

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

/** Service code → HTTP. Returns true if handled. */
function mapQueryError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case PM_ERRORS.PROJECT_NOT_FOUND:
    case PM_ERRORS.WORK_ITEM_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case PM_QUERY_ERRORS.INVALID_FILTER:
    case PM_QUERY_ERRORS.INVALID_CURSOR:
    case PM_QUERY_ERRORS.INVALID_TIMEZONE:
      res.status(400).json({ error: msg });
      return true;
    case PM_QUERY_ERRORS.ME_UNAVAILABLE:
      res.status(422).json({ error: msg });
      return true;
    default:
      return false;
  }
}

export function createPmQueryRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post("/pm/work-items/query", async (req: Request, res, next) => {
    try {
      const parsed = queryBodySchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      res.json(await queryWorkItems(prisma, { userId: actorOf(req) }, parsed.data));
    } catch (err) {
      if (mapQueryError(err, res)) return;
      next(err);
    }
  });

  // What a deep link (`?p=INBOX&item=INBOX-42`) and a notification carry is the
  // key, not an id. Same shape as `GET /pm/work-items/:id`'s `work_item`.
  router.get("/pm/work-items/by-key/:key", async (req, res, next) => {
    try {
      const workspace = typeof req.query.workspace === "string" ? req.query.workspace : undefined;
      res.json({ work_item: await findWorkItemByKey(prisma, req.params.key, workspace) });
    } catch (err) {
      if (mapQueryError(err, res)) return;
      next(err);
    }
  });

  return router;
}
