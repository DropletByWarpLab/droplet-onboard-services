/**
 * WARP-2980 (ADR-059 P5 PR-B, p5b spec §11.1 C) — the pattern rules inside
 * the incident engine, end to end over the in-memory fake:
 *
 *   · a rare person after closing: P3's alert exactly as before, plus ONE
 *     trial flag — the incident's severity, codes, state, notify state and
 *     version are byte-for-byte those of the same run with no build (trial
 *     never counts, D2/D3); the flag reads the incident's area-kind SNAPSHOT
 *     (D10);
 *   · an entry area after closing: a trial flag at alert, and the incident
 *     stays plain activity — nobody is woken;
 *   · expected activity quiets the flag (`suppressed`, D11) and NEVER
 *     after_hours_presence (D12);
 *   · only grouped Frigate detections are judged (D5); a camera incident is
 *     judged against `camera:<name>`;
 *   · a pattern failure leaves the event grouped and the tick whole (D4);
 *   · 5 flags per (code, camera) per incident, and a re-run adds none.
 *
 * Every pre-existing engine suite seeds no build, so it runs through gate (b)
 * and proves "no build ⇒ exactly P3" (D26).
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

import { _resetIncidentHealthForTests, tickSecurityIncidents, type SecurityIncidentDeps } from "./security-incidents.service.js";
import { PatternTally, _resetPatternRulesForTests, flagPatterns, loadPatternContext, patternRuleHealth } from "./security-pattern-rules.js";
import { loadActiveLinks } from "./security-zones.service.js";
import {
  areaRows,
  baselineRows,
  createFakeSecurityPrisma,
  eventRow,
  officeHours,
  type BaselineKeyFixture,
  type FakeSecurityPrisma,
} from "../__tests__/security-incidents.fake.js";

const TZ = "Europe/London";
/** Wednesday 22:14 in London (BST) — closed by the office hours. */
const T0 = new Date("2026-09-23T21:14:00Z");
/** Wednesday 12:00 in London — open. */
const NOON = new Date("2026-09-23T11:00:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const STOCK = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61";

interface Opts {
  kind?: string;
  mode?: "open" | "closed";
  build?: boolean;
  keys?: BaselineKeyFixture[];
  suppressions?: Array<Record<string, unknown>>;
  at?: Date;
}

function world(o: Opts = {}): FakeSecurityPrisma {
  const hours = officeHours(TZ);
  const stock = areaRows(STOCK, "Stock room", o.kind ?? "interior", ["back"]);
  const b = baselineRows({
    keys: o.keys ?? [
      { zoneKey: `area:${STOCK}`, cameras: ["back"] },
      { zoneKey: "camera:front", cameras: ["front"] },
    ],
    sources: [
      { camera: "back", state: "active" },
      { camera: "front", state: "active" },
    ],
  });
  const at = o.at ?? T0;
  return createFakeSecurityPrisma(
    {
      securityZone: [stock.zone],
      securityZoneLink: stock.links,
      securitySiteHours: [hours.header],
      securitySchedule: hours.days,
      securityModeState: [{ id: "singleton", mode: o.mode ?? "closed", modeSource: "schedule", manualEnd: "none", manualUntil: null, setAt: at, version: 3 }],
      securityIncidentEngineState: [
        { id: "singleton", startedAtId: 0n, startedAt: at, triageFloor: 0n, floorCandidate: 0n, floorCandidateAt: plus(at, -180_000), updatedAt: at },
      ],
      ...(o.build === false ? {} : { securityBaselineBuild: [b.build], securityBaselineCell: b.cells }),
      securityBaselineSource: b.sources,
      securitySuppression: o.suppressions ?? [],
    },
    at,
  );
}

const db = (f: FakeSecurityPrisma) => f.client as unknown as PrismaClient;
const deps = (f: FakeSecurityPrisma): SecurityIncidentDeps => ({ isSecurityModuleOn: async () => true, resolveAccess: vi.fn(async () => null), now: f.now });

async function tick(f: FakeSecurityPrisma, at: Date) {
  f.setNow(at);
  return tickSecurityIncidents(db(f), deps(f));
}

/** The incident columns a reason moves — what a trial flag must never move. */
const P3_FIELDS = ["scope", "zoneId", "severity", "reasonCodes", "state", "notifyState", "alertedAt", "version", "eventCount", "grouping"] as const;
const p3View = (f: FakeSecurityPrisma) => f.world.securityIncident.map((i) => Object.fromEntries(P3_FIELDS.map((k) => [k, i[k]])));

beforeEach(() => {
  _resetIncidentHealthForTests();
  _resetPatternRulesForTests();
  alerts.notify.mockClear();
});

describe("a rare person in the Stock room (interior) after closing", () => {
  it("P3's alert exactly as before, plus one trial out_of_place flag; the tick counts it judged", async () => {
    const withBuild = world();
    const noBuild = world({ build: false });
    for (const f of [withBuild, noBuild]) {
      f.world.securityEvent.push(eventRow({ id: 10n, startedAt: T0 }));
      await tick(f, plus(T0, 30_000));
    }
    expect(p3View(withBuild)).toEqual(p3View(noBuild));
    expect(withBuild.world.securityIncident[0]).toMatchObject({
      severity: "alert",
      reasonCodes: ["after_hours_presence"],
      state: "open",
      notifyState: "pending",
    });
    expect(withBuild.world.securityIncidentReason.map((r) => r.code)).toEqual(["after_hours_presence"]);
    expect(withBuild.world.securityPatternFlag).toEqual([
      expect.objectContaining({
        incidentId: withBuild.world.securityIncident[0]!.id,
        code: "out_of_place",
        effect: "trial",
        severity: "alert",
        keyCameras: ["back"],
        rulesetVersion: 3,
        zoneKey: `area:${STOCK}`,
      }),
    ]);
    expect(noBuild.world.securityPatternFlag).toEqual([]);
    expect(withBuild.world.securityPatternDay).toEqual([expect.objectContaining({ date: "2026-09-23", outcome: "judged", count: 1 })]);
    expect(noBuild.world.securityPatternDay).toEqual([expect.objectContaining({ date: "2026-09-23", outcome: "no_build", count: 1 })]);
  });

  it("D10 — a joining detection's flag reads the incident's area-kind SNAPSHOT, not the area as it is now", async () => {
    // Open hours, a restricted area: out_of_place is notice + 1 (restricted) = alert.
    const f = world({ kind: "restricted", mode: "open", at: NOON });
    f.world.securityEvent.push(eventRow({ id: 10n, startedAt: NOON }));
    await tick(f, plus(NOON, 30_000));
    // Someone re-labels the area; the incident keeps its snapshot, and so must the flags joining it.
    f.world.securityZone[0]!.kind = "interior";
    f.world.securityEvent.push(eventRow({ id: 11n, startedAt: plus(NOON, 40_000), createdAt: plus(NOON, 61_000) }));
    await tick(f, plus(NOON, 70_000));
    expect(f.world.securityIncident).toHaveLength(1);
    expect(f.world.securityIncident[0]).toMatchObject({ zoneKind: "restricted", severity: "info", state: "no_action" });
    expect(f.world.securityPatternFlag.map((x) => [x.evidenceEventId, x.severity])).toEqual([
      [10n, "alert"],
      [11n, "alert"],
    ]);
  });
});

describe("a rare person at the Front door (entry) after closing", () => {
  it("a trial flag at alert — and the incident stays plain activity: nobody is woken", async () => {
    const f = world({ kind: "entry" });
    f.world.securityEvent.push(eventRow({ id: 10n, startedAt: T0 }));
    await tick(f, plus(T0, 30_000));
    expect(f.world.securityIncident[0]).toMatchObject({ severity: "info", state: "no_action", notifyState: "not_needed", reasonCodes: [], alertedAt: null });
    expect(f.world.securityIncidentReason).toEqual([]);
    expect(f.world.securityPatternFlag).toEqual([expect.objectContaining({ code: "out_of_place", effect: "trial", severity: "alert" })]);
    expect(f.world.securityIncidentNotice).toEqual([]);
  });
});

describe("expected activity quiets pattern flags, never after_hours_presence (D11, D12)", () => {
  it("covering the area, the label, the hour and all three codes: the P3 alert still fires; the flag is `suppressed` by it", async () => {
    const sup = {
      id: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
      targetKind: "area",
      zoneId: STOCK,
      label: "person",
      days: "every_day",
      hourFrom: 20,
      hourCount: 4,
      codes: ["out_of_place", "unusual_volume", "long_dwell"],
      reason: "The cleaner",
      createdById: "u-owner",
      createdByName: "Maria",
      createdAt: plus(T0, -86_400_000),
      expiresAt: plus(T0, 29 * 86_400_000),
    };
    const f = world({ suppressions: [sup] });
    f.world.securityEvent.push(eventRow({ id: 10n, startedAt: T0 }));
    await tick(f, plus(T0, 30_000));
    expect(f.world.securityIncident[0]).toMatchObject({ severity: "alert", reasonCodes: ["after_hours_presence"], notifyState: "pending" });
    expect(f.world.securityPatternFlag).toEqual([expect.objectContaining({ code: "out_of_place", effect: "suppressed", suppressionId: sup.id })]);
  });

  it("one that has passed its expiresAt but not yet been marked expired quiets nothing", async () => {
    const f = world({
      suppressions: [
        {
          targetKind: "area",
          zoneId: STOCK,
          label: "person",
          days: "every_day",
          hourFrom: 0,
          hourCount: 24,
          codes: ["out_of_place"],
          reason: "Old",
          createdById: "u",
          createdByName: "Maria",
          createdAt: plus(T0, -30 * 86_400_000),
          expiresAt: T0,
        },
      ],
    });
    f.world.securityEvent.push(eventRow({ id: 10n, startedAt: T0 }));
    await tick(f, plus(T0, 30_000));
    expect(f.world.securityPatternFlag).toEqual([expect.objectContaining({ effect: "trial", suppressionId: null })]);
  });
});

describe("what is judged (D5)", () => {
  it("detection_ongoing, detection_low, a threat and a camera going offline get no flag", async () => {
    const f = world();
    f.world.securityEvent.push(
      eventRow({ id: 10n, kind: "detection_ongoing", endedAt: null, dedupeKey: "frigate-ongoing:10", startedAt: T0 }),
      eventRow({ id: 11n, kind: "detection_low", startedAt: T0 }),
      eventRow({ id: 12n, source: "activity_mirror", kind: "threat", camera: null, labels: ["network"], sourceRef: "activity:1", startedAt: T0 }),
      eventRow({ id: 13n, source: "frigate_status", kind: "camera_offline", labels: [], startedAt: T0, endedAt: null }),
    );
    await tick(f, plus(T0, 30_000));
    expect(f.world.securityIncident.length).toBeGreaterThan(0);
    expect(f.world.securityPatternFlag).toEqual([]);
  });

  it("a camera no area covers is judged against camera:<name>", async () => {
    const f = world();
    f.world.securityEvent.push(eventRow({ id: 10n, camera: "front", sourceRef: "front/10.5-abc", startedAt: T0 }));
    await tick(f, plus(T0, 30_000));
    expect(f.world.securityIncident[0]).toMatchObject({ scope: "camera", scopeCamera: "front", severity: "info" });
    // A camera key has no area modifier: closed raises notice to alert.
    expect(f.world.securityPatternFlag).toEqual([
      expect.objectContaining({ zoneKey: "camera:front", keyCameras: ["front"], severity: "alert", detail: expect.objectContaining({ zoneKind: null }) }),
    ]);
  });
});

describe("a pattern failure never fails the event (D4)", () => {
  it("the flag write throws: the event is grouped (never `failed`), the tick completes and the floor advances", async () => {
    const f = world();
    f.failOn("securityPatternFlag", "createMany", undefined, { always: true });
    f.world.securityEvent.push(eventRow({ id: 10n, startedAt: T0 }));
    const r = await tick(f, plus(T0, 30_000));
    expect(r).toMatchObject({ triaged: 1, failed: 0, drained: true, floorAdvanced: true });
    expect(f.world.securityEventTriage).toEqual([expect.objectContaining({ eventId: 10n, outcome: "grouped" })]);
    expect(f.world.securityIncident[0]).toMatchObject({ severity: "alert", notifyState: "pending" });
    expect(f.world.securityPatternFlag).toEqual([]);
    expect(patternRuleHealth().lastError).toEqual({ at: plus(T0, 30_000), message: "something went wrong" });
    expect(f.world.securityPatternDay.map((d) => [d.outcome, d.count])).toEqual([
      ["judged", 1],
      ["failed", 1],
    ]);
  });
});

describe("the evidence cap (D4, spec test 20)", () => {
  it("7 rare detections on one camera in one incident: 5 flags per code; judging them again adds none", async () => {
    const f = world();
    const events = Array.from({ length: 7 }, (_, i) =>
      eventRow({ id: BigInt(10 + i), startedAt: plus(T0, i * 20_000), endedAt: plus(T0, i * 20_000 + 10_000), createdAt: plus(T0, i * 20_000 + 11_000) }),
    );
    f.world.securityEvent.push(...events);
    await tick(f, plus(T0, 200_000));
    expect(f.world.securityIncident).toHaveLength(1);
    const byCode = (code: string) => f.world.securityPatternFlag.filter((x) => x.code === code).length;
    expect(byCode("out_of_place")).toBe(5);
    expect(byCode("unusual_volume")).toBe(5);
    const incidentId = f.world.securityIncident[0]!.id as string;
    const ctx = await loadPatternContext(db(f), plus(T0, 200_000));
    const links = await loadActiveLinks(db(f));
    for (const e of events) {
      const written = await flagPatterns(
        db(f),
        e as never,
        { incidentId, key: { scope: "area", zoneId: STOCK, scopeCamera: null }, zoneKind: "interior", mode: "closed" },
        ctx,
        links,
        plus(T0, 200_000),
        new PatternTally(),
      );
      expect(written).toBe(0);
    }
    expect(f.world.securityPatternFlag).toHaveLength(10);
  });
});
