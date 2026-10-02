/**
 * WARP-2767 — the pre-auth calendar ICS feed credential.
 *
 * Pins the lifecycle end to end over HTTP: a link is bound to one account,
 * rotation kills the old link immediately, revocation kills it with no
 * replacement, expiry is enforced, a deactivated or deleted account's link is
 * dead, and a valid link for alice cannot read bob by editing the URL. The
 * feed is mounted AHEAD of the real authMiddleware (as in app.ts), so "no
 * session needed, but a valid token is" is observable, not assumed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
  },
}));
vi.mock("../services/caldav.client.js", () => ({
  fetchIcsFeed: vi.fn(),
  syncCalendarSource: vi.fn(),
}));
vi.mock("../services/encryption.service.js", () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s,
}));
const recordActivity = vi.fn(async () => null);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => (recordActivity as (...x: unknown[]) => unknown)(...a),
}));

import { authMiddleware } from "../middleware/auth.js";
import { createCalendarRouter, createCalendarPublicRouter } from "../routes/calendar.js";
import { FEED_TOKEN_TTL_MS } from "../services/calendar-feed-token.service.js";

interface TokenRow {
  id: string;
  userId: string;
  secretHash: string;
  state: "active" | "rotated" | "revoked" | "expired";
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
}
interface UserRow {
  id: string;
  username: string;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
}

/** In-memory stand-in for the slice of PrismaClient the calendar routes use. */
function makeDb() {
  const users = new Map<string, UserRow>([
    ["u-alice", { id: "u-alice", username: "alice", directoryStatus: "ACTIVE" }],
    ["u-bob", { id: "u-bob", username: "bob", directoryStatus: "ACTIVE" }],
  ]);
  const tokens: TokenRow[] = [];
  let n = 0;
  const matches = (r: TokenRow, w: Partial<TokenRow>) =>
    (w.id === undefined || r.id === w.id) &&
    (w.userId === undefined || r.userId === w.userId) &&
    (w.state === undefined || r.state === w.state);
  const db = {
    users,
    tokens,
    calendarEvent: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => [
        {
          id: `ev-${where.userId}`,
          externalUid: null,
          title: `secret plans of ${where.userId}`,
          description: null,
          location: null,
          meetingUrl: null,
          startsAt: new Date(Date.now() + 3600_000),
          endsAt: new Date(Date.now() + 7200_000),
          allDay: false,
          updatedAt: new Date(),
        },
      ]),
    },
    calendarFeedToken: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; state: string; expiresAt: { gt: Date } } }) =>
        tokens
          .filter((r) => r.userId === where.userId && r.state === where.state && r.expiresAt > where.expiresAt.gt)
          .sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = tokens.find((t) => t.id === where.id);
        if (!r) return null;
        const u = users.get(r.userId);
        // FK cascade: a deleted user has no token rows.
        if (!u) return null;
        return { ...r, user: { username: u.username, directoryStatus: u.directoryStatus } };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Partial<TokenRow>; data: Partial<TokenRow> }) => {
        let count = 0;
        for (const r of tokens) if (matches(r, where)) (Object.assign(r, data), count++);
        return { count };
      }),
      create: vi.fn(async ({ data }: { data: Pick<TokenRow, "userId" | "secretHash" | "expiresAt"> }) => {
        const r: TokenRow = { id: `tok-${++n}`, state: "active", createdAt: new Date(), endedAt: null, ...data };
        tokens.push(r);
        return r;
      }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return db;
}

type Db = ReturnType<typeof makeDb>;

/** Production mount order: public feed → real authMiddleware → calendar. */
function buildProdShapedApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use("/api", createCalendarPublicRouter(db as never));
  app.use(authMiddleware);
  app.use("/api", createCalendarRouter(db as never));
  return app;
}

/** Signed-in-as harness for the owner's self-service endpoints. */
function buildSignedInApp(db: Db, id: string, username: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id, username, displayName: username, role: "family" } as never;
    next();
  });
  app.use("/api", createCalendarRouter(db as never));
  return app;
}

async function mintLink(db: Db, id: string, username: string): Promise<{ path: string; token: string }> {
  const res = await request(buildSignedInApp(db, id, username)).post("/api/calendar/publish/rotate");
  expect(res.status).toBe(200);
  const url = new URL(res.body.url, "http://box");
  return { path: url.pathname, token: url.searchParams.get("token")! };
}

const feed = (db: Db, path: string, token: string) =>
  request(buildProdShapedApp(db)).get(path).query({ token });

beforeEach(() => recordActivity.mockClear());

describe("WARP-2767 — calendar feed token lifecycle", () => {
  it("serves the owner's feed with no session, and nothing without a token", async () => {
    const db = makeDb();
    const { path, token } = await mintLink(db, "u-alice", "alice");
    expect(path).toBe("/api/calendar/publish/alice.ics");

    const ok = await feed(db, path, token);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("secret plans of alice");

    const none = await request(buildProdShapedApp(db)).get(path);
    expect(none.status).toBe(403);
    // The authenticated surface behind it still demands a session.
    const authed = await request(buildProdShapedApp(db)).get("/api/calendar/publish-token");
    expect(authed.status).toBe(401);
  });

  it("stores only a hash of the secret", async () => {
    const db = makeDb();
    const { token } = await mintLink(db, "u-alice", "alice");
    const secret = token.split(".")[1];
    expect(JSON.stringify(db.tokens)).not.toContain(secret);
  });

  it("refuses a cross-user read: alice's valid token on bob's URL is 403 and reads nothing", async () => {
    const db = makeDb();
    const { token } = await mintLink(db, "u-alice", "alice");
    await mintLink(db, "u-bob", "bob");
    const res = await feed(db, "/api/calendar/publish/bob.ics", token);
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("secret plans");
    expect(db.calendarEvent.findMany).not.toHaveBeenCalled();
  });

  it("refuses a forged secret on a real token id", async () => {
    const db = makeDb();
    const { path, token } = await mintLink(db, "u-alice", "alice");
    const forged = `${token.split(".")[0]}.${"A".repeat(43)}`;
    expect((await feed(db, path, forged)).status).toBe(403);
  });

  it("rotate: the old link is dead immediately, the new one works, and bob is untouched", async () => {
    const db = makeDb();
    const old = await mintLink(db, "u-alice", "alice");
    const bob = await mintLink(db, "u-bob", "bob");
    const fresh = await mintLink(db, "u-alice", "alice");

    expect((await feed(db, old.path, old.token)).status).toBe(403);
    expect((await feed(db, fresh.path, fresh.token)).status).toBe(200);
    expect((await feed(db, bob.path, bob.token)).status).toBe(200);
    expect(db.tokens.find((t) => t.id === old.token.split(".")[0])?.state).toBe("rotated");
  });

  it("revoke: the link is dead, status reports none, and bob is untouched", async () => {
    const db = makeDb();
    const link = await mintLink(db, "u-alice", "alice");
    const bob = await mintLink(db, "u-bob", "bob");
    const app = buildSignedInApp(db, "u-alice", "alice");

    const r = await request(app).post("/api/calendar/publish/revoke");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ revoked: 1 });
    expect((await feed(db, link.path, link.token)).status).toBe(403);
    expect((await feed(db, bob.path, bob.token)).status).toBe(200);
    expect((await request(app).get("/api/calendar/publish-token")).body.state).toBe("none");
  });

  it("expiry: an overdue link is refused and stamped expired", async () => {
    const db = makeDb();
    const link = await mintLink(db, "u-alice", "alice");
    const row = db.tokens[0];
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual(FEED_TOKEN_TTL_MS - 1000);
    row.expiresAt = new Date(Date.now() - 1);

    const res = await feed(db, link.path, link.token);
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("BEGIN:VCALENDAR");
    expect(row.state).toBe("expired");
  });

  it("a deactivated or deleted account's link is dead, even if the name is reused", async () => {
    const db = makeDb();
    const link = await mintLink(db, "u-alice", "alice");
    db.users.get("u-alice")!.directoryStatus = "DEACTIVATED";
    expect((await feed(db, link.path, link.token)).status).toBe(403);

    // De-provisioned, then a NEW account takes the name "alice".
    db.users.delete("u-alice");
    db.users.set("u-alice2", { id: "u-alice2", username: "alice", directoryStatus: "ACTIVE" });
    expect((await feed(db, link.path, link.token)).status).toBe(403);
  });

  it("status never returns a URL; rotate returns it once, with its expiry", async () => {
    const db = makeDb();
    const app = buildSignedInApp(db, "u-alice", "alice");
    expect((await request(app).get("/api/calendar/publish-token")).body).toEqual({
      state: "none",
      createdAt: null,
      expiresAt: null,
    });
    const minted = await request(app).post("/api/calendar/publish/rotate");
    expect(typeof minted.body.expiresAt).toBe("string");
    const status = await request(app).get("/api/calendar/publish-token");
    expect(status.body.state).toBe("active");
    expect(status.body.url).toBeUndefined();
  });

  it("audits rotate and revoke without ever recording the token", async () => {
    const db = makeDb();
    const { token } = await mintLink(db, "u-alice", "alice");
    await request(buildSignedInApp(db, "u-alice", "alice")).post("/api/calendar/publish/revoke");
    expect(recordActivity).toHaveBeenCalledTimes(2);
    const rows = JSON.stringify(recordActivity.mock.calls);
    expect(rows).toContain("Calendar feed link created");
    expect(rows).toContain("Calendar feed link turned off");
    expect(rows).not.toContain(token.split(".")[1]);
  });
});
