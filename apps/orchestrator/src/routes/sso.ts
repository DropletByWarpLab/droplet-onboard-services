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
 * Native handoff (RFC 8252 loopback / private-use scheme + PKCE) for the
 * native Windows client, which has no WebView to carry the state cookie. The
 * box stays the confidential OIDC client and the IdP still redirects to the
 * box's own callback, so the IdP-registered redirect URI is unchanged
 * (ADR-016); the handoff is a second, box-local leg:
 *
 *   POST /api/sso/oidc/native/begin
 *        { provider, redirectUri, codeChallenge, codeChallengeMethod:"S256" }
 *        → 200 { authorizeUrl }  (no cookie, no 302)
 *   GET  /api/sso/oidc/callback   NATIVE row → no cookie check, no session
 *        cookies; 302 to redirectUri?code=<one-time handoff>&state=<state>
 *   POST /api/sso/oidc/native/token { code, codeVerifier }
 *        → the /auth/login?return=body JSON body
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
 *   - Native leg: the explicit `flowKind` column on the state row decides the
 *     branch, so a browser flow can never be turned into a handoff. State
 *     stays single-use and server-side; the handoff code is 32 random bytes,
 *     stored as sha256 only, lives 60 s, is redeemable once, and is useless
 *     without the app's PKCE verifier.
 *   - We NEVER log the code, tokens, secrets, or claims.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";

import {
  isSsoProvider,
  getOidcProviderConfig,
  buildAuthorizeRequest,
  exchangeCodeAndValidate,
  enabledSsoProviders,
  isGoogleHostedDomainAllowed,
  type SsoProvider,
  type ValidatedIdentity,
} from "../services/sso-oidc.service.js";
import {
  createLoginState,
  consumeLoginState,
  peekLoginState,
  setHandoff,
  consumeHandoff,
  SSO_LOGIN_STATE_TTL_SECONDS,
  SSO_NATIVE_HANDOFF_TTL_SECONDS,
} from "../services/sso-login-state.service.js";
import type { Role } from "../services/jwt.service.js";
import {
  issueSessionTokens,
  sessionTokenBody,
  setSessionCookies,
} from "../services/session-mint.js";
import { checkLoginSecondFactor } from "../services/login-second-factor.service.js";
import { findUserByEmail, emailWriteData } from "../services/user-directory.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { resolveTrustedOriginUrl } from "../lib/trusted-origin.js";
import { browserMarkerHeader } from "../lib/browser-context.js";
import { createLogger } from "../lib/logger.js";
import { authRateLimit } from "../middleware/rate-limit.js";
import { isUserIdShaped, normalizeEmail } from "@droplet/auth-policy";

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

/**
 * The native app's own redirect for the handoff, in canonical form only:
 *   - `http://127.0.0.1:<port>/<path>` or `http://[::1]:<port>/<path>`
 *     (RFC 8252 §7.3 loopback; the name `localhost` is refused per §8.3),
 *     port 1024–65535 without leading zeros, a path of unreserved characters
 *     and `/`, and no user info, query or fragment;
 *   - exactly `droplet://sso/callback` (RFC 8252 §7.1 private-use scheme).
 * The box appends `?code=…&state=…`, so a query is never accepted here.
 */
const LOOPBACK_REDIRECT_RE = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{3,4})\/[A-Za-z0-9\-._~/]*$/;
const APP_SCHEME_REDIRECT = "droplet://sso/callback";

const nativeRedirectUriSchema = z
  .string()
  .max(512)
  .refine((uri) => {
    if (uri === APP_SCHEME_REDIRECT) return true;
    const m = LOOPBACK_REDIRECT_RE.exec(uri);
    if (!m) return false;
    const port = Number(m[1]);
    return port >= 1024 && port <= 65535;
  });

/** RFC 7636: an S256 challenge is BASE64URL(SHA256(verifier)), 43 chars. */
const pkceChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const nativeBeginSchema = z.object({
  provider: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  codeChallengeMethod: z.string(),
});

const nativeTokenSchema = z.object({
  // 32 random bytes, base64url.
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  // RFC 7636 §4.1: 43–128 characters of [A-Z a-z 0-9 - . _ ~].
  codeVerifier: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/),
});

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time check of BASE64URL(SHA256(verifier)) against the stored challenge. */
function pkceS256Matches(codeVerifier: string, codeChallenge: string): boolean {
  const computed = Buffer.from(createHash("sha256").update(codeVerifier).digest("base64url"));
  const stored = Buffer.from(codeChallenge);
  return computed.length === stored.length && timingSafeEqual(computed, stored);
}

/**
 * OAuth 2.0 / OIDC authorization-error codes (RFC 6749 section 4.1, OIDC Core
 * authentication error response) the IdP may send back on the callback. Only
 * these are relayed to
 * the native app, verbatim; anything else (and never `error_description`, which
 * is IdP-controlled free text) collapses to `server_error`.
 */
const RELAYED_IDP_ERRORS: ReadonlySet<string> = new Set([
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "account_selection_required",
  "consent_required",
]);

/**
 * Besides the relayed IdP codes, the box sends `sso_failed`, `totp_required`,
 * `sso_email_unverified` and `sso_domain_not_allowed` (documented in
 * docs/mobile-api-contract.md).
 */
/** RFC 6749 section 4.1 (authorization error response) shape: the app's redirect with `error` and the state it sent. */
function nativeErrorRedirectUrl(redirectUri: string, state: string, error: string): string {
  return `${redirectUri}?error=${encodeURIComponent(error)}&state=${encodeURIComponent(state)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * RFC 8252 §8.6 consent page for a NATIVE flow. The IdP leg has just finished
 * in the system browser; before the browser hands a sign-in code to whatever is
 * registered for the app's redirect (a loopback listener, or the `droplet://`
 * scheme any local app can claim), the person confirms it. Continue is the
 * handoff redirect, Cancel is the same redirect with `error=access_denied`. No
 * script and no form: both are plain links. The code stays useless without the
 * app's PKCE verifier and lives 60 s, so an abandoned page grants nothing.
 */
function renderNativeConsentPage(input: {
  provider: string;
  displayName: string;
  redirectUri: string;
  continueUrl: string;
  cancelUrl: string;
}): string {
  const target =
    input.redirectUri === APP_SCHEME_REDIRECT
      ? "the Droplet app on this computer"
      : "an app running on this computer";
  const e = escapeHtml;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Sign in to Droplet</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:12vh auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.25rem}a.btn{display:inline-block;padding:.6rem 1.1rem;border-radius:.4rem;text-decoration:none;margin-right:.6rem;border:1px solid #444;color:#1a1a1a}
a.primary{background:#1a1a1a;color:#fff}small{color:#555}</style></head>
<body><h1>Sign in to Droplet?</h1>
<p>You signed in with ${e(input.provider)} as <strong>${e(input.displayName)}</strong>.
Continue to give ${e(target)} access to this Droplet account.</p>
<p><a class="btn primary" href="${e(input.continueUrl)}">Continue</a><a class="btn" href="${e(input.cancelUrl)}">Cancel</a></p>
<p><small>Only continue if you started this sign-in from the Droplet app just now. This page expires in one minute.</small></p>
</body></html>`;
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

/** Local-part of an email, sanitized for use as a username seed.
 *  WARP-2911: never the shape of a `User.id` — notifications refuse a
 *  UUID-shaped recipient, so such a username would be refused every one. */
function usernameSeedFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const cleaned = local.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 48);
  return cleaned.length >= 2 && !isUserIdShaped(cleaned) ? cleaned : `sso-${cleaned}`;
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
  /** WARP-3193 SEC-AUTH-2 — whether this account can complete
   *  POST /auth/login (a local password on a row the IdP did not
   *  provision — the same rule auth.ts's isIdpProvisioned gate applies). */
  canPasswordLogin: boolean;
}

function canPasswordLogin(row: { passwordHash: string | null; provisionSource?: string | null }): boolean {
  return Boolean(row.passwordHash) && row.provisionSource !== "SSO" && row.provisionSource !== "SCIM";
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

/** WARP-3193 SEC-AUTH-3 — a not-yet-linked Google account whose hosted
 *  domain is not on DROPLET_SSO_GOOGLE_ALLOWED_HD. Mapped to a distinct 401. */
class SsoDomainNotAllowedError extends Error {
  readonly code = "SSO_DOMAIN_NOT_ALLOWED";
  constructor() {
    super("SSO sign-in refused: this Google account's domain is not allowed on this appliance.");
    this.name = "SsoDomainNotAllowedError";
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
  identity: ValidatedIdentity,
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
      canPasswordLogin: canPasswordLogin(existing.user),
    };
  }

  // From here we need an email to link/create. No email → can't make a
  // usable login row, so refuse (no login-unable rows).
  if (!identity.email) {
    return null;
  }
  // #374 — resolve/create against the directory's canonical form
  // (@droplet/auth-policy, WARP-3193 ARCH-9), or a differently-cased address
  // would mint a second row for an owner who already exists.
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

  // WARP-3193 SEC-AUTH-3 — a Google account not yet linked by `sub` may link
  // or be created only when its Workspace domain (`hd`) is on the explicit
  // allowlist. An empty allowlist allows none (fail closed), and a consumer
  // Google account has no `hd` at all. Already-linked users took branch 1.
  if (provider === "google" && !isGoogleHostedDomainAllowed(identity.hostedDomain)) {
    throw new SsoDomainNotAllowedError();
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
      canPasswordLogin: canPasswordLogin(byEmail),
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
      // WARP-2858: explicit origin — the box never sets a local password on it.
      provisionSource: "SSO",
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
    canPasswordLogin: false, // SSO-only row, no passwordHash
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
  // CodeQL js/missing-rate-limiting — `authRateLimit` (20/min/IP) on both
  // halves of the public SSO flow: /authorize persists a login-state row per
  // hit, /callback does the code exchange + session mint (a credential path,
  // same posture as /auth/login).
  router.post("/sso/oidc/authorize", authRateLimit, async (req, res, next) => {
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

  // ── Begin SSO for a native app (RFC 8252 handoff) ──
  // Same IdP authorize request as the browser flow (so the IdP-registered
  // redirect URI, the box callback, is unchanged — ADR-016), but the state row
  // is NATIVE and carries the app's redirect + PKCE challenge. JSON answer: no
  // state cookie (the system browser that finishes the flow is not this
  // client) and no 302 (the app opens the URL itself).
  router.post("/sso/oidc/native/begin", authRateLimit, async (req, res, next) => {
    try {
      const parsed = nativeBeginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", code: "INVALID_REQUEST" });
        return;
      }
      const { provider, redirectUri, codeChallenge, codeChallengeMethod } = parsed.data;
      if (!isSsoProvider(provider)) {
        res.status(400).json({
          error: "Unknown or unsupported SSO provider",
          code: "SSO_PROVIDER_UNSUPPORTED",
        });
        return;
      }
      if (!nativeRedirectUriSchema.safeParse(redirectUri).success) {
        res.status(400).json({
          error:
            "redirectUri must be http://127.0.0.1:<port>/<path>, http://[::1]:<port>/<path> or droplet://sso/callback",
          code: "INVALID_REDIRECT_URI",
        });
        return;
      }
      if (codeChallengeMethod !== "S256" || !pkceChallengeSchema.safeParse(codeChallenge).success) {
        res.status(400).json({
          error: "codeChallenge must be a 43-character base64url S256 challenge",
          code: "INVALID_CODE_CHALLENGE",
        });
        return;
      }
      if (!prisma) {
        logger.error("SSO native begin: prisma not wired; cannot persist login state");
        res.status(500).json({ error: "SSO is not available", code: "SSO_NO_PRISMA" });
        return;
      }
      if (!getOidcProviderConfig(provider)) {
        res.status(400).json({
          error: `SSO for "${provider}" is not configured on this appliance`,
          code: "SSO_PROVIDER_NOT_CONFIGURED",
        });
        return;
      }

      const { authorizeUrl, state, nonce, codeVerifier } = await buildAuthorizeRequest(provider);
      await createLoginState(prisma, {
        provider,
        state,
        nonce,
        codeVerifier,
        // Unused on the native leg (the handoff goes to nativeRedirectUri);
        // the column is required.
        returnTo: "/",
        ttlSeconds: SSO_LOGIN_STATE_TTL_SECONDS,
        flowKind: "NATIVE",
        nativeRedirectUri: redirectUri,
        nativeCodeChallenge: codeChallenge,
      });

      res.setHeader("Cache-Control", "no-store");
      res.json({ authorizeUrl });
    } catch (err) {
      next(err);
    }
  });

  // ── Finish SSO: validate, link/create the local user, issue session ──
  router.get("/sso/oidc/callback", authRateLimit, async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(500).json({ error: "SSO is not available", code: "SSO_NO_PRISMA" });
        return;
      }

      const queryState = typeof req.query.state === "string" ? req.query.state : null;
      const cookieState = req.cookies?.[SSO_STATE_COOKIE] ?? null;

      // Clear the CSRF cookie regardless of outcome — it's single-use.
      res.clearCookie(SSO_STATE_COOKIE, { path: "/api/sso" });

      if (!queryState) {
        res.status(401).json({ error: "Invalid SSO state" });
        return;
      }

      // Read (not claim) the row first: only its explicit flowKind says
      // whether this callback finishes a NATIVE flow, which has no browser
      // cookie by design (begin answered a native HTTP client, not this
      // browser). The native leg stays bound to its initiator by the
      // single-use server-side state + the app's PKCE verifier at /token.
      // An unknown state falls through to the cookie check.
      const peeked = await peekLoginState(prisma, queryState);
      const cookieExempt = peeked?.flowKind === "NATIVE";

      // CSRF: the cookie-side state must match the query state. A callback
      // that didn't originate from THIS browser's /authorize fails here.
      if (!cookieExempt && (!cookieState || queryState !== cookieState)) {
        res.status(401).json({ error: "Invalid SSO state" });
        return;
      }

      // Single-use server-side claim: rejects unknown / replayed / expired.
      const loginState = await consumeLoginState(prisma, queryState);
      if (!loginState) {
        res.status(401).json({ error: "Invalid or expired SSO state" });
        return;
      }

      // NATIVE flow: the system browser is not the app, so a failure has
      // nowhere useful to render. Relay it to the app's own redirect as
      // `error=` (RFC 6749 section 4.1, so the app can stop waiting) and audit it.
      // Returns false for a BROWSER flow, which keeps answering in place.
      const relayNativeError = async (
        error: string,
        reason: string,
        alreadyAudited = false,
      ): Promise<boolean> => {
        if (loginState.flowKind !== "NATIVE" || !loginState.nativeRedirectUri) return false;
        if (!alreadyAudited) {
          await recordActivity({
            kind: "auth",
            severity: "warn",
            sourceIcon: "shield-alert",
            what: "Native SSO sign-in did not complete",
            sub: `${loginState.provider} • ${reason}`,
            refs: { outcome: reason, method: "sso-native", provider: loginState.provider, error },
            actor: { type: "anonymous" },
          });
        }
        res.setHeader("Cache-Control", "no-store");
        res.redirect(302, nativeErrorRedirectUrl(loginState.nativeRedirectUri, loginState.state, error));
        return true;
      };

      // The IdP refused or the person cancelled at the IdP: `error=` instead
      // of `code=`. Only the standard codes are relayed, never the free text.
      const idpError = typeof req.query.error === "string" ? req.query.error : null;
      if (idpError) {
        const relayed = RELAYED_IDP_ERRORS.has(idpError) ? idpError : "server_error";
        const reason = idpError === "access_denied" ? "idp_access_denied" : "idp_error";
        if (await relayNativeError(relayed, reason)) return;
      }

      const code = typeof req.query.code === "string" ? req.query.code : null;
      if (!code) {
        if (await relayNativeError("invalid_request", "missing_code")) return;
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
      let identity: ValidatedIdentity;
      try {
        identity = await exchangeCodeAndValidate(provider, currentUrl, {
          expectedNonce: loginState.nonce,
          codeVerifier: loginState.codeVerifier,
          expectedState: queryState,
        });
      } catch (err) {
        // Log the failure WITHOUT the code/tokens/claims.
        logger.warn({ provider, err: (err as Error).message }, "SSO ID-token validation failed");
        if (await relayNativeError("sso_failed", "validation_failed")) return;
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
          if (await relayNativeError("sso_email_unverified", "email_unverified")) {
            return;
          }
          res.status(401).json({ error: "SSO sign-in failed", code: err.code });
          return;
        }
        if (err instanceof SsoDomainNotAllowedError) {
          logger.warn({ provider }, "SSO sign-in refused: Google hosted domain not on the allowlist");
          if (await relayNativeError("sso_domain_not_allowed", "domain_not_allowed")) {
            return;
          }
          res.status(401).json({ error: "SSO sign-in failed", code: err.code });
          return;
        }
        throw err;
      }
      if (!user) {
        // No usable email in a valid token → we won't mint a login-unable row.
        logger.warn({ provider }, "SSO sign-in rejected: ID token had no usable email");
        if (await relayNativeError("sso_failed", "no_usable_account")) return;
        res.status(401).json({ error: "SSO sign-in failed" });
        return;
      }

      // WARP-3193 SEC-AUTH-2 — SSO must not bypass an enrolled local TOTP
      // factor (an IdP compromise would otherwise skip it). The redirect
      // flow cannot carry a code, and the codebase does not parse `amr`, so
      // the account is refused here with the password path's TOTP_REQUIRED
      // and signs in through POST /auth/login (password + code) instead.
      // Scoped to accounts that CAN do that: refusing an IdP-provisioned
      // account (no local password) would lock it out with no remedy,
      // since there is no MFA-reset route. That residual needs a pending-
      // second-factor step on the SSO callback (not built here).
      if (user.canPasswordLogin) {
        const secondFactor = await checkLoginSecondFactor(prisma, user.id, {});
        if (secondFactor !== "not_enrolled") {
          await recordActivity({
            kind: "auth",
            severity: "warn",
            sourceIcon: "shield-alert",
            what: "Two-factor challenge failed",
            sub: `${user.username} • ${provider}`,
            refs: { outcome: "totp_required", method: "sso", provider, userId: user.id, username: user.username },
            actor: { type: "anonymous" },
          });
          // Already audited above; a native app gets `error=totp_required` and
          // signs in through the password + code form instead.
          if (await relayNativeError("totp_required", "totp_required", true)) {
            return;
          }
          res.status(401).json({ error: "Two-factor authentication required", code: "TOTP_REQUIRED" });
          return;
        }
      }


      if (loginState.flowKind === "NATIVE") {
        // RFC 8252 handoff: NO session and NO cookies here (this is the
        // system browser, not the app). Park a one-time code on the row —
        // sha256 only, 60 s — and ask the person to confirm (RFC 8252 §8.6)
        // before the browser hands it to the app's redirect. The app redeems
        // it at POST /sso/oidc/native/token with its verifier, and THAT is
        // where the sign-in is audited (a parked code is not a sign-in).
        const redirectUri = loginState.nativeRedirectUri;
        if (!redirectUri) {
          // The migration CHECK makes a NATIVE row without it unwritable.
          throw new Error("SSO native callback: NATIVE login state has no redirect URI");
        }
        const handoffCode = randomBytes(32).toString("base64url");
        await setHandoff(prisma, loginState.id, {
          codeHash: sha256Hex(handoffCode),
          userId: user.id,
          expiresAt: new Date(Date.now() + SSO_NATIVE_HANDOFF_TTL_SECONDS * 1000),
        });

        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        // nativeRedirectUri was validated at begin to carry no query.
        res
          .status(200)
          .type("html")
          .send(
            renderNativeConsentPage({
              provider,
              displayName: user.displayName,
              redirectUri,
              continueUrl: `${redirectUri}?code=${handoffCode}&state=${encodeURIComponent(loginState.state)}`,
              cancelUrl: nativeErrorRedirectUrl(redirectUri, loginState.state, "access_denied"),
            }),
          );
        return;
      }

      // Issue the SAME session cookies as /auth/login. WARP-247: record
      // first (cap + idle/absolute clocks), sid into both tokens, and index
      // the refresh token (WARP-116 — the SSO path previously skipped
      // registerRefreshSession). WARP-1582 — the resolved row's custom
      // access role (null = none) rides in the access token.
      const minted = await issueSessionTokens(user);
      setSessionCookies(req, res, minted);

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

  // ── Redeem a native handoff for a Bearer session ──
  // Answers EXACTLY the /auth/login?return=body body. Bearer-only: no
  // cookies, not cacheable. The code is claimed atomically BEFORE the PKCE
  // check, so any redemption attempt burns it (a wrong verifier cannot be
  // retried against the same code).
  router.post("/sso/oidc/native/token", authRateLimit, async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const parsed = nativeTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", code: "INVALID_REQUEST" });
        return;
      }
      // WARP-582 posture: tokens in a response body are for native clients
      // only (lib/browser-context.ts). Refused before the claim, so a
      // browser-context call does not burn the code.
      const marker = browserMarkerHeader(req.headers);
      if (marker !== null) {
        logger.warn({ marker }, "SSO native token: refused for a browser context (WARP-582)");
        res.status(403).json({
          error: "This endpoint is for native clients only",
          code: "NATIVE_CLIENT_REQUIRED",
        });
        return;
      }
      if (!prisma) {
        res.status(500).json({ error: "SSO is not available", code: "SSO_NO_PRISMA" });
        return;
      }

      const { code, codeVerifier } = parsed.data;
      // Every redemption outcome is audited (the box's activity log, not just
      // logger.warn): a redeemed code IS the sign-in, and a failed one is the
      // signal of a stolen or guessed code. Never the code, verifier or tokens.
      const auditNativeFailure = (
        reason: string,
        row?: { provider: string; handoffUserId: string | null },
      ) =>
        recordActivity({
          kind: "auth",
          severity: "warn",
          sourceIcon: "shield-alert",
          what: "Native SSO sign-in failed",
          sub: `${row?.provider ?? "unknown provider"} • ${reason}`,
          refs: {
            outcome: reason,
            method: "sso-native",
            ip: req.ip ?? null,
            ...(row ? { provider: row.provider } : {}),
            ...(row?.handoffUserId ? { userId: row.handoffUserId } : {}),
          },
          actor: { type: "anonymous" },
        });
      // Single-use claim: unknown, replayed and expired codes all miss.
      const row = await consumeHandoff(prisma, sha256Hex(code));
      if (
        !row ||
        !row.handoffUserId ||
        !row.nativeCodeChallenge ||
        !pkceS256Matches(codeVerifier, row.nativeCodeChallenge)
      ) {
        if (row) logger.warn({ provider: row.provider }, "SSO native token: PKCE verifier mismatch");
        await auditNativeFailure(row ? "pkce_mismatch" : "invalid_or_expired_code", row ?? undefined);
        res.status(401).json({ error: "Invalid or expired handoff code", code: "SSO_HANDOFF_INVALID" });
        return;
      }

      // Re-read the user: a deactivation (or removal) between the callback
      // and this redemption must not yield a session.
      const dbUser = await prisma.user.findUnique({ where: { id: row.handoffUserId } });
      if (!dbUser || dbUser.directoryStatus === "DEACTIVATED") {
        logger.warn({ userId: row.handoffUserId }, "SSO native token: account unavailable");
        await auditNativeFailure("account_unavailable", row);
        res.status(401).json({ error: "SSO sign-in failed", code: "SSO_ACCOUNT_UNAVAILABLE" });
        return;
      }

      // WARP-3193 SEC-AUTH-2 (#2436): the callback refused a local-password
      // account with an enrolled TOTP factor before parking this code. Ask
      // again at redemption so a factor enrolled in the meantime, or a code
      // parked by an older box, cannot skip it.
      if (canPasswordLogin(dbUser)) {
        const secondFactor = await checkLoginSecondFactor(prisma, dbUser.id, {});
        if (secondFactor !== "not_enrolled") {
          await auditNativeFailure("totp_required", row);
          res.status(401).json({ error: "Two-factor authentication required", code: "TOTP_REQUIRED" });
          return;
        }
      }

      const role = dbUser.role as Role;
      const minted = await issueSessionTokens({
        id: dbUser.id,
        username: dbUser.username,
        displayName: dbUser.displayName,
        role,
        accessRoleId: dbUser.accessRoleId ?? null,
      });
      res.json({
        user: {
          id: dbUser.id,
          username: dbUser.username,
          displayName: dbUser.displayName,
          role,
          mustChangePassword: dbUser.mustChangePassword,
        },
        ...sessionTokenBody(minted),
      });
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "log-in",
        what: `${dbUser.displayName} signed in via ${row.provider} SSO (native app)`,
        sub: `${role} • ${row.provider}`,
        refs: {
          outcome: "success",
          method: "sso-native",
          userId: dbUser.id,
          username: dbUser.username,
          role,
          provider: row.provider,
        },
        actor: { type: "user", id: dbUser.id },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
