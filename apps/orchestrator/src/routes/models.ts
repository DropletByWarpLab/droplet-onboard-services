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
 *
 * WARP-1827 — the catalog work, part one (install-only):
 * GET /api/models/catalog        (READ, any authenticated principal) — the
 *                    inference-manager's ELIGIBLE catalog (VRAM-gated,
 *                    decided appliance-side) with per-model `pulled` flags.
 * POST /api/models/:name/pull    (WRITE, owner/admin) — start a catalog
 *                    download and stream the sidecar's NDJSON progress
 *                    through to the client. Pulls only INSTALL — the active
 *                    model is untouched (ADR-003 still holds: no model
 *                    choice moves to the appliance).
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
import {
  fetchEligibleCatalog,
  openPullStream,
  type EligibleCatalog,
} from "../services/model-catalog.service.js";

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

  // ── GET /api/models/catalog ──────────────────────────────────────
  // The inference-manager's ELIGIBLE catalog (VRAM-gated appliance-side)
  // with per-model `pulled` flags. No requireRole — per ADR-004 §3, GET
  // endpoints stay open to any authenticated principal, same as GET /models.
  // Deliberately UNCACHED: the `pulled` flags must be fresh so a completed
  // download drops out of "Available to install" on the next read.
  router.get(
    "/models/catalog",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        let catalog: EligibleCatalog;
        try {
          catalog = await fetchEligibleCatalog();
        } catch (err) {
          logger.warn({ err }, "GET /models/catalog: inference-manager unreachable");
          return res.status(503).json({
            error: "ai_service_unreachable",
            detail:
              "Couldn't reach the AI service to read the model catalog. Try again in a moment.",
          });
        }
        res.json(catalog);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /api/models/:name/pull ──────────────────────────────────
  // Start a catalog download and stream the sidecar's NDJSON progress
  // through to the client. owner/admin only. Install-only by design
  // (ADR-003): a pull never changes the active model — that stays the
  // separate PATCH above. Validation happens against the LIVE eligible
  // catalog (never a cache): unreachable sidecar → 503, unknown model →
  // 400 not_eligible, already installed → 409 already_pulled. The
  // sidecar's own 409 (disk preflight, `insufficient_disk`) passes
  // through verbatim so the dashboard can show its detail message.
  router.post(
    "/models/:name/pull",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const name = (req.params.name ?? "").trim();
        if (!name) {
          return res.status(400).json({ error: "model name is required" });
        }

        let catalog: EligibleCatalog;
        try {
          catalog = await fetchEligibleCatalog();
        } catch (err) {
          logger.warn({ err }, "POST /models/pull: inference-manager unreachable");
          return res.status(503).json({
            error: "ai_service_unreachable",
            detail:
              "Couldn't reach the AI service to confirm the model is available. Try again in a moment.",
          });
        }
        const entry = catalog.models.find((m) => m.name === name);
        if (!entry) {
          return res.status(400).json({
            error: "not_eligible",
            detail: `Model "${name}" isn't in the catalog of models this Droplet can run.`,
          });
        }
        if (entry.pulled) {
          return res.status(409).json({
            error: "already_pulled",
            detail: `Model "${name}" is already installed on this Droplet.`,
          });
        }

        // Audit the ATTEMPT before opening the stream — mirrors the PATCH
        // handler. A later failure gets its own row; silence never means
        // "nothing happened".
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "cpu",
          what: "Model download started",
          sub: name,
          actor: actorFromRequest(req),
          refs: { actor: req.user?.username ?? null, model: name },
        });

        // The upstream is aborted if OUR client goes away mid-stream, so a
        // closed dashboard tab doesn't leave the proxy leg running headless.
        const upstreamAbort = new AbortController();
        let upstream: Awaited<ReturnType<typeof openPullStream>>;
        try {
          upstream = await openPullStream(name, upstreamAbort.signal);
        } catch (err) {
          logger.warn({ err, model: name }, "POST /models/pull: open stream failed");
          return res.status(502).json({
            error: "pull_failed",
            detail: "The download couldn't be started. Try again in a moment.",
          });
        }

        if (upstream.status === 409) {
          // Disk preflight (`insufficient_disk`) — status + body verbatim.
          const body = await upstream
            .json()
            .catch(() => ({ error: "insufficient_disk" }));
          return res.status(409).json(body);
        }
        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text?.().catch(() => "");
          logger.warn(
            { status: upstream.status, detail, model: name },
            "POST /models/pull: upstream refused",
          );
          return res.status(502).json({
            error: "pull_failed",
            detail: "The download couldn't be started. Try again in a moment.",
          });
        }

        res.status(200);
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Cache-Control", "no-cache");
        res.flushHeaders?.();

        let clientGone = false;
        // Disconnect detection listens on the RESPONSE, not the request:
        // since Node 16, an IncomingMessage's "close" fires when the request
        // MESSAGE completes (measured here: +5ms into a still-streaming
        // response), so `req.on("close")` would abort every pull the moment
        // the body was parsed. `res`'s "close" fires exactly once at the true
        // end — writableEnded=true after a normal end, false when the client
        // walked away mid-stream. Only the latter aborts the upstream leg.
        res.on("close", () => {
          if (!res.writableEnded) {
            clientGone = true;
            upstreamAbort.abort();
          }
        });

        // Watch the NDJSON lines for the terminal shapes while piping them
        // through untouched. Tolerant per line: an unparseable line is
        // forwarded and otherwise ignored — the watcher must never be the
        // reason a pull "fails".
        let lineBuffer = "";
        let sawSuccess = false;
        let sawError = false;
        const watchLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed) return;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            if (parsed.status === "success") sawSuccess = true;
            if (parsed.error != null) sawError = true;
          } catch {
            /* not JSON — forwarded anyway, nothing to watch */
          }
        };

        try {
          for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
            const buf = Buffer.from(chunk);
            // A chunk can already be in flight when the client disconnects —
            // don't write into a destroyed response in that race window.
            if (!clientGone) {
              res.write(buf);
              // Express doesn't add flush(); compression middleware does. Call
              // it when present so each progress line leaves immediately.
              (res as unknown as { flush?: () => void }).flush?.();
            }
            lineBuffer += buf.toString("utf8");
            let newline: number;
            while ((newline = lineBuffer.indexOf("\n")) >= 0) {
              watchLine(lineBuffer.slice(0, newline));
              lineBuffer = lineBuffer.slice(newline + 1);
            }
          }
          if (lineBuffer) watchLine(lineBuffer);
        } catch (err) {
          // Client disconnect aborts the upstream (expected); anything else
          // is a mid-stream drop. Either way the outcome is whatever the
          // watcher saw — never fabricate a terminal line.
          if (!clientGone) {
            logger.warn({ err, model: name }, "POST /models/pull: stream interrupted");
          }
        }

        // Terminal accounting BEFORE res.end() so a client that saw the
        // stream finish can immediately re-read a busted cache.
        if (sawSuccess) {
          await cacheDel(MODELS_PAGE_CACHE_KEY);
          await recordActivity({
            kind: "system",
            severity: "info",
            sourceIcon: "cpu",
            what: "Model download finished",
            sub: name,
            actor: actorFromRequest(req),
            refs: { actor: req.user?.username ?? null, model: name },
          });
        } else if (sawError) {
          await recordActivity({
            kind: "system",
            severity: "warn",
            sourceIcon: "cpu",
            what: "Model download failed",
            sub: name,
            actor: actorFromRequest(req),
            refs: { actor: req.user?.username ?? null, model: name },
          });
        }
        if (!clientGone) res.end();
      } catch (err) {
        logger.warn({ err }, "POST /models/pull failed");
        next(err);
      }
    },
  );

  return router;
}
