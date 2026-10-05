/**
 * WARP-3533 — Settings -> Developer: `/api/developer/*`.
 *
 * The REAL router, the real role guards and the real token and feed services,
 * over an in-memory stand-in for the slice of PrismaClient they use. Pinned:
 *   - who may do what: guests and service principals never hold a token;
 *     members their own; owner/admin the switch and everyone's tokens;
 *   - the switch: default off, create is 409 while off, and turning it off
 *     deletes nothing;
 *   - creating: validation, the token shown once and never stored or audited,
 *     the expiry bounds, scopes offered per effective module;
 *   - revoking: own / any (admin), someone else's is a 404 to a member, audited;
 *   - the feed links: listed per feed, minted once, rotated per feed, revoked,
 *     behind the Projects gates (module off and guests are 404);
 *   - THE POINT OF WHERE THIS LIVES: through the real auth stack, an API token
 *     is a 403 on every route here, so a token can never mint a token or a feed
 *     link, or flip the switch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
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

import { authMiddleware } from "../middleware/auth.js";
import { createPmApiTokenRateLimit, pmApiTokenScopeGuard } from "../middleware/pm-api-token-guard.js";
import { createDeveloperRouter } from "../routes/developer.js";
import {
  PM_API_TOKENS_ENABLED_KEY,
  PM_API_TOKEN_MAX_LIFETIME_MS,
  bindPmApiTokenPrisma,
  createPmApiToken,
  hashPmApiToken,
  resetPmApiTokenUseMemo,
} from "../services/pm/pm-api-token.service.js";

type Row = Record<string, unknown>;
interface Tok extends Row {
  id: string;
  userId: string;
  hash: string;
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
}
interface Link extends Row {
  id: string;
  userId: string;
  state: string;
  scope: string;
  projectId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

function cond(value: unknown, c: unknown): boolean {
  if (c === null) return value === null || value === undefined;
  if (c instanceof Date) return value instanceof Date && value.getTime() === c.getTime();
  if (typeof c === "object") {
    const o = c as Record<string, unknown>;
    if ("in" in o) return (o.in as unknown[]).includes(value);
    if (value === null || value === undefined) return false;
    if ("gt" in o && !((value as Date) > (o.gt as Date))) return false;
    if ("lte" in o && !((value as Date) <= (o.lte as Date))) return false;
    if ("lt" in o && !((value as Date) < (o.lt as Date))) return false;
    return true;
  }
  return value === c;
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, c]) =>
    k === "OR" ? (c as Row[]).some((w) => matches(row, w)) : cond(row[k], c),
  );
}

function makeDb(opts: { projectsEnabled?: boolean } = {}) {
  const users = new Map(
    [
      ["u-owner", "olivia", "owner", "Olivia"],
      ["u-admin", "ada", "admin", "Ada"],
      ["u-member", "maria", "family", "Maria"],
      ["u-member2", "marco", "family", "Marco"],
      ["u-guest", "gus", "guest", "Gus"],
    ].map(([id, username, role, displayName]) => [id, { id, username, role, displayName, directoryStatus: "ACTIVE" }]),
  );
  const tokens: Tok[] = [];
  const links: Link[] = [];
  const settings = new Map<string, unknown>();
  const projects = [
    { id: "p-abc", name: "Alpha build", identifier: "ABC", kind: "PROJECT", isArchived: false },
    { id: "p-xyz", name: "Xylophone", identifier: "XYZ", kind: "PROJECT", isArchived: false },
    { id: "p-old", name: "Old stuff", isArchived: true, identifier: "OLD", kind: "PROJECT" },
    { id: "p-support", name: "Customer support", identifier: "SUP", kind: "SERVICE_DESK", isArchived: false },
  ];
  let n = 0;
  const db = {
    users,
    tokens,
    links,
    settings,
    moduleEnabled: opts.projectsEnabled ?? true,
    moduleSetting: { findMany: vi.fn(async () => [{ moduleId: "projects", enabled: db.moduleEnabled }]) },
    workspaceSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { valueJson: settings.get(where.key) } : null,
      ),
      upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: Row; update: Row }) => {
        settings.set(where.key, settings.has(where.key) ? update.valueJson : create.valueJson);
        return {};
      }),
    },
    pmProject: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const p = projects.find((x) => matches(x as unknown as Row, where));
        return p ? { id: p.id, name: p.name, identifier: p.identifier } : null;
      }),
      findMany: vi.fn(async ({ where, take }: { where: Row; take?: number }) =>
        projects
          .filter((x) => matches(x as unknown as Row, where))
          .slice(0, take)
          .map((p) => ({ id: p.id, name: p.name, identifier: p.identifier })),
      ),
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
        if (!t) return null;
        return include?.user ? { ...t, user: { ...users.get(t.userId)! } } : { ...t };
      }),
      findMany: vi.fn(async ({ where, include }: { where: Row; include?: { user?: unknown } }) =>
        tokens
          .filter((r) => matches(r, where))
          .sort((a, b) => +b.createdAt - +a.createdAt)
          .map((t) => (include?.user ? { ...t, user: { ...users.get(t.userId)! } } : { ...t })),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const t of tokens) if (matches(t, where)) (Object.assign(t, data), count++);
        return { count };
      }),
    },
    calendarFeedToken: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        links.filter((r) => matches(r, where)).sort((a, b) => +b.createdAt - +a.createdAt),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const r of links) if (matches(r, where)) (Object.assign(r, data), count++);
        return { count };
      }),
      create: vi.fn(async ({ data }: { data: Pick<Link, "userId" | "secretHash" | "expiresAt"> & Partial<Link> }) => {
        const r = { id: `link-${++n}`, state: "active", scope: "calendar", projectId: null, createdAt: new Date(), endedAt: null, ...data } as Link;
        links.push(r);
        return r;
      }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return db;
}
type Db = ReturnType<typeof makeDb>;

type Principal = { id: string; username: string; displayName: string; role: string };
const P: Record<string, Principal> = {
  owner: { id: "u-owner", username: "olivia", displayName: "Olivia", role: "owner" },
  admin: { id: "u-admin", username: "ada", displayName: "Ada", role: "admin" },
  member: { id: "u-member", username: "maria", displayName: "Maria", role: "family" },
  member2: { id: "u-member2", username: "marco", displayName: "Marco", role: "family" },
  guest: { id: "u-guest", username: "gus", displayName: "Gus", role: "guest" },
  mcp: { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" },
};

function api(db: Db, who: Principal) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = who as never;
    next();
  });
  app.use("/api", createDeveloperRouter(db as never));
  return app;
}

const DAY = 86_400_000;
const auditsNamed = (what: string) => h.recordActivity.mock.calls.filter((c) => (c[0] as { what: string }).what === what);
const switchOn = (db: Db) => db.settings.set(PM_API_TOKENS_ENABLED_KEY, true);

async function mint(db: Db, who = P.member, name = "ci", scopes = ["pm:read"]) {
  const res = await request(api(db, who)).post("/api/developer/tokens").send({ name, scopes });
  expect(res.status).toBe(201);
  return res.body as { token: string; row: { id: string } & Row };
}

beforeEach(() => {
  h.recordActivity.mockClear();
  h.logged.length = 0;
  resetPmApiTokenUseMemo();
});

describe("WARP-3533 — who may do what", () => {
  it("guests and service principals get 403 role_not_allowed on every token route", async () => {
    const db = makeDb();
    switchOn(db);
    for (const who of [P.guest, P.mcp]) {
      const app = api(db, who);
      for (const [verb, path] of [
        ["get", "/api/developer"],
        ["post", "/api/developer/tokens"],
        ["delete", "/api/developer/tokens/tok-1"],
      ] as const) {
        const res = await request(app)[verb](path).send({ name: "x", scopes: ["pm:read"] });
        expect(res.status, `${who.role} ${verb} ${path}`).toBe(403);
        expect(res.body).toEqual({ error: "role_not_allowed" });
      }
    }
    expect(db.tokens).toHaveLength(0);
  });

  it("a member may not flip the switch or list everyone's tokens; owner and admin may", async () => {
    const db = makeDb();
    expect((await request(api(db, P.member)).put("/api/developer/settings").send({ enabled: true })).status).toBe(403);
    expect((await request(api(db, P.member)).get("/api/developer/tokens/all")).status).toBe(403);
    expect(db.settings.has(PM_API_TOKENS_ENABLED_KEY)).toBe(false);

    for (const who of [P.owner, P.admin]) {
      expect((await request(api(db, who)).put("/api/developer/settings").send({ enabled: true })).status).toBe(200);
      expect((await request(api(db, who)).get("/api/developer/tokens/all")).status).toBe(200);
    }
  });
});

describe("WARP-3533 — the switch", () => {
  it("is off by default: the page says so, canCreate is false, and creating is a 409", async () => {
    const db = makeDb();
    const page = await request(api(db, P.member)).get("/api/developer");
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ enabled: false, canCreate: false, isAdmin: false, tokens: [], openapiPath: "/api/pm/openapi.json" });
    const res = await request(api(db, P.member)).post("/api/developer/tokens").send({ name: "x", scopes: ["pm:read"] });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "disabled" });
    expect(db.tokens).toHaveLength(0);
  });

  it("owner/admin turn it on and off, audited once per change, and off deletes nothing", async () => {
    const db = makeDb();
    const on = await request(api(db, P.admin)).put("/api/developer/settings").send({ enabled: true });
    expect(on.body).toMatchObject({ enabled: true, canCreate: true, isAdmin: true });
    expect(auditsNamed("API tokens allowed")).toHaveLength(1);

    // Same value again: no second row.
    await request(api(db, P.admin)).put("/api/developer/settings").send({ enabled: true });
    expect(auditsNamed("API tokens allowed")).toHaveLength(1);

    const { row } = await mint(db);
    const off = await request(api(db, P.owner)).put("/api/developer/settings").send({ enabled: false });
    expect(off.body.enabled).toBe(false);
    expect(auditsNamed("API tokens blocked")).toHaveLength(1);
    expect(db.tokens.map((t) => [t.id, t.status])).toEqual([[row.id, "active"]]);

    expect((await request(api(db, P.owner)).put("/api/developer/settings").send({ enabled: "yes" })).status).toBe(400);
  });
});

describe("WARP-3533 — creating a token", () => {
  it("returns the token once; stores only its hash; audits ids and scopes, never the token", async () => {
    const db = makeDb();
    switchOn(db);
    const res = await request(api(db, P.member)).post("/api/developer/tokens").send({ name: "  Nightly export  ", scopes: ["pm:write", "pm:read"] });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^dpm_[A-Za-z0-9_-]{43}$/);
    expect(res.body.row).toMatchObject({
      name: "Nightly export",
      prefix: res.body.token.slice(4, 12),
      scopes: ["pm:read", "pm:write"],
      status: "active",
      expiresAt: null,
      lastUsedAt: null,
    });
    // The row carries no hash and no secret.
    expect(Object.keys(res.body.row)).not.toContain("hash");
    expect(JSON.stringify(res.body.row)).not.toContain(res.body.token.slice(4));
    expect(db.tokens[0].hash).toBe(hashPmApiToken(res.body.token));
    expect(db.tokens[0].issuedRole).toBe("family");

    const audit = auditsNamed("API token created");
    expect(audit).toHaveLength(1);
    expect((audit[0][0] as { refs: Row }).refs).toMatchObject({ tokenId: res.body.row.id, userId: "u-member", scopes: ["pm:read", "pm:write"] });
    expect(JSON.stringify(h.recordActivity.mock.calls) + h.logged.join("\n")).not.toContain(res.body.token.slice(4));

    // The page lists it, without the secret.
    const page = await request(api(db, P.member)).get("/api/developer");
    expect(page.body.tokens).toHaveLength(1);
    expect(JSON.stringify(page.body)).not.toContain(res.body.token.slice(4));
  });

  it("refuses a bad name, bad scopes and bad expiry with a 400 and writes nothing", async () => {
    const db = makeDb();
    switchOn(db);
    const post = (body: unknown) => request(api(db, P.member)).post("/api/developer/tokens").send(body as object);
    const soon = new Date(Date.now() + DAY).toISOString();
    for (const body of [
      {},
      { name: "", scopes: ["pm:read"] },
      { name: "   ", scopes: ["pm:read"] },
      { name: "x".repeat(65), scopes: ["pm:read"] },
      { name: "x", scopes: [] },
      { name: "x", scopes: ["admin:all"] },
      { name: "x", scopes: ["pm:read", "pm:nope"] },
      { name: "x", scopes: "pm:read" },
      { name: "x", scopes: ["pm:read"], expiresAt: "tomorrow" },
      { name: 7, scopes: ["pm:read"], expiresAt: soon },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(db.tokens).toHaveLength(0);
  });

  it("bounds the expiry: not in the past, not past ten years; absent or null means none", async () => {
    const db = makeDb();
    switchOn(db);
    const post = (expiresAt?: string | null) =>
      request(api(db, P.member)).post("/api/developer/tokens").send({ name: "x", scopes: ["pm:read"], ...(expiresAt === undefined ? {} : { expiresAt }) });
    const past = await post(new Date(Date.now() - 1000).toISOString());
    expect(past.status).toBe(400);
    expect(past.body).toEqual({ error: "invalid_expiry" });
    expect((await post(new Date(Date.now() + PM_API_TOKEN_MAX_LIFETIME_MS + DAY).toISOString())).status).toBe(400);

    const ok = await post(new Date(Date.now() + 30 * DAY).toISOString());
    expect(ok.status).toBe(201);
    expect(Date.parse(ok.body.row.expiresAt) - Date.now()).toBeGreaterThan(29 * DAY);
    expect((await post(null)).body.row.expiresAt).toBeNull();
    expect((await post()).body.row.expiresAt).toBeNull();
  });

  it("offers the scopes of the modules that are on, and none when Projects is off", async () => {
    const on = makeDb();
    switchOn(on);
    const pm = await request(api(on, P.member)).get("/api/developer");
    expect(pm.body.scopes.map((s: { id: string }) => s.id)).toEqual(["pm:read", "pm:write"]);
    for (const s of pm.body.scopes) {
      expect(s.label).toEqual(expect.any(String));
      expect(s.description).toEqual(expect.any(String));
    }
    const off = makeDb({ projectsEnabled: false });
    switchOn(off);
    expect((await request(api(off, P.member)).get("/api/developer")).body.scopes).toEqual([]);
  });
});

describe("WARP-3533 — listing and revoking", () => {
  it("a member sees their own tokens only; owner/admin see everyone's with the holder", async () => {
    const db = makeDb();
    switchOn(db);
    await mint(db, P.member, "mine");
    await mint(db, P.member2, "theirs");
    const own = await request(api(db, P.member)).get("/api/developer");
    expect(own.body.tokens.map((t: { name: string }) => t.name)).toEqual(["mine"]);
    const all = await request(api(db, P.admin)).get("/api/developer/tokens/all");
    expect(all.body.tokens.map((t: { name: string; user: { displayName: string } }) => [t.name, t.user.displayName]).sort()).toEqual([
      ["mine", "Maria"],
      ["theirs", "Marco"],
    ]);
    expect(JSON.stringify(all.body)).not.toContain("hash");
  });

  it("revoke keeps the row, says who, is idempotent, and is a 404 to a member on someone else's token", async () => {
    const db = makeDb();
    switchOn(db);
    const { row } = await mint(db, P.member);

    expect((await request(api(db, P.member2)).delete(`/api/developer/tokens/${row.id}`)).status).toBe(404);
    expect(db.tokens[0].status).toBe("active");

    expect((await request(api(db, P.owner)).delete(`/api/developer/tokens/${row.id}`)).status).toBe(204);
    expect(db.tokens).toHaveLength(1);
    expect(db.tokens[0]).toMatchObject({ status: "revoked", revokedReason: "manual", revokedById: "u-owner" });

    expect((await request(api(db, P.member)).delete(`/api/developer/tokens/${row.id}`)).status).toBe(204);
    expect(auditsNamed("API token revoked")).toHaveLength(1);
    expect((await request(api(db, P.member)).delete("/api/developer/tokens/nope")).status).toBe(404);
  });

  it("a person may revoke their own token while the switch is off (a lost laptop)", async () => {
    const db = makeDb();
    switchOn(db);
    const { row } = await mint(db, P.member);
    db.settings.set(PM_API_TOKENS_ENABLED_KEY, false);
    expect((await request(api(db, P.member)).delete(`/api/developer/tokens/${row.id}`)).status).toBe(204);
    expect(db.tokens[0].status).toBe("revoked");
  });
});

describe("WARP-3533 — the ICS feed links", () => {
  it("lists 'My work' first, then each live project, with whether it has a link", async () => {
    const db = makeDb();
    db.links.push(
      { id: "l1", userId: "u-member", state: "active", scope: "pm_my_work", projectId: null, createdAt: new Date(), expiresAt: new Date(Date.now() + DAY) },
      { id: "l2", userId: "u-member", state: "active", scope: "pm_project", projectId: "p-xyz", createdAt: new Date(), expiresAt: new Date(Date.now() + DAY) },
      // someone else's, an ended one, an expired one and a calendar link: none of them count
      { id: "l3", userId: "u-member2", state: "active", scope: "pm_project", projectId: "p-abc", createdAt: new Date(), expiresAt: new Date(Date.now() + DAY) },
      { id: "l4", userId: "u-member", state: "rotated", scope: "pm_project", projectId: "p-abc", createdAt: new Date(), expiresAt: new Date(Date.now() + DAY) },
      { id: "l5", userId: "u-member", state: "active", scope: "calendar", projectId: null, createdAt: new Date(), expiresAt: new Date(Date.now() + DAY) },
    );
    const res = await request(api(db, P.member)).get("/api/developer/feeds");
    expect(res.status).toBe(200);
    expect(res.body.feeds.map((f: { kind: string; name: string; state: string }) => [f.kind, f.name, f.state])).toEqual([
      ["my_work", "My work", "active"],
      ["project", "Alpha build", "none"],
      ["project", "Xylophone", "active"],
    ]);
    expect(res.body.feeds[0]).toMatchObject({ projectId: null, identifier: null });
    expect(res.body.feeds[1]).toMatchObject({ projectId: "p-abc", identifier: "ABC", createdAt: null, expiresAt: null });
    expect(JSON.stringify(res.body)).not.toContain("secretHash");
  });

  it("rotate returns the URL once, ends only that feed's previous link, and audits without the token", async () => {
    const db = makeDb();
    const first = await request(api(db, P.member)).post("/api/developer/feeds/rotate").send({ kind: "my_work" });
    expect(first.status).toBe(200);
    expect(first.body.url).toMatch(/^\/api\/calendar\/publish\/maria\/my-work\.ics\?token=link-\d+\.[A-Za-z0-9_-]{43}$/);
    expect(typeof first.body.expiresAt).toBe("string");

    const proj = await request(api(db, P.member)).post("/api/developer/feeds/rotate").send({ kind: "project", projectId: "p-abc" });
    expect(proj.body.url).toMatch(/^\/api\/calendar\/publish\/maria\/projects\/p-abc\.ics\?token=/);

    const again = await request(api(db, P.member)).post("/api/developer/feeds/rotate").send({ kind: "my_work" });
    expect(again.status).toBe(200);
    const states = db.links.map((l) => [l.scope, l.projectId, l.state]);
    expect(states).toEqual([
      ["pm_my_work", null, "rotated"],
      ["pm_project", "p-abc", "active"],
      ["pm_my_work", null, "active"],
    ]);
    expect(auditsNamed("Work feed link created")).toHaveLength(2);
    expect(auditsNamed("Work feed link replaced")).toHaveLength(1);
    const secret = (u: string) => u.split("token=")[1].split(".")[1];
    expect(JSON.stringify(h.recordActivity.mock.calls) + h.logged.join("\n")).not.toContain(secret(first.body.url));
    expect(JSON.stringify(db.links)).not.toContain(secret(first.body.url));
  });

  it("revoke turns one feed's link off and reports how many it ended", async () => {
    const db = makeDb();
    await request(api(db, P.member)).post("/api/developer/feeds/rotate").send({ kind: "my_work" });
    await request(api(db, P.member)).post("/api/developer/feeds/rotate").send({ kind: "project", projectId: "p-abc" });
    const res = await request(api(db, P.member)).post("/api/developer/feeds/revoke").send({ kind: "project", projectId: "p-abc" });
    expect(res.body).toEqual({ revoked: 1 });
    expect(db.links.map((l) => [l.scope, l.state])).toEqual([
      ["pm_my_work", "active"],
      ["pm_project", "revoked"],
    ]);
    expect((await request(api(db, P.member)).post("/api/developer/feeds/revoke").send({ kind: "project", projectId: "p-abc" })).body).toEqual({ revoked: 0 });
    expect(auditsNamed("Work feed link turned off")).toHaveLength(2);
  });

  it("refuses a malformed body (400) and a project that is archived or absent (404)", async () => {
    const db = makeDb();
    const post = (body: object) => request(api(db, P.member)).post("/api/developer/feeds/rotate").send(body);
    for (const body of [{}, { kind: "calendar" }, { kind: "project" }, { kind: "project", projectId: "" }, { kind: "project", projectId: 3 }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post({ kind: "project", projectId: "p-old" })).body).toEqual({ error: "project_not_found" });
    expect((await post({ kind: "project", projectId: "p-nope" })).status).toBe(404);
    expect(db.links).toHaveLength(0);
  });

  it("keeps Service Desk projects out of feed discovery, rotation, and revocation", async () => {
    const db = makeDb();
    const listed = await request(api(db, P.member)).get("/api/developer/feeds");
    expect(listed.status).toBe(200);
    expect(listed.body.feeds.map((feed: { projectId: string | null }) => feed.projectId)).not.toContain("p-support");

    const rotate = await request(api(db, P.member))
      .post("/api/developer/feeds/rotate")
      .send({ kind: "project", projectId: "p-support" });
    expect(rotate.status).toBe(404);
    expect(rotate.body).toEqual({ error: "project_not_found" });

    const revoke = await request(api(db, P.member))
      .post("/api/developer/feeds/revoke")
      .send({ kind: "project", projectId: "p-support" });
    expect(revoke.status).toBe(404);
    expect(revoke.body).toEqual({ error: "project_not_found" });
    expect(db.links).toHaveLength(0);
  });

  it("is behind the Projects gates: module off and guests are 404 module_disabled, on every feed route", async () => {
    const off = makeDb({ projectsEnabled: false });
    for (const [verb, path, body] of [
      ["get", "/api/developer/feeds", undefined],
      ["post", "/api/developer/feeds/rotate", { kind: "my_work" }],
      ["post", "/api/developer/feeds/revoke", { kind: "my_work" }],
    ] as const) {
      const res = await request(api(off, P.member))[verb](path).send(body);
      expect(res.status, path).toBe(404);
      expect(res.body).toEqual({ error: "module_disabled", module: "projects" });
    }
    const on = makeDb();
    const guest = await request(api(on, P.guest)).post("/api/developer/feeds/rotate").send({ kind: "my_work" });
    expect(guest.status).toBe(404);
    expect(guest.body).toEqual({ error: "module_disabled", module: "projects" });
    expect(on.links).toHaveLength(0);
    // A service principal is not a person: 403.
    expect((await request(api(on, P.mcp)).get("/api/developer/feeds")).status).toBe(403);
  });
});

describe("WARP-3533 — an API token can reach none of this", () => {
  let seq = 0;
  function realStack(db: Db) {
    bindPmApiTokenPrisma(db as never);
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(authMiddleware);
    app.use(createPmApiTokenRateLimit(1000, `pm-api-token-dev-test-${++seq}`));
    app.use(pmApiTokenScopeGuard);
    app.use("/api", createDeveloperRouter(db as never));
    // a PM route, so the token is shown to work where it is meant to
    app.get("/api/pm/ping", (req, res) => res.json({ user: req.user?.id }));
    return app;
  }

  it("a token with every scope is a 403 TOKEN_ROUTE_FORBIDDEN on every developer route, and nothing is minted", async () => {
    const db = makeDb();
    switchOn(db);
    const u = db.users.get("u-admin")!;
    const { token } = await createPmApiToken(
      db as never,
      { id: u.id, role: u.role },
      { name: "all", scopes: ["pm:read", "pm:write", "support:read", "support:write"], expiresAt: null },
    );
    const app = realStack(db);
    const bearer = { Authorization: `Bearer ${token}` };
    expect((await request(app).get("/api/pm/ping").set(bearer)).status).toBe(200);

    const before = { tokens: db.tokens.length, links: db.links.length, switch: db.settings.get(PM_API_TOKENS_ENABLED_KEY) };
    const attempts: Array<[string, string, object | undefined]> = [
      ["get", "/api/developer", undefined],
      ["put", "/api/developer/settings", { enabled: false }],
      ["post", "/api/developer/tokens", { name: "successor", scopes: ["pm:read", "pm:write"] }],
      ["get", "/api/developer/tokens/all", undefined],
      ["delete", `/api/developer/tokens/${db.tokens[0].id}`, undefined],
      ["get", "/api/developer/feeds", undefined],
      ["post", "/api/developer/feeds/rotate", { kind: "my_work" }],
      ["post", "/api/developer/feeds/revoke", { kind: "my_work" }],
    ];
    for (const [verb, path, body] of attempts) {
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[verb](path).set(bearer).send(body);
      expect(res.status, `${verb} ${path}`).toBe(403);
      expect(res.body.code, `${verb} ${path}`).toBe("TOKEN_ROUTE_FORBIDDEN");
    }
    expect({ tokens: db.tokens.length, links: db.links.length, switch: db.settings.get(PM_API_TOKENS_ENABLED_KEY) }).toEqual(before);
    expect(db.tokens[0].status).toBe("active");
  });
});
