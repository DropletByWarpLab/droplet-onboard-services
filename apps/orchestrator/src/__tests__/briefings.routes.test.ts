/**
 * WARP-2270 — /api/briefings/*: role floor, self-only isolation, the 202/429
 * rewrite matrix, idempotent read, and the per-user Redis cache.
 *
 * Prisma is an in-memory fake that RECORDS every `where` it is handed, so the
 * isolation test can assert that no query in routes/briefings.ts ever runs
 * unscoped — not just that the right rows come back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

const cache = new Map<string, unknown>();
const cacheSet = vi.fn(async (k: string, v: unknown, _ttl?: number) => void cache.set(k, v));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (k: string) => cache.get(k) ?? null),
  cacheSet: (k: string, v: unknown, ttl?: number) => cacheSet(k, v, ttl),
  cacheDel: vi.fn(async (k: string) => void cache.delete(k)),
}));
const recordActivity = vi.fn(async (_p: unknown) => null);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (p: unknown) => recordActivity(p),
}));

import {
  briefingCacheKey,
  briefingToday,
  createBriefingsRouter,
  invalidateBriefingCache,
  BRIEFING_CACHE_TTL_SECONDS,
} from "../routes/briefings.js";

type Row = {
  id: string;
  userId: string;
  forDate: Date;
  status: string;
  skipReason: string | null;
  failureReason: string | null;
  headline: string | null;
  vibe: string | null;
  body: unknown;
  sources: unknown;
  model: string | null;
  iterations: number | null;
  artKind: string;
  photoStatus: string;
  photoRef: string | null;
  triggeredBy: string;
  startedAt: Date | null;
  endedAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const TZ = "UTC";
const today = () => new Date().toISOString().slice(0, 10);
const todayCol = () => new Date(`${today()}T00:00:00.000Z`);

function row(over: Partial<Row>): Row {
  return {
    id: "b-" + Math.random().toString(36).slice(2),
    userId: "u-alice",
    forDate: todayCol(),
    status: "ready",
    skipReason: null,
    failureReason: null,
    headline: "Three invoices are overdue",
    vibe: "busy",
    body: { summary: "x" },
    sources: ["email_inbox_overview"],
    model: "gpt-oss:20b",
    iterations: 4,
    artKind: "ascii",
    photoStatus: "none",
    photoRef: null,
    triggeredBy: "scheduler",
    startedAt: null,
    endedAt: null,
    readAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function matches(r: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "userId_forDate") {
      const c = v as { userId: string; forDate: Date };
      if (r.userId !== c.userId || r.forDate.getTime() !== c.forDate.getTime()) return false;
    } else if (v && typeof v === "object" && "in" in (v as object)) {
      if (!(v as { in: unknown[] }).in.includes(r[k as keyof Row])) return false;
    } else if (v instanceof Date) {
      if ((r[k as keyof Row] as Date | null)?.getTime() !== v.getTime()) return false;
    } else if (r[k as keyof Row] !== v) return false;
  }
  return true;
}

function fakePrisma(rows: Row[]) {
  const wheres: Array<Record<string, unknown>> = [];
  const seen = (w: Record<string, unknown>) => (wheres.push(w), w);
  const mb = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => matches(r, seen(where))) ?? null,
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => matches(r, seen(where))) ?? null,
    ),
    findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
      rows
        .filter((r) => matches(r, seen(where)))
        .sort((a, b) => b.forDate.getTime() - a.forDate.getTime())
        .slice(0, take),
    ),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((r) => matches(r, seen(where))).length,
    ),
    upsert: vi.fn(async ({ where, create }: { where: Record<string, unknown>; create: Partial<Row> }) => {
      const hit = rows.find((r) => matches(r, seen(where)));
      if (hit) return hit;
      const r = row({ ...create, headline: null, vibe: null, body: null, sources: null });
      rows.push(r);
      return r;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, seen(where)));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
  };
  return {
    prisma: { morningBriefing: mb, workspace: { findUnique: vi.fn(async () => ({ tz: TZ })) } },
    wheres,
  };
}

function app(prisma: unknown, user: { id: string; role: string } | null) {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as unknown as { user: typeof user }).user = user;
    next();
  });
  a.use("/api", createBriefingsRouter(prisma as import("@prisma/client").PrismaClient));
  return a;
}

const alice = { id: "u-alice", role: "family" };
const bob = { id: "u-bob", role: "admin" };

beforeEach(() => {
  cache.clear();
  vi.clearAllMocks();
});

describe("WARP-2270 — role floor", () => {
  const routes: Array<["get" | "post", string]> = [
    ["get", "/api/briefings/today"],
    ["get", "/api/briefings"],
    ["get", "/api/briefings/unread-count"],
    ["post", "/api/briefings/x/read"],
    ["post", "/api/briefings/today/run"],
  ];
  it.each(routes)("%s %s → 403 for guest and for no session", async (m, path) => {
    const { prisma } = fakePrisma([row({})]);
    expect((await request(app(prisma, { id: "g", role: "guest" }))[m](path)).status).toBe(403);
    expect((await request(app(prisma, null))[m](path)).status).toBe(403);
    expect(prisma.morningBriefing.findUnique).not.toHaveBeenCalled();
  });
});

describe("WARP-2270 — GET /today", () => {
  it("404 no_briefing_today when the caller has no row today", async () => {
    const { prisma } = fakePrisma([row({ userId: "u-bob" })]);
    const res = await request(app(prisma, alice)).get("/api/briefings/today");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "no_briefing_today" });
  });

  it("returns the row without userId, forDate as YYYY-MM-DD", async () => {
    const { prisma } = fakePrisma([row({ id: "a1" })]);
    const res = await request(app(prisma, alice)).get("/api/briefings/today");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("a1");
    expect(res.body.forDate).toBe(today());
    expect(res.body).not.toHaveProperty("userId");
  });

  it("caches a settled row under briefing:<user>:<date> for 300 s", async () => {
    const { prisma } = fakePrisma([row({ id: "a1" })]);
    await request(app(prisma, alice)).get("/api/briefings/today");
    expect(cacheSet).toHaveBeenCalledWith(`briefing:u-alice:${today()}`, expect.anything(), 300);
    await request(app(prisma, alice)).get("/api/briefings/today");
    expect(prisma.morningBriefing.findUnique).toHaveBeenCalledTimes(1);
  });

  it("never caches an in-flight row (the tile polls it)", async () => {
    const { prisma } = fakePrisma([row({ status: "running" })]);
    await request(app(prisma, alice)).get("/api/briefings/today");
    expect(cacheSet).not.toHaveBeenCalled();
  });
});

describe("WARP-2270 — unread-count", () => {
  it.each([
    ["ready", null, 1],
    ["ready", new Date(), 0],
    ["pending", null, 0],
    ["running", null, 0],
    ["failed", null, 0],
    ["skipped", null, 0],
  ])("status=%s readAt=%s → %i", async (status, readAt, total) => {
    const { prisma } = fakePrisma([row({ status, readAt })]);
    const res = await request(app(prisma, alice)).get("/api/briefings/unread-count");
    expect(res.body).toEqual({ total });
  });

  it("drops to 0 after POST /read", async () => {
    const { prisma } = fakePrisma([row({ id: "a1" })]);
    const a = app(prisma, alice);
    expect((await request(a).get("/api/briefings/unread-count")).body.total).toBe(1);
    await request(a).post("/api/briefings/a1/read");
    expect((await request(a).get("/api/briefings/unread-count")).body.total).toBe(0);
  });
});

describe("WARP-2270 — POST /:id/read", () => {
  it("is idempotent — the second call returns the original readAt", async () => {
    const { prisma } = fakePrisma([row({ id: "a1" })]);
    const a = app(prisma, alice);
    const first = await request(a).post("/api/briefings/a1/read");
    const second = await request(a).post("/api/briefings/a1/read");
    expect(first.status).toBe(200);
    expect(second.body.readAt).toBe(first.body.readAt);
  });

  it("invalidates the cache key", async () => {
    const { prisma } = fakePrisma([row({ id: "a1" })]);
    const a = app(prisma, alice);
    await request(a).get("/api/briefings/today");
    expect(cache.has(briefingCacheKey("u-alice", today()))).toBe(true);
    await request(a).post("/api/briefings/a1/read");
    expect(cache.has(briefingCacheKey("u-alice", today()))).toBe(false);
  });
});

describe("WARP-2270 — POST /today/run", () => {
  it("no row → 202 pending, triggeredBy user, one audit row", async () => {
    const rows: Row[] = [];
    const { prisma } = fakePrisma(rows);
    const res = await request(app(prisma, alice)).post("/api/briefings/today/run");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ briefingId: rows[0].id, status: "pending" });
    expect(rows[0]).toMatchObject({ userId: "u-alice", status: "pending", triggeredBy: "user" });
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0][0]).toMatchObject({
      kind: "tool_run",
      actor: { type: "user", id: "u-alice" },
      refs: { briefingId: rows[0].id, action: "rewrite_requested" },
    });
  });

  it("running → 429 briefing_run_in_progress", async () => {
    const { prisma } = fakePrisma([row({ status: "running" })]);
    const res = await request(app(prisma, alice)).post("/api/briefings/today/run");
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "briefing_run_in_progress" });
  });

  it("ended < 10 min ago → 429 briefing_run_too_soon with retryAfterSec", async () => {
    const { prisma } = fakePrisma([row({ endedAt: new Date(Date.now() - 4 * 60_000) })]);
    const res = await request(app(prisma, alice)).post("/api/briefings/today/run");
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("briefing_run_too_soon");
    expect(res.body.retryAfterSec).toBeGreaterThan(5 * 60);
    expect(res.body.retryAfterSec).toBeLessThanOrEqual(6 * 60);
  });

  it("failed and older than 10 min → reset to pending, reasons and readAt cleared", async () => {
    const r = row({
      status: "failed",
      failureReason: "invalid_output",
      readAt: new Date(),
      endedAt: new Date(Date.now() - 30 * 60_000),
    });
    const { prisma } = fakePrisma([r]);
    const res = await request(app(prisma, alice)).post("/api/briefings/today/run");
    expect(res.status).toBe(202);
    expect(r).toMatchObject({ status: "pending", failureReason: null, readAt: null, triggeredBy: "user" });
  });

  it("already pending → 202 with the same row, no reset", async () => {
    const r = row({ status: "pending", id: "p1" });
    const { prisma } = fakePrisma([r]);
    const res = await request(app(prisma, alice)).post("/api/briefings/today/run");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ briefingId: "p1", status: "pending" });
    expect(prisma.morningBriefing.updateMany).not.toHaveBeenCalled();
  });
});

describe("WARP-2270 — self-only isolation (two users)", () => {
  function seed() {
    return [
      row({ id: "alice-today", userId: "u-alice" }),
      row({ id: "bob-today", userId: "u-bob", status: "running" }),
      row({ id: "bob-old", userId: "u-bob", forDate: new Date("2026-01-01T00:00:00.000Z") }),
    ];
  }

  it("every query carries the caller's userId", async () => {
    const rows = seed();
    const { prisma, wheres } = fakePrisma(rows);
    const a = app(prisma, alice);
    await request(a).get("/api/briefings/today");
    await request(a).get("/api/briefings?limit=50");
    await request(a).get("/api/briefings/unread-count");
    await request(a).post("/api/briefings/bob-today/read");
    await request(a).post("/api/briefings/alice-today/read");
    await request(a).post("/api/briefings/today/run");
    expect(wheres.length).toBeGreaterThan(0);
    for (const w of wheres) {
      const uid = (w.userId ?? (w.userId_forDate as { userId?: string } | undefined)?.userId) as string;
      expect(uid).toBe("u-alice");
    }
  });

  it("GET /today and history never return the other user's rows", async () => {
    const { prisma } = fakePrisma(seed());
    const today1 = await request(app(prisma, alice)).get("/api/briefings/today");
    expect(today1.body.id).toBe("alice-today");
    const hist = await request(app(prisma, alice)).get("/api/briefings");
    expect(hist.body.items.map((i: { id: string }) => i.id)).toEqual(["alice-today"]);
    for (const i of hist.body.items) expect(i).not.toHaveProperty("userId");
  });

  it("marking another user's briefing read is a 404 and changes nothing", async () => {
    const rows = seed();
    const { prisma } = fakePrisma(rows);
    const res = await request(app(prisma, alice)).post("/api/briefings/bob-today/read");
    expect(res.status).toBe(404);
    expect(rows.find((r) => r.id === "bob-today")!.readAt).toBeNull();
  });

  it("a run request only ever touches the caller's own row", async () => {
    const rows = seed();
    const { prisma } = fakePrisma(rows);
    // Bob's row is running; Alice's is ready and old enough — her request must
    // neither 429 on Bob's state nor reset Bob's row.
    rows[0].endedAt = new Date(Date.now() - 60 * 60_000);
    const res = await request(app(prisma, alice)).post("/api/briefings/today/run");
    expect(res.status).toBe(202);
    expect(res.body.briefingId).toBe("alice-today");
    expect(rows.find((r) => r.id === "bob-today")!.status).toBe("running");
  });

  it("the cache key is per user — Bob never gets Alice's cached row", async () => {
    const { prisma } = fakePrisma(seed());
    await request(app(prisma, alice)).get("/api/briefings/today");
    const res = await request(app(prisma, bob)).get("/api/briefings/today");
    expect(res.body.id).toBe("bob-today");
  });
});

describe("WARP-2270 — history limit and helpers", () => {
  it("clamps limit to 30", async () => {
    const { prisma } = fakePrisma([]);
    await request(app(prisma, alice)).get("/api/briefings?limit=500");
    expect(prisma.morningBriefing.findMany.mock.calls[0][0].take).toBe(30);
  });

  it("invalidateBriefingCache deletes the key; TTL is 300", async () => {
    cache.set(briefingCacheKey("u", "2026-09-22"), { id: "x" });
    await invalidateBriefingCache("u", "2026-09-22");
    expect(cache.size).toBe(0);
    expect(BRIEFING_CACHE_TTL_SECONDS).toBe(300);
  });

  it("briefingToday uses Workspace.tz, falls back past an invalid zone", async () => {
    const at = new Date("2026-09-22T03:00:00.000Z"); // 20:00 on the 21st in LA
    const ws = (tz: string | null) =>
      ({ workspace: { findUnique: async () => ({ tz }) } }) as unknown as import("@prisma/client").PrismaClient;
    expect(await briefingToday(ws("America/Los_Angeles"), at)).toBe("2026-09-21");
    expect(await briefingToday(ws("Europe/Paris"), at)).toBe("2026-09-22");
    expect(await briefingToday(ws("Not/AZone"), at)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
