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
 *
 * WARP-1302: the payload deliberately carries NO navigation target. The FQDN
 * is split-horizon (public-NXDOMAIN) and only resolvable where the box owns
 * the LAN's DNS — a shape fact the orchestrator cannot see (compose wires
 * DROPLET_LAN_DNS_AUTHORITY to the gateway only). The advance signal is
 * nginx's canonical-host 307, which IS authority-gated (spec §2(d)): the
 * status page's poll surfaces it as an opaqueredirect and reloads. A
 * payload-driven redirect here would send authority=0 clients to a DNS
 * dead-end.
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
        hqConfigured: Boolean(config.HQ_ISSUANCE_URL),
      });
    } catch {
      // The page treats any non-advance answer as "keep polling" — degrade
      // without leaking error internals onto an unauthenticated surface.
      res.status(503).json({ state: "UNKNOWN", fqdn: null, hqConfigured: false });
    }
  });

  return router;
}
