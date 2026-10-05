/**
 * /api/pm/* — native project-management routes (ADR-026), the Droplet-owned
 * project-management surface. Backs the dashboard Projects surface and (via the
 * orchestrator) the 9 `pm_*` MCP tools.
 *
 * Auth: mounted AFTER authMiddleware. PM is company-shared — reads are open
 * to any authenticated member-or-above role; writes are gated with
 * `requireRole`. An external guest reads nothing (WARP-3369, Romain
 * 2026-09-30): the `projects` module's tier floor (`refuseBelowFloor` in
 * access-catalog.ts, mounted by `mountModuleGates` off the `/api/pm` prefix)
 * answers 404 `module_disabled` before any route here runs. Project,
 * work-item + comment writes additionally admit the MCP service principal
 * (`requireRoleOrMcpService`) so the LLM's confirmed write tools can dispatch
 * through here. The human-facing confirmation gate is NOT in this file and NOT
 * in the tool handlers: it is the dispatch-time interceptor
 * (`packages/tools-core/src/interceptor.ts`, WARP-2305), pinned for every
 * confirming tool by `confirmation-interceptor-compat.test.ts`. An earlier
 * version of this comment claimed "the tool layer owns" it with no test behind
 * it, and the pm_* tools shipped ungated (WARP-2008).
 *
 * Errors: the service throws Error(code); we map codes → HTTP status here,
 * mirroring routes/calendar.ts.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole, requireRoleOrMcpService } from "../../middleware/auth.js";
import { guestAssignedInProject, guestAssignedWorkItem, ownAssignments } from "../../middleware/guest-share.js";
import * as pm from "../../services/pm/pm.service.js";
import { actorOf } from "./actor.js";
import { listRelationsFor } from "../../services/pm/pm-relations.service.js";
import { resolveDepartmentFilter } from "../../services/pm/pm-department.js";
import { isDateOnly, parseDateInput } from "../../services/pm/pm-dates.js";
import { recordActivity, recordActivityInTx } from "../../services/activity.singleton.js";
import { actorFromRequest } from "../../services/activity.service.js";
import { parsePaging } from "./paging.js";
import { WORK_ITEM_TYPE, ESTIMATE } from "./field-schemas.js";


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
    case "department_not_found":
    // ADR-048 — same shape: the referenced row is simply not there.
    case "company_not_found":
      res.status(404).json({ error: msg });
      return true;
    case "invalid_parent":
    case "invalid_state":
    // WARP-3371 — a re-parent that would close a loop, and a PATCH that would
    // strip a work item of its state. Well-formed requests whose CHOICE is not
    // processable: the same class as invalid_state.
    case "parent_cycle":
    case "state_required":
    // ADR-045 §5.3 — the HOUSEHOLD refusal. The referenced row exists and the
    // request is well-formed; it is the CHOICE that is not processable, which
    // is the same shape as invalid_state above.
    case "department_not_assignable":
    // WARP-3365 — an external guest cannot lead a project.
    case "lead_is_guest":
    // WARP-3520 — well-formed requests the DATA refuses: re-parenting that
    // would loop, a default that is a done/cancelled column, a reorder that
    // does not list every row once.
    case "parent_cycle":
    case "state_default_terminal":
    case "invalid_order":
      res.status(422).json({ error: msg });
      return true;
    case "identifier_taken":
    // WARP-3520 — the item is already in the state the request asks for.
    case "work_item_archived":
    case "work_item_not_archived":
    case "state_is_last":
    case "state_is_default":
    // ADR-045 §5.3 — the department exists and is a legal owner in principle;
    // it is on its way out. A conflict with the resource's current state, the
    // same class as state_is_last, not a validation failure.
    case "department_archived":
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
    // WARP-3371 — a label / assignee id that is not usable. The 422 names EVERY
    // offending id, so the caller can fix the request instead of guessing which.
    case "invalid_label":
    case "invalid_assignee":
      res.status(422).json({ error: msg, ids: err instanceof pm.PmRefError ? err.ids : [] });
      return true;
    case "invalid_cursor":
      // WARP-3371 — a `cursor` this list did not mint. The caller's mistake,
      // not a missing row, so 400 rather than a 404 or an empty page.
      res.status(400).json({ error: msg });
      return true;
    // WARP-3370 — a hard delete asked of a project that is not archived. The
    // request is well-formed and the caller may delete; the project's CURRENT
    // state is what forbids it (archive it first), the same class as
    // state_is_last — a conflict, not a validation failure.
    case "project_not_archived":
      res.status(409).json({ error: msg });
      return true;
    // WARP-3370 — the identifier typed to confirm is not this project's.
    case "identifier_mismatch":
      res.status(422).json({ error: msg });
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
  // ADR-045 §5.3 — the department that owns this project's work.
  // WARP-2724 — `.min(1)`: an empty string is a 400 here rather than a
    // falsy value the service has to notice. The comment in `pm.service.ts`
    // claiming "the zod schemas reject '' at the boundary" was true of
    // `company_id` and not of this one.
    department_id: z.string().min(1).max(64).optional(),
  // ADR-048 (WARP-2729) — the customer this project is FOR. The column has
  // existed since WARP-2562 with no writer on any path; this is the first.
  // `.min(1)`: an empty string is not a customer id. Without it, "" skipped the
  // service's existence check and reached Postgres as an invalid FK.
  company_id: z.string().min(1).max(64).optional(),
});

const projectPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(10000).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  leadId: z.string().max(64).nullable().optional(),
  // ADR-045 §5.3 — `null` clears the department; omitting it leaves it alone.
  // WARP-2724 — `.min(1)`, and `null` stays the way to CLEAR an
    // assignment. "" was neither: it skipped the guard and disconnected.
    department_id: z.string().min(1).max(64).nullable().optional(),
  // ADR-048 — `null` clears the customer; omitting it leaves it alone.
  // `null` clears; "" is a malformed id, not a clear — see the create schema.
  company_id: z.string().min(1).max(64).nullable().optional(),
  archived: z.boolean().optional(),
});

// WARP-3370 — hard delete is confirmed by typing the project's identifier. The
// dashboard asks for it; the API asks too, so a script cannot skip the question.
const projectDeleteSchema = z.object({ confirm_identifier: z.string().min(1).max(64) });

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
  // WARP-3520 — only `true`: a project always has exactly one default, so it
  // moves by making ANOTHER state the default, never by clearing this one.
  isDefault: z.literal(true).optional(),
});

// WARP-3520 — a full ordering: every row exactly once (the service checks that).
const stateReorderSchema = z.object({ state_ids: z.array(z.string().min(1).max(64)).min(1).max(100) });
const stateDeleteQuerySchema = z.object({ reassign_to: z.string().min(1).max(64).optional() });
const workItemArchivedQuerySchema = z.object({ archived: z.literal("only").optional() });

const labelCreateSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().max(32).optional(),
});

const labelPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().max(32).nullable().optional(),
});

/**
 * WARP-3372 — a date field is a CALENDAR DATE: `YYYY-MM-DD` (or, for a client
 * that predates this, an ISO instant ending in `Z`, whose UTC date is taken).
 * It parses to that day at 00:00:00Z — the value stored — so no zone is ever
 * applied to it (pm-dates.ts). `2026-02-30` is a 400, not March.
 */
const dateField = z
  .string()
  .max(40)
  .transform((s, ctx) => {
    const d = parseDateInput(s);
    if (!d) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected a calendar date, YYYY-MM-DD" });
      return z.NEVER;
    }
    return d;
  });

const workItemCreateSchema = z.object({
  name: z.string().min(1).max(500),
  description_html: z.string().max(100000).optional(),
  state_id: z.string().max(64).optional(),
  priority: PRIORITY.optional(),
  assignees: z.array(z.string().max(64)).max(50).optional(),
  label_ids: z.array(z.string().max(64)).max(50).optional(),
  parent_id: z.string().max(64).optional(),
  // ADR-045 §5.3 — overrides the project's department for this item.
  // WARP-2724 — `.min(1)`: an empty string is a 400 here rather than a
    // falsy value the service has to notice. The comment in `pm.service.ts`
    // claiming "the zod schemas reject '' at the boundary" was true of
    // `company_id` and not of this one.
    department_id: z.string().min(1).max(64).optional(),
  start_date: dateField.optional(),
  due_date: dateField.optional(),
  type: WORK_ITEM_TYPE.optional(),
  estimate: ESTIMATE.optional(),
});

const workItemPatchSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  description_html: z.string().max(100000).nullable().optional(),
  state_id: z.string().max(64).nullable().optional(),
  priority: PRIORITY.optional(),
  assignees: z.array(z.string().max(64)).max(50).optional(),
  label_ids: z.array(z.string().max(64)).max(50).optional(),
  parent_id: z.string().max(64).nullable().optional(),
  // ADR-045 §5.3 — `null` clears the OVERRIDE, so the item inherits its
  // project's department again (which may itself be none).
  // WARP-2724 — `.min(1)`, and `null` stays the way to CLEAR an
    // assignment. "" was neither: it skipped the guard and disconnected.
    department_id: z.string().min(1).max(64).nullable().optional(),
  start_date: dateField.nullable().optional(),
  due_date: dateField.nullable().optional(),
  // `sortOrder` is a Float column: a kanban drag inserts BETWEEN two cards
  // (2.5 between 2 and 3) without renumbering the column. `.int()` here made the
  // API refuse the very values the column exists for. `.finite()` still keeps
  // NaN and ±Infinity out of Prisma (review finding: sortOrder admits
  // NaN/Infinity) — JSON cannot carry them, but a client-built string or a future
  // coercion could.
  sortOrder: z.number().finite().optional(),
  type: WORK_ITEM_TYPE.optional(),
  // `null` clears the estimate; omitting it leaves it alone.
  estimate: ESTIMATE.nullable().optional(),
});

const transitionSchema = z.object({ state_id: z.string().min(1).max(64) });
const commentCreateSchema = z.object({ comment_html: z.string().min(1).max(100000) });

const summaryQuerySchema = z.object({
  // The caller's own calendar day; a date that does not exist is a 400.
  today: z
    .string()
    .refine(isDateOnly, "expected a calendar date, YYYY-MM-DD")
    .optional(),
});

const WRITE = ["owner", "admin", "family"] as const;

/**
 * WARP-3369 (Romain, 2026-09-30) — assigning a work item to an external guest
 * SHARES that one item with them: they may read it, comment on it and move its
 * state. These two routes are the ones that admit `guest` on top of WRITE; each
 * is followed by `guestAssignedWorkItem`, which answers 404 unless the item is
 * assigned to the calling guest. Everything else in Projects stays closed to a
 * guest (`requireModuleTierFloor`, with `modules/guest-shares.ts` naming the
 * five requests that get past it).
 */
const WRITE_OR_ASSIGNED_GUEST = [...WRITE, "guest"] as const;

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

/**
 * WARP-3370 — the audit row for a project archive / restore, through the same
 * recorder every other admin action on the box uses (`kind: "system"`, like a
 * department restore or a workspace-location change). Best-effort and AFTER the
 * commit, because both are reversible; the irreversible hard delete appends its
 * row inside its own transaction instead.
 */
async function auditProjectLifecycle(
  req: Request,
  verb: "archived" | "restored",
  project: pm.ApiProject,
): Promise<void> {
  await recordActivity({
    kind: "system",
    severity: "ok",
    sourceIcon: verb === "archived" ? "archive" : "archive-restore",
    what: verb === "archived" ? "Project archived" : "Project restored",
    sub: `${project.name} (${project.identifier})`,
    refs: {
      actor: req.user?.username ?? null,
      projectId: project.id,
      projectName: project.name,
      projectIdentifier: project.identifier,
    },
    actor: actorFromRequest(req),
  });
}

export function createPmNativeRouter(prisma: PrismaClient): Router {
  const router = Router();
  const sharedItem = guestAssignedWorkItem(prisma);
  const sharedProject = guestAssignedInProject(prisma);

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

  // Index KPI strip. `?today=YYYY-MM-DD` is the caller's own calendar day, so
  // "overdue" (due BEFORE today) means the same thing here as on the board
  // (WARP-3372); absent, it is the UTC date.
  router.get("/pm/summary", async (req, res, next) => {
    try {
      const parsed = summaryQuerySchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed);
      const slug = req.query.workspace ? String(req.query.workspace) : undefined;
      res.json({ summary: await pm.getSummary(prisma, slug, parsed.data.today) });
    } catch (err) {
      next(err);
    }
  });

  // WARP-3372 — who a PM user id names (lead, assignee, creator, author, actor).
  // GET /auth/users is owner/admin-only, so a member saw "User 1a2b" for every
  // colleague; this is the minimal {id, displayName, avatarUrl} projection of
  // the ACTIVE people on the box, readable by every role that reads the board.
  // Sits under /api/pm, so the `projects` module gate and the guest tier floor
  // (404 for an external guest, who is not on the GUEST_SHARES list) already
  // apply; the role guard here is the router being honest on its own, and keeps
  // the MCP service principal — which has no use for a roster — out.
  router.get("/pm/people", requireRole("owner", "admin", "family"), async (_req, res, next) => {
    try {
      res.json({ people: await pm.listPeople(prisma) });
    } catch (err) {
      next(err);
    }
  });

  // ── Projects ──
  router.get("/pm/projects", async (req, res, next) => {
    try {
      // 🔴 `?per_page=abc` used to reach `take` as NaN here and answer 500.
      const pageParsed = parsePaging(req.query);
      if (!pageParsed.success) return badRequest(res, pageParsed);
      const projects = await pm.listProjects(prisma, {
        workspaceSlug: req.query.workspace ? String(req.query.workspace) : undefined,
        includeArchived: req.query.archived === "1" || req.query.archived === "true",
        perPage: pageParsed.data.limit,
        // WARP-2719 — `?department=` takes an id, a slug or a NAME, and
        // `none` for "owned by nobody". Resolved here rather than left to the
        // caller because the assistant cannot look a name up: the department
        // listing scopes itself to the caller's own memberships, and the
        // service principal holds none.
        departmentId: await resolveDepartmentFilter(
          prisma,
          req.query.department === undefined ? undefined : String(req.query.department),
        ),
      });
      res.json({ projects });
    } catch (err) {
      // WARP-2719 — was a bare `next(err)`. An unknown department throws
      // `department_not_found` here, and without this it reaches the model as
      // a 500 (`BUSINESS_API_ERROR`) instead of the 404 that says which half
      // of the request was wrong.
      if (mapServiceError(err, res)) return;
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
        departmentId: parsed.data.department_id,
        companyId: parsed.data.company_id,
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
      // ADR-045 §5.3 — `department_id` is the only wire field on this schema
      // whose name differs from the service's, so the spread cannot carry it.
      // `undefined` (absent) and `null` (clear) mean different things and both
      // must survive the rename.
      // ADR-048 — `company_id` renames for the same reason `department_id`
      // does, and carries the same three-state meaning: absent leaves the
      // customer alone, `null` clears it, an id sets it.
      //
      // WARP-3370 — `archived` is split out: archiving and restoring are audited
      // transitions with their own function, not one more field of the update.
      const { department_id, company_id, archived, ...rest } = parsed.data;
      const hasFields = [...Object.values(rest), department_id, company_id].some((v) => v !== undefined);
      let project: pm.ApiProject | null = null;
      // An archive-only PATCH must not also rewrite the row for nothing.
      if (hasFields || archived === undefined) {
        project = await pm.updateProject(prisma, req.params.id, {
          ...rest,
          departmentId: department_id,
          companyId: company_id,
        });
      }
      if (archived !== undefined) {
        const out = await pm.setProjectArchived(prisma, req.params.id, archived);
        project = out.project;
        // A transition is audited; asking for the state it is already in is not.
        if (out.changed) await auditProjectLifecycle(req, archived ? "archived" : "restored", out.project);
      }
      res.json({ project });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // WARP-3370 — HARD delete. Not what "delete" meant before: it used to remove
  // any project, with every work item, for any member, leaving no trace. Now it
  // is owner/admin only, only for an ARCHIVED project, only with the identifier
  // typed, and it writes its audit row in the same transaction as the delete.
  // Members archive (PATCH `archived`); they cannot destroy. The MCP principal
  // is not admitted — no tool deletes a project.
  router.delete("/pm/projects/:id", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const parsed = projectDeleteSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      await pm.deleteProject(prisma, req.params.id, {
        confirmIdentifier: parsed.data.confirm_identifier,
        audit: (tx, project) =>
          recordActivityInTx(tx, {
            kind: "system",
            severity: "warn",
            sourceIcon: "trash-2",
            what: "Project deleted",
            sub: `${project.name} (${project.identifier})`,
            refs: {
              actor: req.user?.username ?? null,
              projectId: project.id,
              projectName: project.name,
              projectIdentifier: project.identifier,
              workItemsDeleted: project.workItemCount,
            },
            actor: actorFromRequest(req),
          }),
      });
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // ── States ──
  router.get("/pm/projects/:id/states", sharedProject, async (req, res, next) => {
    try {
      res.json({ states: await pm.listStates(prisma, req.params.id) });
    } catch (err) {
      // WARP-3528 — a service desk's id is project_not_found (404), not a 500.
      if (mapServiceError(err, res)) return;
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
      // WARP-3520 — `?reassign_to=<stateId>` picks where the state's items go;
      // omitted, they land in the project's default state as before.
      const query = stateDeleteQuerySchema.safeParse(req.query);
      if (!query.success) return badRequest(res, query);
      await pm.deleteState(prisma, req.params.id, { reassignTo: query.data.reassign_to });
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // WARP-3520 — the whole column order in one transaction. After
  // `POST /pm/projects/:id/states` and disjoint from every `:id` route above
  // (the second segment is a literal), so neither can shadow the other.
  router.post("/pm/projects/:id/states/reorder", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = stateReorderSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      res.json({ states: await pm.reorderStates(prisma, req.params.id, parsed.data.state_ids) });
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
      // WARP-3528 — as for the state list.
      if (mapServiceError(err, res)) return;
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
      // non-numeric limit/page returns a clean 400 instead of NaN → 500.
      const pageParsed = parsePaging(q);
      if (!pageParsed.success) return badRequest(res, pageParsed);
      // WARP-3520 — `?archived=only` is the "Archived" list; anything else
      // non-empty is a 400 rather than a silently ignored typo that would show
      // the live board where the archive was asked for.
      const archivedParsed = workItemArchivedQuerySchema.safeParse({
        archived: q.archived === "" ? undefined : q.archived,
      });
      if (!archivedParsed.success) return badRequest(res, archivedParsed);
      const parentRaw = q.parent;
      const page = await pm.listWorkItems(prisma, req.params.id, {
        archived: archivedParsed.data.archived,
        stateId: q.state ? String(q.state) : undefined,
        assignee: q.assignee ? String(q.assignee) : undefined,
        labelId: q.label ? String(q.label) : undefined,
        priority: q.priority
          ? (PRIORITY.safeParse(String(q.priority)).success
              ? (String(q.priority) as pm.ApiWorkItem["priority"])
              : undefined)
          : undefined,
        parentId: parentRaw === undefined ? undefined : parentRaw === "none" ? null : String(parentRaw),
        // WARP-2717 — `?department=` matches that department AND its teams;
        // `?department=none` matches work no department owns. The `none`
        // sentinel mirrors `?parent=none` directly above so the API has ONE
        // way to say "explicitly nothing".
        //
        // WARP-2719 widened it from an id to an id-or-slug-or-name and moved
        // the three-way decoding into `resolveDepartmentFilter`, so all three
        // readers answer the same word the same way — and an unknown one is a
        // 404 rather than an empty board.
        departmentId: await resolveDepartmentFilter(
          prisma,
          q.department === undefined ? undefined : String(q.department),
        ),
        q: q.q ? String(q.q) : undefined,
        limit: pageParsed.data.limit,
        cursor: pageParsed.data.cursor,
        page: pageParsed.data.page,
      });
      // WARP-3371 — a page, not a bare array: `nextCursor` is null on the last
      // page and `total` is the exact size of the filtered set, so a caller can
      // always tell "that is all of it" from "that is the first 100 of 250".
      res.json({ work_items: page.items, nextCursor: page.nextCursor, total: page.total });
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
          departmentId: d.department_id,
          startDate: d.start_date,
          dueDate: d.due_date,
          type: d.type,
          estimate: d.estimate,
        });
        res.status(201).json({ work_item });
      } catch (err) {
        if (mapServiceError(err, res)) return;
        next(err);
      }
    },
  );

  // WARP-3407 — the caller's OWN assigned work items, across projects (newest
  // change first). The one list an external guest gets: it is how they find
  // the items shared with them by assignment (WARP-3369), and it names nothing
  // else. Every role may read their own; `ownAssignments` pins the caller's id
  // and nothing in the query can change whose items are listed.
  router.get("/pm/assigned-to-me", ownAssignments(), async (req, res, next) => {
    try {
      const pageParsed = parsePaging(req.query);
      if (!pageParsed.success) return badRequest(res, pageParsed);
      const page = await pm.listAssignedWorkItems(prisma, String(res.locals.assigneeId), {
        limit: pageParsed.data.limit,
        cursor: pageParsed.data.cursor,
        page: pageParsed.data.page,
      });
      res.json({ work_items: page.items, nextCursor: page.nextCursor, total: page.total });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // Workspace-wide search (backs pm_search_work_items). Registered before the
  // /:id route — distinct path, no conflict.
  router.get("/pm/work-items", async (req, res, next) => {
    try {
      // 🔴 `?per_page=abc` used to reach `take` as NaN here and answer 500.
      const pageParsed = parsePaging(req.query);
      if (!pageParsed.success) return badRequest(res, pageParsed);
      const page = await pm.searchWorkItems(prisma, {
        workspaceSlug: req.query.workspace ? String(req.query.workspace) : undefined,
        q: req.query.q ? String(req.query.q) : "",
        limit: pageParsed.data.limit,
        cursor: pageParsed.data.cursor,
        // WARP-2719 — this reader is the one that answers "what is Front Desk
        // working on?", a question carrying no search term, so an empty `q`
        // alongside a department is now a real query rather than an empty list.
        departmentId: await resolveDepartmentFilter(
          prisma,
          req.query.department === undefined
            ? undefined
            : String(req.query.department),
        ),
      });
      res.json({ work_items: page.items, nextCursor: page.nextCursor, total: page.total });
    } catch (err) {
      // WARP-2719 — see GET /pm/projects. Was a bare `next(err)`.
      if (mapServiceError(err, res)) return;
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
  router.get("/pm/work-items/:id", sharedItem, async (req, res, next) => {
    try {
      // Independent reads, and getWorkItem already 404s a missing item, so the
      // relations read skips its own existence check rather than asking twice.
      //
      // WARP-3369: a guest is shown THE item and nothing around it. A relation
      // names the OTHER item (its title, its project), so a guest's detail
      // carries none, and the read is not even made.
      const isGuest = req.user?.role === "guest";
      const [work_item, relations] = await Promise.all([
        pm.getWorkItem(prisma, req.params.id),
        isGuest
          ? Promise.resolve([])
          : listRelationsFor(prisma, req.params.id, { itemChecked: true }),
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
          departmentId: d.department_id,
          // `undefined` leaves the date alone, `null` clears it.
          startDate: d.start_date,
          dueDate: d.due_date,
          sortOrder: d.sortOrder,
          type: d.type,
          estimate: d.estimate,
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
    requireRoleOrMcpService(...WRITE_OR_ASSIGNED_GUEST),
    sharedItem,
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

  // WARP-3520 — archive hides an item from the board and list and is fully
  // reversible; both are ordinary writer actions. Hard delete is not: it is
  // owner/admin only, below.
  router.post("/pm/work-items/:id/archive", requireRole(...WRITE), async (req, res, next) => {
    try {
      res.json({ work_item: await pm.archiveWorkItem(prisma, actorOf(req), req.params.id) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/work-items/:id/restore", requireRole(...WRITE), async (req, res, next) => {
    try {
      res.json({ work_item: await pm.restoreWorkItem(prisma, actorOf(req), req.params.id) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // WARP-3520 — OWNER/ADMIN only (it was every writer). A hard delete takes the
  // item's comments, activity and relations with it, so it is the one item action
  // that also leaves a signed audit row: the PmActivity trail dies with the item.
  // Ids and the key only — never the title or description (the audit stream is
  // exported wholesale).
  router.delete("/pm/work-items/:id", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const item = await pm.getWorkItem(prisma, req.params.id);
      await pm.deleteWorkItem(prisma, actorOf(req), req.params.id);
      await recordActivity({
        kind: "system",
        severity: "info",
        sourceIcon: "folder-kanban",
        what: "pm_work_item_delete",
        sub: item.key,
        refs: { surface: "projects", workItemId: item.id, projectId: item.projectId, key: item.key },
        actor: actorFromRequest(req),
      });
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // ── Comments ──
  router.get("/pm/work-items/:id/comments", sharedItem, async (req, res, next) => {
    try {
      const pageParsed = parsePaging(req.query);
      if (!pageParsed.success) return badRequest(res, pageParsed);
      const page = await pm.listComments(prisma, req.params.id, pageParsed.data);
      res.json({ comments: page.items, nextCursor: page.nextCursor, total: page.total });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // Activity feed (read-only timeline).
  router.get("/pm/work-items/:id/activity", async (req, res, next) => {
    try {
      const pageParsed = parsePaging(req.query);
      if (!pageParsed.success) return badRequest(res, pageParsed);
      const page = await pm.listActivity(prisma, req.params.id, pageParsed.data);
      res.json({ activity: page.items, nextCursor: page.nextCursor, total: page.total });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post(
    "/pm/work-items/:id/comments",
    requireRoleOrMcpService(...WRITE_OR_ASSIGNED_GUEST),
    sharedItem,
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
