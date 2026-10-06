/**
 * WARP-3519 (ADR-069 WS-2) — /api/pm/comments/*, /api/pm/work-items/:id/watchers
 * and /api/pm/work-items/:id/timeline: editing and deleting comments, reactions,
 * the watch list and the merged activity timeline.
 *
 * Its own router rather than more lines in routes/pm/native.ts, for the reason
 * routes/pm/relations.ts gives: the paths are disjoint from the native router's
 * (`/pm/comments/:id…`, `/pm/work-items/:id/{watchers,timeline}`), the error
 * vocabulary is its own, and other slices are editing native.ts concurrently.
 * Mounted on the same `/api` prefix in app.ts, immediately after the relations
 * router — so the `projects` module gate and the tier floor (`mountModuleGates`,
 * off the `/api/pm` prefix) cover every route here with no registry edit.
 *
 * Auth: mounted AFTER authMiddleware. Reads are open to any authenticated role
 * the module floor admits; every write takes `requireRole(...WRITE)`.
 *
 * RBAC, stated rather than left to be discovered:
 *   - Writes do NOT admit the MCP service principal. No tool edits or deletes a
 *     comment, reacts, or manages a watch list; admitting `_service:mcp` would
 *     widen the surface for a caller that does not exist (relations.ts's
 *     argument, verbatim). The assistant still COMMENTS — through native.ts.
 *   - External guests are not admitted to any route here, not even for an item
 *     assigned to them: none of these requests is in modules/guest-shares.ts, so
 *     the projects tier floor answers 404 `module_disabled`. Opening one is
 *     Romain's WARP-3369 decision to extend, not this slice's.
 *   - The finer rules (author-only edit, author-or-admin delete, owner / admin /
 *     project-lead management of OTHER people's watching) are the service's,
 *     because they depend on the row, not the role. They answer 403 with a
 *     stable code.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { normalizePmReactionEmoji } from "@droplet/shared-types";
import { requireRole } from "../../middleware/auth.js";
import { actorOf } from "./actor.js";
import { PM_ERRORS } from "../../services/pm/pm.service.js";
import {
  PM_COLLAB_ERRORS,
  TIMELINE_MAX_LIMIT,
  addReaction,
  addWatcher,
  deleteComment,
  editComment,
  getTimeline,
  listWatchers,
  removeReaction,
  removeWatcher,
  type CollabActor,
} from "../../services/pm/pm-collaboration.service.js";

const WRITE = ["owner", "admin", "family"] as const;

const commentEditSchema = z.object({ comment_html: z.string().min(1).max(100000) });

// The allowlist is checked here (a clean 400 naming the field) AND again in the
// service, which is the one that owns the vocabulary — a second caller of the
// service cannot skip it.
const emojiSchema = z.object({
  emoji: z
    .string()
    .min(1)
    .max(32)
    .refine((v) => normalizePmReactionEmoji(v) !== null, { message: "emoji is not an allowed reaction" }),
});

const watcherSchema = z.object({ user_id: z.string().min(1).max(64).optional() });

const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(TIMELINE_MAX_LIMIT).optional(),
  cursor: z.string().max(200).optional(),
});

function badRequest(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
}

/** Service error code -> HTTP. Returns true if handled. */
function mapCollabError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case PM_ERRORS.COMMENT_NOT_FOUND:
    case PM_ERRORS.WORK_ITEM_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case PM_COLLAB_ERRORS.COMMENT_FORBIDDEN:
    case PM_COLLAB_ERRORS.WATCH_FORBIDDEN:
      // The person is known and the request is well-formed; THIS row is not
      // theirs to change. (A role that may not write at all never gets here —
      // `requireRole` answers first.)
      res.status(403).json({ error: msg });
      return true;
    case PM_COLLAB_ERRORS.COMMENT_DELETED:
      // A conflict with the comment's current state, the class state_is_last is.
      res.status(409).json({ error: msg });
      return true;
    case PM_COLLAB_ERRORS.EMPTY_COMMENT:
    case PM_COLLAB_ERRORS.USER_CANNOT_READ:
      res.status(422).json({ error: msg });
      return true;
    case PM_COLLAB_ERRORS.INVALID_EMOJI:
    case PM_COLLAB_ERRORS.INVALID_CURSOR:
      res.status(400).json({ error: msg });
      return true;
    default:
      return false;
  }
}

const actorFrom = (req: Request): CollabActor => ({ id: actorOf(req), role: req.user?.role });

/** A DELETE has no body by convention but clients send one anyway — take the
 *  value from the JSON body or the query string, body first. */
function bodyOrQuery(req: Request, key: string): unknown {
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body?.[key];
  if (fromBody !== undefined) return fromBody;
  const fromQuery = req.query[key];
  return typeof fromQuery === "string" ? fromQuery : undefined;
}

export function createPmCollaborationRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── Comments: edit + delete ──
  router.patch("/pm/comments/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = commentEditSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const comment = await editComment(prisma, actorFrom(req), req.params.id, parsed.data.comment_html);
      res.json({ comment });
    } catch (err) {
      if (mapCollabError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/comments/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      const comment = await deleteComment(prisma, actorFrom(req), req.params.id);
      res.json({ deleted: req.params.id, comment });
    } catch (err) {
      if (mapCollabError(err, res)) return;
      next(err);
    }
  });

  // ── Reactions ──
  router.post("/pm/comments/:id/reactions", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = emojiSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed);
      const { comment, created } = await addReaction(
        prisma,
        actorFrom(req),
        req.params.id,
        parsed.data.emoji,
      );
      res.status(created ? 201 : 200).json({ comment });
    } catch (err) {
      if (mapCollabError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/comments/:id/reactions", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = emojiSchema.safeParse({ emoji: bodyOrQuery(req, "emoji") });
      if (!parsed.success) return badRequest(res, parsed);
      const comment = await removeReaction(prisma, actorFrom(req), req.params.id, parsed.data.emoji);
      res.json({ comment });
    } catch (err) {
      if (mapCollabError(err, res)) return;
      next(err);
    }
  });

  // ── Watchers ──
  router.get("/pm/work-items/:id/watchers", async (req, res, next) => {
    try {
      res.json({ watchers: await listWatchers(prisma, req.params.id) });
    } catch (err) {
      if (mapCollabError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/work-items/:id/watchers", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = watcherSchema.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(res, parsed);
      const { watchers, created } = await addWatcher(
        prisma,
        actorFrom(req),
        req.params.id,
        parsed.data.user_id,
      );
      res.status(created ? 201 : 200).json({ watchers });
    } catch (err) {
      if (mapCollabError(err, res)) return;
      next(err);
    }
  });

  router.delete("/pm/work-items/:id/watchers", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = watcherSchema.safeParse({ user_id: bodyOrQuery(req, "user_id") });
      if (!parsed.success) return badRequest(res, parsed);
      const { watchers } = await removeWatcher(
        prisma,
        actorFrom(req),
        req.params.id,
        parsed.data.user_id,
      );
      res.json({ watchers });
    } catch (err) {
      if (mapCollabError(err, res)) return;
      next(err);
    }
  });

  // ── Timeline (comments + activity merged, newest last) ──
  router.get("/pm/work-items/:id/timeline", async (req, res, next) => {
    try {
      const parsed = timelineQuerySchema.safeParse({
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      if (!parsed.success) return badRequest(res, parsed);
      res.json(await getTimeline(prisma, req.params.id, parsed.data));
    } catch (err) {
      if (mapCollabError(err, res)) return;
      next(err);
    }
  });

  return router;
}
