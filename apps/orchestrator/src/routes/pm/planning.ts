/**
 * WARP-3521 (ADR-069 slice WS-5) — /api/pm cycles (sprints) and modules
 * (milestones), the planning half of Projects.
 *
 * Its own router rather than more lines in routes/pm/native.ts, for the reason
 * routes/pm/relations.ts gives: the paths are disjoint, the error vocabulary is
 * its own, and several concurrent changes edit native.ts. Mounted on the same
 * `/api` prefix in app.ts, immediately after the relations router. Because every
 * path starts `/pm/`, the `projects` module gate and the external-guest tier
 * floor (`mountModuleGates`, off the `/api/pm` prefix) cover it with no registry
 * edit: a guest is answered 404 `module_disabled` before anything here runs, and
 * the guest-share allow-list names none of these paths.
 *
 * Auth: mounted AFTER authMiddleware. PM is household-shared, so reads are open
 * to any authenticated role that gets past the module gate and writes take
 * `requireRole(owner | admin | family)` — the split native.ts uses for states
 * and labels, the comparable project-level configuration. These writes do NOT
 * admit the MCP service principal: no registered tool plans cycles or modules,
 * and widening the surface for a caller that does not exist is how an
 * unconfirmed write path appears. (Putting a work item INTO a cycle goes
 * through `PATCH /pm/work-items/:id { cycle_id }`, which already admits it.)
 *
 * Wire conventions follow the rest of /api/pm: snake_case request bodies,
 * camelCase responses, dates as `YYYY-MM-DD`. The one exception is
 * `moveIncompleteTo` on cycle completion, spelled the way the slice spec
 * writes it.
 */

import { Router, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../../middleware/auth.js";
import { actorOf } from "./actor.js";
import {
  completeCycle,
  createCycle,
  deleteCycle,
  getCycle,
  getCycleBurndown,
  listBacklog,
  listCycleWorkItems,
  listCycles,
  startCycle,
  updateCycle,
} from "../../services/pm/pm-cycles.service.js";
import {
  addModuleWorkItems,
  createModule,
  deleteModule,
  getModule,
  listModuleWorkItems,
  listModules,
  listModulesForWorkItem,
  removeModuleWorkItems,
  updateModule,
} from "../../services/pm/pm-modules.service.js";
import { PmPlanningError, parseDateOnly } from "../../services/pm/pm-planning.js";

const WRITE = ["owner", "admin", "family"] as const;

/**
 * `z.enum` is a ROUTE validator here, not a tool schema (WARP-1839's ban is on
 * the JSON Schema an LLM tool advertises; nothing in this file is serialized
 * into `tools[]`) — the same note routes/pm/relations.ts carries.
 */
const MODULE_STATUS = z.enum(["backlog", "planned", "in_progress", "paused", "completed", "cancelled"]);

/** A calendar date. `2026-02-30` and `2026-10-5` are refused, not rolled over. */
const DATE_ONLY = z
  .string()
  .refine((v) => parseDateOnly(v) !== null, { message: "must be a calendar date, YYYY-MM-DD" });

/** `YYYY-MM-DD` → midnight UTC; `null` stays `null`, absent stays `undefined`. */
function toDate(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  return v === null ? null : (parseDateOnly(v) as Date);
}

const cycleCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  start_date: DATE_ONLY.nullable().optional(),
  end_date: DATE_ONLY.nullable().optional(),
});

const cyclePatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  start_date: DATE_ONLY.nullable().optional(),
  end_date: DATE_ONLY.nullable().optional(),
});

/** A cycle id, or the word `backlog`. A cycle id is a uuid, so the word cannot
 *  collide with one. Required: completing a cycle must say where the unfinished
 *  work goes, never default it. */
const cycleCompleteSchema = z.object({
  moveIncompleteTo: z.string().min(1).max(64),
});

const moduleCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  lead_id: z.string().min(1).max(64).nullable().optional(),
  status: MODULE_STATUS.optional(),
  start_date: DATE_ONLY.nullable().optional(),
  target_date: DATE_ONLY.nullable().optional(),
});

const modulePatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  lead_id: z.string().min(1).max(64).nullable().optional(),
  status: MODULE_STATUS.optional(),
  start_date: DATE_ONLY.nullable().optional(),
  target_date: DATE_ONLY.nullable().optional(),
});

const moduleItemsSchema = z.object({
  work_item_ids: z.array(z.string().min(1).max(64)).min(1).max(200),
});

// Same guard the native router has on its list: a non-numeric `per_page` would
// coerce to NaN and reach Prisma's skip/take.
const paginationQuerySchema = z.object({
  per_page: z.coerce.number().int().positive().max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
});

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

/**
 * Service code → HTTP. Returns true if handled.
 *
 * The decisions worth stating:
 *   * 404 — the row referenced is not there.
 *   * 422 — the request is well-formed and the row exists, but the CHOICE is not
 *     processable: a cycle in another project, an end before its start.
 *   * 409 — the request is fine and the resource's CURRENT state refuses it: a
 *     second active cycle, completing a draft, planning into a finished cycle.
 *   * `concurrent_mutation` — a SERIALIZABLE loser. Nothing was applied; retry.
 * `PmPlanningError.details` rides along, so "which cycle is in the way" and
 * "which ids were missing" reach the client instead of staying in a log.
 */
function mapPlanningError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const details = err instanceof PmPlanningError ? err.details : undefined;
  const body = (extra: Record<string, unknown> = {}) => ({
    error: msg,
    ...(details ? { details } : {}),
    ...extra,
  });
  switch (msg) {
    case "project_not_found":
    case "cycle_not_found":
    case "module_not_found":
    case "work_item_not_found":
      res.status(404).json(body());
      return true;
    case "invalid_cycle":
    case "invalid_work_item":
    case "invalid_dates":
    case "cycle_dates_required":
    case "lead_is_guest":
      res.status(422).json(body());
      return true;
    case "cycle_already_active": {
      const name = typeof details?.activeCycleName === "string" ? details.activeCycleName : "Another cycle";
      res.status(409).json(body({ message: `${name} is already active. Complete it before starting another.` }));
      return true;
    }
    case "cycle_not_draft":
    case "cycle_not_active":
    case "cycle_completed":
      res.status(409).json(body());
      return true;
    case "concurrent_mutation":
      res.status(409).json({
        error: msg,
        code: "CONCURRENT_MUTATION",
        message:
          "Another request changed this at the same time. Nothing was applied — try again.",
      });
      return true;
    default:
      return false;
  }
}

export function createPmPlanningRouter(prisma: PrismaClient): Router {
  const router = Router();

  /** Pagination query → service options, or a 400 already sent. */
  function pageOf(req: { query: Record<string, unknown> }, res: Response) {
    const parsed = paginationQuerySchema.safeParse({ per_page: req.query.per_page, page: req.query.page });
    if (!parsed.success) {
      badRequest(res, parsed);
      return null;
    }
    return { perPage: parsed.data.per_page, page: parsed.data.page };
  }

  // ══ Cycles ═════════════════════════════════════════════════════════════════

  router.get("/pm/projects/:id/cycles", async (req, res, next) => {
    try {
      res.json({ cycles: await listCycles(prisma, req.params.id) });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/projects/:id/cycles", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = cycleCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const d = parsed.data;
      const cycle = await createCycle(prisma, req.params.id, {
        name: d.name,
        description: d.description,
        startDate: toDate(d.start_date),
        endDate: toDate(d.end_date),
      });
      res.status(201).json({ cycle });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  // The planning backlog: unfinished work in no cycle. A sibling of /cycles, on
  // the project, so it cannot shadow or be shadowed by `/pm/projects/:id`.
  router.get("/pm/projects/:id/backlog", async (req, res, next) => {
    try {
      const page = pageOf(req, res);
      if (!page) return;
      res.json(await listBacklog(prisma, req.params.id, page));
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.get("/pm/cycles/:id", async (req, res, next) => {
    try {
      res.json({ cycle: await getCycle(prisma, req.params.id) });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.patch("/pm/cycles/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = cyclePatchSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const d = parsed.data;
      res.json({
        cycle: await updateCycle(prisma, req.params.id, {
          name: d.name,
          description: d.description,
          startDate: toDate(d.start_date),
          endDate: toDate(d.end_date),
        }),
      });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/cycles/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await deleteCycle(prisma, actorOf(req), req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/cycles/:id/start", requireRole(...WRITE), async (req, res, next) => {
    try {
      res.json({ cycle: await startCycle(prisma, req.params.id) });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/cycles/:id/complete", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = cycleCompleteSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const to = parsed.data.moveIncompleteTo;
      res.json(
        await completeCycle(prisma, actorOf(req), req.params.id, {
          moveIncompleteTo: to === "backlog" ? null : to,
        }),
      );
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.get("/pm/cycles/:id/burndown", async (req, res, next) => {
    try {
      res.json({ burndown: await getCycleBurndown(prisma, req.params.id) });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.get("/pm/cycles/:id/work-items", async (req, res, next) => {
    try {
      const page = pageOf(req, res);
      if (!page) return;
      res.json(await listCycleWorkItems(prisma, req.params.id, page));
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  // ══ Modules ════════════════════════════════════════════════════════════════

  router.get("/pm/projects/:id/modules", async (req, res, next) => {
    try {
      res.json({ modules: await listModules(prisma, req.params.id) });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/projects/:id/modules", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = moduleCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const d = parsed.data;
      const created = await createModule(prisma, req.params.id, {
        name: d.name,
        description: d.description,
        leadId: d.lead_id,
        status: d.status,
        startDate: toDate(d.start_date),
        targetDate: toDate(d.target_date),
      });
      res.status(201).json({ module: created });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.get("/pm/modules/:id", async (req, res, next) => {
    try {
      res.json({ module: await getModule(prisma, req.params.id) });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.patch("/pm/modules/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = modulePatchSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const d = parsed.data;
      res.json({
        module: await updateModule(prisma, req.params.id, {
          name: d.name,
          description: d.description,
          leadId: d.lead_id,
          status: d.status,
          startDate: toDate(d.start_date),
          targetDate: toDate(d.target_date),
        }),
      });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/modules/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await deleteModule(prisma, actorOf(req), req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.get("/pm/modules/:id/work-items", async (req, res, next) => {
    try {
      const page = pageOf(req, res);
      if (!page) return;
      res.json(await listModuleWorkItems(prisma, req.params.id, page));
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/modules/:id/work-items", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = moduleItemsSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      res.json(await addModuleWorkItems(prisma, actorOf(req), req.params.id, parsed.data.work_item_ids));
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  // The spec's `DELETE /modules/:id/work-items` takes its ids in the body; a
  // DELETE body is legal but some intermediaries drop it, so the single-item
  // form below carries the id in the path for the dashboard to use.
  router.delete("/pm/modules/:id/work-items", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = moduleItemsSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      res.json(await removeModuleWorkItems(prisma, actorOf(req), req.params.id, parsed.data.work_item_ids));
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  router.delete(
    "/pm/modules/:id/work-items/:workItemId",
    requireRole(...WRITE),
    async (req, res, next) => {
      try {
        res.json(await removeModuleWorkItems(prisma, actorOf(req), req.params.id, [req.params.workItemId]));
      } catch (err) {
        if (mapPlanningError(err, res)) return;
        next(err);
      }
    },
  );

  // The item side of the same relation: which modules is THIS item in. The
  // drawer's picker reads it. A sibling path of the native `/pm/work-items/:id`,
  // so neither shadows the other.
  router.get("/pm/work-items/:id/modules", async (req, res, next) => {
    try {
      res.json({ modules: await listModulesForWorkItem(prisma, req.params.id) });
    } catch (err) {
      if (mapPlanningError(err, res)) return;
      next(err);
    }
  });

  return router;
}
