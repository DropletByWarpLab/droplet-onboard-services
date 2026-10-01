/**
 * WARP-2979 (ADR-059 P4 §6.12, §7 A1–A4, §9 "Assistant") — what the read-only
 * `security` chat tools read.
 *
 * The REAL router with its real guard chain (`requireRoleOrService` for the
 * MCP principal, `resolveSecurityActor` over the shared `resolveAssertedUser`),
 * the real read models (incidents, feed, areas, mode) over the in-memory fake
 * (security-incidents.fake.ts), and the §9 resolver injected through
 * `deps.resolve`. Every request arrives as `_service:mcp` with
 * `X-Nextcloud-User`, exactly as the mcp-server sends it.
 *
 * The world: Stefan (owner) sees everything; Maria (family) holds a grant on
 * `front` only. "Shop floor" is made of `front`, "Stock room" of `back`, so
 * for Maria the Stock room, its incident and its events do not exist. Maria
 * acknowledged an incident, set the site mode by hand, and a mode_changed row
 * and a mirrored threat both carry her name in their stored summaries — and
 * no output may say "Maria" (§6.12.5, D26).
 *
 * WARP-2980 (ADR-059 P5 PR-E, spec §6.18, D30) — A5, what the
 * `security_explain_pattern` tool reads: "what normal looks like" for one
 * area or camera, with the acting person's scope. The pattern world adds a
 * "Loading bay" made of `front` AND `back`: Maria sees it (through `front`)
 * but not every camera behind it, so she gets the place and no numbers. And
 * A1/A2 never carry a pattern flag — trial or quietened — for anyone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
  recordActivityInTx: vi.fn(),
  getActivityRecorder: () => ({ record: vi.fn() }),
}));

// A camera-limited viewer's incident page is ordered in SQL; this lane runs the reference the pg lane pins it to.
vi.mock("../services/security-incident-page.js", async () => ({
  projectedIncidentPage: (await import("./security-incidents.fake.js")).referenceProjectedIncidentPage,
}));

import { AREA_READ_BATCH, createSecurityAssistantRouter, type CameraStatusSource } from "../routes/security-assistant.js";
import { securityScopeForPerson } from "../services/security-access.js";
import { assistantBodyBudget } from "../services/security-assistant-view.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { explainSecurityPattern } from "../services/security-patterns-read.js";
import { loadIncidentDetail } from "../services/security-incident-view.js";
import { SECURITY_ZONE_ACTIVE_LIMIT } from "../services/security-zones.service.js";
import type { LockReadingsState } from "../services/security-lock-adapter.js";
import { getTool, type ToolContext } from "@droplet/tools-core";
import {
  areaRows as fakeAreaRows,
  baselineRows,
  createFakeSecurityPrisma,
  eventRow,
  officeHours,
  type BaselineKeyFixture,
  type FakeSecurityPrisma,
  type FakeWorld,
} from "./security-incidents.fake.js";

type Level = "view" | "act" | "manage";

const NOW = new Date("2026-09-23T21:30:00Z"); // Wed 22:30 London — closed since 17:00
const T = new Date("2026-09-23T21:14:00Z");
const STEFAN = "11111111-1111-4111-8111-111111111111";
const MARIA = "22222222-2222-4222-8222-222222222222";
const JORDAN = "33333333-3333-4333-8333-333333333333";
const GUS = "44444444-4444-4444-8444-444444444444";
const SAM = "55555555-5555-4555-8555-555555555555";
const DEE = "66666666-6666-4666-8666-666666666666";

const SHOP = "0a0a0a0a-0000-4000-8000-000000000001";
const STOCK = "0a0a0a0a-0000-4000-8000-000000000002";

const INC_FRONT = "1b1b1b1b-0000-4000-8000-000000000001";
const INC_BACK = "1b1b1b1b-0000-4000-8000-000000000002";
const INC_THREAT = "1b1b1b1b-0000-4000-8000-000000000003";
const INC_OLD = "1b1b1b1b-0000-4000-8000-000000000004";
const MISSING = "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f";

/** The fake's area rows, plus the columns every stored link has and route 3's view reads. */
function areaRows(...args: Parameters<typeof fakeAreaRows>) {
  const { zone, links } = fakeAreaRows(...args);
  return { zone, links: links.map((l) => ({ ...l, stateChangedAt: T, evidence: null })) };
}

function incident(id: string, over: Record<string, unknown>) {
  return {
    id,
    scope: "area",
    zoneLinkIds: [],
    openedInMode: "closed",
    grouping: "closed",
    state: "open",
    severity: "alert",
    notifyState: "done",
    alertedAt: T,
    rulesetVersion: 2,
    firstActivityAt: T,
    lastActivityAt: T,
    lastArrivalAt: T,
    eventCount: 1,
    spanByCamera: {},
    version: 1,
    ...over,
  };
}

function reason(incidentId: string, code: string, camera: string | null, severity: string, id: bigint, kind = "detection") {
  return {
    id: `r-${incidentId.slice(-4)}-${id}`,
    incidentId,
    code,
    severity,
    rulesetVersion: 2,
    evidenceEventId: id,
    evidenceCamera: camera,
    evidenceSource: camera ? "frigate" : "activity_mirror",
    evidenceKind: kind,
    evidenceLabel: kind === "detection" ? "person" : kind === "threat" ? "auth" : null,
    evidenceAt: T,
    // A stored summary may name a person; the tools never pass it through.
    evidenceSummary: "Maria's sign-in failed",
    detail: { by: "Maria" },
    relatedCamera: null,
    relatedLock: false,
  };
}

function world(over: Partial<FakeWorld> = {}): FakeSecurityPrisma {
  const shop = areaRows(SHOP, "Shop floor", "interior", ["front"]);
  const stock = areaRows(STOCK, "Stock room", "interior", ["back"]);
  const hours = officeHours("Europe/London");
  const e1 = eventRow({ id: 1n, camera: "front", startedAt: T, summary: "Person seen by Front door", sourceRef: "front/1.5-abc", dedupeKey: "k1" });
  const e2 = eventRow({ id: 2n, camera: "back", startedAt: new Date(T.getTime() + 60_000), summary: "Person seen by Back camera", sourceRef: "back/2.5-abc", dedupeKey: "k2" });
  const e3 = eventRow({
    id: 3n, source: "site_mode", kind: "mode_changed", camera: null, labels: ["closed", "manual", "open"], sourceRef: "site", dedupeKey: "k3",
    startedAt: new Date(T.getTime() - 3_600_000), endedAt: null, summary: "Closed up by Maria",
  });
  const e4 = eventRow({
    id: 4n, source: "activity_mirror", kind: "threat", severity: "notice", camera: null, labels: ["auth"], sourceRef: "activity:9", dedupeKey: "k4",
    startedAt: new Date(T.getTime() - 120_000), endedAt: null, summary: "Failed sign-in for maria",
  });
  return createFakeSecurityPrisma(
    {
      user: [
        { id: STEFAN, username: "stefan", nextcloudUsername: "stefan", displayName: "Stefan", role: "owner", directoryStatus: "ACTIVE" },
        { id: MARIA, username: "maria", nextcloudUsername: "maria", displayName: "Maria", role: "family", directoryStatus: "ACTIVE" },
        { id: JORDAN, username: "jordan", nextcloudUsername: "jordan", displayName: "Jordan", role: "admin", directoryStatus: "ACTIVE" },
        { id: GUS, username: "gus", nextcloudUsername: "gus", displayName: "Gus", role: "guest", directoryStatus: "ACTIVE" },
        // SSO / SCIM: no Nextcloud username at all.
        { id: SAM, username: "sam@example.com", nextcloudUsername: null, displayName: "Sam", role: "family", directoryStatus: "ACTIVE" },
        { id: DEE, username: "dee", nextcloudUsername: "dee", displayName: "Dee", role: "family", directoryStatus: "DEACTIVATED" },
      ],
      camera: [
        { id: "cam-back", name: "back", displayName: "Back camera" },
        { id: "cam-front", name: "front", displayName: "Front door" },
      ],
      cameraAccessGrant: [
        { id: "g1", userId: MARIA, cameraId: "cam-front" },
        { id: "g2", userId: SAM, cameraId: "cam-front" },
      ],
      securityZone: [shop.zone, stock.zone],
      securityZoneLink: [...shop.links, ...stock.links],
      securityEvent: [e1, e2, e3, e4],
      securityEventTriage: [
        { eventId: 1n, outcome: "grouped", incidentId: INC_FRONT, alsoZoneIds: [] },
        { eventId: 2n, outcome: "grouped", incidentId: INC_BACK, alsoZoneIds: [] },
      ],
      securityIncident: [
        incident(INC_FRONT, {
          zoneId: SHOP, zoneName: "Shop floor", zoneKind: "interior", cameras: ["front"], state: "acknowledged",
          reasonCodes: ["after_hours_presence"], countsByCamera: { front: { person: 1 } },
        }),
        incident(INC_BACK, {
          zoneId: STOCK, zoneName: "Stock room", zoneKind: "interior", cameras: ["back"], reasonCodes: ["after_hours_presence"],
          countsByCamera: { back: { person: 1 } }, firstActivityAt: new Date(T.getTime() + 60_000), lastActivityAt: new Date(T.getTime() + 60_000),
        }),
        incident(INC_THREAT, {
          scope: "site_threat", zoneId: null, zoneName: null, zoneKind: null, cameras: [], severity: "notice", reasonCodes: ["threat_signal"],
          countsByCamera: { "": { _threat: 1 } }, firstActivityAt: new Date(T.getTime() - 120_000), lastActivityAt: new Date(T.getTime() - 120_000),
        }),
        // Two days ago: outside last night.
        incident(INC_OLD, {
          zoneId: SHOP, zoneName: "Shop floor", zoneKind: "interior", cameras: ["front"], state: "resolved", reasonCodes: ["after_hours_presence"],
          countsByCamera: { front: { person: 1 } }, firstActivityAt: new Date("2026-09-21T23:00:00Z"), lastActivityAt: new Date("2026-09-21T23:05:00Z"),
        }),
      ],
      securityIncidentReason: [
        reason(INC_FRONT, "after_hours_presence", "front", "alert", 1n),
        reason(INC_BACK, "after_hours_presence", "back", "alert", 2n),
        reason(INC_THREAT, "threat_signal", null, "notice", 4n, "threat"),
        reason(INC_OLD, "after_hours_presence", "front", "alert", 5n),
      ],
      securityIncidentAck: [
        { id: "a1", incidentId: INC_FRONT, action: "acknowledge", byUserId: MARIA, byName: "Maria", at: new Date(T.getTime() + 300_000), sessionId: "s", sessionChecked: true, client: "Maria's phone", viaNotificationId: null, note: "Maria checked" },
      ],
      securitySiteHours: [hours.header],
      securitySchedule: hours.days,
      securityModeState: [
        { id: "singleton", mode: "closed", modeSource: "manual", manualEnd: "none", manualUntil: null, setById: MARIA, setAt: new Date(T.getTime() - 3_600_000), version: 3 },
      ],
      ...over,
    },
    NOW,
  );
}

function access(level: Level | null): EffectiveAccessResult {
  return {
    tier: "family",
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
  } as unknown as EffectiveAccessResult;
}

const ALL_ONLINE: CameraStatusSource = () =>
  new Map<string | null, { health: "online" | "offline" }>([
    [null, { health: "online" }],
    ["front", { health: "online" }],
    ["back", { health: "offline" }],
  ]);

interface AppOpts {
  principal?: { id: string; role: string } | null;
  level?: Level | null;
  resolve?: (userId: string) => Promise<EffectiveAccessResult | null>;
  cameraStatus?: CameraStatusSource;
  /** WARP-2979 PR-4 — the lock adapter as the routes read it (default: none running). */
  locks?: () => { knownLocks(): Array<{ ref: string; name: string; connected: boolean }>; readingsState(): LockReadingsState } | null;
}

function app(f: FakeSecurityPrisma, opts: AppOpts = {}) {
  const resolve = vi.fn(opts.resolve ?? (async (_userId: string) => access(opts.level === undefined ? "view" : opts.level)));
  const server = express();
  server.use((req: Request, _res: Response, next: NextFunction) => {
    const principal = opts.principal === undefined ? { id: "_service:mcp", role: "service" } : opts.principal;
    if (principal) (req as unknown as { user?: unknown }).user = { ...principal, username: principal.id };
    next();
  });
  server.use(
    "/api",
    createSecurityAssistantRouter(f.client as unknown as PrismaClient, {
      resolve,
      now: () => NOW,
      cameraStatus: opts.cameraStatus ?? ALL_ONLINE,
      locks: (opts.locks ?? (() => null)) as never,
    }),
  );
  return { server, resolve };
}

const get = (s: express.Express, path: string, asUser: string | null = "stefan") => {
  const r = request(s).get(path);
  return asUser === null ? r : r.set("X-Nextcloud-User", asUser);
};

const ROUTES = [
  "/api/security/assistant/incidents",
  `/api/security/assistant/incidents/${INC_FRONT}`,
  "/api/security/assistant/events",
  "/api/security/assistant/areas",
  // WARP-2980 PR-E — A5.
  "/api/security/assistant/patterns?area=Shop%20floor",
];

const MODULE_DISABLED = { error: "module_disabled", module: "security" };

/** Droplet's own summary of INC_FRONT (PR-2's check already refused any name in it). */
const SUMMARY = "A person was seen on the Shop floor at 10:14 PM while the site was closed. It was acknowledged at 10:19 PM.";
const WRITTEN = new Date(T.getTime() + 600_000); // 10:24 PM London

/** Give an incident a "Summary by Droplet" as the narrator writes it (the CHECK's shape), then `over`. */
function withSummary(w: FakeSecurityPrisma, id: string, over: Record<string, unknown> = {}): void {
  const row = w.world.securityIncident.find((r) => r.id === id);
  if (!row) throw new Error(`no incident ${id}`);
  Object.assign(row, {
    narrativeState: "written",
    narrative: SUMMARY,
    narrativeModel: "llama3.2:3b",
    narrativePromptVersion: 1,
    narratedAt: WRITTEN,
    narrativeAudience: { cameras: [...(row.cameras as string[])], threats: row.scope === "site_threat", locks: false },
    ...over,
  });
}

let f: FakeSecurityPrisma;
beforeEach(() => {
  f = world();
});

describe("refusals: only the MCP principal, only for a person who may view Security", () => {
  it.each(ROUTES)("a person's own session is refused with 403 (%s)", async (path) => {
    for (const role of ["owner", "admin", "family"]) {
      const { server } = app(f, { principal: { id: STEFAN, role } });
      const res = await get(server, path);
      expect(res.status, role).toBe(403);
    }
  });

  it.each(ROUTES)("another service principal is refused with 403 (%s)", async (path) => {
    const { server } = app(f, { principal: { id: "_service:voice", role: "service" } });
    expect((await get(server, path)).status).toBe(403);
  });

  it.each([
    ["no X-Nextcloud-User", null],
    ["an unknown person", "nobody"],
    ["a deactivated person", "dee"],
    ["a guest", "gus"],
  ])("%s → 404 module_disabled on every route, and nothing is read", async (_label, who) => {
    const { server, resolve } = app(f);
    for (const path of ROUTES) {
      const res = await get(server, path, who);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toEqual(MODULE_DISABLED);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  // #2420 review 12: a header naming TWO rows (one person's username is another's id) is neither of them —
  // here the other row is an owner, so picking either would scope the call with a stranger's reach.
  it("a header that names two people → 404 module_disabled on every route, and neither is asked about", async () => {
    f.world.user.push({ id: "66666666-6666-4666-8666-666666666666", username: MARIA, nextcloudUsername: null, displayName: "Twin", role: "owner", directoryStatus: "ACTIVE" });
    const { server, resolve } = app(f);
    for (const path of ROUTES) {
      const res = await get(server, path, MARIA);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toEqual(MODULE_DISABLED);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("family without the Security feature → 404 module_disabled, asked about Maria", async () => {
    const { server, resolve } = app(f, { level: null });
    for (const path of ROUTES) {
      const res = await get(server, path, "maria");
      expect(res.status, path).toBe(404);
      expect(res.body, path).toEqual(MODULE_DISABLED);
    }
    expect(resolve).toHaveBeenCalledWith(MARIA);
  });

  it("a resolver that throws → 404 module_disabled (never a 503 that says the person exists)", async () => {
    const { server } = app(f, { resolve: async () => { throw new Error("db down"); } });
    const res = await get(server, "/api/security/assistant/incidents", "maria");
    expect(res.status).toBe(404);
    expect(res.body).toEqual(MODULE_DISABLED);
  });

  it("the owner needs no resolved level (owners bypass), and is never asked about", async () => {
    const { server, resolve } = app(f, { level: null });
    expect((await get(server, "/api/security/assistant/incidents", "stefan")).status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("identity: the header is a username on stdio and a User.id over HTTP", () => {
  it("resolves by username and by id alike, and scopes to that person", async () => {
    const { server, resolve } = app(f);
    const byName = await get(server, "/api/security/assistant/incidents", "maria");
    const byId = await get(server, "/api/security/assistant/incidents", MARIA);
    expect(byName.status).toBe(200);
    expect(byId.body).toEqual(byName.body);
    expect(resolve).toHaveBeenCalledWith(MARIA);
  });

  it("an SSO user with no nextcloudUsername resolves (by id and by username)", async () => {
    const { server, resolve } = app(f);
    for (const who of [SAM, "sam@example.com"]) {
      const res = await get(server, "/api/security/assistant/incidents", who);
      expect(res.status, who).toBe(200);
      expect(res.body.incidents.map((i: { id: string }) => i.id), who).toContain(INC_FRONT);
    }
    expect(resolve).toHaveBeenCalledWith(SAM);
  });
});

describe("DS-005 — Maria sees only `front`", () => {
  it("A1 omits the Stock room's incident and the threat; the owner sees all four", async () => {
    const { server } = app(f);
    const maria = await get(server, "/api/security/assistant/incidents", "maria");
    expect(maria.body.incidents.map((i: { id: string }) => i.id).sort()).toEqual([INC_FRONT, INC_OLD].sort());
    const owner = await get(server, "/api/security/assistant/incidents", "stefan");
    expect(owner.body.incidents.map((i: { id: string }) => i.id).sort()).toEqual([INC_BACK, INC_FRONT, INC_OLD, INC_THREAT].sort());
  });

  it("A2: a hidden incident answers exactly like a missing one", async () => {
    const { server } = app(f);
    const hidden = await get(server, `/api/security/assistant/incidents/${INC_BACK}`, "maria");
    const missing = await get(server, `/api/security/assistant/incidents/${MISSING}`, "maria");
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(hidden.body).toEqual({ error: { code: "INCIDENT_NOT_FOUND", message: "There is no such incident." } });
  });

  it("A3 omits back's rows and the threat; ?camera=<hidden> is the same empty page as ?camera=<unknown>", async () => {
    const { server } = app(f);
    const all = await get(server, "/api/security/assistant/events", "maria");
    expect(all.body.events.map((e: { source: string }) => e.source).sort()).toEqual(["Front door", "Site mode"]);
    const hidden = await get(server, "/api/security/assistant/events?camera=Back%20camera", "maria");
    const unknown = await get(server, "/api/security/assistant/events?camera=Garage", "maria");
    expect(hidden.body.events).toEqual([]);
    expect(hidden.body).toEqual(unknown.body);
    const owner = await get(server, "/api/security/assistant/events?camera=back%20CAMERA", "stefan");
    expect(owner.body.events.map((e: { source: string }) => e.source)).toEqual(["Back camera"]);
  });

  it("A4 hides an area made only of `back`", async () => {
    const { server } = app(f);
    const maria = await get(server, "/api/security/assistant/areas", "maria");
    expect(maria.body.areas.map((a: { name: string }) => a.name)).toEqual(["Shop floor"]);
    const owner = await get(server, "/api/security/assistant/areas", "stefan");
    expect(owner.body.areas.map((a: { name: string }) => a.name).sort()).toEqual(["Shop floor", "Stock room"]);
  });

  it("?area=<hidden> equals ?area=<unknown> on A1, A3 and A4", async () => {
    const { server } = app(f);
    for (const path of ["/api/security/assistant/incidents", "/api/security/assistant/events", "/api/security/assistant/areas"]) {
      const hidden = await get(server, `${path}?area=Stock%20room`, "maria");
      const unknown = await get(server, `${path}?area=Loading%20bay`, "maria");
      expect(hidden.status, path).toBe(200);
      expect(hidden.body, path).toEqual(unknown.body);
    }
  });

  it("area names match case-insensitively and trimmed", async () => {
    const { server } = app(f);
    const res = await get(server, "/api/security/assistant/incidents?area=%20%20shop%20FLOOR%20", "maria");
    expect(res.body.incidents.map((i: { id: string }) => i.id).sort()).toEqual([INC_FRONT, INC_OLD].sort());
  });

  it("threats appear only for owner and admin", async () => {
    const { server } = app(f);
    for (const who of ["stefan", "jordan"]) {
      const res = await get(server, "/api/security/assistant/events?kind=threat", who);
      expect(res.body.events.map((e: { what: string }) => e.what), who).toEqual(["sign-in warning"]);
    }
    expect((await get(server, "/api/security/assistant/events?kind=threat", "maria")).body.events).toEqual([]);
  });
});

// WARP-2977 P2b-2 x WARP-2979 P4: lock state is presence data (DS-019). A3 and A4 speak of door locks from P4 PR-4
// (§6.12.3) and read the dashboard's own scope: a person with Devices view gets the lock-only area, the lock among what
// covers an area and the lock's rows, exactly as the dashboard shows them; without it, a site without locks.
describe("door locks (DS-019) — A3 and A4 follow Devices view, never the camera grant", () => {
  const DOOR = "0a0a0a0a-0000-4000-8000-000000000009";
  const LOCK = "matter:4660/1";
  const withDevices = async (_userId: string) =>
    ({
      ...access("view"),
      features: [
        { moduleId: "security", level: "view" },
        { moduleId: "smart_home", level: "manage" },
      ],
    }) as unknown as EffectiveAccessResult;

  function lockWorld(): FakeSecurityPrisma {
    const shop = areaRows(SHOP, "Shop floor", "interior", ["front"]);
    const door = areaRows(DOOR, "Back door", "entry", []);
    const lockLink = (id: string, zoneId: string) => ({
      id, zoneId, sourceKind: "lock", sourceRef: LOCK, sourceLabel: "Back door lock", state: "active", origin: "person", stateSetBy: "person", stateChangedAt: T, evidence: null,
    });
    return world({
      securityZone: [shop.zone, door.zone],
      securityZoneLink: [...shop.links, lockLink("door-l0", DOOR), lockLink("shop-l9", SHOP)],
      securityEvent: [
        eventRow({ id: 1n, camera: "front", startedAt: T, summary: "Person seen by Front door", sourceRef: "front/1.5-abc", dedupeKey: "k1" }),
        eventRow({
          id: 7n, source: "matter_lock", kind: "lock_state", camera: null, labels: [], cameraZones: [], sourceRef: LOCK, dedupeKey: "k7",
          startedAt: new Date(T.getTime() + 30_000), endedAt: null, summary: "Back door lock unlocked",
        }),
      ],
      securityEventTriage: [],
      securityIncident: [],
      securityIncidentReason: [],
      securityIncidentAck: [],
    });
  }

  it.each(["stefan", "maria"])("A4 for %s, who holds Devices: the lock-only area, and the lock among what covers an area", async (who) => {
    f = lockWorld();
    const { server } = app(f, { resolve: withDevices });
    const res = await get(server, "/api/security/assistant/areas", who);
    expect(res.status).toBe(200);
    // The dashboard's scope for this very person shows them the lock: the tools read that same scope.
    const person = { id: who === "stefan" ? STEFAN : MARIA, role: who === "stefan" ? "owner" : "family" };
    expect((await securityScopeForPerson(f.client as unknown as PrismaClient, person, withDevices)).mayReadLocks).toBe(true);
    const byName = new Map(res.body.areas.map((a: { name: string; coveredBy: unknown }) => [a.name, a.coveredBy]));
    expect([...byName.keys()].sort()).toEqual(["Back door", "Shop floor"]);
    // No lock adapter running: the link's snapshot name, reporting unknown.
    expect(byName.get("Back door")).toEqual([{ source: "Back door lock", part: null, reporting: "unknown", linkedBy: "a person" }]);
    expect(byName.get("Shop floor")).toContainEqual({ source: "Back door lock", part: null, reporting: "unknown", linkedBy: "a person" });
  });

  it.each(["maria", "jordan"])("A4 for %s, without Devices: no lock-only area, and no lock among what covers an area", async (who) => {
    f = lockWorld();
    const { server } = app(f);
    const res = await get(server, "/api/security/assistant/areas", who);
    expect(res.status).toBe(200);
    expect(res.body.areas.map((a: { name: string }) => a.name)).toEqual(["Shop floor"]);
    expect(res.body.areas[0].coveredBy).toEqual([{ source: "Front door", part: null, reporting: "yes", linkedBy: "a person" }]);
    expect(JSON.stringify(res.body)).not.toMatch(/lock|Back door/i);
  });

  it.each(["stefan", "maria"])("A3 for %s, who holds Devices: the lock's row, also through the lock-only area", async (who) => {
    f = lockWorld();
    const { server } = app(f, { resolve: withDevices });
    const all = await get(server, "/api/security/assistant/events", who);
    expect(all.body.events.map((e: { source: string }) => e.source)).toEqual(["Door lock", "Front door"]);
    const door = await get(server, "/api/security/assistant/events?area=Back%20door", who);
    expect(door.body.events.map((e: { kind: string; source: string }) => [e.kind, e.source])).toEqual([["lock_state", "Door lock"]]);
    // The stored summary never passes through.
    expect(JSON.stringify(all.body)).not.toContain("Back door lock unlocked");
  });

  it.each(["maria", "jordan"])("A3 for %s, without Devices: no lock row, and the lock-only area answers like an unknown one", async (who) => {
    f = lockWorld();
    const { server } = app(f);
    const all = await get(server, "/api/security/assistant/events", who);
    expect(all.body.events.map((e: { source: string }) => e.source)).toEqual(["Front door"]);
    expect(JSON.stringify(all.body)).not.toMatch(/lock/i);
    const door = await get(server, "/api/security/assistant/events?area=Back%20door", who);
    const unknown = await get(server, "/api/security/assistant/events?area=Nowhere", who);
    expect(door.body.events).toEqual([]);
    expect(door.body).toEqual(unknown.body);
  });
});

describe("no person's name in any output (§6.12.5, D26)", () => {
  it("not the acknowledger, the mode-setter, a mode_changed summary or a threat's text", async () => {
    const { server } = app(f, { level: "manage" });
    const bodies: unknown[] = [];
    for (const who of ["stefan", "jordan", "maria"]) {
      for (const path of [
        "/api/security/assistant/incidents",
        `/api/security/assistant/incidents/${INC_FRONT}`,
        `/api/security/assistant/incidents/${INC_THREAT}`,
        "/api/security/assistant/events",
        "/api/security/assistant/areas",
      ]) {
        const res = await get(server, path, who);
        if (res.status === 200) bodies.push(res.body);
      }
    }
    expect(bodies.length).toBeGreaterThanOrEqual(13);
    const text = JSON.stringify(bodies).toLowerCase();
    expect(text).not.toContain("maria");
    expect(text).not.toContain("stefan");
    expect(text).not.toContain("jordan");
  });

  // Part A (WARP-2979, spec §6.12.5): the one stored text A2 passes through is Droplet's own summary. PR-2's
  // check keeps names out of it; this proves A2 adds none around it — "Maria" is seeded everywhere else
  // the incident stores a name or free text, and none of it reaches the tool.
  it("A2 with Droplet's summary: the summary reaches the tool; Maria, stored elsewhere in the incident, never does", async () => {
    withSummary(f, INC_FRONT, { narrativeModel: "maria-local:3b", narrativeError: "Maria's earlier try was refused" });
    Object.assign(f.world.securityIncident.find((r) => r.id === INC_FRONT)!, {
      verdict: "expected",
      verdictById: MARIA,
      verdictByName: "Maria",
      verdictAt: WRITTEN,
      verdictFirstAt: WRITTEN,
      verdictCodes: ["after_hours_presence"],
    });
    const { server } = app(f);
    for (const who of ["stefan", "jordan"]) {
      const res = await get(server, `/api/security/assistant/incidents/${INC_FRONT}`, who);
      expect(res.status, who).toBe(200);
      expect(res.body.incident.summaryByDroplet, who).toEqual({ text: SUMMARY, writtenAt: { at: WRITTEN.toISOString(), local: "10:24 PM" } });
      // Seeded: the acknowledger (name, client, note), the verdict-giver, the evidence's stored summary and
      // detail, the mode-setter, the model's id and the last error.
      expect(JSON.stringify(res.body).toLowerCase(), who).not.toContain("maria");
    }
  });

  it("the acknowledgement is its time only; the mode says why, not who", async () => {
    const { server } = app(f);
    const a2 = await get(server, `/api/security/assistant/incidents/${INC_FRONT}`, "stefan");
    expect(a2.body.incident.acknowledged).toEqual({ at: { at: new Date(T.getTime() + 300_000).toISOString(), local: "10:19 PM" } });
    expect(a2.body.incident.state).toBe("acknowledged");
    const a4 = await get(server, "/api/security/assistant/areas", "stefan");
    expect(a4.body.site).toMatchObject({ mode: "closed", why: "set by hand", hoursSet: true, timezone: "Europe/London" });
  });
});

describe("the shapes", () => {
  it("A1: plain words, local times, and the incident page", async () => {
    const { server } = app(f);
    const res = await get(server, "/api/security/assistant/incidents?limit=1", "maria");
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Europe/London");
    expect(res.body.period).toBeNull();
    expect(res.body.incidents).toEqual([
      {
        id: INC_FRONT,
        title: "Shop floor",
        severity: "alert",
        state: "acknowledged",
        codes: [{ code: "after_hours_presence", sentence: "A person was seen while the site was closed or set to away" }],
        first: { at: T.toISOString(), local: "10:14 PM" },
        last: { at: T.toISOString(), local: "10:14 PM" },
        events: 1,
        stillHappening: false,
        url: `/security/incidents/${INC_FRONT}`,
      },
    ]);
    expect(res.body.nextCursor).toMatch(/^\d+\.[0-9a-f-]{36}$/);
    const next = await get(server, `/api/security/assistant/incidents?limit=1&cursor=${res.body.nextCursor}`, "maria");
    expect(next.body.incidents.map((i: { id: string }) => i.id)).toEqual([INC_OLD]);
    expect(next.body.nextCursor).toBeNull();
  });

  it("A2: codes with evidence built from kinds, events with areas, nothing stored passed through", async () => {
    const { server } = app(f);
    const res = await get(server, `/api/security/assistant/incidents/${INC_FRONT}`, "maria");
    expect(res.status).toBe(200);
    expect(res.body.incident.codes).toEqual([
      {
        code: "after_hours_presence",
        sentence: "A person was seen while the site was closed or set to away",
        evidence: [{ at: { at: T.toISOString(), local: "10:14 PM" }, source: "Front door", what: "person seen", area: "Shop floor" }],
      },
    ]);
    expect(res.body.incident.events).toEqual([
      {
        at: { at: T.toISOString(), local: "10:14 PM" },
        until: { at: new Date(T.getTime() + 20_000).toISOString(), local: "10:14 PM" },
        kind: "detection",
        what: "person seen",
        source: "Front door",
        part: null,
        areas: ["Shop floor"],
      },
    ]);
    expect(res.body.incident).toMatchObject({ moreEvents: false, eventsRemoved: false, resolved: null, summaryByDroplet: null });
    expect(Object.keys(res.body.incident).sort()).toEqual(
      ["acknowledged", "codes", "events", "eventsRemoved", "first", "id", "last", "moreEvents", "resolved", "severity", "state", "stillHappening", "summaryByDroplet", "title", "url"].sort(),
    );
  });

  it("A3: a mode change says what the site became, not who changed it", async () => {
    const { server } = app(f);
    const res = await get(server, "/api/security/assistant/events?kind=mode_changed", "stefan");
    expect(res.body.events).toEqual([
      expect.objectContaining({ kind: "mode_changed", what: "site set to closed", source: "Site mode", areas: [] }),
    ]);
  });

  it("A3: label narrows to detections of that label", async () => {
    const { server } = app(f);
    const res = await get(server, "/api/security/assistant/events?label=person", "stefan");
    expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual(["detection", "detection"]);
    expect((await get(server, "/api/security/assistant/events?label=dog", "stefan")).body.events).toEqual([]);
  });

  it("A4: coverage per area, who linked it, whether it reports; suggestions only at manage", async () => {
    const { server } = app(f, { level: "view" });
    const owner = await get(server, "/api/security/assistant/areas?area=stock%20room", "stefan");
    expect(owner.body.areas).toEqual([
      {
        name: "Stock room",
        kind: "inside",
        lastActivity: { at: { at: new Date(T.getTime() + 60_000).toISOString(), local: "10:15 PM" }, what: "person seen", source: "Back camera" },
        openIncidents: 1,
        coveredBy: [{ source: "Back camera", part: null, reporting: "offline", linkedBy: "a person" }],
      },
    ]);
    expect(owner.body.suggestionsWaiting).toBe(0);
    const maria = await get(server, "/api/security/assistant/areas", "maria");
    expect(maria.body.suggestionsWaiting).toBeNull();
  });
});

// ── WARP-2979 P4 PR-4: door locks in the tools (DS-019: Security view AND Devices view) ──

describe("P4 PR-4 — door locks in security_search_events (A3) and security_zone_status (A4)", () => {
  const LOCK = "matter:4660/1";
  /** Devices (smart_home) view on top of Security view: may read locks. */
  const withDevices = async (_userId: string) => {
    const a = access("view");
    a.features = [...a.features, { moduleId: "smart_home", level: "view" }] as EffectiveAccessResult["features"];
    return a;
  };
  const lockRow = (id: bigint, at: Date, reading: string, observed: "live" | "polled") =>
    eventRow({
      id,
      source: "matter_lock",
      kind: "lock_state",
      camera: null,
      sourceRef: LOCK,
      dedupeKey: `matter_lock:4660/1:after:${id - 1n}:${reading}`,
      labels: [reading],
      score: null,
      startedAt: at,
      endedAt: null,
      // A stored summary names the lock (and could name more); `what` is rebuilt from the reading instead.
      summary: `Maria's door: ${reading}${observed === "polled" ? " (found when Droplet checked)" : ""}`,
      observed,
    });
  /**
   * The real resolver's §3 bypass: the owner's catalog holds every module, Devices included (the scope resolves an
   * owner like anyone else). Everyone else here: Security view only.
   */
  const ownerBypass = async (userId: string) => (userId === STEFAN ? withDevices(userId) : access("view"));
  const lockApp = (opts: AppOpts = {}) => app(f, { resolve: ownerBypass, ...opts });
  const known = (connected = true, readings: LockReadingsState = "current") => () => ({
    knownLocks: () => [{ ref: LOCK, name: "Back door lock", connected }],
    readingsState: () => readings,
  });

  beforeEach(() => {
    f.world.securityEvent.push(lockRow(10n, new Date(T.getTime() + 120_000), "unlocked", "live"), lockRow(11n, new Date(T.getTime() + 180_000), "locked", "polled"));
    // The Shop floor's door lock, linked by a person.
    f.world.securityZoneLink.push({
      id: "l-shop-lock",
      zoneId: SHOP,
      sourceKind: "lock",
      sourceRef: LOCK,
      sourceLabel: "Smart Lock (as linked)",
      state: "active",
      origin: "person",
      stateSetBy: "person",
      createdAt: T,
      stateChangedAt: T,
      evidence: null,
    });
  });

  it("A3 kind=lock_state: the lock's changes, newest first — the reading, the lock's name, its areas, and whether it was heard live", async () => {
    const { server } = lockApp({ locks: known() });
    const res = await get(server, "/api/security/assistant/events?kind=lock_state", "stefan");
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([
      {
        at: { at: new Date(T.getTime() + 180_000).toISOString(), local: "10:17 PM" },
        until: null,
        kind: "lock_state",
        what: "lock locked",
        source: "Back door lock",
        part: null,
        areas: ["Shop floor"],
        found: "when Droplet checked",
      },
      {
        at: { at: new Date(T.getTime() + 120_000).toISOString(), local: "10:16 PM" },
        until: null,
        kind: "lock_state",
        what: "lock unlocked",
        source: "Back door lock",
        part: null,
        areas: ["Shop floor"],
        found: "live",
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("Maria");
  });

  it("DS-019: without Devices view, kind=lock_state answers exactly as a kind with nothing in it — the same body", async () => {
    const { server } = lockApp({ locks: known() });
    for (const who of ["maria", "jordan"]) {
      const locks = await get(server, "/api/security/assistant/events?kind=lock_state&period=last_24h", who);
      const nothing = await get(server, "/api/security/assistant/events?kind=camera_online&period=last_24h", who);
      expect(locks.status, who).toBe(200);
      expect(locks.body, who).toEqual(nothing.body);
      expect(locks.body.events, who).toEqual([]);
    }
  });

  it("DS-019: the unfiltered search holds lock rows only for a viewer who may read locks — Devices view, not the camera grant", async () => {
    const lockKinds = (body: { events: Array<{ kind: string }> }) => body.events.filter((e) => e.kind === "lock_state").length;
    const { server } = lockApp({ locks: known() });
    expect(lockKinds((await get(server, "/api/security/assistant/events", "stefan")).body)).toBe(2);
    expect(lockKinds((await get(server, "/api/security/assistant/events", "maria")).body)).toBe(0);
    const devices = lockApp({ locks: known(), resolve: withDevices });
    expect(lockKinds((await get(devices.server, "/api/security/assistant/events", "maria")).body)).toBe(2);
  });

  it("only a lock event says how it was found: a camera row carries no `found`", async () => {
    const { server } = lockApp({ locks: known() });
    const res = await get(server, "/api/security/assistant/events?kind=detection", "stefan");
    expect(res.body.events.length).toBeGreaterThan(0);
    for (const e of res.body.events) expect(e).not.toHaveProperty("found");
  });

  it("with no lock adapter the lock's name is a plain 'Door lock', never the stored summary", async () => {
    const { server } = lockApp();
    const res = await get(server, "/api/security/assistant/events?kind=lock_state", "stefan");
    expect(res.body.events.map((e: { source: string }) => e.source)).toEqual(["Door lock", "Door lock"]);
  });

  it("A4: a person-linked lock covers its area — named, reporting from the lock adapter; hidden without Devices view", async () => {
    const shop = async (opts: AppOpts, who = "stefan") => {
      const { server } = lockApp(opts);
      const res = await get(server, "/api/security/assistant/areas?area=Shop%20floor", who);
      return res.body.areas[0].coveredBy as Array<{ source: string; part: string | null; reporting: string; linkedBy: string }>;
    };
    expect(await shop({ locks: known() })).toEqual([
      { source: "Front door", part: null, reporting: "yes", linkedBy: "a person" },
      { source: "Back door lock", part: null, reporting: "yes", linkedBy: "a person" },
    ]);
    expect((await shop({ locks: known(false) }))[1]!.reporting).toBe("offline");
    expect((await shop({ locks: () => ({ knownLocks: () => [], readingsState: () => "current" as const }) }))[1]).toMatchObject({ source: "Smart Lock (as linked)", reporting: "not set up" });
    // A last list the adapter can no longer confirm is not "yes": the /security header says it can't reach the locks.
    expect((await shop({ locks: known(true, "unreachable") }))[1]!.reporting).toBe("unknown");
    expect((await shop({}))[1]!.reporting).toBe("unknown");
    expect((await shop({ locks: known() }, "maria")).map((c) => c.source)).toEqual(["Front door"]);
  });
});

// Part A (WARP-2979, spec §6.12.3 A2): `summaryByDroplet` follows `narrativeVisibleTo` — as built by PR-2, a
// viewer-level rule: only a viewer who sees every camera AND may read threats — and is only ever a WRITTEN text.
describe("A2 summaryByDroplet", () => {
  const a2 = async (w: FakeSecurityPrisma, who: string, id = INC_FRONT) => {
    const res = await get(app(w).server, `/api/security/assistant/incidents/${id}`, who);
    expect(res.status, who).toBe(200);
    return res.body;
  };

  it("the owner and an admin get the written text and when, as a local time", async () => {
    withSummary(f, INC_FRONT);
    withSummary(f, INC_THREAT, { narrative: "A sign-in failed twice at 10:12 PM." });
    for (const who of ["stefan", "jordan"]) {
      expect((await a2(f, who)).incident.summaryByDroplet, who).toEqual({ text: SUMMARY, writtenAt: { at: WRITTEN.toISOString(), local: "10:24 PM" } });
      expect((await a2(f, who, INC_THREAT)).incident.summaryByDroplet.text, who).toBe("A sign-in failed twice at 10:12 PM.");
    }
  });

  it("🔴 a camera-limited viewer gets null — even for an incident wholly on her own camera — and her answer is the same byte for byte as with no summary", async () => {
    const without = await a2(world(), "maria");
    withSummary(f, INC_FRONT);
    const withIt = await a2(f, "maria");
    expect(withIt.incident.summaryByDroplet).toBeNull();
    expect(withIt).toEqual(without);
    // The SSO family member granted `front` too: same rule, same null.
    expect((await a2(f, "sam@example.com")).incident.summaryByDroplet).toBeNull();
  });

  it.each([
    ["pending — a Regenerate in flight keeps the old text", { narrativeState: "pending" }],
    ["pending, never written", { narrativeState: "pending", narrative: null, narrativeModel: null, narrativePromptVersion: null, narratedAt: null, narrativeAudience: null }],
    ["failed, with an earlier text", { narrativeState: "failed", narrativeError: "CHECK_FAILED:TIMES" }],
    ["expired, with an earlier text", { narrativeState: "expired" }],
    ["none", { narrativeState: "none", narrative: null, narrativeModel: null, narrativePromptVersion: null, narratedAt: null, narrativeAudience: null }],
  ])("null unless written: %s", async (_label, over) => {
    withSummary(f, INC_FRONT, over);
    expect((await a2(f, "stefan")).incident.summaryByDroplet).toBeNull();
  });

  it("null while summaries are switched off, and back when they are on", async () => {
    withSummary(f, INC_FRONT);
    f.world.securityAiSettings.push({ id: "singleton", linking: "link_and_suggest", summaries: "off", version: 1, updatedById: null, updatedAt: T });
    expect((await a2(f, "stefan")).incident.summaryByDroplet).toBeNull();
    f.world.securityAiSettings[0]!.summaries = "on";
    expect((await a2(f, "stefan")).incident.summaryByDroplet).not.toBeNull();
  });

  it("an unreadable summaries setting shows none, never a 503", async () => {
    withSummary(f, INC_FRONT);
    f.failOn("securityAiSettings", "findUnique", undefined, { always: true });
    expect((await a2(f, "stefan")).incident.summaryByDroplet).toBeNull();
  });
});

// WARP-3194 items 1 and 2: A4 could not resume past the areas it trimmed, and it queried every visible area
// (two queries each, all at once) before trimming.
describe("A4 pages through the areas, reading only what a page holds (WARP-3194)", () => {
  const LABEL = "A camera with a very long display name that goes on".padEnd(60, "x");
  const name = (i: number) => `Area ${String(i).padStart(3, "0")}`;
  const cap = 8_000 - '{"type":"security_areas",}'.length;

  /** `visible` areas on `front` (Maria's camera) and `hidden` ones on `back` alone, their names interleaved. */
  function areaWorld(visible: number, hidden: number): FakeSecurityPrisma {
    const rows = [
      ...Array.from({ length: visible }, (_, i) => areaRows(`0c0c0c0c-0000-4000-8000-${String(i).padStart(12, "0")}`, name(2 * i), "interior", ["front"])),
      ...Array.from({ length: hidden }, (_, i) => areaRows(`0d0d0d0d-0000-4000-8000-${String(i).padStart(12, "0")}`, name(2 * i + 1), "interior", ["back"])),
    ];
    return world({
      camera: [{ id: "cam-front", name: "front", displayName: LABEL }, { id: "cam-back", name: "back", displayName: "Back camera" }],
      securityZone: rows.map((r) => r.zone),
      securityZoneLink: rows.flatMap((r) => r.links),
    });
  }

  /** Every page from offset 0, following nextOffset. */
  async function pages(w: FakeSecurityPrisma, who: string) {
    const { server } = app(w, { level: "manage" });
    const out: Array<Record<string, unknown> & { areas: Array<{ name: string }>; moreAreas: number; nextOffset: number | null }> = [];
    let offset: number | null = 0;
    for (let i = 0; offset !== null && i < 20; i++) {
      const res = await get(server, `/api/security/assistant/areas?offset=${offset}`, who);
      expect(res.status).toBe(200);
      out.push(res.body);
      offset = res.body.nextOffset;
    }
    expect(offset).toBeNull();
    return out;
  }

  it("nextOffset resumes right after the last area shown: every area once, in order, each page under the cap", async () => {
    const all = await pages(areaWorld(40, 0), "stefan");
    expect(all.length).toBeGreaterThan(1);
    expect(all.flatMap((b) => b.areas.map((a) => a.name))).toEqual(Array.from({ length: 40 }, (_, i) => name(2 * i)));
    let seen = 0;
    for (const b of all) {
      seen += b.areas.length;
      expect(b.moreAreas).toBe(40 - seen);
      expect(b.nextOffset).toBe(seen < 40 ? seen : null);
      expect(JSON.stringify(b).length).toBeLessThan(cap);
    }
  });

  it("an offset past the end is an empty page with nothing more; outside 0–64 it is 400", async () => {
    const { server } = app(areaWorld(40, 0));
    for (const offset of [40, 64]) {
      const res = await get(server, `/api/security/assistant/areas?offset=${offset}`, "stefan");
      expect(res.status, String(offset)).toBe(200);
      expect(res.body, String(offset)).toMatchObject({ areas: [], moreAreas: 0, nextOffset: null });
    }
    for (const offset of ["65", "-1", "1.5", "x"]) {
      const res = await get(server, `/api/security/assistant/areas?offset=${offset}`, "stefan");
      expect(res.status, offset).toBe(400);
      expect(res.body.error.code, offset).toBe("BAD_REQUEST");
    }
  });

  // tools-core cannot import the orchestrator's limit, so the tool's `offset` ceiling (OFFSET_MAX) is a literal
  // there. This runs the real tool and ties the two: it refuses an offset exactly where the route would.
  it("security_zone_status's offset ceiling is A4's (SECURITY_ZONE_ACTIVE_LIMIT)", async () => {
    const tool = getTool("security_zone_status")!;
    const body = { site: { mode: "closed" }, areas: [], moreAreas: 0, nextOffset: null, suggestionsWaiting: null };
    const orchestratorGet = vi.fn().mockImplementation(async () => new globalThis.Response(JSON.stringify(body), { status: 200 }));
    const ctx = { http: { orchestrator: { get: orchestratorGet } }, signal: new AbortController().signal } as unknown as ToolContext;
    expect((await tool.handler({ offset: SECURITY_ZONE_ACTIVE_LIMIT }, ctx)).ok).toBe(true);
    expect(orchestratorGet).toHaveBeenCalledTimes(1);
    const past = await tool.handler({ offset: SECURITY_ZONE_ACTIVE_LIMIT + 1 }, ctx);
    expect(past.ok).toBe(false);
    expect(orchestratorGet).toHaveBeenCalledTimes(1);
  });

  it("?area= and offset together: the one area, then nothing", async () => {
    const { server } = app(areaWorld(40, 0));
    const first = await get(server, `/api/security/assistant/areas?area=${encodeURIComponent(name(6))}&offset=0`, "stefan");
    expect(first.body).toMatchObject({ areas: [{ name: name(6) }], moreAreas: 0, nextOffset: null });
    const past = await get(server, `/api/security/assistant/areas?area=${encodeURIComponent(name(6))}&offset=1`, "stefan");
    expect(past.body).toMatchObject({ areas: [], moreAreas: 0, nextOffset: null });
  });

  it("🔴 DS-005: hidden areas move no count, no offset and no page — Maria's pages are byte for byte a site's without them", async () => {
    const withHidden = await pages(areaWorld(40, 20), "maria");
    const without = await pages(areaWorld(40, 0), "maria");
    expect(withHidden.length).toBeGreaterThan(1);
    expect(withHidden).toEqual(without);
    expect(JSON.stringify(withHidden)).not.toContain("Back camera");
    // A forged offset reads her areas only: past them it is the same empty page as on a site without hidden ones.
    const a = app(areaWorld(40, 20)).server;
    const b = app(areaWorld(40, 0)).server;
    for (const offset of [20, 39, 40, 45, 59, 60, 64]) {
      const x = await get(a, `/api/security/assistant/areas?offset=${offset}`, "maria");
      const y = await get(b, `/api/security/assistant/areas?offset=${offset}`, "maria");
      expect(x.body, String(offset)).toEqual(y.body);
    }
    // The owner, who sees them, pages through all sixty.
    const owner = await pages(areaWorld(40, 20), "stefan");
    const everyName = [...Array.from({ length: 40 }, (_, i) => name(2 * i)), ...Array.from({ length: 20 }, (_, i) => name(2 * i + 1))].sort();
    expect(owner.flatMap((p) => p.areas.map((x) => x.name))).toEqual(everyName);
  });

  /** Count the per-area reads A4 makes, and how many run at once. */
  function probeReads(w: FakeSecurityPrisma) {
    const probe = { counts: 0, events: 0, inFlight: 0, peak: 0 };
    const wrap = (table: "securityIncident" | "securityEvent", method: "count" | "findMany", tally: "counts" | "events") => {
      const delegate = w.client[table] as Record<string, (args: unknown) => Promise<unknown>>;
      const real = delegate[method]!.bind(delegate);
      delegate[method] = async (args: unknown) => {
        probe[tally]++;
        probe.inFlight++;
        probe.peak = Math.max(probe.peak, probe.inFlight);
        try {
          await new Promise((r) => setImmediate(r));
          return await real(args);
        } finally {
          probe.inFlight--;
        }
      };
    };
    wrap("securityIncident", "count", "counts");
    wrap("securityEvent", "findMany", "events");
    return probe;
  }

  it("reads only the areas the page can hold, a few at a time — not every visible area at once", async () => {
    const w = areaWorld(40, 0);
    const probe = probeReads(w);
    const res = await get(app(w).server, "/api/security/assistant/areas", "stefan");
    const n = res.body.areas.length;
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(40);
    // One count and one latest-event read per area read; at most one batch past the last area that fits.
    expect(probe.counts).toBeLessThanOrEqual(n + AREA_READ_BATCH);
    expect(probe.events).toBe(probe.counts);
    // Two reads per area in flight, a batch at a time.
    expect(probe.peak).toBeLessThanOrEqual(2 * AREA_READ_BATCH);
    expect(probe.peak).toBeGreaterThan(1);
  });

  it("…and the page is exactly what fitting every area would give: each area's own answer, as many as fit", async () => {
    const w = areaWorld(40, 0);
    const { server } = app(w);
    const res = await get(server, "/api/security/assistant/areas", "stefan");
    const n = res.body.areas.length;
    const own = async (i: number) => (await get(server, `/api/security/assistant/areas?area=${encodeURIComponent(name(2 * i))}`, "stefan")).body.areas[0];
    for (let i = 0; i < n; i++) expect(res.body.areas[i], name(2 * i)).toEqual(await own(i));
    expect(JSON.stringify(res.body).length).toBeLessThanOrEqual(assistantBodyBudget());
    // One more area would not have fitted.
    const more = { ...res.body, areas: [...res.body.areas, await own(n)], moreAreas: res.body.moreAreas - 1, nextOffset: n + 1 < 40 ? n + 1 : null };
    expect(JSON.stringify(more).length).toBeGreaterThan(assistantBodyBudget());
  });
});

describe("A4 reporting, honestly", () => {
  const stockCoverage = async (status: CameraStatusSource) => {
    const { server } = app(f, { cameraStatus: status });
    const res = await get(server, "/api/security/assistant/areas?area=Stock%20room", "stefan");
    return res.body.areas[0].coveredBy[0].reporting as string;
  };

  it("detection switched off is neither reporting nor offline", async () => {
    expect(await stockCoverage(() => new Map([[null, { health: "online" as const }], ["back", { health: "disabled" as const }]]))).toBe("detection off");
  });

  it("the camera system down makes every camera offline, whatever its own last word", async () => {
    expect(await stockCoverage(() => new Map([[null, { health: "offline" as const }], ["back", { health: "online" as const }]]))).toBe("offline");
  });

  it("no reading since Droplet started is unknown — never a guess either way", async () => {
    expect(await stockCoverage(() => new Map())).toBe("unknown");
  });

  it("a link to a camera Droplet does not have is not set up", async () => {
    f = world({ camera: [{ id: "cam-front", name: "front", displayName: "Front door" }] });
    expect(await stockCoverage(ALL_ONLINE)).toBe("not set up");
  });
});

describe("periods", () => {
  it("last_night with hours set: from this evening's close to now, in the site zone", async () => {
    const { server } = app(f);
    const res = await get(server, "/api/security/assistant/incidents?period=last_night", "stefan");
    expect(res.status).toBe(200);
    expect(res.body.period).toEqual({
      from: { at: "2026-09-23T16:00:00.000Z", local: "5:00 PM" },
      to: { at: NOW.toISOString(), local: "10:30 PM" },
      label: "last night",
    });
    expect(res.body.incidents.map((i: { id: string }) => i.id).sort()).toEqual([INC_BACK, INC_FRONT, INC_THREAT].sort());
  });

  it("last_night without hours: 6 PM yesterday to 8 AM today, in the workspace's zone", async () => {
    f = world({ securitySiteHours: [{ id: "singleton", state: "not_set", timezone: null, version: 0 }], workspace: [{ id: 1, tz: "Europe/London" }] });
    const { server } = app(f);
    const res = await get(server, "/api/security/assistant/events?period=last_night", "stefan");
    expect(res.status).toBe(200);
    expect(res.body.period.from.at).toBe("2026-09-22T17:00:00.000Z");
    expect(res.body.period.to.at).toBe("2026-09-23T07:00:00.000Z");
    expect(res.body.events).toEqual([]);
  });

  it("today with no site zone → 400 NO_SITE_TIMEZONE", async () => {
    f = world({ securitySiteHours: [{ id: "singleton", state: "not_set", timezone: null, version: 0 }] });
    const { server } = app(f);
    const res = await get(server, "/api/security/assistant/incidents?period=today", "stefan");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NO_SITE_TIMEZONE");
  });

  // WARP-3194 item 3: hours that cannot be evaluated used to cost the tools their zone altogether.
  describe("opening hours that can't be read (WARP-3194)", () => {
    const office = officeHours("Europe/London");
    /** An unknown site zone, or one weekday row gone: either way `loadSiteHours` answers ok:false. */
    const unreadable = (how: "unknown zone" | "a weekday missing", siteZone: string, workspaceTz: string | null) =>
      world({
        securitySiteHours: [{ ...office.header, timezone: how === "unknown zone" ? "Mars/Olympus" : siteZone }],
        securitySchedule: how === "a weekday missing" ? office.days.slice(1) : office.days,
        workspace: workspaceTz ? [{ id: 1, tz: workspaceTz }] : [],
      });

    it("an unknown site zone falls back to the workspace's: today answers, in that zone, on A1 and A3", async () => {
      f = unreadable("unknown zone", "", "Europe/London");
      const { server } = app(f);
      for (const path of ["/api/security/assistant/incidents?period=today", "/api/security/assistant/events?period=today"]) {
        const res = await get(server, path, "stefan");
        expect(res.status, path).toBe(200);
        expect(res.body.timezone, path).toBe("Europe/London");
        expect(res.body.period.from, path).toEqual({ at: "2026-09-22T23:00:00.000Z", local: "12:00 AM" });
      }
    });

    it("a site zone the runtime knows is kept when only the rows are broken — the workspace's never replaces it", async () => {
      f = unreadable("a weekday missing", "America/New_York", "Europe/London");
      const res = await get(app(f).server, "/api/security/assistant/incidents?period=today", "stefan");
      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe("America/New_York");
      expect(res.body.period.from.at).toBe("2026-09-23T04:00:00.000Z");
    });

    it("last_night reads as if no hours were set: 6 PM yesterday to 8 AM today, in the fallback zone", async () => {
      f = unreadable("unknown zone", "", "Europe/London");
      const res = await get(app(f).server, "/api/security/assistant/incidents?period=last_night", "stefan");
      expect(res.status).toBe(200);
      expect(res.body.period.from.at).toBe("2026-09-22T17:00:00.000Z");
      expect(res.body.period.to.at).toBe("2026-09-23T07:00:00.000Z");
    });

    it("no zone known at all: today is still 400 NO_SITE_TIMEZONE, never a guessed zone", async () => {
      f = unreadable("unknown zone", "", null);
      const res = await get(app(f).server, "/api/security/assistant/incidents?period=today", "stefan");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("NO_SITE_TIMEZONE");
    });

    it("A4 answers instead of 503: the mode is unknown and says why, the areas are what they were, times in the fallback zone", async () => {
      const readable = await get(app(world()).server, "/api/security/assistant/areas", "stefan");
      f = unreadable("unknown zone", "", "Europe/London");
      const res = await get(app(f).server, "/api/security/assistant/areas", "stefan");
      expect(res.status).toBe(200);
      expect(res.body.site).toEqual({ mode: "unknown", why: "opening hours can't be read", until: null, hoursSet: true, timezone: "Europe/London" });
      expect(res.body.areas).toEqual(readable.body.areas);
      // And with no zone known either: still an answer, its times without a zone.
      f = unreadable("unknown zone", "", null);
      const bare = await get(app(f).server, "/api/security/assistant/areas", "stefan");
      expect(bare.status).toBe(200);
      expect(bare.body.site).toMatchObject({ mode: "unknown", timezone: null });
    });
  });

  it("a period keeps only incidents whose VISIBLE span meets it", async () => {
    // Incident …0005's stored span reaches into last night only through `back`; Maria sees only `front`,
    // whose activity ended the night before (21 Sep, 23:00–23:05).
    f = world();
    f.world.securityIncident.push(
      incident("1b1b1b1b-0000-4000-8000-000000000005", {
        zoneId: SHOP, zoneName: "Shop floor", zoneKind: "interior", cameras: ["front", "back"], reasonCodes: ["after_hours_presence"],
        countsByCamera: { front: { person: 1 }, back: { person: 1 } },
        firstActivityAt: new Date("2026-09-21T23:00:00Z"), lastActivityAt: T,
        spanByCamera: { front: { first: "2026-09-21T23:00:00.000Z", last: "2026-09-21T23:05:00.000Z" }, back: { first: T.toISOString(), last: T.toISOString() } },
      }),
    );
    f.world.securityIncidentReason.push(reason("1b1b1b1b-0000-4000-8000-000000000005", "after_hours_presence", "front", "alert", 9n));
    const { server } = app(f);
    const maria = await get(server, "/api/security/assistant/incidents?period=last_night", "maria");
    expect(maria.body.incidents.map((i: { id: string }) => i.id)).toEqual([INC_FRONT]);
    const owner = await get(server, "/api/security/assistant/incidents?period=last_night", "stefan");
    expect(owner.body.incidents.map((i: { id: string }) => i.id)).toContain("1b1b1b1b-0000-4000-8000-000000000005");
  });

  // Review #2420 (item 1): the period is judged on HER span in the query itself — never paged on the stored span
  // and filtered after. Otherwise a hidden camera's activity pulls an incident into the page, the page carries a
  // cursor, and following it returns nothing: the cursor alone says a hidden camera was active.
  it("🔴 a hidden camera's activity in the window changes nothing she can read — every page, body for body, and no empty page with a cursor", async () => {
    const X = "1b1b1b1b-0000-4000-8000-000000000006";
    // X: front at 2 PM London (before last night), and — in world A only — back at 10:20 PM (inside it).
    const worldWith = (backInWindow: boolean) => {
      const w = world();
      const frontSpan = { first: "2026-09-23T13:00:00.000Z", last: "2026-09-23T13:05:00.000Z" };
      const back = new Date("2026-09-23T21:20:00Z");
      w.world.securityIncident.push(
        incident(X, {
          zoneId: SHOP, zoneName: "Shop floor", zoneKind: "interior",
          cameras: backInWindow ? ["back", "front"] : ["front"],
          reasonCodes: ["after_hours_presence"],
          countsByCamera: backInWindow ? { front: { person: 1 }, back: { person: 1 } } : { front: { person: 1 } },
          firstActivityAt: new Date(frontSpan.first),
          lastActivityAt: backInWindow ? back : new Date(frontSpan.last),
          spanByCamera: backInWindow ? { front: frontSpan, back: { first: back.toISOString(), last: back.toISOString() } } : { front: frontSpan },
        }),
      );
      w.world.securityIncidentReason.push(reason(X, "after_hours_presence", "front", "alert", 11n));
      return w;
    };
    const pages = async (w: FakeSecurityPrisma) => {
      const { server } = app(w);
      const out: unknown[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < 10; n++) {
        const res = await get(server, `/api/security/assistant/incidents?period=last_night&limit=1${cursor ? `&cursor=${cursor}` : ""}`, "maria");
        expect(res.status).toBe(200);
        // Never an empty page that still carries a cursor.
        if (res.body.incidents.length === 0) expect(res.body.nextCursor).toBeNull();
        out.push(res.body);
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      return out;
    };
    const a = await pages(worldWith(true));
    const b = await pages(worldWith(false));
    expect(a).toEqual(b);
    // And X is in neither: her own span (front, 2 PM) never meets last night.
    expect(JSON.stringify(a)).not.toContain(X);
  });

  it("bad from/to → 400 BAD_REQUEST with the route's message", async () => {
    const { server } = app(f);
    const res = await get(server, "/api/security/assistant/events?from=2026-09-22T21:00:00", "stefan");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
    expect(res.body.error.message).toMatch(/offset/);
  });
});

describe("failure and size", () => {
  it.each([
    ["/api/security/assistant/incidents", "securityIncident", "findMany"],
    [`/api/security/assistant/incidents/${INC_FRONT}`, "securityIncident", "findUnique"],
    ["/api/security/assistant/events", "securityEvent", "findMany"],
    ["/api/security/assistant/areas", "securityZone", "findMany"],
    ["/api/security/assistant/patterns?area=Shop%20floor", "securityBaselineBuild", "findFirst"],
  ] as const)("%s: a database error is 503, never an empty 200", async (path, table, method) => {
    f.failOn(table, method, undefined, { always: true });
    const { server } = app(f);
    const res = await get(server, path, "stefan");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: "SECURITY_UNAVAILABLE", message: "Security can't be read right now." } });
  });

  /**
   * The largest answers: 40 areas, 80 events, 40 incidents. `mixed` adds `back` to every area and incident
   * (40 more events, its activity 30 s after front's) — a camera Maria, granted only `front`, can't see.
   */
  function bigWorld(mixed = false) {
    const long = "A camera with a very long display name that goes on".padEnd(60, "x");
    const areaName = (i: number) => `Area number ${i} with a long name that fills it`.padEnd(60, "y");
    const areas = Array.from({ length: 40 }, (_, i) =>
      areaRows(`0b0b0b0b-0000-4000-8000-${String(i).padStart(12, "0")}`, areaName(i), "interior", mixed ? ["front", "front/driveway_left_side", "back"] : ["front", "front/driveway_left_side"]),
    );
    const at = (i: number) => new Date(T.getTime() - i * 60_000);
    const events = [
      ...Array.from({ length: 80 }, (_, i) =>
        eventRow({ id: BigInt(100 + i), camera: "front", cameraZones: ["driveway_left_side", "porch_steps_area"], startedAt: at(i), sourceRef: `front/${100 + i}.5-a`, dedupeKey: `big${i}` }),
      ),
      ...(mixed
        ? Array.from({ length: 40 }, (_, i) =>
            eventRow({ id: BigInt(300 + i), camera: "back", startedAt: new Date(at(i).getTime() + 30_000), sourceRef: `back/${300 + i}.5-a`, dedupeKey: `bigb${i}` }),
          )
        : []),
    ];
    const incidents = Array.from({ length: 40 }, (_, i) =>
      incident(`2c2c2c2c-0000-4000-8000-${String(i).padStart(12, "0")}`, {
        zoneId: areas[0]!.zone.id, zoneName: areaName(0), zoneKind: "interior", cameras: mixed ? ["front", "back"] : ["front"], reasonCodes: ["after_hours_presence"],
        countsByCamera: mixed ? { front: { person: 3 }, back: { person: 2 } } : { front: { person: 3 } },
        firstActivityAt: at(i),
        lastActivityAt: mixed ? new Date(at(i).getTime() + 30_000) : at(i),
        ...(mixed
          ? { spanByCamera: { front: { first: at(i).toISOString(), last: at(i).toISOString() }, back: { first: new Date(at(i).getTime() + 30_000).toISOString(), last: new Date(at(i).getTime() + 30_000).toISOString() } } }
          : {}),
      }),
    );
    f = world({
      camera: [{ id: "cam-front", name: "front", displayName: long }, { id: "cam-back", name: "back", displayName: "Back camera" }],
      securityZone: areas.map((a) => a.zone),
      securityZoneLink: areas.flatMap((a) => a.links),
      securityEvent: events,
      securityEventTriage: events.map((e) => ({ eventId: e.id, outcome: "grouped", incidentId: incidents[0]!.id, alsoZoneIds: [] })),
      securityIncident: incidents,
      securityIncidentReason: incidents.flatMap((i, n) => [
        reason(i.id, "after_hours_presence", "front", "alert", BigInt(100 + n)),
        ...(mixed ? [reason(i.id, "after_hours_presence", "back", "alert", BigInt(300 + n))] : []),
      ]),
      securityIncidentAck: [],
    });
    return { incidents };
  }

  it("every answer at its largest stays under the 8,000-char tool cap, with a cursor to resume", async () => {
    const { incidents } = bigWorld();
    const { server } = app(f);
    const cap = 8_000 - '{"type":"security_incidents",}'.length;
    const a1 = await get(server, "/api/security/assistant/incidents?limit=25", "stefan");
    const a2 = await get(server, `/api/security/assistant/incidents/${incidents[0]!.id}`, "stefan");
    const a3 = await get(server, "/api/security/assistant/events?limit=40", "stefan");
    const a4 = await get(server, "/api/security/assistant/areas", "stefan");
    for (const [name, res] of [["A1", a1], ["A2", a2], ["A3", a3], ["A4", a4]] as const) {
      expect(res.status, name).toBe(200);
      expect(JSON.stringify(res.body).length, name).toBeLessThan(cap);
    }
    // Cut short by size, never silently: each says where to resume, or how much it left out.
    expect(a1.body.incidents.length).toBeGreaterThan(5);
    expect(a1.body.nextCursor).not.toBeNull();
    expect(a2.body.incident.moreEvents).toBe(true);
    expect(a3.body.events.length).toBeGreaterThan(5);
    expect(a3.body.nextCursor).not.toBeNull();
    expect(a4.body.moreAreas).toBeGreaterThan(0);
    // …and the cursor resumes exactly after the last item shown.
    const a3next = await get(server, `/api/security/assistant/events?limit=40&cursor=${a3.body.nextCursor}`, "stefan");
    const seen = a3.body.events.length;
    expect(a3next.body.events[0].at.at).toBe(new Date(T.getTime() - seen * 60_000).toISOString());
  });

  // Part A: the summary counts toward the same budget, and it is the EVENTS that give way — never the summary.
  it("A2 with a summary at its longest (700 chars): under the cap, the summary whole, fewer events and moreEvents", async () => {
    const { incidents } = bigWorld();
    const { server } = app(f);
    const cap = 8_000 - '{"type":"security_incident",}'.length;
    const path = `/api/security/assistant/incidents/${incidents[0]!.id}`;
    const before = await get(server, path, "stefan");
    const longest = "A person was seen at the front door while the site was closed, and stayed for a while. ".repeat(9).slice(0, 700).trim();
    withSummary(f, incidents[0]!.id, { narrative: longest });
    const after = await get(server, path, "stefan");
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body).length).toBeLessThan(cap);
    expect(after.body.incident.summaryByDroplet.text).toBe(longest);
    expect(after.body.incident.moreEvents).toBe(true);
    expect(after.body.incident.events.length).toBeGreaterThan(0);
    expect(after.body.incident.events.length).toBeLessThan(before.body.incident.events.length);
  });

  // #2420 review 12: the camera-limited viewer takes a different path (her own SQL page, the partial view),
  // and her answers are sized and resumed the same way — without `back` in any of them.
  it("…and for a camera-limited viewer too: under the cap, a cursor that resumes after her last item, nothing of `back`", async () => {
    const { incidents } = bigWorld(true);
    const { server } = app(f);
    const cap = 8_000 - '{"type":"security_incidents",}'.length;
    const a1 = await get(server, "/api/security/assistant/incidents?limit=25", "maria");
    const a2 = await get(server, `/api/security/assistant/incidents/${incidents[0]!.id}`, "maria");
    const a3 = await get(server, "/api/security/assistant/events?limit=40", "maria");
    const a4 = await get(server, "/api/security/assistant/areas", "maria");
    for (const [name, res] of [["A1", a1], ["A2", a2], ["A3", a3], ["A4", a4]] as const) {
      expect(res.status, name).toBe(200);
      expect(JSON.stringify(res.body).length, name).toBeLessThan(cap);
      expect(JSON.stringify(res.body), name).not.toContain("Back camera");
    }
    expect(a1.body.incidents.length).toBeGreaterThan(5);
    expect(a1.body.nextCursor).not.toBeNull();
    expect(a2.body.incident.moreEvents).toBe(true);
    expect(a3.body.events.length).toBeGreaterThan(5);
    expect(a3.body.nextCursor).not.toBeNull();
    // Her times are front's: the first incident's last activity is T, not back's T + 30 s.
    expect(a1.body.incidents[0].last.at).toBe(T.toISOString());
    // A1 resumes exactly after her last incident, and A3 after her last event.
    const shown = a1.body.incidents.length;
    const a1next = await get(server, `/api/security/assistant/incidents?limit=25&cursor=${a1.body.nextCursor}`, "maria");
    expect(a1next.status).toBe(200);
    expect(a1next.body.incidents[0].id).toBe(incidents[shown]!.id);
    const a3next = await get(server, `/api/security/assistant/events?limit=40&cursor=${a3.body.nextCursor}`, "maria");
    expect(a3next.body.events[0].at.at).toBe(new Date(T.getTime() - a3.body.events.length * 60_000).toISOString());
  });
});

// ── WARP-2980 (ADR-059 P5 PR-E, spec §6.18) — A5 ────────────────────────────

/** An area made of `front` AND `back`: Maria sees it, but not every camera behind it. */
const LOADING = "0c0c0c0c-0000-4000-8000-000000000003";
/** Wednesday 2 AM in London: nobody seen at this hour on any weekday. */
const AT_2AM = "2026-09-23T02:00:00+01:00";
/** Wednesday 2 PM in London: someone in the Stock room on 18 of 20 weekdays. */
const AT_2PM = "2026-09-23T14:00:00+01:00";
const OWNER_SCOPE = { visibleCameras: "all" as const, mayReadThreats: true, mayReadLocks: false };
const enc = encodeURIComponent;

/** Expected activity, as route 33 stores it: a person's own reason and name — neither may reach the tool. */
function expectedActivity(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    targetKind: "area",
    zoneId: STOCK,
    camera: null,
    label: "person",
    days: "weekdays",
    hourFrom: 1,
    hourCount: 3,
    codes: ["out_of_place"],
    reason: "Maria restocks the shelves",
    createdById: MARIA,
    createdByName: "Maria",
    createdAt: T,
    expiresAt: new Date("2026-10-23T09:00:00Z"),
    state: "active",
    ...over,
  };
}

function patternWorld(o: { sources?: Array<{ camera: string; state: "learning" | "active" | "stale" }>; build?: boolean; over?: Partial<FakeWorld> } = {}) {
  const shop = areaRows(SHOP, "Shop floor", "interior", ["front"]);
  const stock = areaRows(STOCK, "Stock room", "interior", ["back"]);
  const loading = areaRows(LOADING, "Loading bay", "entry", ["front", "back"]);
  const busyAfternoon: BaselineKeyFixture["at"] = (dayType, hour) =>
    dayType === "weekday" && hour === 14 ? { daysWithEvent: 18, eventCount: 60, dwellSamples: 40, durationP99Sec: 300 } : {};
  const b = baselineRows({
    keys: [
      { zoneKey: `area:${SHOP}`, cameras: ["front"] },
      { zoneKey: `area:${STOCK}`, cameras: ["back"], at: busyAfternoon },
      { zoneKey: `area:${LOADING}`, cameras: ["back", "front"] },
      { zoneKey: "camera:front", cameras: ["front"] },
      { zoneKey: "camera:back", cameras: ["back"] },
    ],
    sources: o.sources ?? [
      { camera: "back", state: "active" },
      { camera: "front", state: "active" },
    ],
  });
  return world({
    securityZone: [shop.zone, stock.zone, loading.zone],
    securityZoneLink: [...shop.links, ...stock.links, ...loading.links],
    ...(o.build === false ? {} : { securityBaselineBuild: [b.build], securityBaselineCell: b.cells }),
    securityBaselineSource: b.sources,
    securitySuppression: [],
    ...o.over,
  });
}

const patterns = (s: express.Express, query: string, who = "stefan") => get(s, `/api/security/assistant/patterns?${query}`, who);

/** The owner's own explanation — what A5 projects (the numbers are PR-A's, never recomputed here). */
async function ownerCell(zoneId: string, at: string) {
  const r = await explainSecurityPattern(f.client as unknown as PrismaClient, OWNER_SCOPE, { zoneId, at: new Date(at) }, NOW);
  if (r.status !== "ok" || !r.view.cell) throw new Error(`fixture: the owner's explanation of ${zoneId} must be ok with a cell (${r.status})`);
  return r.view.cell;
}

describe("WARP-2980 PR-E — A5: what normal looks like, with the acting person's scope", () => {
  it("the owner, the Stock room at 2 AM on a weekday: never seen then, so it would be flagged — and it is not live yet", async () => {
    f = patternWorld();
    const { server, resolve } = app(f);
    const res = await patterns(server, `area=stock%20ROOM&at=${enc(AT_2AM)}`);
    expect(res.status).toBe(200);
    const cell = await ownerCell(STOCK, AT_2AM);
    expect(cell.rarity.wouldFlag).toBe(true);
    expect(res.body).toEqual({
      timezone: "Europe/London",
      at: { at: "2026-09-23T01:00:00.000Z", local: "2:00 AM" },
      place: { name: "Stock room", kind: "area" },
      learning: { state: "ready", daysObserved: 20, daysNeeded: 14 },
      usual: {
        seenOnDays: 0,
        ofDays: 20,
        around: "2 AM",
        dayType: "weekdays",
        typicalPerHour: Number(cell.volume.typicalPerHour!.toPrecision(2)),
        longestUsualVisitSec: null,
        enoughData: true,
      },
      why: null,
      wouldFlag: { notUsual: true, busierFrom: cell.volume.flagsFrom },
      expected: [],
      moreExpected: 0,
      live: false,
    });
    // Owners bypass the level: the resolver is never asked about them.
    expect(resolve).not.toHaveBeenCalled();
  });

  it("the owner at 2 PM: seen on 18 of 20 weekdays, a usual visit up to 5 minutes, not flagged", async () => {
    f = patternWorld();
    const { server } = app(f);
    const res = await patterns(server, `area=Stock%20room&at=${enc(AT_2PM)}`);
    const cell = await ownerCell(STOCK, AT_2PM);
    expect(res.body.usual).toEqual({
      seenOnDays: 18,
      ofDays: 20,
      around: "2 PM",
      dayType: "weekdays",
      typicalPerHour: Number(cell.volume.typicalPerHour!.toPrecision(2)),
      longestUsualVisitSec: 300,
      enoughData: true,
    });
    expect(res.body.wouldFlag).toEqual({ notUsual: false, busierFrom: cell.volume.flagsFrom });
  });

  it("Maria sees `front` but not `back`: the Loading bay answers with the place and usual: null (DS-005, D22)", async () => {
    f = patternWorld();
    const { server, resolve } = app(f);
    const maria = await patterns(server, `area=Loading%20bay&at=${enc(AT_2AM)}`, "maria");
    expect(maria.status).toBe(200);
    expect(maria.body).toEqual({
      timezone: "Europe/London",
      at: { at: "2026-09-23T01:00:00.000Z", local: "2:00 AM" },
      place: { name: "Loading bay", kind: "area" },
      learning: null,
      usual: null,
      why: "not all cameras visible",
      wouldFlag: null,
      expected: [],
      moreExpected: 0,
      live: false,
    });
    expect(resolve).toHaveBeenCalledWith(MARIA);
    // The null is her scope, not the fixture: the owner gets the same place's numbers…
    const owner = await patterns(server, `area=Loading%20bay&at=${enc(AT_2AM)}`, "stefan");
    expect(owner.body.usual).toMatchObject({ seenOnDays: 0, ofDays: 20 });
    // …and an area made only of her own camera answers her with numbers.
    const shop = await patterns(server, `area=Shop%20floor&at=${enc(AT_2AM)}`, "maria");
    expect(shop.body.usual).toMatchObject({ seenOnDays: 0, ofDays: 20 });
    expect(shop.body.why).toBeNull();
  });

  it("a hidden place answers exactly like one that does not exist — by area, camera display name and Frigate name", async () => {
    f = patternWorld();
    const { server } = app(f);
    for (const [hidden, unknown] of [
      ["area=Stock%20room", "area=Boiler%20room"],
      ["camera=Back%20camera", "camera=Garage"],
      ["camera=back", "camera=nosuch"],
    ]) {
      const h = await patterns(server, hidden!, "maria");
      const u = await patterns(server, unknown!, "maria");
      expect(h.status, hidden).toBe(404);
      expect(h.body, hidden).toEqual(u.body);
      expect(h.body, hidden).toEqual({ error: { code: "PLACE_NOT_FOUND", message: "There is no such area or camera." } });
    }
  });

  it("a camera by display name or Frigate name, case-insensitively and trimmed", async () => {
    f = patternWorld();
    const { server } = app(f);
    const bodies = [];
    for (const q of ["camera=Front%20door", "camera=%20FRONT%20DOOR%20", "camera=front"]) {
      const res = await patterns(server, `${q}&at=${enc(AT_2AM)}`, "maria");
      expect(res.status, q).toBe(200);
      bodies.push(res.body);
    }
    expect(bodies[0].place).toEqual({ name: "Front door", kind: "camera" });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it("a camera still learning: says how far along it is, and flags nothing yet", async () => {
    f = patternWorld({ sources: [{ camera: "back", state: "learning" }, { camera: "front", state: "active" }] });
    const { server } = app(f);
    const res = await patterns(server, `area=Stock%20room&at=${enc(AT_2AM)}`);
    expect(res.body.learning).toEqual({ state: "learning", daysObserved: 9, daysNeeded: 14 });
    expect(res.body.wouldFlag).toEqual({ notUsual: false, busierFrom: null });
  });

  it("a camera Droplet has not heard for two days: out of date", async () => {
    f = patternWorld({ sources: [{ camera: "back", state: "stale" }, { camera: "front", state: "active" }] });
    const { server } = app(f);
    const res = await patterns(server, `area=Stock%20room&at=${enc(AT_2AM)}`);
    expect(res.body.learning.state).toBe("out_of_date");
    expect(res.body.wouldFlag).toEqual({ notUsual: false, busierFrom: null });
  });

  it("period=last_night is the closed spell's first hour, in the site zone; no at and no period is now", async () => {
    f = patternWorld();
    const { server } = app(f);
    const night = await patterns(server, "area=Stock%20room&period=last_night");
    expect(night.body.at).toEqual({ at: "2026-09-23T16:00:00.000Z", local: "5:00 PM" });
    expect(night.body.usual.around).toBe("5 PM");
    const now = await patterns(server, "area=Stock%20room");
    expect(now.body.at).toEqual({ at: NOW.toISOString(), local: "10:30 PM" });
    expect(now.body.usual.around).toBe("10 PM");
  });

  it("expected activity covering the slot: plain words and a local end — never the person's reason or name", async () => {
    f = patternWorld({ over: { securitySuppression: [expectedActivity("sup-weekdays"), expectedActivity("sup-weekends", { days: "weekends" })] } });
    const { server } = app(f);
    const res = await patterns(server, `area=Stock%20room&at=${enc(AT_2AM)}`);
    expect(res.body.expected).toEqual([
      {
        text: "A person marked this as expected: Droplet won't flag it as not usually seen here",
        until: { at: "2026-10-23T09:00:00.000Z", local: "Oct 23, 10:00 AM" },
      },
    ]);
    expect(res.body.moreExpected).toBe(0);
  });

  it("no person's name, and no one's own words, in any A5 answer — for the owner, an admin or family", async () => {
    f = patternWorld({ over: { securitySuppression: [expectedActivity("sup-1", { codes: ["out_of_place", "unusual_volume", "long_dwell"] })] } });
    const { server } = app(f, { level: "manage" });
    const bodies: unknown[] = [];
    for (const who of ["stefan", "jordan", "maria"]) {
      for (const q of [
        `area=Stock%20room&at=${enc(AT_2AM)}`,
        `area=Loading%20bay&at=${enc(AT_2AM)}`,
        `area=Shop%20floor&at=${enc(AT_2PM)}`,
        `camera=back&at=${enc(AT_2AM)}`,
      ]) {
        const res = await patterns(server, q, who);
        if (res.status === 200) bodies.push(res.body);
      }
    }
    expect(bodies.length).toBeGreaterThanOrEqual(10);
    // Non-vacuous: the owner's Stock room answer does carry the expected activity.
    expect(JSON.stringify(bodies[0])).toContain("marked this as expected");
    const text = JSON.stringify(bodies).toLowerCase();
    expect(text).not.toContain("maria");
    expect(text).not.toContain("stefan");
    expect(text).not.toContain("jordan");
    expect(text).not.toContain("restocks");
  });

  it.each([
    ["neither area nor camera", ""],
    ["both area and camera", "area=Shop%20floor&camera=front"],
    ["both at and period", `area=Shop%20floor&at=${enc(AT_2AM)}&period=today`],
    ["an at with no offset", "area=Shop%20floor&at=2026-09-23T02:00:00"],
    ["an at more than 30 days back", `area=Shop%20floor&at=${enc("2026-08-20T02:00:00Z")}`],
    ["an at more than an hour ahead", `area=Shop%20floor&at=${enc("2026-09-24T02:00:00Z")}`],
    ["a period this tool does not take", "area=Shop%20floor&period=last_7_days"],
    ["a label Droplet does not track", "area=Shop%20floor&label=bird"],
    ["an unknown option", "area=Shop%20floor&zone=x"],
  ])("%s → 400 BAD_REQUEST", async (_label, q) => {
    f = patternWorld();
    const { server } = app(f);
    const res = await patterns(server, q);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
  });

  it("period=today with no site zone asks for an exact at", async () => {
    f = patternWorld({ over: { securitySiteHours: [{ id: "singleton", state: "not_set", timezone: null, version: 0 }] } });
    const { server } = app(f);
    const res = await patterns(server, "area=Stock%20room&period=today");
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "BAD_REQUEST", message: "Droplet doesn't know this site's time zone. Pass at as an exact time with an offset." });
  });

  it("nothing learned yet (no ready build, or no time zone) → 409 PATTERNS_NOT_READY, never an empty answer", async () => {
    f = patternWorld({ build: false });
    let res = await patterns(app(f).server, "area=Stock%20room");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PATTERNS_NOT_READY");
    f = patternWorld({ over: { securitySiteHours: [{ id: "singleton", state: "not_set", timezone: null, version: 0 }] } });
    res = await patterns(app(f).server, `area=Stock%20room&at=${enc(AT_2AM)}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PATTERNS_NOT_READY");
    expect(res.body.error.message).toMatch(/time zone/);
  });

  it("a slot covered by many expected-activity rules stays under the 8,000-char tool cap, and says how many it left out", async () => {
    const rules = Array.from({ length: 100 }, (_, i) => expectedActivity(`sup-${String(i).padStart(3, "0")}`, { createdAt: new Date(T.getTime() + i) }));
    f = patternWorld({ over: { securitySuppression: rules } });
    const { server } = app(f);
    const res = await patterns(server, `area=Stock%20room&at=${enc(AT_2AM)}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body).length).toBeLessThan(8_000 - '{"type":"security_pattern",}'.length);
    expect(res.body.expected.length).toBeGreaterThan(5);
    expect(res.body.expected.length + res.body.moreExpected).toBe(100);
  });
});

// ── WARP-2980 (ADR-059 P5 D30) — A1/A2 and the pattern flags ─────────────────

describe("WARP-2980 D30 — A1/A2 never carry a pattern flag, trial or quietened, the owner included", () => {
  function patternFlag(id: string, over: Record<string, unknown>) {
    return {
      id,
      incidentId: INC_FRONT,
      code: "out_of_place",
      effect: "trial",
      severity: "alert",
      suppressionId: null,
      rulesetVersion: 3,
      zoneKey: `area:${SHOP}`,
      keyCameras: ["front"],
      evidenceEventId: 1n,
      evidenceCamera: "front",
      evidenceLabel: "person",
      evidenceAt: T,
      evidenceSummary: "Person seen by Front door",
      detail: { hour: 22 },
      createdAt: T,
      ...over,
    };
  }

  it("the Shop floor's incident holds a trial flag and a quietened one: the owner's codes are its counted reasons only", async () => {
    f = world({
      securitySuppression: [expectedActivity("sup-shop", { zoneId: SHOP, codes: ["unusual_volume"] })],
      securityPatternFlag: [
        patternFlag("pf-trial", {}),
        patternFlag("pf-quiet", { code: "unusual_volume", effect: "suppressed", suppressionId: "sup-shop", evidenceEventId: 11n }),
      ],
    });
    // Non-vacuous: the dashboard's own projection (route 18) shows the owner both flags.
    const detail = await loadIncidentDetail(
      f.client as unknown as PrismaClient,
      INC_FRONT,
      { userId: STEFAN, visibleCameras: "all", mayReadThreats: true, mayReadLocks: true, ownerOrAdmin: true },
      "manage",
      NOW,
    );
    expect(detail!.patternFlags.map((p) => p.effect).sort()).toEqual(["suppressed", "trial"]);

    const { server } = app(f);
    const a1 = await get(server, "/api/security/assistant/incidents", "stefan");
    const a2 = await get(server, `/api/security/assistant/incidents/${INC_FRONT}`, "stefan");
    expect(a1.body.incidents.find((i: { id: string }) => i.id === INC_FRONT).codes.map((c: { code: string }) => c.code)).toEqual(["after_hours_presence"]);
    expect(a2.body.incident.codes.map((c: { code: string }) => c.code)).toEqual(["after_hours_presence"]);
    for (const [name, body] of [["A1", a1.body], ["A2", a2.body]] as const) {
      const text = JSON.stringify(body);
      for (const code of ["out_of_place", "unusual_volume", "long_dwell", "expected"]) expect(text, `${name} ${code}`).not.toContain(code);
    }
  });
});
