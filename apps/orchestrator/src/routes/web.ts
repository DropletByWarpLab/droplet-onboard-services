/**
 * WARP-1436 — ambient web data: GET /api/web/weather + GET /api/web/rates.
 *
 * The gate/policy/audit front for the `services/web-fetch` microservice
 * (the only component that actually talks to api.open-meteo.com and
 * www.ecb.europa.eu). Sovereignty posture, in order, on EVERY request:
 *
 *   1. Gate — the `ambient_data` off-LAN channel ("Weather & currency
 *      data (Open-Meteo, European Central Bank)") must be explicitly
 *      enabled. Fail-closed: missing row, disabled row, or a DB error
 *      all refuse with 451 { error: "egress_disabled" } and an audited
 *      refusal. No egress decision is ever guessed.
 *   2. Cache — Redis, keyed per normalized location / base currency.
 *      Freshness window 15 min (weather) / 24 h (rates); the entry is
 *      RETAINED longer so a provider outage can serve `stale: true`
 *      data instead of an error. A fresh hit never leaves the LAN.
 *   3. Upstream — bearer-authenticated call to web-fetch, 10 s abort.
 *      No WEB_FETCH_SERVICE_TOKEN configured → 502 fail-closed, logged,
 *      WITHOUT calling upstream.
 *
 * Every request lands one signed activity row (kind "network", sub
 * "web_egress") via the WARP-456 recorder — the same idiom as
 * routes/egress-audit.ts — with refs.outcome ∈ allowed | refused_gate |
 * provider_error | served_stale.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { config } from "../config.js";
import { ambientDataGate } from "../services/off-lan-gate.service.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import { actorFromRequest } from "../services/activity.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("web-routes");

/** Freshness windows (spec): weather 15 min, rates 24 h. */
const WEATHER_FRESH_SECONDS = 15 * 60;
const RATES_FRESH_SECONDS = 24 * 60 * 60;
/**
 * How long an entry is kept in Redis beyond its freshness window so a
 * provider outage can serve `stale: true` data. 7 days for both routes:
 * long enough to ride out a multi-day WAN outage, short enough that the
 * numbers are still plausibly useful.
 */
const STALE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const UPSTREAM_TIMEOUT_MS = 10_000;

const DST_WEATHER = "api.open-meteo.com";
const DST_RATES = "www.ecb.europa.eu";

type WebRoute = "weather" | "rates";
type WebOutcome = "allowed" | "refused_gate" | "provider_error" | "served_stale";

/** Cached envelope: the upstream JSON plus when we fetched it, so one
 *  Redis key serves both the fresh window and the stale fallback. */
interface CacheEntry {
  data: Record<string, unknown>;
  fetchedAt: number;
}

function isCacheEntry(v: unknown): v is CacheEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as CacheEntry).fetchedAt === "number" &&
    typeof (v as CacheEntry).data === "object" &&
    (v as CacheEntry).data !== null
  );
}

/** One signed activity row per request — the egress-audit idiom.
 *  Fire-and-forget: the HTTP response never waits on the append lock. */
function auditWebEgress(
  req: Request,
  route: WebRoute,
  outcome: WebOutcome,
  httpStatus: number,
): void {
  void recordActivity({
    kind: "network",
    severity: outcome === "refused_gate" || outcome === "provider_error" ? "warn" : "info",
    sourceIcon: "globe",
    what:
      route === "weather"
        ? "Ambient data: weather (Open-Meteo)"
        : "Ambient data: currency rates (European Central Bank)",
    sub: "web_egress",
    refs: {
      channel: "ambient_data",
      route,
      dst: route === "weather" ? DST_WEATHER : DST_RATES,
      outcome,
      httpStatus,
      ...(req.user?.id ? { userId: req.user.id } : {}),
    },
    actor: actorFromRequest(req),
  });
}

/** Bearer-authenticated GET against web-fetch with the 10 s abort. */
async function fetchUpstream(path: string, token: string): Promise<globalThis.Response> {
  return fetch(`${config.WEB_FETCH_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

export function createWebRouter(prisma: PrismaClient): Router {
  const router = Router();

  // `service` included for parity with the other read surfaces the
  // MCP/voice service principals consume (see routes/off-lan-network.ts).
  const guard = requireRole("owner", "admin", "family", "guest", "service");

  router.get("/web/weather", guard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Gate — fail-closed, before anything else.
      if (!(await ambientDataGate(prisma))) {
        auditWebEgress(req, "weather", "refused_gate", 451);
        res.status(451).json({ error: "egress_disabled" });
        return;
      }

      // 2. Validate.
      const raw = req.query.location;
      const location = typeof raw === "string" ? raw.trim() : "";
      if (location.length < 1 || location.length > 120) {
        res.status(400).json({ error: "invalid_location" });
        return;
      }

      // 3. Cache (normalized key). Fresh hit never leaves the LAN.
      const cacheKey = `web:weather:${location.toLowerCase()}`;
      const cached = await cacheGet<CacheEntry>(cacheKey);
      const entry = isCacheEntry(cached) ? cached : null;
      if (entry && Date.now() - entry.fetchedAt < WEATHER_FRESH_SECONDS * 1000) {
        auditWebEgress(req, "weather", "allowed", 200);
        res.json({ ...entry.data, stale: false });
        return;
      }

      // 4. Fail closed when the service token was never provisioned.
      const token = config.WEB_FETCH_SERVICE_TOKEN;
      if (!token) {
        logger.error(
          "WEB_FETCH_SERVICE_TOKEN is unset — refusing /web/weather (fail-closed, no upstream call)",
        );
        auditWebEgress(req, "weather", "provider_error", 502);
        res.status(502).json({ error: "weather_unavailable" });
        return;
      }

      // 5. Upstream.
      let upstream: globalThis.Response | null = null;
      try {
        upstream = await fetchUpstream(
          `/weather?location=${encodeURIComponent(location)}`,
          token,
        );
      } catch (err) {
        logger.warn({ err }, "web-fetch /weather call failed");
      }

      if (upstream?.status === 404) {
        auditWebEgress(req, "weather", "allowed", 404);
        res.status(404).json({ error: "location_not_found" });
        return;
      }

      if (upstream?.ok) {
        const data = (await upstream.json()) as Record<string, unknown>;
        await cacheSet(
          cacheKey,
          { data, fetchedAt: Date.now() } satisfies CacheEntry,
          STALE_RETENTION_SECONDS,
        );
        auditWebEgress(req, "weather", "allowed", 200);
        res.json({ ...data, stale: false });
        return;
      }

      // Upstream down / non-OK: serve the retained (stale) copy if any.
      if (entry) {
        auditWebEgress(req, "weather", "served_stale", 200);
        res.json({ ...entry.data, stale: true });
        return;
      }
      auditWebEgress(req, "weather", "provider_error", 502);
      res.status(502).json({ error: "weather_unavailable" });
    } catch (err) {
      next(err);
    }
  });

  router.get("/web/rates", guard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Gate — fail-closed, before anything else.
      if (!(await ambientDataGate(prisma))) {
        auditWebEgress(req, "rates", "refused_gate", 451);
        res.status(451).json({ error: "egress_disabled" });
        return;
      }

      // 2. Validate. Base is optional (EUR — the ECB's own reference base).
      const raw = req.query.base;
      const base = (typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "EUR").toUpperCase();
      if (!/^[A-Z]{3}$/.test(base)) {
        res.status(400).json({ error: "unknown_currency" });
        return;
      }

      // 3. Cache per base.
      const cacheKey = `web:rates:${base}`;
      const cached = await cacheGet<CacheEntry>(cacheKey);
      const entry = isCacheEntry(cached) ? cached : null;
      if (entry && Date.now() - entry.fetchedAt < RATES_FRESH_SECONDS * 1000) {
        auditWebEgress(req, "rates", "allowed", 200);
        res.json({ ...entry.data, stale: false });
        return;
      }

      // 4. Fail closed when the service token was never provisioned.
      const token = config.WEB_FETCH_SERVICE_TOKEN;
      if (!token) {
        logger.error(
          "WEB_FETCH_SERVICE_TOKEN is unset — refusing /web/rates (fail-closed, no upstream call)",
        );
        auditWebEgress(req, "rates", "provider_error", 502);
        res.status(502).json({ error: "rates_unavailable" });
        return;
      }

      // 5. Upstream.
      let upstream: globalThis.Response | null = null;
      try {
        upstream = await fetchUpstream(`/rates?base=${encodeURIComponent(base)}`, token);
      } catch (err) {
        logger.warn({ err }, "web-fetch /rates call failed");
      }

      // Upstream 400 = the fetcher rejected the currency code.
      if (upstream?.status === 400) {
        auditWebEgress(req, "rates", "allowed", 400);
        res.status(400).json({ error: "unknown_currency" });
        return;
      }

      if (upstream?.ok) {
        const data = (await upstream.json()) as Record<string, unknown>;
        await cacheSet(
          cacheKey,
          { data, fetchedAt: Date.now() } satisfies CacheEntry,
          STALE_RETENTION_SECONDS,
        );
        auditWebEgress(req, "rates", "allowed", 200);
        res.json({ ...data, stale: false });
        return;
      }

      // Upstream down / non-OK: serve the retained (stale) copy if any.
      if (entry) {
        auditWebEgress(req, "rates", "served_stale", 200);
        res.json({ ...entry.data, stale: true });
        return;
      }
      auditWebEgress(req, "rates", "provider_error", 502);
      res.status(502).json({ error: "rates_unavailable" });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
