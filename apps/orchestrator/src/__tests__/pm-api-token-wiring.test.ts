/**
 * WARP-3533 — the API-token guard and the new routers, where they are actually
 * mounted.
 *
 * pm-api-token.test.ts proves the middleware on a hand-built express app. That
 * leaves the one thing a merge of app.ts (a hot file) can silently undo: that
 * `createApp` binds the token lookup, mounts the rate limit and the scope guard
 * right after authMiddleware and before every protected router, and puts the
 * Projects module gate and the OpenAPI route where they belong. Delete the
 * guard, or move it below the routers, and a `dpm_` bearer (an ordinary human
 * principal as far as every router is concerned) reaches the whole API.
 *
 * So this builds the REAL app over a stand-in database and sends tokens at
 * routes mounted early, mid-way and late.
 *
 * MUTATIONS (each red):
 *   - delete `app.use(pmApiTokenScopeGuard)` from app.ts (the 403s become 2xx/404s);
 *   - move it below `createStorageRouter`;
 *   - delete `bindPmApiTokenPrisma(prisma)` (every token is a 401);
 *   - mount `createPmOpenApiRouter` outside /api (the document 404s).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, AUTH_ENABLED: true } };
});
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { createApp } from "../app.js";
import {
  PM_API_TOKENS_ENABLED_KEY,
  bindPmApiTokenPrisma,
  createPmApiToken,
  resetPmApiTokenUseMemo,
} from "../services/pm/pm-api-token.service.js";

type Row = Record<string, unknown>;

function cond(value: unknown, c: unknown): boolean {
  if (c === null) return value === null || value === undefined;
  if (c instanceof Date) return value instanceof Date && value.getTime() === c.getTime();
  if (typeof c === "object") {
    const o = c as Record<string, unknown>;
    if ("in" in o) return (o.in as unknown[]).includes(value);
    if (value === null || value === undefined) return false;
    if ("lte" in o) return (value as Date) <= (o.lte as Date);
    if ("lt" in o) return (value as Date) < (o.lt as Date);
    return true;
  }
  return value === c;
}
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, c]) => (k === "OR" ? (c as Row[]).some((w) => matches(row, w)) : cond(row[k], c)));

/**
 * A Prisma stand-in: the models the token path and the gates read are real
 * (in memory); every other model answers "nothing" so the rest of createApp's
 * routers can be constructed and fall through to their own 401/403/404.
 */
function makeDb(opts: { projectsEnabled?: boolean } = {}) {
  const users = new Map<string, Row>([
    ["u-member", { id: "u-member", username: "maria", displayName: "Maria", role: "family", directoryStatus: "ACTIVE" }],
    ["u-owner", { id: "u-owner", username: "olivia", displayName: "Olivia", role: "owner", directoryStatus: "ACTIVE" }],
  ]);
  const tokens: Row[] = [];
  const settings = new Map<string, unknown>([[PM_API_TOKENS_ENABLED_KEY, true]]);
  let n = 0;
  const overrides: Record<string, Record<string, (...a: any[]) => unknown>> = {
    moduleSetting: { findMany: async () => [{ moduleId: "projects", enabled: opts.projectsEnabled ?? true }] },
    user: { findUnique: async () => ({ mustChangePassword: false }) },
    workspaceSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { valueJson: settings.get(where.key) } : null,
    },
    pmApiToken: {
      create: async ({ data }: { data: Row }) => {
        const t = { id: `tok-${++n}`, status: "active", createdAt: new Date(), lastUsedAt: null, revokedAt: null, revokedReason: null, refusalAuditedAt: null, ...data };
        tokens.push(t);
        return { ...t };
      },
      findUnique: async ({ where, include }: { where: Row; include?: { user?: unknown } }) => {
        const t = tokens.find((r) => matches(r, where));
        return t ? { ...t, ...(include?.user ? { user: { ...users.get(t.userId as string)! } } : {}) } : null;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const t of tokens) if (matches(t, where)) (Object.assign(t, data), count++);
        return { count };
      },
    },
  };
  const generic = (method: string) => async () => (method === "findMany" ? [] : method === "updateMany" || method === "deleteMany" ? { count: 0 } : null);
  const prisma = new Proxy(
    {},
    {
      get: (_t, model) => {
        if (typeof model !== "string" || model === "then") return undefined;
        if (model === "$transaction") return async (arg: unknown) => (typeof arg === "function" ? (arg as (p: unknown) => unknown)(prisma) : []);
        if (model.startsWith("$")) return async () => undefined;
        return new Proxy(overrides[model] ?? {}, {
          get: (target, method) => (method in target ? (target as Row)[method as string] : typeof method === "string" ? generic(method) : undefined),
        });
      },
    },
  );
  return { prisma, users, tokens, settings };
}

let seq = 0;
async function mint(db: ReturnType<typeof makeDb>, who: string, scopes: string[]) {
  const u = db.users.get(who)!;
  return (await createPmApiToken(db.prisma as never, { id: u.id as string, role: u.role as string }, { name: `wiring-${++seq}`, scopes, expiresAt: null })).token;
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

function appOver(db: ReturnType<typeof makeDb>) {
  const app = createApp(db.prisma as never);
  // createApp binds its own client to the token lookup; it is this one.
  bindPmApiTokenPrisma(db.prisma as never);
  return app;
}

let db: ReturnType<typeof makeDb>;
let app: ReturnType<typeof createApp>;

beforeAll(() => resetPmApiTokenUseMemo());
beforeEach(() => {
  db = makeDb();
  app = appOver(db);
});

describe("createApp mounts the API-token guard before every protected router", () => {
  // Early, mid-way and late in app.ts, whether or not they carry a requireRole of their own.
  for (const path of ["/api/auth/me", "/api/storage", "/api/notifications", "/api/admin/files", "/api/developer", "/api/calendar/events", "/api/llm-access"]) {
    it(`GET ${path} is the guard's 403 for a token with every scope`, async () => {
      const token = await mint(db, "u-owner", ["pm:read", "pm:write", "support:read", "support:write"]);
      const res = await request(app).get(path).set(bearer(token));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("TOKEN_ROUTE_FORBIDDEN");
    });
  }

  it("a token cannot mint a token, a calendar link or flip the switch", async () => {
    const token = await mint(db, "u-owner", ["pm:read", "pm:write"]);
    for (const [verb, path] of [
      ["post", "/api/developer/tokens"],
      ["put", "/api/developer/settings"],
      ["post", "/api/developer/feeds/rotate"],
      ["post", "/api/calendar/publish/rotate"],
    ] as const) {
      const res = await request(app)[verb](path).set(bearer(token)).send({});
      expect(res.status, `${verb} ${path}`).toBe(403);
      expect(res.body.code).toBe("TOKEN_ROUTE_FORBIDDEN");
    }
    expect(db.tokens).toHaveLength(1);
    expect(db.settings.get(PM_API_TOKENS_ENABLED_KEY)).toBe(true);
  });

  // The security boundary is a path classifier in front of Express, so the shapes
  // that could make the two disagree are pinned here, against the real app: a
  // token holding every scope must never get the developer router, the switch or a
  // minted token out of any spelling of its path.
  const CONFUSED_PATHS = [
    "/api/developer",
    "/api/developer/",
    "/API/DEVELOPER",
    "//api/developer",
    "/api/./developer",
    "/api/developer.json",
    "/api/developer;x=1",
    "/api/developer%2f",
    "/api%2fdeveloper",
    "/api/%64eveloper",
    "/api/developer%00",
    "/api/pm/../developer",
    "/api/support/../developer",
    "/api/pm/..%2fdeveloper",
    "/api/pm/%2e%2e/developer",
    "/api/pm%2f..%2fdeveloper",
    "/api/pm/webhooks",
    "/API/PM/WEBHOOKS/",
    "/api/pm/projects/p1/settings",
  ];

  it("no spelling of a forbidden path reaches the developer router, the switch or a minted token", async () => {
    const token = await mint(db, "u-owner", ["pm:read", "pm:write", "support:read", "support:write"]);
    const before = { tokens: db.tokens.length, enabled: db.settings.get(PM_API_TOKENS_ENABLED_KEY) };
    for (const path of CONFUSED_PATHS) {
      for (const verb of ["get", "post", "put", "delete"] as const) {
        const res = await request(app)[verb](path).set(bearer(token)).send({ name: "x", scopes: ["pm:read"], enabled: false });
        // 403 (the classifier) or 404 (a path Express never routes), never a 2xx, never the developer payload.
        expect([403, 404], `${verb.toUpperCase()} ${path} -> ${res.status}`).toContain(res.status);
        if (res.status === 403) expect(["TOKEN_ROUTE_FORBIDDEN"], `${verb} ${path}`).toContain(res.body.code);
        expect(res.body.tokens, `${verb} ${path}`).toBeUndefined();
        expect(res.body.token, `${verb} ${path}`).toBeUndefined();
      }
    }
    expect({ tokens: db.tokens.length, enabled: db.settings.get(PM_API_TOKENS_ENABLED_KEY) }).toEqual(before);
  });

  it("a pm:read token is a 403 insufficient_scope on a PM write, before any router or gate answers", async () => {
    const token = await mint(db, "u-member", ["pm:read"]);
    const res = await request(app).post("/api/pm/projects").set(bearer(token)).send({ name: "Nope" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "insufficient_scope", required: "pm:write" });
  });

  it("an unknown dpm_ bearer is a 401, never the guard", async () => {
    const res = await request(app).get("/api/pm/openapi.json").set(bearer("dpm_" + "Z".repeat(43)));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_INVALID");
  });

  it("with no credential at all, the document is a 401", async () => {
    expect((await request(app).get("/api/pm/openapi.json")).status).toBe(401);
  });
});

describe("the PM OpenAPI document, through the real app", () => {
  it("is served to a token with pm:read, through the Projects gates", async () => {
    const token = await mint(db, "u-member", ["pm:read"]);
    const res = await request(app).get("/api/pm/openapi.json").set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(Object.keys(res.body.paths)).toContain("/api/pm/projects");
  });

  it("is refused to a token with only support scopes (403), and reads as absent when Projects is off (404)", async () => {
    const support = await mint(db, "u-member", ["support:read"]);
    expect((await request(app).get("/api/pm/openapi.json").set(bearer(support))).status).toBe(403);

    const off = makeDb({ projectsEnabled: false });
    const offApp = appOver(off);
    const token = await mint(off, "u-member", ["pm:read"]);
    const res = await request(offApp).get("/api/pm/openapi.json").set(bearer(token));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "projects" });
  });
});

describe("a token is its holder, through the real app", () => {
  it("the switch off is a 401 TOKEN_DISABLED, and on again works", async () => {
    const token = await mint(db, "u-member", ["pm:read"]);
    db.settings.set(PM_API_TOKENS_ENABLED_KEY, false);
    const off = await request(app).get("/api/pm/openapi.json").set(bearer(token));
    expect(off.status).toBe(401);
    expect(off.body.code).toBe("TOKEN_DISABLED");
    db.settings.set(PM_API_TOKENS_ENABLED_KEY, true);
    expect((await request(app).get("/api/pm/openapi.json").set(bearer(token))).status).toBe(200);
  });

  it("a holder demoted to guest after minting is a 401, not a guest session", async () => {
    const token = await mint(db, "u-member", ["pm:read"]);
    db.users.get("u-member")!.role = "guest";
    const res = await request(app).get("/api/pm/openapi.json").set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_REVOKED");
  });
});
