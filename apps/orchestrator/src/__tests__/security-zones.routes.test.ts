/**
 * WARP-2977 P2b (spec §7 routes 3, 4, 8–12; §9) — /api/security/zones and
 * /api/security/sources on the REAL router, the real `requireRole`, the real
 * `requireFeatureAccess` (with the resolver injected through `deps.resolve`)
 * and the real `auditSecurityInTx` — only the chain append itself
 * (`recordActivityInTx`) and Prisma are faked.
 *
 * The fake Prisma below is small but honest where these routes depend on it:
 * the compare-and-set `where` (id, version, state) is evaluated, a unique
 * `nameKey` is enforced, and `$transaction` ROLLS BACK on a throw — so "no
 * write" and "the row is unchanged" are provable, not assumed.
 *
 * What is pinned:
 *   · the 4-case level pin on every write route: (a) exactly manage → the
 *     exact 2xx and the exact audit row; (b) an admin narrowed to act → 404
 *     module_disabled, no write, no audit; (c) the role floor — a family
 *     member whose resolver says manage → 403 before the resolver is asked;
 *     (d) the owner → 2xx. Every gated case asserts the resolver was asked
 *     with the caller's id, so a 404 can never be a vacuous one.
 *   · every GET answers a family member at view (no GET is gated above view).
 *   · DS-005 for places: a family viewer granted camera `front` only.
 *   · audit discipline: kind system / severity info / refs.surface+action on
 *     every write; none on changed:false, a 409 or a lost CAS; a failed
 *     append is 503 AUDIT_UNAVAILABLE with the row unchanged (all five
 *     writes); a refused audit precondition is a 500, never a 503.
 *   · the 64-area limit is counted under its advisory lock on add AND
 *     restore (the race itself is proven in security-zones.pg.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  recordActivityInTx: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, FRIGATE_URL: "http://frigate.test:5000" },
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
  recordActivityInTx: h.recordActivityInTx,
  getActivityRecorder: () => null,
}));

import { createSecurityZonesRouter } from "../routes/security-zones.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";
import { ActivityChainPreconditionError } from "../services/activity.service.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { createTransactionSeam } from "./helpers/prisma-tx-harness.js";

// ── the fake database ─────────────────────────────────────────────────────

interface ZoneRow {
  id: string;
  name: string;
  nameKey: string;
  kind: string;
  state: "active" | "archived";
  version: number;
  createdById: string | null;
}
interface LinkRow {
  id: string;
  zoneId: string;
  sourceKind: "camera" | "camera_zone";
  sourceRef: string;
  sourceLabel: string;
  state: "active" | "removed" | "proposed" | "rejected";
  /** WARP-2979 — who created the row and who set its state; every P2b row is a person's. */
  origin: "person" | "droplet";
  stateSetBy: "person" | "droplet";
  createdById: string | null;
  decidedById: string | null;
  stateChangedAt: Date;
}

const SHOP = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61";
const YARD = "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c82";
const OLD = "9b8a7c6d-5e4f-4d3c-8b2a-1f0e9d8c7b63";
const GONE = "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
const T0 = new Date("2026-09-20T08:00:00Z");
const NOW = new Date("2026-09-23T10:00:00Z");

const db = {
  zones: [] as ZoneRow[],
  links: [] as LinkRow[],
  cameras: [] as Array<{ name: string; displayName: string }>,
  grants: new Map<string, string[]>(),
  sql: [] as string[],
  txOptions: [] as unknown[],
  /** Runs at the start of every securityZone.updateMany — lets a test lose the CAS race. */
  beforeCas: null as null | (() => void),
  /** The snapshot of every transaction opened in this test; a concurrent COMMITTED write must survive their rollback. */
  open: [] as Array<{ zones: ZoneRow[]; links: LinkRow[] }>,
  /** Thrown by securityZone.create instead of creating — the database refusing the row. */
  createError: null as unknown,
  /** In order: every raw statement (with its values) and every active-area count — pins lock-before-count. */
  log: [] as string[],
};

const clone = <T>(v: T): T => structuredClone(v);

function seed(): void {
  db.zones = [
    { id: SHOP, name: "Shop floor", nameKey: "shop floor", kind: "interior", state: "active", version: 3, createdById: "u-owner" },
    { id: YARD, name: "Yard", nameKey: "yard", kind: "perimeter", state: "active", version: 1, createdById: "u-owner" },
    { id: OLD, name: "Old store", nameKey: "old store", kind: "restricted", state: "archived", version: 5, createdById: "u-owner" },
  ];
  const l = (id: string, zoneId: string, sourceKind: LinkRow["sourceKind"], sourceRef: string, state: LinkRow["state"] = "active"): LinkRow => ({
    id,
    zoneId,
    sourceKind,
    sourceRef,
    sourceLabel: `was ${sourceRef.split("/")[0]}`,
    state,
    origin: "person",
    stateSetBy: "person",
    createdById: "u-owner",
    decidedById: null,
    stateChangedAt: T0,
  });
  db.links = [
    l("l-shop-front", SHOP, "camera", "front"),
    l("l-shop-porch", SHOP, "camera_zone", "back/porch"),
    l("l-shop-till", SHOP, "camera_zone", "back/till", "removed"),
    l("l-shop-cam9", SHOP, "camera", "cam9"), // stale: the camera is gone
    l("l-yard-back", YARD, "camera", "back"),
  ];
  db.cameras = [
    { name: "front", displayName: "Front camera" },
    { name: "back", displayName: "Back camera" },
    { name: "side", displayName: "Side camera" },
  ];
  db.grants = new Map([["u-fam", ["front"]]]);
  db.sql = [];
  db.txOptions = [];
  db.beforeCas = null;
  db.createError = null;
  db.open = [];
  db.log = [];
}

/** Another writer commits a version bump on `id` (visible now, and kept if our transaction rolls back). */
function concurrentBump(id: string): void {
  for (const zones of [db.zones, ...db.open.map((s) => s.zones)]) zones.find((z) => z.id === id)!.version += 1;
}

function zoneWithLinks(z: ZoneRow, select: Record<string, unknown> | undefined) {
  if (select && !("links" in select)) {
    return Object.fromEntries(Object.keys(select).map((k) => [k, (z as unknown as Record<string, unknown>)[k]]));
  }
  const linkWhere = (select?.links as { where?: { state?: string } } | undefined)?.where;
  const links = db.links
    .filter((l) => l.zoneId === z.id && (!linkWhere?.state || l.state === linkWhere.state))
    // Postgres orders an enum by declaration order (camera, camera_zone), then the ref.
    .sort((a, b) => (a.sourceKind === b.sourceKind ? (a.sourceRef < b.sourceRef ? -1 : 1) : a.sourceKind === "camera" ? -1 : 1))
    .map(clone);
  return { ...clone(z), links };
}

function uniqueNameKey(key: string, exceptId?: string): void {
  if (db.zones.some((z) => z.nameKey === key && z.id !== exceptId)) {
    throw Object.assign(new Error("Unique constraint failed on the fields: (`nameKey`)"), {
      code: "P2002",
      meta: { target: ["nameKey"] },
    });
  }
}

const matchesState = (actual: string, want: unknown) => want === undefined || actual === want;

const prisma = {
  securityZone: {
    findMany: vi.fn(async (args: { where?: { state?: string }; select?: Record<string, unknown> }) =>
      db.zones
        .filter((z) => matchesState(z.state, args.where?.state))
        .sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === "active" ? -1 : 1))
        .map((z) => zoneWithLinks(z, args.select)),
    ),
    findUnique: vi.fn(async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
      const z = db.zones.find((x) => x.id === args.where.id);
      return z ? zoneWithLinks(z, args.select) : null;
    }),
    count: vi.fn(async (args: { where?: { state?: string } }) => {
      db.log.push(`count ${JSON.stringify(args.where ?? {})}`);
      return db.zones.filter((z) => matchesState(z.state, args.where?.state)).length;
    }),
    create: vi.fn(async (args: { data: { name: string; nameKey: string; kind: string; createdById: string | null }; select?: Record<string, unknown> }) => {
      if (db.createError) throw db.createError;
      uniqueNameKey(args.data.nameKey);
      const z: ZoneRow = { id: randomUUID(), state: "active", version: 0, ...args.data };
      db.zones.push(z);
      return zoneWithLinks(z, args.select);
    }),
    updateMany: vi.fn(
      async (args: {
        where: { id: string; version?: number; state?: string };
        data: { name?: string; nameKey?: string; kind?: string; state?: ZoneRow["state"]; version?: { increment: number } };
      }) => {
        db.beforeCas?.();
        const hits = db.zones.filter(
          (z) =>
            z.id === args.where.id &&
            (args.where.version === undefined || z.version === args.where.version) &&
            matchesState(z.state, args.where.state),
        );
        for (const z of hits) {
          if (args.data.nameKey !== undefined) uniqueNameKey(args.data.nameKey, z.id);
          if (args.data.name !== undefined) z.name = args.data.name;
          if (args.data.nameKey !== undefined) z.nameKey = args.data.nameKey;
          if (args.data.kind !== undefined) z.kind = args.data.kind;
          if (args.data.state !== undefined) z.state = args.data.state;
          if (args.data.version) z.version += args.data.version.increment;
        }
        return { count: hits.length };
      },
    ),
  },
  securityZoneLink: {
    findMany: vi.fn(async (args: { where: { zoneId?: string; state?: string; zone?: { state?: string } }; select?: Record<string, unknown> }) =>
      db.links
        .filter((l) => {
          if (args.where.zoneId !== undefined && l.zoneId !== args.where.zoneId) return false;
          if (!matchesState(l.state, args.where.state)) return false;
          const zone = db.zones.find((z) => z.id === l.zoneId)!;
          return matchesState(zone.state, args.where.zone?.state);
        })
        .map((l) => {
          const zone = db.zones.find((z) => z.id === l.zoneId)!;
          return { ...clone(l), zone: { name: zone.name, kind: zone.kind } };
        }),
    ),
    createMany: vi.fn(async (args: { data: Array<Omit<LinkRow, "id" | "decidedById">> }) => {
      for (const d of args.data) db.links.push({ id: `l-new-${d.sourceRef}`, decidedById: null, ...d });
      return { count: args.data.length };
    }),
    updateMany: vi.fn(
      async (args: { where: { id: string | { in: string[] }; state?: string }; data: Partial<LinkRow> }) => {
        const ids = typeof args.where.id === "string" ? [args.where.id] : args.where.id.in;
        const hits = db.links.filter((l) => ids.includes(l.id) && matchesState(l.state, args.where.state));
        for (const l of hits) Object.assign(l, args.data);
        return { count: hits.length };
      },
    ),
  },
  camera: {
    findMany: vi.fn(async () => db.cameras.map(clone)),
  },
  cameraAccessGrant: {
    findMany: vi.fn(async (args: { where: { userId: string } }) =>
      (db.grants.get(args.where.userId) ?? []).map((name) => ({ camera: { name } })),
    ),
  },
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    db.sql.push(sql);
    db.log.push(`sql ${sql} ${JSON.stringify(values)}`);
    if (sql.includes("pg_advisory_xact_lock")) return [{ locked: false }];
    // The fake approximates Postgres lower(btrim(...)); the pg lane pins the real thing.
    const key = String(values[0]).trim().toLowerCase();
    if (sql.includes('FROM "SecurityZone"')) {
      const z = db.zones.find((x) => x.nameKey === key);
      return z ? [{ id: z.id, state: z.state }] : [];
    }
    if (sql.includes("lower(btrim(")) return [{ k: key }];
    throw new Error(`fake $queryRaw: unexpected SQL ${sql}`);
  }),
  $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
    db.txOptions.push(options);
    return txSeam.$transaction(fn, options);
  }),
};

/**
 * WARP-1570: the shared transaction seam. It hands the callback the fake
 * itself, and ROLLS BACK on a throw to the snapshot taken when the
 * transaction opened (then re-applies anything another transaction committed
 * meanwhile). A snapshot stays in `db.open` so `concurrentBump` — a write
 * another writer committed — survives that rollback.
 */
const txSeam = createTransactionSeam({
  client: () => prisma,
  snapshot: () => {
    const snap = { zones: clone(db.zones), links: clone(db.links) };
    db.open.push(snap);
    return snap;
  },
  restore: (snap) => {
    const s = snap as { zones: ZoneRow[]; links: LinkRow[] };
    db.zones = s.zones;
    db.links = s.links;
  },
});

// ── principals and the §9 resolver fixture (feature-gate.test.ts shape) ───

type Role = "owner" | "admin" | "family" | "guest";
type Level = "view" | "act" | "manage";

function result(level: Level | null, tier: EffectiveAccessResult["tier"]): EffectiveAccessResult {
  return {
    tier,
    features: (level ? [{ moduleId: "security", level }] : []) as EffectiveAccessResult["features"],
    toolDomains: [],
    locks: false,
    cloud: false,
    connectors: {},
    connectorGrants: null,
    usage: {
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      source: "default",
      sources: { storageQuotaBytes: "default", maxUploadSizeMb: "default", llmDailyMessageCap: "default" },
    },
    deptRights: [],
    exceptions: [],
  };
}

const USERS: Record<string, { role: Role; level: Level | null }> = {
  "u-owner": { role: "owner", level: "manage" },
  "u-admin": { role: "admin", level: "manage" },
  "u-admin-act": { role: "admin", level: "act" },
  "u-fam": { role: "family", level: "view" },
  "u-fam-manage": { role: "family", level: "manage" },
  "u-guest": { role: "guest", level: "view" },
};

const resolve = vi.fn(async (userId: string) => {
  const u = USERS[userId];
  return u ? result(u.level, u.role === "guest" ? "family" : u.role) : null;
});

const frigate = vi.fn();
const FRIGATE_CONFIG = {
  cameras: { front: { zones: { porch: {} } }, back: { zones: { porch: {}, till: {}, door: {} } }, side: {} },
};

function app(userId: keyof typeof USERS | null) {
  const server = express();
  server.use(express.json());
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (userId) (req as Request & { user?: unknown }).user = { id: userId, username: userId, displayName: userId, role: USERS[userId].role };
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.use("/api", createSecurityZonesRouter(prisma as any, { resolve, now: () => NOW, frigateConfig: frigate }));
  return server;
}

/** The (tx, params) of every chain append — the audit rows the routes wrote. */
const audits = () => h.recordActivityInTx.mock.calls.map((c) => c[1] as Record<string, unknown> & { refs: Record<string, unknown> });
const state = () => clone({ zones: db.zones, links: db.links });

beforeEach(() => {
  seed();
  vi.clearAllMocks();
  sensitiveRateLimit.resetKey("127.0.0.1");
  h.recordActivityInTx.mockImplementation(async () => ({ id: 1n }));
  frigate.mockResolvedValue(FRIGATE_CONFIG);
});

// ── 4-case level pins on every write route ───────────────────────────────

interface WriteCase {
  name: string;
  send: (userId: keyof typeof USERS) => request.Test;
  status: number;
  action: string;
}

const WRITES: WriteCase[] = [
  {
    name: "POST /security/zones",
    send: (u) => request(app(u)).post("/api/security/zones").send({ name: "Stock room", kind: "restricted" }),
    status: 201,
    action: "zone.create",
  },
  {
    name: "PATCH /security/zones/:id",
    send: (u) => request(app(u)).patch(`/api/security/zones/${SHOP}`).send({ kind: "entry", expectedVersion: 3 }),
    status: 200,
    action: "zone.update",
  },
  {
    name: "POST /security/zones/:id/archive",
    send: (u) => request(app(u)).post(`/api/security/zones/${SHOP}/archive`).send({ expectedVersion: 3 }),
    status: 200,
    action: "zone.archive",
  },
  {
    name: "POST /security/zones/:id/unarchive",
    send: (u) => request(app(u)).post(`/api/security/zones/${OLD}/unarchive`).send({ expectedVersion: 5 }),
    status: 200,
    action: "zone.unarchive",
  },
  {
    name: "PUT /security/zones/:id/links",
    send: (u) =>
      request(app(u))
        .put(`/api/security/zones/${SHOP}/links`)
        .send({ links: [{ sourceKind: "camera", sourceRef: "front" }, { sourceKind: "camera", sourceRef: "side" }], expectedVersion: 3 }),
    status: 200,
    action: "zone.links",
  },
];

describe.each(WRITES)("$name — level pins (manage)", ({ send, status, action }) => {
  it("(a) exactly manage → the exact 2xx and exactly one audit row", async () => {
    const res = await send("u-admin");
    expect(res.status).toBe(status);
    expect(resolve).toHaveBeenCalledWith("u-admin");
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      kind: "system",
      severity: "info",
      sourceIcon: "shield",
      actor: { type: "user", id: "u-admin" },
      refs: { surface: "security", action },
    });
    expect(db.txOptions).toEqual([READ_COMMITTED_TX]);
  });

  it("(b) an admin narrowed to act → 404 module_disabled, no write, no audit", async () => {
    const before = state();
    const res = await send("u-admin-act");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "security" });
    expect(resolve).toHaveBeenCalledWith("u-admin-act");
    expect(state()).toEqual(before);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("(c) the role floor: family whose resolver says manage → 403 before the resolver is asked", async () => {
    const before = state();
    const res = await send("u-fam-manage");
    expect(res.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("(d) the owner → the 2xx", async () => {
    const res = await send("u-owner");
    expect(res.status).toBe(status);
    expect(resolve).toHaveBeenCalledWith("u-owner");
    expect(audits()).toHaveLength(1);
  });
});

describe("every GET answers a family member at view (none is gated above view)", () => {
  it.each(["/api/security/zones", "/api/security/zones?include=archived", "/api/security/sources"])("%s → 200", async (path) => {
    const res = await request(app("u-fam")).get(path);
    expect(res.status).toBe(200);
  });

  it("guests are below the role floor", async () => {
    expect((await request(app("u-guest")).get("/api/security/zones")).status).toBe(403);
    expect((await request(app("u-guest")).get("/api/security/sources")).status).toBe(403);
  });
});

// ── DS-005 for places ────────────────────────────────────────────────────

describe("DS-005 — family granted `front` only", () => {
  it("the list shows the area it can partly see with those links only, and hides the one it cannot see at all", async () => {
    const res = await request(app("u-fam")).get("/api/security/zones");
    expect(res.body.zones.map((z: { id: string; links: Array<{ sourceRef: string }> }) => [z.id, z.links.map((l) => l.sourceRef)])).toEqual([
      [SHOP, ["front"]],
    ]);
  });

  it("the owner sees every active area with every active link, labelled by the live camera name, else the snapshot", async () => {
    const res = await request(app("u-owner")).get("/api/security/zones");
    expect(res.body.zones).toEqual([
      {
        id: SHOP,
        name: "Shop floor",
        kind: "interior",
        state: "active",
        version: 3,
        links: [
          { id: "l-shop-cam9", sourceKind: "camera", sourceRef: "cam9", label: "was cam9", state: "active", stateChangedAt: T0.toISOString() },
          { id: "l-shop-front", sourceKind: "camera", sourceRef: "front", label: "Front camera", state: "active", stateChangedAt: T0.toISOString() },
          { id: "l-shop-porch", sourceKind: "camera_zone", sourceRef: "back/porch", label: "Back camera", state: "active", stateChangedAt: T0.toISOString() },
        ],
      },
      { id: YARD, name: "Yard", kind: "perimeter", state: "active", version: 1, links: [{ id: "l-yard-back", sourceKind: "camera", sourceRef: "back", label: "Back camera", state: "active", stateChangedAt: T0.toISOString() }] },
    ]);
  });

  it("/sources omits the camera it cannot see, and every link on it", async () => {
    const res = await request(app("u-fam")).get("/api/security/sources");
    expect(res.body).toEqual({
      frigate: "ok",
      cameras: [{ name: "front", label: "Front camera", parts: ["porch"] }],
      linkStatus: [{ linkId: "l-shop-front", status: "present" }],
    });
  });
});

describe("GET /api/security/zones — include=archived is a filter at manage, never a gate", () => {
  const ids = (res: request.Response) => res.body.zones.map((z: { id: string }) => z.id);

  it("owner/admin at manage get the removed areas too", async () => {
    expect(ids(await request(app("u-admin")).get("/api/security/zones?include=archived"))).toEqual([SHOP, YARD, OLD]);
    expect(resolve).toHaveBeenCalledWith("u-admin");
  });

  it("an admin narrowed to act, and family, get the active list — 200, never a refusal", async () => {
    for (const u of ["u-admin-act", "u-fam"] as const) {
      const res = await request(app(u)).get("/api/security/zones?include=archived");
      expect(res.status).toBe(200);
      expect(ids(res)).not.toContain(OLD);
    }
  });

  it("an unknown include value is a 400", async () => {
    expect((await request(app("u-owner")).get("/api/security/zones?include=removed")).status).toBe(400);
  });

  it("a database failure is 503 ZONES_UNAVAILABLE, never an empty list", async () => {
    prisma.securityZone.findMany.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app("u-owner")).get("/api/security/zones");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ZONES_UNAVAILABLE");
  });
});

describe("GET /api/security/sources — one config fetch, degrades per half", () => {
  it("owner: every camera, parts from Frigate, and each link's status", async () => {
    const res = await request(app("u-owner")).get("/api/security/sources");
    expect(frigate).toHaveBeenCalledTimes(1);
    expect(res.body.cameras).toEqual([
      { name: "back", label: "Back camera", parts: ["door", "porch", "till"] },
      { name: "front", label: "Front camera", parts: ["porch"] },
      { name: "side", label: "Side camera", parts: [] },
    ]);
    expect(res.body.linkStatus).toEqual([
      { linkId: "l-shop-front", status: "present" },
      { linkId: "l-shop-porch", status: "present" },
      { linkId: "l-shop-cam9", status: "missing" },
      { linkId: "l-yard-back", status: "present" },
    ]);
  });

  it("Frigate down: frigate unavailable, cameras from the rows without parts, parts unknown — still 200", async () => {
    frigate.mockRejectedValueOnce(new Error("timeout"));
    const res = await request(app("u-owner")).get("/api/security/sources");
    expect(res.status).toBe(200);
    expect(res.body.frigate).toBe("unavailable");
    expect(res.body.cameras.every((c: { parts: string[] }) => c.parts.length === 0)).toBe(true);
    expect(res.body.linkStatus).toContainEqual({ linkId: "l-shop-porch", status: "unknown" });
    expect(res.body.linkStatus).toContainEqual({ linkId: "l-shop-cam9", status: "unknown" });
    expect(res.body.linkStatus).toContainEqual({ linkId: "l-shop-front", status: "present" });
  });

  it("the Camera rows unreadable: cameras from Frigate alone, and EVERY visible link still has a status — unknown where it needed the rows — still 200", async () => {
    prisma.camera.findMany.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app("u-owner")).get("/api/security/sources");
    expect(res.status).toBe(200);
    expect(res.body.frigate).toBe("ok");
    expect(res.body.cameras.map((c: { label: string }) => c.label)).toEqual(["back", "front", "side"]);
    // Never an empty list (the Areas page would flag nothing). cam9 is in
    // neither half that answered, and "missing" needs BOTH: unknown.
    expect(res.body.linkStatus).toEqual([
      { linkId: "l-shop-front", status: "present" },
      { linkId: "l-shop-porch", status: "present" },
      { linkId: "l-shop-cam9", status: "unknown" },
      { linkId: "l-yard-back", status: "present" },
    ]);
  });

  it.each([
    ["the owner", "u-owner" as const, ["l-shop-front", "l-shop-porch", "l-shop-cam9", "l-yard-back"]],
    ["a family viewer granted front only", "u-fam" as const, ["l-shop-front"]],
  ])("both halves down, for %s: every VISIBLE link is unknown — still 200", async (_l, user, visible) => {
    prisma.camera.findMany.mockRejectedValueOnce(new Error("db down"));
    frigate.mockRejectedValueOnce(new Error("timeout"));
    const res = await request(app(user)).get("/api/security/sources");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      frigate: "unavailable",
      cameras: [],
      linkStatus: visible.map((linkId) => ({ linkId, status: "unknown" })),
    });
  });

  it("the links themselves unreadable: 503 ZONES_UNAVAILABLE — never an empty list that reads as all clear", async () => {
    prisma.securityZoneLink.findMany.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app("u-owner")).get("/api/security/sources");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ZONES_UNAVAILABLE");
  });

  it("the viewer's grants unreadable: 503 — never an unfiltered list", async () => {
    prisma.cameraAccessGrant.findMany.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app("u-fam")).get("/api/security/sources");
    expect(res.status).toBe(503);
  });
});

// ── route 8: add an area ─────────────────────────────────────────────────

describe("POST /api/security/zones", () => {
  it("creates it trimmed, with nameKey computed by Postgres inside the transaction, and audits it", async () => {
    const res = await request(app("u-owner")).post("/api/security/zones").send({ name: "  Stock room ", kind: "restricted" });
    expect(res.status).toBe(201);
    expect(res.body.zone).toMatchObject({ name: "Stock room", kind: "restricted", state: "active", version: 0, links: [] });
    expect(db.zones.find((z) => z.name === "Stock room")).toMatchObject({ nameKey: "stock room", createdById: "u-owner" });
    expect(db.sql.some((s) => s.includes("lower(btrim(") && s.includes("AS k"))).toBe(true);
    expect(db.sql[0]).toContain("pg_advisory_xact_lock");
    expect(audits()[0]).toMatchObject({
      what: 'Security: added the area "Stock room"',
      refs: { surface: "security", action: "zone.create", zoneId: res.body.zone.id, name: "Stock room", kind: "restricted" },
    });
  });

  it.each([
    ["an empty name", { name: "   ", kind: "entry" }],
    ["a 61-character name", { name: "x".repeat(61), kind: "entry" }],
    ["a control character", { name: "Front\u0007door", kind: "entry" }],
    ["a lone surrogate (unstorable in the audit chain)", { name: "Front\ud800", kind: "entry" }],
    ["a right-to-left override (U+202E)", { name: "Front \u202Eroom kcots", kind: "entry" }],
    ["a bidi isolate (U+2067)", { name: "Front \u2067door\u2069", kind: "entry" }],
    ["a zero-width space (U+200B)", { name: "Front\u200Bdoor", kind: "entry" }],
    ["a trailing U+FEFF (never quietly trimmed)", { name: "Front door\uFEFF", kind: "entry" }],
    ["nothing visible (Hangul fillers)", { name: "\u3164\u3164", kind: "entry" }],
    ["nothing visible (no-break spaces)", { name: "\u00A0\u00A0", kind: "entry" }],
    ["an unknown kind", { name: "Front door", kind: "lobby" }],
    ["an unknown field", { name: "Front door", kind: "entry", state: "archived" }],
  ])("400 on %s, before any transaction", async (_n, body) => {
    const res = await request(app("u-owner")).post("/api/security/zones").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a name another area holds, in any case → 409 ZONE_NAME_TAKEN, nothing written", async () => {
    const res = await request(app("u-owner")).post("/api/security/zones").send({ name: "SHOP FLOOR", kind: "entry" });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "ZONE_NAME_TAKEN", message: expect.any(String) });
    expect(db.zones).toHaveLength(3);
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("…held by a removed area → 409 with archivedZoneId, so the page can offer to restore it", async () => {
    const res = await request(app("u-owner")).post("/api/security/zones").send({ name: "old store", kind: "entry" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "ZONE_NAME_TAKEN", archivedZoneId: OLD });
  });

  it("the database refusing the name CHECK (23514) → 400 VALIDATION_ERROR, not a 500", async () => {
    db.createError = new Error('new row for relation "SecurityZone" violates check constraint "SecurityZone_name_key"');
    const res = await request(app("u-owner")).post("/api/security/zones").send({ name: "Front door", kind: "entry" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("a 65th active area → 409 ZONE_LIMIT, nothing written", async () => {
    for (let i = 0; i < 62; i++) {
      db.zones.push({ id: randomUUID(), name: `A${i}`, nameKey: `a${i}`, kind: "entry", state: "active", version: 0, createdById: null });
    }
    const res = await request(app("u-owner")).post("/api/security/zones").send({ name: "One more", kind: "entry" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ZONE_LIMIT");
    expect(db.zones).toHaveLength(65);
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("a failed audit append → 503 AUDIT_UNAVAILABLE and the area was never created", async () => {
    h.recordActivityInTx.mockRejectedValueOnce(new Error("chain lock timeout"));
    const res = await request(app("u-owner")).post("/api/security/zones").send({ name: "Stock room", kind: "restricted" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(db.zones.map((z) => z.name)).not.toContain("Stock room");
  });

  it("a broken audit precondition is a programming error: 500 INTERNAL_ERROR, never dressed up as an outage", async () => {
    // security-audit.ts's contract: only a failed APPEND is AUDIT_UNAVAILABLE (503, "try again");
    // a transaction the append refuses (not READ COMMITTED, a bare client) is a bug — a 500.
    h.recordActivityInTx.mockRejectedValueOnce(new ActivityChainPreconditionError("not a READ COMMITTED transaction"));
    const before = state();
    const res = await request(app("u-owner")).post("/api/security/zones").send({ name: "Stock room", kind: "restricted" });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(state()).toEqual(before);
  });
});

// ── the 64-area limit: routes 8 and 11 check-then-write under one lock ───

describe("the 64-area limit is counted under its own lock", () => {
  it.each([
    ["adding an area", () => request(app("u-owner")).post("/api/security/zones").send({ name: "Stock room", kind: "restricted" }), 201],
    ["restoring one", () => request(app("u-owner")).post(`/api/security/zones/${OLD}/unarchive`).send({ expectedVersion: 5 }), 200],
  ] as const)("%s takes the area-limit advisory lock BEFORE it counts the active areas", async (_n, send, status) => {
    // Without the lock two writers at 63 both count 63 and both commit: 65 active areas
    // (security-zones.pg.test.ts proves that race on real Postgres).
    expect((await send()).status).toBe(status);
    const lock = db.log.findIndex((e) => e.includes("pg_advisory_xact_lock") && e.includes('"droplet:security-zone-limit"'));
    const count = db.log.findIndex((e) => e.startsWith("count "));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(count).toBeGreaterThan(lock);
  });
});

// ── route 9: rename / re-kind ────────────────────────────────────────────

describe("PATCH /api/security/zones/:id", () => {
  const patch = (body: Record<string, unknown>, id = SHOP) => request(app("u-owner")).patch(`/api/security/zones/${id}`).send(body);

  it("renames it, recomputes nameKey in SQL, bumps the version and audits before/after", async () => {
    const res = await patch({ name: "Sales floor", expectedVersion: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, zone: { id: SHOP, name: "Sales floor", version: 4 } });
    expect(db.zones.find((z) => z.id === SHOP)).toMatchObject({ nameKey: "sales floor", version: 4 });
    expect(audits()[0]).toMatchObject({
      what: 'Security: renamed the area "Shop floor" to "Sales floor"',
      refs: {
        action: "zone.update",
        zoneId: SHOP,
        before: { name: "Shop floor", kind: "interior" },
        after: { name: "Sales floor", kind: "interior" },
      },
    });
  });

  it("nothing to change → 200 changed:false, no write, no audit", async () => {
    const res = await patch({ name: " Shop floor ", kind: "interior", expectedVersion: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: false, zone: { version: 3 } });
    expect(prisma.securityZone.updateMany).not.toHaveBeenCalled();
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("a stale form → 409 VERSION_CONFLICT, no audit", async () => {
    const res = await patch({ kind: "entry", expectedVersion: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VERSION_CONFLICT");
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("a CAS lost to a concurrent write (count 0) → 409, row untouched, no audit", async () => {
    db.beforeCas = () => {
      concurrentBump(SHOP);
      db.beforeCas = null;
    };
    const res = await patch({ kind: "entry", expectedVersion: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VERSION_CONFLICT");
    expect(db.zones.find((z) => z.id === SHOP)).toMatchObject({ kind: "interior", version: 4 });
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("a removed area → 409 ZONE_ARCHIVED; unknown and non-uuid ids → 404", async () => {
    expect((await patch({ kind: "entry", expectedVersion: 5 }, OLD)).body.error.code).toBe("ZONE_ARCHIVED");
    const gone = await patch({ kind: "entry", expectedVersion: 0 }, GONE);
    expect([gone.status, gone.body.error.code]).toEqual([404, "ZONE_NOT_FOUND"]);
    expect((await patch({ kind: "entry", expectedVersion: 0 }, "shop")).status).toBe(404);
  });

  it("renaming onto another area's name → 409 ZONE_NAME_TAKEN, rolled back", async () => {
    const res = await patch({ name: "yard", expectedVersion: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ZONE_NAME_TAKEN");
    expect(db.zones.find((z) => z.id === SHOP)).toMatchObject({ name: "Shop floor", version: 3 });
  });

  it("400 without name or kind, or with a non-integer version", async () => {
    expect((await patch({ expectedVersion: 3 })).status).toBe(400);
    expect((await patch({ kind: "entry", expectedVersion: 3.5 })).status).toBe(400);
    expect((await patch({ kind: "entry" })).status).toBe(400);
  });

  it.each([
    ["a left-to-right override (U+202D)", "Shop \u202Dfloor"],
    ["a zero-width joiner (U+200D)", "Shop\u200Dfloor"],
    ["a word joiner (U+2060)", "Shop\u2060floor"],
    ["nothing visible", "\u200E\u3000"],
  ])("a rename to a name with %s → 400 VALIDATION_ERROR before any transaction, the area unchanged", async (_n, name) => {
    const before = state();
    const res = await patch({ name, expectedVersion: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("a failed audit append → 503 AUDIT_UNAVAILABLE and the area is unchanged", async () => {
    h.recordActivityInTx.mockRejectedValueOnce(new Error("disk full"));
    const res = await patch({ name: "Sales floor", expectedVersion: 3 });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(db.zones.find((z) => z.id === SHOP)).toMatchObject({ name: "Shop floor", nameKey: "shop floor", version: 3 });
  });
});

// ── routes 10 / 11: remove and restore ───────────────────────────────────

describe("POST /api/security/zones/:id/archive and /unarchive", () => {
  it("archive: state archived, version bumped, links kept, audited", async () => {
    const res = await request(app("u-owner")).post(`/api/security/zones/${SHOP}/archive`).send({ expectedVersion: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, zone: { state: "archived", version: 4 } });
    expect(db.links.filter((l) => l.zoneId === SHOP && l.state === "active")).toHaveLength(3);
    expect(audits()[0]).toMatchObject({ what: 'Security: removed the area "Shop floor"', refs: { action: "zone.archive", zoneId: SHOP } });
  });

  it("already in that state → changed:false and no audit; a stale version → 409", async () => {
    const same = await request(app("u-owner")).post(`/api/security/zones/${OLD}/archive`).send({ expectedVersion: 5 });
    expect(same.body).toMatchObject({ changed: false, zone: { state: "archived", version: 5 } });
    const stale = await request(app("u-owner")).post(`/api/security/zones/${OLD}/unarchive`).send({ expectedVersion: 4 });
    expect(stale.status).toBe(409);
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it.each([
    ["archive", SHOP, 3, "active"],
    ["unarchive", OLD, 5, "archived"],
  ] as const)("%s: a CAS lost to a concurrent write (count 0) → 409, state untouched, no audit", async (op, id, v, stays) => {
    db.beforeCas = () => {
      concurrentBump(id);
      db.beforeCas = null;
    };
    const res = await request(app("u-owner")).post(`/api/security/zones/${id}/${op}`).send({ expectedVersion: v });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VERSION_CONFLICT");
    expect(db.zones.find((z) => z.id === id)).toMatchObject({ state: stays, version: v + 1 });
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it.each([
    ["archive", SHOP, 3],
    ["unarchive", OLD, 5],
  ] as const)("%s: a failed audit append → 503 AUDIT_UNAVAILABLE, state and version unchanged", async (op, id, v) => {
    h.recordActivityInTx.mockRejectedValueOnce(new Error("chain lock timeout"));
    const before = state();
    const res = await request(app("u-owner")).post(`/api/security/zones/${id}/${op}`).send({ expectedVersion: v });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(state()).toEqual(before);
  });

  it("restoring a 65th active area → 409 ZONE_LIMIT", async () => {
    for (let i = 0; i < 62; i++) {
      db.zones.push({ id: randomUUID(), name: `A${i}`, nameKey: `a${i}`, kind: "entry", state: "active", version: 0, createdById: null });
    }
    const res = await request(app("u-owner")).post(`/api/security/zones/${OLD}/unarchive`).send({ expectedVersion: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ZONE_LIMIT");
    expect(db.zones.find((z) => z.id === OLD)?.state).toBe("archived");
  });
});

// ── route 12: what covers an area ────────────────────────────────────────

describe("PUT /api/security/zones/:id/links", () => {
  const put = (links: Array<[string, string]>, expectedVersion = 3, id = SHOP) =>
    request(app("u-owner"))
      .put(`/api/security/zones/${id}/links`)
      .send({ links: links.map(([sourceKind, sourceRef]) => ({ sourceKind, sourceRef })), expectedVersion });
  const active = (zoneId = SHOP) =>
    db.links
      .filter((l) => l.zoneId === zoneId && l.state === "active")
      .map((l) => l.sourceRef)
      .sort();

  it("adds, reactivates and removes in one audited change; the version moves once", async () => {
    const res = await put([
      ["camera", "front"],
      ["camera_zone", "back/till"], // removed → active again
      ["camera_zone", "back/door"], // new
      ["camera", "cam9"], // stale, but already linked: kept without a check
    ]);
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.zone.version).toBe(4);
    expect(active()).toEqual(["back/door", "back/till", "cam9", "front"]);
    const porch = db.links.find((l) => l.id === "l-shop-porch")!;
    expect(porch).toMatchObject({ state: "removed", decidedById: "u-owner", stateChangedAt: NOW });
    expect(db.links.find((l) => l.sourceRef === "back/door")).toMatchObject({ sourceLabel: "Back camera", createdById: "u-owner" });
    expect(db.links.find((l) => l.id === "l-shop-till")).toMatchObject({ state: "active", sourceLabel: "Back camera", decidedById: "u-owner" });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      what: 'Security: changed what covers the area "Shop floor"',
      refs: { action: "zone.links", zoneId: SHOP, added: ["back/door"], removed: ["back/porch"], reactivated: ["back/till"] },
    });
  });

  it("the same set (in any order, with duplicates) → changed:false, no transaction, no audit", async () => {
    const res = await put([
      ["camera_zone", "back/porch"],
      ["camera", "cam9"],
      ["camera", "front"],
      ["camera", "front"],
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: false, zone: { version: 3 } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("only NEW refs are checked, and a camera row answers without asking Frigate", async () => {
    const res = await put([
      ["camera", "front"],
      ["camera", "side"],
    ]);
    expect(res.status).toBe(200);
    expect(frigate).not.toHaveBeenCalled();
  });

  it.each([
    ["a camera neither half knows", [["camera", "cam7"]]],
    ["a part the camera does not have", [["camera_zone", "back/gate"]]],
    ["a part of a camera Frigate does not have", [["camera_zone", "cam9/till"]]],
  ] as const)("422 SOURCE_NOT_FOUND for %s — nothing written", async (_n, links) => {
    const before = state();
    const res = await put(links as unknown as Array<[string, string]>);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("SOURCE_NOT_FOUND");
    expect(state()).toEqual(before);
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("Frigate unreachable: a new part → 503 SOURCE_CHECK_UNAVAILABLE; a new camera row still links", async () => {
    frigate.mockRejectedValue(new Error("timeout"));
    const part = await put([["camera_zone", "back/door"]]);
    expect([part.status, part.body.error.code]).toEqual([503, "SOURCE_CHECK_UNAVAILABLE"]);
    const cam = await put([["camera", "side"]]);
    expect(cam.status).toBe(200);
  });

  it("the CAS is taken first: losing it to a concurrent write → 409, nothing written, no audit", async () => {
    db.beforeCas = () => {
      concurrentBump(SHOP);
      db.beforeCas = null;
    };
    const before = db.links.map(clone);
    const res = await put([["camera", "side"]]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VERSION_CONFLICT");
    expect(db.links).toEqual(before);
    expect(h.recordActivityInTx).not.toHaveBeenCalled();
  });

  it("a failed audit append → 503 AUDIT_UNAVAILABLE, links and version unchanged", async () => {
    h.recordActivityInTx.mockRejectedValueOnce(new Error("chain lock timeout"));
    const before = state();
    const res = await put([["camera", "side"]]);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(state()).toEqual(before);
  });

  it("stale form, removed area, unknown area", async () => {
    expect((await put([["camera", "side"]], 2)).body.error.code).toBe("VERSION_CONFLICT");
    expect((await put([["camera", "side"]], 5, OLD)).body.error.code).toBe("ZONE_ARCHIVED");
    expect((await put([["camera", "side"]], 0, GONE)).status).toBe(404);
  });

  it("400 on a malformed ref or more than 32 distinct links", async () => {
    expect((await put([["camera", "back/till"]])).status).toBe(400);
    expect((await put([["camera_zone", "back"]])).status).toBe(400);
    const many = Array.from({ length: 33 }, (_, i) => ["camera", `cam${i}`] as [string, string]);
    expect((await put(many)).status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // Spec §7 route 12: AT MOST 32 — exactly 32 is a save, and duplicates collapse before the count.
  it.each([
    ["exactly 32 distinct links", 32, 0],
    ["33 entries that are 32 distinct links", 32, 1],
  ])("%s → 200, saved", async (_n, distinct, dupes) => {
    frigate.mockResolvedValue({ cameras: Object.fromEntries(Array.from({ length: distinct }, (_, i) => [`cam${i}`, {}])) });
    const links = Array.from({ length: distinct }, (_, i) => ["camera", `cam${i}`] as [string, string]);
    for (let i = 0; i < dupes; i++) links.push(["camera", "cam0"]);
    const res = await put(links);
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
