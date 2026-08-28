import { rateLimit, type RateLimitRequestHandler } from "express-rate-limit";

/**
 * Shared request rate limiters (CodeQL `js/missing-rate-limiting` sweep,
 * 2026-08-27).
 *
 * Why a second limiter next to the hand-rolled Redis lockouts in
 * `routes/auth.ts` / `routes/setup.ts`: those implement *account* semantics
 * (wrong-password counters, progressive claim-code backoff) and stay exactly
 * as they are. What they don't give us is a coarse per-client ceiling on how
 * often an authorization-performing handler can be *entered* at all — which
 * is what lets an attacker burn CPU on argon2 / WebAuthn verification, or
 * enumerate accounts, at line rate. `express-rate-limit` closes that with a
 * process-local sliding window keyed on `req.ip` (correct behind the gateway
 * because `app.set("trust proxy", 1)` is set in `app.ts`).
 *
 * Process-local (MemoryStore) is the right store here: the orchestrator is a
 * single Node process on the appliance, and the limiter is a ceiling, not
 * the account lockout — the Redis-backed lockouts remain the source of truth
 * for "this account/IP is locked".
 *
 * Presets, tightest first. Pick by what the handler *costs* or *protects*:
 *
 * - `authRateLimit`      — credential / assertion verification and other
 *                          handlers an attacker would brute-force
 *                          (login, MFA, WebAuthn, setup claim, SSO callback).
 * - `sensitiveRateLimit` — authorization-gated mutations and secret-bearing
 *                          reads (token issuance, share links, VPN peers,
 *                          camera credentials).
 * - `standardRateLimit`  — everything else CodeQL flags: authenticated reads
 *                          and routine writes where the concern is only that
 *                          the handler performs an authorization check.
 *
 * Every preset sends the IETF `RateLimit-*` draft-8 headers so clients can
 * back off, and answers `429` with the same `{ error }` envelope the rest of
 * the API uses.
 */

const RATE_LIMIT_MESSAGE = { error: "Too many requests, slow down" } as const;

function preset(
  name: string,
  windowMs: number,
  limit: number,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: RATE_LIMIT_MESSAGE,
    // One counter per preset, not per route: a client hammering login *and*
    // MFA shares the auth budget, which is the point.
    identifier: `droplet-${name}`,
  });
}

/** 20 requests / minute / IP — brute-forceable credential + assertion paths. */
export const authRateLimit: RateLimitRequestHandler = preset("auth", 60_000, 20);

/** 60 requests / minute / IP — secret-bearing or mutating authorized handlers. */
export const sensitiveRateLimit: RateLimitRequestHandler = preset(
  "sensitive",
  60_000,
  60,
);

/** 300 requests / minute / IP — routine authorized reads and writes. */
export const standardRateLimit: RateLimitRequestHandler = preset(
  "standard",
  60_000,
  300,
);

/**
 * Escape hatch for a handler whose natural cadence doesn't fit a preset
 * (e.g. a polling endpoint the dashboard hits every second). Prefer a preset.
 */
export function createRateLimit(
  name: string,
  opts: { windowMs: number; limit: number },
): RateLimitRequestHandler {
  return preset(name, opts.windowMs, opts.limit);
}
