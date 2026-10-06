import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import { trustedOriginUrl } from "../lib/trusted-origin.js";
import { createLogger } from "../lib/logger.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { getGoogleApp, getMicrosoftApp, sealGoogleAppSecret, validateGoogleRedirectUri } from "../services/account-provider-setup.service.js";
import { parseAppRegistration } from "../services/m365/state.js";
const logger = createLogger("account-provider-setup");

const bodySchema = z.object({
  google: z.object({ clientId: z.string().trim().max(512), clientSecret: z.string().max(4096).optional() }).strict().optional(),
  microsoft: z.object({ clientId: z.string().trim().max(512), tenantId: z.string().trim().max(255) }).strict().optional(),
}).strict().refine((body) => body.google !== undefined || body.microsoft !== undefined);

export function createAccountProviderSetupRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use("/account-connections/setup", requireRole("owner", "admin"));
  router.get("/account-connections/setup", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const [googleRow, googleApp, microsoft, googleRedirect, microsoftRedirect] = await Promise.all([
        prisma.cloudOAuthApp.findUnique({ where: { provider: "GOOGLE" } }), getGoogleApp(prisma), getMicrosoftApp(prisma),
        trustedOriginUrl(req, "/api/google/callback"), trustedOriginUrl(req, "/api/m365/callback"),
      ]);
      const callbackSupported = validateGoogleRedirectUri(googleRedirect);
      return res.json({
        google: { clientId: googleRow?.clientId ?? "", hasClientSecret: !!googleApp, configured: !!googleApp && callbackSupported, redirectUri: googleRedirect, callbackSupported },
        microsoft: { clientId: microsoft?.clientId ?? "", tenantId: microsoft?.tenantId ?? "", configured: !!microsoft, redirectUri: microsoftRedirect },
      });
    } catch {
      return res.status(503).json({ error: "setup_unavailable", message: "Droplet could not read account connection setup. Try again." });
    }
  });

  router.put("/account-connections/setup", sensitiveRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = bodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "invalid_setup", message: "Check the account connection setup fields." });
    const microsoft = body.data.microsoft;
    const parsedMicrosoft = microsoft && (microsoft.clientId || microsoft.tenantId) ? parseAppRegistration(microsoft) : null;
    if (parsedMicrosoft && !parsedMicrosoft.ok) {
      return res.status(400).json({ error: "invalid_app_registration", message: parsedMicrosoft.reason, field: parsedMicrosoft.field });
    }
    try {
      await prisma.$transaction(async (tx) => {
        const google = body.data.google;
        if (google) {
          if (!google.clientId) {
            await tx.cloudOAuthApp.deleteMany({ where: { provider: "GOOGLE" } });
          } else {
            const existing = await tx.cloudOAuthApp.findUnique({ where: { provider: "GOOGLE" } });
            // An omitted secret can be retained only for the SAME client ID.
            const secret = google.clientSecret !== undefined
              ? (google.clientSecret ? sealGoogleAppSecret(google.clientSecret) : null)
              : existing?.clientId === google.clientId ? existing.clientSecretEnc : null;
            await tx.cloudOAuthApp.upsert({
              where: { provider: "GOOGLE" },
              create: { provider: "GOOGLE", clientId: google.clientId, clientSecretEnc: secret },
              update: { clientId: google.clientId, clientSecretEnc: secret },
            });
          }
        }
        if (microsoft) {
          if (!microsoft.clientId && !microsoft.tenantId) {
            await tx.cloudOAuthApp.deleteMany({ where: { provider: "MICROSOFT" } });
          } else if (parsedMicrosoft?.ok) {
            await tx.cloudOAuthApp.upsert({
              where: { provider: "MICROSOFT" },
              create: { provider: "MICROSOFT", ...parsedMicrosoft.app },
              update: parsedMicrosoft.app,
            });
          }
        }
      });
      try {
        await recordActivity({ kind: "system", severity: "info", sourceIcon: "mail", what: "Account connection setup updated", actor: actorFromRequest(req), refs: { providers: Object.keys(body.data) } });
      } catch {
        // Setup already committed; recorder downtime must not claim a failed save.
        logger.warn({ providers: Object.keys(body.data) }, "Account connection setup audit failed");
      }
      return res.json({ ok: true });
    } catch {
      return res.status(503).json({ error: "setup_save_failed", message: "Droplet could not save account connection setup. Try again." });
    }
  });
  return router;
}
