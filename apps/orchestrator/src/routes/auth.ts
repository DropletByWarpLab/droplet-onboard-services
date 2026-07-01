import { Router, Request } from "express";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import {
  generateInviteToken,
  findInviteByToken,
  isExpired,
  isUsed,
  isRevoked,
} from "../services/invite.service.js";
import { sendInviteEmail } from "../services/email-channel.service.js";
import { trustedOriginUrl } from "../lib/trusted-origin.js";
import { buildInviteUrl } from "../lib/invite-url.js";
import {
  ncCheckSetupRequired,
  ncInstallAndCreateAdmin,
  ncLoginWithCredentials,
  ncDeleteAppPassword,
  ncGetCurrentUser,
  ncCreateUser,
  ncDeleteUser,
  ncListUsers,
  ncUpdateUser,
  ncSetUserEnabled,
  ncOAuth2AuthorizeUrl,
  ncOAuth2ExchangeCode,
  ncOAuth2RefreshToken,
  NextcloudUserExistsError,
} from "../services/nextcloud.client.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  denyRefreshToken,
  claimRefreshRotation,
  registerRefreshSession,
  unregisterRefreshSession,
  revokeUserSessions,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  roleOutranks,
  type Role,
} from "../services/jwt.service.js";
import {
  SESSION_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  requireRole,
} from "../middleware/auth.js";
import {
  storeNcToken,
  getNcToken,
  deleteNcToken,
  touchNcToken,
  resolveNcToken,
} from "../services/nextcloud-session.service.js";
import {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
} from "../services/password.service.js";
import { cacheGet, cacheSet, cacheDel, cacheIncr } from "../services/cache.service.js";
import {
  TOTP_ISSUER,
  generateTotpEnrollment,
  encryptTotpSecret,
  decryptTotpSecret,
  verifyTotpCode,
} from "../services/totp.service.js";
import {
  generateRecoveryCodes,
  findMatchingRecoveryCodeHash,
} from "../services/recovery.service.js";
import QRCode from "qrcode";
import { config } from "../config.js";
import { buildNcGroups, householdGroupName } from "./auth-groups.js";
import { purgeUserData } from "../services/brain-memory.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { verifyClaimCodePresence } from "../services/setup-claim.service.js";
import {
  passwordZod,
  baseUserIdFromEmail,
  nthUserIdCandidate,
  isReservedUserId,
} from "@droplet/auth-policy";
import { createLogger } from "../lib/logger.js";

/** WARP-456: caller IP for auth audit rows. Uses Express's proxy-aware
 *  `req.ip` — `trust proxy` is set in app.ts, so behind the nginx gateway
 *  this resolves to the real client. NEVER the leftmost `X-Forwarded-For`
 *  entry: that one is client-controlled, so every auth audit row would
 *  record whatever IP the caller chose to claim. Exported for tests. */
export function callerIpFromReq(req: Request): string | undefined {
  return req.ip ?? req.socket?.remoteAddress ?? undefined;
}

const logger = createLogger("auth-route");

const usernameField = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, "Username must be alphanumeric")
  .refine(
    (val) => !isReservedUserId(val),
    "This username is reserved and cannot be used",
  );

// ADR-013 (PR #374 review fix): email is the directory login key and the
// only stable login identifier (the Nextcloud auth fallback was removed).
// The btree unique index on `User.email` is case-SENSITIVE, so without
// normalization `Stefan@Warp.test` (written at setup) and `stefan@warp.test`
// (typed at login) resolve to different rows → owner lock-out, and
// `owner@x` / `Owner@x` both insert → unique-bypass. Normalize to
// trim+lowercase at EVERY boundary (write + read) so every value that ever
// touches the column is already canonical; the plain unique index then
// catches collisions and the email-keyed lookup always hits. Validation
// (length, RFC shape) runs on the normalized value. `.email()` after the
// transform also rejects a value that was only well-formed before trimming.
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(200);

const setupSchema = z.object({
  password: passwordZod,
  displayName: z.string().min(1).max(128).optional(),
  // ADR-013: email is the directory login key and the sole user-facing
  // identifier. Username is derived server-side (deriveUniqueUserId).
  email: emailField,
  // WARP-165 — front-panel claim code. OPTIONAL in the schema (default-off
  // back-compat: the un-gated path never sends it). Only ENFORCED when
  // config.DROPLET_CLAIM_GATE_ENABLED is on, where its absence is a 403
  // CLAIM_CODE_REQUIRED (handled in the route, not the schema, so the
  // owner-already-exists guard can run first). Bounded so a junk payload is
  // cheap; verified read-only against the persisted ClaimCode.
  claimCode: z.string().min(1).max(64).optional(),
});

// ADR-013: the directory login key is email. The Aurora login (PR #370)
// labels the field "Work email" and sends it as the identifier. We accept
// it under `email` (canonical) and still tolerate the legacy `username`
// field carrying the same value, so a client mid-rollout that hasn't
// renamed the field keeps working through one deploy window. At least one
// of the two must be present and non-empty.
const loginSchema = z
  .object({
    // ADR-013 (PR #374): the directory login key is case-insensitive but
    // the unique index is case-sensitive, so the lookup value must be
    // trim+lowercased to match the (already-normalized) stored value —
    // otherwise an owner who set up `Stefan@Warp.test` is locked out when
    // they sign in as `stefan@warp.test`. Normalize on BOTH the canonical
    // `email` field and the legacy `username` field (which carries the same
    // email value during the rollout window). `.min(1)` runs AFTER trim so
    // an all-whitespace identifier is rejected.
    email: z.string().trim().toLowerCase().min(1).optional(),
    username: z.string().trim().toLowerCase().min(1).optional(),
    password: z.string().min(1),
    // PR #375 — optional second factor for the TOTP login gate. Only
    // consulted when the resolved user has TOTP enabled; a 6-digit TOTP
    // code or a one-time recovery code. Bounded to keep a junk payload
    // cheap. Absent for password-only accounts.
    totp: z.string().trim().max(16).optional(),
    recoveryCode: z.string().trim().max(64).optional(),
  })
  .refine((d) => Boolean(d.email ?? d.username), {
    message: "Email and password are required",
  });

const createUserSchema = z.object({
  password: passwordZod,
  displayName: z.string().min(1).max(128).optional(),
  email: emailField,
  // WARP-824: the admin types a TEMPORARY password and (by default) requires
  // the new user to change it on first login. This maps to the explicit
  // `User.mustChangePassword` column the post-auth gate reads. Default true —
  // an admin-minted account is a temp-credential handoff unless the operator
  // explicitly opts out, so a client that omits the field gets the safe
  // (forced-change) behaviour.
  mustChangePassword: z.boolean().default(true),
});

// WARP-824 — self-service password change (forced first-login change, or any
// user rotating their own password). `currentPassword` proves the caller holds
// the existing credential (a session cookie alone must not let an attacker who
// stepped away from an unlocked tab silently rotate the password). `newPassword`
// goes through the SAME shared policy (passwordZod) every other credential
// surface enforces, so the UI checklist and server agree.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordZod,
});

// PR #375 — TOTP verify / re-challenge body: exactly six decimal digits.
const totpVerifySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "A 6-digit code is required"),
});

// PR #375 — recovery-code consumption body.
const recoveryConsumeSchema = z.object({
  code: z.string().trim().min(1).max(64),
});

// ── WARP-217 invite schemas ──
// WARP-171: widened from the legacy ["user", "admin"] union to the full
// Role enum so the DB column (now typed as `Role`) and the request body
// share a vocabulary. Legacy "user" sent by older dashboard builds is
// coerced to "family" via the preprocessor so existing clients keep
// working through one rolling deploy window — the dashboard should be
// updated to send the canonical names in a follow-up.
//
// `service` is excluded because a service principal is never minted by
// an invite — those are env-var-only (SERVICE_TOKEN_*).
const inviteRoleField = z.preprocess(
  (v) => (v === "user" ? "family" : v),
  z.enum(["owner", "admin", "family", "guest"]),
);

const createInviteSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  // ADR-013: the invite email is the invitee's directory login key on
  // accept and the basis for the derived userid. Required.
  email: emailField,
  role: inviteRoleField.default("family"),
  // Acceptance window in hours (1h–30d). Default 72h.
  ttlHours: z.number().int().min(1).max(720).optional(),
});

const acceptInviteSchema = z.object({
  password: passwordZod,
});

// WARP-171: the legacy `isAdmin(req)` helper was inlined-and-removed
// when every invite-management route was switched to
// `requireRole("owner", "admin")`. The two-value contract is now
// expressed at route registration where reviewers can see it.

/** Best-effort source IP for the audit trail. Honours `trust proxy`. */
function getRequestIp(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

/**
 * Progressive backoff for failed current-password checks on
 * POST /auth/change-password (PR #549 reviewer follow-up: without a lockout
 * the endpoint is a current-password brute-force oracle for whoever holds a
 * session cookie). Mirrors the WARP-631 claim-code model: a small free tier,
 * then FIXED escalating locks that always elapse on their own; the failure
 * counter resets after an hour without failures and on a successful verify.
 * Keyed by user id — the gate protects the ACCOUNT's password, and a NATed
 * household shares one IP. Fails OPEN on cache errors so a flaky Redis can
 * never lock a legitimate user out of rotating their password.
 */
const PW_CHANGE_FREE_TIER = 5;
/** Lock seconds for the 1st, 2nd, 3rd … lock; the last value is the cap. */
const PW_CHANGE_BACKOFF_SCHEDULE = [30, 60, 120, 300, 900] as const;
/** Failure counter resets after an hour of no failures (rolling window). */
const PW_CHANGE_FAILS_TTL_SEC = 60 * 60;

function pwChangeFailsKey(userId: string): string {
  return `ratelimit:change-password:fails:${userId}`;
}
function pwChangeLockKey(userId: string): string {
  return `ratelimit:change-password:lock:${userId}`;
}

/** PURE schedule map (failure count → lock seconds). Exported for tests. */
export function passwordChangeBackoffSeconds(failureCount: number): number {
  const idx = failureCount - PW_CHANGE_FREE_TIER - 1;
  if (idx < 0) return 0;
  return PW_CHANGE_BACKOFF_SCHEDULE[
    Math.min(idx, PW_CHANGE_BACKOFF_SCHEDULE.length - 1)
  ];
}

async function checkPasswordChangeLock(
  userId: string,
): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  try {
    const until = (await cacheGet<number>(pwChangeLockKey(userId))) ?? 0;
    const now = Date.now();
    if (until > now) {
      return { locked: true, retryAfterSeconds: Math.ceil((until - now) / 1000) };
    }
    return { locked: false, retryAfterSeconds: 0 };
  } catch {
    return { locked: false, retryAfterSeconds: 0 };
  }
}

async function recordPasswordChangeFailure(userId: string): Promise<void> {
  try {
    // cacheIncr is atomic (Redis INCR) — avoids the read-modify-write race
    // where two concurrent wrong-password requests both read N and both write
    // N+1, keeping the counter artificially low.
    const next = await cacheIncr(pwChangeFailsKey(userId), PW_CHANGE_FAILS_TTL_SEC);
    if (next === null) return; // Redis error — fail open
    const lockedSeconds = passwordChangeBackoffSeconds(next);
    if (lockedSeconds > 0) {
      await cacheSet(
        pwChangeLockKey(userId),
        Date.now() + lockedSeconds * 1000,
        lockedSeconds,
      );
    }
  } catch {
    // fail open — see the model comment above.
  }
}

async function clearPasswordChangeRateState(userId: string): Promise<void> {
  try {
    await cacheDel(pwChangeFailsKey(userId));
    await cacheDel(pwChangeLockKey(userId));
  } catch {
    // fail open.
  }
}

/**
 * WARP-579 — progressive backoff for failed /auth/login credential checks.
 * Until now /auth/login verified the argon2id hash with NO rate limit, so an
 * unauthenticated attacker could brute-force any account's password from the
 * public router. Mirrors the change-password backoff model above (a small free
 * tier, then FIXED escalating locks that always elapse on their own; the
 * counter resets after an hour without failures and on a successful login).
 *
 * Two independent gates, BOTH consulted before the verify:
 *   • per-IP    — caps how fast one source can spray attempts across many
 *                 accounts (credential stuffing). Keyed by the proxy-aware
 *                 caller IP.
 *   • per-account — caps how fast one account's password can be guessed from
 *                 anywhere (distributed guessing). Keyed by the normalized
 *                 login email; applied to EVERY attempt — including
 *                 unknown-email — so it can't double as an account-enumeration
 *                 oracle (the email is hashed into the key, not stored).
 *
 * The per-account tier is more forgiving than per-IP because a NATed household
 * legitimately shares one public IP; the per-account lock is the harder ceiling
 * on actually compromising a single credential. Fails OPEN on cache errors so a
 * flaky Redis can never lock every user out of signing in.
 */
const LOGIN_IP_FREE_TIER = 10;
const LOGIN_ACCOUNT_FREE_TIER = 5;
/** Lock seconds for the 1st, 2nd, 3rd … lock; the last value is the cap. */
const LOGIN_BACKOFF_SCHEDULE = [30, 60, 120, 300, 900] as const;
/** Failure counter resets after an hour of no failures (rolling window). */
const LOGIN_FAILS_TTL_SEC = 60 * 60;

function loginIpFailsKey(ip: string): string {
  return `ratelimit:login:ip:fails:${ip}`;
}
function loginIpLockKey(ip: string): string {
  return `ratelimit:login:ip:lock:${ip}`;
}
/**
 * WARP-579 finding 4: the login email must be HASHED into the per-account
 * Redis key, never interpolated as plaintext. Interpolating it (a) leaks every
 * targeted email to anyone with Redis `SCAN`, and (b) lets an RFC-valid colon
 * in the local-part (`a:b@x`) corrupt the `ratelimit:login:account:fails:`
 * namespace. `email` is already trim+lowercased by loginSchema, so the hash is
 * stable across the write/read boundary. sha256 is a one-way namespace digest
 * here, not a password hash — speed is fine and salting is unnecessary (the key
 * is per-attempt rate-limit state, not a stored secret).
 */
function hashLoginEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}
function loginAccountFailsKey(email: string): string {
  return `ratelimit:login:account:fails:${hashLoginEmail(email)}`;
}
function loginAccountLockKey(email: string): string {
  return `ratelimit:login:account:lock:${hashLoginEmail(email)}`;
}

/**
 * PURE schedule map (failure count → lock seconds) for the given free tier.
 * Exported for tests. Below `freeTier` failures the gate forgives; the first
 * lock lands on the (freeTier+1)th failure.
 */
export function loginBackoffSeconds(failureCount: number, freeTier: number): number {
  const idx = failureCount - freeTier - 1;
  if (idx < 0) return 0;
  return LOGIN_BACKOFF_SCHEDULE[
    Math.min(idx, LOGIN_BACKOFF_SCHEDULE.length - 1)
  ];
}

async function checkLoginLock(
  lockKey: string,
): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  try {
    const until = (await cacheGet<number>(lockKey)) ?? 0;
    const now = Date.now();
    if (until > now) {
      return { locked: true, retryAfterSeconds: Math.ceil((until - now) / 1000) };
    }
    return { locked: false, retryAfterSeconds: 0 };
  } catch {
    return { locked: false, retryAfterSeconds: 0 };
  }
}

async function recordLoginFailure(
  failsKey: string,
  lockKey: string,
  freeTier: number,
): Promise<void> {
  try {
    // cacheIncr is atomic (Lua INCR + first-creation-only EXPIRE) — avoids the
    // read-modify-write race where two concurrent failed logins both read N and
    // both write N+1. WARP-579 finding 5: it is a true FIXED window — the TTL is
    // stamped only when the counter is first created, so the counter passively
    // decays after LOGIN_FAILS_TTL_SEC of no failures, matching the documented
    // "resets after an hour of no failures" intent. (A sliding TTL would re-arm
    // the window on every failure and never let it expire — that bug was fixed
    // in cacheIncr itself, so the throttle gets fixed-window semantics for free.)
    const next = await cacheIncr(failsKey, LOGIN_FAILS_TTL_SEC);
    if (next === null) return; // Redis error — fail open
    const lockedSeconds = loginBackoffSeconds(next, freeTier);
    if (lockedSeconds > 0) {
      await cacheSet(lockKey, Date.now() + lockedSeconds * 1000, lockedSeconds);
    }
  } catch {
    // fail open — see the model comment above.
  }
}

/**
 * WARP-579 finding 2: on a COMPLETE successful login, clear ONLY the
 * authenticating account's fail/lock counters. We deliberately do NOT clear the
 * per-IP keys: a shared-NAT attacker could otherwise spray failures against a
 * victim, then log into their OWN account from the same IP to zero the shared
 * per-IP counter, looping forever. The per-IP counters decay on their own via
 * their fixed-window TTL (finding 5), so one account's success can never wipe
 * the per-IP failure state that guards every other account on that IP. The
 * legitimate user's own per-account counter still resets here, so their next
 * session isn't held under a stale lock.
 */
async function clearLoginAccountRateState(email: string): Promise<void> {
  try {
    await cacheDel(loginAccountFailsKey(email));
    await cacheDel(loginAccountLockKey(email));
  } catch {
    // fail open.
  }
}

// The invite-accept URL is built by the shared, host-validated
// `buildInviteUrl` in lib/invite-url.ts (PR #486 review finding 2). The old
// local copy trusted `x-forwarded-host` blindly, embedding an unvalidated host
// into a token-bearing email link — a token-exfiltration vector.

const updateUserSchema = z
  .object({
    displayName: z.string().min(1).max(128).optional(),
    // ADR-013 (PR #374): normalized so an admin editing a member's email
    // writes the same canonical form the login lookup + unique index expect.
    email: emailField.optional(),
    // Accept either a byte count (1073741824) or a human string ("5 GB", "none").
    quota: z.union([z.string().min(1).max(32), z.number().int().min(0)]).optional(),
    // ADR-013: same shared policy the setup/add-user/invite paths enforce.
    password: passwordZod.optional(),
  })
  .refine(
    (d) =>
      d.displayName !== undefined ||
      d.email !== undefined ||
      d.quota !== undefined ||
      d.password !== undefined,
    { message: "At least one field is required" }
  );

/**
 * Build the OAuth2 callback `redirect_uri` from the box's canonical origin.
 *
 * PR #486 review finding 2: this previously trusted `req.headers.host`
 * verbatim, so a forged Host/X-Forwarded-Host poisoned the redirect_uri sent
 * to the IdP. It now delegates to the shared trusted-origin resolver (canonical
 * origin -> allowlisted request host -> safe default), so a forged header is
 * never embedded. The IdP here is the box's own Nextcloud, fronted by the same
 * Nginx on the same host, so the canonical origin is the correct redirect_uri.
 *
 * Exported so the OAuth2 round-trip's two redirect_uri call sites (authorize +
 * token-exchange) share one definition — they MUST be byte-identical for the
 * IdP to accept the exchange.
 */
export async function getRedirectUri(
  req: import("express").Request,
): Promise<string> {
  return trustedOriginUrl(req, "/api/auth/callback");
}

/**
 * Resolve the session token from cookie (browser) or Authorization header (API client).
 */
function resolveToken(req: import("express").Request): string | null {
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  return null;
}

// ────────────────────────────────────────────────────────────────
// Public auth routes — mounted BEFORE the auth middleware
//
// `prisma` is optional for backward compatibility with the legacy
// createAuthRouter() shim, but the WARP-217 invite-accept endpoints need
// it. When called without prisma those routes simply 404 (the dashboard's
// `getInvite` / `acceptInvite` calls will treat that as "invite not found"
// which is the right default for an under-configured deployment).
//
// WARP-485 round 2 — JWT-path normalization callsites (this file owns
// the only places where `id` enters the JWT subject claim or the NC
// token cache key; the OCS auth path was already normalized in round 1
// inside `src/middleware/auth.ts`):
//
//   1. POST /api/auth/login        — line ~275: signAccessToken({ id })
//                                  — line ~267: storeNcToken(id, ...)
//   2. POST /api/auth/refresh      — line ~447: signAccessToken({ id })
//                                  — line ~452: touchNcToken(id, ...)
//   3. POST /api/auth/invites/accept/:token
//                                  — line ~674: signAccessToken({ id })
//   4. POST /api/auth/logout       — line ~768: getNcToken(req.user.id)
//                                  — line ~776: deleteNcToken(req.user.id)
//
// Contract: every `id` fed to signAccessToken / signRefreshToken / NC
// token store helpers in this file is the **local `User.id` UUID**,
// resolved by looking up the local `User` row whose `nextcloudUsername`
// matches the Nextcloud user id returned by OCS. The pre-WARP-485 shape
// fed the NC username string into `JWT.sub`, which bypassed WARP-480's
// self-action guard at `/api/people/:id` under JWT auth (`req.user.id`
// = NC username, `req.params.id` = UUID → string mismatch → guard
// silently skipped).
//
// Fail-closed posture (matches the OCS path's WARP-485 round-1
// behavior): when no local User row exists for the authenticated
// Nextcloud user, the route returns 401 + `USER_NOT_PROVISIONED`
// instead of minting a synthetic id. Silent auto-provision would be
// a privilege-escalation vector — an attacker holding a valid OCS
// credential for an unrelated NC user could otherwise mint a default-
// `family`-role local row.
// ────────────────────────────────────────────────────────────────

/**
 * Derive a unique, Nextcloud-safe userid from an email. Walks suffix
 * candidates (base, base-2, base-3, …), skipping reserved ids and any value
 * already used as `username` OR `nextcloudUsername` (both are @unique).
 */
async function deriveUniqueUserId(
  prisma: import("@prisma/client").PrismaClient,
  email: string,
): Promise<string> {
  const base = baseUserIdFromEmail(email);
  for (let n = 1; n < 100000; n += 1) {
    const candidate = nthUserIdCandidate(base, n);
    if (isReservedUserId(candidate)) continue;
    const taken = await prisma.user.findFirst({
      where: { OR: [{ username: candidate }, { nextcloudUsername: candidate }] },
    });
    if (!taken) return candidate;
  }
  throw new Error("deriveUniqueUserId: exhausted candidate space");
}

export function createPublicAuthRouter(
  prisma?: import("@prisma/client").PrismaClient,
): Router {
  const router = Router();

  // ── Check if initial setup is required ──
  router.get("/auth/setup", async (_req, res, next) => {
    try {
      const setupRequired = await ncCheckSetupRequired();
      // WARP-165 — surface whether the physical-presence claim gate is on so
      // the setup wizard's Account step knows to show + require the claim-code
      // field. Reading config (not the DB) keeps this probe cheap; the field
      // is verified server-side at POST /auth/setup regardless of what the
      // client chooses to render.
      res.json({
        setupRequired,
        claimGateEnabled: config.DROPLET_CLAIM_GATE_ENABLED,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Initial setup: create the first admin user ──
  router.post("/auth/setup", async (req, res, next) => {
    try {
      const parsed = setupSchema.safeParse(req.body);
      if (!parsed.success) {
        const fields = parsed.error.flatten().fieldErrors;
        if (fields.email) {
          res.status(400).json({ error: "Enter a valid email address.", code: "INVALID_EMAIL" });
          return;
        }
        if (fields.password) {
          res.status(400).json({
            error: "That password doesn't meet the requirements.",
            code: "WEAK_PASSWORD",
          });
          return;
        }
        res.status(400).json({ error: "Invalid request", code: "INVALID_REQUEST" });
        return;
      }

      const { password, displayName, email } = parsed.data;

      // WARP-485 follow-up (Romain PR #279 review): the local User
      // mirror is a HARD precondition for setup, not a best-effort
      // side-effect. Fail-CLOSED here BEFORE touching Nextcloud so we
      // never leave an NC admin without a local row — the alternative
      // is the exact lockout this PR exists to prevent (login path
      // 401s USER_NOT_PROVISIONED at lines 325-351 below). Matches the
      // login route's fail-CLOSED stance for the legacy
      // createAuthRouter() shim that wires this router without prisma.
      if (!prisma) {
        logger.error(
          { email },
          "setup: prisma client not wired into public auth router; refusing to create NC admin without local mirror",
        );
        res.status(500).json({
          error: "Setup misconfigured: local user database not wired",
          code: "SETUP_NO_PRISMA",
        });
        return;
      }

      // ── N1 (PR #374): owner-already-exists guard. ──
      // ADR-013 made LOCAL rows (not Nextcloud `installed=true`) the
      // authoritative source, which re-opened a hole on this route: a
      // re-POST to /auth/setup would either (a) rewrite the existing
      // owner's argon2id passwordHash via the username-keyed upsert below
      // — a full account takeover — or (b) mint a SECOND owner row. Setup
      // is a one-time bootstrap: once any `owner`-role row exists, refuse
      // with 409 and touch neither the hash nor Nextcloud. The owner-count
      // idiom mirrors people.ts's last-owner guard. This runs BEFORE
      // hashPassword + upsert + ncInstallAndCreateAdmin so a takeover
      // attempt has zero side effects.
      const existingOwners = await prisma.user.count({
        where: { role: "owner" },
      });
      if (existingOwners > 0) {
        logger.warn(
          { email },
          "setup: refused — an owner already exists (N1 owner-already-exists guard, PR #374)",
        );
        res.status(409).json({
          error: "Setup has already been completed for this appliance.",
          code: "OWNER_EXISTS",
        });
        return;
      }

      // ── WARP-165: physical-presence claim gate. ──
      // When enabled, the genuine first-owner request must carry the claim
      // code shown on the device's front panel — proof the operator is
      // physically at the box, not merely on its LAN. This closes the
      // first-boot window where any LAN client could create the owner.
      //
      // POSITIONED AFTER the N1 owner-exists guard ON PURPOSE: a
      // dropped-response RETRY (the original setup committed but its response
      // was lost) must hit the benign 409 OWNER_EXISTS above, NOT a fresh
      // claim 403. So the code is only validated on the genuine
      // first-owner-creation path (existingOwners === 0).
      //
      // VERIFY-ONLY, never consume: the consume that flips the ClaimCode to
      // `consumed` is owned by the cloud-bind step (POST /api/setup/claim),
      // and `isClaimed()` reads the consumed count. In the real wizard the box
      // is claimed BEFORE the owner is created, so the row is already
      // `consumed` by the time we get here — `verifyClaimCodePresence` matches
      // either state and never mutates, so it neither double-binds nor breaks
      // the cloud-claim flow. Default-off (DROPLET_CLAIM_GATE_ENABLED) keeps a
      // half-shipped gate from locking anyone out.
      if (config.DROPLET_CLAIM_GATE_ENABLED) {
        const claimCode = parsed.data.claimCode?.trim() ?? "";
        if (!claimCode) {
          // Never log the (absent) code; warn for the operator only.
          logger.warn(
            { email },
            "setup: rejected — claim gate ON and no claim code supplied (WARP-165)",
          );
          res.status(403).json({
            error:
              "A claim code from the device's front panel is required to complete setup.",
            code: "CLAIM_CODE_REQUIRED",
          });
          return;
        }
        const present = await verifyClaimCodePresence(prisma, claimCode);
        if (!present) {
          // Never echo or log the submitted/real code (secret-in-logs gate).
          logger.warn(
            { email },
            "setup: rejected — claim code did not match the front-panel code (WARP-165)",
          );
          res.status(403).json({
            error:
              "That claim code doesn't match the one shown on your device's front panel.",
            code: "CLAIM_CODE_INVALID",
          });
          return;
        }
      }

      // Romain PR #279 round 2: order matters here because the two
      // calls have very different recovery profiles.
      //
      //   prisma.user.upsert     — idempotent on `nextcloudUsername`;
      //                            infinitely safe to retry.
      //   ncInstallAndCreateAdmin — ONE-SHOT. Nextcloud refuses a
      //                            second install once `installed=true`
      //                            (status.php), so on a partial-failure
      //                            retry the route would be permanently
      //                            stuck unless the operator dropped
      //                            into the box and reset state.
      //
      // Do the idempotent step FIRST so a transient DB failure leaves
      // Nextcloud untouched and the operator can simply retry. If the
      // upsert succeeds and ncInstall later fails, the next retry
      // hits the same idempotent upsert (no-op) and re-attempts
      // ncInstall — exactly what we want for transient infrastructure
      // failures.
      //
      // ADR-013: the directory is the auth source of truth, so the
      // owner's argon2id passwordHash is written HERE (not derived from
      // Nextcloud). Nextcloud is provisioned downstream below with the
      // same plaintext so its WebDAV account works, but it no longer
      // authenticates anyone. The plaintext is hashed before it touches
      // the row and is never logged.
      const username = await deriveUniqueUserId(prisma, email);
      const passwordHash = await hashPassword(password);
      // `email` is guaranteed present + normalized (N2 makes it required on
      // this path; emailField trim+lowercased it). Write it directly so the
      // stored login key matches the case-insensitive /auth/login lookup.
      await prisma.user.upsert({
        where: { nextcloudUsername: username },
        update: {
          displayName: displayName || username,
          passwordHash,
          email,
        },
        create: {
          username,
          displayName: displayName || username,
          email,
          nextcloudUsername: username,
          passwordHash,
          role: "owner" as any,
        },
      });

      // WARP-883: the owner must join the household group too, otherwise the
      // shared "Household" groupfolder never mounts for the primary user and
      // GET /api/files/spaces reports sharedAvailable:false for them (the
      // SpaceSwitcher never appears). buildNcGroups preserves the owner's
      // existing "admin" group and appends the household group without
      // duplication — same helper the invite-accept path uses.
      const ownerGroups = buildNcGroups(
        "owner",
        householdGroupName(config.DROPLET_SHARED_FOLDER_NAME),
      );
      await ncInstallAndCreateAdmin(username, password, displayName, ownerGroups);
      logger.info({ username }, "Initial admin user created");

      res.json({ status: "ok", username });
    } catch (err: any) {
      logger.error({ err }, "Setup failed");
      res.status(500).json({ error: err.message || "Setup failed" });
    }
  });

  // ── Login: validate credentials LOCALLY against the directory, issue JWT ──
  //
  // ADR-013 — the built-in argon2id directory is the auth source of truth.
  // We resolve the User by email, verify the password against the stored
  // argon2id hash (password.service), and only then provision/refresh the
  // downstream Nextcloud session for WebDAV. Nextcloud no longer
  // authenticates — it's a downstream-provisioned account.
  router.post("/auth/login", async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Email and password are required" });
        return;
      }

      // Email is the stable directory login key (accept the legacy
      // `username` field carrying the same value during rollout). Already
      // trim+lowercased by loginSchema (ADR-013 / PR #374), so it matches
      // the normalized value stored on the row by the case-sensitive
      // unique index. Keep the `.trim()` as belt-and-suspenders.
      const loginEmail = (parsed.data.email ?? parsed.data.username ?? "").trim();
      const password = parsed.data.password;
      const loginIp = callerIpFromReq(req) ?? null;

      // WARP-579 finding 3: when the caller IP can't be resolved (misconfigured
      // `trust proxy`, unix-socket transport), the per-IP brute-force gate below
      // is silently inactive — `loginIp` is null so no per-IP lock is checked or
      // recorded, leaving only the per-account gate. Surface the degraded state
      // exactly once per affected request so operators can spot a misconfigured
      // proxy instead of discovering the per-IP gate is off only after an
      // incident. We keep serving the request (the per-account gate still
      // applies, and hard-failing would break unix-socket health checks); this
      // is the observability fix, not a hard fail-closed.
      if (!loginIp) {
        logger.warn(
          { route: "/auth/login" },
          "per-IP login brute-force throttle inactive: caller IP unresolved " +
            "(check `trust proxy` / transport); only the per-account gate applies",
        );
      }

      // WARP-579 — progressive brute-force throttle BEFORE any verify work.
      // Without this the public /auth/login route is an unbounded
      // password-guessing oracle. Two independent gates (per-IP and
      // per-account) — either one locked → 429, never spend a verify. The
      // 429 is returned regardless of whether the account exists, so the
      // throttle leaks no enumeration signal.
      const ipLock = loginIp
        ? await checkLoginLock(loginIpLockKey(loginIp))
        : { locked: false, retryAfterSeconds: 0 };
      const accountLock = await checkLoginLock(loginAccountLockKey(loginEmail));
      if (ipLock.locked || accountLock.locked) {
        const retryAfterSeconds = Math.max(
          ipLock.retryAfterSeconds,
          accountLock.retryAfterSeconds,
        );
        await recordActivity({
          kind: "auth",
          severity: "warn",
          sourceIcon: "shield-alert",
          what: "Sign-in throttled",
          sub: `${loginEmail} • ${loginIp ?? "unknown"}`,
          refs: {
            outcome: "too_many_attempts",
            username: loginEmail,
            ip: loginIp,
          },
        });
        res
          .status(429)
          .set("Retry-After", String(retryAfterSeconds))
          .json({
            error: "Too many attempts. Try again shortly.",
            code: "TOO_MANY_ATTEMPTS",
            retryAfterSeconds,
          });
        return;
      }

      // Shared failure path. Identical status + body for every
      // unsuccessful branch (unknown email, no password set, wrong
      // password) so an attacker can't enumerate registered emails by
      // diffing the response. The `username` label in the audit row is
      // the attempted login identifier; the password never reaches the
      // recorder. WARP-579: each unsuccessful attempt bumps BOTH the
      // per-IP and per-account failure counters (escalating lockout).
      const denyInvalid = async (attempted: string): Promise<void> => {
        if (loginIp) {
          await recordLoginFailure(
            loginIpFailsKey(loginIp),
            loginIpLockKey(loginIp),
            LOGIN_IP_FREE_TIER,
          );
        }
        await recordLoginFailure(
          loginAccountFailsKey(loginEmail),
          loginAccountLockKey(loginEmail),
          LOGIN_ACCOUNT_FREE_TIER,
        );
        await recordActivity({
          kind: "auth",
          severity: "warn",
          sourceIcon: "shield-alert",
          what: "Sign-in failed",
          sub: `${attempted} • ${callerIpFromReq(req) ?? "unknown"}`,
          refs: {
            outcome: "invalid_credentials",
            username: attempted,
            ip: callerIpFromReq(req) ?? null,
          },
        });
        res.status(401).json({ error: "Invalid credentials" });
      };

      // The shim createAuthRouter() wires the public router without
      // prisma. Without the directory we can't authenticate anyone — but
      // we still spend a dummy verify so this branch is timing-comparable
      // to a real lookup, then deny with the identical error.
      if (!prisma) {
        logger.warn(
          "Directory login: prisma not wired into public auth router; failing closed (ADR-013)",
        );
        await verifyDummyPassword(password);
        await denyInvalid(loginEmail);
        return;
      }

      // Resolve the directory user by email. On a miss, still run an
      // argon2id verify against a dummy hash so the unknown-email branch
      // costs roughly the same wall-clock as the wrong-password branch
      // (anti-enumeration). A user without a passwordHash (service-only
      // principal, pre-first-login invitee) is treated identically — no
      // leak distinguishing "no account" from "account, no password".
      const localUser = await prisma.user.findUnique({
        where: { email: loginEmail },
      });
      // WARP (SCIM directory sync): a user the directory deactivated
      // (Okta SCIM `active:false` → `directoryStatus = DEACTIVATED`, a SOFT
      // disable, never a row delete) must be denied even if the row + hash
      // still exist. Fold it into the SAME shared deny branch as
      // unknown-email / null-hash so a deactivated account is
      // wire-indistinguishable from a non-existent one (no oracle for "this
      // email exists but is disabled") and the timing matches (dummy verify
      // spent, real argon2id verify never runs).
      if (
        !localUser ||
        !localUser.passwordHash ||
        localUser.directoryStatus === "DEACTIVATED"
      ) {
        await verifyDummyPassword(password);
        await denyInvalid(loginEmail);
        return;
      }

      const ok = await verifyPassword(localUser.passwordHash, password);
      if (!ok) {
        await denyInvalid(loginEmail);
        return;
      }

      // WARP-579 finding 1: the password verified, but the login is NOT yet
      // complete if this user has a second factor. We must NOT clear the
      // throttle state here — doing so before the TOTP gate let an attacker
      // who knew a valid password brute-force all ~10^6 TOTP codes with no
      // lockout (the TOTP-failure path never re-armed the throttle). The clear
      // now happens ONLY after the COMPLETE login succeeds (below), and a TOTP
      // failure is recorded as a login failure so it accrues toward the same
      // account/IP lockout that guards the password gate.

      const userId = localUser.id; // local UUID — fed into JWT.sub + NC store key
      const username = localUser.username; // human-readable handle (display + audit only)
      const displayName = localUser.displayName;
      const role: Role = localUser.role as Role;

      // ── PR #375 — second-factor gate ──────────────────────────────────
      // The password verified. If this user has TOTP ENABLED
      // (TotpCredential.confirmedAt non-null — explicit enablement column,
      // never IS-NULL inference), require a valid TOTP code OR an unused
      // recovery code from the login body BEFORE issuing the session. A
      // pending (unconfirmed) enrollment does NOT gate login. The gate runs
      // before Nextcloud provisioning + token issuance so a failed second
      // factor mints nothing.
      //
      // On a successful challenge we stamp `mfaStampIso` into the access
      // token (signAccessToken) so require-recent-mfa (WARP-230) can gate
      // sensitive routes for this session.
      let mfaStampIso: string | undefined;
      const totpCred = await prisma.totpCredential.findUnique({
        where: { userId },
      });
      if (totpCred && totpCred.confirmedAt) {
        const totpCode =
          typeof parsed.data.totp === "string" ? parsed.data.totp.trim() : "";
        const recoveryCode =
          typeof parsed.data.recoveryCode === "string"
            ? parsed.data.recoveryCode
            : "";

        let secondFactorOk = false;

        if (totpCode) {
          const secret = decryptTotpSecret(totpCred.secretEnc);
          secondFactorOk = await verifyTotpCode(secret, totpCode);
        } else if (recoveryCode) {
          // Match against the user's UNUSED codes only; consume exactly the
          // matched row so a replay of the same code finds nothing.
          const unused = await prisma.recoveryCode.findMany({
            where: { userId, usedAt: null },
          });
          const matchHash = await findMatchingRecoveryCodeHash(
            recoveryCode,
            unused.map((r) => r.codeHash),
          );
          if (matchHash) {
            const consumed = unused.find((r) => r.codeHash === matchHash);
            if (consumed) {
              // Atomic single-use: only flip the row if it is STILL unused.
              // Two concurrent logins presenting the same code both read it
              // unused above; the usedAt:null guard means exactly one update
              // flips a row (count 1) and the loser sees count 0 → the factor
              // fails. Mirrors claimRefreshRotation / invite single-use.
              const claimed = await prisma.recoveryCode.updateMany({
                where: { id: consumed.id, usedAt: null },
                data: { usedAt: new Date() },
              });
              secondFactorOk = claimed.count > 0;
            }
          }
        }

        if (!secondFactorOk) {
          // WARP-579 finding 1: a wrong second factor IS a failed login attempt
          // for throttling purposes. Without this, an attacker holding a valid
          // password could spin through ~10^6 TOTP codes with no lockout. Bump
          // the SAME per-account (and per-IP when resolvable) failure counters
          // that guard the password gate, so repeated wrong-TOTP attempts
          // escalate to a 429 at the top of the handler exactly like wrong
          // passwords do. The counters are cleared only on a fully-successful
          // login below.
          if (loginIp) {
            await recordLoginFailure(
              loginIpFailsKey(loginIp),
              loginIpLockKey(loginIp),
              LOGIN_IP_FREE_TIER,
            );
          }
          await recordLoginFailure(
            loginAccountFailsKey(loginEmail),
            loginAccountLockKey(loginEmail),
            LOGIN_ACCOUNT_FREE_TIER,
          );
          // Distinguishable from "Invalid credentials" so the dashboard can
          // prompt for the code instead of treating it as a bad password.
          // The password was already correct, so this leaks no enumeration
          // signal a logged-in attacker doesn't already have.
          await recordActivity({
            kind: "auth",
            severity: "warn",
            sourceIcon: "shield-alert",
            what: "Two-factor challenge failed",
            sub: `${username} • ${callerIpFromReq(req) ?? "unknown"}`,
            refs: {
              outcome: "totp_required",
              userId,
              username,
              ip: callerIpFromReq(req) ?? null,
            },
          });
          res.status(401).json({
            error: "Two-factor authentication required",
            code: "TOTP_REQUIRED",
          });
          return;
        }

        mfaStampIso = new Date().toISOString();
      }

      // WARP-579 finding 1 + 2: the login is now COMPLETE (password verified AND
      // — if enabled — the second factor satisfied). Clear the brute-force
      // throttle for THIS account only, so a legitimate user who fat-fingered
      // their password or TOTP a few times isn't held under a stale lock next
      // session. We intentionally leave the per-IP counters to decay via their
      // own TTL (finding 2) so one account's success can't wipe the shared per-IP
      // failure state guarding other accounts on the same NAT.
      await clearLoginAccountRateState(loginEmail);

      // Downstream provisioning (NOT authentication): ensure the caller
      // has a live Nextcloud app-password so Files/WebDAV keep working.
      // The directory already authenticated them; if Nextcloud is down or
      // the account isn't provisioned yet, we log and continue — login
      // must not fail just because the WebDAV side is unavailable. The
      // same NC password is provisioned downstream at account creation,
      // so credential-based session minting is a provisioning detail.
      const ncUsername = localUser.nextcloudUsername ?? username;
      try {
        const ncSession = await ncLoginWithCredentials(ncUsername, password);
        if (ncSession) {
          // Keyed by the local User.id UUID so logout's
          // getNcToken(req.user.id) hits the same slot (WARP-485).
          await storeNcToken(userId, ncSession.token, REFRESH_TOKEN_TTL_SECONDS);
        } else {
          logger.warn(
            { userId },
            "Directory login: Nextcloud session could not be provisioned; WebDAV will be unavailable until next login (ADR-013)",
          );
        }
      } catch (err) {
        // Non-fatal — the directory is the source of truth. Surface in
        // logs so on-call can spot a degraded WebDAV provisioning path.
        logger.error(
          { err, userId },
          "Directory login: downstream Nextcloud provisioning failed (non-fatal)",
        );
      }

      // Issue JWT access + refresh tokens. The access token carries the
      // MFA stamp (PR #375) when a second factor was just satisfied.
      const accessToken = signAccessToken({
        id: userId,
        username,
        displayName,
        role,
        lastMfaAt: mfaStampIso,
      });
      const refreshToken = signRefreshToken({ id: userId, username, displayName, role });
      // WARP-116: index this refresh token so an admin "revoke now" (role
      // change / disable) can denylist every live device session for the user.
      await registerRefreshSession(userId, refreshToken);

      const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";

      // Access token in session cookie
      res.cookie(SESSION_COOKIE_NAME, accessToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/",
        maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
      });

      // Refresh token in separate cookie (scoped to /api/auth)
      res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/api/auth",
        maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
      });

      // WARP-456: successful sign-in audit row.
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "log-in",
        what: `${displayName} signed in`,
        sub: `${role} • ${callerIpFromReq(req) ?? "unknown"}`,
        refs: {
          outcome: "success",
          userId,
          username,
          role,
          ip: callerIpFromReq(req) ?? null,
        },
      });

      // ADR-008 §3 + action item #2: native mobile clients can't read
      // httpOnly Set-Cookie headers reliably (URLSession on iOS hides
      // them; Android's OkHttp can but it's ugly). When the caller
      // opts in with `?return=body=1`, return the JWTs in the JSON
      // body too. The cookies are STILL set so browsers behave
      // unchanged. No behavior change for any existing caller — the
      // body field is only added when the query param is present.
      const wantBody = req.query.return === "body" || req.query.return === "body=1";
      res.json({
        // WARP-824: surface the explicit forced-change flag so the dashboard
        // redirects an admin-created temp-password user to the change-password
        // screen. This is a UX convenience — the post-auth gate enforces it
        // server-side regardless of whether the client honours the redirect.
        user: { id: userId, username, displayName, role, mustChangePassword: localUser.mustChangePassword },
        ...(wantBody
          ? {
              accessToken,
              refreshToken,
              accessTokenExpiresAt:
                Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
              refreshTokenExpiresAt:
                Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS,
            }
          : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── OAuth2: Redirect to Nextcloud authorization ──
  router.get("/auth/authorize", async (req, res) => {
    if (config.AUTH_MODE !== "oauth2" || !config.OAUTH2_CLIENT_ID) {
      res.status(400).json({ error: "OAuth2 is not configured. Set AUTH_MODE=oauth2 and provide OAUTH2_CLIENT_ID." });
      return;
    }

    const state = randomBytes(16).toString("hex");
    const redirectUri = await getRedirectUri(req);

    // Store state in a short-lived cookie for CSRF protection
    const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.cookie("oauth2_state", state, {
      httpOnly: true,
      secure: isHttps,
      sameSite: "lax",
      maxAge: 300_000, // 5 minutes
    });

    const authorizeUrl = ncOAuth2AuthorizeUrl(config.OAUTH2_CLIENT_ID, redirectUri, state);
    res.redirect(authorizeUrl);
  });

  // ── OAuth2: Handle callback ──
  router.get("/auth/callback", async (req, res, next) => {
    try {
      if (config.AUTH_MODE !== "oauth2" || !config.OAUTH2_CLIENT_ID) {
        res.status(400).json({ error: "OAuth2 is not configured" });
        return;
      }

      const { code, state } = req.query;
      const savedState = req.cookies?.oauth2_state;

      // CSRF validation
      if (!state || !savedState || state !== savedState) {
        res.status(400).json({ error: "Invalid OAuth2 state parameter" });
        return;
      }

      // Clear the state cookie
      res.clearCookie("oauth2_state");

      if (!code || typeof code !== "string") {
        res.status(400).json({ error: "Missing authorization code" });
        return;
      }

      // Same shared, host-validated redirect_uri the authorize step used — the
      // OAuth2 token exchange requires it to be byte-identical (PR #486 finding 2).
      const redirectUri = await getRedirectUri(req);

      const tokens = await ncOAuth2ExchangeCode(
        code,
        config.OAUTH2_CLIENT_ID,
        config.OAUTH2_CLIENT_SECRET,
        redirectUri
      );

      if (!tokens) {
        res.status(401).json({ error: "Failed to exchange authorization code" });
        return;
      }

      // Fetch user details with the new access token
      const user = await ncGetCurrentUser(tokens.accessToken);

      // Store tokens in HTTP-only cookies
      const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
      res.cookie(SESSION_COOKIE_NAME, tokens.accessToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/",
        maxAge: tokens.expiresIn * 1000,
      });

      res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
        httpOnly: true,
        secure: isHttps,
        sameSite: "lax",
        path: "/api/auth",
        maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
      });

      // Redirect to dashboard with user info (or return JSON for API clients)
      if (req.headers.accept?.includes("text/html")) {
        res.redirect("/");
      } else {
        res.json({
          user: user || { id: "unknown", username: "unknown", displayName: "Unknown" },
        });
      }
    } catch (err) {
      next(err);
    }
  });

  // ── Refresh: exchange refresh token for new access token ──
  router.post("/auth/refresh", async (req, res, next) => {
    try {
      // ADR-008: native clients (iOS / Android / Tauri Win) POST the
      // refresh token in the JSON body since they can't read httpOnly
      // cookies. Browsers continue to use the REFRESH_COOKIE_NAME cookie
      // set by /auth/login. Body takes precedence if both are present
      // so a mobile client deliberately rotating doesn't get blocked by
      // a stale cookie.
      const refreshTokenBody =
        typeof req.body?.refreshToken === "string" ? req.body.refreshToken : null;
      const refreshTokenCookie = req.cookies?.[REFRESH_COOKIE_NAME] ?? null;
      const refreshTokenInput = refreshTokenBody ?? refreshTokenCookie;
      if (!refreshTokenInput) {
        res.status(401).json({ error: "No refresh token available" });
        return;
      }

      // --- Try JWT refresh first ---
      const refreshResult = await verifyRefreshToken(refreshTokenInput);
      if (refreshResult) {
        // Claim exclusive rotation rights before issuing new tokens. If
        // another concurrent /auth/refresh call (e.g. a browser double-submit
        // on flaky networks) already claimed this token, reject to prevent
        // two valid token pairs from being issued for the same refresh token.
        const claimed = await claimRefreshRotation(refreshTokenInput);
        if (!claimed) {
          res.status(401).json({ error: "Refresh token is already being rotated" });
          return;
        }

        const { sub, username, displayName, role } = refreshResult;

        // WARP-485 round 2 — re-validate that the local User row backing
        // this refresh token still exists before rotating. Three things
        // this catches:
        //   1. Owner removed the user via /api/people mid-session — the
        //      stale cookie must not silently mint fresh credentials.
        //   2. Legacy refresh tokens issued pre-WARP-485 carry the NC
        //      username in `sub` (not a UUID); `findUnique({ id: sub })`
        //      returns null on those, invalidating them so the holder
        //      re-logs in and gets a properly-shaped token pair. This is
        //      the deliberate cache-bump for the JWT layer.
        //   3. Defense in depth against forged tokens that somehow
        //      verify but reference no real user.
        // Fail-closed with the same error code as the OCS path so the
        // dashboard's auth-error handler can branch consistently.
        if (!prisma) {
          logger.warn(
            { sub },
            "JWT refresh: prisma not wired into public auth router; failing closed (WARP-485 round 2)",
          );
          // Deny the token that was actually presented — body-sourced for
          // native clients (ADR-008), cookie for browsers. Denying only the
          // cookie left a body token replayable after its rotation claim
          // expired.
          await denyRefreshToken(refreshTokenInput);
          res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
          res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
          res.status(401).json({
            error: "User not provisioned. Please log in again.",
            code: "USER_NOT_PROVISIONED",
          });
          return;
        }
        const localUser = await prisma.user.findUnique({ where: { id: sub } });
        // Fail closed when the backing row is gone OR the directory deactivated
        // it (SCIM `active:false` / DELETE → DEACTIVATED, soft). A row-existence
        // check alone let a still-valid refresh token keep minting fresh
        // credentials for an offboarded user; mirror the DEACTIVATED gate the
        // /auth/login, SSO, and WebAuthn paths already enforce.
        if (!localUser || localUser.directoryStatus === "DEACTIVATED") {
          logger.warn(
            { sub, deactivated: localUser?.directoryStatus === "DEACTIVATED" },
            "JWT refresh: no usable User row for refresh-token subject (missing or deactivated); refusing rotation (WARP-485 round 2)",
          );
          // Burn the old refresh token so a retry can't re-enter this
          // branch repeatedly — denylist entry auto-expires with the
          // token's own TTL. Must be the token actually presented
          // (body-sourced for ADR-008 native clients, cookie for browsers).
          await denyRefreshToken(refreshTokenInput);
          res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
          res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
          res.status(401).json({
            error: "User not provisioned. Please log in again.",
            code: "USER_NOT_PROVISIONED",
          });
          return;
        }

        // WARP-116 (review fix 1): re-derive the role from the authoritative
        // DB row, NOT from the role carried in the old refresh token. A
        // session that escapes the denylist (the revoke-after-clear race, or a
        // Redis outage that drops the best-effort deny write) would otherwise
        // keep its stale — possibly higher — role for the full 7-day refresh
        // TTL, partially defeating the "immediate propagation" promise.
        // Precedence: DB role wins; the token-carried `role` is only a fallback
        // for a legitimate rotation where the local row somehow lacks a role
        // (defensive — `localUser` is non-null and gated past the !localUser /
        // DEACTIVATED check above, so this fallback is belt-and-suspenders).
        const effectiveRole: Role = (localUser.role as Role) ?? role;

        // Rotate: denylist the old refresh token (overwrites the short-TTL
        // rotation claim with a full-lifetime entry) and issue a new pair.
        await denyRefreshToken(refreshTokenInput);
        // WARP-116: keep the session index in lockstep with rotation — drop
        // the old token's member, add the new one — so a later "revoke now"
        // walks live tokens only and never re-denylists a rotated-out hash.
        await unregisterRefreshSession(sub, refreshTokenInput);
        const newRefreshToken = signRefreshToken({ id: sub, username, displayName, role: effectiveRole });
        const newAccessToken = signAccessToken({ id: sub, username, displayName, role: effectiveRole });
        await registerRefreshSession(sub, newRefreshToken);

        // Extend the NC session token's TTL so it doesn't expire mid-session
        // (the user would otherwise see silent 401s on /api/files after the
        // original 7-day window elapses even though their JWT is fresh).
        await touchNcToken(sub, REFRESH_TOKEN_TTL_SECONDS);

        const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
        res.cookie(SESSION_COOKIE_NAME, newAccessToken, {
          httpOnly: true,
          secure: isHttps,
          sameSite: "lax",
          path: "/",
          maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
        });
        res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, {
          httpOnly: true,
          secure: isHttps,
          sameSite: "lax",
          path: "/api/auth",
          maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
        });

        // Native clients want the new tokens in body since they can't
        // read Set-Cookie. Always include them — browsers ignore the
        // body's accessToken (they use the cookie that was just set
        // above), so this is non-breaking.
        res.json({
          status: "ok",
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          accessTokenExpiresAt:
            Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
          refreshTokenExpiresAt:
            Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS,
        });
        return;
      }

      // --- Fallback: OAuth2 refresh (legacy Nextcloud tokens) ---
      if (config.AUTH_MODE === "oauth2" && config.OAUTH2_CLIENT_ID) {
        const tokens = await ncOAuth2RefreshToken(
          refreshTokenInput,
          config.OAUTH2_CLIENT_ID,
          config.OAUTH2_CLIENT_SECRET
        );

        if (!tokens) {
          res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
          res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
          res.status(401).json({ error: "Failed to refresh token" });
          return;
        }

        const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
        res.cookie(SESSION_COOKIE_NAME, tokens.accessToken, {
          httpOnly: true,
          secure: isHttps,
          sameSite: "lax",
          path: "/",
          maxAge: tokens.expiresIn * 1000,
        });

        res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
          httpOnly: true,
          secure: isHttps,
          sameSite: "lax",
          path: "/api/auth",
          maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
        });

        res.json({ status: "ok", expiresIn: tokens.expiresIn });
        return;
      }

      // Neither JWT nor OAuth2 could handle the token
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
      res.status(401).json({ error: "Invalid or expired refresh token" });
    } catch (err) {
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────
  // WARP-217 — Public invite-accept endpoints
  //
  // These two are mounted on the PUBLIC router because the invitee, by
  // definition, has no Droplet account yet. The token in the URL is the
  // sole authentication. We never echo the stored token back, never log
  // it, and compare it in constant time inside `findInviteByToken`.
  //
  //   GET  /api/auth/invites/accept/:token   — fetch invite metadata
  //   POST /api/auth/invites/accept/:token   — set password + create NC user
  //
  // State-machine returns:
  //   - 404 (not-found / revoked — both leak the same info to clients)
  //   - 410 GONE  with code "USED" or "EXPIRED"
  //   - 200 / 400 (bad password) / 500 (Nextcloud failure)
  // ────────────────────────────────────────────────────────────
  router.get("/auth/invites/accept/:token", async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(404).json({ error: "Invite not found" });
        return;
      }
      const invite = await findInviteByToken(prisma, req.params.token);
      if (!invite || isRevoked(invite)) {
        res.status(404).json({ error: "Invite not found" });
        return;
      }
      if (isUsed(invite)) {
        res.status(410).json({ error: "This invite has already been used", code: "USED" });
        return;
      }
      if (isExpired(invite)) {
        res.status(410).json({ error: "This invite has expired", code: "EXPIRED" });
        return;
      }
      res.json({
        username: invite.username,
        displayName: invite.displayName,
        role: invite.role,
        expiresAt: invite.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/invites/accept/:token", async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(404).json({ error: "Invite not found" });
        return;
      }
      const parsed = acceptInviteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "That password doesn't meet the requirements.",
          code: "INVALID_PASSWORD",
        });
        return;
      }
      const { password } = parsed.data;

      const invite = await findInviteByToken(prisma, req.params.token);
      if (!invite || isRevoked(invite)) {
        res.status(404).json({ error: "Invite not found" });
        return;
      }
      if (isUsed(invite)) {
        res.status(410).json({ error: "This invite has already been used", code: "USED" });
        return;
      }
      if (isExpired(invite)) {
        res.status(410).json({ error: "This invite has expired", code: "EXPIRED" });
        return;
      }

      // Defense in depth: re-validate the username at accept time. The
      // create endpoint already runs this check, but a stale row that was
      // somehow hand-edited (or migrated in from elsewhere) must not be
      // able to land a reserved username.
      const usernameCheck = usernameField.safeParse(invite.username);
      if (!usernameCheck.success) {
        res.status(400).json({ error: "Invite has an invalid username" });
        return;
      }

      // Build the Nextcloud groups list from the invite's role.
      // WARP-171: the invite role is now the canonical Role enum (was
      // a free-form String). The mapping below preserves the
      // pre-WARP-171 wire contract — "admin" invitee still lands in
      // the Nextcloud "admin" group, which roleFromGroups() turns
      // back into the "owner" session role on first login. The new
      // enum values get explicit mappings so future invites can ask
      // for them without ambiguity. `family` (formerly "user") is
      // the empty-groups default so a regular household member lands
      // in Nextcloud's default group set.
      //
      // WARP-883: ADDITIONALLY add the household group so the shared
      // "Household" group folder (groupfolders) mounts into the invitee's
      // home. buildNcGroups preserves the pre-WARP-883 role→group mapping and
      // appends the household group without duplication.
      const groups: string[] = buildNcGroups(
        invite.role as Role,
        householdGroupName(config.DROPLET_SHARED_FOLDER_NAME),
      );

      try {
        await ncCreateUser(
          // Use the configured admin token from env. No request-bound NC
          // token is available since the invitee isn't logged in yet.
          process.env.NEXTCLOUD_ADMIN_TOKEN ||
            Buffer.from(
              `${process.env.NEXTCLOUD_ADMIN_USER || "admin"}:${process.env.NEXTCLOUD_ADMIN_PASSWORD || ""}`,
            ).toString("base64"),
          invite.username,
          password,
          invite.displayName || undefined,
          groups,
        );
      } catch (err: any) {
        logger.error({ err, username: invite.username }, "Failed to create user from invite");
        // Typed-error path: NextcloudUserExistsError carries ocsStatus=102
        // and lets us detect user-exists without sniffing message strings.
        if (err instanceof NextcloudUserExistsError) {
          res.status(409).json({ error: "A user with this username already exists" });
          return;
        }
        res.status(500).json({ error: "Could not create your account. Please try again or ask the admin who invited you." });
        return;
      }

      // Mark the invite accepted BEFORE we issue cookies — this is the
      // single-use enforcement point. A concurrent second POST will see
      // acceptedAt non-null and 410. The DB unique-on-token + this
      // single-row update keeps the race window small (Prisma's update is
      // not transactional with the ncCreateUser call, but Nextcloud's
      // own statuscode 102 catches the user-exists race).
      const acceptedFrom = getRequestIp(req);
      await prisma.userInvite.update({
        where: { id: invite.id },
        data: {
          acceptedAt: new Date(),
          acceptedFrom: acceptedFrom ?? undefined,
        },
      });

      // Auto-login the invitee — same shape as /api/auth/login.
      // WARP-171: preserve the pre-WARP-171 wire contract — "admin"
      // invitee gets an "owner" session role (the original two-value
      // semantics) — and add direct passthrough for the three new
      // enum values an invite can now request explicitly.
      const role: Role =
        invite.role === "owner" || invite.role === "admin"
          ? "owner"
          : invite.role === "guest"
            ? "guest"
            : "family";

      // WARP-485 round 2 — provision the local User row mapping this
      // Nextcloud identity to a local UUID BEFORE signing the JWT, so
      // `JWT.sub = localUser.id` (UUID) instead of the invite username
      // string. Without this step, the invitee's first session would
      // ship the bypassable shape we just fixed on /auth/login.
      //
      // Upsert (not create) so concurrent invite-accept POSTs that race
      // through `await prisma.userInvite.update` don't trip
      // P2002-unique on `nextcloudUsername` — the second caller still
      // sees the existing row and gets a properly-shaped JWT.
      //
      // The User.role column uses the canonical Role enum value from
      // the invite (so DB-level RBAC matches the operator's intent on
      // the create endpoint); the JWT session `role` keeps the legacy
      // mapping above (admin invite → owner session) which existing
      // routes still depend on.
      // ADR-013 (PR #374): this email lands directly in User.email — the
      // case-sensitive unique-indexed login key. createInviteSchema already
      // normalizes new invites, but re-normalize here as defense in depth so
      // a stale (pre-fix) or hand-edited invite row can't plant a row whose
      // email casing breaks the email-keyed /auth/login lookup.
      // An invite predating the email-normalization fix may carry email: null,
      // which the email-keyed /auth/login cannot match (operator remediation: re-invite).
      const inviteEmail = invite.email
        ? invite.email.trim().toLowerCase()
        : null;
      // ADR-013: the built-in argon2id directory is the auth source of
      // truth, so the invitee's passwordHash is written HERE — exactly as
      // /auth/setup does for the first owner. Nextcloud was already
      // provisioned above (ncCreateUser) with the same plaintext for
      // downstream WebDAV, but it no longer authenticates anyone:
      // /auth/login verifies THIS hash, keyed by email. Without this write
      // the invitee lands with passwordHash = null and the email-keyed
      // login fails closed — an accepted invite that can never sign in.
      // The plaintext is hashed before it touches the row and never logged.
      const passwordHash = await hashPassword(password);
      const userRow = await prisma.user.upsert({
        where: { nextcloudUsername: invite.username },
        update: {
          // If a row already exists, keep its UUID — the invite-accept
          // is essentially a re-acceptance of the same identity (rare
          // but possible under retry). Refresh `displayName` from the
          // invite in case the operator updated it, and refresh the
          // credential so a retry never leaves a stale or absent hash.
          // Also refresh `email` (the email-keyed login key) so a
          // re-acceptance always lands the correct login identifier.
          displayName: invite.displayName || invite.username,
          email: inviteEmail,
          passwordHash,
        },
        create: {
          username: invite.username,
          displayName: invite.displayName || invite.username,
          email: inviteEmail,
          nextcloudUsername: invite.username,
          passwordHash,
          role: invite.role as any, // canonical Role enum from the invite
          // `isLocal` defaults to true in the schema; mirror-from-NC
          // would only flip false for setup-time admins.
        },
      });
      const userId = userRow.id; // local UUID — fed into JWT.sub

      const accessToken = signAccessToken({
        id: userId,
        username: invite.username,
        displayName: invite.displayName || invite.username,
        role,
      });
      const refreshToken = signRefreshToken({
        id: userId,
        username: invite.username,
        displayName: invite.displayName || invite.username,
        role,
      });
      // WARP-116: index the invite-accept auto-login session too.
      await registerRefreshSession(userId, refreshToken);

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

      logger.info(
        { username: invite.username, role: invite.role, invitedBy: invite.createdBy },
        "Invite accepted",
      );

      res.json({
        user: {
          id: userId,
          username: invite.username,
          displayName: invite.displayName || invite.username,
          role,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ────────────────────────────────────────────────────────────────
// Protected auth routes — mounted AFTER the auth middleware
// so req.user is populated by the middleware.
// ────────────────────────────────────────────────────────────────
export function createProtectedAuthRouter(
  prisma?: import("@prisma/client").PrismaClient,
  sendOptions: import("../services/email-channel.service.js").SendOptions = {},
): Router {
  const router = Router();

  // ── Get current user info ──
  router.get("/auth/me", async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      // WARP-824: read the forced-change flag FRESH from the row (not the JWT
      // claim) so a hard refresh after sign-in still knows the user is gated,
      // and so it flips to false the instant the change-password call clears
      // it. Service principals have no directory row → treated as not gated.
      // Fail-soft to false if prisma isn't wired (legacy shim) or the row is
      // gone — the post-auth gate is the authoritative enforcement layer.
      let mustChangePassword = false;
      if (prisma && req.user.role !== "service") {
        try {
          const row = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { mustChangePassword: true },
          });
          mustChangePassword = row?.mustChangePassword ?? false;
        } catch {
          mustChangePassword = false;
        }
      }

      res.json({
        id: req.user.id,
        username: req.user.username,
        displayName: req.user.displayName,
        role: req.user.role,
        mustChangePassword,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── WARP-824 — self-service password change ──
  // Any authenticated user can rotate their own password here; an
  // admin-created user holding a temporary password MUST come through here
  // before the forced-change gate lets them reach anything else. Verifies the
  // current password (a session cookie alone is not enough), enforces the
  // shared policy on the new one, writes a fresh argon2id hash, and CLEARS the
  // explicit `mustChangePassword` flag. Mirrors the local-directory model
  // (ADR-013): the built-in argon2id hash is the auth source of truth, so the
  // change lands on `User.passwordHash` directly. Nextcloud is mirrored
  // downstream for WebDAV but is NOT consulted for the gate.
  router.post("/auth/change-password", async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      if (!prisma) {
        // Mirrors the create/login fail-closed posture for the legacy shim:
        // without the directory we cannot verify or persist a password.
        logger.error(
          "change-password: prisma not wired into protected auth router; cannot rotate password",
        );
        res.status(500).json({
          error: "Server misconfigured: local user database not wired",
          code: "USERS_NO_PRISMA",
        });
        return;
      }

      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        const fieldErrors = parsed.error.flatten().fieldErrors;
        if (fieldErrors.newPassword?.length) {
          res
            .status(400)
            .json({ error: "Password does not meet policy requirements", code: "WEAK_PASSWORD" });
          return;
        }
        res.status(400).json({ error: "Current and new password are required", code: "INVALID_REQUEST" });
        return;
      }

      const { currentPassword, newPassword } = parsed.data;

      // Progressive lock BEFORE any verify work (PR #549 reviewer follow-up):
      // without this, a hijacked session can brute-force the current password
      // unbounded — change-password is the one authenticated surface where
      // the password itself is the thing being guessed.
      const lock = await checkPasswordChangeLock(req.user.id);
      if (lock.locked) {
        res
          .status(429)
          .set("Retry-After", String(lock.retryAfterSeconds))
          .json({
            error: "Too many attempts. Try again shortly.",
            code: "TOO_MANY_ATTEMPTS",
            retryAfterSeconds: lock.retryAfterSeconds,
          });
        return;
      }

      const localUser = await prisma.user.findUnique({
        where: { id: req.user.id },
      });
      // A session whose row vanished (deleted mid-flight) or a service-only
      // row with no hash cannot rotate a password. Fail closed.
      if (!localUser || !localUser.passwordHash) {
        res.status(400).json({ error: "Invalid current password", code: "INVALID_PASSWORD" });
        return;
      }

      const ok = await verifyPassword(localUser.passwordHash, currentPassword);
      if (!ok) {
        await recordPasswordChangeFailure(req.user.id);
        res.status(400).json({ error: "Invalid current password", code: "INVALID_PASSWORD" });
        return;
      }

      // A no-op "change" (new === current) is not a real rotation — reject it
      // before touching the hash so a forced-change user can't satisfy the
      // gate by re-entering the temp password. Checked AFTER the current
      // password is verified: the endpoint must answer nothing about the
      // submitted strings to a caller who hasn't proven the current password
      // (PR #549 reviewer follow-up — ordering half of the oracle finding).
      // clearPasswordChangeRateState is called AFTER this check so a caller
      // submitting (correct, correct) cannot drain the failure counter without
      // completing a real rotation (finding from 2026-06-10 sweep).
      if (currentPassword === newPassword) {
        res
          .status(400)
          .json({ error: "Choose a password different from your current one", code: "SAME_PASSWORD" });
        return;
      }
      await clearPasswordChangeRateState(req.user.id);

      // ADR-013: write the new argon2id hash to the directory row AND clear the
      // forced-change flag in the SAME update so the gate opens atomically with
      // the credential change.
      const newHash = await hashPassword(newPassword);
      await prisma.user.update({
        where: { id: localUser.id },
        data: { passwordHash: newHash, mustChangePassword: false },
      });

      // Mirror the new password downstream to Nextcloud for WebDAV (best
      // effort — the directory is the source of truth, so a failed mirror must
      // not fail the rotation; the next login re-provisions the NC session).
      const ncUsername = localUser.nextcloudUsername ?? localUser.username;
      const token = await resolveNcToken(req);
      if (token) {
        try {
          await ncUpdateUser(token, ncUsername, "password", newPassword);
        } catch (err) {
          logger.warn(
            { err, userId: localUser.id },
            "change-password: downstream Nextcloud password mirror failed (non-fatal)",
          );
        }
      }

      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "key-round",
        what: `${localUser.displayName} changed their password`,
        sub: callerIpFromReq(req) ?? "unknown",
        refs: {
          outcome: "password_changed",
          userId: localUser.id,
          username: localUser.username,
          ip: callerIpFromReq(req) ?? null,
        },
      });

      res.json({ status: "ok" });
    } catch (err) {
      next(err);
    }
  });

  // ── PR #375 — TOTP enrollment ──
  // Mint a fresh secret, store it ENCRYPTED (never plaintext, never logged),
  // and hand back the otpauth:// URI + a QR data-URL for the authenticator
  // app. The factor is NOT active until POST /auth/totp/verify confirms a
  // code (confirmedAt). Re-enrolling before confirmation re-mints the
  // pending secret; once the factor is enabled this 409s rather than
  // silently rotating a working secret out from under the user.
  router.post("/auth/totp/enroll", async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      if (!prisma) {
        res.status(500).json({ error: "TOTP unavailable: database not wired" });
        return;
      }
      const userId = req.user.id;

      const existing = await prisma.totpCredential.findUnique({
        where: { userId },
      });
      if (existing?.confirmedAt) {
        res.status(409).json({
          error: "Two-factor authentication is already enabled.",
          code: "TOTP_ALREADY_ENABLED",
        });
        return;
      }

      // Label the authenticator entry with the user's email when present,
      // else the username — both are non-secret display identifiers.
      const label = req.user.username;
      const { secret, otpauthUri } = generateTotpEnrollment(label);
      const secretEnc = encryptTotpSecret(secret);

      // Upsert the pending credential. confirmedAt stays null until verify.
      await prisma.totpCredential.upsert({
        where: { userId },
        create: { userId, secretEnc, confirmedAt: null },
        update: { secretEnc, confirmedAt: null },
      });

      // Clear any recovery codes from a PRIOR confirmed-then-disabled TOTP
      // credential. The invariant is "recovery codes exist iff a confirmed
      // TOTP credential exists" — starting a fresh (re-)enrollment resets
      // the factor to unconfirmed, so any leftover codes must not survive
      // into the new enrollment window. verify() re-mints a fresh set on
      // first confirmation (see :1414), so this never strands a usable
      // factor. (ORCH-07)
      await prisma.recoveryCode.deleteMany({ where: { userId } });

      const qrDataUrl = await QRCode.toDataURL(otpauthUri, {
        errorCorrectionLevel: "M",
        margin: 1,
      });

      // The plaintext `secret` is deliberately NOT returned — the QR / URI
      // carry it to the authenticator app; nothing else needs it.
      res.json({ otpauthUri, qrDataUrl, issuer: TOTP_ISSUER });
    } catch (err) {
      next(err);
    }
  });

  // ── PR #375 — TOTP verify / re-challenge ──
  // Verify a 6-digit code against the (decrypted) stored secret. On the
  // FIRST success, enable the factor (set confirmedAt) and mint one-time
  // recovery codes — returned ONCE in this response and never again. A
  // verify against an already-enabled factor is a re-challenge (e.g. a
  // step-up) and returns no new codes.
  router.post("/auth/totp/verify", async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      if (!prisma) {
        res.status(500).json({ error: "TOTP unavailable: database not wired" });
        return;
      }
      const parsed = totpVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "A 6-digit code is required" });
        return;
      }
      const userId = req.user.id;

      const cred = await prisma.totpCredential.findUnique({ where: { userId } });
      if (!cred) {
        res.status(400).json({
          error: "No enrollment in progress. Start with /auth/totp/enroll.",
          code: "TOTP_NOT_ENROLLED",
        });
        return;
      }

      const secret = decryptTotpSecret(cred.secretEnc);
      const codeOk = await verifyTotpCode(secret, parsed.data.code);
      if (!codeOk) {
        res.status(401).json({ error: "Invalid code", code: "TOTP_INVALID" });
        return;
      }

      const firstConfirmation = !cred.confirmedAt;
      if (!firstConfirmation) {
        // Re-challenge against an already-enabled factor — no new codes.
        res.json({ enabled: true });
        return;
      }

      // First successful verify → enable + mint recovery codes. Clear any
      // stale codes from a prior (re-)enrollment so the displayed set is
      // the only valid set.
      await prisma.totpCredential.update({
        where: { userId },
        data: { confirmedAt: new Date() },
      });
      const { plaintext, hashes } = await generateRecoveryCodes();
      await prisma.recoveryCode.deleteMany({ where: { userId } });
      await prisma.recoveryCode.createMany({
        data: hashes.map((codeHash) => ({ userId, codeHash })),
      });

      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "shield-check",
        what: `${req.user.displayName} enabled two-factor authentication`,
        sub: callerIpFromReq(req) ?? null,
        refs: { outcome: "totp_enabled", userId, username: req.user.username },
      });

      // Recovery codes are returned ONCE here and never persisted in
      // plaintext — the client must show them now.
      res.json({ enabled: true, recoveryCodes: plaintext });
    } catch (err) {
      next(err);
    }
  });

  // ── PR #375 — consume a recovery code (step-up for a live session) ──
  // The login route consumes recovery codes pre-session; this endpoint
  // covers an already-authenticated step-up. Single-use: the matched row
  // is marked used so a replay matches nothing.
  router.post("/auth/recovery", async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      if (!prisma) {
        res.status(500).json({ error: "Recovery unavailable: database not wired" });
        return;
      }
      const parsed = recoveryConsumeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "A recovery code is required" });
        return;
      }
      const userId = req.user.id;

      const unused = await prisma.recoveryCode.findMany({
        where: { userId, usedAt: null },
      });
      const matchHash = await findMatchingRecoveryCodeHash(
        parsed.data.code,
        unused.map((r) => r.codeHash),
      );
      if (!matchHash) {
        res.status(401).json({ error: "Invalid code", code: "RECOVERY_INVALID" });
        return;
      }
      const consumed = unused.find((r) => r.codeHash === matchHash);
      if (!consumed) {
        res.status(401).json({ error: "Invalid code", code: "RECOVERY_INVALID" });
        return;
      }
      // Atomic single-use: the usedAt:null guard makes the consume safe
      // against a concurrent step-up presenting the same code. If a racer
      // already spent it between our read and here, count is 0 → reject as
      // invalid rather than re-authenticating. Mirrors claimRefreshRotation.
      const claimed = await prisma.recoveryCode.updateMany({
        where: { id: consumed.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) {
        res.status(401).json({ error: "Invalid code", code: "RECOVERY_INVALID" });
        return;
      }

      const remaining = unused.length - 1;
      res.json({ ok: true, remaining });
    } catch (err) {
      next(err);
    }
  });

  // ── Logout: denylist refresh token + clear cookies ──
  router.post("/auth/logout", async (req, res, next) => {
    try {
      // Denylist the JWT refresh token so it can't be reused
      const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
      if (refreshToken) {
        await denyRefreshToken(refreshToken);
        // WARP-116: drop this device's member from the session index so a
        // later "revoke now" doesn't re-denylist an already-dead token. Keyed
        // by the session subject (req.user.id == JWT.sub == the userId used at
        // registration); a no-op when no member matches.
        if (req.user?.id) {
          await unregisterRefreshSession(req.user.id, refreshToken);
        }
      }

      // Revoke the stored Nextcloud app-password so it can't outlive the
      // session. Two code paths:
      //   • JWT sessions: the NC token lives in Redis keyed by user id;
      //     fetch it, ask Nextcloud to revoke, then delete from Redis.
      //   • Legacy sessions: the cookie IS the NC token; revoke it directly.
      const sessionToken = resolveToken(req);
      if (sessionToken && verifyAccessToken(sessionToken) && req.user?.id) {
        const ncToken = await getNcToken(req.user.id);
        if (ncToken) {
          try {
            await ncDeleteAppPassword(ncToken);
          } catch {
            // Non-fatal — token may already be revoked upstream
          }
        }
        await deleteNcToken(req.user.id);
      } else if (sessionToken) {
        try {
          await ncDeleteAppPassword(sessionToken);
        } catch {
          // Non-fatal — token may already be revoked or expired
        }
      }

      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });

      // WARP-456: audit row for the logout. `req.user` is set by the
      // authMiddleware before this handler runs.
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "log-out",
        what: req.user?.displayName
          ? `${req.user.displayName} signed out`
          : "Sign-out",
        sub: callerIpFromReq(req) ?? null,
        refs: {
          userId: req.user?.id ?? null,
          ip: callerIpFromReq(req) ?? null,
        },
      });

      res.json({ status: "ok" });
    } catch (err) {
      next(err);
    }
  });

  // ── List users (admin only) ──
  router.get("/auth/users", async (req, res, next) => {
    try {
      const token = await resolveNcToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      // Hide the Nextcloud system/database admin account — it exists for
      // internal orchestrator use only and must never appear in the UI.
      const systemUser = (process.env.NEXTCLOUD_ADMIN_USER || "admin").toLowerCase();
      // WARP-947: run NC list + DB lookup in parallel; separate maps per column
      // prevent cross-column key collision (nc username ≠ local username namespace).
      const [allUsers, localRows] = await Promise.all([
        ncListUsers(token),
        prisma
          ? prisma.user.findMany({ select: { id: true, username: true, nextcloudUsername: true } })
          : ([] as { id: string; username: string; nextcloudUsername: string | null }[]),
      ]);
      const ncUsers = allUsers.filter((u) => u.id.toLowerCase() !== systemUser);
      const uuidByNcUsername = new Map<string, string>();
      const uuidByUsername = new Map<string, string>();
      for (const row of localRows) {
        if (row.nextcloudUsername) uuidByNcUsername.set(row.nextcloudUsername.toLowerCase(), row.id);
        uuidByUsername.set(row.username.toLowerCase(), row.id);
      }
      const users = ncUsers.map((u) => {
        const key = u.id.toLowerCase();
        return {
          ...u,
          userId: uuidByNcUsername.get(key) ?? uuidByUsername.get(key) ?? null,
        };
      });
      res.json({ users });
    } catch (err: any) {
      if (err.message?.includes("403") || err.message?.includes("997")) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      next(err);
    }
  });

  // ── Create user (admin only) ──
  // WARP-171: per-route guard. owner + admin only.
  router.post("/auth/users", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) {
        const fieldErrors = parsed.error.flatten().fieldErrors;
        if (fieldErrors.email?.length) {
          res.status(400).json({ error: "Invalid email address", code: "INVALID_EMAIL" });
          return;
        }
        if (fieldErrors.password?.length) {
          res.status(400).json({ error: "Password does not meet policy requirements", code: "WEAK_PASSWORD" });
          return;
        }
        res.status(400).json({ error: "Invalid request", code: "INVALID_REQUEST" });
        return;
      }

      const { email, password, displayName, mustChangePassword } = parsed.data;

      const token = await resolveNcToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      // WARP-485 follow-up (Romain PR #279 review): fail-CLOSED if
      // prisma isn't wired so we never create an NC user that we
      // can't mirror locally. Without this guard, the new user would
      // be permanently locked out on first login (login path 401s
      // USER_NOT_PROVISIONED at lines 325-351). Mirrors the login
      // route's fail-CLOSED behavior for the legacy
      // createAuthRouter() shim.
      if (!prisma) {
        logger.error(
          { email },
          "admin create-user: prisma not wired into protected auth router; refusing to create NC user without local mirror",
        );
        res.status(500).json({
          error: "Server misconfigured: local user database not wired",
          code: "USERS_NO_PRISMA",
        });
        return;
      }

      // Derive the unique userid from the email local-part (same
      // algorithm used by /auth/setup). The resulting username is
      // stable across retries because deriveUniqueUserId queries the
      // live DB on every call, so a collision-resolved candidate
      // (e.g. "kid-2") will only be returned when "kid" is already
      // taken.
      const username = await deriveUniqueUserId(prisma, email);

      // ADR-013: the directory is the auth source of truth. Hash the
      // plaintext BEFORE the upsert so the stored row carries an
      // argon2id PHC string, never the plaintext. Without this, the
      // login route (which checks passwordHash for null / DEACTIVATED)
      // would unconditionally deny the newly-created user.
      const passwordHash = await hashPassword(password);

      // Romain PR #279 round 2: idempotent upsert FIRST, ncCreateUser
      // SECOND. Without this ordering, a transient failure between
      // the two writes produces a misleading 409 on retry:
      //
      //   attempt 1 → ncCreateUser OK → upsert THROWS → caller 500
      //   attempt 2 → ncCreateUser THROWS NextcloudUserExistsError
      //               → outer catch maps to 409 "user already exists"
      //               → admin gets a 409 that masks the real bug
      //                 (the missing local row from attempt 1), and
      //                 the freshly-provisioned NC user is locked out
      //                 forever with USER_NOT_PROVISIONED
      //
      // Reordered the calls so the idempotent step lands first:
      //
      //   attempt 1 → upsert OK → ncCreateUser THROWS (transient)
      //                         → caller 500, local row orphaned
      //   attempt 2 → upsert no-op → ncCreateUser succeeds
      //                            → caller 201, system is consistent
      //
      // The orphan-local-row edge case (transient NC failure on the
      // first try) is acceptable because: (a) the orphan row carries
      // no privileges any code path honors without a matching NC
      // user, and (b) the next retry collapses it back into the
      // happy path. Worst real-world impact: a defunct row sits in
      // `User` if the admin abandons the username — operator can
      // purge via the standard delete-user flow.
      await prisma.user.upsert({
        where: { nextcloudUsername: username },
        update: {
          displayName: displayName || username,
          email,
          passwordHash,
          // WARP-824: a re-issued temp password (idempotent retry, or an
          // operator re-creating the same account with a fresh temp secret)
          // re-arms the forced-change gate — mirror the create branch so the
          // flag never goes stale on the update path.
          mustChangePassword,
        },
        create: {
          username,
          displayName: displayName || username,
          email,
          nextcloudUsername: username,
          passwordHash,
          role: "family" as any,
          // WARP-824: explicit forced-change-on-first-login flag (default
          // true). The post-auth gate reads this fresh on every request.
          mustChangePassword,
        },
      });

      // WARP-883: admin-created users are `family` role — add them to the
      // household group so the shared "Household" group folder mounts for them.
      await ncCreateUser(
        token,
        username,
        password,
        displayName,
        buildNcGroups("family", householdGroupName(config.DROPLET_SHARED_FOLDER_NAME)),
      );

      res.status(201).json({ status: "ok", username });
    } catch (err: any) {
      // Typed-error path mirrors the invite-accept route — detect the
      // OCS user-exists race (statuscode 102) by error class, not by
      // substring-sniffing the message (which can false-positive on
      // unrelated messages that happen to contain "102").
      if (err instanceof NextcloudUserExistsError) {
        res.status(409).json({ error: "User already exists" });
        return;
      }
      next(err);
    }
  });

  // ── Update user (admin only) ──
  // Accepts any combination of displayName / email / quota / password and
  // applies them one OCS PUT at a time. Each field is independent so a
  // partial failure leaves the previously-applied fields in place.
  // WARP-171: per-route guard. owner + admin only.
  router.put("/auth/users/:username", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const token = await resolveNcToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        const fieldErrors = parsed.error.flatten().fieldErrors;
        if (fieldErrors.email?.length) {
          res.status(400).json({ error: "Invalid email address", code: "INVALID_EMAIL" });
          return;
        }
        if (fieldErrors.password?.length) {
          res.status(400).json({ error: "Password does not meet policy requirements", code: "WEAK_PASSWORD" });
          return;
        }
        res.status(400).json({ error: "Invalid request", code: "INVALID_REQUEST" });
        return;
      }

      const { username } = req.params;
      const { displayName, email, quota, password } = parsed.data;

      // ADR-013: the built-in directory is the auth source of truth and
      // /auth/login verifies the LOCAL passwordHash by email. An email or
      // password edit that only touches Nextcloud has NO effect on login, so
      // those edits MUST land on the local row. Fail CLOSED if the directory
      // isn't wired (the legacy createAuthRouter() shim) rather than silently
      // updating only Nextcloud. (displayName/quota are NC-side attributes and
      // don't gate login, so they don't require the directory.)
      const touchesDirectory = email !== undefined || password !== undefined;
      if (touchesDirectory && !prisma) {
        logger.error(
          { username },
          "update-user: prisma not wired into protected auth router; refusing to change directory email/password without the local mirror",
        );
        res.status(500).json({
          error: "Server misconfigured: local user database not wired",
          code: "USERS_NO_PRISMA",
        });
        return;
      }

      // Write the local directory row FIRST (idempotent; source of truth).
      // `email` is already trim+lowercased by emailField; the plaintext
      // password is hashed here and NEVER written to the row.
      if (prisma) {
        const data: Record<string, unknown> = {};
        if (displayName !== undefined) data.displayName = displayName;
        if (email !== undefined) data.email = email;
        if (password !== undefined) data.passwordHash = await hashPassword(password);
        if (Object.keys(data).length > 0) {
          const updated = await prisma.user.updateMany({
            where: { nextcloudUsername: username },
            data,
          });
          // A credential change against a username with no directory row is
          // meaningless for login — surface it instead of half-applying it to
          // Nextcloud only.
          if (updated.count === 0 && touchesDirectory) {
            res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
            return;
          }
        }
      }

      // Mirror the changes to Nextcloud (the WebDAV account + NC-side
      // attributes). One OCS PUT per field; the plaintext password is sent
      // here so the user's Files/WebDAV login keeps working.
      if (displayName !== undefined) {
        await ncUpdateUser(token, username, "displayname", displayName);
      }
      if (email !== undefined) {
        await ncUpdateUser(token, username, "email", email);
      }
      if (quota !== undefined) {
        await ncUpdateUser(token, username, "quota", String(quota));
      }
      if (password !== undefined) {
        await ncUpdateUser(token, username, "password", password);
      }
      res.json({ status: "ok", username });
    } catch (err: any) {
      if (err.message?.includes("403") || err.message?.includes("997")) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      next(err);
    }
  });

  // ── Disable / enable user (admin only) ──
  // WARP-171: per-route guard. owner + admin only.
  router.post(
    "/auth/users/:username/disable",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const token = await resolveNcToken(req);
        if (!token) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        await ncSetUserEnabled(token, req.params.username, false);
        // WARP-116: a disabled user must lose access effectively immediately,
        // not at their next ≤15-min access-token expiry. Resolve the local
        // row (the session index is keyed by User.id == JWT.sub) and denylist
        // every live refresh token so the next /auth/refresh fails. Best-effort
        // — a missing local row (legacy NC-only account) just means there were
        // no JWT sessions to revoke.
        if (prisma) {
          const row = await prisma.user.findUnique({
            where: { nextcloudUsername: req.params.username },
            select: { id: true },
          });
          if (row) await revokeUserSessions(row.id);
        }
        res.json({ status: "disabled", username: req.params.username });
      } catch (err: any) {
        if (err.message?.includes("403") || err.message?.includes("997")) {
          res.status(403).json({ error: "Admin access required" });
          return;
        }
        next(err);
      }
    },
  );

  // WARP-171: per-route guard. owner + admin only.
  router.post(
    "/auth/users/:username/enable",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const token = await resolveNcToken(req);
        if (!token) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        await ncSetUserEnabled(token, req.params.username, true);
        res.json({ status: "enabled", username: req.params.username });
      } catch (err: any) {
        if (err.message?.includes("403") || err.message?.includes("997")) {
          res.status(403).json({ error: "Admin access required" });
          return;
        }
        next(err);
      }
    },
  );

  // ── Revoke all sessions for a user (admin only) ──
  // WARP-116: the explicit, opt-in "revoke now" path. v1 RBAC propagates a
  // role/account change at the next access-token refresh (≤15 min); this
  // endpoint denylists every live refresh token for the user immediately so
  // their next /auth/refresh fails and they must re-authenticate. Already-
  // issued access tokens still expire on their own ≤15-min clock (stateless
  // verification) — by design. Keyed by username → resolved to the local
  // User.id the session index uses (== JWT.sub).
  router.post(
    "/auth/users/:username/revoke-sessions",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        if (!prisma) {
          // The session index is keyed by local User.id; without the local
          // directory we can't resolve the username to revoke. Fail closed.
          res.status(500).json({
            error: "Server misconfigured: local user database not wired",
            code: "USERS_NO_PRISMA",
          });
          return;
        }
        const row = await prisma.user.findUnique({
          where: { nextcloudUsername: req.params.username },
          select: { id: true },
        });
        if (!row) {
          res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
          return;
        }
        const revoked = await revokeUserSessions(row.id);
        res.json({ status: "ok", username: req.params.username, revoked });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Delete user (admin only) ──
  // WARP-205: Cascade brain-memory items + chunks + on-disk bytes the
  // user owned. We do this AFTER Nextcloud-side delete succeeds so a
  // failed upstream call doesn't leave the brain tier partially purged
  // (the dashboard would then list a user that no longer exists in
  // Nextcloud — strictly worse than the converse). The cascade is
  // best-effort: if it throws we still return success, but log loud
  // — orphaned local rows are recoverable later via a janitor job;
  // returning 500 here would also fail to undo the upstream delete.
  // WARP-171: per-route guard. owner + admin only.
  router.delete("/auth/users/:username", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const token = await resolveNcToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      await ncDeleteUser(token, req.params.username);

      if (prisma) {
        try {
          const purged = await purgeUserData(prisma, req.params.username);
          logger.info(
            {
              username: req.params.username,
              items: purged.items,
              chunks: purged.chunks,
            },
            "Cascaded brain-memory purge after user delete",
          );
        } catch (err) {
          // Don't fail the user-delete if the local cascade trips —
          // the upstream NC delete already succeeded, and undoing it
          // is awkward. Log loud so on-call can clean up later.
          logger.error(
            { err, username: req.params.username },
            "Brain-memory cascade purge failed (user already deleted in Nextcloud)",
          );
        }
      } else {
        // Should never happen in production; createProtectedAuthRouter
        // is invoked with prisma in app.ts.
        logger.warn(
          { username: req.params.username },
          "purgeUserData skipped — protected auth router instantiated without prisma",
        );
      }

      res.json({ status: "deleted", username: req.params.username });
    } catch (err) {
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────
  // WARP-217 — Admin invite management
  //
  //   POST   /api/auth/invites           — generate a token + URL
  //   GET    /api/auth/invites           — list (most recent first)
  //   DELETE /api/auth/invites/:token    — revoke (idempotent)
  //
  // All three are admin-only. We rely on `req.user.role` populated by the
  // upstream auth middleware. Returning 403 (not 401) on non-admin matches
  // the existing ddns/vpn convention so the dashboard's "you're logged in,
  // just not allowed" path is consistent across pages.
  // ────────────────────────────────────────────────────────────
  // WARP-171: per-route guard. owner + admin only. Replaces the
  // pre-WARP-171 inline `isAdmin(req)` check; the guard runs as
  // middleware ahead of the handler so the 403 short-circuits before
  // any handler-local validation.
  router.post("/auth/invites", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(500).json({ error: "Invite store unavailable" });
        return;
      }
      const parsed = createInviteSchema.safeParse(req.body);
      if (!parsed.success) {
        const fieldErrors = parsed.error.flatten().fieldErrors;
        if (fieldErrors.email?.length) {
          res.status(400).json({ error: "Enter a valid email address.", code: "INVALID_EMAIL" });
          return;
        }
        res.status(400).json({ error: "Invalid request", code: "INVALID_REQUEST" });
        return;
      }

      // Privilege-escalation guard. `requireRole("owner","admin")` proved the
      // caller may issue invites, but NOT which role they may assign. Without
      // this cap an `admin` could mint an `owner` invite, and the accept path
      // grants an owner/admin invite an `owner` session role + Nextcloud
      // `admin` group (see POST /auth/invites/accept/:token above) — a
      // straight privilege escalation. Reject any assigned role that outranks
      // the inviter's own; owner→owner is allowed, admin→owner is not. Fail
      // closed if the role claim is somehow absent.
      const inviterRole = req.user?.role;
      if (!inviterRole || roleOutranks(parsed.data.role, inviterRole)) {
        res.status(403).json({
          error: "You cannot invite someone to a role higher than your own",
          code: "ROLE_RANK_EXCEEDED",
        });
        return;
      }

      // Derive the unique userid from the email local-part. The derived
      // username is stored on the invite row and used at accept time
      // (the invitee never chooses their own username).
      const username = await deriveUniqueUserId(prisma, parsed.data.email);

      const ttlHours = parsed.data.ttlHours ?? 72;
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
      const token = generateInviteToken();

      const created = await prisma.userInvite.create({
        data: {
          token,
          username,
          displayName: parsed.data.displayName ?? null,
          email: parsed.data.email,
          role: parsed.data.role,
          createdBy: req.user?.username ?? "unknown",
          expiresAt,
        },
      });

      logger.info(
        {
          username,
          role: parsed.data.role,
          createdBy: req.user?.username,
          expiresAt,
        },
        "User invite created",
      );

      // BUG-11 — deliver the invite email. The row is created above; the email
      // is a separate, fallible step over the operator's SMTP relay.
      // `sendInviteEmail` flips the invite's `sendStatus` and NEVER throws, so a
      // relay outage can't 500 the create. A failed send leaves a valid,
      // retryable invite (POST /api/people/invites/:id/resend) — explicit state,
      // no silent success. Skipped only when the invite carries no email (which
      // can't happen here: email is required above) or prisma isn't wired.
      // Resolve the host-validated accept URL once (the canonical-origin
      // lookup is cached, but one call keeps the email + response consistent).
      const acceptUrl = await buildInviteUrl(req, created.token);

      let sendStatus: "sent" | "failed" = "failed";
      if (prisma && parsed.data.email) {
        const sendResult = await sendInviteEmail(
          prisma,
          {
            inviteId: created.id,
            to: parsed.data.email,
            acceptUrl,
            role: created.role,
          },
          sendOptions,
        );
        sendStatus = sendResult.status;
      }

      res.json({
        token: created.token,
        url: acceptUrl,
        expiresAt: created.expiresAt,
        send_status: sendStatus,
      });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: GET listing of invites is also admin-only — exposing
  // pending tokens to a family-tier user would be a credential leak
  // even though the token's just-an-identifier. Same guard as the
  // POST/DELETE invite endpoints.
  router.get("/auth/invites", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      if (!prisma) {
        res.status(500).json({ error: "Invite store unavailable" });
        return;
      }
      const rows = await prisma.userInvite.findMany({
        orderBy: { createdAt: "desc" },
      });
      const invites = rows.map((r) => ({
        token: r.token,
        username: r.username,
        displayName: r.displayName,
        email: r.email,
        role: r.role,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        acceptedAt: r.acceptedAt,
        revokedAt: r.revokedAt,
      }));
      res.json({ invites });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin only.
  router.delete(
    "/auth/invites/:token",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        if (!prisma) {
          res.status(500).json({ error: "Invite store unavailable" });
          return;
        }
        const invite = await findInviteByToken(prisma, req.params.token);
        if (!invite) {
          res.status(404).json({ error: "Invite not found" });
          return;
        }
        // Idempotent: revoking an already-revoked invite is a no-op success.
        if (!invite.revokedAt) {
          await prisma.userInvite.update({
            where: { id: invite.id },
            data: { revokedAt: new Date() },
          });
        }
        res.json({ revoked: true });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/** @deprecated Use createPublicAuthRouter() + createProtectedAuthRouter() instead */
export function createAuthRouter(): Router {
  // Backward-compatible single router for any code still using the old API.
  // Combines both public and protected routes (but /auth/me will only work
  // if authMiddleware runs before this router — see app.ts).
  const router = Router();
  router.use(createPublicAuthRouter());
  router.use(createProtectedAuthRouter());
  return router;
}
