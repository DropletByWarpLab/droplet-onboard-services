/**
 * WARP-2586 (ADR-045 slice G) — /api/pm/work-items/:id/relations, the cross-project link
 * surface.
 *
 * Its own router rather than more lines in routes/pm/native.ts: the paths are
 * disjoint (`/pm/work-items/:id/relations`, `/pm/relations/:relationId`), the
 * error vocabulary is its own, and several concurrent changes edit native.ts.
 * Mounted on the same `/api` prefix in app.ts, immediately after it.
 *
 * Auth: mounted AFTER authMiddleware. PM is household-shared, so reads are open
 * to any authenticated role and writes take `requireRole(...WRITE)` — the same
 * split native.ts uses.
 *
 * RBAC note, stated rather than left to be discovered: writes here do NOT admit
 * the MCP service principal. `requireRoleOrMcpService` on native.ts's project /
 * work-item / comment writes exists because a registered `pm_*` tool dispatches
 * through them. No tool writes relations (slice G registers none — see the
 * budget note in the ADR), so admitting `_service:mcp` would widen the surface
 * for a caller that does not exist. When a `pm_link_work_items` tool lands, its
 * change widens this guard and adds the TOOL_ROUTES hop in the same diff;
 * tool-routes.test.ts's bidirectional drift check is what makes that
 * non-optional.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../../middleware/auth.js";
import { actorOf } from "./actor.js";
import { isConcurrencyConflict } from "../../services/role-mutation-guard.service.js";
import {
  createRelation,
  deleteRelation,
  listRelationsFor,
  PM_RELATION_ERRORS,
  RELATION_SCAN_MAX_DEPTH,
  RELATION_SCAN_MAX_NODES,
  type ApiRelationKind,
} from "../../services/pm/pm-relations.service.js";


/**
 * `z.enum` here is a ROUTE validator, not a tool schema. WARP-1839's ban on
 * `enum` applies to the JSON Schema an LLM tool advertises, where it reaches
 * llama.cpp's GBNF grammar compiler — the ai-gateway's DMR sanitizer does not
 * strip it. Nothing in this file is serialized into `tools[]`; native.ts's
 * PRIORITY / STATE_GROUP validators are the same shape for the same reason.
 */
const RELATION_KIND = z.enum(["BLOCKS", "RELATES", "DUPLICATES"]);

const relationCreateSchema = z.object({
  to_work_item_id: z.string().min(1).max(64),
  kind: RELATION_KIND,
});

const WRITE = ["owner", "admin", "family"] as const;

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

/**
 * Service code -> HTTP. Returns true if handled.
 *
 * The interesting mappings:
 *   * `relation_cycle` is 409, not 422: the request is well-formed and the
 *     caller IS authorized — the current graph is what forbids it, and adding
 *     the reverse edge first would make the identical request succeed.
 *   * `relation_scan_exhausted` is 409 WITH the bounds in the body. A refusal
 *     the operator cannot explain is a support ticket; naming the limit that
 *     was hit turns it into a data-shape conversation.
 *   * P2034 (SERIALIZABLE loser) is 409 CONCURRENT_MUTATION, never a 500 —
 *     nothing was applied, retry. Same mapping people.ts / auth.ts use.
 */
function mapRelationError(err: unknown, res: Response): boolean {
  if (isConcurrencyConflict(err)) {
    res.status(409).json({
      error: "concurrent_mutation",
      code: "CONCURRENT_MUTATION",
      message: "Another request changed these work items at the same time. Nothing was applied — try again.",
    });
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case PM_RELATION_ERRORS.WORK_ITEM_NOT_FOUND:
    case PM_RELATION_ERRORS.RELATION_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case PM_RELATION_ERRORS.RELATION_SELF:
      res.status(422).json({ error: msg });
      return true;
    case PM_RELATION_ERRORS.RELATION_EXISTS:
      res.status(409).json({ error: msg });
      return true;
    case PM_RELATION_ERRORS.RELATION_CYCLE:
      res.status(409).json({
        error: msg,
        message: "That link would close a chain of blockers, so neither item could ever start.",
      });
      return true;
    case PM_RELATION_ERRORS.RELATION_SCAN_EXHAUSTED:
      res.status(409).json({
        error: msg,
        message:
          `The blocker graph reached this box's scan limit (${RELATION_SCAN_MAX_DEPTH} levels / ` +
          `${RELATION_SCAN_MAX_NODES} items), so the link was refused rather than added unchecked.`,
      });
      return true;
    default:
      return false;
  }
}

export function createPmRelationsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Read — any authenticated role, matching every other PM read.
  router.get("/pm/work-items/:id/relations", async (req, res, next) => {
    try {
      res.json({ relations: await listRelationsFor(prisma, req.params.id) });
    } catch (err) {
      if (mapRelationError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/work-items/:id/relations", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = relationCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const relation = await createRelation(prisma, actorOf(req), {
        fromId: req.params.id,
        toId: parsed.data.to_work_item_id,
        // The zod enum and the Prisma enum are the same three literals; the
        // cast is the one seam between a validated string and the generated
        // union, and it cannot widen because RELATION_KIND is closed.
        kind: parsed.data.kind as ApiRelationKind,
      });
      res.status(201).json({ relation });
    } catch (err) {
      if (mapRelationError(err, res)) return;
      next(err);
    }
  });

  // Delete by relation id — the id BOTH ends' reads return, so a symmetric
  // relation is removed by the same call from either side.
  router.delete("/pm/relations/:relationId", requireRole(...WRITE), async (req, res, next) => {
    try {
      await deleteRelation(prisma, actorOf(req), req.params.relationId);
      res.json({ deleted: req.params.relationId });
    } catch (err) {
      if (mapRelationError(err, res)) return;
      next(err);
    }
  });

  return router;
}
