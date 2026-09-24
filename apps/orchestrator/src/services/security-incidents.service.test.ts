/**
 * WARP-2978 (ADR-059 P3 spec §6.1, §6.5, §6.10, §6.11) — the incident engine
 * over the in-memory fake (src/__tests__/security-incidents.fake.ts), which
 * models Prisma's where language, the unique keys, the FKs, the WARP-2978
 * CHECKs and transaction rollback.
 *
 * What is pinned here: the first-run boundary (history is never grouped), the
 * triage ledger (exactly one row per event, `failed` never blocks the queue),
 * the gap-safe floor (2 min AND a drained batch), grouping and the reason
 * codes end to end, the CAS retry, escalation, sealing (quiet + settle + a
 * drained backlog), the camera_offline timer, retention, and the `incidents`
 * health row. Concurrency and the real CHECKs are the pg lane's
 * (security-incidents.pg.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const alerts = vi.hoisted(() => ({
  notify: vi.fn(async () => ({ incidents: 0 })),
  redeliver: vi.fn(async () => ({ redelivered: 0 })),
  recompute: vi.fn(async () => undefined),
}));

vi.mock("./security-alerts.service.js", () => ({
  notifyPendingIncidents: alerts.notify,
  redeliverStuckNotices: alerts.redeliver,
  recomputeAlertsHealth: alerts.recompute,
}));

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
  recordActivityInTx: vi.fn(),
  getActivityRecorder: () => null,
}));

import {
  FLOOR_SETTLE_MS,
  QUIET_MS,
  SECURITY_INCIDENT_INTERVAL_MS,
  SECURITY_INCIDENT_LOCK_KEY,
  SETTLE_MS,
  TRIAGE_BATCH,
  TRIAGE_TRANSIENT_ATTEMPTS,
  TICK_DEADLINE_MS,
  IncidentConflictError,
  isTransientTriageError,
  _resetIncidentHealthForTests,
  incidentHealthRow,
  incidentHealthState,
  registerSecurityIncidentJobs,
  tickSecurityIncidents,
  trimSecurityIncidents,
  type SecurityIncidentDeps,
} from "./security-incidents.service.js";
import { areaRows, createFakeSecurityPrisma, eventRow, officeHours, type FakeSecurityPrisma, type FakeWorld } from "../__tests__/security-incidents.fake.js";

/** 22:14 in London (BST) on Wednesday 2026-09-23 — the site closed at 17:00. */
const T0 = new Date("2026-09-23T21:14:00Z");
const NOON = new Date("2026-09-23T11:00:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

const STOCK = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61";
const TILL = "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c82";

function engineState(floor = 0n, candidateAt = T0): Record<string, unknown> {
  return { id: "singleton", startedAtId: 0n, startedAt: T0, triageFloor: floor, floorCandidate: floor, floorCandidateAt: candidateAt, updatedAt: T0 };
}

function world(over: Partial<FakeWorld> = {}, now = T0): FakeSecurityPrisma {
  const hours = officeHours();
  const stock = areaRows(STOCK, "Stock room", "interior", ["back"]);
  return createFakeSecurityPrisma(
    {
      securityZone: [stock.zone],
      securityZoneLink: stock.links,
      securitySiteHours: [hours.header],
      securitySchedule: hours.days,
      securityModeState: [
        { id: "singleton", mode: "closed", modeSource: "schedule", manualEnd: "none", manualUntil: null, setAt: T0, version: 3 },
      ],
      securityIncidentEngineState: [engineState()],
      ...over,
    },
    now,
  );
}

function deps(f: FakeSecurityPrisma): SecurityIncidentDeps {
  return { isSecurityModuleOn: async () => true, resolveAccess: vi.fn(async () => null), now: f.now };
}

async function tick(f: FakeSecurityPrisma, at?: Date) {
  if (at) f.setNow(at);
  return tickSecurityIncidents(f.client as unknown as PrismaClient, deps(f));
}

const incidents = (f: FakeSecurityPrisma) => f.world.securityIncident;
const triage = (f: FakeSecurityPrisma, id: bigint) => f.world.securityEventTriage.find((t) => t.eventId === id);

beforeEach(() => {
  _resetIncidentHealthForTests();
  alerts.notify.mockClear();
  alerts.redeliver.mockClear();
  alerts.recompute.mockClear();
});

describe("the first run (D16)", () => {
  it("starts at the current max id: history is never grouped, the next event is", async () => {
    const f = world({
      securityIncidentEngineState: [],
      securityEvent: [eventRow({ id: 1n }), eventRow({ id: 2n }), eventRow({ id: 3n })],
    });
    await tick(f);
    expect(f.world.securityIncidentEngineState[0]).toMatchObject({ startedAtId: 3n, triageFloor: 3n, floorCandidate: 3n });
    expect(f.world.securityEventTriage).toHaveLength(0);
    expect(incidents(f)).toHaveLength(0);

    f.world.securityEvent.push(eventRow({ id: 4n }));
    await tick(f, plus(T0, 10_000));
    expect(f.world.securityEventTriage.map((t) => t.eventId)).toEqual([4n]);
  });

  it("an empty store starts at 0", async () => {
    const f = world({ securityIncidentEngineState: [] });
    await tick(f);
    expect(f.world.securityIncidentEngineState[0]).toMatchObject({ startedAtId: 0n, triageFloor: 0n });
  });
});

describe("triage: one person in the Stock room after closing", () => {
  it("opens an alert incident with after_hours_presence, its evidence and its membership row", async () => {
    const f = world({ securityEvent: [eventRow({ id: 1n })] });
    await tick(f);
    expect(incidents(f)).toHaveLength(1);
    const i = incidents(f)[0]!;
    expect(i).toMatchObject({
      scope: "area",
      zoneId: STOCK,
      zoneName: "Stock room",
      zoneKind: "interior",
      zoneLinkIds: [`${STOCK.slice(0, 8)}-l0`],
      scopeCamera: null,
      openedInMode: "closed",
      grouping: "collecting",
      state: "open",
      severity: "alert",
      reasonCodes: ["after_hours_presence"],
      notifyState: "pending",
      alertedAt: T0,
      rulesetVersion: 1,
      eventCount: 1,
      cameras: ["back"],
      countsByCamera: { back: { person: 1 } },
      firstActivityAt: T0,
      lastActivityAt: plus(T0, 20_000),
      lastArrivalAt: plus(T0, 21_000),
      spanByCamera: { back: { first: T0.toISOString(), last: plus(T0, 20_000).toISOString() } },
    });
    expect(f.world.securityIncidentReason).toEqual([
      expect.objectContaining({
        incidentId: i.id,
        code: "after_hours_presence",
        severity: "alert",
        evidenceEventId: 1n,
        evidenceCamera: "back",
        evidenceLabel: "person",
        detail: expect.objectContaining({ mode: "closed", modeSource: "schedule", zoneKind: "interior" }),
      }),
    ]);
    expect(triage(f, 1n)).toMatchObject({
      outcome: "grouped",
      incidentId: i.id,
      matchedLinkIds: [`${STOCK.slice(0, 8)}-l0`],
      alsoZoneIds: [],
      rulesetVersion: 1,
    });
  });

  it("each event is triaged in its own READ COMMITTED transaction; the mode timeline is one REPEATABLE READ snapshot", async () => {
    const f = world({ securityEvent: [eventRow({ id: 1n }), eventRow({ id: 2n, startedAt: plus(T0, 60_000) })] });
    await tick(f);
    expect(f.txLevels.filter((l) => l === "ReadCommitted")).toHaveLength(2);
    expect(f.txLevels[0]).toBe("RepeatableRead");
  });

  it("the same visit in open hours is plain activity: no code, nothing to acknowledge", async () => {
    const f = world({ securityEvent: [eventRow({ id: 1n, startedAt: NOON })] }, NOON);
    f.world.securityModeState[0]!.mode = "open";
    await tick(f);
    expect(incidents(f)[0]).toMatchObject({ state: "no_action", severity: "info", reasonCodes: [], notifyState: "not_needed", openedInMode: "open" });
  });

  it("an event in two areas groups under the most sensitive, and records the other", async () => {
    const till = areaRows(TILL, "Till", "restricted", ["back/till"]);
    const f = world({ securityEvent: [eventRow({ id: 1n, cameraZones: ["till"] })] });
    f.world.securityZone.push(till.zone);
    f.world.securityZoneLink.push(...till.links);
    await tick(f);
    expect(incidents(f)[0]).toMatchObject({ zoneId: TILL, zoneKind: "restricted" });
    expect(triage(f, 1n)).toMatchObject({ alsoZoneIds: [STOCK] });
  });

  it("a camera no area covers → camera scope, with no after-hours code", async () => {
    const f = world({ securityEvent: [eventRow({ id: 1n, camera: "yard", sourceRef: "yard/1.5-a" })] });
    await tick(f);
    expect(incidents(f)[0]).toMatchObject({ scope: "camera", scopeCamera: "yard", zoneId: null, state: "no_action" });
  });

  it("low, context and lone-recovery rows are ledgered and never grouped", async () => {
    const f = world({
      securityEvent: [
        eventRow({ id: 1n, kind: "detection_low" }),
        eventRow({ id: 2n, kind: "mode_changed", source: "site_mode", camera: null, labels: ["closed", "schedule", "open"] }),
        eventRow({ id: 3n, kind: "camera_online", source: "frigate_status", labels: [], endedAt: null }),
        eventRow({ id: 4n, kind: "lock_state", source: "matter_lock", camera: null, labels: ["unlocked"] }),
      ],
    });
    await tick(f);
    expect([1n, 2n, 3n, 4n].map((id) => triage(f, id)?.outcome)).toEqual(["low", "context", "context", "context"]);
    expect(incidents(f)).toHaveLength(0);
  });

  it("joins inside 5 min of quiet; opens a new incident after 5 min + 1 s", async () => {
    const e1 = eventRow({ id: 1n });
    const e2 = eventRow({ id: 2n, startedAt: plus(T0, 140_000) });
    const e3 = eventRow({ id: 3n, startedAt: plus(e2.endedAt as Date, QUIET_MS + 1_000) });
    const f = world({ securityEvent: [e1, e2, e3] });
    await tick(f);
    expect(incidents(f)).toHaveLength(2);
    expect(triage(f, 1n)!.incidentId).toBe(triage(f, 2n)!.incidentId);
    expect(triage(f, 3n)!.incidentId).not.toBe(triage(f, 1n)!.incidentId);
    const first = incidents(f).find((i) => i.id === triage(f, 1n)!.incidentId)!;
    expect(first).toMatchObject({ eventCount: 2, countsByCamera: { back: { person: 2 } }, lastActivityAt: e2.endedAt });
    // One reason row per evidence event, both on the first incident.
    expect(f.world.securityIncidentReason.filter((r) => r.incidentId === first.id)).toHaveLength(2);
  });

  it("threat_signal: a sign-in warning fires; Droplet's own push bookkeeping (sub web_push) does not", async () => {
    const f = world({
      activityRow: [
        { id: 70n, sub: "login", kind: "auth", severity: "warn" },
        { id: 71n, sub: "web_push", kind: "network", severity: "warn" },
      ],
      securityEvent: [
        eventRow({ id: 1n, kind: "threat", source: "activity_mirror", camera: null, sourceRef: "activity:70", labels: ["auth"], endedAt: null, startedAt: plus(T0, -600_000) }),
        eventRow({ id: 2n, kind: "threat", source: "activity_mirror", camera: null, sourceRef: "activity:71", labels: ["network"], endedAt: null }),
      ],
    });
    await tick(f);
    const [a, b] = [incidents(f).find((i) => i.id === triage(f, 1n)!.incidentId)!, incidents(f).find((i) => i.id === triage(f, 2n)!.incidentId)!];
    expect(a).toMatchObject({ scope: "site_threat", severity: "notice", reasonCodes: ["threat_signal"], state: "open" });
    expect(b).toMatchObject({ scope: "site_threat", severity: "info", reasonCodes: [] });
  });
});

describe("exactly once, and never blocked", () => {
  it("a PERMANENT triage failure is recorded `failed` with why, and the next event still triages", async () => {
    const f = world({ securityEvent: [eventRow({ id: 1n }), eventRow({ id: 2n, camera: "yard", sourceRef: "yard/2.5-a" })] });
    const permanent = new Error('new row for relation "SecurityIncident" violates check constraint "SecurityIncident_span"');
    f.failOn("securityIncident", "create", undefined, { error: permanent });
    await tick(f);
    expect(triage(f, 1n)).toMatchObject({ outcome: "failed", incidentId: null, error: expect.stringContaining("SecurityIncident_span") });
    expect(triage(f, 2n)).toMatchObject({ outcome: "grouped" });
    // The failed transaction left nothing behind: one incident (event 2's).
    expect(incidents(f)).toHaveLength(1);
    expect(incidentHealthState().failedLastDay).toBe(1);
  });

  it("a lost CAS re-reads and retries once", async () => {
    const f = world({ securityEvent: [eventRow({ id: 1n })] });
    await tick(f);
    f.world.securityEvent.push(eventRow({ id: 2n, startedAt: plus(T0, 60_000) }));
    f.onCall("securityIncident", "updateMany", (w) => {
      (w.securityIncident[0]!.version as number)++;
    });
    await tick(f, plus(T0, 90_000));
    expect(triage(f, 2n)).toMatchObject({ outcome: "grouped", incidentId: incidents(f)[0]!.id });
    expect(incidents(f)[0]).toMatchObject({ eventCount: 2 });
  });

  it("losing the CAS twice is transient: nothing recorded this tick, and the next tick groups the event", async () => {
    const f = world({ securityEvent: [eventRow({ id: 1n })] });
    await tick(f);
    f.world.securityEvent.push(eventRow({ id: 2n, startedAt: plus(T0, 60_000) }));
    const bump = (w: FakeWorld) => {
      (w.securityIncident[0]!.version as number)++;
    };
    f.onCall("securityIncident", "updateMany", bump);
    f.onCall("securityIncident", "updateMany", bump);
    await tick(f, plus(T0, 90_000));
    expect(triage(f, 2n)).toBeUndefined();
    expect(incidents(f)[0]).toMatchObject({ eventCount: 1 });
    await tick(f, plus(T0, 100_000));
    expect(triage(f, 2n)).toMatchObject({ outcome: "grouped", incidentId: incidents(f)[0]!.id });
    expect(incidents(f)[0]).toMatchObject({ eventCount: 2 });
  });

  // Review #3: a pool timeout, a dropped connection or a deadlock is not the event's fault.
  describe("transient database errors are retried, never recorded as the event's failure", () => {
    const transient = (code: string) => Object.assign(new Error(`transient ${code}`), { code, name: "PrismaClientKnownRequestError" });

    it.each(["P2028", "P2024", "P1001", "P1017", "P2034"])("%s: nothing recorded, the tick stops triaging (order kept), the next tick groups it", async (code) => {
      const f = world({
        securityEvent: [eventRow({ id: 1n }), eventRow({ id: 2n, camera: "yard", sourceRef: "yard/2.5-a" })],
        securityIncidentEngineState: [engineState(0n, plus(T0, -FLOOR_SETTLE_MS - 60_000))],
      });
      f.failOn("securityIncident", "create", undefined, { error: transient(code) });
      await tick(f);
      expect(f.world.securityEventTriage).toHaveLength(0);
      // Not drained: the floor stays below the untriaged event.
      expect(f.world.securityIncidentEngineState[0]).toMatchObject({ triageFloor: 0n, floorCandidate: 0n });
      await tick(f, plus(T0, 10_000));
      expect(triage(f, 1n)).toMatchObject({ outcome: "grouped" });
      expect(triage(f, 2n)).toMatchObject({ outcome: "grouped" });
      expect(incidentHealthState().failedLastDay).toBe(0);
    });

    it("a deadlock reported inside an unknown request error (40P01) is transient too", async () => {
      const f = world({ securityEvent: [eventRow({ id: 1n })] });
      const deadlock = Object.assign(new Error('ConnectorError { code: "40P01", message: "deadlock detected" }'), { name: "PrismaClientUnknownRequestError" });
      f.failOn("securityIncident", "create", undefined, { error: deadlock });
      await tick(f);
      expect(triage(f, 1n)).toBeUndefined();
      await tick(f, plus(T0, 10_000));
      expect(triage(f, 1n)).toMatchObject({ outcome: "grouped" });
    });

    it(`a transient error that persists for ${TRIAGE_TRANSIENT_ATTEMPTS} ticks is recorded failed, and the queue moves on`, async () => {
      const f = world({ securityEvent: [eventRow({ id: 1n }), eventRow({ id: 2n, camera: "yard", sourceRef: "yard/2.5-a" })] });
      f.failOn("securityIncident", "create", (a) => (a as { data: { scopeCamera?: string } }).data.scopeCamera !== "yard", {
        always: true,
        error: transient("P1017"),
      });
      for (let n = 0; n < TRIAGE_TRANSIENT_ATTEMPTS - 1; n++) {
        await tick(f, plus(T0, n * 10_000));
        expect(f.world.securityEventTriage, `tick ${n + 1}`).toHaveLength(0);
      }
      await tick(f, plus(T0, TRIAGE_TRANSIENT_ATTEMPTS * 10_000));
      expect(triage(f, 1n)).toMatchObject({ outcome: "failed", error: expect.stringContaining("P1017") });
      expect(triage(f, 2n)).toMatchObject({ outcome: "grouped" });
    });

    it("the classifier: transient codes and SQLSTATEs yes; a CHECK violation, a TypeError, a unique clash no", () => {
      expect(isTransientTriageError(transient("P2028"))).toBe(true);
      expect(isTransientTriageError(new IncidentConflictError("x"))).toBe(true);
      expect(isTransientTriageError(Object.assign(new Error("x"), { name: "PrismaClientInitializationError" }))).toBe(true);
      expect(isTransientTriageError(Object.assign(new Error("boom"), { code: "P2010", meta: { code: "57P01" } }))).toBe(true);
      expect(isTransientTriageError(Object.assign(new Error("boom"), { code: "P2010", meta: { code: "23514" } }))).toBe(false);
      expect(isTransientTriageError(transient("P2002"))).toBe(false);
      expect(isTransientTriageError(new TypeError("x"))).toBe(false);
      expect(isTransientTriageError(new Error("disk full"))).toBe(false);
    });
  });
});

describe("the floor (§6.1 step 3): only after 2 min AND a drained batch", () => {
  const lows = (from: number, n: number) =>
    Array.from({ length: n }, (_, k) => eventRow({ id: BigInt(from + k), kind: "detection_low" }));

  it("a full batch never advances it; a drained one does only once the candidate is 2 min old", async () => {
    const f = world({
      securityEvent: lows(1, TRIAGE_BATCH + 1),
      securityIncidentEngineState: [engineState(0n, plus(T0, -FLOOR_SETTLE_MS - 60_000))],
    });
    await tick(f);
    expect(f.world.securityEventTriage).toHaveLength(TRIAGE_BATCH);
    expect(f.world.securityIncidentEngineState[0]).toMatchObject({ triageFloor: 0n, floorCandidate: 0n });

    await tick(f, plus(T0, 10_000));
    expect(f.world.securityEventTriage).toHaveLength(TRIAGE_BATCH + 1);
    const head = BigInt(TRIAGE_BATCH + 1);
    expect(f.world.securityIncidentEngineState[0]).toMatchObject({
      triageFloor: 0n,
      floorCandidate: head,
      floorCandidateAt: plus(T0, 10_000),
    });

    f.world.securityEvent.push(...lows(TRIAGE_BATCH + 2, 1));
    await tick(f, plus(T0, 10_000 + FLOOR_SETTLE_MS - 1_000));
    expect(f.world.securityIncidentEngineState[0]).toMatchObject({ triageFloor: 0n, floorCandidate: head });

    await tick(f, plus(T0, 10_000 + FLOOR_SETTLE_MS));
    expect(f.world.securityIncidentEngineState[0]).toMatchObject({ triageFloor: head, floorCandidate: head + 1n });
  });

  it("nothing at or below the floor is looked at again", async () => {
    const f = world({ securityEvent: lows(1, 3), securityIncidentEngineState: [engineState(2n)] });
    await tick(f);
    expect(f.world.securityEventTriage.map((t) => t.eventId)).toEqual([3n]);
  });
});

describe("escalation (D22)", () => {
  it("an alert joining an acknowledged notice incident reopens it, sets alertedAt and a pending notify", async () => {
    const f = world({
      securityEvent: [
        eventRow({ id: 1n, kind: "camera_offline", source: "frigate_status", labels: [], endedAt: null, startedAt: plus(T0, -120_000) }),
      ],
    });
    await tick(f, plus(T0, -60_000 + 1_000));
    // The camera stayed down for a minute → a notice; a person acknowledges it.
    await tick(f, plus(T0, -40_000));
    const i = incidents(f)[0]!;
    expect(i).toMatchObject({ severity: "notice", state: "open", reasonCodes: ["camera_offline"], notifyState: "not_needed" });
    Object.assign(i, { state: "acknowledged", stateChangedById: "u-maria" });

    f.world.securityEvent.push(eventRow({ id: 2n }));
    await tick(f, plus(T0, 30_000));
    expect(incidents(f)[0]).toMatchObject({
      state: "open",
      severity: "alert",
      reasonCodes: ["after_hours_presence", "camera_offline"],
      notifyState: "pending",
      alertedAt: plus(T0, 30_000),
      stateChangedById: null,
    });
  });
});

describe("camera_offline at the tick", () => {
  const offline = (id: bigint, at: Date) =>
    eventRow({ id, kind: "camera_offline", source: "frigate_status", labels: [], endedAt: null, startedAt: at, createdAt: at, summary: "Camera back stopped reporting" });
  const online = (id: bigint, at: Date) =>
    eventRow({ id, kind: "camera_online", source: "frigate_status", labels: [], endedAt: null, startedAt: at, createdAt: at, summary: "Camera back is reporting again" });

  it("down with no recovery: nothing until 60 s, then one notice", async () => {
    const f = world({ securityEvent: [offline(1n, T0)] });
    await tick(f, plus(T0, 30_000));
    expect(incidents(f)[0]).toMatchObject({ state: "no_action", reasonCodes: [] });
    await tick(f, plus(T0, 61_000));
    expect(incidents(f)[0]).toMatchObject({ state: "open", severity: "notice", reasonCodes: ["camera_offline"] });
    expect(f.world.securityIncidentReason).toEqual([
      expect.objectContaining({ code: "camera_offline", evidenceEventId: 1n, detail: { offlineForSec: null, backAt: null } }),
    ]);
    await tick(f, plus(T0, 71_000));
    expect(f.world.securityIncidentReason).toHaveLength(1);
  });

  it("back within 59 s is a blip: the recovery joins, and no reason is ever added", async () => {
    const f = world({ securityEvent: [offline(1n, T0), online(2n, plus(T0, 59_000))] });
    await tick(f, plus(T0, 120_000));
    expect(incidents(f)).toHaveLength(1);
    expect(incidents(f)[0]).toMatchObject({ state: "no_action", eventCount: 2, countsByCamera: { back: { _status: 2 } } });
  });
});

describe("sealing (§6.1 step 5): quiet + settle, the last arrival, and a drained backlog", () => {
  it("seals at lastActivity + 5 min + 90 s, not a second before", async () => {
    const f = world({ securityEvent: [eventRow({ id: 1n })] });
    await tick(f);
    const due = plus(plus(T0, 20_000), QUIET_MS + SETTLE_MS);
    await tick(f, plus(due, -1_000));
    expect(incidents(f)[0]).toMatchObject({ grouping: "collecting", closedAt: null });
    await tick(f, due);
    expect(incidents(f)[0]).toMatchObject({ grouping: "closed", closedAt: due });
  });

  it("waits 90 s after the LAST ARRIVAL, however old its event time", async () => {
    const late = eventRow({ id: 1n, startedAt: plus(T0, -3_600_000 + 60_000), createdAt: T0 });
    late.endedAt = plus(late.startedAt as Date, 10_000);
    const f = world({ securityEvent: [late] });
    await tick(f);
    await tick(f, plus(T0, SETTLE_MS - 1_000));
    expect(incidents(f)[0]!.grouping).toBe("collecting");
    await tick(f, plus(T0, SETTLE_MS));
    expect(incidents(f)[0]!.grouping).toBe("closed");
  });

  it("a backlog never seals an incident its own queued events should have joined", async () => {
    const f = world({ securityEvent: [eventRow({ id: 1n })] });
    await tick(f);
    const due = plus(plus(T0, 20_000), QUIET_MS + SETTLE_MS);
    f.world.securityEvent.push(
      ...Array.from({ length: TRIAGE_BATCH + 1 }, (_, k) => eventRow({ id: BigInt(10 + k), kind: "detection_low" })),
    );
    await tick(f, due);
    expect(incidents(f)[0]!.grouping).toBe("collecting");
    await tick(f, plus(due, 10_000));
    expect(incidents(f)[0]!.grouping).toBe("closed");
  });

  it("a sealed incident never takes a late member: the late event opens its own", async () => {
    const f = world({ securityEvent: [eventRow({ id: 1n })] });
    await tick(f);
    const due = plus(plus(T0, 20_000), QUIET_MS + SETTLE_MS);
    await tick(f, due);
    f.world.securityEvent.push(eventRow({ id: 2n, startedAt: plus(T0, 30_000), createdAt: plus(due, 1_000) }));
    await tick(f, plus(due, 10_000));
    expect(incidents(f)).toHaveLength(2);
    expect(triage(f, 2n)!.incidentId).not.toBe(triage(f, 1n)!.incidentId);
  });
});

describe("after triage: the notifier, and health", () => {
  it("each tick hands pending alerts to the notifier and redelivers stuck notices; alerts health every 6th tick", async () => {
    const f = world();
    for (let n = 0; n < 6; n++) await tick(f, plus(T0, n * SECURITY_INCIDENT_INTERVAL_MS));
    expect(alerts.notify).toHaveBeenCalledTimes(6);
    expect(alerts.redeliver).toHaveBeenCalledTimes(6);
    expect(alerts.recompute).toHaveBeenCalledTimes(1);
  });

  it(`review #6: notify and redelivery get the tick's hard deadline (${TICK_DEADLINE_MS} ms), not yet passed at the start`, async () => {
    const f = world();
    await tick(f);
    const notifyOpts = (alerts.notify.mock.calls[0] as unknown[])[3] as { deadline: () => boolean };
    const redeliverOpts = (alerts.redeliver.mock.calls[0] as unknown[])[2] as { deadline: () => boolean };
    expect(notifyOpts.deadline()).toBe(false);
    expect(redeliverOpts.deadline()).toBe(false);
    expect(TICK_DEADLINE_MS).toBeLessThanOrEqual(45_000);
  });

  it("review #8: an alert's failed audit does not cut the tick short — redelivery, the failed count, alerts health and lastOkAt all run, THEN it rethrows", async () => {
    const f = world();
    alerts.notify.mockResolvedValueOnce({ incidents: 1, auditError: new Error("chain down") } as never);
    await expect(tick(f)).rejects.toThrow("chain down");
    expect(alerts.redeliver).toHaveBeenCalledTimes(1);
    expect(alerts.recompute).toHaveBeenCalledTimes(1);
    expect(incidentHealthState()).toMatchObject({ lastOkAt: T0, lastError: { at: T0, message: "chain down" } });
  });

  it("a completed tick sets lastOkAt; a throwing one records lastError and rethrows", async () => {
    const f = world();
    await tick(f);
    expect(incidentHealthState().lastOkAt).toEqual(T0);
    f.failOn("securityEvent", "aggregate", undefined, { error: new Error("db down") });
    await expect(tick(f, plus(T0, 10_000))).rejects.toThrow("db down");
    expect(incidentHealthState()).toMatchObject({ lastOkAt: T0, lastError: { at: plus(T0, 10_000), message: "db down" } });
  });

  it("registration schedules a 10 s interval on its own advisory lock and sets registeredAt (§7's boot assertion)", () => {
    const scheduleInterval = vi.fn();
    const f = world();
    registerSecurityIncidentJobs({ scheduleInterval }, f.client as unknown as PrismaClient, deps(f));
    expect(scheduleInterval).toHaveBeenCalledWith(SECURITY_INCIDENT_INTERVAL_MS, expect.any(Function), {
      lockKey: SECURITY_INCIDENT_LOCK_KEY,
    });
    expect(incidentHealthState().registeredAt).toBeInstanceOf(Date);
  });
});

describe("incidentHealthRow (§6.11)", () => {
  const NOW = T0;
  const base = { registeredAt: plus(NOW, -600_000), lastOkAt: plus(NOW, -5_000), lastError: null, failedLastDay: 0 };

  it("not registered → down, Not running", () => {
    expect(incidentHealthRow({ ...base, registeredAt: null, lastOkAt: null }, "Europe/London", NOW)).toEqual({
      id: "incidents",
      state: "down",
      detail: "Not running",
      lastSeenAt: null,
    });
  });

  it("freshly registered gets a 2-minute grace before 'hasn't sorted' is down", () => {
    expect(incidentHealthRow({ ...base, registeredAt: plus(NOW, -60_000), lastOkAt: null }, "Europe/London", NOW).state).toBe("ok");
    expect(incidentHealthRow({ ...base, registeredAt: plus(NOW, -121_000), lastOkAt: null }, "Europe/London", NOW)).toMatchObject({
      state: "down",
      detail: "Hasn't sorted new events since 10:11 PM",
    });
  });

  it("stale for more than 2 minutes → down, in the site's clock — or in minutes without one (never UTC)", () => {
    const stale = { ...base, lastOkAt: plus(NOW, -180_000) };
    expect(incidentHealthRow(stale, "Europe/London", NOW)).toMatchObject({ state: "down", detail: "Hasn't sorted new events since 10:11 PM" });
    expect(incidentHealthRow(stale, null, NOW)).toMatchObject({ state: "down", detail: "Hasn't sorted new events for 3 minutes" });
  });

  it("failed triage in the last day → down, counted", () => {
    expect(incidentHealthRow({ ...base, failedLastDay: 2 }, null, NOW)).toMatchObject({ state: "down", detail: "Couldn't sort 2 events in the last day" });
    expect(incidentHealthRow({ ...base, failedLastDay: 1 }, null, NOW).detail).toBe("Couldn't sort 1 event in the last day");
  });

  it("otherwise ok, with lastSeenAt = the last completed tick", () => {
    expect(incidentHealthRow(base, null, NOW)).toEqual({
      id: "incidents",
      state: "ok",
      detail: "Sorting events into incidents",
      lastSeenAt: base.lastOkAt.toISOString(),
    });
  });
});

describe("retention (§6.10, D30)", () => {
  const BEFORE = new Date("2026-08-24T03:50:00Z");
  const NOW = new Date("2026-09-23T03:50:00Z");
  function inc(id: string, over: Record<string, unknown>): Record<string, unknown> {
    return {
      id,
      scope: "camera",
      scopeCamera: "yard",
      openedInMode: "closed",
      grouping: "closed",
      closedAt: plus(BEFORE, -1),
      state: "no_action",
      severity: "info",
      reasonCodes: [],
      notifyState: "not_needed",
      rulesetVersion: 1,
      eventCount: 1,
      countsByCamera: {},
      cameras: ["yard"],
      eventsKept: "kept",
      version: 0,
      ...over,
    };
  }
  const coded = { state: "open", severity: "notice", reasonCodes: ["camera_offline"] };

  it("events trimmed → eventsKept follows exactly; plain activity goes with its events; coded incidents stay a year", async () => {
    const f = createFakeSecurityPrisma({
      securityIncident: [
        inc("gone-plain", { firstActivityAt: plus(BEFORE, -7_200_000), lastActivityAt: plus(BEFORE, -3_600_000) }),
        inc("gone-coded", { ...coded, firstActivityAt: plus(BEFORE, -7_200_000), lastActivityAt: plus(BEFORE, -3_600_000) }),
        inc("straddle", { ...coded, firstActivityAt: plus(BEFORE, -60_000), lastActivityAt: plus(BEFORE, 60_000) }),
        inc("recent", { firstActivityAt: plus(BEFORE, 60_000), lastActivityAt: plus(BEFORE, 120_000) }),
        inc("ancient-coded", { ...coded, firstActivityAt: plus(NOW, -366 * 86_400_000), lastActivityAt: plus(NOW, -366 * 86_400_000), eventsKept: "removed" }),
      ],
      securityEvent: [eventRow({ id: 5n, startedAt: plus(BEFORE, 60_000) }), eventRow({ id: 6n, startedAt: plus(BEFORE, 90_000) })],
      securityEventTriage: [
        { eventId: 5n, outcome: "grouped", incidentId: "straddle", matchedLinkIds: [], alsoZoneIds: [], rulesetVersion: 1 },
        { eventId: 6n, outcome: "grouped", incidentId: "recent", matchedLinkIds: [], alsoZoneIds: [], rulesetVersion: 1 },
      ],
      securityIncidentReason: [
        { incidentId: "ancient-coded", code: "camera_offline", severity: "notice", rulesetVersion: 1, evidenceEventId: 1n, evidenceSource: "frigate_status", evidenceKind: "camera_offline", evidenceAt: NOW, evidenceSummary: "x", detail: {} },
      ],
    });
    const r = await trimSecurityIncidents(f.client as unknown as PrismaClient, BEFORE, NOW);
    const byId = new Map(f.world.securityIncident.map((i) => [i.id, i]));
    expect([...byId.keys()].sort()).toEqual(["gone-coded", "recent", "straddle"]);
    expect(byId.get("gone-coded")).toMatchObject({ eventsKept: "removed" });
    expect(byId.get("straddle")).toMatchObject({ eventsKept: "partly_removed" });
    expect(byId.get("recent")).toMatchObject({ eventsKept: "kept" });
    expect(f.world.securityIncidentReason).toHaveLength(0);
    expect(r).toEqual({ marked: 2, deleted: 2 });
  });

  it("the members guard: an incident that still has a member is never deleted, so the Restrict FK can never fail the job", async () => {
    const f = createFakeSecurityPrisma({
      securityIncident: [inc("odd", { firstActivityAt: plus(BEFORE, -7_200_000), lastActivityAt: plus(BEFORE, -3_600_000) })],
      securityEvent: [eventRow({ id: 9n, startedAt: plus(BEFORE, 10) })],
      securityEventTriage: [{ eventId: 9n, outcome: "grouped", incidentId: "odd", matchedLinkIds: [], alsoZoneIds: [], rulesetVersion: 1 }],
    });
    await expect(trimSecurityIncidents(f.client as unknown as PrismaClient, BEFORE, NOW)).resolves.toMatchObject({ deleted: 0 });
    expect(f.world.securityIncident).toHaveLength(1);
  });
});
