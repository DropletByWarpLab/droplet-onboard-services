/**
 * WARP-845 — per-user chat projects on `/api/llm/projects`.
 *
 * Folders for the chat history sidebar plus a default persona: each
 * project carries an optional `systemPrompt` the dashboard seeds into
 * new chats started inside it. Strictly per-user (product call): every
 * query is scoped by the caller's username, cross-user access 404s
 * (no existence leak), and there is no sharing surface.
 *
 *   GET    /llm/projects           — list caller's projects (+ chat counts)
 *   POST   /llm/projects           — create {name, systemPrompt?}
 *   PATCH  /llm/projects/:id       — rename / edit prompt
 *   DELETE /llm/projects/:id       — delete; chats survive (FK SET NULL)
 *
 * Conversation membership is managed on the existing conversation PATCH
 * (routes/llm.ts) via `projectId`, and stamped at creation via the chat
 * request's `projectId` (ownership-validated in ensureConversation's
 * caller).
 */
import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";

type AuthedRequest = {
  user?: { id?: string; username?: string; role?: string };
};

function callerUsername(req: AuthedRequest): string | null {
  return req.user?.username ?? null;
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  systemPrompt: z.string().max(4000).nullable().optional(),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    systemPrompt: z.string().max(4000).nullable().optional(),
  })
  .refine((d) => d.name !== undefined || d.systemPrompt !== undefined, {
    message: "At least one field is required",
  });

const HUMAN_ROLES = ["owner", "admin", "family", "guest"] as const;

/** One wire shape for every verb — GET's mapping, minus the caller's own
 *  `userId` (it's implicit) and always with `chatCount` so the dashboard
 *  type holds for rows inserted from POST/PATCH responses too. */
function toDto(
  p: {
    id: string;
    name: string;
    systemPrompt: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  chatCount: number,
) {
  return {
    id: p.id,
    name: p.name,
    systemPrompt: p.systemPrompt,
    chatCount,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function createChatProjectsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/llm/projects",
    requireRole(...HUMAN_ROLES),
    async (req, res, next) => {
      try {
        const userId = callerUsername(req as AuthedRequest);
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const projects = await prisma.chatProject.findMany({
          where: { userId },
          orderBy: { updatedAt: "desc" },
          include: { _count: { select: { sessions: true } } },
        });
        res.json({
          projects: projects.map((p) => toDto(p, p._count.sessions)),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/llm/projects",
    requireRole(...HUMAN_ROLES),
    async (req, res, next) => {
      try {
        const userId = callerUsername(req as AuthedRequest);
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid project",
            details: parsed.error.flatten(),
          });
          return;
        }
        const project = await prisma.chatProject.create({
          data: {
            userId,
            name: parsed.data.name,
            systemPrompt: parsed.data.systemPrompt ?? null,
          },
        });
        res.status(201).json({ project: toDto(project, 0) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/llm/projects/:id",
    requireRole(...HUMAN_ROLES),
    async (req, res, next) => {
      try {
        const userId = callerUsername(req as AuthedRequest);
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const parsed = patchSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid patch",
            details: parsed.error.flatten(),
          });
          return;
        }
        // Atomic ownership-scoped update (no TOCTOU pre-check).
        const r = await prisma.chatProject.updateMany({
          where: { id: req.params.id, userId },
          data: parsed.data,
        });
        if (r.count === 0) {
          res.status(404).json({ error: "project_not_found" });
          return;
        }
        // findFirst (not findUniqueOrThrow): a concurrent DELETE between
        // the update and the read-back should 404, not 500.
        const project = await prisma.chatProject.findFirst({
          where: { id: req.params.id },
          include: { _count: { select: { sessions: true } } },
        });
        if (!project) {
          res.status(404).json({ error: "project_not_found" });
          return;
        }
        res.json({ project: toDto(project, project._count.sessions) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/llm/projects/:id",
    requireRole(...HUMAN_ROLES),
    async (req, res, next) => {
      try {
        const userId = callerUsername(req as AuthedRequest);
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const r = await prisma.chatProject.deleteMany({
          where: { id: req.params.id, userId },
        });
        if (r.count === 0) {
          res.status(404).json({ error: "project_not_found" });
          return;
        }
        // Chats survive via the FK's SET NULL — nothing else to do.
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
