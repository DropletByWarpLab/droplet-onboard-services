/**
 * PR #377 (WARP-___) — WebAuthn / passkey routes.
 *
 * FIDO2/WebAuthn passkeys as a phishing-resistant, PASSWORDLESS sign-in
 * alongside the ADR-013 argon2id directory login (PR #374). Decision (the
 * ticket asked us to flag it): passkeys are implemented as a PASSWORDLESS
 * primary credential — a successful assertion alone issues the normal cookie
 * session, exactly like POST /auth/login does after an argon2id verify. They
 * are an *alternative* credential, not a mandatory second factor. Rationale:
 *   - The spec (docs/ONBOARDING_WEBAUTHN.md) says the assert ceremony "issues
 *     the normal cookie session" and the Aurora login surfaces a standalone
 *     "Use a security key or passkey" button — i.e. sign in with the passkey
 *     by itself, no password first.
 *   - WebAuthn with user-verification is itself multi-factor (possession of
 *     the authenticator + the PIN/biometric that unlocks it), so a single
 *     passkey assertion is a strong primary credential for a home appliance.
 *   - The same assertion is the natural place to later stamp `lastMfaAt` for
 *     step-up flows; that JWT-claim plumbing is owned by WARP-238 and is
 *     deliberately NOT expanded here (see the matching note in the PR body).
 *
 * Four routes, split to match the auth.ts public/protected mounting:
 *   PROTECTED (require a signed-in user — you enrol a passkey for yourself):
 *     POST /auth/webauthn/register/options
 *     POST /auth/webauthn/register/verify
 *   PUBLIC (no session yet — this is how you GET one):
 *     POST /auth/webauthn/authenticate/options
 *     POST /auth/webauthn/authenticate/verify
 *
 * Security:
 *   - Challenges are server-side, single-use (consume-by-delete) and
 *     time-bound (webauthn-challenge.service) — no replay.
 *   - rpID + origin are derived from the request (webauthn-config) — no
 *     hardcoded host, no new env var; works on the LAN with the WAN down.
 *   - Signature counter monotonicity is enforced by @simplewebauthn/server
 *     (it throws on a regression) and the verified `newCounter` is persisted
 *     on every successful assertion (clone detection).
 *   - Public keys / credential ids are treated as opaque and never logged.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import type { PrismaClient, WebAuthnCredential } from "@prisma/client";
import {
  signAccessToken,
  signRefreshToken,
  registerRefreshSession,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type Role,
} from "../services/jwt.service.js";
import { createSession } from "../services/session.service.js";
import { SESSION_COOKIE_NAME, REFRESH_COOKIE_NAME } from "../middleware/auth.js";
import { createChallenge, consumeChallenge } from "../services/webauthn-challenge.service.js";
import { deriveWebAuthnRp } from "../services/webauthn-config.js";
import { recordActivity } from "../services/activity.singleton.js";
import { createLogger } from "../lib/logger.js";
import { browserMarkerHeader } from "../lib/browser-context.js";

const logger = createLogger("webauthn-routes");

/**
 * WARP-1160: caller IP for audit rows. Mirrors auth.ts callerIpFromReq (the
 * WARP-579 standard) — uses Express's proxy-aware `req.ip` (`trust proxy` is
 * set in app.ts, so behind the nginx hop this resolves the real client).
 * NEVER the leftmost `X-Forwarded-For` entry: that value is client-controlled,
 * so every WebAuthn audit row would record whatever IP the caller chose to
 * claim.
 */
function callerIp(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

/** The verify endpoints accept the browser's ceremony response under `response`.
 *  Shape is validated by @simplewebauthn/server; we only assert it's present. */
const verifyBodySchema = z.object({
  response: z.object({}).passthrough(),
});

/** CSV (stored) -> transports array (the library's shape). */
function parseTransports(csv: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!csv) return undefined;
  const list = csv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean) as AuthenticatorTransportFuture[];
  return list.length > 0 ? list : undefined;
}

/** transports array (the library's shape) -> CSV (stored). */
function serializeTransports(transports: AuthenticatorTransportFuture[] | undefined): string | null {
  return transports && transports.length > 0 ? transports.join(",") : null;
}

/**
 * Issue the cookie session for an authenticated user — byte-for-byte the same
 * shape as POST /auth/login (access cookie + refresh cookie + JSON user, with
 * the optional `?return=body` mobile escape hatch). Keeping this identical to
 * the password path means downstream (auth middleware, refresh, logout) treats
 * a passkey session exactly like a password session.
 */
async function issueSession(
  req: Request,
  res: import("express").Response,
  user: {
    id: string;
    username: string;
    displayName: string;
    role: Role;
    /** WARP-1582 — assigned custom access role, `null` for none. Spread
     *  straight into signAccessToken below, so a caller that omits it
     *  mints a claim-less token and consumers fall back to the database. */
    accessRoleId?: string | null;
  },
): Promise<void> {
  // WARP-247 — record first so the sid rides inside both tokens; also
  // index the refresh token (WARP-116) — the passkey path previously
  // skipped registerRefreshSession, leaving these sessions invisible to
  // the admin revoke sweep.
  const { sid } = await createSession({ id: user.id, role: user.role });
  const accessToken = signAccessToken({ ...user, sid });
  const refreshToken = signRefreshToken({ ...user, sid });
  await registerRefreshSession(user.id, refreshToken);
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";

  res.cookie(SESSION_COOKIE_NAME, accessToken, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    path: "/api/auth",
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });

  // WARP-582 — same NATIVE-client-only gate as POST /auth/login: a browser
  // context (any Sec-Fetch-* / Origin / Referer marker present) never gets
  // tokens in the body; it keeps the cookie-only session. See
  // lib/browser-context.ts for the marker rationale.
  const wantBodyParam = req.query.return === "body" || req.query.return === "body=1";
  const browserMarker = wantBodyParam ? browserMarkerHeader(req.headers) : null;
  if (wantBodyParam && browserMarker !== null) {
    logger.warn(
      { marker: browserMarker, username: user.username },
      "passkey login: ?return=body refused for a browser context — cookie-only session issued (WARP-582)",
    );
  }
  const wantBody = wantBodyParam && browserMarker === null;
  res.json({
    user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
    ...(wantBody
      ? {
          accessToken,
          refreshToken,
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
          refreshTokenExpiresAt: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS,
        }
      : {}),
  });
}

// ────────────────────────────────────────────────────────────────
// PROTECTED — registration (mounted AFTER the auth middleware)
// ────────────────────────────────────────────────────────────────
export function createProtectedWebAuthnRouter(prisma?: PrismaClient): Router {
  const router = Router();

  // ── Registration: generate creation options ──
  router.post("/auth/webauthn/register/options", async (req, res, next) => {
    try {
      const user = (req as unknown as { user?: { id: string; username: string; displayName: string } }).user;
      if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      if (!prisma) {
        res.status(503).json({ error: "Directory unavailable" });
        return;
      }

      const { rpID, rpName } = deriveWebAuthnRp(req);

      // Exclude already-registered credentials so the same authenticator
      // can't be enrolled twice for this user.
      const existing = await prisma.webAuthnCredential.findMany({ where: { userId: user.id } });

      // Mint + persist the single-use challenge BEFORE handing it to the
      // library, so the value the browser receives is the one we'll accept.
      const challenge = await createChallenge(prisma, { type: "REGISTRATION", userId: user.id });

      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: user.username,
        userDisplayName: user.displayName,
        challenge,
        attestationType: "none",
        excludeCredentials: existing.map((c) => ({
          id: c.credentialId,
          transports: parseTransports(c.transports),
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      });

      res.json(options);
    } catch (err) {
      next(err);
    }
  });

  // ── Registration: verify attestation + store the credential ──
  router.post("/auth/webauthn/register/verify", async (req, res, next) => {
    try {
      const user = (req as unknown as { user?: { id: string } }).user;
      if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      if (!prisma) {
        res.status(503).json({ error: "Directory unavailable" });
        return;
      }

      const parsed = verifyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Missing registration response" });
        return;
      }
      const response = parsed.data.response as unknown as RegistrationResponseJSON;

      const { rpID, origin } = deriveWebAuthnRp(req);

      // Look up the live challenge by the value echoed in the client data,
      // bound to THIS user, then consume it (single-use). A registration
      // response carries the challenge inside clientDataJSON; the library
      // re-checks it against expectedChallenge, but we resolve our store row
      // first so we can reject an unknown/expired/replayed challenge cheaply.
      const clientChallenge = extractClientChallenge(response);
      if (!clientChallenge) {
        res.status(400).json({ error: "Malformed registration response" });
        return;
      }
      const stored = await consumeChallenge(prisma, clientChallenge, "REGISTRATION");
      if (!stored || stored.userId !== user.id) {
        res.status(400).json({ error: "Registration challenge expired or invalid" });
        return;
      }

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: clientChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: false,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "WebAuthn registration verification failed");
        res.status(400).json({ error: "Registration verification failed" });
        return;
      }

      if (!verification.verified || !verification.registrationInfo) {
        res.status(400).json({ error: "Registration could not be verified" });
        return;
      }

      const { credential } = verification.registrationInfo;
      await prisma.webAuthnCredential.create({
        data: {
          userId: user.id,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          counter: credential.counter,
          transports: serializeTransports(credential.transports),
        },
      });

      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "key-round",
        what: "Passkey registered",
        sub: `${user.id} • ${callerIp(req) ?? "unknown"}`,
        refs: { outcome: "passkey_registered", userId: user.id, ip: callerIp(req) ?? null },
        actor: { type: "user", id: user.id },
      });

      res.json({ verified: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ────────────────────────────────────────────────────────────────
// PUBLIC — passwordless authentication (mounted BEFORE the auth middleware)
// ────────────────────────────────────────────────────────────────
export function createPublicWebAuthnRouter(prisma?: PrismaClient): Router {
  const router = Router();

  // ── Authentication: generate assertion options ──
  router.post("/auth/webauthn/authenticate/options", async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(503).json({ error: "Directory unavailable" });
        return;
      }
      const { rpID } = deriveWebAuthnRp(req);

      // Passwordless / discoverable-credential flow: no user is known yet, so
      // we mint an ANONYMOUS challenge and let the authenticator surface its
      // resident keys. allowCredentials is left empty for this reason.
      const challenge = await createChallenge(prisma, { type: "AUTHENTICATION", userId: null });

      const options = await generateAuthenticationOptions({
        rpID,
        challenge,
        userVerification: "preferred",
      });

      res.json(options);
    } catch (err) {
      next(err);
    }
  });

  // ── Authentication: verify assertion + issue the session ──
  router.post("/auth/webauthn/authenticate/verify", async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(503).json({ error: "Directory unavailable" });
        return;
      }
      const parsed = verifyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Missing authentication response" });
        return;
      }
      const response = parsed.data.response as unknown as AuthenticationResponseJSON;

      const { rpID, origin } = deriveWebAuthnRp(req);

      const clientChallenge = extractClientChallenge(response);
      if (!clientChallenge) {
        res.status(400).json({ error: "Malformed authentication response" });
        return;
      }
      const stored = await consumeChallenge(prisma, clientChallenge, "AUTHENTICATION");
      if (!stored) {
        res.status(400).json({ error: "Authentication challenge expired or invalid" });
        return;
      }

      // Resolve the asserted credential by its id. Unknown credential → 401
      // (no enumeration value in distinguishing this from a bad assertion).
      const credentialId = typeof response.id === "string" ? response.id : "";
      const dbCred = credentialId
        ? await prisma.webAuthnCredential.findUnique({ where: { credentialId } })
        : null;
      if (!dbCred) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: clientChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: false,
          credential: {
            id: dbCred.credentialId,
            publicKey: new Uint8Array(dbCred.publicKey),
            counter: dbCred.counter,
            transports: parseTransports(dbCred.transports),
          },
        });
      } catch (err) {
        // Includes the counter-regression (clone) rejection. The stored
        // counter is deliberately NOT advanced here.
        logger.warn({ err: (err as Error).message }, "WebAuthn assertion verification failed");
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      if (!verification.verified) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      // Resolve the owning directory user FIRST. The signature-counter
      // advance + lastUsedAt stamp are deferred until after the deactivation
      // gate below, so a blocked attempt leaves the credential untouched
      // (parity with the clone-rejection path, which also doesn't advance).
      const dbUser = await prisma.user.findUnique({ where: { id: dbCred.userId } });
      if (!dbUser) {
        // Credential outlived its user (should be impossible — FK cascade).
        logger.error({ userId: dbCred.userId }, "Passkey credential has no owning user");
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      // ORCH-02 — a user the directory deactivated (Okta SCIM `active:false`
      // → `directoryStatus = DEACTIVATED`, a SOFT disable that retains the
      // row AND its registered passkeys) must not sign in via WebAuthn
      // either. This is the third login path; `/auth/login` (auth.ts) and
      // SSO (sso.ts) already fail closed on DEACTIVATED — close the parity
      // gap so a previously-enrolled passkey can't defeat offboarding. Same
      // posture/wording as the other paths (no enumeration signal).
      if (dbUser.directoryStatus === "DEACTIVATED") {
        logger.warn(
          { userId: dbUser.id },
          "WebAuthn sign-in rejected: directory user is deactivated",
        );
        // Audit parity with auth.ts denyInvalid: record a warn-level denial so
        // a deactivated user probing via passkey leaves the same trail the
        // password path produces. The counter is intentionally NOT advanced —
        // we return before the credential update below.
        await recordActivity({
          kind: "auth",
          severity: "warn",
          sourceIcon: "shield-alert",
          what: "Passkey sign-in blocked for a deactivated account",
          sub: `${dbUser.username} • ${callerIp(req) ?? "unknown"}`,
          refs: {
            outcome: "invalid_credentials",
            method: "webauthn",
            userId: dbUser.id,
            username: dbUser.username,
            ip: callerIp(req) ?? null,
          },
          // WARP-181: pre-auth denial — the sign-in did not complete.
          actor: { type: "anonymous" },
        });
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      // Advance the signature counter to the verified value (clone detection
      // on the NEXT assertion) and stamp last-used — only now that the user is
      // verified AND active, so a blocked attempt never mutates state.
      await prisma.webAuthnCredential.update({
        where: { id: dbCred.id },
        data: {
          counter: verification.authenticationInfo.newCounter,
          lastUsedAt: new Date(),
        },
      });

      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "log-in",
        what: `${dbUser.displayName} signed in with a passkey`,
        sub: `${dbUser.role} • ${callerIp(req) ?? "unknown"}`,
        refs: {
          outcome: "success",
          method: "webauthn",
          userId: dbUser.id,
          username: dbUser.username,
          role: dbUser.role,
          ip: callerIp(req) ?? null,
        },
        actor: { type: "user", id: dbUser.id },
      });

      await issueSession(req, res, {
        id: dbUser.id,
        username: dbUser.username,
        displayName: dbUser.displayName,
        role: dbUser.role as Role,
        // WARP-1582 — a passkey session is a session like any other; it
        // must carry the same claim or every passkey user silently keeps
        // paying the per-turn read.
        accessRoleId: dbUser.accessRoleId ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Pull the base64url `challenge` out of a ceremony response's clientDataJSON.
 * The browser echoes the server challenge inside clientDataJSON; we read it to
 * resolve our single-use store row before delegating full verification to the
 * library. Returns null on any malformed input (the route then 400s).
 */
function extractClientChallenge(
  response: RegistrationResponseJSON | AuthenticationResponseJSON,
): string | null {
  try {
    const clientDataJSON = (response as { response?: { clientDataJSON?: string } }).response
      ?.clientDataJSON;
    if (typeof clientDataJSON !== "string" || clientDataJSON.length === 0) return null;
    const json = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as {
      challenge?: string;
    };
    return typeof json.challenge === "string" && json.challenge.length > 0 ? json.challenge : null;
  } catch {
    return null;
  }
}

// Convenience combined factory (parallels createAuthRouter()).
export function createWebAuthnRouter(prisma?: PrismaClient): Router {
  const router = Router();
  router.use(createPublicWebAuthnRouter(prisma));
  router.use(createProtectedWebAuthnRouter(prisma));
  return router;
}

export type { WebAuthnCredential };
