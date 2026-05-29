/**
 * WARP-461 Phase B4 — Durable memory-fact CRUD on `/api/memory/facts`.
 *
 * Backs FEATURES.md §5 (durable per-workspace memory) + §2.2.7 (Memory
 * panel in the chat side panel). The model is *per workspace*, not per
 * user — the dashboard shows whatever facts the team has accumulated.
 *
 * Endpoints:
 *   GET    /api/memory/facts         — list. Optional ?category= filter,
 *                                       ?active=true|false, ?limit=N.
 *   POST   /api/memory/facts         — create. Body: {category, fact,
 *                                       evidenceChatId?}.
 *   PATCH  /api/memory/facts/:id     — edit fact/category/active.
 *   DELETE /api/memory/facts/:id     — hard delete (audit row still
 *                                       persisted on the ActivityRow side).
 *
 * Authorization: owner+admin+family — guest is read-only (no write).
 * Service principals don't manage memory; only humans do.
 */
import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";

type AuthedRequest = {
  user?: { id?: string; username?: string; role?: string };
};

const categoryEnum = z.enum(["Tone", "Workflow", "Scope", "Schedule", "Other"]);

const createFactSchema = z.object({
  category: categoryEnum,
  fact: z.string().min(1).max(2000),
  evidenceChatId: z.string().uuid().optional(),
});

const patchFactSchema = z
  .object({
    category: categoryEnum.optional(),
    fact: z.string().min(1).max(2000).optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (d) => d.category !== undefined || d.fact !== undefined || d.active !== undefined,
    { message: "At least one field is required" },
  );

const listQuerySchema = z.object({
  category: categoryEnum.optional(),
  active: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return 100;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : 100;
    }),
});

function authorOf(req: import("express").Request): string {
  const u = (req as AuthedRequest).user ?? {};
  // Prefer username for human readability in the audit chain. Fall back
  // to id (UUID) if username is unset.
  return u.username ?? u.id ?? "unknown";
}

export function createMemoryRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/memory/facts",
    requireRole("owner", "admin", "family", "guest"),
    async (req, res, next) => {
      try {
        const q = listQuerySchema.safeParse(req.query);
        if (!q.success) {
          res.status(400).json({ error: "Invalid query", details: q.error.flatten() });
          return;
        }
        const facts = await prisma.memoryFact.findMany({
          where: {
            ...(q.data.category ? { category: q.data.category } : {}),
            ...(q.data.active !== undefined ? { active: q.data.active } : {}),
          },
          orderBy: { addedAt: "desc" },
          take: q.data.limit,
        });
        res.json({ facts });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/memory/facts",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const parsed = createFactSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid fact", details: parsed.error.flatten() });
          return;
        }
        const fact = await prisma.memoryFact.create({
          data: {
            category: parsed.data.category,
            fact: parsed.data.fact,
            evidenceChatId: parsed.data.evidenceChatId,
            addedBy: authorOf(req),
          },
        });
        res.status(201).json({ fact });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/memory/facts/:id",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const parsed = patchFactSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid patch", details: parsed.error.flatten() });
          return;
        }
        // Atomic ownership-scoped update — same TOCTOU-avoidance pattern
        // as PR #279 (droplet-pr-review-patterns P1).
        const r = await prisma.memoryFact.updateMany({
          where: { id: req.params.id },
          data: parsed.data,
        });
        if (r.count === 0) {
          res.status(404).json({ error: "fact not found" });
          return;
        }
        const fact = await prisma.memoryFact.findUniqueOrThrow({
          where: { id: req.params.id },
        });
        res.json({ fact });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/memory/facts/:id",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const r = await prisma.memoryFact.deleteMany({
          where: { id: req.params.id },
        });
        if (r.count === 0) {
          res.status(404).json({ error: "fact not found" });
          return;
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
