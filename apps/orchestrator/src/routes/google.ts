/** Public callback is mounted before session auth; account control stays per person. */
import { Router, type Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { bearerIsServicePrincipal, requireRole } from "../middleware/auth.js";
import { authRateLimit, sensitiveRateLimit, standardRateLimit } from "../middleware/rate-limit.js";
import { trustedOriginUrl } from "../lib/trusted-origin.js";
import { validateGoogleRedirectUri } from "../services/account-provider-setup.service.js";
import {
  beginGoogleConnect, completeGoogleConnect, disconnectGoogle, getGoogleConnectionView,
  getGoogleMailboxAccessToken, googleDependencies, GOOGLE_FLOW_TTL_MS,
  GoogleDisconnectRequiredError, GoogleMailboxUnavailableError, GoogleNotConnectedError, GoogleSetupRequiredError, GoogleTemporarilyUnavailableError,
  type GoogleDependencies, type GoogleOutcome,
} from "../services/google/google-auth.service.js";

export const GOOGLE_CALLBACK_PATH = "/api/google/callback";
export const GOOGLE_STATE_COOKIE = "droplet_google_state";
const COOKIE_PATH = "/api/google";
const CONNECT_ROLES = ["owner", "admin", "family"] as const;
const connectBody = z.object({ mail: z.boolean().default(true), calendar: z.boolean().default(false) }).strict()
  .refine((features) => features.mail || features.calendar);

export function createGoogleRouter(prisma: PrismaClient, options: Partial<GoogleDependencies> = {}): Router {
  const router = Router();
  const deps = googleDependencies(options);

  router.get("/google/connection", standardRateLimit, requireRole(...CONNECT_ROLES), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user?.id) return res.status(401).json({ error: "unauthenticated" });
    try {
      const redirectUri = await trustedOriginUrl(req, GOOGLE_CALLBACK_PATH);
      const view = await getGoogleConnectionView(prisma, req.user.id, deps.now());
      return res.json({ ...view, configured: !!await deps.getApp(prisma), redirectUri,
        callbackSupported: validateGoogleRedirectUri(redirectUri) });
    } catch {
      return res.status(503).json({ error: "google_status_unavailable" });
    }
  });

  router.post("/google/connect", sensitiveRateLimit, requireRole(...CONNECT_ROLES), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user?.id) return res.status(401).json({ error: "unauthenticated" });
    const body = connectBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: "invalid_request" });
    try {
      const redirectUri = await trustedOriginUrl(req, GOOGLE_CALLBACK_PATH);
      const started = await beginGoogleConnect(prisma, req.user.id, redirectUri, deps, body.data);
      res.cookie(GOOGLE_STATE_COOKIE, started.state, {
        httpOnly: true, secure: true, sameSite: "lax", path: COOKIE_PATH, maxAge: GOOGLE_FLOW_TTL_MS,
      });
      return res.json({ authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt });
    } catch (err) {
      if (err instanceof GoogleSetupRequiredError) return res.status(400).json({
        error: err.callbackUnsupported ? "google_callback_unsupported" : "google_app_required", message: err.message,
      });
      if (err instanceof GoogleNotConnectedError) return res.status(403).json({ error: "google_account_unavailable" });
      if (err instanceof GoogleMailboxUnavailableError) return res.status(503).json({ error: "email_integration_unavailable", message: err.message });
      if (err instanceof GoogleDisconnectRequiredError) return res.status(409).json({ error: "google_disconnect_required", message: err.message });
      return res.status(503).json({ error: "google_sign_in_unavailable", message: "Google sign-in could not be started. Try again shortly." });
    }
  });

  router.delete("/google/connection", sensitiveRateLimit, requireRole(...CONNECT_ROLES), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user?.id) return res.status(401).json({ error: "unauthenticated" });
    try {
      await disconnectGoogle(prisma, req.user.id, deps);
      return res.status(204).send();
    } catch {
      return res.status(503).json({ error: "google_disconnect_failed" });
    }
  });

  router.get("/email/:accountId/oauth-token", sensitiveRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Role labels and forwarded identities cannot turn a person into this service.
    if (req.user?.id !== "_service:email" || !bearerIsServicePrincipal(req, "_service:email")) {
      return res.status(403).json({ error: "forbidden" });
    }
    try {
      return res.json({ accessToken: await getGoogleMailboxAccessToken(prisma, req.params.accountId, deps) });
    } catch (err) {
      if (err instanceof GoogleNotConnectedError) return res.status(409).json({ error: "google_needs_reconnect" });
      if (err instanceof GoogleTemporarilyUnavailableError) return res.status(503).json({ error: "google_temporarily_unavailable" });
      return res.status(503).json({ error: "google_token_unavailable" });
    }
  });

  return router;
}

export function createGoogleCallbackRouter(prisma: PrismaClient, options: Partial<GoogleDependencies> = {}): Router {
  const router = Router();
  const deps = googleDependencies(options);
  router.get("/google/callback", authRateLimit, async (req: Request, res) => {
    res.setHeader("Cache-Control", "no-store");
    const param = (name: string) => typeof req.query[name] === "string" ? req.query[name] as string : null;
    const cookie = req.cookies?.[GOOGLE_STATE_COOKIE];
    res.clearCookie(GOOGLE_STATE_COOKIE, { httpOnly: true, secure: true, sameSite: "lax", path: COOKIE_PATH });
    let outcome: GoogleOutcome;
    try {
      outcome = await completeGoogleConnect(prisma, {
        state: param("state"), browserState: typeof cookie === "string" ? cookie : null,
        code: param("code"), error: param("error"),
      }, deps);
    } catch {
      outcome = "failed";
    }
    // No callback parameter becomes a URL destination or reflected error text.
    return res.redirect(303, `/settings?google=${outcome}`);
  });
  return router;
}
