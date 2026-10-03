/**
 * WARP-2980 (ADR-059 P5 §7 routes 29–31) — GET /api/security/patterns,
 * /patterns/cells and /patterns/explain through the REAL router and the real
 * read service over an in-memory Prisma (security-patterns.fake.ts).
 *
 * Every route is view-level: `requireRole('owner','admin','family')` only —
 * a page load must never produce a denial the threat mirror would turn into
 * a "threat" (pinned by security-level-invariant.test.ts too). The module
 * toggle and the per-person view gate are `mountModuleGates`'s, off
 * /api/security, as for every Security router.
 *
 * DS-005 (§6.13): a family viewer granted camera A only, with area X linking
 * A and B and area Y linking only A — route 29 lists Y's key and not X's;
 * routes 30 and 31 answer X exactly like a random id: the same 404, the same
 * body. Never an empty 200 on an outage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

vi.mock("../config.js", () => ({ config: { AUTH_ENABLED: false } }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn().mockResolvedValue(null) }));

import { createSecurityPatternsRouter } from "../routes/security-patterns.js";
import { cellsFor, newPatternsWorld, patternsPrisma, type PatternsWorld } from "./security-patterns.fake.js";

const TZ = "America/New_York";
const NOW = new Date("2026-09-23T06:14:00Z");
const B = "b-ready";
const A = "front";
const C = "back";
const X = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61"; // A + C
const Y = "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c82"; // A only
const GONE = "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
const Z = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f"; // A + C, and NO cells yet (day 1)

type Role = "owner" | "admin" | "family" | "guest";

let w: PatternsWorld;

function world(): PatternsWorld {
  return newPatternsWorld({
    hours: { state: "set", timezone: TZ },
    cameras: [
      { name: A, displayName: "Front camera" },
      { name: C, displayName: "Back camera" },
    ],
    grants: { "u-family": [A] },
    zones: [
      { id: X, name: "Shop floor", kind: "interior", state: "active", version: 2 },
      { id: Y, name: "Car park", kind: "parking", state: "active", version: 1 },
      { id: Z, name: "Stock room", kind: "restricted", state: "active", version: 1 },
    ],
    links: [
      { id: "l1", zoneId: X, sourceKind: "camera", sourceRef: A, state: "active" },
      { id: "l2", zoneId: X, sourceKind: "camera", sourceRef: C, state: "active" },
      { id: "l3", zoneId: Y, sourceKind: "camera", sourceRef: A, state: "active" },
      { id: "l4", zoneId: Z, sourceKind: "camera", sourceRef: A, state: "active" },
      { id: "l5", zoneId: Z, sourceKind: "camera", sourceRef: C, state: "active" },
    ],
    sources: [
      { sourceKey: `camera:${A}`, camera: A, state: "active", daysObserved: 20, firstSeenAt: new Date("2026-08-01T00:00:00Z"), lastSeenAt: NOW, stateChangedAt: NOW },
      { sourceKey: `camera:${C}`, camera: C, state: "learning", daysObserved: 9, firstSeenAt: new Date("2026-09-10T00:00:00Z"), lastSeenAt: NOW, stateChangedAt: NOW },
    ],
    builds: [
      { id: B, state: "ready", timezone: TZ, windowFrom: "2026-08-26", windowTo: "2026-09-22", finishedAt: new Date("2026-09-23T04:11:00Z"), startedAt: new Date("2026-09-23T04:10:00Z") },
    ],
    cells: [
      ...cellsFor(B, { zoneKey: `camera:${A}`, keyKind: "camera", camera: A, cameras: [A] }, "person", () => ({}), 1n),
      ...cellsFor(B, { zoneKey: `camera:${C}`, keyKind: "camera", camera: C, cameras: [C] }, "person", () => ({}), 100n),
      ...cellsFor(B, { zoneKey: `area:${X}`, keyKind: "area", zoneId: X, zoneVersion: 2, cameras: [C, A].sort() }, "person", () => ({}), 200n),
      ...cellsFor(B, { zoneKey: `area:${Y}`, keyKind: "area", zoneId: Y, zoneVersion: 1, cameras: [A] }, "person", () => ({}), 300n),
    ],
  });
}

function app(role: Role | null = "owner") {
  const server = express();
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (role !== null) (req as Request & { user?: unknown }).user = { id: `u-${role}`, username: role, displayName: role, role };
    next();
  });
  // `resolve`: the viewer scope asks the §9 resolver whether door locks are
  // readable (WARP-2977 P2b-2, DS-019). Mounted alone, nothing has resolved the
  // request, so no local row (null) — the role decides, as in security.routes.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.use("/api", createSecurityPatternsRouter(patternsPrisma(w) as any, { now: () => NOW, resolve: async () => null }));
  return server;
}

beforeEach(() => {
  w = world();
});

describe("who may call — every route is view-level (a GET is never gated above view)", () => {
  it.each(["owner", "admin", "family"] as const)("%s → 200 on 29, 30 and 31", async (role) => {
    expect((await request(app(role)).get("/api/security/patterns")).status).toBe(200);
    expect((await request(app(role)).get(`/api/security/patterns/cells?key=camera:${A}`)).status).toBe(200);
    expect((await request(app(role)).get(`/api/security/patterns/explain?camera=${A}`)).status).toBe(200);
  });

  it("guest → 403: presence patterns are not for the guest tier", async () => {
    expect((await request(app("guest")).get("/api/security/patterns")).status).toBe(403);
    expect((await request(app("guest")).get(`/api/security/patterns/cells?key=camera:${A}`)).status).toBe(403);
    expect((await request(app("guest")).get(`/api/security/patterns/explain?camera=${A}`)).status).toBe(403);
  });
});

describe("29 GET /api/security/patterns", () => {
  it("DS-005: family (camera A only) sees area Y's key and not area X's", async () => {
    const res = await request(app("family")).get("/api/security/patterns");
    expect(res.status).toBe(200);
    expect(res.body.keys.map((k: { zoneKey: string }) => k.zoneKey)).toEqual([`area:${Y}`, `camera:${A}`]);
    expect(res.body.sources.map((s: { camera: string }) => s.camera)).toEqual([A]);
    const owner = await request(app("owner")).get("/api/security/patterns");
    expect(owner.body.keys).toHaveLength(4);
  });

  it("WARP-2980 PR-B: precision for owner/admin only — null for family (it spans every camera)", async () => {
    w.incidents = [{ id: "i1", verdict: "not_expected", verdictCodes: ["out_of_place"], verdictFirstAt: new Date(NOW.getTime() - 40 * 86_400_000) }];
    const owner = await request(app("owner")).get("/api/security/patterns");
    expect(owner.body.precision).toEqual({
      showAfterDays: 30,
      codes: [{ code: "out_of_place", marked: 1, notExpected: 1, firstMarkedAt: new Date(NOW.getTime() - 40 * 86_400_000).toISOString(), percentRight: 100 }],
    });
    expect((await request(app("admin")).get("/api/security/patterns")).body.precision).not.toBeNull();
    expect((await request(app("family")).get("/api/security/patterns")).body.precision).toBeNull();
  });

  it("an outage is a 503, never an empty 200", async () => {
    w.failReads = true;
    const res = await request(app()).get("/api/security/patterns");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: "PATTERNS_UNAVAILABLE", message: expect.any(String) } });
  });
});

describe("30 GET /api/security/patterns/cells", () => {
  it("48 cells for a key the viewer may see; the label defaults to person", async () => {
    const res = await request(app("family")).get(`/api/security/patterns/cells?key=area:${Y}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: `area:${Y}`, label: "person", window: { from: "2026-08-26", to: "2026-09-22" } });
    expect(res.body.cells).toHaveLength(48);
  });

  it("DS-005: area X for family answers EXACTLY like a random id — the same 404, the same body", async () => {
    const hidden = await request(app("family")).get(`/api/security/patterns/cells?key=area:${X}`);
    const missing = await request(app("family")).get(`/api/security/patterns/cells?key=area:${GONE}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: { code: "PATTERN_NOT_FOUND", message: expect.any(String) } });
    expect(JSON.stringify(hidden.body)).toBe(JSON.stringify(missing.body));
    const hiddenCamera = await request(app("family")).get(`/api/security/patterns/cells?key=camera:${C}`);
    expect(JSON.stringify(hiddenCamera.body)).toBe(JSON.stringify(missing.body));
  });

  it.each([
    ["no key", ""],
    ["a key of neither kind", "?key=zone:abc"],
    ["an area key that is not a uuid", "?key=area:not-a-uuid"],
    ["a camera name Frigate never sends", "?key=camera:bad%20name"],
    ["a label Frigate never sends", `?key=camera:${A}&label=traffic%20light`],
    ["an unknown parameter", `?key=camera:${A}&cursor=1`],
  ])("%s → 400 VALIDATION_ERROR", async (_l, qs) => {
    const res = await request(app()).get(`/api/security/patterns/cells${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("an outage is a 503", async () => {
    w.failReads = true;
    const res = await request(app()).get(`/api/security/patterns/cells?key=camera:${A}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PATTERNS_UNAVAILABLE");
  });
});

describe("31 GET /api/security/patterns/explain", () => {
  it("a camera at a given time, in the baseline zone", async () => {
    const res = await request(app("family")).get(`/api/security/patterns/explain?camera=${A}&at=2026-09-22T19:30:00Z`);
    expect(res.status).toBe(200);
    expect(res.body.key).toMatchObject({ zoneKey: `camera:${A}`, kind: "camera", name: "Front camera" });
    expect(res.body.at).toMatchObject({ local: "Tue 3:30 PM", hour: 15, dayType: "weekday", timezone: TZ });
    expect(res.body.cell).toMatchObject({ ready: true, daysObserved: 20 });
  });

  it("an area by id defaults to now", async () => {
    const res = await request(app("owner")).get(`/api/security/patterns/explain?zone=${X}`);
    expect(res.status).toBe(200);
    expect(res.body.at).toMatchObject({ instant: NOW.toISOString(), local: "Wed 2:14 AM" });
  });

  it("DS-005: a hidden area and a hidden camera answer exactly like a missing one", async () => {
    const hidden = await request(app("family")).get(`/api/security/patterns/explain?zone=${X}`);
    const missing = await request(app("family")).get(`/api/security/patterns/explain?zone=${GONE}`);
    const hiddenCamera = await request(app("family")).get(`/api/security/patterns/explain?camera=${C}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe("PATTERN_NOT_FOUND");
    expect(JSON.stringify(hidden.body)).toBe(JSON.stringify(missing.body));
    expect(JSON.stringify(hiddenCamera.body)).toBe(JSON.stringify(missing.body));
  });

  it("DS-005 on day 1: an area with NO cells whose cameras the viewer cannot all see answers like a random id (review #2352)", async () => {
    const hidden = await request(app("family")).get(`/api/security/patterns/explain?zone=${Z}`);
    const missing = await request(app("family")).get(`/api/security/patterns/explain?zone=${GONE}`);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body)).toBe(JSON.stringify(missing.body));
    expect(JSON.stringify(hidden.body)).not.toContain(C);
    const cells = await request(app("family")).get(`/api/security/patterns/cells?key=area:${Z}`);
    expect(cells.status).toBe(404);
    expect(JSON.stringify(cells.body)).toBe(JSON.stringify(missing.body));
    // The owner sees every camera: the area answers, with no cell yet.
    const owner = await request(app("owner")).get(`/api/security/patterns/explain?zone=${Z}`);
    expect(owner.status).toBe(200);
    expect(owner.body.cell).toBeNull();
  });

  it("no ready build → 409 PATTERNS_NOT_BUILT; no zone → 409 NO_TIMEZONE", async () => {
    w.builds = [];
    const notBuilt = await request(app()).get(`/api/security/patterns/explain?camera=${A}`);
    expect(notBuilt.status).toBe(409);
    expect(notBuilt.body.error.code).toBe("PATTERNS_NOT_BUILT");
    w = world();
    w.hours = null;
    const noZone = await request(app()).get(`/api/security/patterns/explain?camera=${A}`);
    expect(noZone.status).toBe(409);
    expect(noZone.body.error.code).toBe("NO_TIMEZONE");
  });

  it.each([
    ["neither zone nor camera", ""],
    ["both zone and camera", `?zone=${Y}&camera=${A}`],
    ["a zone that is not a uuid", "?zone=abc"],
    ["an `at` without an offset", `?camera=${A}&at=2026-09-22T19:30:00`],
    ["an `at` more than an hour ahead", `?camera=${A}&at=2026-09-23T07:15:00Z`],
    ["an unknown parameter", `?camera=${A}&period=today`],
  ])("%s → 400 VALIDATION_ERROR", async (_l, qs) => {
    const res = await request(app()).get(`/api/security/patterns/explain${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("an `at` up to an hour ahead is fine", async () => {
    expect((await request(app()).get(`/api/security/patterns/explain?camera=${A}&at=2026-09-23T07:10:00Z`)).status).toBe(200);
  });

  it("an outage is a 503", async () => {
    w.failReads = true;
    const res = await request(app()).get(`/api/security/patterns/explain?camera=${A}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PATTERNS_UNAVAILABLE");
  });
});
