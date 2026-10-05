/**
 * WARP-2115 / ADR-041 — the Microsoft 365 connection control plane.
 *
 *   GET    /api/m365/connection          The signed-in person's own link:
 *                                        state, which account, which app,
 *                                        granted scopes, last refresh — and the
 *                                        redirect URI their app registration
 *                                        must list. Never any token material.
 *                                        WARP-3538: plus `sharePoint { enabled,
 *                                        granted, needsConsent }` — what the
 *                                        person chose, whether Microsoft has
 *                                        allowed it, whether they must act.
 *   PUT    /api/m365/sharepoint          `{ enabled }` — the person's own
 *                                        SharePoint switch (WARP-3538). ON
 *                                        records the choice on a CONNECTED
 *                                        link (409 otherwise) and asks
 *                                        Microsoft for nothing; OFF deletes the
 *                                        list of SharePoint files the box kept,
 *                                        in one transaction. Answers with the
 *                                        connection view.
 *   GET    /api/m365/sync-status         How far the box has got reading the
 *                                        person's Microsoft 365 (WARP-3538):
 *                                        per workload, their OneDrive, and each
 *                                        SharePoint library — file counts, last
 *                                        read, state. Names decrypted here; never
 *                                        a token or a delta link.
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
 * Both connect routes accept `{ clientId, tenantId }` — the customer's OWN
 * Entra app (WARP-2705). Omitted, the connection's stored app is reused, then
 * the owner-configured organisation app (WARP-3788). Each person's grant and
 * token cache remain separate.
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
import { z } from "zod";

import { requireRole } from "../middleware/auth.js";
import { authRateLimit, sensitiveRateLimit, standardRateLimit } from "../middleware/rate-limit.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { trustedOriginUrl } from "../lib/trusted-origin.js";
import { createLogger } from "../lib/logger.js";
import {
  beginAuthCodeConnect,
  beginDeviceCodeConnect,
  completeAuthCodeConnect,
  disconnect,
  getConnectionView,
  M365AppRequiredError,
  setSharePointEnabled,
  setCalendarEnabled,
  type EntraAppRegistration,
  type EntraClient,
} from "../services/m365/m365-auth.service.js";
import { getSyncStatus } from "../services/m365/sync-status.service.js";
import { createEntraClient } from "../services/m365/entra-client.js";
import { getMicrosoftApp } from "../services/account-provider-setup.service.js";
import { setMicrosoftMailEnabled, MicrosoftMailboxConflictError } from "../services/m365/mail-settings.service.js";
import {
  classifyAuthFailure,
  parseAppRegistration,
  redactAuthError,
  PENDING_FLOW_TTL_MS,
} from "../services/m365/state.js";

const logger = createLogger("m365-route");

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

/** Where the callback lands the person, with the outcome for the page to say:
 *  Settings, where each person's own Microsoft 365 card lives (WARP-3056).
 *  Not the integrations hub — that is owner/admin and box-level, and this
 *  connection is per person, family included. */
const M365_LANDING_PATH = "/settings";

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

/**
 * WARP-3538 — the body of `PUT /m365/sharepoint`. STRICT: a key this route does
 * not know is refused, not ignored. The person is the session — there is no
 * `userId` here to honour, and a body that tries to name one is a request this
 * route does not understand rather than one to quietly act on half of.
 */
const sharePointBodySchema = z.object({ enabled: z.boolean() }).strict();

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

  router.put("/m365/mail", sensitiveRateLimit, requireRole(...CONNECT_ROLES), async (req, res) => {
    const userId = (req as AuthedRequest).user?.id;
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    const body = sharePointBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "invalid_request" });
    try {
      const before = await prisma.m365Connection.findUnique({ where: { userId }, select: { mailEnabled: true } });
      if (!await setMicrosoftMailEnabled(prisma, userId, body.data.enabled, entra)) return res.status(409).json({ error: "m365_not_connected", message: "Connect Outlook first, then turn on email import." });
      if (body.data.enabled !== (before?.mailEnabled === true)) await recordActivity({ kind: "auth", severity: "info", sourceIcon: "cloud",
        what: body.data.enabled ? "Outlook email import enabled" : "Outlook email import disabled", sub: body.data.enabled ? "WAITING" : "DISCONNECTED",
        actor: actorFromRequest(req as never), refs: { connector: "m365", userId, mailEnabled: body.data.enabled } });
      return res.json(await getConnectionView(prisma, userId));
    } catch (error) {
      if (error instanceof MicrosoftMailboxConflictError || (error as { code?: string })?.code === "P2002") return res.status(409).json({ error: "mailbox_conflict", message: "This email address already has a mailbox in Droplet. Remove that mailbox before importing it through Outlook." });
      return res.status(503).json({ error: "m365_mail_update_failed", message: "The Outlook email setting could not be changed. Reload its status and try again." });
    }
  });

  router.put("/m365/calendar", sensitiveRateLimit, requireRole(...CONNECT_ROLES), async (req, res) => {
    const userId = (req as AuthedRequest).user?.id;
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    const body = sharePointBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "invalid_request" });
    try {
      const result = await setCalendarEnabled(prisma, userId, body.data.enabled);
      if (!result.ok) return res.status(409).json({ error: "m365_not_connected", message: "Connect Outlook first, then turn on calendar import." });
      return res.json(result.view);
    } catch {
      return res.status(503).json({ error: "m365_calendar_update_failed", message: "The Outlook calendar setting could not be changed. Reload its status and try again." });
    }
  });

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
          configured: !!view.app || !!(await getMicrosoftApp(prisma)),
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

  router.put(
    "/m365/sharepoint",
    // CodeQL js/missing-rate-limiting — a mutation that, switched off, deletes
    // rows; sensitive preset, as the connect routes.
    sensitiveRateLimit,
    requireRole(...CONNECT_ROLES),
    async (req, res) => {
      const userId = (req as AuthedRequest).user?.id;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      const body = sharePointBodySchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: "invalid_request", details: body.error.flatten() });
      }

      try {
        const result = await setSharePointEnabled(prisma, userId, body.data.enabled);
        if (!result.ok) {
          // There is no live Microsoft account to ask for the scope on. The
          // switch is offered once the person is connected, so this is a stale
          // card or a hand-made request — answered, and nothing written.
          return res.status(409).json({
            error: "m365_not_connected",
            message: "Connect Microsoft 365 first, then turn on SharePoint.",
          });
        }
        return res.json(result.view);
      } catch (err) {
        // The transaction rolled back, so nothing is half-done; the person can
        // press it again. Answered rather than left to hang, and the error is
        // logged here, never echoed — a database error names hosts and queries.
        logger.error({ err, userId }, "m365 sharepoint switch failed");
        return res.status(500).json({ error: "m365_sharepoint_failed" });
      }
    },
  );

  router.get(
    "/m365/sync-status",
    standardRateLimit,
    requireRole(...CONNECT_ROLES),
    async (req, res) => {
      const userId = (req as AuthedRequest).user?.id;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      try {
        return res.json(await getSyncStatus(prisma, userId));
      } catch (err) {
        // Without this an async rejection leaves the request hanging — the card's
        // status poll would never settle.
        logger.error({ err, userId }, "m365 sync status failed");
        return res.status(500).json({ error: "m365_sync_status_unavailable" });
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
