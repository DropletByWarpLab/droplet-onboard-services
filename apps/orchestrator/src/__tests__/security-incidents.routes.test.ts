/**
 * WARP-2978 (ADR-059 P3 spec §7 routes 16–22, §6.6, §6.8) — the incident and
 * alert-routing routes.
 *
 * The REAL router, the real `requireRole`, the real `requireFeatureAccess`
 * with the §9 resolver injected through `deps.resolve`, the real services
 * (read model, actions, routing) over the in-memory fake
 * (src/__tests__/security-incidents.fake.ts), and the real audit helpers —
 * only the chain append and the rate limiter are stubbed.
 *
 * Level pins, for EVERY write route (19, 20, 22):
 *   (a) exactly at the level → the exact 2xx and the exact audit;
 *   (b) one level below → 404 module_disabled, nothing written, nothing audited;
 *   (c) the role floor → 403 before the resolver is asked (family on 22 even
 *       with a manage resolver);
 *   (d) owner → 2xx.
 * Every 2xx/404 case asserts the resolver was asked about THIS user.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../services/off-lan-gate.service.js", () => ({ webPushGate: async () => true }));

import { createSecurityIncidentsRouter } from "../routes/security-incidents.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { _resetAlertsHealthForTests } from "../services/security-alerts.service.js";
import { createFakeSecurityPrisma, type FakeSecurityPrisma, type FakeWorld } from "./security-incidents.fake.js";

type Role = "owner" | "admin" | "family" | "guest";
type Level = "view" | "act" | "manage";

const NOW = new Date("2026-09-23T21:30:00Z");
const T = new Date("2026-09-23T21:14:00Z");
const STEFAN = "11111111-1111-4111-8111-111111111111";
const MARIA = "22222222-2222-4222-8222-222222222222";
const JORDAN = "33333333-3333-4333-8333-333333333333";
const USERS: Record<string, { id: string; username: string; displayName: string }> = {
  owner: { id: STEFAN, username: "stefan", displayName: "Stefan" },
  admin: { id: JORDAN, username: "jordan", displayName: "Jordan" },
  family: { id: MARIA, username: "maria", displayName: "Maria" },
  guest: { id: "44444444-4444-4444-8444-444444444444", username: "gus", displayName: "Gus" },
};

/** Visible to Maria (front) — an alert on front, a notice on back. */
const SHARED = "0b7c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4";
/** Only on back: hidden from Maria. */
const BACK_ONLY = "1c8d0e2f-3a4b-4c5d-9e6f-8091a2b3c4d5";
/** On both cameras, but its only code is on back: plain activity for Maria. */
const HIDDEN_CODE = "2d9e1f3a-4b5c-4d6e-8f70-91a2b3c4d5e6";
const MISSING = "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f";

function access(level: Level | null, tier: EffectiveAccessResult["tier"] = "family"): EffectiveAccessResult {
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
  } as unknown as EffectiveAccessResult;
}

function incident(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    scope: "area",
    zoneId: "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61",
    zoneName: "Stock room",
    zoneKind: "interior",
    zoneLinkIds: ["l0"],
    openedInMode: "closed",
    grouping: "collecting",
    state: "open",
    severity: "alert",
    reasonCodes: ["after_hours_presence", "camera_offline"],
    notifyState: "done",
    alertedAt: T,
    rulesetVersion: 1,
    firstActivityAt: T,
    lastActivityAt: T,
    lastArrivalAt: T,
    eventCount: 3,
    countsByCamera: { front: { person: 2 }, back: { _status: 1 } },
    cameras: ["back", "front"],
    version: 4,
    ...over,
  };
}

function reason(incidentId: string, code: string, camera: string | null, severity: string, id: bigint) {
  return {
    incidentId,
    code,
    severity,
    rulesetVersion: 1,
    evidenceEventId: id,
    evidenceCamera: camera,
    evidenceSource: "frigate",
    evidenceKind: code === "camera_offline" ? "camera_offline" : "detection",
    evidenceLabel: code === "camera_offline" ? null : "person",
    evidenceAt: T,
    evidenceSummary: "x",
    detail: {},
  };
}

function world(over: Partial<FakeWorld> = {}): FakeSecurityPrisma {
  return createFakeSecurityPrisma(
    {
      user: [
        { ...USERS.owner, role: "owner", directoryStatus: "ACTIVE" },
        { ...USERS.family, role: "family", directoryStatus: "ACTIVE" },
        { ...USERS.admin, role: "admin", directoryStatus: "ACTIVE" },
      ],
      camera: [
        { id: "cam-back", name: "back", displayName: "Back camera" },
        { id: "cam-front", name: "front", displayName: "Front door" },
      ],
      cameraAccessGrant: [{ id: "g1", userId: MARIA, cameraId: "cam-front" }],
      securityIncident: [
        incident(SHARED),
        incident(BACK_ONLY, { scope: "camera", zoneId: null, zoneName: null, zoneKind: null, zoneLinkIds: [], scopeCamera: "back", cameras: ["back"], countsByCamera: { back: { person: 1 } }, reasonCodes: ["after_hours_presence"], lastActivityAt: new Date(T.getTime() + 60_000) }),
        incident(HIDDEN_CODE, { reasonCodes: ["after_hours_presence"], lastActivityAt: new Date(T.getTime() - 60_000) }),
      ],
      securityIncidentReason: [
        reason(SHARED, "after_hours_presence", "front", "alert", 1n),
        reason(SHARED, "camera_offline", "back", "notice", 2n),
        reason(BACK_ONLY, "after_hours_presence", "back", "alert", 3n),
        reason(HIDDEN_CODE, "after_hours_presence", "back", "alert", 4n),
      ],
      securityIncidentNotice: [
        { id: "n-maria", incidentId: SHARED, userId: MARIA, username: "maria", reason: "routed", outcome: "sent", notificationLogId: "log-maria", channels: "toast", settledAt: T },
        { id: "n-stefan", incidentId: SHARED, userId: STEFAN, username: "stefan", reason: "routed", outcome: "sent", notificationLogId: "log-stefan", channels: "toast", settledAt: T },
      ],
      notificationLog: [
        { id: "log-maria", username: "maria", kind: "event", title: "t", channels: "toast", ackState: "unacked" },
        { id: "log-stefan", username: "stefan", kind: "event", title: "t", channels: "toast", ackState: "unacked" },
      ],
      securitySiteHours: [{ id: "singleton", state: "set", timezone: "Europe/London", version: 1 }],
      ...over,
    },
    NOW,
  );
}

function app(f: FakeSecurityPrisma, role: Role | null | "", level: Level | null) {
  const resolve = vi.fn(async (_userId: string) => access(level, role === "owner" ? "owner" : "family"));
  const server = express();
  server.use(express.json());
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (role !== null) {
      const who = USERS[role || "family"]!;
      (req as unknown as { user?: unknown }).user = { ...who, role, sid: "sess-1" };
      (req as unknown as { sessionChecked?: boolean }).sessionChecked = true;
    }
    next();
  });
  server.use("/api", createSecurityIncidentsRouter(f.client as unknown as PrismaClient, { resolve, now: () => NOW }));
  return { server, resolve };
}

const audits = () => h.inTx.mock.calls.map((c) => c[1] as { what: string; refs: Record<string, unknown> });

beforeEach(() => {
  h.inTx.mockReset().mockResolvedValue({ id: 1n });
  h.record.mockReset().mockResolvedValue({ id: 2n });
  _resetAlertsHealthForTests();
});

// ── the level pins ─────────────────────────────────────────────────────────

interface WriteCase {
  name: string;
  level: Level;
  below: Level;
  /** The role that may hold `level` but not pass this route's role floor; null = the guest floor. */
  floorRole: Role;
  floorLevel: Level;
  atRole: Role;
  send: (s: express.Express) => request.Test;
  status: number;
  action: string;
}

const WRITES: WriteCase[] = [
  {
    name: "POST /security/incidents/:id/acknowledge",
    level: "act",
    below: "view",
    floorRole: "guest",
    floorLevel: "act",
    atRole: "family",
    send: (s) => request(s).post(`/api/security/incidents/${SHARED}/acknowledge`).send({}),
    status: 200,
    action: "incident.acknowledge",
  },
  {
    name: "POST /security/incidents/:id/resolve",
    level: "act",
    below: "view",
    floorRole: "guest",
    floorLevel: "act",
    atRole: "family",
    send: (s) => request(s).post(`/api/security/incidents/${SHARED}/resolve`).send({ note: "Cleaner, as expected" }),
    status: 200,
    action: "incident.resolve",
  },
  {
    name: "PUT /security/alert-routing/:userId",
    level: "manage",
    below: "act",
    floorRole: "family",
    floorLevel: "manage",
    atRole: "admin",
    send: (s) => request(s).put(`/api/security/alert-routing/${MARIA}`).send({ state: "receiving", expectedVersion: null }),
    status: 200,
    action: "alert_routing.set",
  },
];

describe.each(WRITES)("$name — gated at $level", (w) => {
  it("(a) at the route's level → the exact 2xx and one audit", async () => {
    const f = world();
    const { server, resolve } = app(f, w.atRole, w.level);
    const res = await w.send(server);
    expect(res.status, JSON.stringify(res.body)).toBe(w.status);
    expect(resolve).toHaveBeenCalledWith(USERS[w.atRole]!.id);
    expect(audits().map((a) => a.refs.action)).toEqual([w.action]);
  });

  it("(b) one level below → 404 module_disabled, nothing written, nothing audited", async () => {
    const f = world();
    const before = JSON.stringify(f.world, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const { server, resolve } = app(f, w.atRole, w.below);
    const res = await w.send(server);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "security" });
    expect(resolve).toHaveBeenCalledWith(USERS[w.atRole]!.id);
    expect(JSON.stringify(f.world, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("(c) the role floor → 403 before the resolver is asked", async () => {
    const f = world();
    const { server, resolve } = app(f, w.floorRole, w.floorLevel);
    const res = await w.send(server);
    expect(res.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("(d) owner → 2xx", async () => {
    const f = world();
    const { server, resolve } = app(f, "owner", "manage");
    const res = await w.send(server);
    expect(res.status, JSON.stringify(res.body)).toBe(w.status);
    expect(resolve).toHaveBeenCalledWith(STEFAN);
  });
});

describe("every GET: family at view → 200, and no GET is gated above view", () => {
  it.each([
    ["GET /api/security/incidents", "/api/security/incidents"],
    ["GET /api/security/incidents/summary", "/api/security/incidents/summary"],
    ["GET /api/security/incidents/:id", `/api/security/incidents/${SHARED}`],
    ["GET /api/security/alert-routing", "/api/security/alert-routing"],
  ])("%s", async (_n, url) => {
    const { server } = app(world(), "family", "view");
    const res = await request(server).get(url);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("a guest never reads incidents", async () => {
    const { server } = app(world(), "guest", "view");
    expect((await request(server).get("/api/security/incidents")).status).toBe(403);
  });
});

// ── route 16–18: DS-005 ────────────────────────────────────────────────────

describe("reading incidents — DS-005", () => {
  it("route 16: the owner sees every incident; family only those on cameras they can see", async () => {
    const f = world();
    const owner = await request(app(f, "owner", "manage").server).get("/api/security/incidents");
    expect(owner.body.incidents.map((i: { id: string }) => i.id)).toEqual([BACK_ONLY, SHARED, HIDDEN_CODE]);
    const family = await request(app(f, "family", "view").server).get("/api/security/incidents");
    expect(family.body.incidents.map((i: { id: string }) => i.id)).toEqual([SHARED, HIDDEN_CODE]);
    const shared = family.body.incidents[0];
    expect(shared).toMatchObject({ severity: "alert", reasonCodes: ["after_hours_presence"], eventCount: 2, labels: { person: 2 }, state: "open" });
    expect(family.body.incidents[1]).toMatchObject({ severity: "info", reasonCodes: [], state: "no_action", lastAck: null });
  });

  it("route 16: `?severity=alert` for a viewer whose only alert code is hidden — the incident is absent", async () => {
    const f = world();
    const family = await request(app(f, "family", "view").server).get("/api/security/incidents?severity=alert");
    expect(family.body.incidents.map((i: { id: string }) => i.id)).toEqual([SHARED]);
    const owner = await request(app(f, "owner", "manage").server).get("/api/security/incidents?severity=alert");
    expect(owner.body.incidents.map((i: { id: string }) => i.id)).toContain(HIDDEN_CODE);
  });

  it("route 16: pages by cursor; bad input is a 400; an outage is a 503, never an empty 200", async () => {
    const f = world();
    const { server } = app(f, "owner", "manage");
    const first = await request(server).get("/api/security/incidents?limit=2");
    expect(first.body.incidents).toHaveLength(2);
    const second = await request(server).get(`/api/security/incidents?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body).toEqual({ incidents: [expect.objectContaining({ id: HIDDEN_CODE })], nextCursor: null });
    for (const qs of ["limit=500", "state=everything", "cursor=yesterday", "since=today"]) {
      expect((await request(server).get(`/api/security/incidents?${qs}`)).status, qs).toBe(400);
    }
    f.failOn("securityIncident", "findMany", undefined, { always: true });
    const down = await request(server).get("/api/security/incidents");
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("INCIDENTS_UNAVAILABLE");
  });

  it("route 17: counts only what the viewer may see", async () => {
    const f = world();
    const family = await request(app(f, "family", "view").server).get("/api/security/incidents/summary");
    expect(family.body).toMatchObject({ openAlerts: 1, openNotices: 0, alertsReady: false });
    expect(family.body.latest.map((i: { id: string }) => i.id)).toEqual([SHARED]);
    const owner = await request(app(f, "owner", "manage").server).get("/api/security/incidents/summary");
    expect(owner.body).toMatchObject({ openAlerts: 3, openNotices: 0 });
  });

  it("route 18: a hidden incident answers exactly like a missing one", async () => {
    const { server } = app(world(), "family", "view");
    const hidden = await request(server).get(`/api/security/incidents/${BACK_ONLY}`);
    const missing = await request(server).get(`/api/security/incidents/${MISSING}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(hidden.body).toEqual({ error: { code: "INCIDENT_NOT_FOUND", message: "There is no such incident." } });
    expect((await request(server).get("/api/security/incidents/not-a-uuid")).status).toBe(400);
  });

  it("route 18: family sees their own notice only; the owner sees every notice; visible reasons only", async () => {
    const f = world();
    const family = await request(app(f, "family", "act").server).get(`/api/security/incidents/${SHARED}`);
    expect(family.body.reasons.map((r: { code: string }) => r.code)).toEqual(["after_hours_presence"]);
    expect(family.body.notices.map((n: { userId: string }) => n.userId)).toEqual([MARIA]);
    expect(family.body.viewer).toEqual({ level: "act", acknowledged: false });
    const owner = await request(app(f, "owner", "manage").server).get(`/api/security/incidents/${SHARED}`);
    expect(owner.body.notices.map((n: { name: string }) => n.name).sort()).toEqual(["Maria", "Stefan"]);
    expect(owner.body.viewer).toEqual({ level: "manage", acknowledged: false });
  });
});

// ── routes 19–20: the table ────────────────────────────────────────────────

describe("route 19 — acknowledge", () => {
  it("records who, when, which sign-in, what the device said — and acks only the actor's own notification row", async () => {
    const f = world();
    const { server } = app(f, "family", "act");
    const res = await request(server)
      .post(`/api/security/incidents/${SHARED}/acknowledge`)
      .set("X-Droplet-Client", "droplet-ios/1.4.0 (iOS 18.2)")
      .send({ notificationId: "log-maria" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.incident).toMatchObject({ id: SHARED, state: "acknowledged", viewer: { acknowledged: true } });
    expect(res.body.incident.acks).toEqual([
      { action: "acknowledge", byName: "Maria", at: NOW.toISOString(), client: "droplet-ios/1.4.0 (iOS 18.2)", viaNotification: true, note: "" },
    ]);
    expect(f.world.securityIncidentAck[0]).toMatchObject({ byUserId: MARIA, sessionId: "sess-1", sessionChecked: true, viaNotificationId: "log-maria" });
    expect(f.world.securityIncident.find((i) => i.id === SHARED)).toMatchObject({ state: "acknowledged", stateChangedById: MARIA, version: 5 });
    expect(f.world.notificationLog.find((r) => r.id === "log-maria")).toMatchObject({
      ackState: "acked",
      ackMethod: "incident",
      ackSessionId: "sess-1",
      ackSessionChecked: true,
      ackClient: "droplet-ios/1.4.0 (iOS 18.2)",
    });
    expect(f.world.notificationLog.find((r) => r.id === "log-stefan")).toMatchObject({ ackState: "unacked", ackMethod: null });
    expect(audits()[0]).toMatchObject({
      kind: "system",
      severity: "info",
      what: "Security: acknowledged an alert in Stock room",
      refs: { surface: "security", action: "incident.acknowledge", incidentId: SHARED, severity: "alert", codes: ["after_hours_presence", "camera_offline"], state: "acknowledged" },
    });
    expect(audits()[0]!.refs.ackId).toBe(f.world.securityIncidentAck[0]!.id);
  });

  it("the same person twice → changed:false, one row, one audit", async () => {
    const f = world();
    const { server } = app(f, "family", "act");
    await request(server).post(`/api/security/incidents/${SHARED}/acknowledge`).send({});
    const again = await request(server).post(`/api/security/incidents/${SHARED}/acknowledge`).send({});
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(f.world.securityIncidentAck).toHaveLength(1);
    expect(h.inTx).toHaveBeenCalledTimes(1);
  });

  it("a second person is recorded too (D23) — the state stays acknowledged", async () => {
    const f = world();
    await request(app(f, "family", "act").server).post(`/api/security/incidents/${SHARED}/acknowledge`).send({});
    const second = await request(app(f, "owner", "manage").server).post(`/api/security/incidents/${SHARED}/acknowledge`).send({});
    expect(second.body.changed).toBe(true);
    expect(f.world.securityIncidentAck.map((a) => a.byUserId)).toEqual([MARIA, STEFAN]);
    expect(f.world.securityIncident.find((i) => i.id === SHARED)).toMatchObject({ state: "acknowledged", stateChangedById: MARIA });
    expect(h.inTx).toHaveBeenCalledTimes(2);
  });

  it("a notification that is not this person's alert for this incident is not stored — never a 4xx", async () => {
    const f = world();
    const res = await request(app(f, "family", "act").server).post(`/api/security/incidents/${SHARED}/acknowledge`).send({ notificationId: "log-stefan" });
    expect(res.status).toBe(200);
    expect(f.world.securityIncidentAck[0]).toMatchObject({ viaNotificationId: null });
    expect(f.world.notificationLog.find((r) => r.id === "log-stefan")).toMatchObject({ ackState: "unacked" });
  });

  it("hidden → 404 like missing; plain activity for this viewer → 409 NOT_ACTIONABLE; nothing written", async () => {
    const f = world();
    const { server } = app(f, "family", "act");
    const hidden = await request(server).post(`/api/security/incidents/${BACK_ONLY}/acknowledge`).send({});
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe("INCIDENT_NOT_FOUND");
    const plain = await request(server).post(`/api/security/incidents/${HIDDEN_CODE}/acknowledge`).send({});
    expect(plain.status).toBe(409);
    expect(plain.body.error.code).toBe("NOT_ACTIONABLE");
    expect(f.world.securityIncidentAck).toHaveLength(0);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("an audit that cannot be written → 503 AUDIT_UNAVAILABLE, and nothing changed", async () => {
    const f = world();
    h.inTx.mockRejectedValue(new Error("chain down"));
    const res = await request(app(f, "family", "act").server).post(`/api/security/incidents/${SHARED}/acknowledge`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(f.world.securityIncidentAck).toHaveLength(0);
    expect(f.world.securityIncident.find((i) => i.id === SHARED)).toMatchObject({ state: "open", version: 4 });
    expect(f.world.notificationLog.find((r) => r.id === "log-maria")).toMatchObject({ ackState: "unacked" });
  });

  it("a strict body", async () => {
    const res = await request(app(world(), "family", "act").server).post(`/api/security/incidents/${SHARED}/acknowledge`).send({ via: "x" });
    expect(res.status).toBe(400);
  });
});

describe("route 20 — resolve", () => {
  it("resolves and seals a collecting incident, with the note on the ack row — never in the audit refs", async () => {
    const f = world();
    const res = await request(app(f, "family", "act").server).post(`/api/security/incidents/${SHARED}/resolve`).send({ note: "  Cleaner, as expected  " });
    expect(res.status).toBe(200);
    expect(f.world.securityIncident.find((i) => i.id === SHARED)).toMatchObject({
      state: "resolved",
      grouping: "closed",
      closedAt: NOW,
      resolvedAt: NOW,
      resolvedById: MARIA,
    });
    expect(f.world.securityIncidentAck[0]).toMatchObject({ action: "resolve", note: "Cleaner, as expected" });
    expect(JSON.stringify(audits()[0]!.refs)).not.toContain("Cleaner");
    const again = await request(app(f, "family", "act").server).post(`/api/security/incidents/${SHARED}/resolve`).send({});
    expect(again.body.changed).toBe(false);
  });

  it.each([
    ["a NUL", "bad\u0000note"],
    ["a bidi override", "bad‮note"],
    ["a line separator", "bad note"],
  ])("a note with %s → 400 before the transaction", async (_n, note) => {
    const f = world();
    const res = await request(app(f, "family", "act").server).post(`/api/security/incidents/${SHARED}/resolve`).send({ note });
    expect(res.status).toBe(400);
    expect(f.txLevels).toHaveLength(0);
    expect(f.world.securityIncidentAck).toHaveLength(0);
  });

  it("a note over 280 characters → 400", async () => {
    const res = await request(app(world(), "family", "act").server).post(`/api/security/incidents/${SHARED}/resolve`).send({ note: "x".repeat(281) });
    expect(res.status).toBe(400);
  });
});

// ── routes 21–22 ───────────────────────────────────────────────────────────

describe("routes 21–22 — who is told about alerts", () => {
  it("21 at manage: every person; below manage: only your own line", async () => {
    const f = world();
    const admin = await request(app(f, "admin", "manage").server).get("/api/security/alert-routing");
    expect(admin.body.level).toBe("manage");
    expect(admin.body.people.map((p: { name: string }) => p.name)).toEqual(["Jordan", "Maria", "Stefan"]);
    const family = await request(app(f, "family", "act").server).get("/api/security/alert-routing");
    expect(family.body).toEqual({ level: "act", self: { state: "not_receiving", eligible: true } });
  });

  it("22: the last eligible receiver cannot be turned off → 409 NO_RECIPIENT, nothing audited", async () => {
    const f = world();
    const { server } = app(f, "owner", "manage");
    await request(server).get("/api/security/alert-routing");
    const res = await request(server).put(`/api/security/alert-routing/${STEFAN}`).send({ state: "not_receiving", expectedVersion: 0 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: "NO_RECIPIENT", message: "Someone who can open Security has to be told about alerts." } });
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("22: an ineligible person turned on → 422; turned off (clean-up) → 200", async () => {
    const f = world({
      user: [
        { ...USERS.owner, role: "owner", directoryStatus: "ACTIVE" },
        { ...USERS.family, role: "family", directoryStatus: "DEACTIVATED" },
      ],
      securityAlertRecipient: [{ userId: MARIA, state: "receiving", origin: "chosen", version: 2 }],
    });
    const { server } = app(f, "owner", "manage");
    const on = await request(server).put(`/api/security/alert-routing/${MARIA}`).send({ state: "receiving", expectedVersion: 2 });
    expect(on.status).toBe(422);
    expect(on.body.error.code).toBe("NOT_ELIGIBLE");
    const off = await request(server).put(`/api/security/alert-routing/${MARIA}`).send({ state: "not_receiving", expectedVersion: 2 });
    expect(off.status).toBe(200);
    expect(off.body.person).toMatchObject({ userId: MARIA, state: "not_receiving", eligible: false, ineligibleReason: "inactive" });
  });

  it("22: an unknown person → 404; a stale version → 409 VERSION_CONFLICT; a bad body → 400", async () => {
    const f = world();
    const { server } = app(f, "owner", "manage");
    expect((await request(server).put(`/api/security/alert-routing/${MISSING}`).send({ state: "receiving", expectedVersion: null })).body.error.code).toBe(
      "USER_NOT_FOUND",
    );
    await request(server).get("/api/security/alert-routing");
    const stale = await request(server).put(`/api/security/alert-routing/${STEFAN}`).send({ state: "receiving", expectedVersion: 9 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    expect((await request(server).put(`/api/security/alert-routing/${STEFAN}`).send({ state: "on" })).status).toBe(400);
  });
});
