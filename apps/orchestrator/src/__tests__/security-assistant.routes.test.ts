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

import { createSecurityAssistantRouter, type CameraStatusSource } from "../routes/security-assistant.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { explainSecurityPattern } from "../services/security-patterns-read.js";
import { loadIncidentDetail } from "../services/security-incident-view.js";
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
}

function app(f: FakeSecurityPrisma, opts: AppOpts = {}) {
  const resolve = vi.fn(opts.resolve ?? (async (_userId: string) => access(opts.level === undefined ? "view" : opts.level)));
  const server = express();
  server.use((req: Request, _res: Response, next: NextFunction) => {
    const principal = opts.principal === undefined ? { id: "_service:mcp", role: "service" } : opts.principal;
    if (principal) (req as unknown as { user?: unknown }).user = { ...principal, username: principal.id };
    next();
  });
  server.use("/api", createSecurityAssistantRouter(f.client as unknown as PrismaClient, { resolve, now: () => NOW, cameraStatus: opts.cameraStatus ?? ALL_ONLINE }));
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
    expect(res.body.incident).toMatchObject({ moreEvents: false, eventsRemoved: false, resolved: null });
    expect(Object.keys(res.body.incident).sort()).toEqual(
      ["acknowledged", "codes", "events", "eventsRemoved", "first", "id", "last", "moreEvents", "resolved", "severity", "state", "stillHappening", "title", "url"].sort(),
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

  it("a period keeps only incidents whose VISIBLE span meets it", async () => {
    // INC_FRONT's stored span reaches into last night only through `back`; Maria sees front at 2 days ago.
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

  it("every answer at its largest stays under the 8,000-char tool cap, with a cursor to resume", async () => {
    const long = "A camera with a very long display name that goes on".padEnd(60, "x");
    const areaName = (i: number) => `Area number ${i} with a long name that fills it`.padEnd(60, "y");
    const areas = Array.from({ length: 40 }, (_, i) => areaRows(`0b0b0b0b-0000-4000-8000-${String(i).padStart(12, "0")}`, areaName(i), "interior", ["front", "front/driveway_left_side"]));
    const events = Array.from({ length: 80 }, (_, i) =>
      eventRow({ id: BigInt(100 + i), camera: "front", cameraZones: ["driveway_left_side", "porch_steps_area"], startedAt: new Date(T.getTime() - i * 60_000), sourceRef: `front/${100 + i}.5-a`, dedupeKey: `big${i}` }),
    );
    const incidents = Array.from({ length: 40 }, (_, i) =>
      incident(`2c2c2c2c-0000-4000-8000-${String(i).padStart(12, "0")}`, {
        zoneId: areas[0]!.zone.id, zoneName: areaName(0), zoneKind: "interior", cameras: ["front"], reasonCodes: ["after_hours_presence"],
        countsByCamera: { front: { person: 3 } }, lastActivityAt: new Date(T.getTime() - i * 60_000), firstActivityAt: new Date(T.getTime() - i * 60_000),
      }),
    );
    f = world({
      camera: [{ id: "cam-front", name: "front", displayName: long }, { id: "cam-back", name: "back", displayName: "Back camera" }],
      securityZone: areas.map((a) => a.zone),
      securityZoneLink: areas.flatMap((a) => a.links),
      securityEvent: events,
      securityEventTriage: events.map((e) => ({ eventId: e.id, outcome: "grouped", incidentId: incidents[0]!.id, alsoZoneIds: [] })),
      securityIncident: incidents,
      securityIncidentReason: incidents.map((i, n) => reason(i.id, "after_hours_presence", "front", "alert", BigInt(100 + n))),
      securityIncidentAck: [],
    });
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
});

// ── WARP-2980 (ADR-059 P5 PR-E, spec §6.18) — A5 ────────────────────────────

/** An area made of `front` AND `back`: Maria sees it, but not every camera behind it. */
const LOADING = "0c0c0c0c-0000-4000-8000-000000000003";
/** Wednesday 2 AM in London: nobody seen at this hour on any weekday. */
const AT_2AM = "2026-09-23T02:00:00+01:00";
/** Wednesday 2 PM in London: someone in the Stock room on 18 of 20 weekdays. */
const AT_2PM = "2026-09-23T14:00:00+01:00";
const OWNER_SCOPE = { visibleCameras: "all" as const, mayReadThreats: true };
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
      { userId: STEFAN, visibleCameras: "all", mayReadThreats: true, ownerOrAdmin: true },
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
