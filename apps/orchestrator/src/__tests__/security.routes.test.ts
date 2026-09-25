/**
 * WARP-2977 (ADR-059 §3.1, §6) — GET /api/security/events and /health.
 *
 * The real `requireRole` runs (a stub would let a wrong allowlist pass). The
 * per-person `security` grant and the box-wide toggle are mounted by
 * `mountModuleGates` off the registry prefix — pinned at the bottom, since
 * this file mounts the router alone.
 *
 * DS-005 is the point of most of these cases: a camera the viewer is not
 * granted must be ABSENT — no row, no count, and asking for it by name gets
 * the same empty page as a camera that exists and saw nothing.
 *
 * WARP-2977 P2b adds areas to the feed (`?zone=`, `zones[]` on every row)
 * and the site-mode row to the header. DS-005 applies to places too: an area
 * made only of cameras the viewer cannot see is absent — its filter answers
 * the empty page without a query, and no row ever names it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

const h = vi.hoisted(() => ({
  snapshot: new Map<string | null, { health: "online" | "offline" | "disabled"; at: Date }>(),
  siteMode: { id: "site_mode", state: "ok", detail: "(slice A's copy)", lastSeenAt: null } as Record<string, unknown>,
  siteModeHealth: vi.fn(),
  patterns: { id: "patterns", state: "quiet", detail: "(slice A3's copy)", lastSeenAt: null } as Record<string, unknown>,
  patternsHealth: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, FRIGATE_URL: "http://frigate.test:5000" },
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/camera.service.js", () => ({
  securityStatusSnapshot: () => h.snapshot,
}));

// Slice A owns the site_mode row's copy; this file pins only that the header
// asks for it and where it lands.
vi.mock("../services/security-mode.service.js", () => ({
  securitySiteModeHealth: h.siteModeHealth,
}));

// WARP-2980 — the baseline job owns the patterns row's copy; this file pins
// that the header asks for it with the VIEWER's scope and where it lands.
vi.mock("../services/security-baselines.service.js", () => ({
  securityPatternsHealth: h.patternsHealth,
}));

import { createSecurityRouter } from "../routes/security.js";
import { FEATURE_GATED_MODULES } from "../modules/module-mounts.js";
import { MODULE_BY_ID } from "../modules/module-registry.js";
import { _resetSecurityIngestHealthForTests, registerSecurityJobs } from "../services/security-events.service.js";
import { _resetIncidentHealthForTests } from "../services/security-incidents.service.js";

type Role = "owner" | "admin" | "family" | "guest";

const findMany = vi.fn();
const grants = vi.fn();
const stateRow = vi.fn();
const zoneLinks = vi.fn();
const triage = vi.fn();

function app(role: Role | null = "owner") {
  const prisma = {
    securityEvent: { findMany },
    cameraAccessGrant: { findMany: grants },
    securityIngestState: { findUnique: stateRow },
    securityZoneLink: { findMany: zoneLinks },
    securityEventTriage: { findMany: triage },
  };
  const server = express();
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (role !== null) (req as Request & { user?: unknown }).user = { id: "u-1", username: "sam", displayName: "Sam", role };
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.use("/api", createSecurityRouter(prisma as any));
  return server;
}

const NOW = new Date("2026-09-23T02:14:00Z");
function dbRow(id: number, over: Record<string, unknown> = {}) {
  return {
    id: BigInt(id),
    source: "frigate",
    kind: "detection",
    severity: "info",
    camera: "front",
    sourceRef: `front/171${id}.5-abc`,
    dedupeKey: `frigate:171${id}.5-abc`,
    labels: ["person"],
    cameraZones: ["porch"],
    score: 0.9,
    startedAt: new Date(NOW.getTime() - id * 1000),
    endedAt: NOW,
    summary: "Person in porch",
    createdAt: NOW,
    ...over,
  };
}

/** The visibility clause is the first entry of the top-level AND. */
function visibilityOf(call: number) {
  return findMany.mock.calls[call][0].where.AND[0];
}

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
  grants.mockReset().mockResolvedValue([{ camera: { name: "front" } }]);
  stateRow.mockReset().mockResolvedValue(null);
  zoneLinks.mockReset().mockResolvedValue([]);
  triage.mockReset().mockResolvedValue([]);
  _resetIncidentHealthForTests();
  h.siteModeHealth.mockReset().mockImplementation(async () => h.siteMode);
  h.patternsHealth.mockReset().mockImplementation(async () => h.patterns);
  h.snapshot.clear();
  _resetSecurityIngestHealthForTests();
});

describe("GET /api/security/events — who may call", () => {
  it.each(["owner", "admin", "family"] as const)("%s → 200", async (role) => {
    expect((await request(app(role)).get("/api/security/events")).status).toBe(200);
  });

  it("guest → 403: presence data is not for the guest tier", async () => {
    expect((await request(app("guest")).get("/api/security/events")).status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("no session → 403", async () => {
    expect((await request(app(null)).get("/api/security/events")).status).toBe(403);
  });
});

describe("GET /api/security/events — DS-005 and the threat gate", () => {
  it("owner: no camera constraint, threats included", async () => {
    await request(app("owner")).get("/api/security/events");
    expect(visibilityOf(0)).toEqual({});
    expect(grants).not.toHaveBeenCalled();
  });

  it("family: only granted cameras (plus camera-less rows), and no mirrored threats", async () => {
    await request(app("family")).get("/api/security/events");
    expect(visibilityOf(0)).toEqual({
      AND: [{ OR: [{ camera: null }, { camera: { in: ["front"] } }] }, { source: { not: "activity_mirror" } }],
    });
  });

  it("family asking for an ungranted camera by name gets an empty page, not a 403", async () => {
    const res = await request(app("family")).get("/api/security/events?camera=back");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], nextCursor: null });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("family asking for a granted camera gets it", async () => {
    await request(app("family")).get("/api/security/events?camera=front");
    expect(findMany.mock.calls[0][0].where.AND).toContainEqual({ camera: "front" });
  });
});

describe("GET /api/security/events — query and paging", () => {
  it("hides detection_low unless includeLow=true", async () => {
    await request(app()).get("/api/security/events");
    await request(app()).get("/api/security/events?includeLow=true");
    expect(findMany.mock.calls[0][0].where.AND).toContainEqual({ kind: { not: "detection_low" } });
    expect(findMany.mock.calls[1][0].where.AND).not.toContainEqual({ kind: { not: "detection_low" } });
  });

  it("filters by a comma list of kinds", async () => {
    await request(app()).get("/api/security/events?kind=camera_offline,threat");
    expect(findMany.mock.calls[0][0].where.AND).toContainEqual({ kind: { in: ["camera_offline", "threat"] } });
  });

  it("orders newest first with the id as tiebreak, and reads one extra row to know if there is more", async () => {
    await request(app()).get("/api/security/events?limit=10");
    const q = findMany.mock.calls[0][0];
    expect(q.orderBy).toEqual([{ startedAt: "desc" }, { id: "desc" }]);
    expect(q.take).toBe(11);
  });

  it("returns a cursor only when there is another page, and serialises ids as strings", async () => {
    findMany.mockResolvedValue([dbRow(1), dbRow(2), dbRow(3)]);
    const res = await request(app()).get("/api/security/events?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { id: string }) => e.id)).toEqual(["1", "2"]);
    expect(res.body.nextCursor).toBe(`${NOW.getTime() - 2000}.2`);
    expect(res.body.events[0]).toMatchObject({ frigateEventId: "1711.5-abc", camera: "front", kind: "detection" });
  });

  it("WARP-2978: every row carries `incident` — null for an event no incident holds", async () => {
    findMany.mockResolvedValue([dbRow(1), dbRow(2)]);
    const res = await request(app()).get("/api/security/events");
    expect(res.body.events.map((e: { incident: unknown }) => e.incident)).toEqual([null, null]);
  });

  it("WARP-2978: a grouped event carries its incident's id — one IN query on the triage ledger for the page", async () => {
    findMany.mockResolvedValue([dbRow(1), dbRow(2)]);
    triage.mockResolvedValue([{ eventId: 1n, incidentId: "0b7c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4" }]);
    const res = await request(app("family")).get("/api/security/events");
    expect(res.body.events.map((e: { incident: unknown }) => e.incident)).toEqual([{ id: "0b7c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4" }, null]);
    expect(triage).toHaveBeenCalledTimes(1);
    expect(triage.mock.calls[0][0].where).toEqual({ eventId: { in: [1n, 2n] }, outcome: "grouped" });
  });

  it("a cursor narrows to rows strictly after it in feed order", async () => {
    await request(app()).get("/api/security/events?cursor=1790000000000.42");
    expect(findMany.mock.calls[0][0].where.AND).toContainEqual({
      OR: [
        { startedAt: { lt: new Date(1_790_000_000_000) } },
        { startedAt: new Date(1_790_000_000_000), id: { lt: 42n } },
      ],
    });
  });

  it.each([
    ["an unknown kind", "kind=everything"],
    ["a limit over 200", "limit=500"],
    ["a camera name with a slash", "camera=front%2F..%2Fx"],
    ["a malformed cursor", "cursor=yesterday"],
    ["an unknown parameter", "since=today"],
  ])("400 on %s", async (_n, qs) => {
    const res = await request(app()).get(`/api/security/events?${qs}`);
    expect(res.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("a database failure is a 503, never an empty 200 (empty reads as a quiet site)", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    const res = await request(app()).get("/api/security/events");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "SECURITY_FEED_UNAVAILABLE" });
  });
});

describe("GET /api/security/health", () => {
  it("owner sees every source row, including threats, with the site-mode row before retention", async () => {
    registerSecurityJobs({ scheduleInterval: vi.fn(), scheduleCron: vi.fn() }, {} as never);
    const res = await request(app("owner")).get("/api/security/health");
    expect(res.status).toBe(200);
    // WARP-2977 P2b: `site_mode` joins the pinned order — deliberately red against P2a's list.
    // WARP-2978: `incidents` and `alerts` join it after site_mode; WARP-2980's `patterns` follows
    // them, before retention (whichever merged second moved this pin). WARP-2979: `links` (Droplet's
    // link proposals) sits between alerts and patterns.
    expect(res.body.sources.map((s: { id: string }) => s.id)).toEqual([
      "camera_ingest",
      "camera_system",
      "threat_mirror",
      "site_mode",
      "incidents",
      "alerts",
      "links",
      "patterns",
      "retention",
    ]);
  });

  it("WARP-2979: the links row says DOWN 'Not running' while the job is not registered — for every viewer, naming nothing", async () => {
    for (const role of ["owner", "family"] as const) {
      const res = await request(app(role)).get("/api/security/health");
      expect(res.body.sources.find((s: { id: string }) => s.id === "links"), role).toEqual({
        id: "links",
        state: "down",
        detail: "Not running",
        lastSeenAt: null,
      });
    }
  });

  it("WARP-2978: the incidents row says DOWN 'Not running' while the engine is not registered (§7's boot assertion)", async () => {
    const res = await request(app("family")).get("/api/security/health");
    expect(res.body.sources.find((s: { id: string }) => s.id === "incidents")).toMatchObject({
      state: "down",
      detail: "Not running",
    });
  });

  it("WARP-2980: the patterns row is the baseline job's row, verbatim, asked for with the viewer's scope", async () => {
    grants.mockResolvedValue([{ camera: { name: "front" } }]);
    const res = await request(app("family")).get("/api/security/health");
    expect(res.body.sources.find((s: { id: string }) => s.id === "patterns")).toEqual(h.patterns);
    expect(h.patternsHealth).toHaveBeenCalledTimes(1);
    const [, scope, now] = h.patternsHealth.mock.calls[0];
    expect([...scope.visibleCameras]).toEqual(["front"]);
    expect(now).toBeInstanceOf(Date);
    const owner = await request(app("owner")).get("/api/security/health");
    expect(owner.status).toBe(200);
    expect(h.patternsHealth.mock.calls[1][1].visibleCameras).toBe("all");
  });

  it("WARP-2980: a viewer scope that cannot be read gives the patterns row nothing to count (null), never 'all' — and no 503", async () => {
    grants.mockRejectedValue(new Error("db down"));
    const res = await request(app("family")).get("/api/security/health");
    expect(res.status).toBe(200);
    expect(h.patternsHealth.mock.calls[0][1]).toBeNull();
  });

  it("the site_mode row is slice A's row, passed through verbatim (whatever its copy)", async () => {
    const res = await request(app("owner")).get("/api/security/health");
    expect(res.body.sources.find((s: { id: string }) => s.id === "site_mode")).toEqual(h.siteMode);
    expect(h.siteModeHealth).toHaveBeenCalledTimes(1);
    expect(h.siteModeHealth.mock.calls[0][1]).toBeInstanceOf(Date);
  });

  it("family does not get a threat row for a feed they cannot see, but does get the site mode and patterns", async () => {
    const res = await request(app("family")).get("/api/security/health");
    // WARP-2978: nor the alerts row (it names who is told); the incidents row is everyone's.
    // WARP-2979: so is the links row.
    expect(res.body.sources.map((s: { id: string }) => s.id)).toEqual([
      "camera_ingest",
      "camera_system",
      "site_mode",
      "incidents",
      "links",
      "patterns",
      "retention",
    ]);
  });

  it("an ingest that never subscribed says DOWN", async () => {
    const res = await request(app()).get("/api/security/health");
    expect(res.body.sources[0]).toMatchObject({ id: "camera_ingest", state: "down" });
  });

  it("a Frigate that went offline says DOWN", async () => {
    h.snapshot.set(null, { health: "offline", at: NOW });
    const res = await request(app()).get("/api/security/health");
    expect(res.body.sources.find((s: { id: string }) => s.id === "camera_system")).toMatchObject({ state: "down" });
  });

  it("guest → 403", async () => {
    expect((await request(app("guest")).get("/api/security/health")).status).toBe(403);
  });
});

// ── WARP-2977 P2b: areas on the feed ─────────────────────────────────────

const SHOP = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61"; // links front (whole) + back/porch
const YARD = "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c82"; // links back only
const EMPTY = "9b8a7c6d-5e4f-4d3c-8b2a-1f0e9d8c7b63"; // an area with no links
const GONE = "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6"; // no such area

/** loadActiveLinks rows as Prisma returns them for its select. */
function linkRow(zoneId: string, name: string, sourceKind: "camera" | "camera_zone", sourceRef: string) {
  return { id: `l-${zoneId.slice(0, 4)}-${sourceRef}`, zoneId, sourceKind, sourceRef, stateSetBy: "person", zone: { name, kind: "interior" } };
}
const AREA_LINKS = [
  linkRow(SHOP, "Shop floor", "camera", "front"),
  linkRow(SHOP, "Shop floor", "camera_zone", "back/porch"),
  linkRow(YARD, "Yard", "camera", "back"),
];

describe("GET /api/security/events?zone= — DS-005 applied to places", () => {
  beforeEach(() => {
    zoneLinks.mockResolvedValue(AREA_LINKS);
  });

  it("loads only active links of active areas", async () => {
    await request(app("family")).get("/api/security/events");
    expect(zoneLinks.mock.calls[0][0].where).toEqual({ state: "active", zone: { state: "active" } });
  });

  it("family, an area made only of a camera they cannot see → the empty page and NO query", async () => {
    const res = await request(app("family")).get(`/api/security/events?zone=${YARD}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], nextCursor: null });
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing (or removed) area", GONE],
    ["an area with no links", EMPTY],
  ])("%s → the same empty page and no query, even for the owner", async (_n, id) => {
    const res = await request(app("owner")).get(`/api/security/events?zone=${id}`);
    expect(res.body).toEqual({ events: [], nextCursor: null });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("family, an area they can partly see: visibility stays AND[0], the area clause follows the camera clause, hidden links dropped", async () => {
    await request(app("family")).get(`/api/security/events?zone=${SHOP}&camera=front`);
    const and = findMany.mock.calls[0][0].where.AND;
    expect(and[0]).toEqual({
      AND: [{ OR: [{ camera: null }, { camera: { in: ["front"] } }] }, { source: { not: "activity_mirror" } }],
    });
    expect(and[3]).toEqual({ camera: "front" });
    // back/porch is hidden from this viewer, so only the front camera arm remains.
    expect(and[4]).toEqual({ OR: [{ camera: "front" }] });
    expect(and).toHaveLength(6);
  });

  it("owner, the same area: the whole camera AND the part of the other camera's view, incl. its offline/online rows", async () => {
    await request(app("owner")).get(`/api/security/events?zone=${SHOP}`);
    const and = findMany.mock.calls[0][0].where.AND;
    expect(and[0]).toEqual({});
    expect(and[4]).toEqual({
      OR: [
        { camera: "front" },
        {
          camera: "back",
          OR: [
            { kind: { in: ["detection", "detection_ongoing", "detection_low"] }, cameraZones: { hasSome: ["porch"] } },
            { kind: { in: ["camera_offline", "camera_online"] } },
          ],
        },
      ],
    });
  });

  it("rows name only the areas the viewer can see — never the hidden one", async () => {
    findMany.mockResolvedValue([
      dbRow(1, { camera: "front", cameraZones: [] }),
      dbRow(2, { camera: "back", cameraZones: ["porch"], sourceRef: "back/1712.5-abc" }),
      dbRow(3, { source: "activity_mirror", kind: "threat", camera: null, cameraZones: [] }),
    ]);
    const family = await request(app("family")).get("/api/security/events");
    expect(family.body.events.map((e: { zones: unknown }) => e.zones)).toEqual([
      [{ id: SHOP, name: "Shop floor" }],
      [], // back is not granted: Shop floor's back/porch link and Yard are both hidden
      [],
    ]);
    const owner = await request(app("owner")).get("/api/security/events");
    expect(owner.body.events.map((e: { zones: unknown }) => e.zones)).toEqual([
      [{ id: SHOP, name: "Shop floor" }],
      [
        { id: SHOP, name: "Shop floor" },
        { id: YARD, name: "Yard" },
      ],
      [],
    ]);
  });

  it("a row's areas come in name order, not id order", async () => {
    const ZEBRA = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"; // sorts FIRST by id, LAST by name
    zoneLinks.mockResolvedValue([...AREA_LINKS, linkRow(ZEBRA, "Zebra crossing", "camera", "back")]);
    findMany.mockResolvedValue([dbRow(1, { camera: "back", cameraZones: ["porch"] })]);
    const res = await request(app("owner")).get("/api/security/events");
    expect(res.body.events[0].zones).toEqual([
      { id: SHOP, name: "Shop floor" },
      { id: YARD, name: "Yard" },
      { id: ZEBRA, name: "Zebra crossing" },
    ]);
  });

  it("a camera's offline row carries the areas watching any part of its view", async () => {
    findMany.mockResolvedValue([
      dbRow(1, { source: "frigate_status", kind: "camera_offline", camera: "back", cameraZones: [], score: null }),
    ]);
    const res = await request(app("owner")).get("/api/security/events");
    expect(res.body.events[0].zones.map((z: { id: string }) => z.id)).toEqual([SHOP, YARD]);
  });

  it("mode_changed is a feed kind", async () => {
    const res = await request(app()).get("/api/security/events?kind=mode_changed");
    expect(res.status).toBe(200);
    expect(findMany.mock.calls[0][0].where.AND).toContainEqual({ kind: { in: ["mode_changed"] } });
  });

  it("400 on a zone that is not an area id", async () => {
    const res = await request(app()).get("/api/security/events?zone=front-door");
    expect(res.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("an unreadable link table is a 503, never a feed without its areas", async () => {
    zoneLinks.mockRejectedValue(new Error("db down"));
    const res = await request(app()).get("/api/security/events");
    expect(res.status).toBe(503);
  });
});

describe("the module gate that sits in front of this router", () => {
  it("`security` owns /api/security and is per-person gated (view) by mountModuleGates", () => {
    expect(MODULE_BY_ID.get("security")?.routePrefixes).toEqual(["/api/security"]);
    expect(MODULE_BY_ID.get("security")?.navHrefs).toEqual(["/security"]);
    expect(FEATURE_GATED_MODULES.has("security")).toBe(true);
  });
});
