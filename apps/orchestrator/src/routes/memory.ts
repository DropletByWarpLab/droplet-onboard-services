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
import { standardRateLimit } from "../middleware/rate-limit.js";
import {
  canTargetAudience,
  visibleAudiences,
  type MemoryAudience,
} from "../services/memory-audience.js";

type AuthedRequest = {
  user?: { id?: string; username?: string; role?: string };
};

// WARP-1120 (D-9) — `Business` joins the memory-fact vocabulary (the enum
// value shipped in Phase 0's migration; Phase 2 threads it through every
// hardcoded site).
const categoryEnum = z.enum(["Tone", "Workflow", "Scope", "Schedule", "Other", "Business"]);
// WARP-845 — who the fact is distributed to (minimum-role ladder).
const audienceEnum = z.enum(["owner", "admin", "family", "guest"]);

const createFactSchema = z.object({
  category: categoryEnum,
  fact: z.string().min(1).max(2000),
  evidenceChatId: z.string().uuid().optional(),
  audience: audienceEnum.optional(),
});

const patchFactSchema = z
  .object({
    category: categoryEnum.optional(),
    fact: z.string().min(1).max(2000).optional(),
    active: z.boolean().optional(),
    audience: audienceEnum.optional(),
  })
  .refine(
    (d) =>
      d.category !== undefined ||
      d.fact !== undefined ||
      d.active !== undefined ||
      d.audience !== undefined,
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

/** WARP-845: owner/admin manage everything; everyone else can only see —
 *  and therefore touch — facts within their audience rank. Applied to
 *  reads AND writes so a family caller can't PATCH/DELETE (or read back
 *  via a no-op PATCH) an owner-audience fact they can't see. */
function audienceScope(role: string | undefined) {
  return role === "owner" || role === "admin"
    ? {}
    : { audience: { in: visibleAudiences(role) } };
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
        // WARP-845: owner/admin see everything (they manage the panel);
        // everyone else sees only the audiences their role may read.
        const role = (req as AuthedRequest).user?.role;
        const facts = await prisma.memoryFact.findMany({
          where: {
            ...(q.data.category ? { category: q.data.category } : {}),
            ...(q.data.active !== undefined ? { active: q.data.active } : {}),
            ...audienceScope(role),
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
    // CodeQL js/missing-rate-limiting — routine authenticated write (one
    // row per call); the standard per-IP preset is the right ceiling.
    standardRateLimit,
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const parsed = createFactSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid fact", details: parsed.error.flatten() });
          return;
        }
        // WARP-845: you can't mint facts more privileged than yourself
        // (a family member can target family/guest, not admin/owner).
        const role = (req as AuthedRequest).user?.role;
        const audience: MemoryAudience = parsed.data.audience ?? "family";
        if (!canTargetAudience(role, audience)) {
          res.status(403).json({ error: "audience_above_role" });
          return;
        }
        const fact = await prisma.memoryFact.create({
          data: {
            category: parsed.data.category,
            fact: parsed.data.fact,
            evidenceChatId: parsed.data.evidenceChatId,
            addedBy: authorOf(req),
            audience,
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
        // WARP-845: retargeting a fact's audience obeys the same
        // can't-exceed-your-own-rank rule as creation.
        if (
          parsed.data.audience !== undefined &&
          !canTargetAudience(
            (req as AuthedRequest).user?.role,
            parsed.data.audience,
          )
        ) {
          res.status(403).json({ error: "audience_above_role" });
          return;
        }
        // Atomic ownership-scoped update — same TOCTOU-avoidance pattern
        // as PR #279 (droplet-pr-review-patterns P1). The audience scope
        // makes an out-of-rank fact indistinguishable from a missing one.
        const role = (req as AuthedRequest).user?.role;
        const r = await prisma.memoryFact.updateMany({
          where: { id: req.params.id, ...audienceScope(role) },
          data: parsed.data,
        });
        if (r.count === 0) {
          res.status(404).json({ error: "fact not found" });
          return;
        }
        // findFirst (not findUniqueOrThrow): a concurrent DELETE between
        // the update and the read-back should 404, not 500.
        const fact = await prisma.memoryFact.findFirst({
          where: { id: req.params.id },
        });
        if (!fact) {
          res.status(404).json({ error: "fact not found" });
          return;
        }
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
        const role = (req as AuthedRequest).user?.role;
        const r = await prisma.memoryFact.deleteMany({
          where: { id: req.params.id, ...audienceScope(role) },
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
