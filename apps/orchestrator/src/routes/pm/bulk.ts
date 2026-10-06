/**
 * WARP-3537 (WS-6b) — `POST /api/pm/work-items/bulk`: change up to 500 work items
 * at once, all or nothing.
 *
 *   { ids: string[], patch: { stateId?, priority?, assigneeIds?, addLabelIds?,
 *                             removeLabelIds?, cycleId?, isArchived? } }
 *
 * What the service guarantees (one transaction, a per-item permission check, one
 * activity row per changed field per item) is `services/pm/pm-bulk.service.ts`'s
 * header; this file is the HTTP face: the role gate, validation, status codes.
 *
 * The patch is `.strict()`: a key this slice does not own — `moduleId`, `type`,
 * `estimate` — is a 400 that names it, not a field quietly ignored until a later
 * slice starts honouring it. And a patch must SAY something: `{}` is a 400, while
 * `{ cycleId: null }`, `{ isArchived: false }` and `{ assigneeIds: [] }` are
 * patches (every value in them is falsy and every one is a decision).
 *
 * Human roles only (`owner | admin | family`, what PATCH admits, minus the MCP
 * principal): a change needs a person to be attributed to, and the assistant has
 * no bulk tool. Own router, mounted on `/api` in app.ts BEFORE the native one like
 * the query and views routers — `/pm/work-items/bulk` is a literal under the
 * `/pm/work-items/:id` prefix native.ts reserves, and specific paths go first
 * (droplet-pr-review-patterns P16).
 *
 * Error bodies carry `ids` — the work items the refusal is about — so a client can
 * say "3 of these" and a person can find them:
 *
 *   403 work_items_forbidden    ids = every item the caller may not change
 *   404 work_item_not_found     ids = the ids that are not work items
 *   404 state_not_found | label_not_found | cycle_not_found
 *   422 invalid_state | invalid_label | invalid_cycle   ids = the items it does not fit
 *   422 invalid_assignee        ids = unusable person ids from the patch
 *   409 concurrent_mutation     nothing applied; send it again
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { PM_BULK_MAX_IDS, PM_BULK_MAX_VALUES, PM_PRIORITIES } from "@droplet/shared-types";
import { requireRole } from "../../middleware/auth.js";
import { PM_ERRORS, PmRefError } from "../../services/pm/pm.service.js";
import {
  PM_BULK_ERRORS,
  PM_BULK_WRITER_ROLES,
  PmBulkError,
  bulkUpdateWorkItems,
} from "../../services/pm/pm-bulk.service.js";

const idSchema = z.string().min(1).max(64);
const idList = z.array(idSchema).max(PM_BULK_MAX_VALUES);

const patchSchema = z
  .object({
    // A real state: "clear the state" is not a bulk action.
    stateId: idSchema.optional(),
    priority: z.enum(PM_PRIORITIES).optional(),
    // A full-set replacement, like `assignees` on the single-item PATCH; [] clears.
    assigneeIds: idList.optional(),
    addLabelIds: idList.optional(),
    removeLabelIds: idList.optional(),
    // null takes the item out of its cycle.
    cycleId: idSchema.nullable().optional(),
    isArchived: z.boolean().optional(),
  })
  .strict()
  .superRefine((patch, ctx) => {
    if (Object.values(patch).every((v) => v === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "empty_patch" });
    }
    const adding = new Set(patch.addLabelIds ?? []);
    if ((patch.removeLabelIds ?? []).some((l) => adding.has(l))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "label_added_and_removed", path: ["removeLabelIds"] });
    }
  });

/** Strict at the top level too: `id` for `ids` is a typo to refuse, not a no-op. */
const bodySchema = z
  .object({
    ids: z.array(idSchema).min(1).max(PM_BULK_MAX_IDS),
    patch: patchSchema,
  })
  .strict();

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

/** Service code → HTTP. Returns true if handled. */
function mapBulkError(err: unknown, res: Response): boolean {
  if (err instanceof PmRefError && err.message === PM_ERRORS.INVALID_ASSIGNEE) {
    res.status(422).json({ error: err.message, ids: err.ids });
    return true;
  }
  if (err instanceof PmBulkError) {
    switch (err.code) {
      case PM_BULK_ERRORS.FORBIDDEN:
        res.status(403).json({ error: err.code, ids: err.ids });
        return true;
      case PM_ERRORS.WORK_ITEM_NOT_FOUND:
        res.status(404).json({ error: err.code, ids: err.ids });
        return true;
      case PM_ERRORS.STATE_NOT_FOUND:
      case PM_ERRORS.LABEL_NOT_FOUND:
      case PM_BULK_ERRORS.CYCLE_NOT_FOUND:
        res.status(404).json({ error: err.code });
        return true;
      case PM_ERRORS.INVALID_STATE:
      case PM_BULK_ERRORS.INVALID_LABEL:
      case PM_BULK_ERRORS.INVALID_CYCLE:
        res.status(422).json({ error: err.code, ids: err.ids });
        return true;
      default:
        return false;
    }
  }
  if (err instanceof Error && err.message === PM_ERRORS.CONCURRENT_MUTATION) {
    // SERIALIZABLE loser. Nothing was applied; same body shape native.ts and
    // relations.ts use for the same case.
    res.status(409).json({
      error: err.message,
      code: "CONCURRENT_MUTATION",
      message: "Another request changed these work items at the same time. Nothing was applied — try again.",
    });
    return true;
  }
  return false;
}

export function createPmBulkRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post("/pm/work-items/bulk", requireRole(...PM_BULK_WRITER_ROLES), async (req: Request, res, next) => {
    try {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      // `requireRole` has refused every principal that is not one of the three
      // human roles, so `req.user` is a real person here.
      const user = req.user!;
      res.json(await bulkUpdateWorkItems(prisma, { userId: user.id, role: user.role }, parsed.data));
    } catch (err) {
      if (mapBulkError(err, res)) return;
      next(err);
    }
  });

  return router;
}
