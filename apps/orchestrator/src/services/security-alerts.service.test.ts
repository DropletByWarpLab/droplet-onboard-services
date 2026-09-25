/**
 * WARP-2978 (ADR-059 P3 spec §6.7, §6.11, §7 routes 21–22; D25–D29) — who is
 * told about Security alerts, the notifier, redelivery, the `alerts` health
 * row, and the routing writes — over the in-memory fake.
 *
 * WARP-2911 is pinned here the way the brief asks: every fake user has a
 * DISTINCT, UUID-shaped `id` and a plain `username`, and the NotificationLog
 * row and the notice carry the username — never the id. `recordNotification`
 * is the REAL one (its runtime guard throws on a User.id), writing into the
 * fake; only the transport (`deliverNotification`) is stubbed, stamping the
 * row the way the real one does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const h = vi.hoisted(() => ({
  fake: null as null | { txDepth(): number; world: Record<string, Array<Record<string, unknown>>> },
  recorded: [] as Array<{ username: string; inTx: boolean }>,
  delivered: [] as Array<{ id: string; opts: unknown; txDepth: number; notifyState: unknown }>,
  deliverFails: false,
  /** Review #7: #2353's delivery CLAIMS the row (error = outcome_unknown) before any transport, and the stamp overwrites it — unless it is lost. */
  stampLost: false,
  audit: vi.fn(),
  inTxAudit: vi.fn(),
  gate: true,
}));

vi.mock("./notifications.service.js", async (orig) => {
  const real = await orig<typeof import("./notifications.service.js")>();
  return {
    ...real,
    recordNotification: async (db: unknown, input: { username: string }) => {
      h.recorded.push({ username: input.username, inTx: (h.fake?.txDepth() ?? 0) > 0 });
      return real.recordNotification(db as never, input as never);
    },
    deliverNotification: async (_prisma: unknown, id: string, opts: unknown) => {
      const w = h.fake!.world;
      const incident = w.securityIncident[0];
      h.delivered.push({ id, opts, txDepth: h.fake!.txDepth(), notifyState: incident?.notifyState });
      if (h.deliverFails) throw new Error("mqtt down");
      const row = w.notificationLog.find((r) => r.id === id)!;
      // The real claim: only a row that is still queued can be delivered, once.
      if (row.deliveredAt != null || row.error != null) return { id, channels: [], delivered: false, skipped: "already_delivered" };
      row.error = "delivery: outcome_unknown";
      if (h.stampLost) return { id, channels: ["toast"], delivered: true };
      Object.assign(row, { channels: "toast", deliveredAt: new Date(), pushOutcome: "no_subscribers", error: null });
      return { id, channels: ["toast"], delivered: true };
    },
  };
});

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
  recordActivityInTx: (...a: unknown[]) => h.inTxAudit(...a),
  getActivityRecorder: () => ({ record: h.audit }),
}));

vi.mock("./off-lan-gate.service.js", () => ({ webPushGate: async () => h.gate }));

import {
  SECURITY_ALERT_HOURLY_CAP,
  SECURITY_NOTIFY_MAX_ATTEMPTS,
  SECURITY_REDELIVER_AFTER_MS,
  _resetAlertsHealthForTests,
  alertsReady,
  computeAlertsHealthRow,
  incidentTag,
  notifyPendingIncidents,
  readAlertRouting,
  redeliverStuckNotices,
  setAlertRouting,
} from "./security-alerts.service.js";
import type { EffectiveAccessResult } from "./effective-access.service.js";
import { areaRows, createFakeSecurityPrisma, officeHours, type FakeSecurityPrisma, type FakeWorld } from "../__tests__/security-incidents.fake.js";

const NOW = new Date("2026-09-23T21:20:00Z"); // 10:20 PM in London
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

// Distinct UUID-shaped ids and plain usernames (WARP-2911).
const STEFAN = "11111111-1111-4111-8111-111111111111";
const MARIA = "22222222-2222-4222-8222-222222222222";
const JORDAN = "33333333-3333-4333-8333-333333333333";
const INCIDENT = "0b7c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4";
const STOCK = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61";

type Level = "view" | "act" | "manage";
const LEVELS: Record<string, Level | null> = {};

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
    exceptions: [],
  } as unknown as EffectiveAccessResult;
}
const THROWS = new Set<string>();
async function defaultResolve(userId: string): Promise<EffectiveAccessResult | null> {
  if (THROWS.has(userId)) throw new Error("resolver down");
  if (!(userId in LEVELS)) return access("manage");
  return LEVELS[userId] === null ? null : access(LEVELS[userId]!);
}
const resolve = vi.fn(defaultResolve);

function user(id: string, username: string, displayName: string, role: string, over: Record<string, unknown> = {}) {
  return { id, username, displayName, role, directoryStatus: "ACTIVE", ...over };
}

function reason(camera: string | null, at: Date, over: Record<string, unknown> = {}) {
  return {
    incidentId: INCIDENT,
    code: "after_hours_presence",
    severity: "alert",
    rulesetVersion: 1,
    evidenceEventId: BigInt(at.getTime() % 100000),
    evidenceCamera: camera,
    evidenceSource: "frigate",
    evidenceKind: "detection",
    evidenceLabel: "person",
    evidenceAt: at,
    evidenceSummary: "Person seen",
    detail: { mode: "closed", modeSource: "schedule", nonOpenAt: at.toISOString(), zoneKind: "interior" },
    ...over,
  };
}

function incident(over: Record<string, unknown> = {}) {
  return {
    id: INCIDENT,
    scope: "area",
    zoneId: STOCK,
    zoneName: "Stock room",
    zoneKind: "interior",
    zoneLinkIds: ["l0"],
    openedInMode: "closed",
    grouping: "collecting",
    state: "open",
    severity: "alert",
    reasonCodes: ["after_hours_presence"],
    notifyState: "pending",
    notifyAttempts: 0,
    alertedAt: plus(NOW, -5_000),
    rulesetVersion: 1,
    firstActivityAt: plus(NOW, -60_000),
    lastActivityAt: plus(NOW, -40_000),
    lastArrivalAt: plus(NOW, -39_000),
    eventCount: 1,
    countsByCamera: { back: { person: 1 } },
    cameras: ["back"],
    spanByCamera: {},
    version: 2,
    ...over,
  };
}

function world(over: Partial<FakeWorld> = {}): FakeSecurityPrisma {
  const hours = officeHours();
  const stock = areaRows(STOCK, "Stock room", "interior", ["back"]);
  const f = createFakeSecurityPrisma(
    {
      user: [user(STEFAN, "stefan", "Stefan", "owner"), user(MARIA, "maria", "Maria", "family"), user(JORDAN, "jordan", "Jordan", "admin")],
      camera: [
        { id: "cam-back", name: "back", displayName: "Back camera" },
        { id: "cam-front", name: "front", displayName: "Front door" },
      ],
      cameraAccessGrant: [{ id: "g1", userId: MARIA, cameraId: "cam-front" }],
      securityIncident: [incident()],
      securityIncidentReason: [reason("back", plus(NOW, -60_000))],
      securitySiteHours: [hours.header],
      securitySchedule: hours.days,
      securityZone: [stock.zone],
      securityZoneLink: stock.links,
      ...over,
    },
    NOW,
  );
  h.fake = f as never;
  return f;
}

const deps = (moduleOn = true) => ({ isSecurityModuleOn: async () => moduleOn, resolveAccess: resolve });
const client = (f: FakeSecurityPrisma) => f.client as unknown as PrismaClient;
const notices = (f: FakeSecurityPrisma) => f.world.securityIncidentNotice;
const noticeOf = (f: FakeSecurityPrisma, userId: string) => notices(f).find((n) => n.userId === userId && n.incidentId === INCIDENT);

beforeEach(() => {
  h.recorded = [];
  h.delivered = [];
  h.deliverFails = false;
  h.stampLost = false;
  h.gate = true;
  h.audit.mockReset().mockResolvedValue({ id: 1n });
  h.inTxAudit.mockReset().mockResolvedValue({ id: 2n });
  resolve.mockReset().mockImplementation(defaultResolve);
  for (const k of Object.keys(LEVELS)) delete LEVELS[k];
  THROWS.clear();
  _resetAlertsHealthForTests();
});

describe("the fixtures agree with production (WARP-2911)", () => {
  it("every fake user has a UUID-shaped id that differs from its plain username", async () => {
    const { isUserIdShaped } = await import("@droplet/auth-policy");
    for (const u of world().world.user) {
      expect(isUserIdShaped(u.id as string), String(u.id)).toBe(true);
      expect(isUserIdShaped(u.username as string), String(u.username)).toBe(false);
      expect(u.username).not.toBe(u.id);
    }
  });
});

describe("routing defaults (D25)", () => {
  it("owners get a receiving row lazily, marked owner_default; nobody else gets one", async () => {
    const f = world();
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(f.world.securityAlertRecipient).toEqual([
      expect.objectContaining({ userId: STEFAN, state: "receiving", origin: "owner_default", setById: null }),
    ]);
  });
});

describe("the notifier (§6.7)", () => {
  it("tells the owner: the NotificationLog row and the notice carry the USERNAME, never the User.id (WARP-2911)", async () => {
    const f = world();
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(f.world.notificationLog).toHaveLength(1);
    const log = f.world.notificationLog[0]!;
    expect(log).toMatchObject({
      username: "stefan",
      kind: "event",
      title: "Person in Stock room after hours",
      body: "Back camera saw someone at 10:19 PM. The site was closed.",
      url: `/security/incidents/${INCIDENT}`,
      data: { incidentId: INCIDENT },
    });
    expect(log.username).not.toBe(STEFAN);
    expect(noticeOf(f, STEFAN)).toMatchObject({
      username: "stefan",
      reason: "routed",
      outcome: "sent",
      notificationLogId: log.id,
      channels: "toast",
      pushOutcome: "no_subscribers",
      settledAt: NOW,
    });
    expect(f.world.securityIncident[0]).toMatchObject({ notifyState: "done", notifyAttempts: 0, version: 3 });
  });

  it("review #12: a notice's createdAt and settledAt are on ONE clock — the tick's — whatever the database's says", async () => {
    const f = world(); // the fake database's clock is NOW
    const tick = plus(NOW, 7_000);
    await notifyPendingIncidents(client(f), deps(), tick);
    expect(noticeOf(f, STEFAN)).toMatchObject({ createdAt: tick, settledAt: tick });
  });

  it("records inside the transaction, delivers after it commits — with the incident's tag and alert priority", async () => {
    const f = world();
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(h.recorded).toEqual([{ username: "stefan", inTx: true }]);
    expect(h.delivered).toEqual([
      { id: f.world.notificationLog[0]!.id, opts: { tag: incidentTag(INCIDENT), priority: "alert" }, txDepth: 0, notifyState: "done" },
    ]);
    expect(f.txLevels).toContain("ReadCommitted");
  });

  it("audits incident.alerted as the system, after the notices commit and after delivery", async () => {
    const f = world();
    h.audit.mockImplementation(async () => {
      expect(h.delivered).toHaveLength(1);
      expect(f.txDepth()).toBe(0);
      return { id: 1n };
    });
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const params = h.audit.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({
      kind: "system",
      severity: "info",
      what: "Security: sent an alert about Stock room",
      actor: { type: "system", id: null },
      refs: { surface: "security", action: "incident.alerted", incidentId: INCIDENT, notices: [{ userId: STEFAN, outcome: "sent", reason: "routed" }] },
    });
  });

  it("review #8: a failed audit is RETURNED, never thrown — the next incident is still notified", async () => {
    const f = world();
    const second = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    f.world.securityIncident.push({ ...incident({ id: second, alertedAt: plus(NOW, -1_000) }), zoneLinkIds: ["l0"] });
    f.world.securityIncidentReason.push({ id: "r2", createdAt: NOW, ...reason("back", plus(NOW, -50_000), { incidentId: second }) });
    h.audit.mockRejectedValueOnce(new Error("chain down"));
    const r = await notifyPendingIncidents(client(f), deps(), NOW);
    expect(r).toMatchObject({ incidents: 2, auditError: expect.objectContaining({ message: "chain down" }) });
    expect(f.world.securityIncident.map((i) => i.notifyState)).toEqual(["done", "done"]);
    expect(h.audit).toHaveBeenCalledTimes(2);
  });

  it("DS-005: a family recipient who cannot see the camera is skipped_not_visible — no NotificationLog row for her", async () => {
    const f = world({ securityAlertRecipient: [{ userId: MARIA, state: "receiving", origin: "chosen", version: 1, setById: STEFAN }] });
    LEVELS[MARIA] = "act";
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "skipped_not_visible", notificationLogId: null, settledAt: NOW });
    expect(f.world.notificationLog.map((r) => r.username)).toEqual(["stefan"]);
  });

  it("the text is built from each recipient's VISIBLE evidence only", async () => {
    const f = world({
      securityAlertRecipient: [{ userId: MARIA, state: "receiving", origin: "chosen", version: 1, setById: STEFAN }],
      securityIncidentReason: [reason("back", plus(NOW, -60_000)), reason("front", plus(NOW, -30_000))],
      securityIncident: [incident({ cameras: ["back", "front"] })],
    });
    LEVELS[MARIA] = "act";
    await notifyPendingIncidents(client(f), deps(), NOW);
    const body = (u: string) => f.world.notificationLog.find((r) => r.username === u)!.body;
    expect(body("maria")).toBe("Front door saw someone at 10:19 PM. The site was closed.");
    expect(body("stefan")).toBe("Back camera saw someone at 10:19 PM. The site was closed. It happened 1 more time.");
  });

  it("the owner fallback: the only routed person lost access → the owner is told (fallback_owner), the routed one skipped_no_access", async () => {
    const f = world({
      securityAlertRecipient: [
        { userId: STEFAN, state: "not_receiving", origin: "chosen", version: 1, setById: STEFAN },
        { userId: MARIA, state: "receiving", origin: "chosen", version: 1, setById: STEFAN },
      ],
    });
    LEVELS[MARIA] = "view";
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "skipped_no_access", reason: "routed" });
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "sent", reason: "fallback_owner" });
    expect(resolve).toHaveBeenCalledWith(MARIA);
  });

  it("review #2: the only routed person is eligible but cannot see the camera → the owner is told (fallback_owner)", async () => {
    const f = world({
      securityAlertRecipient: [
        { userId: STEFAN, state: "not_receiving", origin: "chosen", version: 1, setById: STEFAN },
        { userId: MARIA, state: "receiving", origin: "chosen", version: 1, setById: STEFAN },
      ],
    });
    LEVELS[MARIA] = "act";
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "skipped_not_visible", reason: "routed" });
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "sent", reason: "fallback_owner" });
    expect(f.world.notificationLog.map((r) => r.username)).toEqual(["stefan"]);
  });

  it("review #2: a routed person who was capped still counts as told — no fallback", async () => {
    const prior = Array.from({ length: SECURITY_ALERT_HOURLY_CAP }, (_, k) => ({
      id: `p${k}`,
      incidentId: `00000000-0000-4000-8000-00000000010${k}`,
      userId: MARIA,
      username: "maria",
      reason: "routed",
      outcome: "sent",
      notificationLogId: `lp${k}`,
      channels: "toast",
      createdAt: plus(NOW, -(k + 1) * 60_000),
      settledAt: plus(NOW, -(k + 1) * 60_000),
    }));
    const f = world({
      securityAlertRecipient: [
        { userId: STEFAN, state: "not_receiving", origin: "chosen", version: 1, setById: STEFAN },
        { userId: MARIA, state: "receiving", origin: "chosen", version: 1, setById: STEFAN },
      ],
      cameraAccessGrant: [{ id: "g1", userId: MARIA, cameraId: "cam-back" }],
      securityIncidentNotice: prior,
    });
    LEVELS[MARIA] = "act";
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "skipped_capped" });
    expect(noticeOf(f, STEFAN)).toBeUndefined();
  });

  it("eligibility is ≥ act on Security, checked at send time: `view` is not enough", async () => {
    const f = world({ securityAlertRecipient: [{ userId: JORDAN, state: "receiving", origin: "chosen", version: 1, setById: STEFAN }] });
    LEVELS[JORDAN] = "view";
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, JORDAN)).toMatchObject({ outcome: "skipped_no_access" });
  });

  it("a deactivated person is not told; a resolver failure is not access", async () => {
    const f = world({
      user: [
        user(STEFAN, "stefan", "Stefan", "owner"),
        user(MARIA, "maria", "Maria", "family", { directoryStatus: "DEACTIVATED" }),
        user(JORDAN, "jordan", "Jordan", "admin"),
      ],
      securityAlertRecipient: [
        { userId: STEFAN, state: "not_receiving", origin: "chosen", version: 1, setById: STEFAN },
        { userId: MARIA, state: "receiving", origin: "chosen", version: 1, setById: STEFAN },
        { userId: JORDAN, state: "receiving", origin: "chosen", version: 1, setById: STEFAN },
      ],
    });
    THROWS.add(JORDAN);
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "skipped_no_access" });
    expect(noticeOf(f, JORDAN)).toMatchObject({ outcome: "skipped_no_access" });
    // Neither routed person could be told, so the owner is (the fallback).
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "sent", reason: "fallback_owner" });
  });

  it("a username shaped like a User.id is skipped_no_address — it is never sent to", async () => {
    const f = world({
      user: [user(STEFAN, "44444444-4444-4444-8444-444444444444", "Stefan", "owner")],
    });
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "skipped_no_address", notificationLogId: null });
    expect(f.world.notificationLog).toHaveLength(0);
  });

  it(`the cap: at ${SECURITY_ALERT_HOURLY_CAP} alert notifications in the last hour, the next is skipped_capped (D28)`, async () => {
    const prior = (n: number) =>
      Array.from({ length: n }, (_, k) => ({
        id: `n${k}`,
        incidentId: `00000000-0000-4000-8000-00000000000${k}`,
        userId: STEFAN,
        username: "stefan",
        reason: "routed",
        outcome: "sent",
        notificationLogId: `log${k}`,
        channels: "toast",
        createdAt: plus(NOW, -(k + 1) * 60_000),
        settledAt: plus(NOW, -(k + 1) * 60_000),
      }));
    const capped = world({ securityIncidentNotice: prior(SECURITY_ALERT_HOURLY_CAP) });
    await notifyPendingIncidents(client(capped), deps(), NOW);
    expect(noticeOf(capped, STEFAN)).toMatchObject({ outcome: "skipped_capped", notificationLogId: null });

    const under = world({ securityIncidentNotice: prior(SECURITY_ALERT_HOURLY_CAP - 1) });
    await notifyPendingIncidents(client(under), deps(), NOW);
    expect(noticeOf(under, STEFAN)?.outcome).toBe("sent");

    // Older than an hour does not count.
    const old = world({ securityIncidentNotice: prior(SECURITY_ALERT_HOURLY_CAP).map((n) => ({ ...n, createdAt: plus(NOW, -3_700_000) })) });
    await notifyPendingIncidents(client(old), deps(), NOW);
    expect(noticeOf(old, STEFAN)?.outcome).toBe("sent");
  });

  it("a sealed (closed) incident that is still pending is notified — sealing is not handling it", async () => {
    const f = world({ securityIncident: [incident({ grouping: "closed", closedAt: plus(NOW, -1_000) })] });
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "sent" });
  });

  it("module off box-wide → module_off: grouped, never sent (D29)", async () => {
    const f = world();
    await notifyPendingIncidents(client(f), deps(false), NOW);
    expect(f.world.securityIncident[0]).toMatchObject({ notifyState: "module_off" });
    expect(f.world.notificationLog).toHaveLength(0);
    expect(notices(f)).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it(`${SECURITY_NOTIFY_MAX_ATTEMPTS} failures → failed (terminal); each failure rolls back and is counted`, async () => {
    const f = world();
    f.failOn("notificationLog", "create", undefined, { always: true, error: new Error("disk full") });
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(f.world.securityIncident[0]).toMatchObject({ notifyState: "pending", notifyAttempts: 1 });
    expect(notices(f)).toHaveLength(0);
    await notifyPendingIncidents(client(f), deps(), NOW);
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(f.world.securityIncident[0]).toMatchObject({ notifyState: "failed", notifyAttempts: 3 });
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(f.world.securityIncident[0]).toMatchObject({ notifyState: "failed", notifyAttempts: 3 });
  });

  it("one notice per (incident, recipient): a second notify of the same incident tells nobody again", async () => {
    const f = world();
    await notifyPendingIncidents(client(f), deps(), NOW);
    f.world.securityIncident[0]!.notifyState = "pending";
    await notifyPendingIncidents(client(f), deps(), plus(NOW, 10_000));
    expect(f.world.notificationLog).toHaveLength(1);
    expect(notices(f)).toHaveLength(1);
    expect(h.recorded).toHaveLength(1);
  });

  it("a delivery that throws leaves the notice queued for redelivery — the record is already committed", async () => {
    const f = world();
    h.deliverFails = true;
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "queued", settledAt: null });
    expect(f.world.securityIncident[0]).toMatchObject({ notifyState: "done" });
  });
});

// Review #6: a tick must never outlive its 60 s lock — notify and redelivery stop at the deadline.
// Review R4 (rjouffret): Maria (sees front) was skipped — the first alert
// evidence was on back. Alert evidence on front joins later; the engine sets
// the incident pending again (security-incidents.service.test.ts pins that).
describe("review R4 — late alert evidence on a camera a skipped person can see", () => {
  const LATER = plus(NOW, 60_000);
  const routedMaria = { userId: MARIA, state: "receiving", origin: "chosen", version: 1, setById: STEFAN };

  /** The first run (Maria skipped_not_visible, Stefan told), then alert evidence on `camera` and the engine's `pending`. */
  async function firstRunThenLate(f: FakeSecurityPrisma, camera = "front"): Promise<void> {
    LEVELS[MARIA] = "act";
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "skipped_not_visible" });
    f.world.securityIncidentReason.push({ id: "r-late", createdAt: LATER, ...reason(camera, plus(NOW, 30_000), { evidenceEventId: 777n }) });
    Object.assign(f.world.securityIncident[0]!, { notifyState: "pending", cameras: ["back", camera].sort() });
  }

  it("her skipped notice becomes her one notification — by username, delivered, settled, dated now; the owner is not told twice", async () => {
    const f = world({ securityAlertRecipient: [routedMaria] });
    await firstRunThenLate(f);
    await notifyPendingIncidents(client(f), deps(), LATER);
    expect(notices(f).filter((n) => n.userId === MARIA)).toHaveLength(1);
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "sent", reason: "routed", createdAt: LATER, settledAt: LATER, notificationLogId: expect.any(String) });
    expect(f.world.notificationLog.map((r) => r.username)).toEqual(["stefan", "maria"]);
    expect(f.world.notificationLog.find((r) => r.username === "maria")!.body).toBe("Front door saw someone at 10:20 PM. The site was closed.");
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "sent", createdAt: NOW });
    expect(f.world.securityIncident[0]).toMatchObject({ notifyState: "done" });
    expect(h.audit).toHaveBeenCalledTimes(2);
  });

  it("a re-plan never adds someone routed AFTER the alert: only skipped people are planned again", async () => {
    const f = world({ securityAlertRecipient: [routedMaria] });
    await firstRunThenLate(f);
    f.world.securityAlertRecipient.push({ userId: JORDAN, state: "receiving", origin: "chosen", version: 1, setById: STEFAN, setAt: NOW });
    await notifyPendingIncidents(client(f), deps(), LATER);
    expect(noticeOf(f, JORDAN)).toBeUndefined();
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "sent" });
  });

  it("still nothing she can see (the late evidence is on another hidden camera): her notice is left as it was, and nothing is audited", async () => {
    const f = world({
      securityAlertRecipient: [routedMaria],
      camera: [
        { id: "cam-back", name: "back", displayName: "Back camera" },
        { id: "cam-front", name: "front", displayName: "Front door" },
        { id: "cam-side", name: "side", displayName: "Side gate" },
      ],
    });
    await firstRunThenLate(f, "side");
    await notifyPendingIncidents(client(f), deps(), LATER);
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "skipped_not_visible", createdAt: NOW, notificationLogId: null });
    expect(f.world.notificationLog.map((r) => r.username)).toEqual(["stefan"]);
    expect(f.world.securityIncident[0]).toMatchObject({ notifyState: "done" });
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it("the hourly cap still applies: capped at the re-plan → skipped_capped, no notification", async () => {
    const prior = Array.from({ length: SECURITY_ALERT_HOURLY_CAP }, (_, k) => ({
      id: `p${k}`,
      incidentId: `00000000-0000-4000-8000-00000000010${k}`,
      userId: MARIA,
      username: "maria",
      reason: "routed",
      outcome: "sent",
      notificationLogId: `lp${k}`,
      channels: "toast",
      createdAt: plus(NOW, -(k + 1) * 60_000),
      settledAt: plus(NOW, -(k + 1) * 60_000),
    }));
    const f = world({ securityAlertRecipient: [routedMaria], securityIncidentNotice: prior });
    await firstRunThenLate(f);
    await notifyPendingIncidents(client(f), deps(), LATER);
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "skipped_capped", notificationLogId: null });
    expect(f.world.notificationLog.map((r) => r.username)).toEqual(["stefan"]);
  });

  it("switched off since the alert → not planned again", async () => {
    const f = world({ securityAlertRecipient: [routedMaria] });
    await firstRunThenLate(f);
    f.world.securityAlertRecipient.find((r) => r.userId === MARIA)!.state = "not_receiving";
    await notifyPendingIncidents(client(f), deps(), LATER);
    expect(noticeOf(f, MARIA)).toMatchObject({ outcome: "skipped_not_visible" });
  });
});

describe("the tick's deadline", () => {
  /** A deadline that has not passed for the first `n` checks, and has after. */
  const passedAfter = (n: number) => {
    let calls = 0;
    return () => ++calls > n;
  };
  const second = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

  it("already passed: no incident is touched — it stays pending, and no attempt is counted", async () => {
    const f = world();
    await notifyPendingIncidents(client(f), deps(), NOW, { deadline: () => true });
    expect(f.world.securityIncident[0]).toMatchObject({ notifyState: "pending", notifyAttempts: 0, version: 2 });
    expect(notices(f)).toHaveLength(0);
  });

  it("passing after the first incident: the second waits for the next tick", async () => {
    const f = world();
    f.world.securityIncident.push({ ...incident({ id: second, alertedAt: plus(NOW, -1_000) }), zoneLinkIds: ["l0"] });
    f.world.securityIncidentReason.push({ id: "r2", createdAt: NOW, ...reason("back", plus(NOW, -50_000), { incidentId: second }) });
    await notifyPendingIncidents(client(f), deps(), NOW, { deadline: passedAfter(2) });
    expect(f.world.securityIncident.find((i) => i.id === INCIDENT)).toMatchObject({ notifyState: "done" });
    expect(f.world.securityIncident.find((i) => i.id === second)).toMatchObject({ notifyState: "pending" });
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(f.world.securityIncident.find((i) => i.id === second)).toMatchObject({ notifyState: "done" });
  });

  it("passing between deliveries: the rest stay queued, and redelivery sends them after two minutes", async () => {
    const f = world({ securityAlertRecipient: [{ userId: JORDAN, state: "receiving", origin: "chosen", version: 1, setById: STEFAN }] });
    await notifyPendingIncidents(client(f), deps(), NOW, { deadline: passedAfter(2) });
    expect(h.delivered).toHaveLength(1);
    const left = notices(f).filter((n) => n.outcome === "queued");
    expect(left).toHaveLength(1);
    await redeliverStuckNotices(client(f), plus(NOW, SECURITY_REDELIVER_AFTER_MS));
    expect(h.delivered).toHaveLength(2);
    expect(notices(f).filter((n) => n.outcome === "queued")).toHaveLength(0);
  });

  it("redelivery stops at the deadline too", async () => {
    const f = world({
      notificationLog: [{ id: "clog1", username: "stefan", kind: "event", title: "t", channels: "", deliveredAt: null, pushOutcome: null, createdAt: plus(NOW, -150_000) }],
      securityIncidentNotice: [
        { id: "n1", incidentId: INCIDENT, userId: STEFAN, username: "stefan", reason: "routed", outcome: "queued", notificationLogId: "clog1", createdAt: plus(NOW, -150_000) },
      ],
    });
    await redeliverStuckNotices(client(f), NOW, { deadline: () => true });
    expect(h.delivered).toHaveLength(0);
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "queued" });
  });
});

describe("redelivery", () => {
  function stuck(ageMs: number) {
    return {
      notificationLog: [{ id: "clog1", username: "stefan", kind: "event", title: "t", channels: "", deliveredAt: null, pushOutcome: null, createdAt: plus(NOW, -ageMs) }],
      securityIncidentNotice: [
        { id: "n1", incidentId: INCIDENT, userId: STEFAN, username: "stefan", reason: "routed", outcome: "queued", notificationLogId: "clog1", createdAt: plus(NOW, -ageMs) },
      ],
      securityIncident: [incident({ notifyState: "done" })],
    };
  }

  it("a notice still queued after 2 min is delivered again with the SAME tag, then settled from the row", async () => {
    const f = world(stuck(150_000));
    await redeliverStuckNotices(client(f), NOW);
    expect(h.delivered).toEqual([expect.objectContaining({ id: "clog1", opts: { tag: incidentTag(INCIDENT), priority: "alert" } })]);
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "sent", channels: "toast", settledAt: NOW });
  });

  it("review #7: a delivery whose outcome was never recorded settles outcome_unknown — never 'not reached'", async () => {
    const f = world();
    h.stampLost = true;
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "outcome_unknown", settledAt: NOW, channels: "", pushOutcome: null });
    const refs = (h.audit.mock.calls[0]![0] as { refs: { notices: Array<{ outcome: string }> } }).refs;
    expect(refs.notices).toEqual([expect.objectContaining({ userId: STEFAN, outcome: "outcome_unknown" })]);
  });

  it("review #7: redelivery cannot re-send a claimed row — it settles it outcome_unknown from the row, and the send is not repeated", async () => {
    const f = world(stuck(150_000));
    f.world.notificationLog[0]!.error = "delivery: outcome_unknown";
    await redeliverStuckNotices(client(f), NOW);
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "outcome_unknown", settledAt: NOW });
    expect(f.world.notificationLog[0]).toMatchObject({ deliveredAt: null, error: "delivery: outcome_unknown" });
  });

  it("an outcome_unknown notice counts against the hourly cap (a row was written, and may have been sent)", async () => {
    const prior = Array.from({ length: SECURITY_ALERT_HOURLY_CAP }, (_, k) => ({
      id: `u${k}`,
      incidentId: `00000000-0000-4000-8000-00000000020${k}`,
      userId: STEFAN,
      username: "stefan",
      reason: "routed",
      outcome: "outcome_unknown",
      notificationLogId: `lu${k}`,
      createdAt: plus(NOW, -(k + 1) * 60_000),
      settledAt: plus(NOW, -(k + 1) * 60_000),
    }));
    const f = world({ securityIncidentNotice: prior });
    await notifyPendingIncidents(client(f), deps(), NOW);
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "skipped_capped" });
  });

  it("a younger one is left alone; a redelivery that still cannot stamp the row settles not_sent (never a loop)", async () => {
    const young = world(stuck(60_000));
    await redeliverStuckNotices(client(young), NOW);
    expect(h.delivered).toHaveLength(0);

    const f = world(stuck(150_000));
    h.deliverFails = true;
    await redeliverStuckNotices(client(f), NOW);
    expect(noticeOf(f, STEFAN)).toMatchObject({ outcome: "not_sent", settledAt: NOW, channels: "" });
  });
});

describe("the alerts health row (§6.11)", () => {
  const receiving = (userId: string) => ({ userId, state: "receiving", origin: userId === STEFAN ? "owner_default" : "chosen", version: 0 });

  it("not configured: no opening hours, or no Inside / Staff only area with a link", async () => {
    const noHours = world({ securitySiteHours: [{ id: "singleton", state: "not_set", timezone: null, version: 0 }] });
    expect(await computeAlertsHealthRow(client(noHours), resolve, NOW)).toMatchObject({
      id: "alerts",
      state: "not_configured",
      detail: "After-hours alerts need opening hours and an area marked Inside or Staff only",
    });
    const onlyEntry = world({ securityZone: [{ ...areaRows(STOCK, "Door", "entry", ["back"]).zone }] });
    expect((await computeAlertsHealthRow(client(onlyEntry), resolve, NOW)).state).toBe("not_configured");
  });

  // WARP-2977 P2b-2 × WARP-2978 — lock rows feed no rule (D21): a door lock on an area is no camera.
  it("not configured: an Inside / Staff only area whose only link is a door lock can never raise an alert", async () => {
    const lockLink = { id: "stock-lock", zoneId: STOCK, sourceKind: "lock", sourceRef: "matter:7/1", sourceLabel: "Stock room lock", state: "active" };
    const onlyLock = world({ securityZoneLink: [lockLink] });
    expect(await alertsReady(client(onlyLock))).toBe(false);
    expect((await computeAlertsHealthRow(client(onlyLock), resolve, NOW)).state).toBe("not_configured");
    // A part of a camera's view does count, beside the lock.
    onlyLock.world.securityZoneLink.push({ ...areaRows(STOCK, "Stock room", "interior", ["back/till"]).links[0]!, id: "stock-part" });
    expect(await alertsReady(client(onlyLock))).toBe(true);
  });

  it("a door lock on an Inside area is not a camera nobody set to be told can see", async () => {
    const f = world({
      securityZoneLink: [
        ...areaRows(STOCK, "Stock room", "interior", ["front"]).links,
        { id: "stock-lock", zoneId: STOCK, sourceKind: "lock", sourceRef: "matter:7/1", sourceLabel: "Stock room lock", state: "active" },
      ],
      securityAlertRecipient: [{ ...receiving(STEFAN), state: "not_receiving" }, receiving(MARIA)],
      pushSubscription: [{ id: "p2", username: "maria", endpoint: "https://fcm.googleapis.com/y" }],
    });
    LEVELS[MARIA] = "act";
    // Maria sees the front camera: every camera an alert can come from is covered.
    expect(await computeAlertsHealthRow(client(f), resolve, NOW)).toMatchObject({ state: "ok", detail: "Alerts go to Maria" });
  });

  it("down: an alert failed in the last day", async () => {
    const f = world({ securityIncident: [incident({ notifyState: "failed", notifyAttempts: 3 })] });
    expect(await computeAlertsHealthRow(client(f), resolve, NOW)).toMatchObject({ state: "down", detail: "An alert couldn't be sent" });
  });

  it("down: nobody set to be told can open Security", async () => {
    const f = world({ securityAlertRecipient: [{ ...receiving(STEFAN), state: "not_receiving" }, receiving(MARIA)] });
    LEVELS[MARIA] = "view";
    expect(await computeAlertsHealthRow(client(f), resolve, NOW)).toMatchObject({
      state: "down",
      detail: "Nobody set to be told can open Security, so the owner is told instead",
    });
  });

  it("review #2 — down: an Inside / Staff only camera nobody set to be told can see (the owner is told about it instead)", async () => {
    const f = world({
      securityAlertRecipient: [{ ...receiving(STEFAN), state: "not_receiving" }, receiving(MARIA)],
      pushSubscription: [{ id: "p2", username: "maria", endpoint: "https://fcm.googleapis.com/y" }],
    });
    LEVELS[MARIA] = "act";
    expect(await computeAlertsHealthRow(client(f), resolve, NOW)).toMatchObject({
      state: "down",
      detail: "Nobody set to be told can see Back camera, so the owner is told about it instead",
    });
    // Give her the camera: covered, and the row reads ok.
    f.world.cameraAccessGrant.push({ id: "g2", userId: MARIA, cameraId: "cam-back" });
    expect(await computeAlertsHealthRow(client(f), resolve, NOW)).toMatchObject({ state: "ok", detail: "Alerts go to Maria" });
  });

  it("quiet: a receiver with no phone set up hears only while Droplet is open — named, to owner/admin", async () => {
    const f = world({
      securityAlertRecipient: [receiving(STEFAN), receiving(MARIA)],
      pushSubscription: [{ id: "p1", username: "stefan", endpoint: "https://fcm.googleapis.com/x" }],
    });
    LEVELS[MARIA] = "act";
    expect(await computeAlertsHealthRow(client(f), resolve, NOW)).toMatchObject({
      state: "quiet",
      detail: "Alerts reach Maria only while Droplet is open (no phone is set up for notifications)",
    });
    h.gate = false;
    expect((await computeAlertsHealthRow(client(f), resolve, NOW)).detail).toBe(
      "Alerts reach Maria and Stefan only while Droplet is open (phone notifications are turned off on this box)",
    );
  });

  it("ok: names who alerts go to", async () => {
    const f = world({
      securityAlertRecipient: [receiving(STEFAN), receiving(MARIA)],
      pushSubscription: [
        { id: "p1", username: "stefan", endpoint: "https://fcm.googleapis.com/x" },
        { id: "p2", username: "maria", endpoint: "https://fcm.googleapis.com/y" },
      ],
    });
    LEVELS[MARIA] = "act";
    expect(await computeAlertsHealthRow(client(f), resolve, NOW)).toMatchObject({ state: "ok", detail: "Alerts go to Maria and Stefan" });
  });
});

describe("routing reads and writes (routes 21–22)", () => {
  const req = { user: { id: STEFAN, role: "owner" } };

  it("the manage view lists every household person with eligibility, delivery and the manager suggestion", async () => {
    const f = world({
      department: [{ id: "d1", name: "Security", archivedAt: null }],
      departmentProfile: [{ departmentId: "d1", template: "security" }],
      departmentMembership: [{ id: "m1", departmentId: "d1", userId: MARIA, right: "manager" }],
      pushSubscription: [{ id: "p1", username: "stefan", endpoint: "https://fcm.googleapis.com/x" }],
    });
    LEVELS[MARIA] = "act";
    LEVELS[JORDAN] = "view";
    const view = await readAlertRouting(client(f), resolve, { id: STEFAN, role: "owner" }, "manage");
    expect(view).toMatchObject({ level: "manage", fallbackActive: false });
    const people = (view as unknown as { people: Array<Record<string, unknown>> }).people;
    expect(people.map((p) => p.name)).toEqual(["Jordan", "Maria", "Stefan"]);
    expect(people.find((p) => p.userId === STEFAN)).toMatchObject({
      role: "owner",
      state: "receiving",
      origin: "owner_default",
      version: 0,
      eligible: true,
      ineligibleReason: null,
      managesSecurityDepartment: false,
      delivery: "push",
    });
    expect(people.find((p) => p.userId === MARIA)).toMatchObject({ state: "not_receiving", origin: null, version: null, eligible: true, managesSecurityDepartment: true, delivery: "in_app_only" });
    expect(people.find((p) => p.userId === JORDAN)).toMatchObject({ eligible: false, ineligibleReason: "no_access" });
  });

  it("below manage it is a filter, not a gate: only the viewer's own line", async () => {
    const f = world();
    LEVELS[MARIA] = "act";
    expect(await readAlertRouting(client(f), resolve, { id: MARIA, role: "family" }, "act")).toEqual({
      level: "act",
      self: { state: "not_receiving", eligible: true },
    });
  });

  it("turning on an eligible person: locked, CAS-or-insert, audited in-tx LAST with the count of eligible receivers", async () => {
    const f = world();
    LEVELS[MARIA] = "act";
    await readAlertRouting(client(f), resolve, { id: STEFAN, role: "owner" }, "manage");
    let writesAtAudit = -1;
    h.inTxAudit.mockImplementation(async () => {
      writesAtAudit = f.log.length;
      return { id: 2n };
    });
    const r = await setAlertRouting(client(f), resolve, req, { userId: MARIA, state: "receiving", expectedVersion: null }, NOW);
    expect(r).toMatchObject({ status: "ok", person: { userId: MARIA, state: "receiving", origin: "chosen", version: 0 } });
    expect(f.world.securityAlertRecipient.find((x) => x.userId === MARIA)).toMatchObject({ state: "receiving", origin: "chosen", setById: STEFAN });
    expect(f.raw[0]).toMatch(/pg_advisory_xact_lock/);
    expect(h.inTxAudit).toHaveBeenCalledTimes(1);
    const params = h.inTxAudit.mock.calls[0]![1] as { refs: Record<string, unknown>; what: string };
    expect(params.refs).toMatchObject({ surface: "security", action: "alert_routing.set", userId: MARIA, state: "receiving", eligibleReceivers: 2 });
    expect(params.what).toBe("Security: Maria is told about alerts");
    // Nothing is written after the audit (it holds the chain lock until commit).
    expect(writesAtAudit).toBe(f.log.length);
    expect(f.log[f.log.length - 1]).toBe("securityAlertRecipient.createMany");
  });

  it("the last eligible receiver cannot be turned off: no_recipient, nothing written, nothing audited", async () => {
    const f = world();
    await readAlertRouting(client(f), resolve, { id: STEFAN, role: "owner" }, "manage");
    const r = await setAlertRouting(client(f), resolve, req, { userId: STEFAN, state: "not_receiving", expectedVersion: 0 }, NOW);
    expect(r).toEqual({ status: "no_recipient" });
    expect(f.world.securityAlertRecipient.find((x) => x.userId === STEFAN)).toMatchObject({ state: "receiving", version: 0 });
    expect(h.inTxAudit).not.toHaveBeenCalled();
  });

  it("an ineligible person cannot be turned on (not_eligible) — but can be turned off (clean-up)", async () => {
    const f = world({ securityAlertRecipient: [{ userId: JORDAN, state: "receiving", origin: "chosen", version: 3, setById: STEFAN }] });
    LEVELS[JORDAN] = "view";
    expect(await setAlertRouting(client(f), resolve, req, { userId: JORDAN, state: "receiving", expectedVersion: 3 }, NOW)).toEqual({
      status: "not_eligible",
      reason: "no_access",
    });
    const off = await setAlertRouting(client(f), resolve, req, { userId: JORDAN, state: "not_receiving", expectedVersion: 3 }, NOW);
    expect(off).toMatchObject({ status: "ok", person: { state: "not_receiving", version: 4 } });
  });

  it("review B: an ineligible person's receiving row can be switched off even when nobody eligible is left receiving", async () => {
    const f = world({
      securityAlertRecipient: [
        { userId: STEFAN, state: "not_receiving", origin: "chosen", version: 1, setById: STEFAN },
        { userId: JORDAN, state: "receiving", origin: "chosen", version: 3, setById: STEFAN },
      ],
    });
    LEVELS[JORDAN] = "view";
    const off = await setAlertRouting(client(f), resolve, req, { userId: JORDAN, state: "not_receiving", expectedVersion: 3 }, NOW);
    expect(off).toMatchObject({ status: "ok", person: { userId: JORDAN, state: "not_receiving", eligible: false, version: 4 } });
    expect(h.inTxAudit).toHaveBeenCalledTimes(1);
    // Switching him back on is still refused.
    expect(await setAlertRouting(client(f), resolve, req, { userId: JORDAN, state: "receiving", expectedVersion: 4 }, NOW)).toEqual({
      status: "not_eligible",
      reason: "no_access",
    });
  });

  it("…while switching off the last ELIGIBLE receiver is still refused", async () => {
    const f = world({
      securityAlertRecipient: [
        { userId: STEFAN, state: "not_receiving", origin: "chosen", version: 1, setById: STEFAN },
        { userId: MARIA, state: "receiving", origin: "chosen", version: 2, setById: STEFAN },
      ],
    });
    LEVELS[MARIA] = "act";
    expect(await setAlertRouting(client(f), resolve, req, { userId: MARIA, state: "not_receiving", expectedVersion: 2 }, NOW)).toEqual({
      status: "no_recipient",
    });
  });

  it("a stale version or a create over an existing row is a version conflict; an unknown person is not_found", async () => {
    const f = world();
    await readAlertRouting(client(f), resolve, { id: STEFAN, role: "owner" }, "manage");
    expect(await setAlertRouting(client(f), resolve, req, { userId: STEFAN, state: "receiving", expectedVersion: 7 }, NOW)).toEqual({
      status: "version_conflict",
    });
    expect(await setAlertRouting(client(f), resolve, req, { userId: STEFAN, state: "receiving", expectedVersion: null }, NOW)).toEqual({
      status: "version_conflict",
    });
    expect(
      await setAlertRouting(client(f), resolve, req, { userId: "99999999-9999-4999-8999-999999999999", state: "receiving", expectedVersion: null }, NOW),
    ).toEqual({ status: "not_found" });
  });
});
