/**
 * ADR-013 (PR #378) — external-IdP OIDC SSO (Google Workspace + Microsoft
 * Entra). The orchestrator is the OIDC RELYING PARTY; on a successful,
 * fully-validated sign-in it ensures/links a LOCAL `User` (keyed by the
 * normalized work email, #374) and issues the SAME session cookies as
 * `/auth/login`. Mounted on the PUBLIC router (before authMiddleware) — a
 * user signing in has no session yet.
 *
 *   POST /api/sso/oidc/authorize  { provider, returnTo? } → 302 to the IdP
 *   GET  /api/sso/oidc/callback   ?code&state              → 302 to returnTo
 *
 * Security (see also sso-oidc.service / sso-login-state.service):
 *   - `state` is CSRF protection: minted at /authorize, persisted server-side
 *     (single-use, time-bound) AND mirrored into an httpOnly cookie. The
 *     callback must match BOTH (cookie === query) and then atomically consume
 *     the server-side row, so a replayed or cross-browser callback fails.
 *   - `nonce` (ID-token replay) + PKCE verifier live ONLY server-side; the
 *     callback reads them from the consumed state row, never from the client.
 *   - ID-token validation (signature via JWKS, iss, aud, exp, nonce) is
 *     delegated to openid-client inside exchangeCodeAndValidate.
 *   - We NEVER log the code, tokens, secrets, or claims.
 */
import { Router, type Request } from "express";
import { z } from "zod";

import {
  isSsoProvider,
  getOidcProviderConfig,
  buildAuthorizeRequest,
  exchangeCodeAndValidate,
  enabledSsoProviders,
  type SsoProvider,
} from "../services/sso-oidc.service.js";
import {
  createLoginState,
  consumeLoginState,
  SSO_LOGIN_STATE_TTL_SECONDS,
} from "../services/sso-login-state.service.js";
import {
  signAccessToken,
  signRefreshToken,
  registerRefreshSession,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type Role,
} from "../services/jwt.service.js";
import { createSession } from "../services/session.service.js";
import { findUserByEmail, emailWriteData } from "../services/user-directory.service.js";
import { SESSION_COOKIE_NAME, REFRESH_COOKIE_NAME } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { resolveTrustedOriginUrl } from "../lib/trusted-origin.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("sso-oidc-route");

/** Short-lived httpOnly cookie carrying the opaque `state` for the
 *  cookie-side half of the CSRF check (paired with the server-side row). */
const SSO_STATE_COOKIE = "droplet_sso_state";

const authorizeSchema = z.object({
  provider: z.string(),
  // Optional post-login landing path. Validated to a same-origin relative
  // path below so it can't become an open redirect.
  returnTo: z.string().optional(),
});

/** #374 normalization — the directory login key is trim+lowercase. SSO must
 *  resolve/create against the same canonical form or it would mint a second
 *  row for an owner who already exists under a differently-cased address. */
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Resolve `returnTo` to a SAFE same-origin path for the post-login redirect.
 *
 * The value reaches the browser via the `Location` response header, so a naive
 * `startsWith("/") && !startsWith("//")` string guard is not enough — it is
 * defeated by (a) `\` / leading-control-char normalization (`/\evil.com`,
 * `/\t//evil.com`), which the browser collapses into an off-origin authority,
 * and (b) `..` resolution that leaves the path itself authority-leading
 * (`/x/..//evil.com` → `//evil.com`).
 *
 * Hardened guard, mirroring the merged Aurora login's `safeNext`
 * (apps/web-dashboard/src/app/login/page.tsx): resolve against a sentinel
 * origin, require the resolved origin to equal the sentinel, return ONLY the
 * resolved path+search+hash, and reject a resolved path that is itself
 * protocol-relative / authority-leading. Anything else → "/".
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "/";
  // Must be an absolute path on THIS origin: a single leading "/", never "//"
  // (protocol-relative) and never a backslash-authority ("/\"). This rejects
  // bare-relative inputs (`evil.com`) and the backslash/control-char tricks
  // before they ever reach the parser.
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/";
  }
  const SENTINEL = "http://x.invalid";
  try {
    const url = new URL(value, SENTINEL);
    // A value that resolves to any origin other than the sentinel carried an
    // authority the parser un-hid (leading tab/newline + "//", e.g.
    // "/\t//evil.com") → off-origin.
    if (url.origin !== SENTINEL) return "/";
    const path = url.pathname + url.search + url.hash;
    // `..` traversal can pop the leading segment and leave the RESOLVED path
    // itself authority-leading (`/x/..//evil.com` → `//evil.com`); the browser
    // would resolve that against the real appliance origin. Reject those.
    if (path.startsWith("//") || path.startsWith("/\\")) return "/";
    return path;
  } catch {
    return "/";
  }
}

/** Local-part of an email, sanitized for use as a username seed. */
function usernameSeedFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const cleaned = local.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 48);
  return cleaned.length >= 2 ? cleaned : `sso-${cleaned}`;
}

type PrismaClient = import("@prisma/client").PrismaClient;

interface ResolvedUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** WARP-1582 — assigned custom access role at sign-in time, `null` for
   *  none. Every branch below already holds the full User row, so this
   *  costs no extra read; it rides into the access token so the chat path
   *  can skip its per-turn lookup. */
  accessRoleId: string | null;
}

/**
 * ORCH-01 — thrown when the IdP asserts an email we could otherwise act on
 * (link to / create a local account from) but does NOT assert
 * `email_verified === true`. We refuse rather than bind the caller's `sub` to
 * a row chosen by an unverified, attacker-controllable email claim. The
 * callback maps this to a distinct 401 so the failure is legible (vs the
 * "no usable email" null path).
 */
class SsoEmailUnverifiedError extends Error {
  readonly code = "SSO_EMAIL_UNVERIFIED";
  constructor() {
    super("SSO sign-in refused: the identity provider did not verify this email address.");
    this.name = "SsoEmailUnverifiedError";
  }
}

/**
 * Account-linking policy (the AC contract):
 *   1. Resolve by (provider, sub) via SsoIdentity → sign in that user
 *      (preserves User.id; emails can be reassigned at the IdP, sub can't).
 *   2. Else look up the local User by NORMALIZED email — but ONLY when the
 *      IdP asserted `email_verified === true` (ORCH-01). An unverified email
 *      is attacker-controllable on providers like entra/okta, so binding a
 *      `sub` to a row chosen by it is an account-takeover vector; we throw
 *      SsoEmailUnverifiedError instead. When verified:
 *        - found  → LINK (create an SsoIdentity pointing at it). Preserves
 *          the existing User.id; an owner who set up with a password keeps
 *          the same row and can now also SSO.
 *        - none   → CREATE a local User (role family / least privilege,
 *          isLocal, NO passwordHash — SSO-only) and link.
 *   3. No usable email → return null. We never create a login-unable row.
 *
 * NOTE: branch 1 (an already-linked (provider, sub)) is intentionally NOT
 * gated on email_verified — that link was vetted when it was first created,
 * and `sub` (not email) is its key.
 */
async function ensureLinkedUser(
  prisma: PrismaClient,
  provider: SsoProvider,
  identity: { sub: string; email?: string; emailVerified: boolean; name?: string },
): Promise<ResolvedUser | null> {
  // 1. Existing IdP identity → that user.
  const existing = await prisma.ssoIdentity.findUnique({
    where: { provider_subject: { provider, subject: identity.sub } },
    include: { user: true },
  });
  if (existing?.user) {
    // WARP (SCIM): a user the directory deactivated (active:false →
    // DEACTIVATED, soft) must not sign in via SSO either, even though the
    // SsoIdentity link still resolves. Fail closed (parity with the
    // /auth/login DEACTIVATED gate) — the row is retained for re-activate.
    if (existing.user.directoryStatus === "DEACTIVATED") {
      logger.warn({ provider, userId: existing.user.id }, "SSO sign-in rejected: directory user is deactivated");
      return null;
    }
    return {
      id: existing.user.id,
      username: existing.user.username,
      displayName: existing.user.displayName,
      role: existing.user.role as Role,
      accessRoleId: existing.user.accessRoleId ?? null,
    };
  }

  // From here we need an email to link/create. No email → can't make a
  // usable login row, so refuse (no login-unable rows).
  if (!identity.email) {
    return null;
  }
  const email = normalizeEmail(identity.email);
  if (!email) {
    return null;
  }

  // ORCH-01 — email is the linking/creation key from here on. Refuse unless
  // the IdP VERIFIED it: an unverified `email` claim is attacker-controllable
  // (e.g. self-asserted at an entra/okta tenant), so acting on it would let a
  // caller bind their `sub` to — or mint a new account on — an address they
  // don't own. Gate BOTH the link (2a) and create (2b) branches. The cookie
  // checks proved the token is authentic; only email_verified proves the
  // address belongs to the bearer.
  if (!identity.emailVerified) {
    throw new SsoEmailUnverifiedError();
  }

  // 2a. Link to an existing local user with this email.
  // WARP-233: blind-index lookup (email at rest is a dcv1 ciphertext).
  const byEmail = await findUserByEmail(prisma, email);
  if (byEmail) {
    // Same deactivation gate as the by-sub branch: never re-activate a
    // disabled directory row by silently minting a fresh SSO link to it.
    if (byEmail.directoryStatus === "DEACTIVATED") {
      logger.warn({ provider, userId: byEmail.id }, "SSO sign-in rejected: directory user is deactivated");
      return null;
    }
    await prisma.ssoIdentity.create({
      data: { userId: byEmail.id, provider, subject: identity.sub, email },
    });
    return {
      id: byEmail.id,
      username: byEmail.username,
      displayName: byEmail.displayName,
      role: byEmail.role as Role,
      accessRoleId: byEmail.accessRoleId ?? null,
    };
  }

  // 2b. Create a new directory user (least privilege, SSO-only) and link.
  const displayName = identity.name?.trim() || email;
  const created = await prisma.user.create({
    data: {
      username: usernameSeedFromEmail(email),
      displayName,
      ...emailWriteData(email),
      role: "family",
      isLocal: true,
      // No passwordHash — this account authenticates via SSO only. The
      // /auth/login route fails closed on a null hash, so this row is never
      // password-loginable (and never "login-unable" — SSO works).
    },
  });
  await prisma.ssoIdentity.create({
    data: { userId: created.id, provider, subject: identity.sub, email },
  });
  return {
    id: created.id,
    username: created.username,
    displayName: created.displayName,
    role: created.role as Role,
    accessRoleId: created.accessRoleId ?? null,
  };
}

function isHttps(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/**
 * Reconstruct the callback URL handed to openid-client's
 * `authorizationCodeGrant`.
 *
 * PR #486 review finding 2: the origin previously came from `req.headers.host`
 * verbatim. openid-client extracts the authorization-response query params
 * (code/state/iss) from this URL and validates state/nonce/PKCE against the
 * server-side row — the HOST is NOT compared against the redirect_uri (that is
 * the provider-config `redirectUri`). So we source the origin from the shared
 * trusted-origin resolver (a forged X-Forwarded-Host is never reflected) while
 * preserving `req.originalUrl`'s path + query exactly, which is where the
 * validated params live. Exported for unit testing.
 */
export async function buildSsoCallbackUrl(req: Request): Promise<URL> {
  const origin = await resolveTrustedOriginUrl(req);
  // origin has no trailing slash; req.originalUrl always begins with "/".
  return new URL(`${origin}${req.originalUrl}`);
}

export function createSsoRouter(prisma?: PrismaClient): Router {
  const router = Router();

  // ── Runtime SSO discovery (WARP-629) ──
  // The Aurora login is LOCAL-FIRST, SSO OPTIONAL: it must render only the
  // identity providers THIS appliance has actually configured, instead of a
  // fixed build-time set baked identically into every image. This is the
  // single source of truth the login page reads.
  //
  // PUBLIC (before authMiddleware, like /authorize + /callback) — the login
  // page has no session yet. Reads env-derived config only (no `prisma`, no
  // session), so it answers even with no directory wired or mid-migration.
  // Body is provider IDs ONLY — never issuer / client-id / client-secret /
  // redirect-uri (the IDs are the same information the rendered buttons
  // already reveal; nothing sensitive crosses the wire). `no-store` so an
  // operator's `.env` edit + restart isn't served from a stale cache.
  router.get("/sso/oidc/providers", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ providers: enabledSsoProviders() });
  });

  // ── Begin SSO: redirect to the IdP authorize URL ──
  router.post("/sso/oidc/authorize", async (req, res, next) => {
    try {
      const parsed = authorizeSchema.safeParse(req.body);
      if (!parsed.success || !isSsoProvider(parsed.data.provider)) {
        res.status(400).json({ error: "Unknown or unsupported SSO provider" });
        return;
      }
      if (!prisma) {
        // No directory to link into — fail closed (mirrors /auth/login).
        logger.error("SSO authorize: prisma not wired; cannot persist login state");
        res.status(500).json({ error: "SSO is not available", code: "SSO_NO_PRISMA" });
        return;
      }
      const provider = parsed.data.provider;

      // Fail closed if the provider isn't fully configured — no half-built
      // authorize URL, no button that 500s mid-flow.
      if (!getOidcProviderConfig(provider)) {
        res.status(400).json({
          error: `SSO for "${provider}" is not configured on this appliance`,
          code: "SSO_PROVIDER_NOT_CONFIGURED",
        });
        return;
      }

      const returnTo = safeReturnTo(parsed.data.returnTo);
      const { authorizeUrl, state, nonce, codeVerifier } = await buildAuthorizeRequest(provider);

      // Persist the single-use, time-bound state server-side.
      await createLoginState(prisma, {
        provider,
        state,
        nonce,
        codeVerifier,
        returnTo,
        ttlSeconds: SSO_LOGIN_STATE_TTL_SECONDS,
      });

      // Mirror the opaque state into an httpOnly cookie for the cookie-side
      // half of the CSRF check. Same maxAge as the server-side row.
      res.cookie(SSO_STATE_COOKIE, state, {
        httpOnly: true,
        secure: isHttps(req),
        sameSite: "lax",
        path: "/api/sso",
        maxAge: SSO_LOGIN_STATE_TTL_SECONDS * 1000,
      });

      res.redirect(authorizeUrl);
    } catch (err) {
      next(err);
    }
  });

  // ── Finish SSO: validate, link/create the local user, issue session ──
  router.get("/sso/oidc/callback", async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(500).json({ error: "SSO is not available", code: "SSO_NO_PRISMA" });
        return;
      }

      const queryState = typeof req.query.state === "string" ? req.query.state : null;
      const cookieState = req.cookies?.[SSO_STATE_COOKIE] ?? null;

      // Clear the CSRF cookie regardless of outcome — it's single-use.
      res.clearCookie(SSO_STATE_COOKIE, { path: "/api/sso" });

      // CSRF: the cookie-side state must match the query state. A callback
      // that didn't originate from THIS browser's /authorize fails here.
      if (!queryState || !cookieState || queryState !== cookieState) {
        res.status(401).json({ error: "Invalid SSO state" });
        return;
      }

      // Single-use server-side claim: rejects unknown / replayed / expired.
      const loginState = await consumeLoginState(prisma, queryState);
      if (!loginState) {
        res.status(401).json({ error: "Invalid or expired SSO state" });
        return;
      }

      const code = typeof req.query.code === "string" ? req.query.code : null;
      if (!code) {
        res.status(400).json({ error: "Missing authorization code" });
        return;
      }

      const provider = loginState.provider;
      if (!isSsoProvider(provider)) {
        // Defensive — a persisted row should always carry a valid provider.
        res.status(400).json({ error: "Unsupported SSO provider" });
        return;
      }

      // Reconstruct the callback URL openid-client extracts the response
      // params from. Origin comes from the canonical trusted origin (not a
      // forged Host header); the path + query — where code/state live and are
      // validated — are preserved verbatim. (PR #486 finding 2.)
      const currentUrl = await buildSsoCallbackUrl(req);

      // Exchange + validate the ID token (signature/iss/aud/exp + nonce +
      // state + PKCE). Any failure throws → 401, no session.
      let identity: { sub: string; email?: string; emailVerified: boolean; name?: string };
      try {
        identity = await exchangeCodeAndValidate(provider, currentUrl, {
          expectedNonce: loginState.nonce,
          codeVerifier: loginState.codeVerifier,
          expectedState: queryState,
        });
      } catch (err) {
        // Log the failure WITHOUT the code/tokens/claims.
        logger.warn({ provider, err: (err as Error).message }, "SSO ID-token validation failed");
        res.status(401).json({ error: "SSO sign-in failed" });
        return;
      }

      let user: ResolvedUser | null;
      try {
        user = await ensureLinkedUser(prisma, provider, identity);
      } catch (err) {
        // ORCH-01 — the IdP returned an email we won't act on because it
        // isn't verified. Refuse with a distinct code rather than linking
        // the caller's sub to an account chosen by an unverified email.
        if (err instanceof SsoEmailUnverifiedError) {
          logger.warn(
            { provider },
            "SSO sign-in refused: IdP did not assert email_verified for a linkable email",
          );
          res.status(401).json({ error: "SSO sign-in failed", code: err.code });
          return;
        }
        throw err;
      }
      if (!user) {
        // No usable email in a valid token → we won't mint a login-unable row.
        logger.warn({ provider }, "SSO sign-in rejected: ID token had no usable email");
        res.status(401).json({ error: "SSO sign-in failed" });
        return;
      }

      // Issue the SAME session cookies as /auth/login. WARP-247: record
      // first (cap + idle/absolute clocks), sid into both tokens, and index
      // the refresh token (WARP-116 — the SSO path previously skipped
      // registerRefreshSession).
      const { sid } = await createSession({ id: user.id, role: user.role });
      const accessToken = signAccessToken({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        sid,
        // WARP-1582 — the resolved row's custom access role (null = none).
        accessRoleId: user.accessRoleId,
      });
      const refreshToken = signRefreshToken({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        sid,
      });
      await registerRefreshSession(user.id, refreshToken);
      const https = isHttps(req);
      res.cookie(SESSION_COOKIE_NAME, accessToken, {
        httpOnly: true,
        secure: https,
        sameSite: "lax",
        path: "/",
        maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
      });
      res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        secure: https,
        sameSite: "lax",
        path: "/api/auth",
        maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
      });

      // Audit row — mirrors /auth/login's success shape. Never includes the
      // code or tokens; `provider` is the SSO source.
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "log-in",
        what: `${user.displayName} signed in via ${provider} SSO`,
        sub: `${user.role} • ${provider}`,
        refs: { outcome: "success", userId: user.id, username: user.username, role: user.role, provider },
        actor: { type: "user", id: user.id },
      });

      res.redirect(safeReturnTo(loginState.returnTo));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
