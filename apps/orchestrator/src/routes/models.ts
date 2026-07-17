/**
 * WARP-471 Phase F3 — `/api/models` (READ-ONLY).
 *
 * Backs FEATURES.md §2.11. One GET endpoint, no mutations. The route
 * file deliberately does NOT register PATCH/POST/DELETE handlers —
 * the one-model rule from CLAUDE.md is enforced structurally
 * (the only way to swap a model is via setup.sh's .env edit, never
 * via a runtime API).
 */
import { Router } from "express";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import {
  getModelsPagePayload,
  type ModelsPagePayload,
} from "../services/models-summary.service.js";

const MODELS_PAGE_CACHE_KEY = "models:page";
const MODELS_PAGE_CACHE_TTL = 30;

export function createModelsRouter(): Router {
  const router = Router();

  // No requireRole — per ADR-004 §3, GET endpoints stay open to any
  // authenticated principal (incl. the `service` role used by mcp-server
  // and voice-io). authMiddleware has already rejected unauthenticated
  // requests by the time this handler runs.
  router.get(
    "/models",
    async (_req, res, next) => {
      try {
        const cached = await cacheGet<ModelsPagePayload>(MODELS_PAGE_CACHE_KEY);
        if (cached) {
          res.json(cached);
          return;
        }
        const payload = await getModelsPagePayload();
        // WARP-1289: never cache a degraded payload (same rule as
        // GET /api/llm/models under WARP-1284) — the next request retries
        // the gateway so the page self-heals the moment the AI service is
        // reachable again, instead of pinning "unreachable" for a TTL.
        if (!payload.degraded) {
          await cacheSet(MODELS_PAGE_CACHE_KEY, payload, MODELS_PAGE_CACHE_TTL);
        }
        res.json(payload);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
