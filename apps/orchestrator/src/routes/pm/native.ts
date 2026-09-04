/**
 * /api/pm/* — native project-management routes (ADR-026), the Droplet-owned
 * project-management surface. Backs the dashboard Projects surface and (via the
 * orchestrator) the 9 `pm_*` MCP tools.
 *
 * Auth: mounted AFTER authMiddleware. PM is household-shared — reads are open
 * to any authenticated role; writes are gated with `requireRole`. Project,
 * work-item + comment writes additionally admit the MCP service principal
 * (`requireRoleOrMcpService`) so the LLM's confirmed write tools can dispatch
 * through here (the tool layer owns the human-facing confirmation gate).
 *
 * Errors: the service throws Error(code); we map codes → HTTP status here,
 * mirroring routes/calendar.ts.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole, requireRoleOrMcpService } from "../../middleware/auth.js";
import * as pm from "../../services/pm/pm.service.js";
import { actorOf } from "./actor.js";
import { listRelationsFor } from "../../services/pm/pm-relations.service.js";


/** Map a service error code to an HTTP response. Returns true if handled. */
function mapServiceError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case "workspace_not_found":
    case "project_not_found":
    case "state_not_found":
    case "label_not_found":
    case "work_item_not_found":
    case "comment_not_found":
      res.status(404).json({ error: msg });
      return true;
    case "invalid_parent":
    case "invalid_state":
    case "invalid_label":
      res.status(422).json({ error: msg });
      return true;
    case "identifier_taken":
    case "state_is_last":
    case "state_is_default":
      // A project must keep at least one state and its sole default landing
      // state — deleting the last/only-default one is a conflict (409), not a
      // missing resource.
      res.status(409).json({ error: msg });
      return true;
    case "concurrent_mutation":
      // SERIALIZABLE loser on deleteWorkItem's audit-then-cascade. Nothing was
      // applied; same body shape routes/pm/relations.ts uses for the same case.
      res.status(409).json({
        error: msg,
        code: "CONCURRENT_MUTATION",
        message:
          "Another request changed this work item at the same time. Nothing was applied — try again.",
      });
      return true;
    default:
      return false;
  }
}

const PRIORITY = z.enum(["urgent", "high", "medium", "low", "none"]);
const STATE_GROUP = z.enum(["backlog", "unstarted", "started", "completed", "cancelled"]);

const projectCreateSchema = z.object({
  workspace_slug: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200),
  identifier: z.string().min(1).max(10).regex(/^[A-Za-z0-9]+$/).optional(),
  description: z.string().max(10000).optional(),
  icon: z.string().max(64).optional(),
  color: z.string().max(32).optional(),
});

const projectPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(10000).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  leadId: z.string().max(64).nullable().optional(),
  archived: z.boolean().optional(),
});

const stateCreateSchema = z.object({
  name: z.string().min(1).max(100),
  group: STATE_GROUP,
  color: z.string().max(32).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const statePatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  group: STATE_GROUP.optional(),
  color: z.string().max(32).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const labelCreateSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().max(32).optional(),
});

const labelPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().max(32).nullable().optional(),
});

const workItemCreateSchema = z.object({
  name: z.string().min(1).max(500),
  description_html: z.string().max(100000).optional(),
  state_id: z.string().max(64).optional(),
  priority: PRIORITY.optional(),
  assignees: z.array(z.string().max(64)).max(50).optional(),
  label_ids: z.array(z.string().max(64)).max(50).optional(),
  parent_id: z.string().max(64).optional(),
  start_date: z.string().datetime().optional(),
  due_date: z.string().datetime().optional(),
});

const workItemPatchSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  description_html: z.string().max(100000).nullable().optional(),
  state_id: z.string().max(64).nullable().optional(),
  priority: PRIORITY.optional(),
  assignees: z.array(z.string().max(64)).max(50).optional(),
  label_ids: z.array(z.string().max(64)).max(50).optional(),
  parent_id: z.string().max(64).nullable().optional(),
  start_date: z.string().datetime().nullable().optional(),
  due_date: z.string().datetime().nullable().optional(),
  // .int() already rejects floats and (via Number.isInteger) NaN/Infinity;
  // .finite() makes the NaN/Infinity rejection explicit and self-documenting so
  // a non-finite sortOrder can never reach Prisma's Int column (review finding:
  // sortOrder admits NaN/Infinity).
  sortOrder: z.number().int().finite().optional(),
});

const transitionSchema = z.object({ state_id: z.string().min(1).max(64) });
const commentCreateSchema = z.object({ comment_html: z.string().min(1).max(100000) });

// Pagination query params: a non-numeric `per_page` / `page` (e.g. `?per_page=abc`)
// would coerce to NaN and reach Prisma's `skip`/`take` as NaN → a driver-level
// crash surfacing as 500. Reject them at the route layer → 400 (review finding:
// NaN pagination → Prisma crash). `z.coerce.number` turns the query string into
// a number; `.int().positive()` rejects NaN, floats, and non-positive values.
const paginationQuerySchema = z.object({
  per_page: z.coerce.number().int().positive().max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
});

const WRITE = ["owner", "admin", "family"] as const;

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

export function createPmNativeRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── Workspaces ──
  router.get("/pm/workspaces", async (_req, res, next) => {
    try {
      res.json({ workspaces: await pm.listWorkspaces(prisma) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/pm/workspaces/:slug", async (req, res, next) => {
    try {
      res.json({ workspace: await pm.getWorkspaceBySlug(prisma, req.params.slug) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // Index KPI strip.
  router.get("/pm/summary", async (req, res, next) => {
    try {
      const slug = req.query.workspace ? String(req.query.workspace) : undefined;
      res.json({ summary: await pm.getSummary(prisma, slug) });
    } catch (err) {
      next(err);
    }
  });

  // ── Projects ──
  router.get("/pm/projects", async (req, res, next) => {
    try {
      const perPage = req.query.per_page ? Number(req.query.per_page) : undefined;
      const projects = await pm.listProjects(prisma, {
        workspaceSlug: req.query.workspace ? String(req.query.workspace) : undefined,
        includeArchived: req.query.archived === "1" || req.query.archived === "true",
        perPage,
      });
      res.json({ projects });
    } catch (err) {
      next(err);
    }
  });

  // Admits `_service:mcp` alongside the human WRITE roles so the
  // confirmation-gated `pm_create_project` tool can dispatch here. Without
  // it the tool ships registered and dead — a plain `requireRole` 403s the
  // MCP principal, which is neither owner nor admin. The human-facing
  // confirmation gate lives in the tool layer, same split as work-items.
  router.post("/pm/projects", requireRoleOrMcpService(...WRITE), async (req, res, next) => {
    try {
      const parsed = projectCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const project = await pm.createProject(prisma, actorOf(req), {
        workspaceSlug: parsed.data.workspace_slug,
        name: parsed.data.name,
        identifier: parsed.data.identifier,
        description: parsed.data.description,
        icon: parsed.data.icon,
        color: parsed.data.color,
      });
      res.status(201).json({ project });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.get("/pm/projects/:id", async (req, res, next) => {
    try {
      res.json({ project: await pm.getProject(prisma, req.params.id) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.patch("/pm/projects/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = projectPatchSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      res.json({ project: await pm.updateProject(prisma, req.params.id, parsed.data) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/projects/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await pm.deleteProject(prisma, req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // ── States ──
  router.get("/pm/projects/:id/states", async (req, res, next) => {
    try {
      res.json({ states: await pm.listStates(prisma, req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/pm/projects/:id/states", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = stateCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const state = await pm.createState(prisma, req.params.id, parsed.data);
      res.status(201).json({ state });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.patch("/pm/states/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = statePatchSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      res.json({ state: await pm.updateState(prisma, req.params.id, parsed.data) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/states/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await pm.deleteState(prisma, req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // ── Labels ──
  router.get("/pm/projects/:id/labels", async (req, res, next) => {
    try {
      res.json({ labels: await pm.listLabels(prisma, req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/pm/projects/:id/labels", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = labelCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const label = await pm.createLabel(prisma, req.params.id, parsed.data);
      res.status(201).json({ label });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.patch("/pm/labels/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = labelPatchSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      res.json({ label: await pm.updateLabel(prisma, req.params.id, parsed.data) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/labels/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await pm.deleteLabel(prisma, req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // ── Work items ──
  router.get("/pm/projects/:id/work-items", async (req, res, next) => {
    try {
      const q = req.query;
      // Validate pagination before anything reaches the service/Prisma so a
      // non-numeric per_page/page returns a clean 400 instead of NaN → 500.
      const pageParsed = paginationQuerySchema.safeParse({
        per_page: q.per_page,
        page: q.page,
      });
      if (!pageParsed.success) return badRequest(res, pageParsed);
      const parentRaw = q.parent;
      const work_items = await pm.listWorkItems(prisma, req.params.id, {
        stateId: q.state ? String(q.state) : undefined,
        assignee: q.assignee ? String(q.assignee) : undefined,
        labelId: q.label ? String(q.label) : undefined,
        priority: q.priority
          ? (PRIORITY.safeParse(String(q.priority)).success
              ? (String(q.priority) as pm.ApiWorkItem["priority"])
              : undefined)
          : undefined,
        parentId: parentRaw === undefined ? undefined : parentRaw === "none" ? null : String(parentRaw),
        q: q.q ? String(q.q) : undefined,
        perPage: pageParsed.data.per_page,
        page: pageParsed.data.page,
      });
      res.json({ work_items });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post(
    "/pm/projects/:id/work-items",
    requireRoleOrMcpService(...WRITE),
    async (req, res, next) => {
      try {
        const parsed = workItemCreateSchema.safeParse(req.body);
        if (!parsed.success) return badRequest(res, parsed);
        const d = parsed.data;
        const work_item = await pm.createWorkItem(prisma, actorOf(req), req.params.id, {
          name: d.name,
          descriptionHtml: d.description_html,
          stateId: d.state_id,
          priority: d.priority,
          assignees: d.assignees,
          labelIds: d.label_ids,
          parentId: d.parent_id,
          startDate: d.start_date ? new Date(d.start_date) : undefined,
          dueDate: d.due_date ? new Date(d.due_date) : undefined,
        });
        res.status(201).json({ work_item });
      } catch (err) {
        if (mapServiceError(err, res)) return;
        next(err);
      }
    },
  );

  // Workspace-wide search (backs pm_search_work_items). Registered before the
  // /:id route — distinct path, no conflict.
  router.get("/pm/work-items", async (req, res, next) => {
    try {
      const work_items = await pm.searchWorkItems(prisma, {
        workspaceSlug: req.query.workspace ? String(req.query.workspace) : undefined,
        q: req.query.q ? String(req.query.q) : "",
        perPage: req.query.per_page ? Number(req.query.per_page) : undefined,
      });
      res.json({ work_items });
    } catch (err) {
      next(err);
    }
  });

  // WARP-2586 — the detail read carries the item's relations alongside it, as
  // a SIBLING key. Deliberately not a field inside `work_item`: that shape is
  // consumed by routes/mobile/pm.ts and, through toPlaneWorkItem, by the
  // `pm_get_work_item` MCP contract, which pm-orch.ts documents as byte-stable.
  // An additive sibling key costs those consumers nothing.
  //
  // Only the DETAIL read. `listWorkItems` stays relation-free on purpose — a
  // 200-card board must not become 200 relation queries, and the board does not
  // render edges.
  router.get("/pm/work-items/:id", async (req, res, next) => {
    try {
      // Independent reads, and getWorkItem already 404s a missing item, so the
      // relations read skips its own existence check rather than asking twice.
      const [work_item, relations] = await Promise.all([
        pm.getWorkItem(prisma, req.params.id),
        listRelationsFor(prisma, req.params.id, { itemChecked: true }),
      ]);
      res.json({ work_item, relations });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.patch(
    "/pm/work-items/:id",
    requireRoleOrMcpService(...WRITE),
    async (req, res, next) => {
      try {
        const parsed = workItemPatchSchema.safeParse(req.body);
        if (!parsed.success) return badRequest(res, parsed);
        const d = parsed.data;
        const work_item = await pm.updateWorkItem(prisma, actorOf(req), req.params.id, {
          name: d.name,
          descriptionHtml: d.description_html,
          stateId: d.state_id,
          priority: d.priority,
          assignees: d.assignees,
          labelIds: d.label_ids,
          parentId: d.parent_id,
          startDate: d.start_date === undefined ? undefined : d.start_date === null ? null : new Date(d.start_date),
          dueDate: d.due_date === undefined ? undefined : d.due_date === null ? null : new Date(d.due_date),
          sortOrder: d.sortOrder,
        });
        res.json({ work_item });
      } catch (err) {
        if (mapServiceError(err, res)) return;
        next(err);
      }
    },
  );

  router.post(
    "/pm/work-items/:id/transition",
    requireRoleOrMcpService(...WRITE),
    async (req, res, next) => {
      try {
        const parsed = transitionSchema.safeParse(req.body);
        if (!parsed.success) return badRequest(res, parsed);
        const work_item = await pm.transitionWorkItem(
          prisma,
          actorOf(req),
          req.params.id,
          parsed.data.state_id,
        );
        res.json({ work_item });
      } catch (err) {
        if (mapServiceError(err, res)) return;
        next(err);
      }
    },
  );

  router.delete("/pm/work-items/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await pm.deleteWorkItem(prisma, actorOf(req), req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // ── Comments ──
  router.get("/pm/work-items/:id/comments", async (req, res, next) => {
    try {
      res.json({ comments: await pm.listComments(prisma, req.params.id) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // Activity feed (read-only timeline).
  router.get("/pm/work-items/:id/activity", async (req, res, next) => {
    try {
      res.json({ activity: await pm.listActivity(prisma, req.params.id) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post(
    "/pm/work-items/:id/comments",
    requireRoleOrMcpService(...WRITE),
    async (req, res, next) => {
      try {
        const parsed = commentCreateSchema.safeParse(req.body);
        if (!parsed.success) return badRequest(res, parsed);
        const comment = await pm.addComment(
          prisma,
          actorOf(req),
          req.params.id,
          parsed.data.comment_html,
        );
        res.status(201).json({ comment });
      } catch (err) {
        if (mapServiceError(err, res)) return;
        next(err);
      }
    },
  );

  return router;
}
