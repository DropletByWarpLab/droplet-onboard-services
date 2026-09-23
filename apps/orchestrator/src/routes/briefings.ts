/**
 * WARP-2270 (story WARP-2251) — `/api/briefings/*`: the caller's own morning
 * briefing.
 *
 * Self-only (decision 2, 2026-08-27): every Prisma call is scoped by
 * `req.user.id` and no route takes a user parameter. Another user's id is a
 * 404, never a 403 — a route must not confirm that someone else's row exists.
 *
 * `POST /today/run` only ENQUEUES (decision 7): it flips today's row to
 * `pending` and returns 202. The WARP-2252 single-flight executor runs it; the
 * tile polls `GET /today`. Nothing here calls the model.
 *
 * Logs carry ids, statuses and counts only — `body`, `headline` and `sources`
 * contain mail excerpts.
 */
import { Router } from "express";
import type { MorningBriefing, PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { cacheDel, cacheGet, cacheSet } from "../services/cache.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { resolveBoxTimezone } from "../services/scene-schedule-tz-backfill.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("briefings");

export const BRIEFING_CACHE_TTL_SECONDS = 300;
/** A rewrite inside this window after the last run ended is refused. */
export const BRIEFING_REWRITE_COOLDOWN_MS = 10 * 60 * 1000;
export const BRIEFING_HISTORY_MAX = 30;

export function briefingCacheKey(userId: string, forDate: string): string {
  return `briefing:${userId}:${forDate}`;
}

/** For the runner (WARP-2248) and sweep (WARP-2252) on every transition. */
export async function invalidateBriefingCache(userId: string, forDate: string): Promise<void> {
  await cacheDel(briefingCacheKey(userId, forDate));
}

/**
 * The box-local calendar day as `YYYY-MM-DD`: `Workspace.tz` → the box's
 * resolved zone → UTC. Stand-in until WARP-2252 exports its helper.
 */
export async function briefingToday(prisma: PrismaClient, now = new Date()): Promise<string> {
  let tz: string | null = null;
  try {
    const ws = await prisma.workspace.findUnique({ where: { id: 1 }, select: { tz: true } });
    tz = ws?.tz ?? null;
  } catch {
    // fall through to the box zone
  }
  for (const zone of [tz, resolveBoxTimezone(), "UTC"]) {
    if (!zone) continue;
    try {
      // en-CA formats as YYYY-MM-DD.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    } catch {
      // unknown zone string in Workspace.tz — try the next one
    }
  }
  return now.toISOString().slice(0, 10);
}

/** `@db.Date` round-trips as UTC midnight. */
function dateCol(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

export type BriefingRow = Omit<MorningBriefing, "userId" | "createdAt" | "updatedAt" | "forDate"> & {
  forDate: string;
};

/** The wire shape. Never includes `userId`. */
export function toRow(b: MorningBriefing): BriefingRow {
  return {
    id: b.id,
    forDate: b.forDate.toISOString().slice(0, 10),
    status: b.status,
    skipReason: b.skipReason,
    failureReason: b.failureReason,
    headline: b.headline,
    vibe: b.vibe,
    body: b.body,
    sources: b.sources,
    model: b.model,
    iterations: b.iterations,
    artKind: b.artKind,
    photoStatus: b.photoStatus,
    photoRef: b.photoRef,
    triggeredBy: b.triggeredBy,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    readAt: b.readAt,
  };
}

const IN_FLIGHT = new Set(["pending", "running"]);

export function createBriefingsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const floor = requireRole("owner", "admin", "family");

  router.get("/briefings/today", floor, async (req, res, next) => {
    try {
      const userId = req.user!.id;
      const forDate = await briefingToday(prisma);
      const key = briefingCacheKey(userId, forDate);
      const cached = await cacheGet<BriefingRow>(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const b = await prisma.morningBriefing.findUnique({
        where: { userId_forDate: { userId, forDate: dateCol(forDate) } },
      });
      if (!b) {
        res.status(404).json({ error: "no_briefing_today" });
        return;
      }
      const row = toRow(b);
      // An in-flight row is what the tile polls every 5 s; caching it would
      // pin "Writing…" for up to 300 s after the run settles.
      if (!IN_FLIGHT.has(row.status)) await cacheSet(key, row, BRIEFING_CACHE_TTL_SECONDS);
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  router.get("/briefings/unread-count", floor, async (req, res, next) => {
    try {
      // Not cached: a stale 1 after read is worse than one indexed lookup.
      const total = await prisma.morningBriefing.count({
        where: {
          userId: req.user!.id,
          forDate: dateCol(await briefingToday(prisma)),
          status: "ready",
          readAt: null,
        },
      });
      res.json({ total: total > 0 ? 1 : 0 });
    } catch (err) {
      next(err);
    }
  });

  router.get("/briefings", floor, async (req, res, next) => {
    try {
      const raw = Number.parseInt(String(req.query.limit ?? ""), 10);
      const take = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), BRIEFING_HISTORY_MAX) : 7;
      const items = await prisma.morningBriefing.findMany({
        where: { userId: req.user!.id },
        orderBy: { forDate: "desc" },
        take,
      });
      res.json({ items: items.map(toRow) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/briefings/today/run", floor, async (req, res, next) => {
    try {
      const userId = req.user!.id;
      const forDate = await briefingToday(prisma);
      const where = { userId_forDate: { userId, forDate: dateCol(forDate) } };

      let b = await prisma.morningBriefing.findUnique({ where });
      if (b?.status === "running") {
        res.status(429).json({ error: "briefing_run_in_progress" });
        return;
      }
      if (b && b.status !== "pending" && b.endedAt) {
        const left = b.endedAt.getTime() + BRIEFING_REWRITE_COOLDOWN_MS - Date.now();
        if (left > 0) {
          res.status(429).json({ error: "briefing_run_too_soon", retryAfterSec: Math.ceil(left / 1000) });
          return;
        }
      }

      if (!b) {
        // upsert, not create: two tabs pressing Write at once must not 500
        // on the (userId, forDate) unique.
        b = await prisma.morningBriefing.upsert({
          where,
          create: { userId, forDate: dateCol(forDate), status: "pending", triggeredBy: "user" },
          update: {},
        });
      } else if (b.status !== "pending") {
        // Conditional on the settled status so a runner that just claimed the
        // row is never reset underneath it.
        await prisma.morningBriefing.updateMany({
          where: { id: b.id, userId, status: { in: ["ready", "failed", "skipped"] } },
          data: {
            status: "pending",
            triggeredBy: "user",
            failureReason: null,
            skipReason: null,
            readAt: null,
          },
        });
        b = (await prisma.morningBriefing.findUnique({ where })) ?? b;
        if (b.status === "running") {
          res.status(429).json({ error: "briefing_run_in_progress" });
          return;
        }
      }

      await invalidateBriefingCache(userId, forDate);
      await recordActivity({
        kind: "tool_run",
        severity: "info",
        sourceIcon: "sun",
        what: "Morning briefing rewrite requested",
        refs: { briefingId: b.id, action: "rewrite_requested" },
        actor: { type: "user", id: userId },
      });
      logger.info({ briefingId: b.id, status: b.status }, "briefing rewrite enqueued");
      res.status(202).json({ briefingId: b.id, status: b.status });
    } catch (err) {
      next(err);
    }
  });

  router.post("/briefings/:id/read", floor, async (req, res, next) => {
    try {
      const userId = req.user!.id;
      const b = await prisma.morningBriefing.findFirst({ where: { id: req.params.id, userId } });
      if (!b) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (b.readAt) {
        res.json({ readAt: b.readAt });
        return;
      }
      const readAt = new Date();
      const { count } = await prisma.morningBriefing.updateMany({
        where: { id: b.id, userId, readAt: null },
        data: { readAt },
      });
      await invalidateBriefingCache(userId, b.forDate.toISOString().slice(0, 10));
      if (count === 0) {
        // Lost a race with another tab — return the readAt that won.
        const won = await prisma.morningBriefing.findFirst({ where: { id: b.id, userId } });
        res.json({ readAt: won?.readAt ?? readAt });
        return;
      }
      res.json({ readAt });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
