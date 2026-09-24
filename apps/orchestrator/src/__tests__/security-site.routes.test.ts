/**
 * WARP-2977 P2b — routes/security-site.ts (spec §7 routes 5, 6, 7, 13, 14, 15).
 *
 * The REAL router, the real `requireRole`, the real `requireFeatureAccess`
 * with the §9 resolver injected through `deps.resolve` (the
 * feature-gate.test.ts fixture shape), the real service over the in-memory
 * fake (src/__tests__/security-site.fake.ts) and the real audit helpers —
 * only the chain append itself is mocked.
 *
 * Level pins, for EVERY write route (spec §9):
 *   (a) exactly at the level → the exact 2xx and the exact audit call;
 *   (b) one level below (act: family at view; manage: admin narrowed to act)
 *       → 404 module_disabled, nothing written, nothing audited;
 *   (c) the requireRole floor (manage: family whose resolver says manage;
 *       act: a guest or a role-less session) → 403, resolver never asked;
 *   (d) owner → 2xx.
 * Every 2xx/404 case asserts the resolver was asked about THIS user, so a 404
 * can never pass vacuously. Every GET answers family-at-view with 200 and
 * never consults the resolver (no GET is gated above view; the module-wide
 * view gate is mountModuleGates', pinned in security-prefix-composition).
 *
 * `sensitiveRateLimit` is swapped for a marked pass-through (one file of
 * writes would exhaust its 60/min bucket); a stack pin below proves every
 * write route still carries it, first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";

const h = vi.hoisted(() => {
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { inTx: vi.fn(), record: vi.fn(), limiter: passThrough };
});

vi.mock("../middleware/rate-limit.js", async (orig) => ({
  ...(await orig<typeof import("../middleware/rate-limit.js")>()),
  sensitiveRateLimit: h.limiter,
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
  recordActivityInTx: (...args: unknown[]) => h.inTx(...args),
  getActivityRecorder: () => ({ record: h.record }),
}));

import { createSecuritySiteRouter } from "../routes/security-site.js";
import { readFeatureGateMeta } from "../middleware/feature-gate.js";
import { isRoleGuard } from "../middleware/auth.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { _resetSiteModeHealthForTests } from "../services/security-mode.service.js";
import { zonedWallClockToUtc } from "../lib/zoned-time.js";
import { defaultHours, defaultMode, fakePrisma, newWorld, weekRows, type FakeWorld } from "./security-site.fake.js";

type Role = "owner" | "admin" | "family" | "guest";
type Level = "view" | "act" | "manage";

const TZ = "Europe/London";
const USER_ID = "33333333-3333-4333-8333-333333333333";

function at(ymd: string, time: string, tz = TZ): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [hh, mi] = time.split(":").map(Number);
  return zonedWallClockToUtc(y!, mo!, d!, hh!, mi!, 0, tz);
}
const NOW = at("2026-09-23", "12:00"); // a Wednesday, inside 09–17

function access(level: Level | null, tier: EffectiveAccessResult["tier"] = "family", devices = false): EffectiveAccessResult {
  return {
    tier,
    features: [
      ...(level ? [{ moduleId: "security", level }] : []),
      // WARP-2977 P2b-2 (DS-019): Devices (smart_home) view — who may read door locks.
      ...(devices ? [{ moduleId: "smart_home", level: "view" }] : []),
    ] as EffectiveAccessResult["features"],
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

function seeded(over: Partial<FakeWorld> = {}): FakeWorld {
  return newWorld({
    hours: defaultHours({ state: "set", timezone: TZ, version: 3 }),
    mode: defaultMode({ setAt: at("2026-09-23", "09:00") }),
    days: weekRows(["09:00-17:00", "09:00-17:00", "09:00-17:00", "09:00-17:00", "09:00-17:00", "closed", "closed"]),
    exceptions: [
      { date: "2026-12-25", kind: "closed", opensMin: null, closesMin: null, note: "", createdById: null, createdAt: NOW, updatedAt: NOW },
    ],
    ...over,
  });
}

/** WARP-2977 P2b-2 — a lock adapter as route 7 reads it: the last sweep's locks and their readings. */
type KnownLockFixture = { ref: string; nodeId: string; endpointId: number; name: string; room: string | null; connected: boolean; reading: string | null; polled: boolean };
const lock = (nodeId: string, name: string, reading: string | null, connected = true): KnownLockFixture => ({
  ref: `matter:${nodeId}/1`,
  nodeId,
  endpointId: 1,
  name,
  room: null,
  connected,
  reading,
  polled: true,
});

function app(
  w: FakeWorld,
  role: Role | null | "",
  level: Level | null,
  now: Date = NOW,
  opts: { devices?: boolean; locks?: KnownLockFixture[] | null } = {},
) {
  const resolve = vi.fn(async (_userId: string) => access(level, role === "owner" ? "owner" : "family", opts.devices === true));
  const prisma = fakePrisma(w);
  const knownLocks = vi.fn(() => opts.locks ?? []);
  const reader = opts.locks === null ? null : { knownLocks, listLocks: vi.fn(), health: vi.fn() };
  const server = express();
  server.use(express.json());
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (role !== null) {
      // A role-less session ("") is the requireRole floor case; the cast is the point.
      (req as unknown as { user?: unknown }).user = { id: USER_ID, username: "sam", displayName: "Sam", role };
    }
    next();
  });
  server.use(
    "/api",
    createSecuritySiteRouter(prisma as unknown as PrismaClient, { resolve, now: () => now, locks: () => reader as never }),
  );
  return { server, resolve, prisma, knownLocks };
}

const HOURS_BODY = {
  state: "set",
  timezone: TZ,
  days: [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
    weekday <= 5 ? { weekday, kind: "hours", opens: "08:00", closes: "18:00" } : { weekday, kind: "closed" },
  ),
  expectedVersion: 3,
};

interface WriteRoute {
  name: string;
  level: "act" | "manage";
  status: number;
  send: (s: express.Express) => request.Test;
  action: string;
}

const WRITES: WriteRoute[] = [
  {
    name: "POST /api/security/mode",
    level: "act",
    status: 200,
    send: (s) => request(s).post("/api/security/mode").send({ action: "close" }),
    action: "mode.close",
  },
  {
    name: "PUT /api/security/hours",
    level: "manage",
    status: 200,
    send: (s) => request(s).put("/api/security/hours").send(HOURS_BODY),
    action: "hours.set",
  },
  {
    name: "PUT /api/security/hours/exceptions/:date",
    level: "manage",
    status: 200,
    send: (s) => request(s).put("/api/security/hours/exceptions/2026-12-24").send({ kind: "closed", note: "Christmas Eve", expectedVersion: 3 }),
    action: "exception.set",
  },
  {
    name: "DELETE /api/security/hours/exceptions/:date",
    level: "manage",
    status: 204,
    send: (s) => request(s).delete("/api/security/hours/exceptions/2026-12-25?version=3"),
    action: "exception.delete",
  },
];

const BELOW: Record<"act" | "manage", { role: Role; level: Level }> = {
  act: { role: "family", level: "view" },
  manage: { role: "admin", level: "act" },
};

beforeEach(() => {
  _resetSiteModeHealthForTests();
  h.inTx.mockReset().mockResolvedValue({ id: 1n });
  h.record.mockReset().mockResolvedValue({ id: 2n });
});

describe.each(WRITES)("$name — level pins ($level)", (route) => {
  const atLevel: Role = route.level === "act" ? "family" : "admin";

  it(`(a) ${atLevel} at ${route.level} → ${route.status}, one audit row of the fixed shape`, async () => {
    const w = seeded();
    const { server, resolve } = app(w, atLevel, route.level);
    const res = await route.send(server);
    expect(res.status).toBe(route.status);
    expect(resolve).toHaveBeenCalledWith(USER_ID);
    expect(h.inTx).toHaveBeenCalledTimes(1);
    const params = h.inTx.mock.calls[0]![1];
    expect(params).toMatchObject({
      kind: "system",
      severity: "info",
      sourceIcon: "shield",
      actor: { type: "user", id: USER_ID },
      refs: { surface: "security", action: route.action },
    });
    expect(params.what).toMatch(/^Security: /);
  });

  it(`(b) one level below (${BELOW[route.level].role} at ${BELOW[route.level].level}) → 404 module_disabled, nothing written`, async () => {
    const w = seeded();
    const before = structuredClone({ hours: w.hours, mode: w.mode, days: w.days, exceptions: w.exceptions });
    const { server, resolve, prisma } = app(w, BELOW[route.level].role, BELOW[route.level].level);
    const res = await route.send(server);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "security" });
    expect(resolve).toHaveBeenCalledWith(USER_ID);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(h.inTx).not.toHaveBeenCalled();
    expect({ hours: w.hours, mode: w.mode, days: w.days, exceptions: w.exceptions }).toEqual(before);
  });

  const floor: Array<[string, Role | ""]> =
    route.level === "manage" ? [["family whose resolver says manage", "family"]] : [["a guest", "guest"], ["a role-less session", ""]];
  it.each(floor)("(c) the requireRole floor: %s → 403, the resolver is never asked", async (_l, role) => {
    const w = seeded();
    const { server, resolve, prisma } = app(w, role, "manage");
    const res = await route.send(server);
    expect(res.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it(`(d) owner → ${route.status}`, async () => {
    const w = seeded();
    const { server, resolve } = app(w, "owner", "manage");
    const res = await route.send(server);
    expect(res.status).toBe(route.status);
    expect(resolve).toHaveBeenCalledWith(USER_ID);
    expect(h.inTx).toHaveBeenCalledTimes(1);
  });
});

describe("GETs are view-only", () => {
  it.each(["/api/security/mode", "/api/security/hours"])("family at view → 200 on %s, resolver not consulted", async (path) => {
    const { server, resolve } = app(seeded(), "family", "view");
    const res = await request(server).get(path);
    expect(res.status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["/api/security/mode", "/api/security/hours"])("guest → 403 on %s", async (path) => {
    expect((await request(app(seeded(), "guest", "manage").server).get(path)).status).toBe(403);
  });
});

describe("router stack", () => {
  const router = createSecuritySiteRouter({} as PrismaClient, {});
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  const routes = (router as unknown as { stack: Layer[] }).stack
    .filter((l) => l.route)
    .map((l) => ({
      key: `${Object.keys(l.route!.methods)[0]!.toUpperCase()} ${l.route!.path}`,
      handles: l.route!.stack.map((s) => s.handle),
    }));

  it("exactly the six §7 routes, each write rate-limited FIRST, role-guarded, then gated at its level", () => {
    expect(routes.map((r) => r.key)).toEqual([
      "GET /security/mode",
      "GET /security/hours",
      "POST /security/mode",
      "PUT /security/hours",
      "PUT /security/hours/exceptions/:date",
      "DELETE /security/hours/exceptions/:date",
    ]);
    const levels = Object.fromEntries(routes.map((r) => [r.key, r.handles.map(readFeatureGateMeta).find(Boolean)?.level ?? null]));
    expect(levels).toEqual({
      "GET /security/mode": null,
      "GET /security/hours": null,
      "POST /security/mode": "act",
      "PUT /security/hours": "manage",
      "PUT /security/hours/exceptions/:date": "manage",
      "DELETE /security/hours/exceptions/:date": "manage",
    });
    for (const r of routes) {
      const gate = r.handles.findIndex((fn) => readFeatureGateMeta(fn) !== null);
      const guard = r.handles.findIndex(isRoleGuard);
      expect(guard, r.key).toBeGreaterThanOrEqual(0);
      if (r.key.startsWith("GET")) continue;
      expect(r.handles[0], r.key).toBe(h.limiter);
      expect(guard, r.key).toBeLessThan(gate);
    }
  });
});

// ── route 5 / 6 ───────────────────────────────────────────────────────────

describe("GET /api/security/mode", () => {
  it("the EFFECTIVE mode with its site zone", async () => {
    const res = await request(app(seeded(), "family", "view", at("2026-09-23", "18:00")).server).get("/api/security/mode");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "closed",
      source: "schedule",
      hours: { state: "set", timezone: TZ, scheduledMode: "closed", upcoming: { at: at("2026-09-24", "09:00").toISOString(), mode: "open" } },
      displayTimezone: TZ,
      stale: true,
    });
  });

  it("an outage → 503 MODE_UNAVAILABLE, never a fake open", async () => {
    const { server, prisma } = app(seeded(), "family", "view");
    prisma.securityModeState.findUnique.mockRejectedValueOnce(new Error("db down"));
    const res = await request(server).get("/api/security/mode");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: "MODE_UNAVAILABLE", message: expect.any(String) } });
  });
});

describe("GET /api/security/hours", () => {
  it("the week, the special days, the preview and the hint", async () => {
    const res = await request(app(seeded({ workspaceTz: "Europe/Paris" }), "family", "view").server).get("/api/security/hours");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "set", timezone: TZ, version: 3, hint: { workspaceTimezone: "Europe/Paris", typicalDay: "" } });
    expect(res.body.days).toHaveLength(7);
    expect(res.body.exceptions).toEqual([{ date: "2026-12-25", kind: "closed", opens: null, closes: null, note: "" }]);
  });

  // The business profile's own §15 ladder: owner/admin see its structured fields, family the summary only.
  it.each([
    ["family", "view", ""],
    ["family", "act", ""],
    ["admin", "view", "SENTINEL: opens alone at 5am"],
    ["owner", "manage", "SENTINEL: opens alone at 5am"],
  ] as const)("the typical-day hint follows the business-profile ladder: %s at %s", async (role, level, typicalDay) => {
    const w = seeded({ typicalDay: "SENTINEL: opens alone at 5am" });
    const res = await request(app(w, role, level).server).get("/api/security/hours");
    expect(res.status).toBe(200);
    expect(res.body.hint.typicalDay).toBe(typicalDay);
  });

  it("a manage write's answer carries the typical day for the admin who made it", async () => {
    const res = await request(app(seeded({ typicalDay: "SENTINEL" }), "admin", "manage").server).put("/api/security/hours").send(HOURS_BODY);
    expect(res.status).toBe(200);
    expect(res.body.hours.hint.typicalDay).toBe("SENTINEL");
  });

  it("an outage → 503 HOURS_UNAVAILABLE", async () => {
    const { server, prisma } = app(seeded(), "family", "view");
    prisma.securitySiteHours.findUnique.mockRejectedValueOnce(new Error("db down"));
    const res = await request(server).get("/api/security/hours");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("HOURS_UNAVAILABLE");
  });
});

// ── route 7 ───────────────────────────────────────────────────────────────

describe("POST /api/security/mode", () => {
  it("Close up → 200 {mode, changed:true}; again → changed:false and no second audit", async () => {
    const w = seeded();
    const { server } = app(w, "family", "act");
    const first = await request(server).post("/api/security/mode").send({ action: "close" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ changed: true, mode: { mode: "closed", source: "manual", manualEnd: "next_opening", setBy: { id: USER_ID, name: "Sam" } } });
    expect(w.events).toEqual([expect.objectContaining({ summary: "Closed up by Sam" })]);
    const again = await request(server).post("/api/security/mode").send({ action: "close" });
    expect(again.body).toMatchObject({ changed: false, mode: { mode: "closed" } });
    expect(h.inTx).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}],
    [{ action: "arm" }],
    [{ action: "open" }],
    [{ action: "open", for: "3h" }],
    [{ action: "close", until: "2026-09-24T09:00:00Z" }],
  ])("a malformed intent %j → 400 VALIDATION_ERROR", async (body) => {
    const res = await request(app(seeded(), "family", "act").server).post("/api/security/mode").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("two lost races → 409 MODE_CONFLICT, nothing audited", async () => {
    const { server, prisma } = app(seeded(), "family", "act");
    prisma.securityModeState.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(server).post("/api/security/mode").send({ action: "away" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MODE_CONFLICT");
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("the audit cannot be written → 503 AUDIT_UNAVAILABLE and the mode is unchanged", async () => {
    const w = seeded();
    h.inTx.mockRejectedValueOnce(new Error("chain down"));
    const res = await request(app(w, "family", "act").server).post("/api/security/mode").send({ action: "away" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: "AUDIT_UNAVAILABLE", message: expect.any(String) } });
    expect(w.mode).toMatchObject({ mode: "open", modeSource: "schedule", version: 0 });
    expect(w.events).toEqual([]);
  });

  it("the transaction expired waiting for the chain lock (P2028) → 503 AUDIT_UNAVAILABLE", async () => {
    const { server, prisma } = app(seeded(), "family", "act");
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("Transaction already closed"), { code: "P2028" }));
    const res = await request(server).post("/api/security/mode").send({ action: "away" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUDIT_UNAVAILABLE");
  });

  it("any other failure → 503 MODE_UNAVAILABLE", async () => {
    const { server, prisma } = app(seeded(), "family", "act");
    prisma.securityModeState.findUnique.mockRejectedValueOnce(new Error("db down"));
    const res = await request(server).post("/api/security/mode").send({ action: "away" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("MODE_UNAVAILABLE");
  });
});

// WARP-2977 P2b-2 (spec §7 route 7, DS-019): a Close up or Away answer names
// the door locks still reported open — for someone who may read locks — and
// never claims the rest are locked.
describe("POST /api/security/mode — unlockedLocks", () => {
  const LOCKS = [
    lock("1", "Side gate", "unlatched"),
    lock("2", "Front door lock", "locked"),
    lock("3", "Back door lock", "unlocked"),
    lock("4", "Cellar", "unknown"),
    lock("5", "Garage", "unlocked", false),
    lock("6", "Annex", null),
  ];

  it.each(["close", "away"] as const)("%s, with Devices view: the connected locks last heard open, by name, sorted", async (action) => {
    const { server, resolve } = app(seeded(), "family", "act", NOW, { devices: true, locks: LOCKS });
    const res = await request(server).post("/api/security/mode").send({ action });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.unlockedLocks).toEqual(["Back door lock", "Side gate"]);
    expect(resolve).toHaveBeenCalledWith(USER_ID);
  });

  it("…also on a changed:false answer (already closed) — the doors are still worth naming", async () => {
    const { server } = app(seeded(), "family", "act", NOW, { devices: true, locks: LOCKS });
    await request(server).post("/api/security/mode").send({ action: "close" });
    const again = await request(server).post("/api/security/mode").send({ action: "close" });
    expect(again.body).toMatchObject({ changed: false, unlockedLocks: ["Back door lock", "Side gate"] });
  });

  it("without Devices view the field is ABSENT — not even an empty list says a lock exists", async () => {
    const { server, knownLocks } = app(seeded(), "family", "act", NOW, { devices: false, locks: LOCKS });
    const res = await request(server).post("/api/security/mode").send({ action: "close" });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("unlockedLocks");
    expect(knownLocks).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: "resume" }],
    [{ action: "open", for: "2h" }],
  ])("%j carries no unlockedLocks, even with Devices view", async (body) => {
    const w = seeded({ mode: defaultMode({ mode: "away", modeSource: "manual", manualEnd: "until_changed", setAt: at("2026-09-23", "09:00") }) });
    const res = await request(app(w, "family", "act", NOW, { devices: true, locks: LOCKS }).server)
      .post("/api/security/mode")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("unlockedLocks");
  });

  it("no lock adapter running → an empty list (nothing known to be open), never an error after the change committed", async () => {
    const w = seeded();
    const res = await request(app(w, "family", "act", NOW, { devices: true, locks: null }).server)
      .post("/api/security/mode")
      .send({ action: "close" });
    expect(res.status).toBe(200);
    expect(res.body.unlockedLocks).toEqual([]);
    expect(w.mode).toMatchObject({ mode: "closed", modeSource: "manual" });
  });

  it("a lock reader that throws AFTER the commit still answers 200 with the committed mode — every 5xx means nothing changed", async () => {
    const w = seeded();
    const { server, knownLocks } = app(w, "family", "act", NOW, { devices: true, locks: LOCKS });
    knownLocks.mockImplementation(() => {
      throw new Error("adapter state unreadable");
    });
    const res = await request(server).post("/api/security/mode").send({ action: "close" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, unlockedLocks: [] });
    expect(w.mode).toMatchObject({ mode: "closed" });
  });
});

// Spec §6.3's row "open {for} when not_set or S=open → resume to schedule
// when manual, else changed:false; `for` ignored". The /security card (D1)
// relies on it: with nothing to choose it posts {action:'open', for:'2h'}
// straight away, with no dialog. Through the real router, the real service.
describe("POST /api/security/mode — Open up when the site is open by the hours already", () => {
  const AWAY = defaultMode({ mode: "away", modeSource: "manual", manualEnd: "until_changed", setAt: at("2026-09-23", "08:00") });
  const CLOSED_BY_HAND = defaultMode({ mode: "closed", modeSource: "manual", manualEnd: "until_changed", setAt: at("2026-09-23", "08:00") });
  const cases: Array<[string, () => FakeWorld]> = [
    ["no opening hours set, Away", () => newWorld({ mode: structuredClone(AWAY) })],
    ["hours say open right now (Wed 12:00), Away", () => seeded({ mode: structuredClone(AWAY) })],
    ["hours say open right now (Wed 12:00), closed by hand until changed", () => seeded({ mode: structuredClone(CLOSED_BY_HAND) })],
  ];

  describe.each(cases)("%s", (_l, build) => {
    it.each(["1h", "2h", "4h"])("for %s → back to the opening hours (open), no end time — `for` is ignored", async (dur) => {
      const w = build();
      const res = await request(app(w, "family", "act").server).post("/api/security/mode").send({ action: "open", for: dur });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        changed: true,
        mode: { mode: "open", source: "schedule", manualEnd: "none", until: null, setBy: null },
      });
      expect(w.mode).toMatchObject({ mode: "open", modeSource: "schedule", manualEnd: "none", manualUntil: null });
      expect(w.events).toEqual([expect.objectContaining({ summary: "Back to opening hours (Sam)" })]);
      expect(h.inTx).toHaveBeenCalledTimes(1);
      expect(h.inTx.mock.calls[0]![1]).toMatchObject({
        what: "Security: back to opening hours",
        refs: { surface: "security", action: "mode.open", mode: "open", source: "schedule", manualEnd: "none", until: null, for: dur },
      });
    });
  });

  it.each<[string, () => FakeWorld]>([
    ["no opening hours set", () => newWorld()],
    ["hours say open right now", () => seeded()],
  ])("%s, already following them → 200 changed:false, nothing written or audited", async (_l, build) => {
    const w = build();
    const before = structuredClone(w.mode);
    const res = await request(app(w, "family", "act").server).post("/api/security/mode").send({ action: "open", for: "2h" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: false, mode: { mode: "open", source: "schedule", until: null } });
    if (before) expect(w.mode).toEqual(before);
    expect(w.events).toEqual([]);
    expect(h.inTx).not.toHaveBeenCalled();
  });
});

// ── route 13 ──────────────────────────────────────────────────────────────

describe("PUT /api/security/hours", () => {
  const put = (w: FakeWorld, body: object) => request(app(w, "admin", "manage").server).put("/api/security/hours").send(body);
  const withDay = (i: number, day: Record<string, unknown>) => ({ ...HOURS_BODY, days: HOURS_BODY.days.map((d, j) => (j === i ? day : d)) });

  it("200 with both views; the zone is stored canonically", async () => {
    const w = seeded();
    const res = await put(w, { ...HOURS_BODY, timezone: "europe/london" });
    expect(res.status).toBe(200);
    expect(res.body.hours).toMatchObject({ state: "set", timezone: "Europe/London", version: 4 });
    expect(res.body.hours.days[0]).toEqual({ weekday: 1, kind: "hours", opens: "08:00", closes: "18:00" });
    expect(res.body.mode).toMatchObject({ mode: "open", version: 1 });
    expect(w.hours!.timezone).toBe("Europe/London");
  });

  it.each([
    ["six days", { ...HOURS_BODY, days: HOURS_BODY.days.slice(0, 6) }, "VALIDATION_ERROR"],
    ["a repeated weekday", withDay(6, { weekday: 1, kind: "closed" }), "VALIDATION_ERROR"],
    ["times on a closed day", withDay(5, { weekday: 6, kind: "closed", opens: "09:00" }), "VALIDATION_ERROR"],
    ["hours with no closing time", withDay(0, { weekday: 1, kind: "hours", opens: "09:00" }), "VALIDATION_ERROR"],
    ["a malformed time", withDay(0, { weekday: 1, kind: "hours", opens: "9am", closes: "17:00" }), "VALIDATION_ERROR"],
    ["an unknown key", { ...HOURS_BODY, note: "x" }, "VALIDATION_ERROR"],
    ["a server-stamped field", { ...HOURS_BODY, version: 9 }, "VALIDATION_ERROR"],
    ["an unknown zone", { ...HOURS_BODY, timezone: "Mars/Base" }, "INVALID_TIMEZONE"],
    ["a raw offset", { ...HOURS_BODY, timezone: "+01:00" }, "INVALID_TIMEZONE"],
    ["the same open and close", withDay(0, { weekday: 1, kind: "hours", opens: "09:00", closes: "09:00" }), "SAME_OPEN_CLOSE"],
  ])("%s → 400 %s, nothing written", async (_l, body, code) => {
    const w = seeded();
    const res = await put(w, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(w.hours!.version).toBe(3);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("a stale expectedVersion → 409 VERSION_CONFLICT", async () => {
    const res = await put(seeded(), { ...HOURS_BODY, expectedVersion: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VERSION_CONFLICT");
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("clearing the hours → 200, not_set", async () => {
    const res = await put(seeded(), { state: "not_set", expectedVersion: 3 });
    expect(res.status).toBe(200);
    expect(res.body.hours).toMatchObject({ state: "not_set", timezone: null });
    expect(res.body.mode.hours).toEqual({ state: "not_set" });
  });

  // A 5xx on these routes means nothing changed. A committed, audited write whose
  // read-back fails is a SAVE: 200 with null views, never "try again".
  it("committed, but the read-back fails → 200 {hours: null, mode: null}; the new hours and ONE audit stand", async () => {
    const w = seeded();
    const { server, prisma } = app(w, "admin", "manage");
    prisma.businessProfile.findUnique.mockRejectedValueOnce(new Error("connection reset"));
    const res = await request(server).put("/api/security/hours").send(HOURS_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hours: null, mode: null });
    expect(w.hours!.version).toBe(4);
    expect(w.days[0]).toMatchObject({ opensMin: 8 * 60, closesMin: 18 * 60 });
    expect(h.inTx).toHaveBeenCalledTimes(1);
    // The retry the old 503 invited would now be a 409 about the person's own save.
    expect((await request(server).put("/api/security/hours").send(HOURS_BODY)).status).toBe(409);
  });

  it("an audit failure → 503 AUDIT_UNAVAILABLE, the old hours stand", async () => {
    const w = seeded();
    h.inTx.mockRejectedValueOnce(new Error("chain down"));
    const res = await put(w, HOURS_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(w.days[0]).toMatchObject({ opensMin: 540 });
    expect(w.hours!.version).toBe(3);
  });
});

// ── routes 14 / 15 ────────────────────────────────────────────────────────

describe("PUT /api/security/hours/exceptions/:date", () => {
  const put = (w: FakeWorld, date: string, body: object) =>
    request(app(w, "admin", "manage").server).put(`/api/security/hours/exceptions/${date}`).send(body);

  it("200 with both views; the special day shows up", async () => {
    const res = await put(seeded(), "2026-09-26", { kind: "hours", opens: "10:00", closes: "14:00", note: "Open day", expectedVersion: 3 });
    expect(res.status).toBe(200);
    expect(res.body.hours.exceptions).toContainEqual({ date: "2026-09-26", kind: "hours", opens: "10:00", closes: "14:00", note: "Open day" });
    expect(res.body.hours.version).toBe(4);
  });

  it.each([
    ["not a calendar date", "2026-02-30", { kind: "closed", expectedVersion: 3 }, 400, "VALIDATION_ERROR"],
    ["not a date at all", "christmas", { kind: "closed", expectedVersion: 3 }, 400, "VALIDATION_ERROR"],
    ["a note over 80 characters", "2026-12-24", { kind: "closed", note: "x".repeat(81), expectedVersion: 3 }, 400, "VALIDATION_ERROR"],
    ["a NUL in the note", "2026-12-24", { kind: "closed", note: "a\u0000b", expectedVersion: 3 }, 400, "VALIDATION_ERROR"],
    ["a lone surrogate in the note", "2026-12-24", { kind: "closed", note: "a\uD800b", expectedVersion: 3 }, 400, "VALIDATION_ERROR"],
    ["a line break in the note", "2026-12-24", { kind: "closed", note: "a\nb", expectedVersion: 3 }, 400, "VALIDATION_ERROR"],
    ["a right-to-left override in the note", "2026-12-24", { kind: "closed", note: "Holiday\u202E", expectedVersion: 3 }, 400, "VALIDATION_ERROR"],
    ["a bidi isolate in the note", "2026-12-24", { kind: "closed", note: "Holi\u2067day", expectedVersion: 3 }, 400, "VALIDATION_ERROR"],
    ["a C1 control in the note", "2026-12-24", { kind: "closed", note: "Holi\u0085day", expectedVersion: 3 }, 400, "VALIDATION_ERROR"],
    ["a line separator in the note", "2026-12-24", { kind: "closed", note: "Holi\u2028day", expectedVersion: 3 }, 400, "VALIDATION_ERROR"],
    ["equal times", "2026-12-24", { kind: "hours", opens: "10:00", closes: "10:00", expectedVersion: 3 }, 400, "SAME_OPEN_CLOSE"],
    ["two days ago (site-local)", "2026-09-21", { kind: "closed", expectedVersion: 3 }, 422, "EXCEPTION_OUT_OF_RANGE"],
    ["367 days ahead", "2027-09-25", { kind: "closed", expectedVersion: 3 }, 422, "EXCEPTION_OUT_OF_RANGE"],
    ["a stale version", "2026-12-24", { kind: "closed", expectedVersion: 1 }, 409, "VERSION_CONFLICT"],
  ])("%s → %i %s, nothing audited", async (_l, date, body, status, code) => {
    const w = seeded();
    const res = await put(w, date, body);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(h.inTx).not.toHaveBeenCalled();
    expect(w.hours!.version).toBe(3);
  });

  it("committed, but the read-back fails → 200 {hours: null, mode: null}; the special day and ONE audit stand", async () => {
    const w = seeded();
    const { server, prisma } = app(w, "admin", "manage");
    prisma.businessProfile.findUnique.mockRejectedValueOnce(new Error("connection reset"));
    const res = await request(server).put("/api/security/hours/exceptions/2026-12-24").send({ kind: "closed", expectedVersion: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hours: null, mode: null });
    expect(w.hours!.version).toBe(4);
    expect(w.exceptions.map((e) => e.date)).toContain("2026-12-24");
    expect(h.inTx).toHaveBeenCalledTimes(1);
  });

  it("no hours yet → 409 HOURS_NOT_SET", async () => {
    const res = await put(seeded({ hours: defaultHours(), days: [] }), "2026-12-24", { kind: "closed", expectedVersion: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("HOURS_NOT_SET");
  });

  it("100 upcoming special days → 409 EXCEPTION_LIMIT", async () => {
    const exceptions = Array.from({ length: 100 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10),
      kind: "closed" as const,
      opensMin: null,
      closesMin: null,
      note: "",
      createdById: null,
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const res = await put(seeded({ exceptions }), "2026-09-27", { kind: "closed", expectedVersion: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EXCEPTION_LIMIT");
  });
});

describe("DELETE /api/security/hours/exceptions/:date", () => {
  const del = (w: FakeWorld, path: string) => request(app(w, "admin", "manage").server).delete(`/api/security/hours/exceptions/${path}`);

  it("204 and gone", async () => {
    const w = seeded();
    const res = await del(w, "2026-12-25?version=3");
    expect(res.status).toBe(204);
    expect(w.exceptions).toEqual([]);
  });

  it.each([
    ["no version", "2026-12-25", 400, "VALIDATION_ERROR"],
    ["a non-numeric version", "2026-12-25?version=abc", 400, "VALIDATION_ERROR"],
    ["an extra query key", "2026-12-25?version=3&force=1", 400, "VALIDATION_ERROR"],
    ["a bad date", "2026-13-01?version=3", 400, "VALIDATION_ERROR"],
    ["no such day", "2026-12-24?version=3", 404, "EXCEPTION_NOT_FOUND"],
    ["a stale version", "2026-12-25?version=2", 409, "VERSION_CONFLICT"],
  ])("%s → %i %s", async (_l, path, status, code) => {
    const w = seeded();
    const res = await del(w, path);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(w.exceptions).toHaveLength(1);
    expect(h.inTx).not.toHaveBeenCalled();
  });
});

// ── DST, end to end, under two process zones ──────────────────────────────

const ORIGINAL_TZ = process.env.TZ;
const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe.each([
  ["unset", undefined],
  ["Pacific/Kiritimati", "Pacific/Kiritimati"],
])("DST exact instants through the routes — process TZ %s", (_l, zone) => {
  beforeAll(() => {
    if (zone) process.env.TZ = zone;
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ ?? SYSTEM_ZONE;
  });

  const NY = "America/New_York";
  const nyWorld = (days: string[]) =>
    seeded({ hours: defaultHours({ state: "set", timezone: NY, version: 1 }), days: weekRows(days), exceptions: [] });

  it("a Saturday 18:00–01:30 close on NY fall-back night is the FIRST 01:30 (05:30Z)", async () => {
    const w = nyWorld(["closed", "closed", "closed", "closed", "closed", "18:00-01:30", "closed"]);
    const res = await request(app(w, "family", "view", new Date("2026-11-01T00:00:00.000Z")).server).get("/api/security/mode");
    expect(res.body.hours).toMatchObject({ scheduledMode: "open", upcoming: { at: "2026-11-01T05:30:00.000Z", mode: "closed" } });
  });

  it("a Sunday 02:30 opening in NY's spring-forward gap opens at 07:30Z (the pre-gap offset)", async () => {
    const w = nyWorld(["closed", "closed", "closed", "closed", "closed", "closed", "02:30-12:00"]);
    const res = await request(app(w, "family", "view", new Date("2026-03-08T00:00:00.000Z")).server).get("/api/security/hours");
    expect(res.body.preview[0]).toEqual({ startsAt: "2026-03-08T07:30:00.000Z", endsAt: "2026-03-08T16:00:00.000Z" });
  });

  it("Open up 2 h in Berlin's repeated hour is capped by instants, not wall clocks", async () => {
    const w = seeded({
      hours: defaultHours({ state: "set", timezone: "Europe/Berlin", version: 1 }),
      days: weekRows(["closed", "closed", "closed", "closed", "closed", "closed", "03:00-12:00"]),
      exceptions: [],
      mode: defaultMode({ mode: "closed", setAt: new Date("2026-10-24T20:00:00.000Z") }),
    });
    // Sun 2026-10-25 02:30 CEST (00:30Z); the 03:00 CET opening is 02:00Z — 1.5 h later.
    const res = await request(app(w, "family", "act", new Date("2026-10-25T00:30:00.000Z")).server)
      .post("/api/security/mode")
      .send({ action: "open", for: "2h" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toMatchObject({ mode: "open", manualEnd: "at_time", until: "2026-10-25T02:00:00.000Z" });
  });
});
