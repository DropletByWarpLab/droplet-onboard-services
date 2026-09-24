/**
 * WARP-2978 PR-D (ADR-059 P3 spec §6.12, D35, R1) — early presence in the
 * incident engine, over the in-memory fake and a REAL in-flight map:
 *
 *   · a person in the Stock room after closing, still tracked 30 s in, gets
 *     ONE `detection_ongoing` row, written before triage — so the alert
 *     incident opens in that same tick, not at Frigate's `end`;
 *   · never a second row: not across ticks, not after a restart that
 *     re-learns the person (the row is found by its key);
 *   · the later `end` row joins THE SAME incident — held open while the
 *     person is in view, even past 6½ quiet minutes — and adds no second
 *     alert; the hold ends with the person (plus the grace) or at the span
 *     cap;
 *   · a person under the score gate, or Frigate's false positive, writes
 *     nothing; without an in-flight source the engine is exactly P3's.
 *
 * The real CHECK, the trigger and the engine on real rows are the pg lane's
 * (security-event-ongoing.pg.test.ts).
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
  MAX_SPAN_MS,
  QUIET_MS,
  SETTLE_MS,
  _resetIncidentHealthForTests,
  tickSecurityIncidents,
  writeOngoingRows,
  type SecurityIncidentDeps,
} from "./security-incidents.service.js";
import { createInflightTracker, INFLIGHT_END_GRACE_MS, type InflightTracker } from "./security-inflight.js";
import { SECURITY_RULESET_VERSION } from "../lib/security-rules.js";
import { areaRows, createFakeSecurityPrisma, eventRow, officeHours, type FakeSecurityPrisma } from "../__tests__/security-incidents.fake.js";

/** 22:14 in London (BST) on Wednesday 2026-09-23 — the site closed at 17:00. */
const T0 = new Date("2026-09-23T21:14:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const STOCK = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61";
const FID = "1790000000.1-abc";

function world(): FakeSecurityPrisma {
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
      securityIncidentEngineState: [
        { id: "singleton", startedAtId: 0n, startedAt: T0, triageFloor: 0n, floorCandidate: 0n, floorCandidateAt: T0, updatedAt: T0 },
      ],
    },
    T0,
  );
}

/** A raw Frigate message about the person, as camera.service hands it to the map. */
function frigate(type: "new" | "update" | "end", after: Record<string, unknown> = {}) {
  return {
    type,
    before: {},
    after: {
      id: FID,
      camera: "back",
      label: "person",
      start_time: T0.getTime() / 1000,
      end_time: null,
      top_score: 0.9,
      false_positive: false,
      entered_zones: [],
      ...after,
    },
  };
}

function deps(f: FakeSecurityPrisma, ongoing?: InflightTracker): SecurityIncidentDeps {
  return { isSecurityModuleOn: async () => true, resolveAccess: vi.fn(async () => null), now: f.now, ...(ongoing ? { ongoing } : {}) };
}

async function tick(f: FakeSecurityPrisma, ongoing: InflightTracker | undefined, at: Date) {
  f.setNow(at);
  return tickSecurityIncidents(f.client as unknown as PrismaClient, deps(f, ongoing));
}

const ongoingRows = (f: FakeSecurityPrisma) => f.world.securityEvent.filter((e) => e.kind === "detection_ongoing");

/** Frigate's `end` for the person, as the ingest stores it (the `detection` row), arriving at `at`. */
function endRow(f: FakeSecurityPrisma, at: Date) {
  const row = eventRow({
    id: 900n,
    sourceRef: `back/${FID}`,
    dedupeKey: `frigate:${FID}`,
    startedAt: T0,
    endedAt: at,
    createdAt: at,
  });
  f.world.securityEvent.push(row);
  return row;
}

beforeEach(() => {
  _resetIncidentHealthForTests();
  alerts.notify.mockClear();
});

describe("a person still in view after closing alerts at 30 s, before their end", () => {
  it("nothing at 29 s; at 30 s ONE detection_ongoing row, triaged in the same tick into an alert incident", async () => {
    const f = world();
    const t = createInflightTracker();
    t.observe(frigate("new", { entered_zones: ["aisle"] }), T0);

    await tick(f, t, plus(T0, 29_000));
    expect(ongoingRows(f)).toHaveLength(0);
    expect(f.world.securityIncident).toHaveLength(0);

    await tick(f, t, plus(T0, 30_000));
    expect(ongoingRows(f)).toEqual([
      expect.objectContaining({
        source: "frigate",
        kind: "detection_ongoing",
        severity: "info",
        camera: "back",
        sourceRef: `back/${FID}`,
        dedupeKey: `frigate-ongoing:${FID}`,
        labels: ["person"],
        cameraZones: ["aisle"],
        score: 0.9,
        startedAt: T0,
        endedAt: null,
        summary: "Person still in view after 30 s",
        createdAt: plus(T0, 30_000),
      }),
    ]);
    const ongoing = ongoingRows(f)[0]!;
    expect(f.world.securityIncident).toEqual([
      expect.objectContaining({
        scope: "area",
        zoneId: STOCK,
        severity: "alert",
        state: "open",
        reasonCodes: ["after_hours_presence"],
        notifyState: "pending",
        alertedAt: plus(T0, 30_000),
        rulesetVersion: SECURITY_RULESET_VERSION,
        // It proves presence from the start of tracking to when it was written.
        firstActivityAt: T0,
        lastActivityAt: plus(T0, 30_000),
        eventCount: 1,
        // Counted as `_ongoing`, never as a second person: the end row counts them.
        countsByCamera: { back: { _ongoing: 1 } },
      }),
    ]);
    expect(f.world.securityIncidentReason).toEqual([
      expect.objectContaining({
        code: "after_hours_presence",
        severity: "alert",
        evidenceEventId: ongoing.id,
        evidenceKind: "detection_ongoing",
        evidenceCamera: "back",
        evidenceLabel: "person",
      }),
    ]);
  });

  it("never a second row: not on the next ticks, not while Frigate keeps updating", async () => {
    const f = world();
    const t = createInflightTracker();
    t.observe(frigate("new"), T0);
    for (let s = 30; s <= 120; s += 10) {
      t.observe(frigate("update", { top_score: 0.95 }), plus(T0, s * 1000));
      await tick(f, t, plus(T0, s * 1000));
    }
    expect(ongoingRows(f)).toHaveLength(1);
    expect(f.world.securityIncident).toHaveLength(1);
    expect(f.world.securityIncident[0]).toMatchObject({ eventCount: 1 });
  });

  it("after a restart (a fresh map) the person is re-learned and their stored row is found — not written twice", async () => {
    const f = world();
    const before = createInflightTracker();
    before.observe(frigate("new"), T0);
    await tick(f, before, plus(T0, 30_000));
    expect(ongoingRows(f)).toHaveLength(1);

    const after = createInflightTracker();
    after.observe(frigate("update"), plus(T0, 90_000));
    const written = await writeOngoingRows(f.client as unknown as PrismaClient, after, plus(T0, 90_000));
    expect(written).toBe(0);
    expect(ongoingRows(f)).toHaveLength(1);
    // Found by its key, so it is not asked for again.
    expect(after.due(plus(T0, 100_000))).toEqual([]);
  });

  it("a write that failed is retried on the next tick", async () => {
    const f = world();
    const t = createInflightTracker();
    t.observe(frigate("new"), T0);
    f.failOn("securityEvent", "createMany");
    expect(await writeOngoingRows(f.client as unknown as PrismaClient, t, plus(T0, 30_000))).toBe(0);
    expect(ongoingRows(f)).toHaveLength(0);
    expect(await writeOngoingRows(f.client as unknown as PrismaClient, t, plus(T0, 40_000))).toBe(1);
    expect(ongoingRows(f)).toHaveLength(1);
  });

  it.each([
    ["under the detection gate", { top_score: 0.69 }],
    ["Frigate's false positive", { false_positive: true }],
    ["not a person", { label: "car" }],
  ])("writes nothing for a track %s", async (_name, over) => {
    const f = world();
    const t = createInflightTracker();
    t.observe(frigate("new", over), T0);
    await tick(f, t, plus(T0, 60_000));
    expect(ongoingRows(f)).toHaveLength(0);
    expect(f.world.securityIncident).toHaveLength(0);
  });

  it("without an in-flight source the engine writes no ongoing row (P3 as it was)", async () => {
    const f = world();
    await tick(f, undefined, plus(T0, 60_000));
    expect(f.world.securityEvent).toHaveLength(0);
  });

  it("the same stay in opening hours is plain activity: the row is written, nothing alerts", async () => {
    const NOON = new Date("2026-09-23T11:00:00Z");
    const f = world();
    f.world.securityModeState[0]!.mode = "open";
    const t = createInflightTracker();
    t.observe(frigate("new", { start_time: NOON.getTime() / 1000 }), NOON);
    await tick(f, t, plus(NOON, 30_000));
    expect(ongoingRows(f)).toHaveLength(1);
    expect(f.world.securityIncident[0]).toMatchObject({ severity: "info", state: "no_action", reasonCodes: [] });
  });
});

describe("the later end row joins the SAME incident", () => {
  async function alertAt30s() {
    const f = world();
    const t = createInflightTracker();
    t.observe(frigate("new"), T0);
    await tick(f, t, plus(T0, 30_000));
    expect(f.world.securityIncident).toHaveLength(1);
    return { f, t, incident: f.world.securityIncident[0]! };
  }

  it("a short stay: the end joins, counts the person once, and alerts no second time", async () => {
    const { f, t, incident } = await alertAt30s();
    t.observe(frigate("end"), plus(T0, 45_000));
    const end = endRow(f, plus(T0, 45_000));
    await tick(f, t, plus(T0, 50_000));
    expect(f.world.securityIncident).toHaveLength(1);
    expect(f.world.securityEventTriage.find((r) => r.eventId === end.id)).toMatchObject({ outcome: "grouped", incidentId: incident.id });
    expect(f.world.securityIncident[0]).toMatchObject({
      eventCount: 2,
      countsByCamera: { back: { _ongoing: 1, person: 1 } },
      alertedAt: plus(T0, 30_000),
      lastActivityAt: plus(T0, 45_000),
    });
  });

  it("a ten-minute stay: held open past 6½ quiet minutes while the person is in view, so the end still joins", async () => {
    const { f, t, incident } = await alertAt30s();
    // 8 minutes in: well past quiet + settle after the ongoing row — would seal, but the person is in view.
    await tick(f, t, plus(T0, 8 * 60_000));
    expect(f.world.securityIncident[0]).toMatchObject({ grouping: "collecting" });
    t.observe(frigate("end"), plus(T0, 10 * 60_000));
    const end = endRow(f, plus(T0, 10 * 60_000));
    await tick(f, t, plus(T0, 10 * 60_000 + 5_000));
    expect(f.world.securityIncident).toHaveLength(1);
    expect(f.world.securityEventTriage.find((r) => r.eventId === end.id)).toMatchObject({ incidentId: incident.id });
    expect(f.world.securityIncident[0]).toMatchObject({ eventCount: 2, alertedAt: plus(T0, 30_000) });
  });

  it("the end row still joins when it is triaged after the end (the grace covers the gap)", async () => {
    const { f, t, incident } = await alertAt30s();
    const endAt = plus(T0, 10 * 60_000);
    t.observe(frigate("end"), endAt);
    // A tick between the `end` message and its row reaching the store must not seal.
    await tick(f, t, plus(endAt, 1_000));
    expect(f.world.securityIncident[0]).toMatchObject({ grouping: "collecting" });
    const end = endRow(f, endAt);
    await tick(f, t, plus(endAt, 11_000));
    expect(f.world.securityEventTriage.find((r) => r.eventId === end.id)).toMatchObject({ incidentId: incident.id });
  });

  it("with nobody in view the incident seals after quiet + settle, as before PR-D (the hold is what keeps it open)", async () => {
    const { f, t } = await alertAt30s();
    t.forgetCamera("back");
    await tick(f, t, plus(T0, 30_000 + QUIET_MS + SETTLE_MS));
    expect(f.world.securityIncident[0]).toMatchObject({ grouping: "closed" });
    // Its end then opens an incident of its own (the documented long-stay split).
    const end = endRow(f, plus(T0, 10 * 60_000));
    await tick(f, t, plus(T0, 10 * 60_000 + 5_000));
    expect(f.world.securityIncident).toHaveLength(2);
    expect(f.world.securityEventTriage.find((r) => r.eventId === end.id)?.incidentId).toBe(f.world.securityIncident[1]!.id);
  });

  it("the grace ends: once the person left and the grace passed, the incident seals", async () => {
    const { f, t } = await alertAt30s();
    const endAt = plus(T0, 60_000);
    t.observe(frigate("end"), endAt);
    endRow(f, endAt);
    await tick(f, t, plus(endAt, 5_000));
    const sealAt = plus(endAt, Math.max(QUIET_MS + SETTLE_MS, INFLIGHT_END_GRACE_MS) + 1_000);
    await tick(f, t, sealAt);
    expect(f.world.securityIncident[0]).toMatchObject({ grouping: "closed" });
  });

  it("the hold stops at the span cap: past 60 min from the first activity no end could join, so it seals", async () => {
    const { f, t } = await alertAt30s();
    await tick(f, t, plus(T0, MAX_SPAN_MS));
    expect(f.world.securityIncident[0]).toMatchObject({ grouping: "collecting" });
    await tick(f, t, plus(T0, MAX_SPAN_MS + 1_000));
    expect(f.world.securityIncident[0]).toMatchObject({ grouping: "closed" });
  });
});
