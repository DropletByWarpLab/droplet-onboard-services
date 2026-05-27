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
import { requireRole } from "../middleware/auth.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import {
  getModelsPagePayload,
  type ModelsPagePayload,
} from "../services/models-summary.service.js";

const MODELS_PAGE_CACHE_KEY = "models:page";
const MODELS_PAGE_CACHE_TTL = 30;

export function createModelsRouter(): Router {
  const router = Router();

  router.get(
    "/models",
    requireRole("owner", "admin", "family", "guest"),
    async (_req, res, next) => {
      try {
        const cached = await cacheGet<ModelsPagePayload>(MODELS_PAGE_CACHE_KEY);
        if (cached) {
          res.json(cached);
          return;
        }
        const payload = await getModelsPagePayload();
        await cacheSet(MODELS_PAGE_CACHE_KEY, payload, MODELS_PAGE_CACHE_TTL);
        res.json(payload);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
