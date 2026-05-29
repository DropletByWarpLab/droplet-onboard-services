/**
 * Plane PM integration routes — OIDC IdP.
 *
 * WARP-505 — orchestrator is a minimal OIDC IdP for the embedded Plane
 * PM stack per spec WARP-498 OQ6 (resolved 2026-05-28). Plane is the
 * relying party; users authenticate via Plane's `/auth/oidc/` flow,
 * which round-trips through the 5 endpoints below.
 *
 * Mount: app.use(createPmRouter()) — public side (BEFORE authMiddleware).
 * Each route handles its own auth: /authorize verifies the dashboard
 * session cookie inline; /token and /userinfo verify client credentials
 * or the bearer-issued access token.
 *
 * Future tickets land here:
 *   WARP-507 — POST /api/pm/onboard (seed first workspace)
 *   WARP-511 — POST /api/pm/webhook (signed Plane → orchestrator events)
 */

import { randomBytes } from "node:crypto";

import { Router, type Request, type Response, type NextFunction } from "express";
import pino from "pino";

import { config } from "../config.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  oidcIssuer,
  publicJwk,
  signAccessToken,
  signIdToken,
  SUPPORTED_GRANT_TYPES,
  SUPPORTED_ID_TOKEN_ALGS,
  SUPPORTED_RESPONSE_TYPES,
  SUPPORTED_SCOPES,
  verifyAccessToken,
  verifyClientSecret,
} from "../services/pm-oidc.service.js";
import {
  consumeOidcCode,
  storeOidcCode,
} from "../services/pm-session.service.js";
import { verifyAccessToken as verifyDashboardJwt } from "../services/jwt.service.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";

const logger = pino({ name: "pm-oidc-route" });

export function createPmRouter(): Router {
  const router = Router();

  /**
   * GET /api/pm/oidc/.well-known/openid-configuration
   *
   * OIDC discovery document. Plane fetches this once at the start of the
   * configured-IdP flow and caches the endpoint URLs.
   */
  router.get(
    "/api/pm/oidc/.well-known/openid-configuration",
    (_req: Request, res: Response) => {
      const iss = oidcIssuer();
      res.json({
        issuer: iss,
        authorization_endpoint: `${iss}/authorize`,
        token_endpoint: `${iss}/token`,
        userinfo_endpoint: `${iss}/userinfo`,
        jwks_uri: `${iss}/.well-known/jwks.json`,
        response_types_supported: SUPPORTED_RESPONSE_TYPES,
        grant_types_supported: SUPPORTED_GRANT_TYPES,
        id_token_signing_alg_values_supported: SUPPORTED_ID_TOKEN_ALGS,
        scopes_supported: SUPPORTED_SCOPES,
        subject_types_supported: ["public"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        claims_supported: ["sub", "email", "first_name", "last_name"],
      });
    },
  );

  /**
   * GET /api/pm/oidc/.well-known/jwks.json
   *
   * Public key set. Plane fetches this to verify ID-token signatures.
   * Single key for V1; rotation is a follow-up ticket.
   */
  router.get(
    "/api/pm/oidc/.well-known/jwks.json",
    (_req: Request, res: Response) => {
      res.json({ keys: [publicJwk()] });
    },
  );

  /**
   * GET /api/pm/oidc/authorize
   *
   * Auth endpoint. Validates the dashboard session cookie (the user is
   * already logged into Droplet); if missing, redirects to the dashboard
   * login with `return_to` set so the user lands back here after login.
   *
   * On success: mints an authorization code, stashes it in Redis, and
   * 302s to Plane's `redirect_uri` with `code` + `state`.
   *
   * No PKCE enforcement for V1 — Plane's OIDC client config controls
   * whether PKCE is required.
   */
  router.get(
    "/api/pm/oidc/authorize",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const clientId = req.query.client_id as string | undefined;
        const redirectUri = req.query.redirect_uri as string | undefined;
        const responseType = req.query.response_type as string | undefined;
        const scope = (req.query.scope as string | undefined) ?? "openid email profile";
        const state = req.query.state as string | undefined;
        const nonce = (req.query.nonce as string | undefined) ?? "";
        const codeChallenge = req.query.code_challenge as string | undefined;
        const codeChallengeMethod = req.query.code_challenge_method as
          | "S256"
          | "plain"
          | undefined;

        if (clientId !== config.DROPLET_PM_OIDC_CLIENT_ID) {
          return res.status(400).json({ error: "invalid_client" });
        }
        if (!redirectUri) {
          return res.status(400).json({ error: "invalid_request", error_description: "redirect_uri required" });
        }
        if (responseType !== "code") {
          return res.status(400).json({ error: "unsupported_response_type" });
        }
        if (!scope.split(" ").includes("openid")) {
          return res.status(400).json({ error: "invalid_scope" });
        }

        // Verify dashboard session — read cookie directly because this
        // router is mounted BEFORE authMiddleware.
        const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
        const claims = sessionToken ? verifyDashboardJwt(sessionToken) : null;
        if (!claims) {
          // No session — bounce to dashboard login with return_to.
          const returnTo = encodeURIComponent(
            `/api/pm/oidc/authorize?${new URLSearchParams(
              req.query as Record<string, string>,
            ).toString()}`,
          );
          return res.redirect(302, `/login?return_to=${returnTo}`);
        }

        // Mint code, stash, redirect.
        const code = randomBytes(32).toString("hex");
        await storeOidcCode(code, {
          userId: claims.sub,
          nonce,
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
        });

        const url = new URL(redirectUri);
        url.searchParams.set("code", code);
        if (state) url.searchParams.set("state", state);
        return res.redirect(302, url.toString());
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * POST /api/pm/oidc/token
   *
   * Token endpoint. Plane presents the authorization code + client
   * credentials and gets an ID token + access token.
   *
   * Supports `client_secret_post` and `client_secret_basic` per the
   * discovery doc.
   */
  router.post(
    "/api/pm/oidc/token",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Record<string, string | undefined>;
        const grantType = body.grant_type;
        const code = body.code;
        const clientId = body.client_id ?? extractBasicAuthClientId(req);
        const clientSecret = body.client_secret ?? extractBasicAuthSecret(req);

        if (grantType !== "authorization_code") {
          return res.status(400).json({ error: "unsupported_grant_type" });
        }
        if (clientId !== config.DROPLET_PM_OIDC_CLIENT_ID) {
          return res.status(401).json({ error: "invalid_client" });
        }
        if (!clientSecret || !verifyClientSecret(clientSecret)) {
          return res.status(401).json({ error: "invalid_client" });
        }
        if (!code) {
          return res.status(400).json({ error: "invalid_request", error_description: "code required" });
        }

        const payload = await consumeOidcCode(code);
        if (!payload) {
          return res
            .status(400)
            .json({ error: "invalid_grant", error_description: "code expired or already used" });
        }

        // For V1 we surface a minimal identity claim set on the ID token.
        // Email comes from the dashboard JWT's `sub` mapping — the
        // existing User model carries `username` (email-shaped) and
        // optionally display name; resolve via Prisma when WARP-505b
        // wires the user lookup. For now we use sub directly and let
        // Plane derive a display name from the email.
        const idToken = signIdToken({
          sub: payload.userId,
          email: payload.userId,
          nonce: payload.nonce,
        });
        const accessToken = signAccessToken(payload.userId);

        logger.info(
          { sub: payload.userId, event: "oidc_token_issued" },
          "issued OIDC tokens",
        );

        return res.json({
          access_token: accessToken,
          token_type: "Bearer",
          // expires_in describes the access_token lifetime per RFC 6749
          // §5.1 — NOT the ID token's. ID token carries its own `exp`.
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
          id_token: idToken,
          scope: "openid email profile",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * GET /api/pm/oidc/userinfo
   *
   * Userinfo endpoint. Plane calls this with the access token to get the
   * authenticated user's claims.
   */
  router.get(
    "/api/pm/oidc/userinfo",
    (req: Request, res: Response) => {
      const auth = req.header("authorization") ?? "";
      const match = /^Bearer (.+)$/.exec(auth);
      if (!match) {
        return res.status(401).json({ error: "invalid_token" });
      }
      const claims = verifyAccessToken(match[1]);
      if (!claims) {
        return res.status(401).json({ error: "invalid_token" });
      }
      return res.json({
        sub: claims.sub,
        email: claims.sub,
        // first_name / last_name resolved from User table in WARP-505b
        // follow-up; for V1 leave Plane to derive from email.
      });
    },
  );

  return router;
}

function extractBasicAuthClientId(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  return decoded.split(":")[0];
}

function extractBasicAuthSecret(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  return decoded.split(":")[1];
}
