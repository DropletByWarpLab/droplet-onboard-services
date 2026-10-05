/**
 * WARP-3520 (ADR-069 WS-4) — /api/pm custom fields: the per-project field
 * DEFINITIONS and the VALUES an item holds for them.
 *
 * Its own router rather than more lines in routes/pm/native.ts, as relations.ts
 * is: the paths are disjoint (`/pm/projects/:id/properties`, `/pm/properties/:id`,
 * `/pm/work-items/:id/properties/:propertyId`), the error vocabulary is its own,
 * and several concurrent changes edit native.ts. Mounted on the same `/api`
 * prefix in app.ts, immediately after the relations router; the `projects`
 * module gate covers it because the gate is by `/api/pm` prefix.
 *
 * Who may do what:
 *   * Reads — any role that reaches the router (every PM read is open).
 *   * Value writes (`PUT` / `DELETE` .../properties/:propertyId) — owner / admin
 *     / family, like every other item edit.
 *   * Definition writes (create, patch, delete, reorder) — owner / admin, or the
 *     project's LEAD. A field is shared structure: it changes what every item in
 *     the project shows, so it is not an everyday writer's call, but the person
 *     the project answers to must be able to shape it without an admin.
 *
 * Writes here do NOT admit the MCP service principal: no registered tool writes
 * custom fields, so admitting `_service:mcp` would widen the surface for a caller
 * that does not exist (the stance relations.ts takes, for the same reason).
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { recordAccessDenied, requireRole } from "../../middleware/auth.js";
import { actorOf } from "./actor.js";
import { isServiceDesk } from "../../services/pm/pm.service.js";
import {
  PM_PROPERTY_ERRORS,
  PropertyValueError,
  OPTIONS_PER_PROPERTY_LIMIT,
  PROPERTIES_PER_PROJECT_LIMIT,
  clearPropertyValue,
  createProperty,
  deleteProperty,
  listProperties,
  reorderProperties,
  setPropertyValue,
  updateProperty,
} from "../../services/pm/pm-properties.service.js";

const WRITE = ["owner", "admin", "family"] as const;

/** A ROUTE validator, not a tool schema (see field-schemas.ts for why `z.enum`
 *  is fine here); mirrors the Prisma `PmPropertyType`. */
const PROPERTY_TYPE = z.enum(["text", "number", "date", "boolean", "select", "multi_select", "member"]);

const optionSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    label: z.string().trim().min(1).max(60),
    color: z.string().min(1).max(32).nullable().optional(),
  })
  .strict();

const propertyCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    type: PROPERTY_TYPE,
    options: z.array(optionSchema).max(OPTIONS_PER_PROPERTY_LIMIT).nullable().optional(),
  })
  .strict();

// `.strict()` is what makes `type` immutable: a PATCH that names it is a 400,
// not a silent no-op that would let a client believe it had changed.
const propertyPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    options: z.array(optionSchema).max(OPTIONS_PER_PROPERTY_LIMIT).optional(),
    sort_order: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

const propertyReorderSchema = z.object({
  property_ids: z.array(z.string().min(1).max(64)).min(1).max(PROPERTIES_PER_PROJECT_LIMIT),
});

// The value's SHAPE is checked per field type by the service; here it only has
// to be an object, so a bare string or array is a plain 400.
const valueSchema = z.object({ value: z.record(z.string(), z.unknown()) }).strict();

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

/** Service code -> HTTP. Returns true if handled. */
function mapFieldsError(err: unknown, res: Response): boolean {
  if (err instanceof PropertyValueError) {
    // The same envelope a zod failure uses, so the dashboard reads one shape:
    // the sentence goes under the `value` field.
    res.status(400).json({
      error: PM_PROPERTY_ERRORS.INVALID_VALUE,
      details: { formErrors: [], fieldErrors: { value: [err.userMessage] } },
    });
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case PM_PROPERTY_ERRORS.PROPERTY_NOT_FOUND:
    case PM_PROPERTY_ERRORS.PROJECT_NOT_FOUND:
    case PM_PROPERTY_ERRORS.WORK_ITEM_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case PM_PROPERTY_ERRORS.PROPERTY_NAME_TAKEN:
    case PM_PROPERTY_ERRORS.PROPERTY_LIMIT_REACHED:
      res.status(409).json({ error: msg });
      return true;
    case PM_PROPERTY_ERRORS.INVALID_OPTIONS:
    case PM_PROPERTY_ERRORS.INVALID_ORDER:
      res.status(422).json({ error: msg });
      return true;
    default:
      return false;
  }
}

/**
 * Owner / admin pass; a `family` user passes only as the project's LEAD; nobody
 * else does. Chained AFTER `requireRole(...WRITE)`, which has already refused
 * guest / service / no-session, so this only ever sees a writer.
 *
 * `resolveLead` returns the project's `leadId`, `null` for "no lead", or
 * `undefined` when there is no such project — which is the 404, not a 403: a
 * missing project must not read as "you are not its lead".
 */
function ownerAdminOrLead(
  resolveLead: (req: Request) => Promise<string | null | undefined>,
  notFound: string,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const role = req.user?.role;
      if (role === "owner" || role === "admin") {
        next();
        return;
      }
      const lead = await resolveLead(req);
      if (lead === undefined) {
        res.status(404).json({ error: notFound });
        return;
      }
      if (lead !== null && lead === req.user?.id) {
        next();
        return;
      }
      recordAccessDenied(req, "pm-not-project-lead");
      res.status(403).json({ error: "Forbidden: role not permitted" });
    } catch (err) {
      next(err);
    }
  };
}

export function createPmFieldsRouter(prisma: PrismaClient): Router {
  const router = Router();

  const leadOfProject = ownerAdminOrLead(async (req) => {
    const project = await prisma.pmProject.findUnique({
      where: { id: req.params.id },
      select: { leadId: true, kind: true },
    });
    return project && !isServiceDesk(project) ? project.leadId : undefined;
  }, PM_PROPERTY_ERRORS.PROJECT_NOT_FOUND);

  const leadOfProperty = ownerAdminOrLead(async (req) => {
    const property = await prisma.pmCustomProperty.findUnique({
      where: { id: req.params.id },
      select: { project: { select: { leadId: true, kind: true } } },
    });
    return property && !isServiceDesk(property.project) ? property.project.leadId : undefined;
  }, PM_PROPERTY_ERRORS.PROPERTY_NOT_FOUND);

  // ── Definitions ──
  router.get("/pm/projects/:id/properties", async (req, res, next) => {
    try {
      res.json({ properties: await listProperties(prisma, req.params.id) });
    } catch (err) {
      if (mapFieldsError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/projects/:id/properties", requireRole(...WRITE), leadOfProject, async (req, res, next) => {
    try {
      const parsed = propertyCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const property = await createProperty(prisma, req.params.id, parsed.data);
      res.status(201).json({ property });
    } catch (err) {
      if (mapFieldsError(err, res)) return;
      next(err);
    }
  });

  // After the bare `/properties` routes and disjoint from every `:id` route: the
  // second segment is a literal, so neither can shadow the other.
  router.post(
    "/pm/projects/:id/properties/reorder",
    requireRole(...WRITE),
    leadOfProject,
    async (req, res, next) => {
      try {
        const parsed = propertyReorderSchema.safeParse(req.body);
        if (!parsed.success) return badRequest(res, parsed);
        res.json({ properties: await reorderProperties(prisma, req.params.id, parsed.data.property_ids) });
      } catch (err) {
        if (mapFieldsError(err, res)) return;
        next(err);
      }
    },
  );

  router.patch("/pm/properties/:id", requireRole(...WRITE), leadOfProperty, async (req, res, next) => {
    try {
      const parsed = propertyPatchSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const property = await updateProperty(prisma, actorOf(req), req.params.id, {
        name: parsed.data.name,
        options: parsed.data.options,
        sortOrder: parsed.data.sort_order,
      });
      res.json({ property });
    } catch (err) {
      if (mapFieldsError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/properties/:id", requireRole(...WRITE), leadOfProperty, async (req, res, next) => {
    try {
      await deleteProperty(prisma, actorOf(req), req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (mapFieldsError(err, res)) return;
      next(err);
    }
  });

  // ── Values ──
  router.put(
    "/pm/work-items/:id/properties/:propertyId",
    requireRole(...WRITE),
    async (req, res, next) => {
      try {
        const parsed = valueSchema.safeParse(req.body);
        if (!parsed.success) return badRequest(res, parsed);
        const work_item = await setPropertyValue(
          prisma,
          actorOf(req),
          req.params.id,
          req.params.propertyId,
          parsed.data.value,
        );
        res.json({ work_item });
      } catch (err) {
        if (mapFieldsError(err, res)) return;
        next(err);
      }
    },
  );

  router.delete(
    "/pm/work-items/:id/properties/:propertyId",
    requireRole(...WRITE),
    async (req, res, next) => {
      try {
        const work_item = await clearPropertyValue(
          prisma,
          actorOf(req),
          req.params.id,
          req.params.propertyId,
        );
        res.json({ work_item });
      } catch (err) {
        if (mapFieldsError(err, res)) return;
        next(err);
      }
    },
  );

  return router;
}
