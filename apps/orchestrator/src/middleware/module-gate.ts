/**
 * Module gate — server-side enforcement of runtime module enablement.
 * `requireModuleEnabled(id)` 404s a route when its module isn't EFFECTIVE
 * (available && enabled), so a disabled module reads as ABSENT, not FORBIDDEN
 * (403 would leak that it exists). Applied at each module's router mount in
 * app.ts. Runs AFTER auth — this is a capability gate, not an authz gate
 * (ADR-004 role guards are orthogonal and still apply).
 *
 * The effective set is cached for a short TTL (module toggles flip rarely; same
 * rationale as the 30s admin-capabilities cache) so gated routes don't hit the
 * DB per request. Writes (toggle / apply-preset) call `invalidate()`.
 */
import type { RequestHandler } from "express";
import type { ModuleId, PrismaClient } from "@prisma/client";
import { getEffectiveModuleIds } from "../services/modules.service.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("module-gate");

export interface ModuleGate {
  requireModuleEnabled: (id: ModuleId) => RequestHandler;
  /** Bust the cache — call after any enablement write. */
  invalidate: () => void;
}

export function createModuleGate(
  prisma: PrismaClient,
  cfg: AvailabilityConfig,
  ttlMs = 5000
): ModuleGate {
  let cache: { at: number; ids: Set<ModuleId> } | null = null;

  async function effective(): Promise<Set<ModuleId>> {
    const now = Date.now();
    if (cache && now - cache.at < ttlMs) return cache.ids;
    const ids = await getEffectiveModuleIds(prisma, cfg);
    cache = { at: now, ids };
    return ids;
  }

  function requireModuleEnabled(id: ModuleId): RequestHandler {
    return async (_req, res, next) => {
      try {
        const ids = await effective();
        if (!ids.has(id)) {
          res.status(404).json({ error: "module_disabled", module: id });
          return;
        }
        next();
      } catch (e) {
        // Fail closed: on a read error we can't confirm the module is on, so
        // treat it as absent. The tiny cache means we re-query at most every
        // ttlMs, not per request.
        logger.error({ err: e, module: id }, "module_gate_read_failed");
        res.status(404).json({ error: "module_disabled", module: id });
      }
    };
  }

  return { requireModuleEnabled, invalidate: () => { cache = null; } };
}
