/**
 * WARP-247 — server-side session records in Redis.
 *
 * Strategy mirrors cache.service.test.ts: an in-memory fake Redis is
 * injected via __setRedisForTesting; clocks are driven with
 * vi.useFakeTimers + vi.setSystemTime so idle/absolute windows are
 * deterministic. config is mocked with a cap of 3 to keep eviction
 * tests small; activity.singleton and jwt.service.revokeUserSessions
 * are spied to assert audit + denylist wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    SESSION_IDLE_TIMEOUT_ADMIN_SECONDS: 900,
    SESSION_IDLE_TIMEOUT_USER_SECONDS: 3600,
    SESSION_ABSOLUTE_TIMEOUT_SECONDS: 28800,
    SESSION_MAX_CONCURRENT_PER_USER: 3,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const recordActivity = vi.fn().mockResolvedValue(null);
vi.mock("./activity.singleton.js", () => ({
  recordActivity: (...args: unknown[]) => recordActivity(...args),
}));

const revokeUserSessions = vi.fn().mockResolvedValue(0);
vi.mock("./jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("./jwt.service.js")>(
    "./jwt.service.js",
  );
  return {
    ...actual,
    revokeUserSessions: (...a: unknown[]) => revokeUserSessions(...(a as [string])),
  };
});

import { __setRedisForTesting } from "./cache.service.js";
import {
  createSession,
  checkSession,
  deleteSession,
  countLiveSessions,
  revokeAllSessions,
  idleLimitSecondsForRole,
  SESSION_KEY_PREFIX,
  SESSION_INDEX_PREFIX,
  SESSION_TOUCH_INTERVAL_SECONDS,
} from "./session.service.js";

type Entry = { value: string; expiresAt: number };

/** In-memory Redis fake covering the ops session.service uses:
 *  get/set(EX|KEEPTTL)/del/exists + zadd/zrange/zrem/expire. */
function makeFakeRedis() {
  const kv = new Map<string, Entry>();
  const zsets = new Map<string, Map<string, number>>();
  const live = (e?: Entry) => !!e && (!e.expiresAt || Date.now() <= e.expiresAt);
  return {
    kv,
    zsets,
    get: vi.fn(async (k: string) => (live(kv.get(k)) ? kv.get(k)!.value : null)),
    set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
      const prev = kv.get(k);
      let expiresAt = 0;
      if (args[0] === "EX") expiresAt = Date.now() + Number(args[1]) * 1000;
      else if (args[0] === "KEEPTTL") expiresAt = prev?.expiresAt ?? 0;
      kv.set(k, { value: v, expiresAt });
      return "OK";
    }),
    del: vi.fn(async (k: string) => (kv.delete(k) ? 1 : 0)),
    exists: vi.fn(async (k: string) => (live(kv.get(k)) ? 1 : 0)),
    zadd: vi.fn(async (k: string, score: number, member: string) => {
      let z = zsets.get(k);
      if (!z) {
        z = new Map();
        zsets.set(k, z);
      }
      z.set(member, Number(score));
      return 1;
    }),
    // Bounds are accepted as number OR string because that is what the wire
    // does: ioredis stringifies every argument and redis re-parses the index
    // as an integer, so ZRANGE k 0 -1 and ZRANGE k "0" "-1" are the same
    // command. Coercing here (rather than strict-comparing a number) keeps the
    // fake honest against ioredis 6, whose `stop` parameter is typed
    // `string | Buffer` only.
    zrange: vi.fn(
      async (k: string, start: number | string, stop: number | string) => {
        const z = zsets.get(k);
        if (!z) return [];
        const from = Number(start);
        const to = Number(stop);
        if (Number.isNaN(from) || Number.isNaN(to)) {
          throw new Error(
            `fake zrange: non-integer index bounds (${String(start)}, ${String(stop)})`,
          );
        }
        const sorted = [...z.entries()]
          .sort((a, b) => a[1] - b[1])
          .map(([m]) => m);
        const end = to === -1 ? sorted.length : to + 1;
        return sorted.slice(from, end);
      },
    ),
    zrem: vi.fn(async (k: string, member: string) => {
      const z = zsets.get(k);
      if (!z) return 0;
      return z.delete(member) ? 1 : 0;
    }),
    expire: vi.fn(async () => 1),
  };
}

let fake: ReturnType<typeof makeFakeRedis>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-04T10:00:00.000Z"));
  fake = makeFakeRedis();
  __setRedisForTesting(fake as never);
  recordActivity.mockClear();
  revokeUserSessions.mockClear();
});

afterEach(() => {
  __setRedisForTesting(null);
  vi.useRealTimers();
});

const alice = { id: "u-alice", role: "family" as const };
const owner = { id: "u-owner", role: "owner" as const };

function advanceSeconds(s: number) {
  vi.setSystemTime(new Date(Date.now() + s * 1000));
}

describe("idleLimitSecondsForRole", () => {
  it("gives admin-class roles 15 min and user-class roles 60 min", () => {
    expect(idleLimitSecondsForRole("owner")).toBe(900);
    expect(idleLimitSecondsForRole("admin")).toBe(900);
    expect(idleLimitSecondsForRole("family")).toBe(3600);
    expect(idleLimitSecondsForRole("guest")).toBe(3600);
  });
});

describe("createSession", () => {
  it("writes the record and indexes the sid under the user", async () => {
    const { sid, evictedSids } = await createSession(alice);
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(evictedSids).toEqual([]);

    const raw = fake.kv.get(SESSION_KEY_PREFIX + sid);
    expect(raw).toBeDefined();
    const record = JSON.parse(raw!.value);
    expect(record).toMatchObject({ userId: "u-alice", role: "family" });
    expect(record.createdAt).toBe(record.lastSeenAt);
    expect(fake.zsets.get(SESSION_INDEX_PREFIX + "u-alice")!.has(sid)).toBe(true);
  });

  it("evicts the oldest live session beyond the cap and audits it", async () => {
    const s1 = await createSession(alice);
    advanceSeconds(1);
    const s2 = await createSession(alice);
    advanceSeconds(1);
    const s3 = await createSession(alice);
    advanceSeconds(1);
    const s4 = await createSession(alice); // cap is 3 → s1 must die

    expect(s4.evictedSids).toEqual([s1.sid]);
    expect(fake.kv.has(SESSION_KEY_PREFIX + s1.sid)).toBe(false);
    expect(fake.kv.has(SESSION_KEY_PREFIX + s2.sid)).toBe(true);
    expect(fake.kv.has(SESSION_KEY_PREFIX + s3.sid)).toBe(true);
    expect(fake.kv.has(SESSION_KEY_PREFIX + s4.sid)).toBe(true);
    expect(fake.zsets.get(SESSION_INDEX_PREFIX + "u-alice")!.has(s1.sid)).toBe(false);

    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth",
        refs: expect.objectContaining({
          outcome: "session_evicted",
          userId: "u-alice",
          sid: s1.sid,
          limit: 3,
        }),
        actor: { type: "user", id: "u-alice" },
      }),
    );
  });

  it("is best-effort: a Redis failure still yields a sid (login proceeds)", async () => {
    fake.set.mockRejectedValueOnce(new Error("boom"));
    const { sid, evictedSids } = await createSession(alice);
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(evictedSids).toEqual([]);
  });
});

describe("checkSession — idle + absolute enforcement", () => {
  it("returns ok inside both windows and slides lastSeenAt past the throttle", async () => {
    const { sid } = await createSession(alice);
    advanceSeconds(SESSION_TOUCH_INTERVAL_SECONDS + 1);

    const result = await checkSession(sid);
    expect(result.kind).toBe("ok");

    const stored = JSON.parse(fake.kv.get(SESSION_KEY_PREFIX + sid)!.value);
    expect(stored.lastSeenAt).toBe(Math.floor(Date.now() / 1000));
  });

  it("does NOT rewrite lastSeenAt inside the 30s throttle window", async () => {
    const { sid } = await createSession(alice);
    const before = JSON.parse(fake.kv.get(SESSION_KEY_PREFIX + sid)!.value);
    advanceSeconds(5);

    const result = await checkSession(sid);
    expect(result.kind).toBe("ok");
    const after = JSON.parse(fake.kv.get(SESSION_KEY_PREFIX + sid)!.value);
    expect(after.lastSeenAt).toBe(before.lastSeenAt);
  });

  it("expires a family session idle for 60 min, deletes it, audits idle_timeout", async () => {
    const { sid } = await createSession(alice);
    advanceSeconds(3600);

    const result = await checkSession(sid);
    expect(result).toEqual({ kind: "expired", reason: "idle_timeout" });
    expect(fake.kv.has(SESSION_KEY_PREFIX + sid)).toBe(false);
    expect(fake.zsets.get(SESSION_INDEX_PREFIX + "u-alice")!.has(sid)).toBe(false);
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth",
        refs: expect.objectContaining({
          outcome: "session_idle_timeout",
          userId: "u-alice",
          sid,
        }),
        actor: { type: "system", id: null },
      }),
    );
  });

  it("expires an owner session idle for only 15 min (admin window)", async () => {
    const { sid } = await createSession(owner);
    advanceSeconds(900);
    const result = await checkSession(sid);
    expect(result).toEqual({ kind: "expired", reason: "idle_timeout" });
  });

  it("keeps an owner session alive at 14 min idle", async () => {
    const { sid } = await createSession(owner);
    advanceSeconds(14 * 60);
    const result = await checkSession(sid);
    expect(result.kind).toBe("ok");
  });

  it("enforces the 8h absolute cap even when activity is continuous", async () => {
    const { sid } = await createSession(alice);
    // Stay "active": touch every 30 min for 8 hours.
    for (let i = 0; i < 16; i++) {
      advanceSeconds(30 * 60);
      if (i < 15) {
        const mid = await checkSession(sid);
        expect(mid.kind).toBe("ok");
      }
    }
    const result = await checkSession(sid);
    expect(result).toEqual({ kind: "expired", reason: "absolute_timeout" });
    expect(fake.kv.has(SESSION_KEY_PREFIX + sid)).toBe(false);
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: expect.objectContaining({ outcome: "session_absolute_timeout", sid }),
        actor: { type: "system", id: null },
      }),
    );
  });

  it("returns missing for an unknown sid", async () => {
    const result = await checkSession("no-such-sid");
    expect(result).toEqual({ kind: "missing" });
  });

  it("returns error (fail-open signal) when Redis reads fail", async () => {
    fake.get.mockRejectedValueOnce(new Error("redis down"));
    const result = await checkSession("whatever");
    expect(result).toEqual({ kind: "error" });
  });

  it("honours touch:false — refresh must not slide the idle window", async () => {
    const { sid } = await createSession(alice);
    const before = JSON.parse(fake.kv.get(SESSION_KEY_PREFIX + sid)!.value);
    advanceSeconds(SESSION_TOUCH_INTERVAL_SECONDS + 60);

    const result = await checkSession(sid, { touch: false });
    expect(result.kind).toBe("ok");
    const after = JSON.parse(fake.kv.get(SESSION_KEY_PREFIX + sid)!.value);
    expect(after.lastSeenAt).toBe(before.lastSeenAt);
  });
});

describe("deleteSession / revokeAllSessions", () => {
  it("deleteSession removes the record and the index member", async () => {
    const { sid } = await createSession(alice);
    await deleteSession("u-alice", sid);
    expect(fake.kv.has(SESSION_KEY_PREFIX + sid)).toBe(false);
    expect(fake.zsets.get(SESSION_INDEX_PREFIX + "u-alice")!.has(sid)).toBe(false);
  });

  it("revokeAllSessions kills every record and denylists refresh tokens", async () => {
    const s1 = await createSession(alice);
    advanceSeconds(1);
    const s2 = await createSession(alice);

    const revoked = await revokeAllSessions("u-alice");
    expect(revoked).toBe(2);
    expect(fake.kv.has(SESSION_KEY_PREFIX + s1.sid)).toBe(false);
    expect(fake.kv.has(SESSION_KEY_PREFIX + s2.sid)).toBe(false);
    expect(revokeUserSessions).toHaveBeenCalledWith("u-alice");
  });

  it("revokeAllSessions with exceptSid keeps the current session and SKIPS the refresh denylist", async () => {
    const s1 = await createSession(alice);
    advanceSeconds(1);
    const s2 = await createSession(alice);

    const revoked = await revokeAllSessions("u-alice", { exceptSid: s2.sid });
    expect(revoked).toBe(1);
    expect(fake.kv.has(SESSION_KEY_PREFIX + s1.sid)).toBe(false);
    expect(fake.kv.has(SESSION_KEY_PREFIX + s2.sid)).toBe(true);
    // The hash-keyed refresh index can't exempt one sid; rotation is gated on
    // a live record instead, so the denylist sweep must NOT run here (it would
    // kill the kept session's refresh token).
    expect(revokeUserSessions).not.toHaveBeenCalled();
  });
});

describe("countLiveSessions", () => {
  // Logout uses this to decide whether the per-user NC app-password can be
  // revoked (only when the LAST live session ends — the credential is a
  // single per-user Redis slot shared by every device).
  it("returns 0 for a user with no sessions", async () => {
    expect(await countLiveSessions("u-alice")).toBe(0);
  });

  it("counts live records and reflects deleteSession", async () => {
    const s1 = await createSession(alice);
    advanceSeconds(1);
    const s2 = await createSession(alice);
    expect(await countLiveSessions("u-alice")).toBe(2);

    await deleteSession("u-alice", s1.sid);
    expect(await countLiveSessions("u-alice")).toBe(1);

    await deleteSession("u-alice", s2.sid);
    expect(await countLiveSessions("u-alice")).toBe(0);
  });

  it("does not count another user's sessions", async () => {
    await createSession(alice);
    expect(await countLiveSessions(owner.id)).toBe(0);
  });

  it("skips and prunes index members whose record expired (GC'd)", async () => {
    const s1 = await createSession(alice);
    // Simulate the record dying (TTL GC) while the index member lingers.
    fake.kv.delete(SESSION_KEY_PREFIX + s1.sid);
    expect(await countLiveSessions("u-alice")).toBe(0);
    // The stale member was pruned from the index on the way through.
    expect(fake.zsets.get(SESSION_INDEX_PREFIX + "u-alice")?.has(s1.sid)).toBe(false);
  });

  it("returns null when Redis is unreachable (caller picks the failure posture)", async () => {
    fake.zrange.mockRejectedValueOnce(new Error("connection refused"));
    expect(await countLiveSessions("u-alice")).toBe(null);
  });
});

/**
 * ioredis 6 narrowed ZRANGE's `stop` parameter to `string | Buffer` (v5
 * accepted `number` on both bounds), so the three session-index sweeps had to
 * restate `-1` as `"-1"`. That is a pure type-level change — the wire bytes are
 * identical — but getting the coercion wrong here is silent and severe: a stop
 * bound that no longer means "last element" truncates the index walk, so the
 * concurrent-session cap stops evicting and countLiveSessions under-reports
 * (which would leak a Nextcloud app-password past the last logout). These
 * assertions pin the index semantics rather than the literal argument type.
 */
describe("session-index ZRANGE bounds (ioredis 6 compat)", () => {
  it("enumerates the WHOLE index — every sweep asks for [0, -1]", async () => {
    await createSession(alice);
    advanceSeconds(1);
    await createSession(alice);
    advanceSeconds(1);
    await createSession(alice);

    fake.zrange.mockClear();
    expect(await countLiveSessions(alice.id)).toBe(3);

    expect(fake.zrange).toHaveBeenCalled();
    for (const [, start, stop] of fake.zrange.mock.calls) {
      // Redis parses these as integers regardless of JS type; assert the
      // VALUES, so `"-1"`, `-1` all pass and `0`/`1`/`"0"` all fail.
      expect(Number(start)).toBe(0);
      expect(Number(stop)).toBe(-1);
    }
  });

  it("still evicts past the cap with the restated bound", async () => {
    // Cap is 3 (mocked config). A 4th login must evict the oldest — this is
    // the path that silently dies if the stop bound stops meaning "last".
    const s1 = await createSession(alice);
    advanceSeconds(1);
    await createSession(alice);
    advanceSeconds(1);
    await createSession(alice);
    advanceSeconds(1);
    const s4 = await createSession(alice);

    expect(s4.evictedSids).toEqual([s1.sid]);
    expect(await countLiveSessions(alice.id)).toBe(3);
  });

  it("revokeAllSessions sees every member of the index", async () => {
    await createSession(alice);
    advanceSeconds(1);
    await createSession(alice);
    advanceSeconds(1);
    await createSession(alice);

    expect(await revokeAllSessions(alice.id)).toBe(3);
    expect(await countLiveSessions(alice.id)).toBe(0);
  });
});
