/**
 * WARP-3522 (ADR-069 §8) — `/api/pm/views`: saved views.
 *
 *   GET    /pm/views?project=<id|none>   the built-ins + every view the caller may see
 *   POST   /pm/views                     create (personal, or shared by an editor)
 *   PATCH  /pm/views/:id                 rename / re-filter / re-layout
 *   DELETE /pm/views/:id
 *
 * Who may do what is `services/pm/pm-views.service.ts`'s header; this file is
 * the HTTP face: validation, the human-role gate, status codes.
 *
 * A `scope` is chosen at creation and never changes: moving a view between
 * personal and shared would hand one person's private filter to the team, or
 * quietly take a team's away, as a side effect of an edit. "Save as shared" is a
 * second view. (`.strict()` makes sending `scope` to PATCH a 400, not a no-op.)
 *
 * Reads are open to every role the `projects` module gate admits; writes need a
 * human role (`owner | admin | family`) because a view needs an OWNER and the
 * assistant's service principal has no `userId`. An external guest reaches
 * nothing here — see query.ts for how that is proven.
 *
 * Mounted on `/api` in app.ts next to the other PM routers.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import {
  PM_VIEW_LAYOUTS,
  PM_VIEW_NAME_MAX,
  PM_VIEW_SCOPES,
  PmColumnsSchema,
  PmFilterSchema,
  PmGroupBySchema,
  PmSortSchema,
} from "@droplet/shared-types";
import { requireRole } from "../../middleware/auth.js";
import { isConcurrencyConflict } from "../../services/role-mutation-guard.service.js";
import { PM_ERRORS } from "../../services/pm/pm.service.js";
import {
  PM_VIEW_ERRORS,
  createView,
  deleteView,
  listViews,
  updateView,
  type ViewActor,
} from "../../services/pm/pm-views.service.js";

const WRITE = ["owner", "admin", "family"] as const;

/** Trimmed, 1..60. The database CHECK says the same; this says it in words first. */
const nameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(PM_VIEW_NAME_MAX));

const createBodySchema = z
  .object({
    projectId: z.string().min(1).max(64).nullable().optional(),
    workspace: z.string().min(1).max(100).optional(),
    scope: z.enum(PM_VIEW_SCOPES),
    name: nameSchema,
    layout: z.enum(PM_VIEW_LAYOUTS),
    filter: PmFilterSchema,
    groupBy: PmGroupBySchema.nullable().optional(),
    sortBy: PmSortSchema.nullable().optional(),
    columns: PmColumnsSchema.nullable().optional(),
  })
  .strict();

const patchBodySchema = z
  .object({
    name: nameSchema.optional(),
    layout: z.enum(PM_VIEW_LAYOUTS).optional(),
    filter: PmFilterSchema.optional(),
    groupBy: PmGroupBySchema.nullable().optional(),
    sortBy: PmSortSchema.nullable().optional(),
    columns: PmColumnsSchema.nullable().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty_patch" });

const listQuerySchema = z.object({
  project: z.string().min(1).max(64).optional(),
  workspace: z.string().min(1).max(100).optional(),
});

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

/**
 * Service code → HTTP. `view_forbidden` is 403 (you can see it, you may not
 * change it); `view_not_found` is 404 for a missing view AND for someone else's
 * personal one; the rest are conflicts with current state (409). A SERIALIZABLE
 * loser on the cap check is 409 CONCURRENT_MUTATION: nothing was applied, retry.
 */
function mapViewError(err: unknown, res: Response): boolean {
  if (isConcurrencyConflict(err)) {
    res.status(409).json({
      error: "concurrent_mutation",
      code: "CONCURRENT_MUTATION",
      message: "Another request changed these views at the same time. Nothing was applied — try again.",
    });
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case PM_VIEW_ERRORS.VIEW_NOT_FOUND:
    case PM_ERRORS.PROJECT_NOT_FOUND:
    case PM_ERRORS.WORKSPACE_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case PM_VIEW_ERRORS.VIEW_FORBIDDEN:
      res.status(403).json({ error: msg });
      return true;
    case PM_VIEW_ERRORS.VIEW_IS_BUILTIN:
    case PM_VIEW_ERRORS.VIEW_NAME_TAKEN:
    case PM_VIEW_ERRORS.VIEW_LIMIT_REACHED:
      res.status(409).json({ error: msg });
      return true;
    default:
      return false;
  }
}

/** The caller as a person. `requireRole(...WRITE)` has already refused every
 *  principal without one, so `req.user` is a real user here. */
function personOf(req: Request): ViewActor {
  return { userId: req.user!.id, role: req.user!.role };
}

export function createPmViewsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/pm/views", async (req, res, next) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed);
      // A reader with no person behind them (the assistant) sees shared views only.
      const user = req.user;
      const person: ViewActor | null =
        user && user.id !== "_service:mcp" && user.role !== "service"
          ? { userId: user.id, role: user.role }
          : null;
      res.json(await listViews(prisma, person, parsed.data));
    } catch (err) {
      if (mapViewError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/views", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      res.status(201).json({ view: await createView(prisma, personOf(req), parsed.data) });
    } catch (err) {
      if (mapViewError(err, res)) return;
      next(err);
    }
  });

  router.patch("/pm/views/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = patchBodySchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      res.json({ view: await updateView(prisma, personOf(req), req.params.id, parsed.data) });
    } catch (err) {
      if (mapViewError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/views/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await deleteView(prisma, personOf(req), req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapViewError(err, res)) return;
      next(err);
    }
  });

  return router;
}
