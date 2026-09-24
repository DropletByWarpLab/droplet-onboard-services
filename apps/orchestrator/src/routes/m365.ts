/**
 * WARP-2115 / ADR-041 — the Microsoft 365 connection control plane.
 *
 *   GET    /api/m365/connection          The signed-in person's own link:
 *                                        state, which account, which app,
 *                                        granted scopes, last refresh — and the
 *                                        redirect URI their app registration
 *                                        must list. Never any token material.
 *   POST   /api/m365/connect             Begin an authorization-code sign-in
 *                                        (WARP-2704, the primary path). Returns
 *                                        Microsoft's sign-in URL for the
 *                                        browser to open, and sets the httpOnly
 *                                        state cookie the callback checks.
 *   POST   /api/m365/connect/device-code Begin a device-code sign-in — the
 *                                        fallback. Every tenant created since
 *                                        2026-07-01 blocks it by default.
 *   DELETE /api/m365/connection          Unlink and PURGE the stored token.
 *
 *   GET    /api/m365/callback            PUBLIC (createM365CallbackRouter):
 *                                        Microsoft's redirect back to the box.
 *
 * Both connect routes take `{ clientId, tenantId }` — the customer's OWN Entra
 * app registration (WARP-2705). Omitted, the connection's stored app is
 * reused; there is no box-wide app to fall back to.
 *
 * **Every authenticated route is scoped to the requester's own connection.**
 * There is no `:userId` parameter anywhere by design: delegated authorization
 * means one person's Microsoft link is theirs, and an admin must not be able to
 * drive (or read the state of) someone else's mailbox connection through this
 * API.
 *
 * `connect` is deliberately not restricted to owner/admin. Under ADR-041 a
 * cloud connector is enabled per person — each staff member links their own
 * account, and the box reads Microsoft *as them*. Gating this to admins would
 * either block ordinary users from the feature or push the design toward
 * tenant-wide application permissions, which ADR-041 rules out.
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";

import { requireRole } from "../middleware/auth.js";
import { authRateLimit, sensitiveRateLimit } from "../middleware/rate-limit.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { trustedOriginUrl } from "../lib/trusted-origin.js";
import {
  beginAuthCodeConnect,
  beginDeviceCodeConnect,
  completeAuthCodeConnect,
  disconnect,
  getConnectionView,
  M365AppRequiredError,
  type EntraAppRegistration,
  type EntraClient,
} from "../services/m365/m365-auth.service.js";
import { createEntraClient } from "../services/m365/entra-client.js";
import {
  classifyAuthFailure,
  parseAppRegistration,
  redactAuthError,
  PENDING_FLOW_TTL_MS,
} from "../services/m365/state.js";

type AuthedRequest = {
  user?: { id?: string; username?: string; role?: string };
};

/** Everyone who can hold a mailbox can link one. Guests and service principals
 *  cannot — they have no business connecting a business's Microsoft account. */
const CONNECT_ROLES = ["owner", "admin", "family"] as const;

/** Where Microsoft sends the browser back. The owner registers exactly this
 *  URL (on the box's own origin) on their app registration. */
export const M365_CALLBACK_PATH = "/api/m365/callback";

/** The httpOnly cookie that ties a callback to the browser that pressed
 *  Connect. Scoped to /api/m365 so no other route ever sees it. */
export const M365_STATE_COOKIE = "droplet_m365_state";
const M365_COOKIE_PATH = "/api/m365";

/** Where the callback lands the person, with the outcome for the page to say. */
const M365_LANDING_PATH = "/integrations";

function isHttps(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/**
 * The app a connect request names, if it names one. `{ ok: true, app:
 * undefined }` means "reuse the stored app"; naming only one of the two ids is
 * refused rather than half-applied.
 */
function appFromBody(
  body: unknown,
): { ok: true; app: EntraAppRegistration | undefined } | { ok: false; field: string; message: string } {
  const { clientId, tenantId } = (body ?? {}) as { clientId?: unknown; tenantId?: unknown };
  if (clientId === undefined && tenantId === undefined) return { ok: true, app: undefined };
  const parsed = parseAppRegistration({ clientId, tenantId });
  return parsed.ok ? parsed : { ok: false, field: parsed.field, message: parsed.reason };
}

/** 400 for a sign-in the device cannot start without the owner's app. */
function appRequired(res: Response, err: M365AppRequiredError) {
  return res.status(400).json({ error: "m365_app_required", message: err.message });
}

/** A failure to START a sign-in, answered in the terms the dashboard needs. */
function startFailure(res: Response, err: unknown) {
  const failure = (err ?? {}) as { errorCode?: string; errorMessage?: string };
  const kind = classifyAuthFailure(failure);
  // A tenant that blocks device code lands here (AADSTS50199 → ERROR). It is a
  // real, expected configuration answer — surfaced so the dashboard can steer
  // the person to the browser sign-in instead of just failing.
  return res.status(kind === "ERROR" ? 502 : 409).json({
    error: kind === "ERROR" ? "m365_sign_in_unavailable" : "m365_needs_reconnect",
    message: redactAuthError(failure),
  });
}

/** WARP-2285 — the request half of the consent record. The SERVICE records the
 *  outcome; this records that a person deliberately started a sign-in, which is
 *  the gesture ADR-041 §2 treats as the consent itself. No state, no code, no
 *  device code: the activity log is readable and exportable. */
async function auditSignInStarted(
  req: Request,
  userId: string,
  method: "authorization_code" | "device_code",
): Promise<void> {
  await recordActivity({
    kind: "auth",
    severity: "info",
    sourceIcon: "cloud",
    what: "Microsoft 365 sign-in started",
    sub: "PENDING_CONSENT",
    actor: actorFromRequest(req as never),
    refs: { connector: "m365", userId, state: "PENDING_CONSENT", method },
  });
}

export function createM365Router(
  prisma: PrismaClient,
  entra: EntraClient = createEntraClient(),
): Router {
  const router = Router();

  router.get(
    "/m365/connection",
    requireRole(...CONNECT_ROLES),
    async (req, res) => {
      const userId = (req as AuthedRequest).user?.id;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      try {
        const view = await getConnectionView(prisma, userId);
        return res.json({
          ...view,
          // The exact URL the owner adds to their app registration. Built from
          // the box's host-validated origin (never a forged Host header), the
          // same origin the connect route will hand to Microsoft.
          redirectUri: await trustedOriginUrl(req, M365_CALLBACK_PATH),
        });
      } catch {
        // Without this an async rejection leaves the request hanging rather
        // than answering — the connection card would spin forever.
        return res.status(500).json({ error: "m365_status_unavailable" });
      }
    },
  );

  router.post(
    "/m365/connect",
    // CodeQL js/missing-rate-limiting — each call mints a sign-in and rewrites
    // the connection row; sensitive preset.
    sensitiveRateLimit,
    requireRole(...CONNECT_ROLES),
    async (req, res) => {
      const userId = (req as AuthedRequest).user?.id;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      const requested = appFromBody(req.body);
      if (!requested.ok) {
        return res
          .status(400)
          .json({ error: "invalid_app_registration", field: requested.field, message: requested.message });
      }

      try {
        const redirectUri = await trustedOriginUrl(req, M365_CALLBACK_PATH);
        const started = await beginAuthCodeConnect(prisma, entra, userId, {
          app: requested.app,
          redirectUri,
        });

        res.cookie(M365_STATE_COOKIE, started.state, {
          httpOnly: true,
          secure: isHttps(req),
          // Lax, not Strict: the callback is a top-level GET navigation FROM
          // login.microsoftonline.com, which Strict would strip the cookie from.
          sameSite: "lax",
          path: M365_COOKIE_PATH,
          maxAge: PENDING_FLOW_TTL_MS,
        });
        await auditSignInStarted(req, userId, "authorization_code");

        return res.json({ authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt });
      } catch (err) {
        if (err instanceof M365AppRequiredError) return appRequired(res, err);
        return startFailure(res, err);
      }
    },
  );

  router.post(
    "/m365/connect/device-code",
    sensitiveRateLimit,
    requireRole(...CONNECT_ROLES),
    async (req, res) => {
      const userId = (req as AuthedRequest).user?.id;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      const requested = appFromBody(req.body);
      if (!requested.ok) {
        return res
          .status(400)
          .json({ error: "invalid_app_registration", field: requested.field, message: requested.message });
      }

      try {
        const started = await beginDeviceCodeConnect(prisma, entra, userId, { app: requested.app });
        // After `beginDeviceCodeConnect`, so a row is written only once
        // Microsoft has actually issued a code — never for an attempt that
        // failed before it began.
        await auditSignInStarted(req, userId, "device_code");

        return res.status(202).json({
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          expiresAt: started.expiresAt,
          message: started.message,
        });
      } catch (err) {
        if (err instanceof M365AppRequiredError) return appRequired(res, err);
        return startFailure(res, err);
      }
    },
  );

  router.delete(
    "/m365/connection",
    requireRole(...CONNECT_ROLES),
    async (req, res) => {
      const userId = (req as AuthedRequest).user?.id;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      try {
        await disconnect(prisma, userId);
        return res.status(204).send();
      } catch {
        // Answer rather than hang. The caller can retry; nothing is left in a
        // half-disconnected state because disconnect's write is a single update.
        return res.status(500).json({ error: "m365_disconnect_failed" });
      }
    },
  );

  return router;
}

/**
 * WARP-2704 — Microsoft's redirect back to the box. PUBLIC: mounted before
 * authMiddleware, like /sso/oidc/callback, because a Microsoft sign-in with MFA
 * or an admin's consent can outlast the 15-minute access token, and a
 * callback that 401'd would strand a completed consent.
 *
 * It is safe without a session because the service identifies the person by
 * the flow alone: the query `state` must match the httpOnly cookie set on this
 * browser at connect, the row is found by the state's hash and claimed once,
 * and the PKCE verifier never left the box. An unknown or mismatched state
 * touches no row.
 *
 * Always answers with a redirect to the dashboard carrying `?m365=<outcome>`
 * — never with JSON, since a person's browser is what lands here.
 */
export function createM365CallbackRouter(
  prisma: PrismaClient,
  entra: EntraClient = createEntraClient(),
): Router {
  const router = Router();

  // CodeQL js/missing-rate-limiting — a public code-exchange path; same
  // posture as /sso/oidc/callback.
  router.get("/m365/callback", authRateLimit, async (req, res) => {
    const param = (name: string): string | null =>
      typeof req.query[name] === "string" ? (req.query[name] as string) : null;
    const browserState = (req.cookies?.[M365_STATE_COOKIE] as string | undefined) ?? null;

    // Single-use either way.
    res.clearCookie(M365_STATE_COOKIE, { path: M365_COOKIE_PATH });

    let outcome: string;
    try {
      outcome = await completeAuthCodeConnect(prisma, entra, {
        state: param("state"),
        browserState,
        code: param("code"),
        error: param("error"),
        errorDescription: param("error_description"),
      });
    } catch {
      outcome = "failed";
    }
    // A fixed same-origin path and a closed set of outcomes — nothing from the
    // query is reflected into the Location header.
    return res.redirect(303, `${M365_LANDING_PATH}?m365=${outcome}`);
  });

  return router;
}
