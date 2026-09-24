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
import { modelListGeneration } from "../services/model-list-generation.js";
import {
  getModelsPagePayload,
  overlayCloudState,
  type ModelsPagePayload,
} from "../services/models-summary.service.js";
import { resolveEffectiveAccess } from "../services/effective-access.service.js";
import {
  ACTIVE_CHAT_MODEL_KEY,
  readActiveChatModel,
  resolveLocalModelId,
  resolveStoredChatModel,
} from "../services/active-model.service.js";
import {
  benchmarkModel,
  benchCacheKey,
  BENCH_CACHE_TTL,
} from "../services/model-benchmark.service.js";
import {
  fetchEligibleCatalog,
  openPullStream,
  readPullRefusal,
  type EligibleCatalog,
} from "../services/model-catalog.service.js";

const logger = createLogger("models-route");

const MODELS_PAGE_CACHE_KEY = "models:page";
const MODELS_PAGE_CACHE_TTL = 30;
// WARP-3046: GET /api/llm/models' cache (the chat picker's list). Same literal
// as routes/llm.ts `MODELS_CACHE_KEY`, restated here the way llm.ts restates
// MODELS_PAGE_CACHE_KEY, rather than importing a route module into another.
const LLM_MODELS_CACHE_KEY = "llm:models";

export function createModelsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // No requireRole — per ADR-004 §3, GET endpoints stay open to any
  // authenticated principal (incl. the `service` role used by mcp-server
  // and voice-io). authMiddleware has already rejected unauthenticated
  // requests by the time this handler runs.
  router.get(
    "/models",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // The gateway-derived payload is cached; `activeModel` is NOT — it's
        // merged fresh from the setting on every request so a PATCH below
        // takes effect immediately without a cache-invalidation dance.
        let payload = await cacheGet<ModelsPagePayload>(MODELS_PAGE_CACHE_KEY);
        if (!payload) {
          const generation = modelListGeneration();
          payload = await getModelsPagePayload();
          // WARP-1289: never cache a degraded payload (same rule as
          // GET /api/llm/models under WARP-1284) — the next request retries
          // the gateway so the page self-heals the moment the AI service is
          // reachable again, instead of pinning "unreachable" for a TTL.
          // WARP-3046: nor one a finished download overtook — its list
          // predates the new model, and the pull's bust has already run
          // (model-list-generation.ts). This caller still gets it.
          if (!payload.degraded && generation === modelListGeneration()) {
            await cacheSet(MODELS_PAGE_CACHE_KEY, payload, MODELS_PAGE_CACHE_TTL);
          }
        }

        // Resolve the active model against what's actually installed.
        // WARP-1511: a blank/stale setting falls back to the sole/first
        // installed local model (see resolveActiveChatModel's doc comment)
        // instead of claiming a permanent phantom-blank active model. When
        // the local list itself can't be trusted (gateway/Ollama listing
        // degraded), pass `null` so the stored value passes through
        // unresolved rather than being nulled out — or a fallback fabricated
        // — against an incomplete list. WARP-2882: the stored row may hold a
        // legacy display name; `resolveStoredChatModel` maps it to the
        // runtime id first (the same path `/api/llm/models` uses).
        const activeModel = resolveStoredChatModel(
          await readActiveChatModel(prisma),
          payload.degraded ? null : payload.local,
        );

        // WARP-2871 — cloud key + escape state is merged fresh here, per
        // request, for the same reason `activeModel` is: the cached payload
        // is shared by every caller for 30 s, and an admin who just saved a
        // key (or flipped the escape) must see it on the next GET. Each
        // source degrades on its own to null / OFF, never to a guess, and
        // none of them marks the page degraded — the local list is fine.
        const user = req.user;
        const [keys, escapeRow, allowedForYou] = await Promise.all([
          aiGateway.listKeys().catch((err: unknown) => {
            logger.warn({ err }, "GET /models: could not list cloud keys");
            return null;
          }),
          prisma.offLanAllowlistChannel.findUnique({
            where: { key: "cloud_model_escape" },
            select: { enabled: true, lastChangedBy: true, lastChangedAt: true },
          }),
          // §3: service principals never resolve through layer 2, and a
          // session with no person id has nothing to resolve.
          !user?.id || user.role === "service"
            ? Promise.resolve(null)
            : resolveEffectiveAccess(user.id)
                .then((access) => access?.cloud ?? null)
                .catch((err: unknown) => {
                  logger.warn({ err, userId: user.id }, "GET /models: cloud verdict unavailable");
                  return null;
                }),
        ]);

        const overlaid = overlayCloudState(payload, { keys, escapeRow, allowedForYou });
        // WARP-2871: GET /api/settings/off-lan 403s a guest — who flipped the
        // escape, when, and which vendors are keyed must not leak here either.
        // The switch state and the guest's own verdict are still served.
        if (user?.role === "guest") {
          overlaid.cloudAccess.escapeChangedBy = null;
          overlaid.cloudAccess.escapeChangedAt = null;
          overlaid.cloud = overlaid.cloud.map((row) => ({ ...row, hasKey: null }));
        }
        res.json({ ...overlaid, activeModel });
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
        const ref = model.trim();

        // Validate against the LIVE installed set (source of truth), not the
        // 30s-cached page payload — a write must not be validated against a
        // stale list. If the gateway is unreachable we can't vouch for the
        // set, so refuse rather than persist an unverifiable choice.
        // WARP-2882: the caller may send the runtime id or the display name;
        // what gets PERSISTED is always the runtime id.
        let tag: string | null;
        try {
          const listed = await aiGateway.listModels();
          tag = resolveLocalModelId(listed.models, ref);
        } catch (err) {
          logger.warn({ err }, "PATCH /models/active: gateway unreachable");
          return res.status(503).json({
            error: "ai_service_unreachable",
            detail:
              "Couldn't reach the AI service to confirm the model is installed. Try again in a moment.",
          });
        }

        if (!tag) {
          return res.status(400).json({
            error: "not_installed",
            detail: `Model "${ref}" isn't installed on this Droplet.`,
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
        const ref = (req.params.name ?? "").trim();
        if (!ref) {
          return res.status(400).json({ error: "model name is required" });
        }

        // WARP-2882: resolve id-or-display-name to the runtime id — the
        // generation request and the cache key both need the id.
        let name: string | null;
        try {
          const listed = await aiGateway.listModels();
          name = resolveLocalModelId(listed.models, ref);
        } catch (err) {
          logger.warn({ err }, "POST /models/benchmark: gateway unreachable");
          return res.status(503).json({
            error: "ai_service_unreachable",
            detail:
              "Couldn't reach the AI service to confirm the model is installed. Try again in a moment.",
          });
        }
        if (!name) {
          return res.status(400).json({
            error: "not_installed",
            detail: `Model "${ref}" isn't installed on this Droplet.`,
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
  // catalog (never a cache): unreachable sidecar → 503, installed list
  // unreadable → 503 catalog_unconfirmed, unknown model → 400 not_eligible,
  // already installed → 409 already_pulled. A refusal from the sidecar is
  // translated, not relayed (WARP-3046, see `readPullRefusal`): its disk
  // preflight → 409 insufficient_disk, anything else → 502 pull_failed
  // carrying the runtime's own reason. Every exit after "started" that is
  // not a success records "Model download failed".
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
        // WARP-3046: the sidecar couldn't read the runtime's installed list,
        // so every `pulled` flag reads false — including the model that is
        // serving right now. The already_pulled guard below would wave a
        // second multi-GB copy of it through. Refuse until it can confirm.
        if (catalog.tags_unreachable) {
          return res.status(503).json({
            error: "catalog_unconfirmed",
            detail:
              "Couldn't confirm which models are already installed on this Droplet, so downloads are paused. Try again in a moment.",
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

        // The identifier that goes ON THE WIRE is the catalog's `pull_tag`,
        // not the `:name` the user clicked. inference-manager's POST
        // /models/pull hands `body.model` straight to the runtime
        // (`runtime.pull(...)`) — it does NOT resolve name → pull_tag for us;
        // its own manifest lookup only feeds the disk preflight, which is why
        // either identifier appears to work right up until the registry.
        // droplet-local-LLM's docs/model-management.md is explicit: pull_tag
        // is "what POST /api/pull is called with". An entry with no pull_tag
        // is only addressable by its catalog name, so fall back to that.
        // `name` stays the user-facing identity everywhere else — audit rows,
        // progress events, error copy — so the tag never leaks into the UI.
        const pullTag = entry.pull_tag ?? name;

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

        // WARP-3046: the "started" row above must always be closed. Every
        // exit below that is not a success records this, with the reason in
        // `refs` — before, a refusal or an interrupted stream left the
        // download looking like it was still running.
        const recordFailed = (reason: string) =>
          recordActivity({
            kind: "system",
            severity: "warn",
            sourceIcon: "cpu",
            what: "Model download failed",
            sub: name,
            actor: actorFromRequest(req),
            refs: { actor: req.user?.username ?? null, model: name, reason },
          });

        // The upstream is aborted if OUR client goes away mid-stream, so a
        // closed dashboard tab doesn't leave the proxy leg running headless.
        const upstreamAbort = new AbortController();
        let upstream: Awaited<ReturnType<typeof openPullStream>>;
        try {
          upstream = await openPullStream(pullTag, upstreamAbort.signal);
        } catch (err) {
          logger.warn({ err, model: name }, "POST /models/pull: open stream failed");
          await recordFailed("inference_manager_unreachable");
          return res.status(502).json({
            error: "pull_failed",
            detail: "The download couldn't be started. Try again in a moment.",
          });
        }

        if (!upstream.ok || !upstream.body) {
          // Refused before any progress. Translated, never relayed: the disk
          // preflight's FastAPI body is an OBJECT the dashboard used to
          // render as a React child, and a runtime failure (bad tag, no
          // egress, rate limit) was flattened into "try again". See
          // readPullRefusal / contract C2.
          const refusal = await readPullRefusal(upstream);
          logger.warn(
            { status: upstream.status, refusal: refusal.body, model: name },
            "POST /models/pull: upstream refused",
          );
          await recordFailed(
            refusal.status === 409 ? refusal.body.error : refusal.body.detail,
          );
          return res.status(refusal.status).json(refusal.body);
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
        // WARP-3046: the runtime's own words for the failure, for the audit
        // row's `refs.reason` (the client already gets the line itself).
        let errorReason: string | null = null;
        const watchLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed) return;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            if (parsed.status === "success") sawSuccess = true;
            if (parsed.error != null) {
              sawError = true;
              errorReason ??= String(parsed.error).slice(0, 500);
            }
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
          // WARP-3046: every listing that shows installed models must see
          // the new one NOW. Busting only `models:page` let the dashboard's
          // immediate re-read re-cache the gateway's 60 s-old listing, and
          // the chat picker's `llm:models` was never busted — the model had
          // just left "Available to install", so it looked like it vanished
          // for ~90 s. The gateway goes FIRST: dropping our caches before it
          // lets a new read re-fill them from its pre-pull listing. And
          // `refreshModels()` bumps the model-list generation between the
          // two, so a read ALREADY in flight when the download finished
          // cannot write its pre-pull list back after the busts below
          // (model-list-generation.ts).
          try {
            await aiGateway.refreshModels();
          } catch (err) {
            // Best-effort: the pull itself succeeded. The gateway's own TTL
            // still bounds the staleness if this one call misses.
            logger.warn({ err, model: name }, "POST /models/pull: gateway model refresh failed");
          }
          await Promise.all([
            cacheDel(MODELS_PAGE_CACHE_KEY),
            cacheDel(LLM_MODELS_CACHE_KEY),
          ]);
          await recordActivity({
            kind: "system",
            severity: "info",
            sourceIcon: "cpu",
            what: "Model download finished",
            sub: name,
            actor: actorFromRequest(req),
            refs: { actor: req.user?.username ?? null, model: name },
          });
        } else {
          // Not a success, whatever else happened: an error line, the tab
          // closing (which cancels the download — see the out-of-scope
          // server-side job), or a stream that just stopped.
          await recordFailed(
            errorReason ??
              (sawError
                ? "runtime_error"
                : clientGone
                  ? "client_disconnected"
                  : "stream_ended_without_success"),
          );
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
