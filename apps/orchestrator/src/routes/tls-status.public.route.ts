import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { servedCertMetadata } from "../lib/served-cert-pin.js";

/** Public, nonsecret local hostname and installed certificate metadata.
 * No certificate fingerprint or device credentials are exposed here. */
export function createTlsStatusPublicRouter(_prisma: PrismaClient): Router {
  const router = Router();

  router.get("/tls/status", async (_req, res) => {
    try {
      const row = servedCertMetadata(config.DROPLET_LAN_HOSTNAME);
      const fqdn = row?.fqdn || null;
      const state = row?.state ?? "UNKNOWN";
      // Count down the installed leaf, never an old fleet issuance record.
      const notAfter = row?.notAfter ?? null;
      const daysLeft = notAfter
        ? Math.floor((notAfter.getTime() - Date.now()) / 86_400_000)
        : null;
      res.json({
        state,
        fqdn,
        hqConfigured: false,
        internalHostname: config.DROPLET_LAN_HOSTNAME || null,
        daysLeft,
        coversInternalHostname: row?.coversInternalHostname ?? null,
      });
    } catch {
      // Degrade on unavailable metadata
      // without leaking error internals onto an unauthenticated surface.
      res.status(503).json({ state: "UNKNOWN", fqdn: null, hqConfigured: false, daysLeft: null, internalHostname: config.DROPLET_LAN_HOSTNAME || null, coversInternalHostname: null });
    }
  });

  return router;
}
