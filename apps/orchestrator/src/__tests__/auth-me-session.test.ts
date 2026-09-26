/**
 * WARP-2981 (ADR-059 §6.2, D22) — `GET /api/auth/me` says when the sign-in
 * ends: `session: {endsAt: ISO-8601} | null`.
 *
 *   · endsAt = the record's createdAt + the ABSOLUTE limit for the role the
 *     session was minted with — the same arithmetic checkSession enforces, so
 *     the deadline shown is the one that will be applied. The idle deadline
 *     is not exposed: any client that polls keeps sliding it.
 *   · readSessionDeadline is one Redis GET. It never slides lastSeenAt, never
 *     destroys or audits (that is checkSession's job), and never throws: a
 *     missing record, a parse failure or a Redis error is null.
 *   · null for a sid-less (grace-path) token, a service principal, or an
 *     unreadable record — and /auth/me still answers 200.
 *
 * The limits below are deliberately all different (idle ≠ absolute, admin ≠
 * user), so a deadline computed from the wrong one cannot pass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const LIMITS = vi.hoisted(() => ({
  IDLE_ADMIN: 900,
  IDLE_USER: 1_800,
  ABS_ADMIN: 7_200,
  ABS_USER: 5_400,
}));

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    SESSION_IDLE_TIMEOUT_ADMIN_SECONDS: LIMITS.IDLE_ADMIN,
    SESSION_IDLE_TIMEOUT_USER_SECONDS: LIMITS.IDLE_USER,
    SESSION_ABSOLUTE_TIMEOUT_ADMIN_SECONDS: LIMITS.ABS_ADMIN,
    SESSION_ABSOLUTE_TIMEOUT_USER_SECONDS: LIMITS.ABS_USER,
    SESSION_MAX_CONCURRENT_PER_USER: 5,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const recordActivity = vi.fn().mockResolvedValue(null);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => recordActivity(...a),
}));

import { __setRedisForTesting } from "../services/cache.service.js";
import { readSessionDeadline, SESSION_KEY_PREFIX } from "../services/session.service.js";
import { createProtectedAuthRouter } from "../routes/auth.js";

// ── a Redis that holds session records, and can be made to fail ─────────────

function makeRedis() {
  const kv = new Map<string, string>();
  const state = { down: false };
  const guard = () => {
    if (state.down) throw new Error("ECONNREFUSED 127.0.0.1:6379");
  };
  const redis = {
    kv,
    state,
    get: vi.fn(async (k: string) => {
      guard();
      return kv.get(k) ?? null;
    }),
    set: vi.fn(async (k: string, v: string) => {
      guard();
      kv.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (k: string) => (kv.delete(k) ? 1 : 0)),
    zrem: vi.fn(async () => 1),
    exists: vi.fn(async (k: string) => (kv.has(k) ? 1 : 0)),
  };
  return redis;
}

const NOW = new Date("2026-09-24T12:00:00.000Z");
const nowS = NOW.getTime() / 1000;
/** Signed in 40 minutes ago; last seen 10 minutes ago (past the touch throttle). */
const CREATED = nowS - 40 * 60;
const LAST_SEEN = nowS - 10 * 60;

function putRecord(redis: ReturnType<typeof makeRedis>, sid: string, role: string) {
  redis.kv.set(
    SESSION_KEY_PREFIX + sid,
    JSON.stringify({ userId: `u-${sid}`, role, createdAt: CREATED, lastSeenAt: LAST_SEEN }),
  );
}

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();

let redis: ReturnType<typeof makeRedis>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  redis = makeRedis();
  __setRedisForTesting(redis as never);
  recordActivity.mockClear();
});
afterEach(() => {
  __setRedisForTesting(null as never);
  vi.useRealTimers();
});

// ── readSessionDeadline ──────────────────────────────────────────────────────

describe("readSessionDeadline(sid)", () => {
  it("an owner's session ends at createdAt + the ADMIN absolute limit", async () => {
    putRecord(redis, "s-owner", "owner");
    expect(await readSessionDeadline("s-owner")).toEqual({ endsAt: new Date((CREATED + LIMITS.ABS_ADMIN) * 1000) });
  });

  it("an admin's likewise", async () => {
    putRecord(redis, "s-admin", "admin");
    expect((await readSessionDeadline("s-admin"))?.endsAt.toISOString()).toBe(iso(CREATED + LIMITS.ABS_ADMIN));
  });

  it("a family member's session ends at createdAt + the USER absolute limit", async () => {
    putRecord(redis, "s-family", "family");
    expect((await readSessionDeadline("s-family"))?.endsAt.toISOString()).toBe(iso(CREATED + LIMITS.ABS_USER));
  });

  it("a guest's likewise", async () => {
    putRecord(redis, "s-guest", "guest");
    expect((await readSessionDeadline("s-guest"))?.endsAt.toISOString()).toBe(iso(CREATED + LIMITS.ABS_USER));
  });

  it("is one GET: it never slides lastSeenAt, never writes, never destroys, never audits", async () => {
    putRecord(redis, "s-family", "family");
    const before = redis.kv.get(SESSION_KEY_PREFIX + "s-family");
    await readSessionDeadline("s-family");
    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.kv.get(SESSION_KEY_PREFIX + "s-family")).toBe(before);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("a session idle past its idle limit is still only read (enforcement is checkSession's)", async () => {
    redis.kv.set(
      SESSION_KEY_PREFIX + "s-idle",
      JSON.stringify({ userId: "u", role: "family", createdAt: CREATED, lastSeenAt: nowS - LIMITS.IDLE_USER - 60 }),
    );
    expect((await readSessionDeadline("s-idle"))?.endsAt.toISOString()).toBe(iso(CREATED + LIMITS.ABS_USER));
    expect(redis.kv.has(SESSION_KEY_PREFIX + "s-idle")).toBe(true);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("a missing record → null", async () => {
    expect(await readSessionDeadline("s-gone")).toBeNull();
  });

  it("an unparseable record → null (and it is left for the TTL, not deleted)", async () => {
    redis.kv.set(SESSION_KEY_PREFIX + "s-bad", "{not json");
    expect(await readSessionDeadline("s-bad")).toBeNull();
    expect(redis.kv.has(SESSION_KEY_PREFIX + "s-bad")).toBe(true);
  });

  it("a record with no usable createdAt → null, never an Invalid Date", async () => {
    redis.kv.set(SESSION_KEY_PREFIX + "s-odd", JSON.stringify({ userId: "u", role: "family", lastSeenAt: LAST_SEEN }));
    expect(await readSessionDeadline("s-odd")).toBeNull();
  });

  it("a Redis error → null, never a throw", async () => {
    putRecord(redis, "s-family", "family");
    redis.state.down = true;
    await expect(readSessionDeadline("s-family")).resolves.toBeNull();
  });
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────────

type TestUser = { id: string; username: string; displayName: string; role: string; sid?: string };

function meApp(user: TestUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser }).user = user;
    next();
  });
  // No prisma: /auth/me's mustChangePassword read is skipped (fail-soft false).
  app.use("/api", createProtectedAuthRouter());
  return app;
}

describe("GET /api/auth/me — session.endsAt", () => {
  it("an owner: endsAt is createdAt + the admin absolute limit, as ISO-8601", async () => {
    putRecord(redis, "sid-owner", "owner");
    const res = await request(meApp({ id: "u1", username: "stefan", displayName: "Stefan", role: "owner", sid: "sid-owner" })).get(
      "/api/auth/me",
    );
    expect(res.status).toBe(200);
    expect(res.body.session).toEqual({ endsAt: iso(CREATED + LIMITS.ABS_ADMIN) });
    // The rest of the shape is unchanged.
    expect(res.body).toMatchObject({ id: "u1", username: "stefan", displayName: "Stefan", role: "owner", mustChangePassword: false });
  });

  it("a family member: endsAt is createdAt + the user absolute limit", async () => {
    putRecord(redis, "sid-family", "family");
    const res = await request(meApp({ id: "u2", username: "maria", displayName: "Maria", role: "family", sid: "sid-family" })).get(
      "/api/auth/me",
    );
    expect(res.body.session).toEqual({ endsAt: iso(CREATED + LIMITS.ABS_USER) });
  });

  it("a sid-less (grace-path) token → session: null, and Redis is not asked", async () => {
    const res = await request(meApp({ id: "u3", username: "legacy", displayName: "Legacy", role: "family" })).get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.session).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("a service principal → session: null (it has no sign-in to end)", async () => {
    const res = await request(
      meApp({ id: "_service:mcp", username: "_service:mcp", displayName: "MCP", role: "service", sid: "sid-owner" }),
    ).get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.session).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("a Redis error → 200 with session: null", async () => {
    putRecord(redis, "sid-family", "family");
    redis.state.down = true;
    const res = await request(meApp({ id: "u2", username: "maria", displayName: "Maria", role: "family", sid: "sid-family" })).get(
      "/api/auth/me",
    );
    expect(res.status).toBe(200);
    expect(res.body.session).toBeNull();
    expect(res.body.username).toBe("maria");
  });

  it("an unreadable record → session: null", async () => {
    const res = await request(meApp({ id: "u2", username: "maria", displayName: "Maria", role: "family", sid: "sid-missing" })).get(
      "/api/auth/me",
    );
    expect(res.status).toBe(200);
    expect(res.body.session).toBeNull();
  });

  it("reading /auth/me does not slide the idle clock", async () => {
    putRecord(redis, "sid-family", "family");
    await request(meApp({ id: "u2", username: "maria", displayName: "Maria", role: "family", sid: "sid-family" })).get("/api/auth/me");
    expect(redis.set).not.toHaveBeenCalled();
    expect(JSON.parse(redis.kv.get(SESSION_KEY_PREFIX + "sid-family")!).lastSeenAt).toBe(LAST_SEEN);
  });
});
