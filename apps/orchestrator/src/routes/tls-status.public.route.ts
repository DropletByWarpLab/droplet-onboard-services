import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";

/**
 * Warning-free droplet.local (ADR-023 follow-through, spec §3): the gateway's
 * plain-HTTP status page polls this to auto-advance to the trusted FQDN the
 * moment issuance lands. PUBLIC by design — it runs BEFORE any login can
 * exist and rides plain HTTP on the LAN, so the payload carries NO device
 * secrets: cert lifecycle state, the (CT-public) FQDN, and whether HQ
 * issuance is configured at all (drives the page's air-gapped branch).
 * Mounted in app.ts BEFORE authMiddleware, like the other public routers.
 */
export function createTlsStatusPublicRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/tls/status", async (_req, res) => {
    try {
      const row = await prisma.tlsCert.findFirst({ orderBy: { updatedAt: "desc" } });
      const fqdn = row?.fqdn || config.DROPLET_PUBLIC_FQDN || null;
      const state = row?.state ?? "BOOTSTRAP_SELF_SIGNED";
      res.json({
        state,
        fqdn,
        redirectTo: state === "LE_ISSUED" && fqdn ? `https://${fqdn}/` : null,
        hqConfigured: Boolean(config.HQ_ISSUANCE_URL),
      });
    } catch {
      // The page treats any non-advance answer as "keep polling" — degrade
      // without leaking error internals onto an unauthenticated surface.
      res.status(503).json({ state: "UNKNOWN", fqdn: null, redirectTo: null, hqConfigured: false });
    }
  });

  return router;
}
