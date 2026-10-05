/**
 * WARP-3533 — personal API tokens (`dpm_…`) for /api/pm and /api/support.
 *
 * The REAL authMiddleware, the REAL scope guard and rate limiter, and the real
 * token service, over an in-memory stand-in for the slice of PrismaClient they
 * use, mounted in the order app.ts mounts them. Pinned here:
 *   - the token: `dpm_` + 43 base64url chars, only sha256 stored, the prefix is
 *     the 8 chars after `dpm_`, scopes are normalised, expiry is optional;
 *   - it acts as its holder, read at THIS request: role and directory status are
 *     not frozen at minting, and a role change or a deactivation ends it;
 *   - AC: a revoked or expired token gets 401; a `pm:read` token gets 403 on
 *     writes; write implies read; a token never leaves /api/pm + /api/support;
 *   - the workspace switch: off = every token 401 and none deleted;
 *   - lastUsedAt is written at most once a minute per token;
 *   - the rate limit is per token, not per IP;
 *   - AC: the token never reaches a log line, an ActivityRow or a response body,
 *     including on the failure paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import crypto from "node:crypto";
import cookieParser from "cookie-parser";

const h = vi.hoisted(() => ({
  recordActivity: vi.fn(async (..._a: unknown[]) => null),
  logged: [] as string[],
}));

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true, JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa" },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => h.recordActivity(...a),
}));
// Every logger in the import graph writes here, so "never in a log line" is a
// statement about all of them.
vi.mock("../lib/logger.js", () => {
  const stub: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get: (_t, key) =>
        key === "then" ? undefined : key === "child" ? () => stub : (...args: unknown[]) => void h.logged.push(JSON.stringify(args)),
    },
  );
  return { createLogger: () => stub, levelFromEnv: () => "info" };
});

import { authMiddleware, validateTokenForWs } from "../middleware/auth.js";
import { createPmApiTokenRateLimit, pmApiTokenScopeGuard } from "../middleware/pm-api-token-guard.js";
import { createRequestLogger } from "../middleware/request-logger.js";
import {
  PM_API_TOKENS_ENABLED_KEY,
  PM_API_TOKEN_MAX_LIFETIME_MS,
  READ_ONLY_POSTS,
  SESSION_ONLY_ROUTES,
  resolvePmApiTokenPrincipal,
  bindPmApiTokenPrisma,
  createPmApiToken,
  hashPmApiToken,
  isPmApiTokensEnabled,
  isReadRequest,
  listPmApiTokens,
  normalizeScopes,
  recordPmApiTokenUse,
  requiredScope,
  resetPmApiTokenUseMemo,
  revokePmApiToken,
  revokePmApiTokensForUser,
  scopeAllows,
  setPmApiTokensEnabled,
  tokenAreaForPath,
} from "../services/pm/pm-api-token.service.js";

type Row = Record<string, unknown>;
interface Tok extends Row {
  id: string;
  userId: string;
  hash: string;
  status: string;
  issuedRole: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
}
interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  directoryStatus: string;
}

/** Prisma `where` semantics for the operators the service uses. */
function cond(value: unknown, c: unknown): boolean {
  if (c === null) return value === null || value === undefined;
  if (c instanceof Date) return value instanceof Date && value.getTime() === c.getTime();
  if (typeof c === "object") {
    const o = c as Record<string, unknown>;
    if ("in" in o) return (o.in as unknown[]).includes(value);
    if (value === null || value === undefined) return false;
    if ("lte" in o) return (value as Date) <= (o.lte as Date);
    if ("lt" in o) return (value as Date) < (o.lt as Date);
    if ("gte" in o) return (value as Date) >= (o.gte as Date);
  }
  return value === c;
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, c]) =>
    k === "OR" ? (c as Row[]).some((w) => matches(row, w)) : cond(row[k], c),
  );
}

function makeDb() {
  const users = new Map<string, UserRow>(
    [
      ["u-owner", "olivia", "owner"],
      ["u-admin", "ada", "admin"],
      ["u-member", "maria", "family"],
      ["u-member2", "marco", "family"],
      ["u-guest", "gus", "guest"],
    ].map(([id, username, role]) => [id, { id, username, displayName: username, role, directoryStatus: "ACTIVE" }]),
  );
  const tokens: Tok[] = [];
  const settings = new Map<string, unknown>();
  let n = 0;
  const withUser = (t: Tok, include?: { user?: unknown }) => {
    const out: Row = { ...t };
    if (include?.user) out.user = { ...users.get(t.userId)! };
    return out;
  };
  return {
    users,
    tokens,
    settings,
    workspaceSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { valueJson: settings.get(where.key) } : null,
      ),
      upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: Row; update: Row }) => {
        settings.set(where.key, settings.has(where.key) ? update.valueJson : create.valueJson);
        return {};
      }),
    },
    pmApiToken: {
      create: vi.fn(async ({ data }: { data: Row & Pick<Tok, "userId" | "expiresAt"> }) => {
        const t = {
          id: `tok-${++n}`,
          status: "active",
          createdAt: new Date(),
          lastUsedAt: null,
          revokedAt: null,
          revokedReason: null,
          revokedById: null,
          refusalAuditedAt: null,
          ...data,
        } as unknown as Tok;
        tokens.push(t);
        return { ...t };
      }),
      findUnique: vi.fn(async ({ where, include }: { where: Row; include?: { user?: unknown } }) => {
        const t = tokens.find((r) => matches(r, where));
        return t ? withUser(t, include) : null;
      }),
      findMany: vi.fn(async ({ where, include }: { where: Row; include?: { user?: unknown } }) =>
        tokens
          .filter((r) => matches(r, where))
          .sort((a, b) => +b.createdAt - +a.createdAt)
          .map((t) => withUser(t, include)),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const t of tokens) if (matches(t, where)) (Object.assign(t, data), count++);
        return { count };
      }),
    },
  };
}
type Db = ReturnType<typeof makeDb>;

const SECRET_OF = (token: string) => token.slice("dpm_".length);

function switchOn(db: Db) {
  db.settings.set(PM_API_TOKENS_ENABLED_KEY, true);
}

async function mint(
  db: Db,
  who = "u-member",
  scopes: string[] = ["pm:read"],
  expiresAt: Date | null = null,
): Promise<{ token: string; id: string }> {
  const u = db.users.get(who)!;
  const { token, row } = await createPmApiToken(db as never, { id: u.id, role: u.role }, { name: "ci", scopes, expiresAt });
  return { token, id: row.id };
}

let appSeq = 0;
/** The order app.ts mounts them: authMiddleware → rate limit → scope guard → routers. */
function buildApp(db: Db, limit = 300) {
  bindPmApiTokenPrisma(db as never);
  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser());
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createPmApiTokenRateLimit(limit, `pm-api-token-test-${++appSeq}`));
  app.use(pmApiTokenScopeGuard);
  app.all(
    [
      "/api/pm/ping",
      "/api/support/ping",
      "/api/files/ping",
      "/api/auth/me",
      "/api/developer",
      "/api/pmx/ping",
      // WARP-3533 review: a read-only POST, and the admin routes a token may never call.
      "/api/pm/work-items/query",
      "/api/pm/work-items/bulk",
      "/api/pm/webhooks",
      "/api/pm/webhooks/:id/deliveries",
      "/api/pm/projects/:id/settings",
      "/api/support/webhooks",
      "/api/support/settings",
    ],
    (req, res) => res.json({ user: req.user, apiToken: req.apiToken, method: req.method }),
  );
  return app;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const DAY = 86_400_000;

beforeEach(() => {
  h.recordActivity.mockClear();
  h.logged.length = 0;
  resetPmApiTokenUseMemo();
});

describe("WARP-3533 — the token", () => {
  it("is dpm_ + 43 base64url chars; only its sha256 is stored; the prefix is the 8 chars after dpm_", async () => {
    const db = makeDb();
    const { token, id } = await mint(db, "u-member", ["pm:write", "pm:read", "pm:read"]);
    expect(token).toMatch(/^dpm_[A-Za-z0-9_-]{43}$/);
    const stored = db.tokens.find((t) => t.id === id)!;
    expect(stored.hash).toBe(hashPmApiToken(token));
    expect(stored.prefix).toBe(token.slice(4, 12));
    expect(JSON.stringify(db.tokens)).not.toContain(SECRET_OF(token));
    // normalised: each scope once, in vocabulary order
    expect(stored.scopes).toEqual(["pm:read", "pm:write"]);
    expect(stored.issuedRole).toBe("family");
  });

  it("two tokens are never equal", async () => {
    const db = makeDb();
    const a = await mint(db);
    const b = await mint(db);
    expect(a.token).not.toBe(b.token);
    expect(db.tokens[0].hash).not.toBe(db.tokens[1].hash);
  });

  it("refuses a holder who may not hold one (guest, service) and a scope outside the vocabulary", async () => {
    const db = makeDb();
    await expect(
      createPmApiToken(db as never, { id: "u-guest", role: "guest" }, { name: "x", scopes: ["pm:read"], expiresAt: null }),
    ).rejects.toThrow("role_not_allowed");
    await expect(
      createPmApiToken(db as never, { id: "s", role: "service" }, { name: "x", scopes: ["pm:read"], expiresAt: null }),
    ).rejects.toThrow("role_not_allowed");
    await expect(
      createPmApiToken(db as never, { id: "u-member", role: "family" }, { name: "x", scopes: ["pm:read", "admin:all"], expiresAt: null }),
    ).rejects.toThrow("invalid_scopes");
    await expect(
      createPmApiToken(db as never, { id: "u-member", role: "family" }, { name: "x", scopes: [], expiresAt: null }),
    ).rejects.toThrow("invalid_scopes");
    expect(db.tokens).toHaveLength(0);
  });

  it("normalizeScopes keeps only the vocabulary, once each", () => {
    expect(normalizeScopes(["support:write", "pm:read", "x", "pm:read"])).toEqual(["pm:read", "support:write"]);
  });

  it("scope semantics: write implies read; read implies nothing more; areas do not mix; unknown verbs are writes", () => {
    expect(scopeAllows(["pm:read"], "pm", "GET")).toBe(true);
    expect(scopeAllows(["pm:read"], "pm", "HEAD")).toBe(true);
    expect(scopeAllows(["pm:read"], "pm", "POST")).toBe(false);
    expect(scopeAllows(["pm:read"], "pm", "PURGE")).toBe(false);
    expect(scopeAllows(["pm:write"], "pm", "GET")).toBe(true);
    expect(scopeAllows(["pm:write"], "pm", "DELETE")).toBe(true);
    expect(scopeAllows(["support:read", "support:write"], "pm", "GET")).toBe(false);
    expect(scopeAllows(["pm:read", "pm:write"], "support", "GET")).toBe(false);
  });

  it("tokenAreaForPath is segment-bounded, case-insensitive and tolerant of a trailing slash", () => {
    expect(tokenAreaForPath("/api/pm")).toBe("pm");
    expect(tokenAreaForPath("/api/pm/projects/1")).toBe("pm");
    expect(tokenAreaForPath("/API/PM/projects")).toBe("pm");
    expect(tokenAreaForPath("/api/pm/")).toBe("pm");
    expect(tokenAreaForPath("/api/support/tickets")).toBe("support");
    expect(tokenAreaForPath("/api/pmx/ping")).toBeNull();
    expect(tokenAreaForPath("/api/pm-evil")).toBeNull();
    expect(tokenAreaForPath("/api/mobile/pm/projects")).toBeNull();
    expect(tokenAreaForPath("/api/developer")).toBeNull();
    expect(tokenAreaForPath("//api/pm/x")).toBeNull();
    expect(tokenAreaForPath("/")).toBeNull();
  });
});

describe("WARP-3533 — it acts as its holder, read at this request", () => {
  it("resolves to the holder's current row, carries the scopes, and reaches the route", async () => {
    const db = makeDb();
    switchOn(db);
    const { token, id } = await mint(db, "u-member", ["pm:read"]);
    const res = await request(buildApp(db)).get("/api/pm/ping").set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: "u-member", username: "maria", displayName: "maria", role: "family" });
    expect(res.body.apiToken).toEqual({ id, scopes: ["pm:read"] });
    // Not a session: no MFA stamp, no session id, nothing a step-up gate could be satisfied by.
    expect(res.body.user.lastMfaAt).toBeUndefined();
    expect(res.body.user.sid).toBeUndefined();
    expect(res.body.user.accessRoleId).toBeUndefined();
  });

  it("a person whose role changed gets a 401, and the token is stamped revoked (role_changed)", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member");
    db.users.get("u-member")!.role = "admin"; // promotion
    const res = await request(buildApp(db)).get("/api/pm/ping").set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_REVOKED");
    expect(db.tokens[0]).toMatchObject({ status: "revoked", revokedReason: "role_changed" });
    expect(db.tokens[0].revokedAt).toBeInstanceOf(Date);
    // Putting the role back does not bring it back.
    db.users.get("u-member")!.role = "family";
    expect((await request(buildApp(db)).get("/api/pm/ping").set(bearer(token))).status).toBe(401);
  });

  it("a demotion to guest ends it too", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member");
    db.users.get("u-member")!.role = "guest";
    expect((await request(buildApp(db)).get("/api/pm/ping").set(bearer(token))).status).toBe(401);
    expect(db.tokens[0]).toMatchObject({ status: "revoked", revokedReason: "role_changed" });
  });

  it("a deactivated person's token is a 401 and is stamped revoked (user_deactivated)", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member");
    db.users.get("u-member")!.directoryStatus = "DEACTIVATED";
    const res = await request(buildApp(db)).get("/api/pm/ping").set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_REVOKED");
    expect(db.tokens[0]).toMatchObject({ status: "revoked", revokedReason: "user_deactivated" });
  });

  it("another person's token is not borrowed: a token never resolves to anyone but its holder", async () => {
    const db = makeDb();
    switchOn(db);
    const a = await mint(db, "u-member");
    const b = await mint(db, "u-member2");
    const app = buildApp(db);
    expect((await request(app).get("/api/pm/ping").set(bearer(a.token))).body.user.id).toBe("u-member");
    expect((await request(app).get("/api/pm/ping").set(bearer(b.token))).body.user.id).toBe("u-member2");
  });
});

describe("WARP-3533 — AC: revoked or expired gets 401", () => {
  it("revoke keeps the row, says who and why, is idempotent, and the token is a 401 at once", async () => {
    const db = makeDb();
    switchOn(db);
    const { token, id } = await mint(db, "u-member");
    const app = buildApp(db);
    expect((await request(app).get("/api/pm/ping").set(bearer(token))).status).toBe(200);

    expect(await revokePmApiToken(db as never, id, { userId: "u-member2", isAdmin: false })).toBe("not_found");
    expect(db.tokens[0].status).toBe("active");
    expect(await revokePmApiToken(db as never, id, { userId: "u-admin", isAdmin: true })).toMatchObject({ userId: "u-member" });
    expect(db.tokens).toHaveLength(1);
    expect(db.tokens[0]).toMatchObject({ status: "revoked", revokedReason: "manual", revokedById: "u-admin" });
    expect(await revokePmApiToken(db as never, id, { userId: "u-member", isAdmin: false })).toBe("already");

    const res = await request(app).get("/api/pm/ping").set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or expired token", code: "TOKEN_REVOKED" });
    expect(res.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
  });

  it("expiry: an overdue token is a 401 and is stamped expired; no expiry never expires", async () => {
    const db = makeDb();
    switchOn(db);
    const soon = await mint(db, "u-member", ["pm:read"], new Date(Date.now() + 60_000));
    const never = await mint(db, "u-member", ["pm:read"], null);
    const app = buildApp(db);
    expect((await request(app).get("/api/pm/ping").set(bearer(soon.token))).status).toBe(200);

    db.tokens[0].expiresAt = new Date(Date.now() - 1);
    const res = await request(app).get("/api/pm/ping").set(bearer(soon.token));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_EXPIRED");
    expect(db.tokens[0].status).toBe("expired");
    expect((await request(app).get("/api/pm/ping").set(bearer(soon.token))).body.code).toBe("TOKEN_EXPIRED");
    expect((await request(app).get("/api/pm/ping").set(bearer(never.token))).status).toBe(200);
  });

  it("a listing stamps an overdue active token expired, so the page never shows a dead token as active", async () => {
    const db = makeDb();
    await mint(db, "u-member", ["pm:read"], new Date(Date.now() - DAY));
    const rows = await listPmApiTokens(db as never, "u-member");
    expect(rows[0].status).toBe("expired");
  });

  it("an unknown, malformed, empty or oversized token is a 401 TOKEN_INVALID, and the database is asked for a hash only", async () => {
    const db = makeDb();
    switchOn(db);
    const app = buildApp(db);
    for (const t of ["dpm_", "dpm_nope", `dpm_${"A".repeat(43)}`, `dpm_${"A".repeat(500)}`]) {
      const res = await request(app).get("/api/pm/ping").set(bearer(t));
      expect(res.status, t.slice(0, 20)).toBe(401);
      expect(res.body.code).toBe("TOKEN_INVALID");
    }
    for (const call of db.pmApiToken.findUnique.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("dpm_");
    }
  });

  it("a token without the prefix is not this branch: it falls through to the JWT path and is a 401", async () => {
    const db = makeDb();
    const res = await request(buildApp(db)).get("/api/pm/ping").set(bearer(SECRET_OF("dpm_" + "A".repeat(43))));
    expect(res.status).toBe(401);
  });

  it("a refused revoked/expired use writes ONE audit row per token per hour, with ids only", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member");
    db.tokens[0].status = "revoked";
    db.tokens[0].revokedAt = new Date();
    db.tokens[0].revokedReason = "manual";
    const app = buildApp(db);
    await request(app).get("/api/pm/ping").set(bearer(token));
    await request(app).get("/api/pm/ping").set(bearer(token));
    await request(app).get("/api/pm/ping").set(bearer(token));
    const refusals = h.recordActivity.mock.calls.filter((c) => (c[0] as { what: string }).what === "API token refused: token revoked");
    expect(refusals).toHaveLength(1);
    expect((refusals[0][0] as { refs: Row }).refs).toEqual({ tokenId: db.tokens[0].id, userId: "u-member", reason: "revoked" });
  });
});

describe("WARP-3533 — AC: a pm:read token gets 403 on writes; scopes only narrow", () => {
  it("pm:read: GET is served, every write is 403 insufficient_scope with the scope it needs", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member", ["pm:read"]);
    const app = buildApp(db);
    expect((await request(app).get("/api/pm/ping").set(bearer(token))).status).toBe(200);
    expect((await request(app).head("/api/pm/ping").set(bearer(token))).status).toBe(200);
    for (const verb of ["post", "put", "patch", "delete"] as const) {
      const res = await request(app)[verb]("/api/pm/ping").set(bearer(token));
      expect(res.status, verb).toBe(403);
      expect(res.body).toEqual({ error: "insufficient_scope", required: "pm:write" });
      expect(res.headers["www-authenticate"]).toBe('Bearer error="insufficient_scope", scope="pm:write"');
    }
  });

  it("pm:write alone may read and write", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member", ["pm:write"]);
    const app = buildApp(db);
    expect((await request(app).get("/api/pm/ping").set(bearer(token))).status).toBe(200);
    expect((await request(app).post("/api/pm/ping").set(bearer(token))).status).toBe(200);
  });

  it("the areas do not mix: a support token is 403 on /api/pm and a pm token is 403 on /api/support", async () => {
    const db = makeDb();
    switchOn(db);
    const support = await mint(db, "u-member", ["support:read", "support:write"]);
    const pm = await mint(db, "u-member", ["pm:read", "pm:write"]);
    const app = buildApp(db);
    expect((await request(app).get("/api/pm/ping").set(bearer(support.token))).body).toEqual({
      error: "insufficient_scope",
      required: "pm:read",
    });
    expect((await request(app).get("/api/support/ping").set(bearer(support.token))).status).toBe(200);
    expect((await request(app).get("/api/support/ping").set(bearer(pm.token))).status).toBe(403);
  });

  it("it is the holder's permissions, narrowed: the guard changes nothing about who the holder is", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-admin", ["pm:read", "pm:write"]);
    const res = await request(buildApp(db)).post("/api/pm/ping").set(bearer(token));
    expect(res.body.user.role).toBe("admin");
  });
});

describe("WARP-3533 — a token never leaves /api/pm and /api/support", () => {
  it("every other route is 403 TOKEN_ROUTE_FORBIDDEN, before the token is even looked up", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-owner", ["pm:read", "pm:write", "support:read", "support:write"]);
    const app = buildApp(db);
    db.pmApiToken.findUnique.mockClear();
    for (const path of ["/api/files/ping", "/api/auth/me", "/api/developer", "/api/pmx/ping"]) {
      const res = await request(app).get(path).set(bearer(token));
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe("TOKEN_ROUTE_FORBIDDEN");
    }
    // A bad token gets the same answer there: the route is refused first, so it is no oracle.
    const bad = await request(app).get("/api/files/ping").set(bearer("dpm_" + "B".repeat(43)));
    expect(bad.status).toBe(403);
    expect(db.pmApiToken.findUnique).not.toHaveBeenCalled();
  });

  it("case and a trailing slash do not slip past: /API/PM is still the PM area and still needs its scope", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member", ["pm:read"]);
    const app = buildApp(db);
    expect((await request(app).get("/API/PM/ping").set(bearer(token))).status).toBe(200);
    expect((await request(app).post("/API/PM/ping").set(bearer(token))).status).toBe(403);
    expect((await request(app).post("/api/pm/ping/").set(bearer(token))).status).toBe(403);
  });

  it("a cookie that carries a token is refused outright, even beside a valid header", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member");
    const app = buildApp(db);
    const res = await request(app).get("/api/pm/ping").set("Cookie", `droplet_session=${token}`);
    expect(res.status).toBe(401);
    const both = await request(app).get("/api/pm/ping").set("Cookie", `droplet_session=${token}`).set(bearer(token));
    expect(both.status).toBe(401);
  });

  it("a token never opens a WebSocket", async () => {
    const db = makeDb();
    const { token } = await mint(db, "u-member");
    expect(await validateTokenForWs(token)).toBeNull();
  });

  it("a guard reached by a token on a path it did not see (a router mounted ahead of authMiddleware's check) is still 403", () => {
    const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    pmApiTokenScopeGuard(
      { apiToken: { id: "t", scopes: ["pm:read", "pm:write"] }, path: "/api/files/x", method: "GET", user: { role: "family" }, headers: {} } as never,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("a request with no token is untouched by the guard", async () => {
    const db = makeDb();
    const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    pmApiTokenScopeGuard({ path: "/api/files/x", method: "GET", headers: {} } as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    void db;
  });
});

describe("WARP-3533 review — an anonymous caller cannot write audit rows", () => {
  it("N junk dpm_ bearers at routes a token may never call: 403 each, zero ActivityRows, zero lookups, no path in any log", async () => {
    const db = makeDb();
    switchOn(db);
    const app = buildApp(db, 100_000);
    const longTail = "x".repeat(2000);
    const targets = [
      `/api/developer/${longTail}`,
      `/api/files/${longTail}`,
      "/api/auth/me",
      `/api/pm/webhooks/${longTail}`, // session-only: out of a token's reach even under /api/pm
      `/api/support/settings/${longTail}`,
    ];
    db.pmApiToken.findUnique.mockClear();
    let n = 0;
    for (const path of targets) {
      for (let i = 0; i < 6; i++, n++) {
        const res = await request(app)
          .get(path)
          .set(bearer(`dpm_${"J".repeat(43)}${i}`));
        expect(res.status, path.slice(0, 40)).toBe(403);
        expect(res.body.code).toBe("TOKEN_ROUTE_FORBIDDEN");
      }
    }
    expect(n).toBe(30);
    expect(h.recordActivity).not.toHaveBeenCalled();
    expect(db.pmApiToken.findUnique).not.toHaveBeenCalled();
    expect(h.logged.join("\n")).not.toContain(longTail);
  });

  it("the same with a VALID token on those routes: still 403, still no row (the refusal happens before the lookup)", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-owner", ["pm:read", "pm:write", "support:read", "support:write"]);
    const app = buildApp(db, 100_000);
    db.pmApiToken.findUnique.mockClear();
    for (const path of ["/api/developer", "/api/pm/webhooks", "/api/support/settings"]) {
      expect((await request(app).get(path).set(bearer(token))).status, path).toBe(403);
    }
    expect(h.recordActivity).not.toHaveBeenCalled();
    expect(db.pmApiToken.findUnique).not.toHaveBeenCalled();
  });

  it("a scope denial of a validated token still audits, bounded by that token's rate limit", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member", ["pm:read"]);
    const app = buildApp(db, 3);
    for (let i = 0; i < 6; i++) await request(app).post("/api/pm/ping").set(bearer(token));
    expect(h.recordActivity.mock.calls.filter((c) => (c[0] as { what: string }).what === "Access denied")).toHaveLength(3);
  });
});

describe("WARP-3533 review — admin configuration is session-only", () => {
  const SESSION_ONLY_PATHS = [
    "/api/pm/webhooks",
    "/api/pm/webhooks/",
    "/api/pm/webhooks/wh-1",
    "/api/pm/webhooks/wh-1/deliveries",
    "/API/PM/WEBHOOKS",
    "/api/pm/projects/p1/settings",
    "/api/pm/projects/p1/settings/states",
    "/api/pm/workspaces/settings",
    "/api/support/webhooks",
    "/api/support/settings",
    "/api/support/settings/sla",
    "/api/support/queues/settings",
  ];

  it("tokenAreaForPath refuses every session-only shape, whatever the case or trailing slash", () => {
    for (const path of SESSION_ONLY_PATHS) expect(tokenAreaForPath(path), path).toBeNull();
  });

  it("and only those: the neighbours stay reachable (segment-bounded)", () => {
    for (const path of [
      "/api/pm/webhooks-archive",
      "/api/pm/webhookss",
      "/api/pm/projects/p1/settingsx",
      "/api/pm/projects/p1/work-items",
      "/api/pm/projects/settings-of-the-year/states",
      "/api/pm/work-items/p1/comments",
    ]) {
      expect(tokenAreaForPath(path), path).toBe("pm");
    }
    expect(tokenAreaForPath("/api/support/tickets/t1")).toBe("support");
  });

  it("is listed in one place, and every entry names a prefix under the two areas", () => {
    expect(SESSION_ONLY_ROUTES.length).toBeGreaterThan(0);
    for (const pattern of SESSION_ONLY_ROUTES) {
      expect(pattern, pattern).toMatch(/^\/api\/(pm|support)\/[a-z*/-]+$/);
      expect(pattern.endsWith("/"), pattern).toBe(false);
    }
  });

  it("a token holding every scope is a 403 TOKEN_ROUTE_FORBIDDEN on each, with no lookup and no row", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-owner", ["pm:read", "pm:write", "support:read", "support:write"]);
    const app = buildApp(db);
    db.pmApiToken.findUnique.mockClear();
    const concrete: Array<[string, string]> = [
      ["get", "/api/pm/webhooks"],
      ["post", "/api/pm/webhooks"],
      ["delete", "/api/pm/webhooks/wh-1/deliveries"],
      ["patch", "/api/pm/projects/p1/settings"],
      ["get", "/API/PM/Webhooks/"],
      ["put", "/api/support/settings"],
      ["post", "/api/support/webhooks"],
    ];
    for (const [verb, path] of concrete) {
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[verb](path).set(bearer(token));
      // The test app serves the paths that exist in it; the guard answers first either way.
      expect(res.status, `${verb} ${path}`).toBe(403);
      expect(res.body.code, `${verb} ${path}`).toBe("TOKEN_ROUTE_FORBIDDEN");
    }
    expect(db.pmApiToken.findUnique).not.toHaveBeenCalled();
    expect(h.recordActivity).not.toHaveBeenCalled();
  });

  it("the same routes are untouched for a SESSION principal (the guard only ever looks at tokens)", async () => {
    const db = makeDb();
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: "u-owner", username: "olivia", displayName: "Olivia", role: "owner" } as never;
      next();
    });
    app.use(pmApiTokenScopeGuard);
    app.all("/api/pm/webhooks", (_req, res) => res.json({ ok: true }));
    expect((await request(app).post("/api/pm/webhooks")).status).toBe(200);
    void db;
  });
});

describe("WARP-3533 review — read-only POSTs", () => {
  it("scope semantics: a POST to a READ_ONLY_POSTS path needs only read, in any case and with a trailing slash", () => {
    expect([...READ_ONLY_POSTS]).toEqual(["/api/pm/work-items/query"]);
    for (const path of ["/api/pm/work-items/query", "/api/pm/work-items/query/", "/API/PM/Work-Items/QUERY"]) {
      expect(isReadRequest("POST", path), path).toBe(true);
      expect(scopeAllows(["pm:read"], "pm", "POST", path), path).toBe(true);
      expect(requiredScope("pm", "POST", path), path).toBe("pm:read");
    }
  });

  it("and ONLY that: not another verb, not another path, not another area", () => {
    const q = "/api/pm/work-items/query";
    for (const verb of ["PUT", "PATCH", "DELETE", "PROPFIND", "PURGE"]) {
      expect(scopeAllows(["pm:read"], "pm", verb, q), verb).toBe(false);
      expect(requiredScope("pm", verb, q), verb).toBe("pm:write");
    }
    for (const path of [
      "/api/pm/work-items/queryx",
      "/api/pm/work-items/query/extra",
      "/api/pm/work-items/bulk",
      "/api/pm/work-items",
      "/api/pm/projects/p1/work-items",
      "/api/pm/work-items/p1/query",
      "",
    ]) {
      expect(scopeAllows(["pm:read"], "pm", "POST", path), path).toBe(false);
      expect(requiredScope("pm", "POST", path), path).toBe("pm:write");
    }
    // The old two-argument form still means "a POST is a write".
    expect(scopeAllows(["pm:read"], "pm", "POST")).toBe(false);
    // A support-only token has no pm scope at all.
    expect(scopeAllows(["support:read"], "pm", "POST", q)).toBe(false);
    // Write still implies read, so a write token may call it too.
    expect(scopeAllows(["pm:write"], "pm", "POST", q)).toBe(true);
  });

  it("over HTTP: a pm:read token may POST the query route and nothing else; a write route stays 403", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member", ["pm:read"]);
    const app = buildApp(db);
    const ok = await request(app).post("/api/pm/work-items/query").set(bearer(token)).send({ filter: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.method).toBe("POST");
    const denied = await request(app).post("/api/pm/work-items/bulk").set(bearer(token)).send({});
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: "insufficient_scope", required: "pm:write" });
    expect((await request(app).put("/api/pm/work-items/query").set(bearer(token))).status).toBe(403);
  });
});

describe("WARP-3533 — the workspace switch", () => {
  it("defaults to off: a missing row, a malformed value and an unreadable table are all off", async () => {
    const db = makeDb();
    expect(await isPmApiTokensEnabled(db as never)).toBe(false);
    db.settings.set(PM_API_TOKENS_ENABLED_KEY, "true");
    expect(await isPmApiTokensEnabled(db as never)).toBe(false);
    db.settings.set(PM_API_TOKENS_ENABLED_KEY, 1);
    expect(await isPmApiTokensEnabled(db as never)).toBe(false);
    db.workspaceSetting.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await isPmApiTokensEnabled(db as never)).toBe(false);
  });

  it("off: every token is a 401 TOKEN_DISABLED and none is deleted or stamped; on again: they work", async () => {
    const db = makeDb();
    const { token } = await mint(db, "u-member");
    const other = await mint(db, "u-owner", ["pm:read", "pm:write"]);
    const app = buildApp(db);

    // seeded off
    for (const t of [token, other.token]) {
      const res = await request(app).get("/api/pm/ping").set(bearer(t));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("TOKEN_DISABLED");
    }
    expect(db.tokens.map((t) => t.status)).toEqual(["active", "active"]);
    expect(h.recordActivity).not.toHaveBeenCalled();

    expect(await setPmApiTokensEnabled(db as never, true)).toBe(true);
    expect((await request(app).get("/api/pm/ping").set(bearer(token))).status).toBe(200);

    expect(await setPmApiTokensEnabled(db as never, true)).toBe(false);
    expect(await setPmApiTokensEnabled(db as never, false)).toBe(true);
    expect((await request(app).get("/api/pm/ping").set(bearer(token))).status).toBe(401);
    expect(db.tokens).toHaveLength(2);
  });
});

describe("WARP-3533 — lastUsedAt is written at most once a minute per token", () => {
  it("many requests in a minute make one write; the next minute makes another", async () => {
    const db = makeDb();
    const { id } = await mint(db, "u-member");
    const t0 = new Date("2026-10-04T10:00:00Z");
    for (let i = 0; i < 25; i++) await recordPmApiTokenUse(db as never, id, new Date(t0.getTime() + i * 1000));
    expect(db.pmApiToken.updateMany).toHaveBeenCalledTimes(1);
    expect(db.tokens[0].lastUsedAt).toEqual(t0);

    await recordPmApiTokenUse(db as never, id, new Date(t0.getTime() + 61_000));
    expect(db.pmApiToken.updateMany).toHaveBeenCalledTimes(2);
    expect(db.tokens[0].lastUsedAt).toEqual(new Date(t0.getTime() + 61_000));
  });

  it("a restart does not make it a write per request: the statement itself is conditional", async () => {
    const db = makeDb();
    const { id } = await mint(db, "u-member");
    const t0 = new Date("2026-10-04T10:00:00Z");
    await recordPmApiTokenUse(db as never, id, t0);
    resetPmApiTokenUseMemo(); // a new process
    await recordPmApiTokenUse(db as never, id, new Date(t0.getTime() + 5_000));
    // The statement ran, but its WHERE matched nothing: lastUsedAt is still t0.
    expect(db.tokens[0].lastUsedAt).toEqual(t0);
  });

  it("over HTTP: a burst of requests is one lastUsedAt write", async () => {
    const db = makeDb();
    switchOn(db);
    const { token, id } = await mint(db, "u-member");
    const app = buildApp(db);
    for (let i = 0; i < 6; i++) await request(app).get("/api/pm/ping").set(bearer(token));
    await vi.waitFor(() => expect(db.tokens.find((t) => t.id === id)!.lastUsedAt).toBeInstanceOf(Date));
    const lastUsedWrites = db.pmApiToken.updateMany.mock.calls.filter(
      (c) => "lastUsedAt" in ((c[0] as { data: Row }).data),
    );
    expect(lastUsedWrites).toHaveLength(1);
  });

  it("accounting only: a failed write is never a refusal", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member");
    const app = buildApp(db);
    db.pmApiToken.updateMany.mockRejectedValueOnce(new Error("db hiccup"));
    expect((await request(app).get("/api/pm/ping").set(bearer(token))).status).toBe(200);
  });
});

describe("WARP-3533 — rate limit, keyed by token", () => {
  it("one token's budget is its own: spent, it is a 429; another token and the same IP are fine", async () => {
    const db = makeDb();
    switchOn(db);
    const a = await mint(db, "u-member");
    const b = await mint(db, "u-member2");
    const app = buildApp(db, 3);
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get("/api/pm/ping").set(bearer(a.token)).set("X-Forwarded-For", "10.0.0.1")).status).toBe(200);
    }
    const limited = await request(app).get("/api/pm/ping").set(bearer(a.token)).set("X-Forwarded-For", "10.0.0.1");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "Too many requests, slow down" });
    expect(limited.headers["ratelimit"]).toBeDefined();
    // Keyed by TOKEN, not by IP: the same token from another address is still spent...
    expect((await request(app).get("/api/pm/ping").set(bearer(a.token)).set("X-Forwarded-For", "10.0.0.2")).status).toBe(429);
    // ...and another token from the SAME address is untouched.
    expect((await request(app).get("/api/pm/ping").set(bearer(b.token)).set("X-Forwarded-For", "10.0.0.1")).status).toBe(200);
  });

  it("scope denials count against the same budget, so the denial rows are bounded by it", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member", ["pm:read"]);
    const app = buildApp(db, 2);
    expect((await request(app).post("/api/pm/ping").set(bearer(token))).status).toBe(403);
    expect((await request(app).post("/api/pm/ping").set(bearer(token))).status).toBe(403);
    expect((await request(app).post("/api/pm/ping").set(bearer(token))).status).toBe(429);
    const denials = h.recordActivity.mock.calls.filter((c) => (c[0] as { what: string }).what === "Access denied");
    expect(denials).toHaveLength(2);
  });
});

describe("WARP-3533 — the lifecycle hook", () => {
  it("revokes every token the person holds that is not already revoked, with the reason, and audits it once", async () => {
    const db = makeDb();
    await mint(db, "u-member");
    await mint(db, "u-member");
    await mint(db, "u-member2");
    db.tokens[1].status = "expired";
    bindPmApiTokenPrisma(db as never);

    await revokePmApiTokensForUser("u-member", "user_deactivated", { type: "user", id: "u-admin" });
    expect(db.tokens.map((t) => [t.userId, t.status, t.revokedReason])).toEqual([
      ["u-member", "revoked", "user_deactivated"],
      ["u-member", "revoked", "user_deactivated"],
      ["u-member2", "active", null],
    ]);
    expect(h.recordActivity.mock.calls.filter((c) => (c[0] as { what: string }).what === "API tokens revoked")).toHaveLength(1);

    await revokePmApiTokensForUser("u-member2", "role_changed", { type: "user", id: "u-admin" });
    expect(db.tokens[2]).toMatchObject({ status: "revoked", revokedReason: "role_changed" });

    // Nothing left: no second row for the same person.
    await revokePmApiTokensForUser("u-member", "user_deactivated", { type: "user", id: "u-admin" });
    expect(h.recordActivity.mock.calls.filter((c) => (c[0] as { what: string }).what === "API tokens revoked")).toHaveLength(2);
  });

  it("never throws: unbound it logs and returns; a failing write is logged and swallowed", async () => {
    bindPmApiTokenPrisma(null);
    await expect(revokePmApiTokensForUser("u-member", "user_deactivated", { type: "system", id: null })).resolves.toBeUndefined();
    expect(h.logged.join("\n")).toContain("API token revoke not wired");

    const db = makeDb();
    bindPmApiTokenPrisma(db as never);
    db.pmApiToken.updateMany.mockRejectedValueOnce(new Error("boom"));
    await expect(revokePmApiTokensForUser("u-member", "role_changed", { type: "system", id: null })).resolves.toBeUndefined();
  });

  it("unbound, the middleware refuses every token", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member");
    const app = buildApp(db);
    bindPmApiTokenPrisma(null);
    expect((await request(app).get("/api/pm/ping").set(bearer(token))).status).toBe(401);
  });
});

describe("WARP-3533 — AC: the token never appears in logs, audit rows or responses", () => {
  it("not across mint, use, refusal, scope denial, switch-off, lifecycle revoke and a database failure", async () => {
    const db = makeDb();
    switchOn(db);
    const { token, id } = await mint(db, "u-member", ["pm:read"]);
    const secret = SECRET_OF(token);
    const bodies: string[] = [];
    const app = buildApp(db);
    const hit = async (r: request.Test) => {
      const res = await r;
      bodies.push(JSON.stringify(res.body) + JSON.stringify(res.headers) + res.text);
      return res;
    };

    await hit(request(app).get("/api/pm/ping").set(bearer(token))); // use
    await hit(request(app).post("/api/pm/ping").set(bearer(token))); // scope denial
    await hit(request(app).get("/api/files/ping").set(bearer(token))); // route denial
    await hit(request(app).get("/api/pm/ping").set("Cookie", `droplet_session=${token}`)); // cookie refusal
    await setPmApiTokensEnabled(db as never, false);
    await hit(request(app).get("/api/pm/ping").set(bearer(token))); // switch off
    await setPmApiTokensEnabled(db as never, true);
    db.tokens.find((t) => t.id === id)!.expiresAt = new Date(Date.now() - 1);
    await hit(request(app).get("/api/pm/ping").set(bearer(token))); // expired + refusal audit
    await revokePmApiToken(db as never, id, { userId: "u-member", isAdmin: false }); // manual revoke
    await hit(request(app).get("/api/pm/ping").set(bearer(token))); // revoked + refusal audit
    bindPmApiTokenPrisma(db as never);
    await revokePmApiTokensForUser("u-member", "user_deactivated", { type: "system", id: null });
    // a database failure in the auth path, whose error text could carry the query
    db.pmApiToken.findUnique.mockRejectedValueOnce(new Error("connection reset while running findUnique"));
    const failed = await hit(request(app).get("/api/pm/ping").set(bearer(token)));
    expect(failed.status).toBe(500);
    // the same through resolvePmApiTokenPrincipal directly
    await resolvePmApiTokenPrincipal(db as never, token);

    // The scope denial and the expired-token refusal: the rows the scan below is about. (A junk
    // bearer at a route a token may never call writes none: see the audit-flood describe.)
    expect(h.recordActivity.mock.calls.length).toBeGreaterThanOrEqual(2);
    const everything = JSON.stringify(h.recordActivity.mock.calls) + h.logged.join("\n") + bodies.join("\n");
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(secret.slice(0, 12));
    expect(everything).not.toContain(token.slice(0, 12)); // dpm_ + the display prefix
  });

  it("the request logger redacts the Authorization header, so an access-log line carries no token", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member");
    const lines: string[] = [];
    const logger = createRequestLogger({ dest: { write: (s: string) => void lines.push(s) }, level: "info" });
    const app = express();
    bindPmApiTokenPrisma(db as never);
    app.use(cookieParser());
    app.use(logger);
    app.use(authMiddleware);
    app.use(createPmApiTokenRateLimit(10, `pm-api-token-test-${++appSeq}`));
    app.use(pmApiTokenScopeGuard);
    app.get("/api/pm/ping", (_req, res) => res.json({ ok: true }));

    expect((await request(app).get("/api/pm/ping").set(bearer(token))).status).toBe(200);
    expect((await request(app).post("/api/pm/ping").set(bearer(token))).status).toBe(403);
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(2));
    const logged = lines.join("\n");
    expect(logged).not.toContain(SECRET_OF(token));
    expect(logged).toContain("[Redacted]");
  });

  it("a stored row holds no secret, and the audit rows hold ids only", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db, "u-member");
    db.users.get("u-member")!.role = "admin";
    await request(buildApp(db)).get("/api/pm/ping").set(bearer(token));
    expect(JSON.stringify(db.tokens)).not.toContain(SECRET_OF(token));
    for (const call of h.recordActivity.mock.calls) {
      const refs = (call[0] as { refs: Row }).refs;
      expect(Object.keys(refs).sort()).toEqual(expect.arrayContaining(["tokenId"]));
    }
  });
});

describe("WARP-3533 — sanity of the constants", () => {
  it("the longest explicit expiry is ten years", () => {
    expect(PM_API_TOKEN_MAX_LIFETIME_MS).toBe(10 * 365 * DAY);
  });

  it("a hash is 64 hex characters of sha256", () => {
    expect(hashPmApiToken("dpm_x")).toBe(crypto.createHash("sha256").update("dpm_x").digest("hex"));
    expect(hashPmApiToken("dpm_x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
