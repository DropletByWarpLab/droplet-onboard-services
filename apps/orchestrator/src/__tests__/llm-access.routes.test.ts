/**
 * WARP-3452 — coding-tool tokens for the local model API (`/api/llm-access/*`).
 *
 * The REAL router, the real role guards and the real token service, over an
 * in-memory stand-in for the slice of PrismaClient they use. Pinned here:
 *   - a token is `dlk_` + 43 base64url chars; only its sha256 is stored, the
 *     prefix is the 8 chars after `dlk_`, and it expires 364 days on;
 *   - who may do what: guests and service principals never; members their
 *     own tokens; owner/admin the switch and everyone's tokens;
 *   - the switch: default off, create 409 / introspect 403 `disabled`, and
 *     turning it off revokes nothing;
 *   - introspection on every request: invalid / revoked / expired (stamped) /
 *     ok, the usage counter, no active model, and the holder's role/status;
 *   - the two internal routes admit `_service:ai-gateway` alone;
 *   - renew, revoke, usage, and the lifecycle auto-revoke;
 *   - the token never reaches an ActivityRow or a log line.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import crypto from "node:crypto";

const h = vi.hoisted(() => ({
  recordActivity: vi.fn(async (..._a: unknown[]) => null),
  activeModel: "docker.io/ai/gpt-oss:20B-F16" as string | null,
  logged: [] as string[],
}));

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    OLLAMA_CONTEXT_LENGTH: 16384,
    // Two service principals, so the limiter exemption can be told apart from "any service token".
    AI_GATEWAY_SAMPLER_TOKEN: "gw-sampler-token-for-tests",
    SERVICE_TOKEN_MCP: "mcp-token-for-tests",
  },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => h.recordActivity(...a),
}));
vi.mock("../services/active-model.service.js", () => ({
  resolveActiveModel: vi.fn(async () => h.activeModel),
}));
// Every logger in the import graph writes here, so "never in a log line" is
// a statement about all of them.
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

import { createLlmAccessRouter, exemptLlmAccessInternalCalls } from "../routes/llm-access.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { resolveActiveModel } from "../services/active-model.service.js";
import {
  LLM_ACCESS_ENABLED_KEY,
  MODEL_TOKEN_TTL_MS,
  initModelAccessTokenRevoke,
  revokeModelAccessTokensForUser,
} from "../services/model-access-token.service.js";

type Row = Record<string, unknown>;
interface Tok extends Row {
  id: string;
  userId: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
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
  const users = new Map<string, { id: string; role: string; directoryStatus: string; displayName: string }>(
    [
      ["u-owner", "owner", "Olivia"],
      ["u-admin", "admin", "Ada"],
      ["u-member", "family", "Maria"],
      ["u-member2", "family", "Marco"],
      ["u-guest", "guest", "Gus"],
    ].map(([id, role, displayName]) => [id, { id, role, directoryStatus: "ACTIVE", displayName }]),
  );
  const tokens: Tok[] = [];
  const usage: Row[] = [];
  const settings = new Map<string, unknown>();
  let n = 0;
  const withIncludes = (t: Tok, include?: { user?: unknown; usage?: { where?: Row } }) => {
    const out: Row = { ...t };
    if (include?.user) out.user = { ...users.get(t.userId)! };
    if (include?.usage) out.usage = usage.filter((u) => u.tokenId === t.id && matches(u, include.usage!.where));
    return out;
  };
  return {
    users,
    tokens,
    usage,
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
    modelAccessToken: {
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
        } as Tok;
        tokens.push(t);
        return { ...t };
      }),
      findUnique: vi.fn(async ({ where, include }: { where: Row; include?: never }) => {
        const t = tokens.find((r) => matches(r, where));
        return t ? withIncludes(t, include) : null;
      }),
      findMany: vi.fn(async ({ where, include }: { where: Row; include?: never }) =>
        tokens
          .filter((r) => matches(r, where))
          .sort((a, b) => +b.createdAt - +a.createdAt)
          .map((t) => withIncludes(t, include)),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const t of tokens) if (matches(t, where)) (Object.assign(t, data), count++);
        return { count };
      }),
    },
    modelAccessTokenUsage: {
      upsert: vi.fn(
        async ({ where, create, update }: { where: { tokenId_day: { tokenId: string; day: Date } }; create: Row; update: Record<string, { increment: number }> }) => {
          const { tokenId, day } = where.tokenId_day;
          const found = usage.find((u) => u.tokenId === tokenId && +(u.day as Date) === +day);
          if (!found) {
            const u = { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0, ...create };
            usage.push(u);
            return u;
          }
          for (const [k, v] of Object.entries(update)) found[k] = (found[k] as number) + v.increment;
          return found;
        },
      ),
    },
  };
}
type Db = ReturnType<typeof makeDb>;

type Principal = { id: string; username: string; displayName: string; role: string };
const P: Record<string, Principal> = {
  owner: { id: "u-owner", username: "olivia", displayName: "Olivia", role: "owner" },
  admin: { id: "u-admin", username: "ada", displayName: "Ada", role: "admin" },
  member: { id: "u-member", username: "maria", displayName: "Maria", role: "family" },
  member2: { id: "u-member2", username: "marco", displayName: "Marco", role: "family" },
  guest: { id: "u-guest", username: "gus", displayName: "Gus", role: "guest" },
  gateway: { id: "_service:ai-gateway", username: "_service:ai-gateway", displayName: "AI Gateway Sampler", role: "service" },
  mcp: { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" },
  display: { id: "_service:display", username: "_service:display", displayName: "Rack Panel Bridge", role: "service" },
  sampler: { id: "_service:sampler", username: "_service:sampler", displayName: "Routing Sampler", role: "service" },
};

function api(db: Db, who: Principal) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = who as never;
    next();
  });
  app.use("/api", createLlmAccessRouter(db as never));
  return request(app);
}

const DAY = 24 * 60 * 60 * 1000;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const audits = () => h.recordActivity.mock.calls.map((c) => c[0] as { what: string; refs?: Row });
const auditsNamed = (what: string) => audits().filter((a) => a.what === what);

function switchOn(db: Db) {
  db.settings.set(LLM_ACCESS_ENABLED_KEY, true);
}

async function mint(db: Db, who: Principal = P.member, label = "MacBook – VS Code") {
  const res = await api(db, who).post("/api/llm-access/tokens").send({ label });
  expect(res.status).toBe(201);
  return res.body as { token: string; row: { id: string } & Row };
}

const introspect = (db: Db, token: unknown) => api(db, P.gateway).post("/api/llm-access/_introspect").send({ token });

beforeEach(() => {
  h.recordActivity.mockClear();
  h.activeModel = "docker.io/ai/gpt-oss:20B-F16";
  h.logged.length = 0;
});

describe("WARP-3452 — minting a token", () => {
  it("is dlk_ + 43 base64url chars, stored only as its sha256, prefixed for display, expiring 364 days on", async () => {
    const db = makeDb();
    switchOn(db);
    const { token, row } = await mint(db, P.member, "  MacBook – VS Code  ");

    expect(token).toMatch(/^dlk_[A-Za-z0-9_-]{43}$/);
    expect(row.prefix).toBe(token.slice(4, 12));
    expect(row.label).toBe("MacBook – VS Code");
    expect(row.status).toBe("active");
    expect(Date.parse(row.expiresAt as string) - Date.parse(row.createdAt as string)).toBe(364 * DAY);
    expect(MODEL_TOKEN_TTL_MS).toBe(364 * DAY);
    expect(row.usage30d).toEqual({ requests: 0, promptTokens: 0, completionTokens: 0, errors: 0 });

    expect(db.tokens[0].secretHash).toBe(sha256(token));
    expect(JSON.stringify(db.tokens)).not.toContain(token.slice(4));
  });

  it("refuses an empty or over-long label", async () => {
    const db = makeDb();
    switchOn(db);
    expect((await api(db, P.member).post("/api/llm-access/tokens").send({ label: "   " })).status).toBe(400);
    expect((await api(db, P.member).post("/api/llm-access/tokens").send({ label: "x".repeat(65) })).status).toBe(400);
    expect(db.tokens).toHaveLength(0);
  });
});

describe("WARP-3452 — who may do what", () => {
  it("a guest gets 403 role_not_allowed everywhere, and so does any service principal on the public routes", async () => {
    const db = makeDb();
    switchOn(db);
    for (const who of [P.guest, P.gateway, P.mcp]) {
      const get = await api(db, who).get("/api/llm-access");
      expect(get.status).toBe(403);
      expect(get.body).toEqual({ error: "role_not_allowed" });
      const post = await api(db, who).post("/api/llm-access/tokens").send({ label: "x" });
      expect(post.status).toBe(403);
      expect(post.body).toEqual({ error: "role_not_allowed" });
    }
    expect(db.tokens).toHaveLength(0);
    expect(auditsNamed("Access denied").length).toBeGreaterThan(0);
  });

  it("a member sees the page and only their own tokens, newest first, but not the switch or anyone else's", async () => {
    const db = makeDb();
    switchOn(db);
    const first = await mint(db, P.member, "first");
    db.tokens[0].createdAt = new Date(Date.now() - 1000);
    await mint(db, P.member2, "someone else's");
    const second = await mint(db, P.member, "second");

    const res = await api(db, P.member).get("/api/llm-access");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      canCreate: true,
      isAdmin: false,
      activeModel: "docker.io/ai/gpt-oss:20B-F16",
      contextWindow: 16384,
    });
    expect(res.body.tokens.map((t: { id: string }) => t.id)).toEqual([second.row.id, first.row.id]);
    expect(vi.mocked(resolveActiveModel)).toHaveBeenCalledWith(expect.anything(), { strict: true });

    expect((await api(db, P.member).put("/api/llm-access/settings").send({ enabled: false })).status).toBe(403);
    expect((await api(db, P.member).get("/api/llm-access/tokens/all")).status).toBe(403);
  });

  it("owner and admin list everyone's tokens with the holder", async () => {
    const db = makeDb();
    switchOn(db);
    await mint(db, P.member, "maria's");
    await mint(db, P.admin, "ada's");
    for (const who of [P.owner, P.admin]) {
      const res = await api(db, who).get("/api/llm-access/tokens/all");
      expect(res.status).toBe(200);
      expect(res.body.tokens).toHaveLength(2);
      expect(res.body.tokens.map((t: { user: unknown }) => t.user)).toEqual(
        expect.arrayContaining([
          { id: "u-member", displayName: "Maria" },
          { id: "u-admin", displayName: "Ada" },
        ]),
      );
    }
    expect((await api(db, P.admin).get("/api/llm-access")).body.isAdmin).toBe(true);
  });
});

describe("WARP-3452 — the box-wide switch", () => {
  it("is off by default: create is 409 disabled, and the page says so", async () => {
    const db = makeDb();
    const page = await api(db, P.member).get("/api/llm-access");
    expect(page.body).toMatchObject({ enabled: false, canCreate: false });
    const res = await api(db, P.member).post("/api/llm-access/tokens").send({ label: "x" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "disabled" });
  });

  it("owner/admin flip it; each change writes one ActivityRow and a no-op writes none", async () => {
    const db = makeDb();
    const on = await api(db, P.admin).put("/api/llm-access/settings").send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, canCreate: true, isAdmin: true });
    await api(db, P.owner).put("/api/llm-access/settings").send({ enabled: true });
    await api(db, P.owner).put("/api/llm-access/settings").send({ enabled: false });
    const rows = audits().filter((a) => (a.refs as Row | undefined)?.setting === "ai.llm_access.enabled");
    expect(rows.map((a) => (a.refs as Row).enabled)).toEqual([true, false]);
    expect((await api(db, P.owner).put("/api/llm-access/settings").send({ enabled: "yes" })).status).toBe(400);
  });

  it("off makes introspection answer 403 disabled, revokes nothing, and on again restores the token", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db);
    await api(db, P.owner).put("/api/llm-access/settings").send({ enabled: false });

    const off = await introspect(db, token);
    expect(off.status).toBe(403);
    expect(off.body).toEqual({ error: "disabled" });
    expect(db.tokens[0].status).toBe("active");
    expect(db.usage).toHaveLength(0);

    await api(db, P.owner).put("/api/llm-access/settings").send({ enabled: true });
    expect((await introspect(db, token)).status).toBe(200);
  });
});

describe("WARP-3452 — POST /_introspect", () => {
  it("ok: who, the active model's runtime id and the window; counts the request; lastUsedAt at most once a minute", async () => {
    const db = makeDb();
    switchOn(db);
    const { token, row } = await mint(db);

    const res = await introspect(db, token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tokenId: row.id,
      userId: "u-member",
      role: "family",
      activeModel: "docker.io/ai/gpt-oss:20B-F16",
      contextWindow: 16384,
    });
    const firstUse = db.tokens[0].lastUsedAt as Date;
    expect(firstUse).toBeInstanceOf(Date);

    await introspect(db, token);
    expect(db.tokens[0].lastUsedAt).toBe(firstUse);
    expect(db.usage).toHaveLength(1);
    expect(db.usage[0]).toMatchObject({ tokenId: row.id, requests: 2 });

    db.tokens[0].lastUsedAt = new Date(Date.now() - 61_000);
    await introspect(db, token);
    expect((db.tokens[0].lastUsedAt as Date).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("invalid: nothing, garbage, a non-dlk string, or an unknown dlk token → 401 invalid_token", async () => {
    const db = makeDb();
    switchOn(db);
    await mint(db);
    for (const t of [undefined, 42, "Bearer x", "sk-123", `dlk_${"A".repeat(43)}`, `dlk_${"A".repeat(200)}`]) {
      const res = await introspect(db, t);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "invalid_token" });
    }
    expect(db.usage).toHaveLength(0);
  });

  it("revoked → 401 revoked, effective on the very next request", async () => {
    const db = makeDb();
    switchOn(db);
    const { token, row } = await mint(db);
    expect((await introspect(db, token)).status).toBe(200);
    expect((await api(db, P.member).delete(`/api/llm-access/tokens/${row.id}`)).status).toBe(204);
    const res = await introspect(db, token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "revoked" });
  });

  it("expired → 401 expired and the row is stamped expired", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db);
    db.tokens[0].expiresAt = new Date(Date.now() - 1);
    const res = await introspect(db, token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "expired" });
    expect(db.tokens[0].status).toBe("expired");
  });

  it("a refused token writes one ActivityRow per hour, not one per request", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db);
    db.tokens[0].status = "revoked";
    await introspect(db, token);
    await introspect(db, token);
    expect(auditsNamed("Coding tool refused: token revoked")).toHaveLength(1);
    db.tokens[0].refusalAuditedAt = new Date(Date.now() - 61 * 60_000);
    await introspect(db, token);
    expect(auditsNamed("Coding tool refused: token revoked")).toHaveLength(2);
  });

  it("no confirmed active model → 403 no_active_model, and the request is not counted", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db);
    h.activeModel = null;
    const res = await introspect(db, token);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "no_active_model" });
    expect(db.usage).toHaveLength(0);
  });

  it("a holder now a guest → 403 role_not_allowed and the token is revoked for good; a deactivated holder → 401 revoked", async () => {
    const db = makeDb();
    switchOn(db);
    const maria = await mint(db, P.member);
    const marco = await mint(db, P.member2);

    db.users.get("u-member")!.role = "guest";
    const guest = await introspect(db, maria.token);
    expect(guest.status).toBe(403);
    expect(guest.body).toEqual({ error: "role_not_allowed" });
    expect(db.tokens.find((t) => t.id === maria.row.id)).toMatchObject({ status: "revoked", revokedReason: "role_guest" });
    // Promoted back: the token does not come back with her.
    db.users.get("u-member")!.role = "family";
    const back = await introspect(db, maria.token);
    expect(back.status).toBe(401);
    expect(back.body).toEqual({ error: "revoked" });

    db.users.get("u-member2")!.directoryStatus = "DEACTIVATED";
    const gone = await introspect(db, marco.token);
    expect(gone.status).toBe(401);
    expect(gone.body).toEqual({ error: "revoked" });
    expect(db.tokens.find((t) => t.id === marco.row.id)).toMatchObject({ status: "revoked", revokedReason: "user_deactivated" });
  });
});

describe("WARP-3452 — the internal routes admit ai-gateway alone", () => {
  it.each(["owner", "admin", "member", "guest", "mcp", "display", "sampler"])("%s gets 403 on _introspect and _usage", async (who) => {
    const db = makeDb();
    switchOn(db);
    const { token, row } = await mint(db);
    const a = await api(db, P[who]).post("/api/llm-access/_introspect").send({ token });
    expect(a.status).toBe(403);
    expect(a.body.tokenId).toBeUndefined();
    const u = await api(db, P[who])
      .post("/api/llm-access/_usage")
      .send({ tokenId: row.id, promptTokens: 1, completionTokens: 1, error: false });
    expect(u.status).toBe(403);
    expect(db.usage).toHaveLength(0);
    expect(auditsNamed("Access denied").length).toBeGreaterThanOrEqual(2);
  });

  it("the ai-gateway id with a human role is not the service principal", async () => {
    const db = makeDb();
    switchOn(db);
    const { token } = await mint(db);
    const forged = { ...P.gateway, role: "admin" };
    expect((await api(db, forged).post("/api/llm-access/_introspect").send({ token })).status).toBe(403);
  });
});

describe("WARP-3452 — ai-gateway's two internal calls skip the per-IP limiter, and nothing else does", () => {
  const GW = "Bearer gw-sampler-token-for-tests";
  let n = 0;
  /** The app-wide wrapper around a real limiter (2 per minute), in front of a 204. */
  function limited() {
    const app = express();
    app.use(exemptLlmAccessInternalCalls(createRateLimit(`llm-access-test-${++n}`, { windowMs: 60_000, limit: 2 })));
    app.use((_req, res) => void res.status(204).end());
    return request(app);
  }
  async function burst(send: () => PromiseLike<{ status: number }>) {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await send()).status);
    return statuses;
  }

  it("ai-gateway's bearer on POST _introspect and _usage is never counted", async () => {
    const app = limited();
    for (const path of ["/api/llm-access/_introspect", "/api/llm-access/_usage"]) {
      expect(await burst(() => app.post(path).set("Authorization", GW))).toEqual([204, 204, 204, 204]);
    }
  });

  it.each([
    ["another service principal's bearer", "post", "/api/llm-access/_introspect", "Bearer mcp-token-for-tests"],
    ["a near-miss token", "post", "/api/llm-access/_introspect", "Bearer gw-sampler-token-for-testz"],
    ["no bearer", "post", "/api/llm-access/_usage", null],
    ["ai-gateway on another route", "get", "/api/network/off-lan", GW],
    ["ai-gateway on a public llm-access route", "post", "/api/llm-access/tokens", GW],
    ["ai-gateway with GET", "get", "/api/llm-access/_introspect", GW],
    ["a trailing slash", "post", "/api/llm-access/_introspect/", GW],
  ] as const)("%s is counted", async (_name, method, path, auth) => {
    const app = limited();
    const send = () => {
      const r = method === "post" ? app.post(path) : app.get(path);
      return auth ? r.set("Authorization", auth) : r;
    };
    expect(await burst(send)).toEqual([204, 204, 429, 429]);
  });
});

describe("WARP-3452 — POST /_usage", () => {
  it("adds counts to today's row, counts an error, and shows in usage30d; a 31-day-old row does not", async () => {
    const db = makeDb();
    switchOn(db);
    const { token, row } = await mint(db);
    await introspect(db, token);
    const send = (body: Row) => api(db, P.gateway).post("/api/llm-access/_usage").send(body);
    expect((await send({ tokenId: row.id, promptTokens: 1200, completionTokens: 300, error: false })).status).toBe(204);
    expect((await send({ tokenId: row.id, promptTokens: 50, completionTokens: 0, error: true })).status).toBe(204);
    db.usage.push({ tokenId: row.id, day: new Date(Date.now() - 31 * DAY), requests: 9, promptTokens: 9, completionTokens: 9, errors: 9 });

    const page = await api(db, P.member).get("/api/llm-access");
    expect(page.body.tokens[0].usage30d).toEqual({ requests: 1, promptTokens: 1250, completionTokens: 300, errors: 1 });

    expect((await send({ tokenId: row.id, promptTokens: -1, completionTokens: 0, error: false })).status).toBe(400);
    expect((await send({ tokenId: "tok-nope", promptTokens: 1, completionTokens: 1, error: false })).status).toBe(404);
  });
});

describe("WARP-3452 — renew and revoke", () => {
  it("renew: an expired token is active again for 364 days; a revoked one is 409; someone else's is 404 to a member, fine for an admin", async () => {
    const db = makeDb();
    switchOn(db);
    const { row } = await mint(db, P.member);
    db.tokens[0].status = "expired";
    db.tokens[0].expiresAt = new Date(Date.now() - DAY);

    const before = Date.now();
    const res = await api(db, P.member).post(`/api/llm-access/tokens/${row.id}/renew`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(Date.parse(res.body.expiresAt) - before).toBeGreaterThanOrEqual(364 * DAY - 1000);
    expect(auditsNamed("Coding-tool token renewed")).toHaveLength(1);

    expect((await api(db, P.member2).post(`/api/llm-access/tokens/${row.id}/renew`)).status).toBe(404);
    expect((await api(db, P.admin).post(`/api/llm-access/tokens/${row.id}/renew`)).status).toBe(200);

    db.tokens[0].status = "revoked";
    const revoked = await api(db, P.member).post(`/api/llm-access/tokens/${row.id}/renew`);
    expect(revoked.status).toBe(409);
    expect(revoked.body).toEqual({ error: "revoked" });
  });

  it("revoke keeps the row, says who and why, is idempotent, and is 404 on someone else's token for a member", async () => {
    const db = makeDb();
    switchOn(db);
    const { row } = await mint(db, P.member);

    expect((await api(db, P.member2).delete(`/api/llm-access/tokens/${row.id}`)).status).toBe(404);
    expect(db.tokens[0].status).toBe("active");

    expect((await api(db, P.owner).delete(`/api/llm-access/tokens/${row.id}`)).status).toBe(204);
    expect(db.tokens).toHaveLength(1);
    expect(db.tokens[0]).toMatchObject({ status: "revoked", revokedReason: "manual", revokedById: "u-owner" });
    expect(db.tokens[0].revokedAt).toBeInstanceOf(Date);

    expect((await api(db, P.member).delete(`/api/llm-access/tokens/${row.id}`)).status).toBe(204);
    expect(auditsNamed("Coding-tool token revoked")).toHaveLength(1);
  });
});

describe("WARP-3452 — auto-revoke on deactivation and demotion to guest", () => {
  it("revokes every token the person holds that is not already revoked, with the reason, and audits it once", async () => {
    const db = makeDb();
    switchOn(db);
    await mint(db, P.member, "a");
    await mint(db, P.member, "b");
    await mint(db, P.member2, "someone else's");
    db.tokens[1].status = "expired";
    initModelAccessTokenRevoke(db as never);

    await revokeModelAccessTokensForUser("u-member", "user_deactivated", { type: "user", id: "u-admin" });
    expect(db.tokens.map((t) => [t.userId, t.status, t.revokedReason])).toEqual([
      ["u-member", "revoked", "user_deactivated"],
      ["u-member", "revoked", "user_deactivated"],
      ["u-member2", "active", null],
    ]);
    expect(auditsNamed("Coding-tool tokens revoked")).toHaveLength(1);

    await revokeModelAccessTokensForUser("u-member2", "role_guest", { type: "user", id: "u-admin" });
    expect(db.tokens[2]).toMatchObject({ status: "revoked", revokedReason: "role_guest" });

    // Nothing left to revoke: no second row for the same person.
    await revokeModelAccessTokensForUser("u-member", "user_deactivated", { type: "user", id: "u-admin" });
    expect(auditsNamed("Coding-tool tokens revoked")).toHaveLength(2);
  });
});

describe("WARP-3452 — the token never leaves the response that mints it", () => {
  it("no ActivityRow and no log line carries the token or its secret half, across the whole lifecycle", async () => {
    const db = makeDb();
    await api(db, P.owner).put("/api/llm-access/settings").send({ enabled: true });
    const { token, row } = await mint(db);
    await introspect(db, token);
    await api(db, P.gateway).post("/api/llm-access/_usage").send({ tokenId: row.id, promptTokens: 5, completionTokens: 5, error: false });
    await api(db, P.member).post(`/api/llm-access/tokens/${row.id}/renew`);
    await api(db, P.member).delete(`/api/llm-access/tokens/${row.id}`);
    await introspect(db, token);
    await api(db, P.mcp).post("/api/llm-access/_introspect").send({ token });
    initModelAccessTokenRevoke(db as never);
    await revokeModelAccessTokensForUser("u-member", "user_deactivated", { type: "system", id: null });

    expect(h.recordActivity.mock.calls.length).toBeGreaterThan(3);
    const everything = JSON.stringify(h.recordActivity.mock.calls) + h.logged.join("\n");
    expect(everything).not.toContain(token.slice(4));
    expect(everything).not.toContain(token.slice(4, 12));
  });
});
