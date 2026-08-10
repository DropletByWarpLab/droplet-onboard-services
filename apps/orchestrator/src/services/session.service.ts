/**
 * WARP-247 — server-side session records (NIST 800-63B session hardening).
 *
 * The JWT layer stays stateless for signature verification, but every human
 * session minted after this ticket carries a `sid` claim that joins it to a
 * Redis record:
 *
 *   sess:rec:{sid}    → JSON SessionRecord   (string; TTL = absolute + 24h GC grace)
 *   sess:user:{uid}   → ZSET member=sid score=createdAt-epoch-seconds
 *
 * The record is the source of truth for three controls the stateless design
 * could not express:
 *
 *   • sliding idle timeout   — role-dependent (admin 15 min / user 60 min),
 *     enforced by the auth middleware on every request via checkSession();
 *   • absolute timeout       — 8 h from login, never extended (refresh calls
 *     checkSession with touch:false so a token-refresh loop can't slide it);
 *   • immediate revocation   — deleting the record kills the ACCESS token at
 *     the next middleware check (not just refresh, unlike WARP-116's
 *     refresh-token denylist), and /auth/refresh refuses rotation without a
 *     live record.
 *
 * Failure posture (deliberate, mirrors requirePasswordChangeGate):
 *   • Redis ERROR   → callers fail OPEN (kind:"error"): the presented JWT is
 *     still a valid ≤15-min credential and a cache-service restart must not
 *     brick the appliance. Logged loudly.
 *   • record MISSING→ callers fail CLOSED (that IS revocation/expiry).
 *   • createSession → best-effort: a failed write still returns a sid so
 *     login succeeds; the session self-heals via re-login on first 401.
 *
 * The record TTL is absolute + 24 h rather than exactly absolute so that a
 * session presented after its absolute deadline is still FOUND and can emit
 * an accurate `session_absolute_timeout` audit row (a bare TTL expiry would
 * be indistinguishable from revocation). Sessions never presented again are
 * garbage-collected by the TTL with no audit row — there is no access
 * attempt to log.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { getRedis } from "./cache.service.js";
import { revokeUserSessions, type Role } from "./jwt.service.js";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("session");

export const SESSION_KEY_PREFIX = "sess:rec:";
export const SESSION_INDEX_PREFIX = "sess:user:";

/** Write-throttle for the sliding lastSeenAt update: at most one Redis write
 *  per session per this many seconds. Bounds write amplification on chatty
 *  dashboards while keeping idle-window resolution far below the 15-min
 *  admin limit. */
export const SESSION_TOUCH_INTERVAL_SECONDS = 30;

/** GC grace past the absolute cap — see module docstring. */
const RECORD_GC_GRACE_SECONDS = 24 * 60 * 60;

export const DEFAULT_IDLE_TIMEOUT_ADMIN_SECONDS = 15 * 60;
export const DEFAULT_IDLE_TIMEOUT_USER_SECONDS = 60 * 60;
export const DEFAULT_ABSOLUTE_TIMEOUT_SECONDS = 8 * 60 * 60;
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;

export interface SessionRecord {
  userId: string;
  role: Role;
  /** Epoch seconds — fixed at login; the absolute clock. */
  createdAt: number;
  /** Epoch seconds — slid by authenticated activity; the idle clock. */
  lastSeenAt: number;
}

export type SessionCheckResult =
  | { kind: "ok"; record: SessionRecord }
  | { kind: "expired"; reason: "idle_timeout" | "absolute_timeout" }
  | { kind: "missing" }
  | { kind: "error" };

/** Defensive numeric read: config always has zod defaults in production, but
 *  unit tests mock ../config.js with partial objects. */
function cfgNum(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** Admin-class = owner|admin (ROLE_RANK ≥ 2). Everyone else — including the
 *  unreachable `service` case; service principals never mint session records —
 *  gets the user-class window. */
export function idleLimitSecondsForRole(role: Role): number {
  if (role === "owner" || role === "admin") {
    return cfgNum(
      config.SESSION_IDLE_TIMEOUT_ADMIN_SECONDS,
      DEFAULT_IDLE_TIMEOUT_ADMIN_SECONDS,
    );
  }
  return cfgNum(
    config.SESSION_IDLE_TIMEOUT_USER_SECONDS,
    DEFAULT_IDLE_TIMEOUT_USER_SECONDS,
  );
}

export function absoluteLimitSeconds(): number {
  return cfgNum(
    config.SESSION_ABSOLUTE_TIMEOUT_SECONDS,
    DEFAULT_ABSOLUTE_TIMEOUT_SECONDS,
  );
}

export function maxConcurrentSessions(): number {
  return cfgNum(
    config.SESSION_MAX_CONCURRENT_PER_USER,
    DEFAULT_MAX_CONCURRENT_SESSIONS,
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Delete one record + its index member. Best-effort; never throws. */
async function destroyRecord(userId: string, sid: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const removed = await redis.del(SESSION_KEY_PREFIX + sid);
    await redis.zrem(SESSION_INDEX_PREFIX + userId, sid);
    return removed > 0;
  } catch (err) {
    logger.warn({ err, userId, sid }, "session record delete failed");
    return false;
  }
}

/**
 * Mint a session record for a fresh login and enforce the concurrent-session
 * cap (evict oldest, audit each eviction). Called by every mint site BEFORE
 * signing tokens so the sid rides inside both JWTs.
 *
 * Best-effort: any Redis failure still returns a usable sid (login must not
 * fail because the cache restarted) — that session will 401 SESSION_EXPIRED
 * on first use and self-heal via re-login, which is the safe direction.
 */
export async function createSession(user: {
  id: string;
  role: Role;
}): Promise<{ sid: string; evictedSids: string[] }> {
  const sid = randomUUID();
  const now = nowSeconds();
  const record: SessionRecord = {
    userId: user.id,
    role: user.role,
    createdAt: now,
    lastSeenAt: now,
  };
  const idxKey = SESSION_INDEX_PREFIX + user.id;
  const gcTtl = absoluteLimitSeconds() + RECORD_GC_GRACE_SECONDS;
  const evictedSids: string[] = [];

  try {
    const redis = getRedis();
    await redis.set(SESSION_KEY_PREFIX + sid, JSON.stringify(record), "EX", gcTtl);
    await redis.zadd(idxKey, now, sid);
    // GT: only ever extend the index TTL (mirrors cacheSetAdd's posture).
    await redis.expire(idxKey, gcTtl, "GT");

    // Concurrent cap: walk oldest-first, GC index members whose record
    // already expired/died, then evict the oldest live sessions beyond the
    // cap. Two racing logins can transiently exceed the cap by one — each
    // login re-enforces after adding itself, so the steady state converges;
    // a Lua script would close that window and is deliberately out of scope.
    const members = await redis.zrange(idxKey, 0, "-1"); // ascending score = oldest first
    const live: string[] = [];
    for (const member of members) {
      const exists = await redis.exists(SESSION_KEY_PREFIX + member);
      if (exists) live.push(member);
      else await redis.zrem(idxKey, member);
    }
    const cap = maxConcurrentSessions();
    while (live.length > cap) {
      const oldest = live.shift();
      if (!oldest || oldest === sid) break; // never evict the session being created
      await redis.del(SESSION_KEY_PREFIX + oldest);
      await redis.zrem(idxKey, oldest);
      evictedSids.push(oldest);
    }
    for (const evicted of evictedSids) {
      await recordActivity({
        kind: "auth",
        severity: "info",
        sourceIcon: "shield-alert",
        what: "Oldest session evicted (concurrent-session limit)",
        sub: `limit ${cap}`,
        refs: { outcome: "session_evicted", userId: user.id, sid: evicted, limit: cap },
        // The eviction is caused by this user's own new login.
        actor: { type: "user", id: user.id },
      });
    }
  } catch (err) {
    logger.warn(
      { err, userId: user.id },
      "session record write failed — login proceeds; this session will require re-login once Redis recovers",
    );
  }
  return { sid, evictedSids };
}

/**
 * Load + enforce a session record. Order of checks: absolute first (a session
 * past its hard cap is dead no matter how recently it was active), then idle.
 * On success, slides lastSeenAt unless opts.touch === false (the /auth/refresh
 * path — an automatic token refresh is not user activity) or the last write
 * was under SESSION_TOUCH_INTERVAL_SECONDS ago.
 */
export async function checkSession(
  sid: string,
  opts: { touch?: boolean } = {},
): Promise<SessionCheckResult> {
  const touch = opts.touch !== false;
  const recKey = SESSION_KEY_PREFIX + sid;

  let raw: string | null;
  try {
    raw = await getRedis().get(recKey);
  } catch (err) {
    logger.warn({ err, sid }, "session record read failed — caller fails OPEN");
    return { kind: "error" };
  }
  if (!raw) return { kind: "missing" };

  let record: SessionRecord;
  try {
    record = JSON.parse(raw) as SessionRecord;
  } catch {
    // Corrupt record — treat as revoked rather than letting it live forever.
    return { kind: "missing" };
  }

  const now = nowSeconds();

  if (now - record.createdAt >= absoluteLimitSeconds()) {
    await destroyRecord(record.userId, sid);
    await recordActivity({
      kind: "auth",
      severity: "info",
      sourceIcon: "log-out",
      what: "Session expired (absolute limit)",
      sub: `${absoluteLimitSeconds()}s cap`,
      refs: {
        outcome: "session_absolute_timeout",
        userId: record.userId,
        sid,
        limitSeconds: absoluteLimitSeconds(),
      },
      // Policy-driven termination — the box did it, not the user.
      actor: { type: "system", id: null },
    });
    return { kind: "expired", reason: "absolute_timeout" };
  }

  const idleLimit = idleLimitSecondsForRole(record.role);
  if (now - record.lastSeenAt >= idleLimit) {
    await destroyRecord(record.userId, sid);
    await recordActivity({
      kind: "auth",
      severity: "info",
      sourceIcon: "log-out",
      what: "Session expired (inactivity)",
      sub: `${idleLimit}s idle limit (${record.role})`,
      refs: {
        outcome: "session_idle_timeout",
        userId: record.userId,
        sid,
        limitSeconds: idleLimit,
        role: record.role,
      },
      actor: { type: "system", id: null },
    });
    return { kind: "expired", reason: "idle_timeout" };
  }

  if (touch && now - record.lastSeenAt >= SESSION_TOUCH_INTERVAL_SECONDS) {
    try {
      await getRedis().set(
        recKey,
        JSON.stringify({ ...record, lastSeenAt: now }),
        "KEEPTTL",
      );
    } catch (err) {
      // Non-fatal — the next request retries the touch. The idle clock only
      // ever errs in the STRICT direction (an unslid window expires sooner).
      logger.warn({ err, sid }, "session lastSeenAt touch failed (non-fatal)");
    }
  }
  return { kind: "ok", record };
}

/** Logout: drop this device's record so the remaining ≤15-min access token
 *  dies at the next middleware check, not just at refresh. */
export async function deleteSession(userId: string, sid: string): Promise<void> {
  await destroyRecord(userId, sid);
}

/**
 * Count this user's LIVE session records — index members whose record key
 * still exists; stale members (record TTL'd out) are pruned on the way
 * through, same idiom as createSession's eviction sweep. Logout uses this
 * to decide whether the per-user Nextcloud app-password can be revoked
 * (only when the LAST live session ends — the credential is one shared
 * Redis slot, not per-device). Returns null when Redis is unreachable so
 * the caller picks its own failure posture.
 */
export async function countLiveSessions(userId: string): Promise<number | null> {
  const idxKey = SESSION_INDEX_PREFIX + userId;
  try {
    const redis = getRedis();
    const members = await redis.zrange(idxKey, 0, "-1");
    let live = 0;
    for (const member of members) {
      const exists = await redis.exists(SESSION_KEY_PREFIX + member);
      if (exists) live += 1;
      else await redis.zrem(idxKey, member);
    }
    return live;
  } catch (err) {
    logger.warn({ err, userId }, "live-session count failed");
    return null;
  }
}

/**
 * Kill every live session record for a user. Returns the number of records
 * actually deleted.
 *
 *   • No exceptSid (admin revoke / disable / role change / offboarding):
 *     ALSO runs WARP-116's refresh-token denylist sweep (revokeUserSessions)
 *     as defense-in-depth — it covers legacy sid-less refresh tokens and any
 *     record write that was dropped by a Redis blip.
 *   • With exceptSid (self-service credential change keeps the CURRENT
 *     session): the denylist sweep is SKIPPED — the hash-keyed refresh index
 *     cannot exempt one sid, and rotation is gated on a live session record
 *     anyway, so deleting the other records already kills those lineages.
 */
export async function revokeAllSessions(
  userId: string,
  opts: { exceptSid?: string } = {},
): Promise<number> {
  let revoked = 0;
  try {
    const redis = getRedis();
    const idxKey = SESSION_INDEX_PREFIX + userId;
    const members = await redis.zrange(idxKey, 0, "-1");
    for (const sid of members) {
      if (opts.exceptSid && sid === opts.exceptSid) continue;
      const removed = await redis.del(SESSION_KEY_PREFIX + sid);
      await redis.zrem(idxKey, sid);
      if (removed > 0) revoked += 1;
    }
  } catch (err) {
    logger.warn(
      { err, userId },
      "session record sweep failed — refresh denylist below still applies",
    );
  }
  if (!opts.exceptSid) {
    try {
      await revokeUserSessions(userId);
    } catch (err) {
      logger.warn({ err, userId }, "refresh-token denylist sweep failed (non-fatal)");
    }
  }
  return revoked;
}
