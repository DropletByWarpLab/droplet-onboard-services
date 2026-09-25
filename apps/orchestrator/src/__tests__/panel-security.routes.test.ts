/**
 * WARP-2981 (ADR-059 P6, §3.8) — P6-3, GET /api/panel/security: the rack
 * panel's Security count.
 *
 * The REAL router and the real `requireRoleOrService`, over the in-memory
 * incident fake (security-incidents.fake.ts), with the toggle and the health
 * rows injected through the router's deps. Pinned here:
 *
 *   T-O1  which incidents count: state `open` over the whole box (an owner's
 *         view, threats included) — never acknowledged, resolved or plain
 *         activity; and `alerts` is how many of those carry an alert;
 *   T-O2  DS-005: the number equals the OWNER's route-17 total over the same
 *         rows, and is not a family viewer's — who may read higher (an
 *         incident someone else acknowledged whose top reason she cannot see
 *         is still open for her) or lower (hidden cameras and threats);
 *   T-O3  `off` without touching an incident; a toggle or a count that cannot
 *         be read is a 503, never a 200;
 *   T-O4  the body's keys are exactly the documented ones;
 *   T-O5  no person and no other service may call it (403 + a denial row);
 *   T-O7  `upToDate` over the real /security header rows.
 *
 * The level invariant (security-level-invariant.test.ts) pins the guard by
 * probing it; security-prefix-composition.test.ts pins where app.ts mounts it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";

const h = vi.hoisted(() => {
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { inTx: vi.fn(), record: vi.fn(), recordActivity: vi.fn(), limiter: passThrough };
});

vi.mock("../middleware/rate-limit.js", async (orig) => ({
  ...(await orig<typeof import("../middleware/rate-limit.js")>()),
  sensitiveRateLimit: h.limiter,
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...args: unknown[]) => h.recordActivity(...args),
  recordActivityInTx: (...args: unknown[]) => h.inTx(...args),
  getActivityRecorder: () => ({ record: h.record }),
}));

vi.mock("../services/off-lan-gate.service.js", () => ({ webPushGate: async () => true }));

// Route 17 for a camera-limited viewer is ordered in SQL; this lane runs the
// reference the pg lane pins it to (as security-incidents.routes.test.ts does).
vi.mock("../services/security-incident-page.js", async () => ({
  projectedIncidentPage: (await import("./security-incidents.fake.js")).referenceProjectedIncidentPage,
}));

import { createPanelSecurityRouter, panelCountIsCurrent, panelHealthRows, type PanelHealthRows } from "../routes/panel-security.js";
import { createSecurityIncidentsRouter } from "../routes/security-incidents.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { _resetAlertsHealthForTests } from "../services/security-alerts.service.js";
import {
  _resetIncidentHealthForTests,
  incidentHealthRow,
  INCIDENT_HEALTH_STALE_MS,
  type IncidentHealthState,
} from "../services/security-incidents.service.js";
import { _resetSecurityIngestHealthForTests, buildSecurityHealth, type SecurityHealthRow } from "../services/security-events.service.js";
import { createFakeSecurityPrisma, type FakeSecurityPrisma, type FakeWorld } from "./security-incidents.fake.js";

const NOW = new Date("2026-09-23T21:30:00Z");
const T = new Date("2026-09-23T21:14:00Z");
const STEFAN = "11111111-1111-4111-8111-111111111111";
const MARIA = "22222222-2222-4222-8222-222222222222";

type Principal = { id: string; username: string; displayName: string; role: string };
const DISPLAY: Principal = { id: "_service:display", username: "_service:display", displayName: "Rack Panel Bridge", role: "service" };
const PEOPLE: Record<string, Principal> = {
  owner: { id: STEFAN, username: "stefan", displayName: "Stefan", role: "owner" },
  admin: { id: "33333333-3333-4333-8333-333333333333", username: "jordan", displayName: "Jordan", role: "admin" },
  family: { id: MARIA, username: "maria", displayName: "Maria", role: "family" },
  guest: { id: "44444444-4444-4444-8444-444444444444", username: "gus", displayName: "Gus", role: "guest" },
  "_service:mcp": { id: "_service:mcp", username: "_service:mcp", displayName: "MCP", role: "service" },
  "_service:voice": { id: "_service:voice", username: "_service:voice", displayName: "Voice", role: "service" },
};

// ── rows (every one of them legal under the WARP-2978 CHECKs) ─────────────

type Code = "after_hours_presence" | "camera_offline" | "threat_signal";

function incident(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    scope: "camera",
    scopeCamera: "front",
    zoneLinkIds: [],
    openedInMode: "closed",
    grouping: "collecting",
    state: "open",
    severity: "alert",
    reasonCodes: ["after_hours_presence"],
    notifyState: "done",
    alertedAt: T,
    rulesetVersion: 2,
    firstActivityAt: T,
    lastActivityAt: T,
    lastArrivalAt: T,
    eventCount: 1,
    countsByCamera: { front: { person: 1 } },
    spanByCamera: {},
    cameras: ["front"],
    version: 1,
    ...over,
  };
}

/** A notice-level incident: no notification is ever due for it. */
const noticeOver = (over: Record<string, unknown>) => ({ severity: "notice", notifyState: "not_needed", alertedAt: null, ...over });

/** A reason with the evidence its code really carries (CHECK SecurityIncidentReason_site_evidence: only a threat may name no camera here). */
function reason(incidentId: string, code: Code, camera: string | null, id: bigint) {
  const evidence =
    code === "threat_signal"
      ? { evidenceSource: "activity_mirror", evidenceKind: "threat", evidenceLabel: null }
      : code === "camera_offline"
        ? { evidenceSource: "frigate_status", evidenceKind: "camera_offline", evidenceLabel: null }
        : { evidenceSource: "frigate", evidenceKind: "detection", evidenceLabel: "person" };
  return {
    incidentId,
    code,
    severity: code === "after_hours_presence" ? "alert" : "notice",
    rulesetVersion: 2,
    evidenceEventId: id,
    evidenceCamera: camera,
    ...evidence,
    evidenceAt: T,
    evidenceSummary: "x",
    detail: {},
  };
}

const ID = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;

/** T-O1's box: three open (an alert, a notice, a threat) and three that must never count. */
function mixedBox(): Partial<FakeWorld> {
  return {
    securityIncident: [
      incident(ID(1)),
      incident(ID(2), noticeOver({ scopeCamera: "back", cameras: ["back"], reasonCodes: ["camera_offline"], countsByCamera: { back: { _status: 1 } } })),
      incident(ID(3), noticeOver({ scope: "site_threat", scopeCamera: null, cameras: [], reasonCodes: ["threat_signal"], countsByCamera: { "": { _threat: 1 } } })),
      incident(ID(4), { state: "acknowledged", stateChangedById: STEFAN }),
      incident(ID(5), { state: "resolved", grouping: "closed", closedAt: T, resolvedAt: T, resolvedById: STEFAN, stateChangedById: STEFAN }),
      incident(ID(6), { state: "no_action", severity: "info", reasonCodes: [], notifyState: "not_needed", alertedAt: null }),
    ],
    securityIncidentReason: [
      reason(ID(1), "after_hours_presence", "front", 1n),
      reason(ID(2), "camera_offline", "back", 2n),
      reason(ID(3), "threat_signal", null, 3n),
      reason(ID(4), "after_hours_presence", "front", 4n),
      reason(ID(5), "after_hours_presence", "front", 5n),
    ],
  };
}

const row = (id: SecurityHealthRow["id"], state: SecurityHealthRow["state"]): SecurityHealthRow => ({ id, state, detail: "", lastSeenAt: null });
const HEALTHY: PanelHealthRows = { incidents: row("incidents", "ok"), cameraIngest: row("camera_ingest", "ok"), threatMirror: row("threat_mirror", "ok") };

function app(
  f: FakeSecurityPrisma,
  who: Principal | null,
  opts: { on?: boolean | (() => Promise<boolean>); health?: PanelHealthRows } = {},
) {
  const server = express();
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (who) (req as unknown as { user?: unknown }).user = { ...who };
    next();
  });
  const on = opts.on ?? true;
  server.use(
    "/api",
    createPanelSecurityRouter(f.client as unknown as PrismaClient, {
      now: () => NOW,
      isSecurityOn: typeof on === "function" ? on : async () => on,
      healthRows: () => opts.health ?? HEALTHY,
    }),
  );
  return server;
}

const get = (server: express.Express) => request(server).get("/api/panel/security");

beforeEach(() => {
  h.recordActivity.mockReset().mockResolvedValue(null);
  h.inTx.mockReset().mockResolvedValue({ id: 1n });
  h.record.mockReset().mockResolvedValue({ id: 2n });
  _resetAlertsHealthForTests();
  _resetIncidentHealthForTests();
  _resetSecurityIngestHealthForTests();
});

// ── T-O1 ──────────────────────────────────────────────────────────────────

describe("P6-3 — which incidents count (T-O1)", () => {
  it("state open over the whole box, threats included; never acknowledged, resolved or plain activity", async () => {
    const res = await get(app(createFakeSecurityPrisma(mixedBox(), NOW), DISPLAY));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ security: "on", open: 3, alerts: 1, upToDate: true });
  });

  it("an empty box is 0 — an answer, with upToDate saying it can be trusted", async () => {
    const res = await get(app(createFakeSecurityPrisma({}, NOW), DISPLAY));
    expect(res.body).toEqual({ security: "on", open: 0, alerts: 0, upToDate: true });
  });

  it.each([
    ["the engine is not sorting", { ...HEALTHY, incidents: row("incidents", "down") }],
    ["camera events are not getting through", { ...HEALTHY, cameraIngest: row("camera_ingest", "down") }],
    ["network and sign-in warnings are not getting through", { ...HEALTHY, threatMirror: row("threat_mirror", "down") }],
  ])("upToDate is false when %s — the number is still sent", async (_why, health) => {
    const res = await get(app(createFakeSecurityPrisma(mixedBox(), NOW), DISPLAY, { health }));
    expect(res.body).toEqual({ security: "on", open: 3, alerts: 1, upToDate: false });
  });
});

// ── T-O2 ──────────────────────────────────────────────────────────────────

/** Visible to Maria (front): an alert on front, a notice on back. */
const SHARED = "0b7c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4";
/** Only on back: hidden from Maria. */
const BACK_ONLY = "1c8d0e2f-3a4b-4c5d-9e6f-8091a2b3c4d5";
/** On both cameras, but its only code is on back: plain activity for Maria. */
const HIDDEN_CODE = "2d9e1f3a-4b5c-4d6e-8f70-91a2b3c4d5e6";
/** The same alert code on front AND back, acknowledged by the owner: partial for Maria. */
const SAME_CODE = "4f1a3b5c-6d7e-4f80-9102-b3c4d5e6f708";

/** security-incidents.routes.test.ts's world(): the owner's route 17 reads 3 alerts, Maria's 1. */
function world(): FakeSecurityPrisma {
  const area = { scope: "area", scopeCamera: null, zoneId: "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61", zoneName: "Stock room", zoneKind: "interior", zoneLinkIds: ["l0"] };
  const both = { cameras: ["back", "front"], countsByCamera: { front: { person: 2 }, back: { _status: 1 } } };
  return createFakeSecurityPrisma(
    {
      user: [
        { ...PEOPLE.owner, directoryStatus: "ACTIVE" },
        { ...PEOPLE.family, directoryStatus: "ACTIVE" },
      ],
      camera: [
        { id: "cam-back", name: "back", displayName: "Back camera" },
        { id: "cam-front", name: "front", displayName: "Front door" },
      ],
      cameraAccessGrant: [{ id: "g1", userId: MARIA, cameraId: "cam-front" }],
      securityIncident: [
        incident(SHARED, { ...area, ...both, reasonCodes: ["after_hours_presence", "camera_offline"] }),
        incident(BACK_ONLY, { scopeCamera: "back", cameras: ["back"], countsByCamera: { back: { person: 1 } } }),
        incident(HIDDEN_CODE, { ...area, ...both }),
      ],
      securityIncidentReason: [
        reason(SHARED, "after_hours_presence", "front", 1n),
        reason(SHARED, "camera_offline", "back", 2n),
        reason(BACK_ONLY, "after_hours_presence", "back", 3n),
        reason(HIDDEN_CODE, "after_hours_presence", "back", 4n),
      ],
      securitySiteHours: [{ id: "singleton", state: "set", timezone: "Europe/London", version: 1 }],
    },
    NOW,
  );
}

function access(tier: EffectiveAccessResult["tier"]): EffectiveAccessResult {
  return {
    tier,
    features: [{ moduleId: "security", level: "view" }],
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
  } as unknown as EffectiveAccessResult;
}

/** Both routers on ONE fake: the panel as the display principal, route 17 as a person. */
async function both(f: FakeSecurityPrisma): Promise<{ panel: number; owner: number; family: number }> {
  const person = (who: "owner" | "family") => {
    const server = express();
    server.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user?: unknown }).user = { ...PEOPLE[who], sid: "sess-1" };
      next();
    });
    server.use(
      "/api",
      createSecurityIncidentsRouter(f.client as unknown as PrismaClient, { resolve: vi.fn(async () => access(who)), now: () => NOW }),
    );
    return server;
  };
  const total = async (who: "owner" | "family") => {
    const r = await request(person(who)).get("/api/security/incidents/summary");
    expect(r.status).toBe(200);
    return (r.body.openAlerts as number) + (r.body.openNotices as number);
  };
  const panel = await get(app(f, DISPLAY));
  expect(panel.status).toBe(200);
  return { panel: panel.body.open as number, owner: await total("owner"), family: await total("family") };
}

describe("P6-3 — whose number (T-O2, DS-005 / D20)", () => {
  it("is the owner's route-17 total over the same rows, never the family viewer's", async () => {
    expect(await both(world())).toEqual({ panel: 3, owner: 3, family: 1 });
  });

  it("the documented disagreement: an alert the owner acknowledged, with a reason she cannot see, stays open for her — never for the rack", async () => {
    const f = world();
    f.world.securityIncident.push(
      incident(SAME_CODE, {
        scope: "area",
        scopeCamera: null,
        zoneId: "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61",
        zoneName: "Stock room",
        zoneKind: "interior",
        zoneLinkIds: ["l0"],
        state: "acknowledged",
        stateChangedById: STEFAN,
        cameras: ["back", "front"],
        countsByCamera: { front: { person: 1 }, back: { person: 1 } },
      }),
    );
    f.world.securityIncidentReason.push(
      { id: "r-same-front", createdAt: T, ...reason(SAME_CODE, "after_hours_presence", "front", 21n) },
      { id: "r-same-back", createdAt: T, ...reason(SAME_CODE, "after_hours_presence", "back", 22n) },
    );
    // The rack and the owner are unchanged (it is acknowledged); Maria's wall reads one more.
    expect(await both(f)).toEqual({ panel: 3, owner: 3, family: 2 });
  });
});

// ── T-O3 / T-O4 ───────────────────────────────────────────────────────────

describe("P6-3 — off, and what cannot be read (T-O3)", () => {
  it("Security off → {security: 'off'}, and no incident is read (a failing count cannot turn it into a 503)", async () => {
    const f = createFakeSecurityPrisma(mixedBox(), NOW);
    const count = vi.spyOn(f.client.securityIncident as { count: (a: unknown) => Promise<number> }, "count");
    f.failOn("securityIncident", "count", undefined, { always: true });
    const res = await get(app(f, DISPLAY, { on: false }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ security: "off" });
    expect(count).not.toHaveBeenCalled();
  });

  it("a toggle that cannot be read is a 503, never a 200", async () => {
    const res = await get(
      app(createFakeSecurityPrisma(mixedBox(), NOW), DISPLAY, {
        on: async () => {
          throw new Error("moduleSetting unreadable");
        },
      }),
    );
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: "INCIDENTS_UNAVAILABLE", message: "Incidents can't be read right now." } });
  });

  it("a count that cannot be read is a 503 — never `open: 0`", async () => {
    const f = createFakeSecurityPrisma(mixedBox(), NOW);
    f.failOn("securityIncident", "count", undefined, { always: true });
    const res = await get(app(f, DISPLAY));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("INCIDENTS_UNAVAILABLE");
    expect(res.body).not.toHaveProperty("open");
  });

  it("health rows that cannot be built are a 503 too", async () => {
    const server = express();
    server.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user?: unknown }).user = { ...DISPLAY };
      next();
    });
    server.use(
      "/api",
      createPanelSecurityRouter(createFakeSecurityPrisma(mixedBox(), NOW).client as unknown as PrismaClient, {
        isSecurityOn: async () => true,
        healthRows: () => {
          throw new Error("no camera_ingest row");
        },
      }),
    );
    expect((await get(server)).status).toBe(503);
  });
});

describe("P6-3 — the body carries exactly its keys (T-O4)", () => {
  it("off: ['security']; on: ['security', 'open', 'alerts', 'upToDate'], with safe non-negative integers", async () => {
    const off = await get(app(createFakeSecurityPrisma(mixedBox(), NOW), DISPLAY, { on: false }));
    expect(Object.keys(off.body)).toEqual(["security"]);
    const on = await get(app(createFakeSecurityPrisma(mixedBox(), NOW), DISPLAY));
    expect(Object.keys(on.body)).toEqual(["security", "open", "alerts", "upToDate"]);
    for (const n of [on.body.open, on.body.alerts]) {
      expect(Number.isSafeInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    expect(on.body.alerts).toBeLessThanOrEqual(on.body.open);
    expect(typeof on.body.upToDate).toBe("boolean");
  });
});

// ── T-O5 ──────────────────────────────────────────────────────────────────

describe("P6-3 — only the panel may ask (T-O5)", () => {
  it.each(Object.keys(PEOPLE))("%s → 403 with the WARP-237 denial row, and no incident is read", async (who) => {
    const f = createFakeSecurityPrisma(mixedBox(), NOW);
    const count = vi.spyOn(f.client.securityIncident as { count: (a: unknown) => Promise<number> }, "count");
    const res = await get(app(f, PEOPLE[who]!));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
    expect(count).not.toHaveBeenCalled();
    expect(h.recordActivity).toHaveBeenCalledTimes(1);
    expect(h.recordActivity.mock.calls[0]![0]).toMatchObject({
      kind: "auth",
      severity: "warn",
      what: "Access denied",
      refs: { role: PEOPLE[who]!.role, reason: "role-not-permitted" },
    });
  });

  it("the display principal's id with a person's role is refused too (id AND role)", async () => {
    const res = await get(app(createFakeSecurityPrisma(mixedBox(), NOW), { ...DISPLAY, role: "owner" }));
    expect(res.status).toBe(403);
  });

  it("no user at all is refused", async () => {
    const res = await get(app(createFakeSecurityPrisma(mixedBox(), NOW), null));
    expect(res.status).toBe(403);
  });
});

// ── T-O7 ──────────────────────────────────────────────────────────────────

describe("upToDate over the real /security header rows (T-O7)", () => {
  type Ingest = Parameters<typeof buildSecurityHealth>[0]["ingest"];
  const INGEST: Ingest = {
    frigateSubscribed: true,
    frigateSubscribeError: null,
    frigateSubscribedAt: NOW,
    lastFrigateMessageAt: NOW,
    lastRecordedAt: NOW,
    lastWriteError: null,
    jobsRegistered: true,
  };
  const header = (ingest: Partial<Ingest>, frigateConfigured = true) =>
    buildSecurityHealth({ frigateConfigured, ingest: { ...INGEST, ...ingest }, frigate: undefined, state: null, now: NOW });
  const ingestRow = (ingest: Partial<Ingest>, frigateConfigured = true) => header(ingest, frigateConfigured).find((r) => r.id === "camera_ingest")!;
  const mirrorRow = (ingest: Partial<Ingest>) => header(ingest).find((r) => r.id === "threat_mirror")!;
  const engine = (over: Partial<IncidentHealthState>) =>
    incidentHealthRow({ registeredAt: new Date(NOW.getTime() - 3_600_000), lastOkAt: NOW, lastError: null, failedLastDay: 0, ...over }, null, NOW);
  const rows = (over: Partial<PanelHealthRows>): PanelHealthRows => ({ ...HEALTHY, ...over });

  it("the engine: not registered, no tick for 2 min, or a failed triage in the last day → false; ticking → true", () => {
    expect(panelCountIsCurrent(rows({ incidents: engine({ registeredAt: null }) }))).toBe(false);
    expect(panelCountIsCurrent(rows({ incidents: engine({ lastOkAt: new Date(NOW.getTime() - INCIDENT_HEALTH_STALE_MS - 1) }) }))).toBe(false);
    expect(panelCountIsCurrent(rows({ incidents: engine({ failedLastDay: 1 }) }))).toBe(false);
    expect(panelCountIsCurrent(rows({ incidents: engine({}) }))).toBe(true);
    // Only `ok` is sorting: any other state of the row reads as behind.
    expect(panelCountIsCurrent(rows({ incidents: row("incidents", "quiet") }))).toBe(false);
  });

  it("camera events: not subscribed or saves failing → false; quiet or no camera system → true", () => {
    expect(panelCountIsCurrent(rows({ cameraIngest: ingestRow({ frigateSubscribed: false }) }))).toBe(false);
    const failing = ingestRow({ lastWriteError: { at: NOW, message: "boom" }, lastRecordedAt: new Date(NOW.getTime() - 60_000) });
    expect(failing.state).toBe("down");
    expect(panelCountIsCurrent(rows({ cameraIngest: failing }))).toBe(false);
    const quiet = ingestRow({ lastFrigateMessageAt: new Date(NOW.getTime() - 7 * 3_600_000), frigateSubscribedAt: new Date(NOW.getTime() - 8 * 3_600_000) });
    expect(quiet.state).toBe("quiet");
    expect(panelCountIsCurrent(rows({ cameraIngest: quiet }))).toBe(true);
    const none = ingestRow({ frigateSubscribed: false }, false);
    expect(none.state).toBe("not_configured");
    expect(panelCountIsCurrent(rows({ cameraIngest: none }))).toBe(true);
    expect(panelCountIsCurrent(rows({ cameraIngest: ingestRow({}) }))).toBe(true);
  });

  it("network and sign-in warnings: jobs never registered → false; registered, not run yet (quiet) → true", () => {
    expect(panelCountIsCurrent(rows({ threatMirror: mirrorRow({ jobsRegistered: false }) }))).toBe(false);
    const registered = mirrorRow({});
    expect(registered.state).toBe("quiet");
    expect(panelCountIsCurrent(rows({ threatMirror: registered }))).toBe(true);
  });

  it("the default rows are the live ones: a fresh process (engine not registered, not subscribed) is not up to date", () => {
    const live = panelHealthRows(NOW);
    expect([live.incidents.id, live.cameraIngest.id, live.threatMirror.id]).toEqual(["incidents", "camera_ingest", "threat_mirror"]);
    expect(live.incidents.state).toBe("down");
    expect(panelCountIsCurrent(live)).toBe(false);
  });

  it("…and the router uses them when none are injected", async () => {
    const server = express();
    server.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user?: unknown }).user = { ...DISPLAY };
      next();
    });
    server.use("/api", createPanelSecurityRouter(createFakeSecurityPrisma(mixedBox(), NOW).client as unknown as PrismaClient, { isSecurityOn: async () => true }));
    expect((await get(server)).body).toEqual({ security: "on", open: 3, alerts: 1, upToDate: false });
  });
});
