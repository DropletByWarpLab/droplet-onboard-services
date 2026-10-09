import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedService, hostedJwtKey } from "./hosted.service.js";
import { revokeAllSessions, SESSION_KEY_PREFIX, SESSION_INDEX_PREFIX } from "./session.service.js";

const store = vi.hoisted(() => ({ records: new Map<string, string>(), indexes: new Map<string, Set<string>>(), unavailable: false, denied: false,
  beforeTouch: undefined as undefined | (() => Promise<void>),
}));
vi.mock("../config.js", () => ({ config: {
  JWT_SECRET: "dashboard-secret-with-at-least-32-bytes", SANDBOX_PROCESS_SUPERVISION: true,
  corsAllowedOrigins: ["https://droplet-ai.lan"], DROPLET_LAN_HOSTNAME: "droplet-ai.lan",
} }));
vi.mock("./activity.singleton.js", () => ({ recordActivity: vi.fn(async () => null) }));
vi.mock("./jwt.service.js", () => ({ revokeUserSessions: vi.fn(async () => 0), revocationUnavailable: () => new Error("revocation unavailable") }));
vi.mock("./auth-denylist.service.js", () => ({ isUserDenied: vi.fn(async () => store.denied) }));
vi.mock("./cache.service.js", () => ({ getRedis: () => ({
  get: async (key: string) => { if (store.unavailable) throw new Error("Redis unavailable"); return store.records.get(key) ?? null; },
  set: async (key: string, value: string, ...args: unknown[]) => {
    await store.beforeTouch?.();
    if (args.includes("XX") && !store.records.has(key)) return null;
    store.records.set(key, value); return "OK";
  },
  zrange: async (key: string) => [...(store.indexes.get(key) ?? [])],
  del: async (key: string) => Number(store.records.delete(key)),
  zrem: async (key: string, sid: string) => Number(store.indexes.get(key)?.delete(sid) ?? false),
}) }));

const userId = "family-user";
const sid = "dashboard-session";
const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, id: "shop", name: "Shop", version: "1.0.0",
  kind: "app", runtime: "static", http: { health: "/", dir: "." },
  provides: { tools: [], routineDrafts: [], proposedGrants: [] }, resources: { memoryMb: 64, processes: 1 }, egress: "none" }));

function signIn(sessionId = sid, subject = userId, ageSeconds = 0) {
  const now = Math.floor(Date.now() / 1000);
  store.records.set(SESSION_KEY_PREFIX + sessionId, JSON.stringify({ userId: subject, role: "family", createdAt: now - ageSeconds, lastSeenAt: now - ageSeconds }));
  const key = SESSION_INDEX_PREFIX + subject;
  if (!store.indexes.has(key)) store.indexes.set(key, new Set());
  store.indexes.get(key)!.add(sessionId);
}
function fixture() {
  const user = { id: userId, username: "alice", displayName: "Alice", role: "family", directoryStatus: "ACTIVE" };
  const codes = new Map<string, { codeHash: string; extensionId: string; userId: string; sessionId: string; expiresAt: Date }>();
  const prisma = {
    user: { findUnique: vi.fn(async () => user) },
    extension: { findUnique: vi.fn(async () => ({ kind: "app", status: "live", currentVersion: { manifestBytes: manifest }, hostedAppGrants: [{ role: "family" }] })) },
    hostedAppSessionCode: {
      create: vi.fn(async ({ data }) => { codes.set(data.codeHash, data); return data; }),
      findUnique: vi.fn(async ({ where }) => codes.get(where.codeHash) ?? null),
      deleteMany: vi.fn(async ({ where }) => {
        if (!where.codeHash) return { count: 0 };
        const found = codes.get(where.codeHash);
        if (!found || found.extensionId !== where.extensionId || found.expiresAt <= where.expiresAt.gt) return { count: 0 };
        codes.delete(where.codeHash); return { count: 1 };
      }),
    },
  } as unknown as PrismaClient;
  const service = createHostedService(prisma, { enabled: () => true, sandbox: {} as never, audit: vi.fn(async () => null) });
  const request = (sessionId: string | undefined = sid) => ({ user: { id: userId, role: "family", sid: sessionId }, query: {}, headers: {}, header: () => undefined }) as unknown as Request;
  const cookie = (token: string) => ({ ...request(), headers: { cookie: `droplet_app_shop=${token}` } }) as Request;
  const mint = async (sessionId = sid) => new URL((await service.mint(request(sessionId), "shop")).url).searchParams.get("code")!;
  return { service, user, codes, request, cookie, mint };
}

describe("hosted app credentials follow the dashboard revocation store", () => {
  beforeEach(() => { store.records.clear(); store.indexes.clear(); store.unavailable = false; store.denied = false; store.beforeTouch = undefined; signIn(); });

  it("binds the exchange and app JWT to the live sign-in and allows normal app requests", async () => {
    const f = fixture(); const code = await f.mint();
    expect([...f.codes.values()][0].sessionId).toBe(sid);
    const token = await f.service.redeem("shop", code);
    expect(jwt.verify(token, hostedJwtKey(), { audience: "app:shop" })).toMatchObject({ sub: userId, sid });
    expect((await f.service.session(f.cookie(token), "shop")).user.id).toBe(userId);
    expect(f.codes.size).toBe(0);
  });

  it("refuses an already exchanged app token after actual revoke-all removes its record", async () => {
    const f = fixture(); const token = await f.service.redeem("shop", await f.mint());
    expect(await revokeAllSessions(userId)).toBe(1);
    await expect(f.service.session(f.cookie(token), "shop")).rejects.toMatchObject({ status: 401, code: "app_session_revoked" });
    await expect(f.service.relay(f.cookie(token), {} as Response, "shop")).rejects.toMatchObject({ status: 401, code: "app_session_revoked" });
    // The account and app grant remain active: revocation alone must decide.
    expect(f.user.directoryStatus).toBe("ACTIVE");
  });

  it("refuses a pending one-use exchange after revoke-all and consumes it atomically", async () => {
    const f = fixture(); const code = await f.mint();
    await revokeAllSessions(userId);
    await expect(f.service.redeem("shop", code)).rejects.toMatchObject({ status: 401, code: "app_session_revoked" });
    expect(f.codes.size).toBe(0);
    await expect(f.service.redeem("shop", code)).rejects.toMatchObject({ status: 401, code: "exchange_code_invalid" });
  });

  it("refuses the in-flight and subsequent app request when revocation wins a pending activity touch", async () => {
    const f = fixture(); const token = await f.service.redeem("shop", await f.mint());
    const key = SESSION_KEY_PREFIX + sid;
    const record = JSON.parse(store.records.get(key)!);
    store.records.set(key, JSON.stringify({ ...record, lastSeenAt: record.lastSeenAt - 60 }));
    let entered!: () => void;
    let resume!: () => void;
    const touching = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { resume = resolve; });
    store.beforeTouch = async () => { entered(); await released; };
    const pending = f.service.session(f.cookie(token), "shop");
    const refused = expect(pending).rejects.toMatchObject({ status: 401, code: "app_session_revoked" });
    await touching;
    expect(await revokeAllSessions(userId)).toBe(1);
    resume();
    await refused;
    store.beforeTouch = undefined;
    expect(store.records.has(key)).toBe(false);
    await expect(f.service.session(f.cookie(token), "shop")).rejects.toMatchObject({ status: 401, code: "app_session_revoked" });
  });

  it("follows password-change revocation of other sign-ins while retaining the current sign-in", async () => {
    const f = fixture(); signIn("password-change-session");
    const stolen = await f.service.redeem("shop", await f.mint());
    const pending = await f.mint();
    const current = await f.service.redeem("shop", await f.mint("password-change-session"));
    expect(await revokeAllSessions(userId, { exceptSid: "password-change-session" })).toBe(1);
    await expect(f.service.session(f.cookie(stolen), "shop")).rejects.toMatchObject({ status: 401 });
    await expect(f.service.redeem("shop", pending)).rejects.toMatchObject({ status: 401 });
    expect((await f.service.session(f.cookie(current), "shop")).user.id).toBe(userId);
  });

  it("refuses expired, foreign and missing sign-in bindings plus old unbound app JWTs", async () => {
    const f = fixture();
    const unbound = f.request(); delete unbound.user!.sid;
    await expect(f.service.mint(unbound, "shop")).rejects.toMatchObject({ status: 401 });
    signIn("foreign-session", "other-user");
    await expect(f.mint("foreign-session")).rejects.toMatchObject({ status: 401 });
    signIn("expired-session", userId, 13 * 60 * 60);
    await expect(f.mint("expired-session")).rejects.toMatchObject({ status: 401 });
    const old = jwt.sign({}, hostedJwtKey(), { subject: userId, audience: "app:shop", issuer: "droplet-hosted", expiresIn: "1h" });
    await expect(f.service.session(f.cookie(old), "shop")).rejects.toMatchObject({ status: 401 });
  });

  it("fails closed on an unavailable sign-in store and a hard user denylist", async () => {
    const f = fixture(); const token = await f.service.redeem("shop", await f.mint());
    const pending = await f.mint();
    store.unavailable = true;
    await expect(f.service.session(f.cookie(token), "shop")).rejects.toMatchObject({ status: 503, code: "app_session_unavailable" });
    await expect(f.service.redeem("shop", pending)).rejects.toMatchObject({ status: 503, code: "app_session_unavailable" });
    await expect(f.mint()).rejects.toMatchObject({ status: 503 });
    store.unavailable = false; store.denied = true;
    await expect(f.service.session(f.cookie(token), "shop")).rejects.toMatchObject({ status: 401 });
  });

  it("retains anonymous, service and current guest refusal even with a live sign-in", async () => {
    const f = fixture(); const token = await f.service.redeem("shop", await f.mint());
    const anonymous = f.request(); delete anonymous.user;
    await expect(f.service.mint(anonymous, "shop")).rejects.toMatchObject({ status: 403 });
    const service = f.request(); service.user!.role = "service"; service.user!.id = "_service:mcp";
    await expect(f.service.mint(service, "shop")).rejects.toMatchObject({ status: 403 });
    f.user.role = "guest";
    await expect(f.service.session(f.cookie(token), "shop")).rejects.toMatchObject({ status: 403 });
  });
});
