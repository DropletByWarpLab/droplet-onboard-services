/**
 * `/api/models` — the Models surface backend.
 *
 * GET /api/models    (READ, any authenticated principal) — the status
 *                    payload (FEATURES.md §2.11) plus `activeModel`: which
 *                    installed local model the box answers with by default.
 * PATCH /api/models/active  (WRITE, owner/admin) — change the active local
 *                    chat model. Validates the tag is actually installed,
 *                    persists it to the `ai.model.chat` WorkspaceSetting, and
 *                    audits the change (ActivityRow). WARP-1112.
 *
 * The one-model rule (WARP-836) is retired for *selection among installed
 * models*: this endpoint only ever points chat at a model already on the
 * box — it does NOT pull, delete, or otherwise mutate the model set (that
 * remains the catalog work). Appliance stays stateless about model choice
 * (ADR-003): the choice is a control-plane preference, resolved per request.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import { createLogger } from "../lib/logger.js";
import * as aiGateway from "../services/ai-gateway.client.js";
import {
  getModelsPagePayload,
  type ModelsPagePayload,
} from "../services/models-summary.service.js";
import {
  ACTIVE_CHAT_MODEL_KEY,
  readActiveChatModel,
  resolveActiveChatModel,
  localModelIdentifiers,
} from "../services/active-model.service.js";
import {
  benchmarkModel,
  benchCacheKey,
  BENCH_CACHE_TTL,
} from "../services/model-benchmark.service.js";

const logger = createLogger("models-route");

const MODELS_PAGE_CACHE_KEY = "models:page";
const MODELS_PAGE_CACHE_TTL = 30;

export function createModelsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // No requireRole — per ADR-004 §3, GET endpoints stay open to any
  // authenticated principal (incl. the `service` role used by mcp-server
  // and voice-io). authMiddleware has already rejected unauthenticated
  // requests by the time this handler runs.
  router.get(
    "/models",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        // The gateway-derived payload is cached; `activeModel` is NOT — it's
        // merged fresh from the setting on every request so a PATCH below
        // takes effect immediately without a cache-invalidation dance.
        let payload = await cacheGet<ModelsPagePayload>(MODELS_PAGE_CACHE_KEY);
        if (!payload) {
          payload = await getModelsPagePayload();
          // WARP-1289: never cache a degraded payload (same rule as
          // GET /api/llm/models under WARP-1284) — the next request retries
          // the gateway so the page self-heals the moment the AI service is
          // reachable again, instead of pinning "unreachable" for a TTL.
          if (!payload.degraded) {
            await cacheSet(MODELS_PAGE_CACHE_KEY, payload, MODELS_PAGE_CACHE_TTL);
          }
        }

        // Resolve the active model against what's actually installed (for
        // local models the row `name` IS the tag). WARP-1511: a blank/stale
        // setting now falls back to the sole/first installed local model
        // (see resolveActiveChatModel's doc comment for the full contract)
        // instead of claiming a permanent phantom-blank active model. When
        // the local list itself can't be trusted (gateway/Ollama listing
        // degraded), pass `null` so the resolver treats the installed set as
        // unknown and returns the stored value unresolved rather than
        // nulling it out — or fabricating a fallback — against an
        // incomplete list. Ollama-only, same "local never points off-box"
        // invariant as localModelIdentifiers.
        const installed = payload.degraded
          ? null
          : new Set(
              payload.local
                .filter((m) => m.provider === "ollama")
                .map((m) => m.name),
            );
        const activeModel = resolveActiveChatModel(
          await readActiveChatModel(prisma),
          installed,
        );

        res.json({ ...payload, activeModel });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PATCH /api/models/active ─────────────────────────────────────
  // Change the box's active local chat model. owner/admin only. The body
  // is `{ model: "<tag>" }`. The tag MUST be an installed local model —
  // this endpoint never pulls; it only re-points chat at a model already
  // on the box. One ActivityRow per real change (no-op writes skip audit,
  // same discipline as PATCH /api/settings).
  router.patch(
    "/models/active",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body ?? {};
        if (typeof body !== "object" || Array.isArray(body)) {
          return res.status(400).json({ error: "Invalid body" });
        }
        const model = body.model;
        if (typeof model !== "string" || model.trim().length === 0) {
          return res
            .status(400)
            .json({ error: "`model` (non-empty string) is required" });
        }
        const tag = model.trim();

        // Validate against the LIVE installed set (source of truth), not the
        // 30s-cached page payload — a write must not be validated against a
        // stale list. If the gateway is unreachable we can't vouch for the
        // set, so refuse rather than persist an unverifiable choice.
        let installed: Set<string>;
        try {
          const listed = await aiGateway.listModels();
          installed = localModelIdentifiers(listed.models);
        } catch (err) {
          logger.warn({ err }, "PATCH /models/active: gateway unreachable");
          return res.status(503).json({
            error: "ai_service_unreachable",
            detail:
              "Couldn't reach the AI service to confirm the model is installed. Try again in a moment.",
          });
        }

        if (!installed.has(tag)) {
          return res.status(400).json({
            error: "not_installed",
            detail: `Model "${tag}" isn't installed on this Droplet.`,
          });
        }

        const previous = await readActiveChatModel(prisma);
        if (previous === tag) {
          // No-op: same as PATCH /api/settings — an unchanged value skips
          // both the write AND the audit row so a re-submit on focus loss
          // doesn't pollute the activity feed.
          return res.json({ activeModel: tag, changed: false });
        }

        await prisma.workspaceSetting.upsert({
          where: { key: ACTIVE_CHAT_MODEL_KEY },
          update: { valueJson: tag as any },
          // create covers an older DB whose seeder hadn't added the row yet.
          create: {
            key: ACTIVE_CHAT_MODEL_KEY,
            section: "ai" as any,
            type: "string" as any,
            valueJson: tag as any,
          },
        });

        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "cpu",
          what: "Active model changed",
          sub: tag,
          actor: actorFromRequest(req),
          refs: {
            actor: req.user?.username ?? null,
            key: ACTIVE_CHAT_MODEL_KEY,
            previousModel: previous,
            nextModel: tag,
          },
        });

        res.json({ activeModel: tag, changed: true });
      } catch (err) {
        logger.warn({ err }, "PATCH /models/active failed");
        next(err);
      }
    },
  );

  // ── POST /api/models/:name/benchmark ─────────────────────────────
  // Measure a local model's tokens/sec (WARP-836). owner/admin, explicit:
  // benchmarking loads the model, which (max_loaded_models=1) can evict the
  // resident chat model — so this is never automatic. Runs a short fixed
  // generation, reads Ollama's own decode timing, caches the result, and
  // busts the page cache so the next GET shows the number.
  router.post(
    "/models/:name/benchmark",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const name = (req.params.name ?? "").trim();
        if (!name) {
          return res.status(400).json({ error: "model name is required" });
        }

        let installed: Set<string>;
        try {
          const listed = await aiGateway.listModels();
          installed = localModelIdentifiers(listed.models);
        } catch (err) {
          logger.warn({ err }, "POST /models/benchmark: gateway unreachable");
          return res.status(503).json({
            error: "ai_service_unreachable",
            detail:
              "Couldn't reach the AI service to confirm the model is installed. Try again in a moment.",
          });
        }
        if (!installed.has(name)) {
          return res.status(400).json({
            error: "not_installed",
            detail: `Model "${name}" isn't installed on this Droplet.`,
          });
        }

        const result = await benchmarkModel(name);
        if (!result) {
          return res.status(502).json({
            error: "benchmark_failed",
            detail:
              "Couldn't measure this model's speed just now. Give it a moment and try again.",
          });
        }

        await cacheSet(benchCacheKey(name), result, BENCH_CACHE_TTL);
        // Bust the 30s page cache so the freshly-measured tok/s shows on the
        // next GET /api/models instead of waiting out the TTL.
        await cacheDel(MODELS_PAGE_CACHE_KEY);

        res.json(result);
      } catch (err) {
        logger.warn({ err }, "POST /models/benchmark failed");
        next(err);
      }
    },
  );

  return router;
}
