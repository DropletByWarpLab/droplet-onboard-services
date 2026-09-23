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
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

const h = vi.hoisted(() => ({
  snapshot: new Map<string | null, { health: "online" | "offline" | "disabled"; at: Date }>(),
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

import { createSecurityRouter } from "../routes/security.js";
import { FEATURE_GATED_MODULES } from "../modules/module-mounts.js";
import { MODULE_BY_ID } from "../modules/module-registry.js";
import { _resetSecurityIngestHealthForTests, registerSecurityJobs } from "../services/security-events.service.js";

type Role = "owner" | "admin" | "family" | "guest";

const findMany = vi.fn();
const grants = vi.fn();
const stateRow = vi.fn();

function app(role: Role | null = "owner") {
  const prisma = {
    securityEvent: { findMany },
    cameraAccessGrant: { findMany: grants },
    securityIngestState: { findUnique: stateRow },
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
  it("owner sees every source row, including threats", async () => {
    registerSecurityJobs({ scheduleInterval: vi.fn(), scheduleCron: vi.fn() }, {} as never);
    const res = await request(app("owner")).get("/api/security/health");
    expect(res.status).toBe(200);
    expect(res.body.sources.map((s: { id: string }) => s.id)).toEqual([
      "camera_ingest",
      "camera_system",
      "threat_mirror",
      "retention",
    ]);
  });

  it("family does not get a threat row for a feed they cannot see", async () => {
    const res = await request(app("family")).get("/api/security/health");
    expect(res.body.sources.map((s: { id: string }) => s.id)).not.toContain("threat_mirror");
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

describe("the module gate that sits in front of this router", () => {
  it("`security` owns /api/security and is per-person gated (view) by mountModuleGates", () => {
    expect(MODULE_BY_ID.get("security")?.routePrefixes).toEqual(["/api/security"]);
    expect(MODULE_BY_ID.get("security")?.navHrefs).toEqual(["/security"]);
    expect(FEATURE_GATED_MODULES.has("security")).toBe(true);
  });
});
