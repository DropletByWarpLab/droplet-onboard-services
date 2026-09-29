/**
 * WARP-2978 (ADR-059 P3 spec §6.5, D18–D22) — the reason-code rules, one
 * block per code, plus how a reason moves the incident (severity, state,
 * notify) and the per-camera evidence cap. Pure.
 *
 * WARP-2980 (P5 PR-B, p5b spec §11.1 A) — the pattern rules: the three hits
 * (P5-A's arithmetic, D7), the severity table (D9), the expected-activity
 * match (D11–D13, one rule for the engine and route 31) and the pauses the
 * engine and route 31 share; every pattern code still `trial`; the code order
 * pinned to the Prisma enum.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  EVIDENCE_PER_CAMERA,
  PATTERN_RELEASE,
  PATTERN_RULES,
  REASON_CODE_ORDER,
  RULESET,
  afterHoursPresence,
  buildPause,
  cameraOfflineDuringActivity,
  cameraOfflineVerdict,
  rankPick,
  capEvidence,
  hourInWindow,
  keyPause,
  parseActivityRef,
  patternHits,
  patternSeverity,
  reasonPatch,
  suppressionCovers,
  suppressionFor,
  threatSignal,
  type PatternCells,
  type ReasonDraft,
  type ReasonState,
  type ActivitySighting,
  type AreaMatch,
  type SuppressionMatchRow,
  type TriageEvent,
} from "./security-rules.js";
import { PATTERN_CODES, slotRate, volumeThreshold, type CellCounts } from "./security-baseline-math.js";
import type { ModeHistoryRow, ModeTimeline } from "./security-mode-history.js";
import { hhmmToMinutes, weekFrom, type DayHours, type SiteHours } from "./security-hours.js";
import { zonedWallClockToUtc } from "./zoned-time.js";
import { PACKAGE_ROOT } from "../__tests__/helpers/test-paths.js";

const TZ = "Europe/London";
const closedDay: DayHours = { kind: "closed" };
const nineToFive: DayHours = { kind: "hours", opensMin: hhmmToMinutes("09:00")!, closesMin: hhmmToMinutes("17:00")! };
const HOURS: SiteHours = {
  state: "set",
  timezone: TZ,
  week: weekFrom(([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, ...(weekday <= 5 ? nineToFive : closedDay) }))),
  exceptions: new Map(),
};

function at(ymd: string, time: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return zonedWallClockToUtc(y!, mo!, d!, h!, mi!, 0, TZ);
}
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

const WED_NOON = at("2026-09-23", "12:00");
const WED_17 = at("2026-09-23", "17:00");
const WED_2214 = at("2026-09-23", "22:14");

const scheduleTl = (rows: ModeHistoryRow[] = [], hours: SiteHours = HOURS): ModeTimeline => ({
  stored: { mode: "open", modeSource: "schedule", manualEnd: "none", manualUntil: null },
  hours,
  rows,
});
const awayTl: ModeTimeline = {
  stored: { mode: "away", modeSource: "manual", manualEnd: "until_changed", manualUntil: null },
  hours: HOURS,
  rows: [],
};

let nextId = 100n;
function ev(over: Partial<TriageEvent> = {}): TriageEvent {
  const startedAt = over.startedAt ?? WED_2214;
  return {
    id: nextId++,
    source: "frigate",
    kind: "detection",
    camera: "back",
    sourceRef: "back/1727129640.5-abc",
    labels: ["person"],
    cameraZones: [],
    startedAt,
    endedAt: plus(startedAt, 20_000),
    createdAt: plus(startedAt, 21_000),
    summary: "Person seen by back",
    ...over,
  };
}

describe("after_hours_presence (alert) — a person inside while the site is not open", () => {
  it.each([
    ["interior", "closed (opening hours)", scheduleTl(), "closed"],
    ["restricted", "closed (opening hours)", scheduleTl(), "closed"],
    ["interior", "set to away", awayTl, "away"],
  ] as const)("fires for a person in an %s area while %s", (zoneKind, _what, tl, mode) => {
    const e = ev();
    const r = afterHoursPresence({ personLinked: true, scope: "area", zoneKind, event: e, timeline: tl });
    expect(r).toMatchObject({
      code: "after_hours_presence",
      severity: "alert",
      evidenceEventId: e.id,
      evidenceCamera: "back",
      evidenceLabel: "person",
      evidenceAt: e.startedAt,
      detail: { mode, zoneKind, nonOpenAt: e.startedAt.toISOString() },
    });
  });

  it("fires at a straddle: open when the person arrived, closed before they left", () => {
    const e = ev({ startedAt: plus(WED_17, -120_000), endedAt: plus(WED_17, 60_000) });
    const tl = scheduleTl([{ at: WED_17, mode: "closed", source: "schedule", fromMode: "open" }]);
    expect(afterHoursPresence({ personLinked: true, scope: "area", zoneKind: "interior", event: e, timeline: tl })?.detail).toMatchObject({
      mode: "closed",
      modeSource: "schedule",
      nonOpenAt: WED_17.toISOString(),
    });
  });

  it.each([
    ["a car", { labels: ["car"] }, "area", "interior", scheduleTl()],
    ["an entry area", {}, "area", "entry", scheduleTl()],
    ["a perimeter area", {}, "area", "perimeter", scheduleTl()],
    ["a parking area", {}, "area", "parking", scheduleTl()],
    ["a camera no area covers", {}, "camera", null, scheduleTl()],
    ["a detection_low row", { kind: "detection_low" }, "area", "interior", scheduleTl()],
    ["open throughout", { startedAt: WED_NOON, endedAt: plus(WED_NOON, 60_000) }, "area", "interior", scheduleTl()],
    ["hours not set and no manual mode", {}, "area", "interior", scheduleTl([], { state: "not_set" })],
  ] as const)("does not fire for %s", (_n, over, scope, zoneKind, tl) => {
    expect(afterHoursPresence({ personLinked: true, scope, zoneKind, event: ev(over as Partial<TriageEvent>), timeline: tl })).toBeNull();
  });

  // WARP-2978 PR-D (ruleset v2) — a person still in view 30 s in.
  const ongoing = (over: Partial<TriageEvent> = {}): TriageEvent => {
    const startedAt = over.startedAt ?? WED_2214;
    return ev({
      kind: "detection_ongoing",
      endedAt: null,
      createdAt: plus(startedAt, 30_000),
      summary: "Person still in view after 30 s",
      ...over,
    });
  };

  it("fires for a person STILL in view (detection_ongoing) — the alert need not wait for their end", () => {
    const e = ongoing();
    expect(afterHoursPresence({ personLinked: true, scope: "area", zoneKind: "interior", event: e, timeline: scheduleTl() })).toMatchObject({
      code: "after_hours_presence",
      severity: "alert",
      evidenceEventId: e.id,
      evidenceKind: "detection_ongoing",
      evidenceAt: e.startedAt,
      detail: { mode: "closed", nonOpenAt: e.startedAt.toISOString() },
    });
    expect(RULESET.after_hours_presence.kinds).toEqual(["detection", "detection_ongoing"]);
  });

  it("an ongoing row covers [startedAt, when it was written]: arrived before closing, still there after it", () => {
    const e = ongoing({ startedAt: plus(WED_17, -10_000), createdAt: plus(WED_17, 20_000) });
    const tl = scheduleTl([{ at: WED_17, mode: "closed", source: "schedule", fromMode: "open" }]);
    expect(afterHoursPresence({ personLinked: true, scope: "area", zoneKind: "interior", event: e, timeline: tl })?.detail).toMatchObject({
      nonOpenAt: WED_17.toISOString(),
    });
  });

  it.each([
    ["in opening hours", { startedAt: WED_NOON, createdAt: plus(WED_NOON, 30_000) }, "interior"],
    ["in an entry area", {}, "entry"],
    ["for a car", { labels: ["car"] }, "interior"],
  ] as const)("an ongoing row does not fire %s", (_n, over, zoneKind) => {
    expect(afterHoursPresence({ personLinked: true, scope: "area", zoneKind, event: ongoing(over as Partial<TriageEvent>), timeline: scheduleTl() })).toBeNull();
  });
});

describe("camera_offline (notice) — a camera down for more than a minute", () => {
  const OFF = WED_2214;
  const offline = (camera: string | null = "back") =>
    ev({
      source: "frigate_status",
      kind: camera ? "camera_offline" : "source_offline",
      camera,
      sourceRef: camera ? `${camera}/status/detect` : "frigate/available",
      labels: [],
      startedAt: OFF,
      endedAt: null,
      summary: camera ? `Camera ${camera} stopped reporting` : "The camera system stopped reporting",
    });

  it("back at +59 s is a blip: no reason, ever", () => {
    expect(cameraOfflineVerdict(offline(), [{ startedAt: plus(OFF, 59_000) }], plus(OFF, 600_000))).toEqual({ verdict: "blip" });
  });

  it("back at exactly +60 s is still a blip (the window is (o, o + 60 s])", () => {
    expect(cameraOfflineVerdict(offline(), [{ startedAt: plus(OFF, 60_000) }], plus(OFF, 600_000))).toEqual({ verdict: "blip" });
  });

  it("back at +61 s fires, with how long it was down and when it came back", () => {
    const back = plus(OFF, 61_000);
    const v = cameraOfflineVerdict(offline(), [{ startedAt: back }], plus(OFF, 600_000));
    expect(v).toMatchObject({
      verdict: "fire",
      reason: {
        code: "camera_offline",
        severity: "notice",
        evidenceCamera: "back",
        evidenceKind: "camera_offline",
        detail: { offlineForSec: 61, backAt: back.toISOString() },
      },
    });
  });

  it("an online row at the offline row's own instant is not a recovery (the window is open at o)", () => {
    expect(cameraOfflineVerdict(offline(), [{ startedAt: OFF }], plus(OFF, 120_000))).toMatchObject({ verdict: "fire" });
  });

  it("no online row: waits until +60 s, then fires at the tick with no duration", () => {
    expect(cameraOfflineVerdict(offline(), [], plus(OFF, 30_000))).toEqual({ verdict: "wait" });
    expect(cameraOfflineVerdict(offline(), [], plus(OFF, 59_999))).toEqual({ verdict: "wait" });
    expect(cameraOfflineVerdict(offline(), [], plus(OFF, 60_000))).toMatchObject({
      verdict: "fire",
      reason: { detail: { offlineForSec: null, backAt: null } },
    });
  });

  it("the camera system as a whole uses camera NULL (source_offline)", () => {
    const v = cameraOfflineVerdict(offline(null), [], plus(OFF, 90_000));
    expect(v).toMatchObject({ verdict: "fire", reason: { evidenceCamera: null, evidenceKind: "source_offline" } });
  });

  it("the rule's threshold is the ruleset's", () => {
    expect(RULESET.camera_offline.minOfflineMs).toBe(60_000);
  });
});

describe("threat_signal (notice) — a mirrored network or sign-in warning", () => {
  const threat = (over: Partial<TriageEvent> = {}) =>
    ev({
      source: "activity_mirror",
      kind: "threat",
      camera: null,
      sourceRef: "activity:4211",
      labels: ["auth"],
      endedAt: null,
      summary: "Sign-in refused",
      ...over,
    });

  it("fires for an auth warning, never at alert", () => {
    const e = threat();
    expect(threatSignal(e, { sub: "login" })).toMatchObject({
      code: "threat_signal",
      severity: "notice",
      evidenceCamera: null,
      evidenceLabel: "auth",
      detail: { activityId: "4211", kind: "auth" },
    });
  });

  it("skips Droplet's own push-egress bookkeeping (sub = web_push) — alerts produce those (D19)", () => {
    expect(threatSignal(threat({ labels: ["network"] }), { sub: "web_push" })).toBeNull();
  });

  it("fires when the chain row is gone (the 90-day purge)", () => {
    expect(threatSignal(threat(), null)).toMatchObject({ code: "threat_signal" });
  });

  it("does nothing for a row that is not a threat", () => {
    expect(threatSignal(ev(), { sub: null })).toBeNull();
  });

  it("parses `activity:<id>` and nothing else", () => {
    expect(parseActivityRef("activity:4211")).toBe(4211n);
    expect(parseActivityRef("activity:")).toBeNull();
    expect(parseActivityRef("activity:12a")).toBeNull();
    expect(parseActivityRef("back/1.5-abc")).toBeNull();
  });
});

/**
 * The folder that defines SecurityIncidentReason_code_severity LAST — the CHECK as a box holds it after every migration.
 * WARP-2979 (P4) re-adds it with camera_offline_during_activity's arm; P5 PR-D will move this again.
 */
const CODE_SEVERITY_FOLDER = "20260926000100_warp_2979_security_ai";

describe("the database pins D18: the CHECK's code/severity pairs are exactly the RULESET's", () => {
  it("SecurityIncidentReason_code_severity matches RULESET — P3's three codes and P4's (WARP-2980: no pattern code is a key of RULESET)", () => {
    const sql = readFileSync(path.join(PACKAGE_ROOT, "prisma", "migrations", CODE_SEVERITY_FOLDER, "migration.sql"), "utf8");
    const check = /"SecurityIncidentReason_code_severity" CHECK \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
    const pairs = new Map<string, string>();
    for (const m of check.matchAll(/"code" (?:= '(\w+)'|IN \(([^)]*)\)) AND "severity" = '(\w+)'/g)) {
      const codes = m[1] ? [m[1]] : m[2]!.split(",").map((c) => c.trim().replace(/'/g, ""));
      for (const c of codes) pairs.set(c, m[3]!);
    }
    expect(Object.fromEntries(pairs)).toEqual(
      Object.fromEntries(Object.entries(RULESET).map(([code, rule]) => [code, rule.severity])),
    );
    expect(Object.keys(RULESET).sort()).toEqual(["after_hours_presence", "camera_offline", "camera_offline_during_activity", "threat_signal"]);
  });

  it("WARP-2980 D3 — trial is a database fact: no P5 code appears in that CHECK (PR-D widens it with its first writer)", () => {
    const sql = readFileSync(path.join(PACKAGE_ROOT, "prisma", "migrations", CODE_SEVERITY_FOLDER, "migration.sql"), "utf8");
    const check = /"SecurityIncidentReason_code_severity" CHECK \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
    expect(check).toContain("after_hours_presence");
    for (const code of PATTERN_CODES) expect(check, code).not.toContain(code);
  });
});

describe("reasonPatch — a reason moves the incident, never back", () => {
  const plain: ReasonState = { severity: "info", reasonCodes: [], state: "no_action", notifyState: "not_needed", alertedAt: null };
  const NOW = plus(WED_2214, 5_000);
  const draft = (code: ReasonDraft["code"], severity: ReasonDraft["severity"]): ReasonDraft => ({
    code,
    severity,
    evidenceEventId: 1n,
    evidenceCamera: "back",
    evidenceSource: "frigate",
    evidenceKind: "detection",
    evidenceLabel: null,
    evidenceAt: WED_2214,
    evidenceSummary: "x",
    detail: {},
  });

  it("a notice opens a plain incident; no alert, nothing to send", () => {
    expect(reasonPatch(plain, [draft("camera_offline", "notice")], NOW)).toEqual({
      severity: "notice",
      reasonCodes: ["camera_offline"],
      state: "open",
      stateChangedAt: NOW,
      stateChangedById: null,
    });
  });

  it("an alert sets alertedAt and a pending notify", () => {
    expect(reasonPatch(plain, [draft("after_hours_presence", "alert")], NOW)).toMatchObject({
      severity: "alert",
      state: "open",
      alertedAt: NOW,
      notifyState: "pending",
    });
  });

  it("escalation to alert reopens an acknowledged incident (D22)", () => {
    const acked: ReasonState = { ...plain, severity: "notice", reasonCodes: ["camera_offline"], state: "acknowledged" };
    expect(reasonPatch(acked, [draft("after_hours_presence", "alert")], NOW)).toEqual({
      severity: "alert",
      reasonCodes: ["after_hours_presence", "camera_offline"],
      state: "open",
      stateChangedAt: NOW,
      stateChangedById: null,
      alertedAt: NOW,
      notifyState: "pending",
    });
  });

  it("an alert incident that gains another alert reason changes no state and re-notifies nobody (alert is the maximum)", () => {
    const alerted: ReasonState = {
      severity: "alert",
      reasonCodes: ["after_hours_presence"],
      state: "acknowledged",
      notifyState: "done",
      alertedAt: WED_2214,
    };
    expect(reasonPatch(alerted, [draft("after_hours_presence", "alert")], NOW)).toEqual({});
  });

  it("a notice on an acknowledged notice incident leaves it acknowledged", () => {
    const acked: ReasonState = { ...plain, severity: "notice", reasonCodes: ["threat_signal"], state: "acknowledged" };
    expect(reasonPatch(acked, [draft("camera_offline", "notice")], NOW)).toEqual({
      reasonCodes: ["camera_offline", "threat_signal"],
    });
  });
});

describe("capEvidence — at most EVIDENCE_PER_CAMERA rows per (code, camera)", () => {
  const d = (camera: string | null, id: bigint): ReasonDraft => ({
    code: "after_hours_presence",
    severity: "alert",
    evidenceEventId: id,
    evidenceCamera: camera,
    evidenceSource: "frigate",
    evidenceKind: "detection",
    evidenceLabel: "person",
    evidenceAt: WED_2214,
    evidenceSummary: "x",
    detail: {},
  });

  it("a hidden camera's evidence can never crowd out a visible one's", () => {
    const existing = Array.from({ length: EVIDENCE_PER_CAMERA }, (_, i) => ({
      code: "after_hours_presence" as const,
      evidenceCamera: "back",
      evidenceEventId: BigInt(i + 1),
    }));
    const kept = capEvidence(existing, [d("back", 50n), d("front", 51n)]);
    expect(kept.map((k) => k.evidenceEventId)).toEqual([51n]);
  });

  it("counts drafts in the same batch too, and treats an evidence row already stored as present", () => {
    const kept = capEvidence(
      [{ code: "after_hours_presence", evidenceCamera: "front", evidenceEventId: 7n }],
      [d("front", 7n), ...Array.from({ length: 6 }, (_, i) => d("front", BigInt(60 + i)))],
    );
    expect(kept.map((k) => k.evidenceEventId)).toEqual([60n, 61n, 62n, 63n]);
  });
});

// ── WARP-2980 P5 PR-B: the pattern rules (p5b spec §11.1 A) ────────────────

const cell = (daysObserved: number, daysWithEvent: number, eventCount = 0, observedMinutes = daysObserved * 60): CellCounts => ({
  daysObserved,
  daysWithEvent,
  eventCount,
  observedMinutes,
});
const cells = (cur: CellCounts | null, around: { prev?: CellCounts; next?: CellCounts; dwellSamples?: number; p99?: number | null } = {}): PatternCells => ({
  prev: around.prev ?? null,
  cur,
  next: around.next ?? null,
  dwell: { dwellSamples: around.dwellSamples ?? 0, durationP99Sec: around.p99 ?? null },
});
const hits = (c: PatternCells, over: { label?: string; durationSec?: number | null; slotMinutes?: number; k?: number | null } = {}) =>
  patternHits({ label: over.label ?? "person", durationSec: over.durationSec ?? null, slotMinutes: over.slotMinutes ?? 60, k: over.k ?? null, cells: c });
const codesOf = (h: ReturnType<typeof patternHits>) => h.map((x) => x.code);

describe("patternHits — out_of_place (D7: isRare over the smoothed cell)", () => {
  it("fires below 0.05 and never at it (n = 20, d = 0: 0.5/21)", () => {
    expect(codesOf(hits(cells(cell(20, 0))))).toEqual(["out_of_place"]);
    // d′ = 0.25·(1 + 1) = 0.5, n′ = 10 + 0.25·40 = 20 → 1/21 ≈ 0.0476 fires …
    expect(codesOf(hits(cells(cell(10, 0), { prev: cell(20, 1), next: cell(20, 1) })))).toEqual(["out_of_place"]);
    // … n′ = 9 + 10 = 19 → exactly 1/20 = 0.05 does not.
    expect(codesOf(hits(cells(cell(9, 0), { prev: cell(20, 1), next: cell(20, 1) })))).toEqual([]);
  });

  it("nothing fires below 10 smoothed observed days — no code at all; exactly 10 is ready", () => {
    expect(hits(cells(cell(9, 0)))).toEqual([]);
    // Rarity alone can never fire below 10 (p ≥ 0.5/10); volume and dwell could, and must not.
    expect(hits(cells(cell(5, 0, 0, 300), { dwellSamples: 40, p99: 60 }), { k: 50, durationSec: 1_000 })).toEqual([]);
    expect(codesOf(hits(cells(cell(10, 5, 5, 600), { dwellSamples: 40, p99: 60 }), { k: 50, durationSec: 1_000 }))).toEqual([
      "unusual_volume",
      "long_dwell",
    ]);
    expect(codesOf(hits(cells(cell(10, 0))))).toEqual(["out_of_place"]);
    expect(hits(cells(null))).toEqual([]);
  });

  it("its detail reproduces p exactly from the stored strings", () => {
    const [h] = hits(cells(cell(10, 0), { prev: cell(20, 1), next: cell(20, 1) }));
    expect(h!.detail).toEqual({
      daysObserved: 10,
      daysWithEvent: 0,
      smoothedDaysObserved: "20",
      smoothedDaysWithEvent: "0.5",
      p: "0.0476",
      flagsBelow: "0.05",
    });
    const d = h!.detail;
    expect(((Number(d.smoothedDaysWithEvent) + 0.5) / (Number(d.smoothedDaysObserved) + 1)).toPrecision(3)).toBe(d.p);
  });
});

describe("patternHits — unusual_volume (D7/D8: k past k* for the event's own slot)", () => {
  // λ_hour = (40 + 0.5) / (1200 / 60) = 2.025; a fall-back slot is 120 minutes → λ = 4.05.
  const busy = cells(cell(20, 10, 40, 1200));
  const lambda = slotRate(40.5 / 20, 120);
  const kStar = volumeThreshold(lambda);

  it("k* − 1 does not fire and k* does, with λ from slotRate on a 120-minute slot", () => {
    expect(codesOf(hits(busy, { slotMinutes: 120, k: kStar - 1 }))).toEqual([]);
    const [h] = hits(busy, { slotMinutes: 120, k: kStar });
    expect(h).toMatchObject({ code: "unusual_volume", detail: { k: kStar, flagsFrom: kStar, slotMinutes: 120, lambda: lambda.toPrecision(3) } });
    expect(h!.detail.typicalPerHour).toBe((2.025).toPrecision(3));
    expect(h!.detail.tailP).toMatch(/^\d\.\d{2}e-\d+$/);
  });

  it("fewer than 3 never fires, even where 2 is past the tail", () => {
    // A never-seen hour: λ = 0.5 / 20 = 0.025, P(X ≥ 2) ≈ 3e-4 < 0.001 — but k < 3.
    const quiet = cells(cell(20, 0, 0, 1200));
    expect(codesOf(hits(quiet, { k: 2 }))).toEqual(["out_of_place"]);
    expect(codesOf(hits(quiet, { k: 3 }))).toEqual(["out_of_place", "unusual_volume"]);
  });

  it("k = null skips the code; so does a cell with no observed time (no rate)", () => {
    expect(codesOf(hits(busy, { k: null }))).toEqual([]);
    expect(codesOf(hits(cells(cell(20, 10, 40, 0)), { k: 500 }))).toEqual([]);
  });
});

describe("patternHits — long_dwell (D7: person, ≥ 30 samples, longer than max(p99, 120 s))", () => {
  const usual = (dwellSamples: number, p99: number | null) => cells(cell(20, 10), { dwellSamples, p99 });

  it("p99 90 s → the 120 s floor: 120 does not fire, 121 does; its detail shows duration ≥ threshold", () => {
    expect(hits(usual(30, 90), { durationSec: 120 })).toEqual([]);
    const [h] = hits(usual(30, 90), { durationSec: 121 });
    expect(h).toEqual({ code: "long_dwell", detail: { durationSec: 121, p99Sec: 90, thresholdSec: 120, samples: 30 } });
    expect(h!.detail.durationSec as number).toBeGreaterThanOrEqual(h!.detail.thresholdSec as number);
  });

  it("p99 300 s needs more than 300 s", () => {
    expect(hits(usual(30, 300), { durationSec: 300 })).toEqual([]);
    expect(codesOf(hits(usual(30, 300), { durationSec: 300.4 }))).toEqual(["long_dwell"]);
  });

  it("29 samples, a car, or no duration → never", () => {
    expect(hits(usual(29, 90), { durationSec: 1000 })).toEqual([]);
    expect(hits(usual(30, 90), { durationSec: 1000, label: "car" })).toEqual([]);
    expect(hits(usual(30, 90), { durationSec: null })).toEqual([]);
  });
});

describe("patternSeverity — every row of spec §4.6 (D9, D10)", () => {
  it.each([
    ["out_of_place", "person", "open", "interior", "notice"],
    ["out_of_place", "person", "closed", "entry", "alert"],
    ["out_of_place", "person", "open", "restricted", "alert"],
    ["out_of_place", "person", "away", null, "alert"],
    ["out_of_place", "cat", "closed", "restricted", "notice"],
    ["out_of_place", "car", "away", null, "notice"],
    ["unusual_volume", "person", "open", "entry", "info"],
    ["unusual_volume", "person", "closed", "restricted", "notice"],
    ["unusual_volume", "car", "open", "parking", "notice"],
    ["long_dwell", "person", "away", "perimeter", "alert"],
    ["long_dwell", "person", "open", "parking", "notice"],
  ] as const)("%s · %s · %s · %s → %s", (code, label, mode, kind, expected) => {
    expect(patternSeverity(code, label, mode, kind)).toBe(expected);
  });

  it("only an open ENTRY AREA lowers unusual_volume to info — not a camera key, not a closed entry", () => {
    expect(patternSeverity("unusual_volume", "person", "open", null)).toBe("notice");
    expect(patternSeverity("unusual_volume", "person", "closed", "entry")).toBe("notice");
  });
});

describe("expected activity — one match rule for the engine and route 31 (D11–D13, review item 10)", () => {
  const Z = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61";
  const NOW = new Date("2026-09-23T12:00:00Z");
  const row = (over: Partial<SuppressionMatchRow> = {}): SuppressionMatchRow => ({
    id: "s1",
    targetKind: "area",
    zoneId: Z,
    camera: null,
    label: "person",
    days: "weekdays",
    hourFrom: 22,
    hourCount: 3,
    codes: ["out_of_place"],
    state: "active",
    createdAt: new Date("2026-09-20T12:00:00Z"),
    expiresAt: new Date("2026-10-20T12:00:00Z"),
    ...over,
  });
  // 2026-09-23 is a Wednesday; 25 Friday, 26 Saturday, 27 Sunday, 28 Monday.
  const slot = (over: Partial<{ zoneKey: string; label: string; ymd: string; hour: number }> = {}) => ({
    zoneKey: `area:${Z}`,
    label: "person",
    ymd: "2026-09-23",
    hour: 22,
    ...over,
  });

  it("hourInWindow wraps past midnight: (22, 3) is 22, 23 and 0 — not 21 or 1; (22, 2) stops at 23; 24 hours is every hour", () => {
    expect([21, 22, 23, 0, 1].map((h) => hourInWindow(h, 22, 3))).toEqual([false, true, true, true, false]);
    expect([22, 23, 0].map((h) => hourInWindow(h, 22, 2))).toEqual([true, true, false]);
    expect(Array.from({ length: 24 }, (_, h) => hourInWindow(h, 7, 24)).every(Boolean)).toBe(true);
  });

  it("matches the slot it names", () => {
    expect(suppressionCovers(row(), slot(), NOW)).toBe(true);
    expect(suppressionCovers(row(), slot({ hour: 0, ymd: "2026-09-24" }), NOW)).toBe(true);
    expect(suppressionCovers(row({ targetKind: "camera", zoneId: null, camera: "front" }), slot({ zoneKey: "camera:front" }), NOW)).toBe(true);
    expect(suppressionCovers(row({ days: "every_day" }), slot({ ymd: "2026-09-26" }), NOW)).toBe(true);
  });

  it.each([
    ["another key", row(), slot({ zoneKey: "area:7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c82" })],
    ["a camera key for an area row", row(), slot({ zoneKey: `camera:${Z}` })],
    ["another label", row(), slot({ label: "car" })],
    ["weekdays on a Saturday evening", row(), slot({ ymd: "2026-09-26" })],
    ["weekends on a Wednesday evening", row({ days: "weekends" }), slot()],
    ["an hour before the window", row(), slot({ hour: 21 })],
    ["an hour after it", row(), slot({ hour: 1, ymd: "2026-09-24" })],
    ["removed", row({ state: "removed" }), slot()],
    ["expired", row({ state: "expired" }), slot()],
    ["still active but past expiresAt (a lagging expiry never extends one)", row({ expiresAt: NOW }), slot()],
  ])("never matches %s", (_what, r, s) => {
    expect(suppressionCovers(r, s, NOW)).toBe(false);
  });

  it("review item 5 — a window past midnight belongs to the day it OPENS: Friday night's tail is a weekday's, Sunday night's is not", () => {
    const late = row({ hourFrom: 22, hourCount: 4 });
    expect(suppressionCovers(late, slot({ ymd: "2026-09-26", hour: 1 }), NOW)).toBe(true); // Sat 01:00 ← Friday night
    expect(suppressionCovers(late, slot({ ymd: "2026-09-28", hour: 1 }), NOW)).toBe(false); // Mon 01:00 ← Sunday night
    expect(suppressionCovers(row({ hourFrom: 22, hourCount: 4, days: "weekends" }), slot({ ymd: "2026-09-28", hour: 1 }), NOW)).toBe(true);
    // A 24-hour window opened at 06:00 runs to 05:59 the next day, and those hours are the previous day's —
    // which is why route 33 and SecuritySuppression_shape store a whole day only from midnight.
    const fromSix = row({ hourFrom: 6, hourCount: 24, days: "weekends" });
    expect(suppressionCovers(fromSix, slot({ ymd: "2026-09-28", hour: 5 }), NOW)).toBe(true); // Mon 05:00 ← Sunday
    expect(suppressionCovers(fromSix, slot({ ymd: "2026-09-28", hour: 6 }), NOW)).toBe(false); // Mon 06:00 opens Monday
    // From midnight, "Weekends, All day" is exactly Saturday and Sunday.
    const allDay = row({ hourFrom: 0, hourCount: 24, days: "weekends" });
    expect(suppressionCovers(allDay, slot({ ymd: "2026-09-25", hour: 23 }), NOW)).toBe(false); // Fri 23:00
    expect(suppressionCovers(allDay, slot({ ymd: "2026-09-26", hour: 0 }), NOW)).toBe(true); // Sat 00:00
    expect(suppressionCovers(allDay, slot({ ymd: "2026-09-27", hour: 23 }), NOW)).toBe(true); // Sun 23:00
    expect(suppressionCovers(allDay, slot({ ymd: "2026-09-28", hour: 0 }), NOW)).toBe(false); // Mon 00:00
  });

  it("suppressionFor adds the code filter and the oldest-wins choice", () => {
    const flag = { ...slot(), code: "out_of_place" as const };
    expect(suppressionFor({ ...flag, code: "unusual_volume" }, [row()], NOW)).toBeNull();
    const older = row({ id: "s-old", createdAt: new Date("2026-09-01T00:00:00Z") });
    const newer = row({ id: "s-new", createdAt: new Date("2026-09-10T00:00:00Z") });
    expect(suppressionFor(flag, [newer, older], NOW)?.id).toBe("s-old");
    const tieA = row({ id: "s-a" });
    const tieB = row({ id: "s-b" });
    expect(suppressionFor(flag, [tieB, tieA], NOW)?.id).toBe("s-a");
    expect(suppressionFor(flag, [row({ state: "removed" })], NOW)).toBeNull();
  });

  it("takes a pattern code only — after_hours_presence cannot even be asked", () => {
    // @ts-expect-error — a P3 code is not a PatternCode (D12: expected activity never hides after_hours_presence).
    const r = suppressionFor({ ...slot(), code: "after_hours_presence" }, [row({ codes: ["out_of_place"] })], NOW);
    expect(r).toBeNull();
  });
});

describe("the pauses the engine and route 31 share (review item 11)", () => {
  const NOW = new Date("2026-09-23T12:00:00Z"); // 08:00 in New York
  const TZ = "America/New_York";

  it("buildPause: another zone; a window ending before today − 2 site dates; today − 2 passes", () => {
    expect(buildPause(TZ, { timezone: "Europe/London", windowTo: "2026-09-22" }, NOW)).toBe("zone_changed");
    expect(buildPause(TZ, { timezone: TZ, windowTo: "2026-09-20" }, NOW)).toBe("stale_build");
    expect(buildPause(TZ, { timezone: TZ, windowTo: "2026-09-21" }, NOW)).toBeNull();
    expect(buildPause(TZ, { timezone: TZ, windowTo: "2026-09-22" }, NOW)).toBeNull();
  });

  it("keyPause: an area whose version moved or is gone; the evidence camera outside the cells; any camera not active", () => {
    const state = new Map([
      ["front", "active"],
      ["back", "learning"],
    ]);
    const area = (liveVersion: number | null) => ({ kind: "area" as const, liveVersion });
    expect(keyPause(area(2), { zoneVersion: 2, cameras: ["front"] }, state, "front")).toBeNull();
    expect(keyPause(area(3), { zoneVersion: 2, cameras: ["front"] }, state, "front")).toBe("area_changed");
    expect(keyPause(area(null), { zoneVersion: 2, cameras: ["front"] }, state, "front")).toBe("area_changed");
    expect(keyPause(area(2), { zoneVersion: 2, cameras: ["front"] }, state, "side")).toBe("area_changed");
    expect(keyPause(area(2), { zoneVersion: 2, cameras: ["back", "front"] }, state, "front")).toBe("camera_not_active");
    expect(keyPause({ kind: "camera" }, { zoneVersion: null, cameras: ["back"] }, state, "back")).toBe("camera_not_active");
    expect(keyPause({ kind: "camera" }, { zoneVersion: null, cameras: ["gone"] }, state)).toBe("camera_not_active");
    expect(keyPause({ kind: "camera" }, { zoneVersion: null, cameras: [] }, state)).toBe("camera_not_active");
  });
});

describe("tripwires (D2, D21)", () => {
  it("every pattern code is still `trial` — flipping one is P5 PR-D, with the counted path, the reasons CHECK arm and the alert copy (F2)", () => {
    expect(Object.keys(PATTERN_RULES.codes)).toEqual([...PATTERN_CODES]);
    expect(PATTERN_RELEASE).toEqual({ out_of_place: "trial", unusual_volume: "trial", long_dwell: "trial" });
  });

  it("REASON_CODE_ORDER is the `enum SecurityReasonCode` block of schema.prisma, in declaration order", () => {
    const schema = readFileSync(path.join(PACKAGE_ROOT, "prisma", "schema.prisma"), "utf8");
    const block = /enum SecurityReasonCode \{([\s\S]*?)\}/.exec(schema)?.[1] ?? "";
    const values = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"));
    expect([...REASON_CODE_ORDER]).toEqual(values);
  });

  it("reasonPatch still sorts the P3 codes in declaration order", () => {
    const d: ReasonDraft = {
      code: "after_hours_presence",
      severity: "alert",
      evidenceEventId: 9n,
      evidenceCamera: "back",
      evidenceSource: "frigate",
      evidenceKind: "detection",
      evidenceLabel: "person",
      evidenceAt: WED_2214,
      evidenceSummary: "x",
      detail: {},
    };
    const i: ReasonState = { severity: "notice", reasonCodes: ["threat_signal"], state: "open", notifyState: "not_needed", alertedAt: null };
    expect(reasonPatch(i, [d], WED_2214).reasonCodes).toEqual(["after_hours_presence", "threat_signal"]);
  });

  it("capEvidence caps pattern-flag drafts the same way: 5 per (code, camera), never a stored one twice", () => {
    const flag = (id: bigint, camera = "back") => ({ code: "out_of_place" as const, evidenceCamera: camera, evidenceEventId: id, severity: "alert" });
    const drafts = [1n, 2n, 3n, 4n, 5n, 6n, 7n].map((id) => flag(id));
    expect(capEvidence([], drafts).map((d) => d.evidenceEventId)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(capEvidence([{ code: "out_of_place", evidenceCamera: "back", evidenceEventId: 1n }], [flag(1n), flag(8n, "front")]).map((d) => d.evidenceEventId)).toEqual([8n]);
  });
});

// ── WARP-2979 (P4 §6.7): alerts only through links a person made or kept ────

describe("rankPick — an area a PERSON linked first (§6.7.1)", () => {
  const m = (zoneId: string, zoneKind: AreaMatch["zoneKind"], personLinked: boolean, specificity: AreaMatch["specificity"] = "whole"): AreaMatch => ({
    zoneId,
    zoneName: zoneId,
    zoneKind,
    linkIds: [`${zoneId}-l`],
    specificity,
    personLinked,
  });

  it("a person-linked entry beats a Droplet-only restricted area; among the person-linked, the kind rank still decides", () => {
    expect(rankPick([m("z-restricted", "restricted", false), m("z-entry", "entry", true)]).zoneId).toBe("z-entry");
    expect(rankPick([m("z-entry", "entry", true), m("z-interior", "interior", true)]).zoneId).toBe("z-interior");
    expect(rankPick([m("z-a", "interior", false), m("z-b", "interior", false, "part")]).zoneId).toBe("z-b");
  });
});

describe("after_hours_presence needs a person-linked primary area (§6.7.1)", () => {
  it("an event matched only through Droplet's own link groups, but never alerts", () => {
    expect(afterHoursPresence({ personLinked: false, scope: "area", zoneKind: "interior", event: ev(), timeline: scheduleTl() })).toBeNull();
    expect(afterHoursPresence({ personLinked: true, scope: "area", zoneKind: "interior", event: ev(), timeline: scheduleTl() })).not.toBeNull();
  });
});

describe("camera_offline_during_activity (alert, §6.7.2)", () => {
  const DROP = WED_2214;
  const STOCK = "z-stock";
  const areas = new Map([[STOCK, "Stock room"]]);
  const offline = (over: Partial<TriageEvent> = {}): TriageEvent =>
    ev({
      kind: "camera_offline",
      source: "frigate_status",
      camera: "back",
      sourceRef: "back/status/detect",
      labels: [],
      startedAt: DROP,
      endedAt: null,
      createdAt: DROP,
      summary: "Camera back stopped reporting",
      ...over,
    });
  /** A person seen on `camera` starting `startOffsetMs` from the drop, `durMs` long, in the person-linked areas given. */
  const seen = (startOffsetMs: number, over: Partial<ActivitySighting> = {}, durMs = 5_000): ActivitySighting => {
    const startedAt = plus(DROP, startOffsetMs);
    return { ...ev({ camera: "stock_cam", startedAt, endedAt: plus(startedAt, durMs), createdAt: plus(startedAt, durMs) }), personZoneIds: [STOCK], ...over };
  };
  const NOW = plus(DROP, 90_000);
  const judge = (input: Partial<Parameters<typeof cameraOfflineDuringActivity>[0]> = {}) =>
    cameraOfflineDuringActivity({
      offline: offline(),
      onlines: [],
      now: NOW,
      personAreas: areas,
      activity: [seen(-60_000)],
      timeline: scheduleTl(),
      ...input,
    });

  it.each([
    ["closed", scheduleTl(), "closed"],
    ["away", awayTl, "away"],
  ] as const)("fires while %s: an alert on the dropped camera, naming where the person was seen", (_n, tl, mode) => {
    const a = seen(-60_000);
    const r = judge({ timeline: tl, activity: [a] });
    expect(r).toMatchObject({
      code: "camera_offline_during_activity",
      severity: "alert",
      evidenceCamera: "back",
      evidenceKind: "camera_offline",
      evidenceAt: DROP,
      relatedCamera: "stock_cam",
      detail: {
        offlineForSec: null,
        backAt: null,
        mode,
        activity: { eventId: a.id.toString(), kind: "detection", label: "person", at: a.startedAt.toISOString(), zoneId: STOCK, zoneName: "Stock room" },
      },
    });
  });

  it("the window's edges: a sighting ENDING at −120 s fires, at −120.001 s it does not; one STARTING at +60 s fires, at +60.001 s it does not", () => {
    expect(judge({ activity: [seen(-125_000, {}, 5_000)] })).not.toBeNull();
    expect(judge({ activity: [seen(-125_001, {}, 5_000)] })).toBeNull();
    expect(judge({ activity: [seen(60_000)] })).not.toBeNull();
    expect(judge({ activity: [seen(60_001)] })).toBeNull();
    // Whole seconds, as the spec states them: −120 s fires, −121 s does not; +60 s fires, +61 s does not.
    expect(judge({ activity: [seen(-120_000, {}, 0)] })).not.toBeNull();
    expect(judge({ activity: [seen(-121_000, {}, 0)] })).toBeNull();
    expect(judge({ activity: [seen(61_000)] })).toBeNull();
  });

  it("does not fire in opening hours (P3's camera_offline notice covers it)", () => {
    expect(judge({ offline: offline({ startedAt: WED_NOON, createdAt: WED_NOON }), activity: [], now: plus(WED_NOON, 90_000) })).toBeNull();
    const noon = seen(0);
    expect(
      judge({
        offline: offline({ startedAt: WED_NOON, createdAt: WED_NOON }),
        now: plus(WED_NOON, 90_000),
        activity: [{ ...noon, startedAt: plus(WED_NOON, -10_000), endedAt: WED_NOON }],
      }),
    ).toBeNull();
  });

  it("only through PERSON links: no person-linked area for the camera, or a sighting matched only through Droplet's links → nothing", () => {
    expect(judge({ personAreas: new Map() })).toBeNull();
    expect(judge({ activity: [seen(-60_000, { personZoneIds: [] })] })).toBeNull();
    // A person-linked area of ANOTHER camera does not count for this one.
    expect(judge({ activity: [seen(-60_000, { personZoneIds: ["z-yard"] })] })).toBeNull();
  });

  it("a person, never a car or a low-confidence row; never Frigate-wide (source_offline)", () => {
    expect(judge({ activity: [seen(-60_000, { labels: ["car"] })] })).toBeNull();
    expect(judge({ activity: [seen(-60_000, { kind: "detection_low" })] })).toBeNull();
    expect(judge({ offline: offline({ kind: "source_offline", camera: null, sourceRef: "frigate/available" }) })).toBeNull();
  });

  it("the camera back within a minute is a blip (camera_offline's own condition, reused); still waiting before 60 s", () => {
    expect(judge({ onlines: [{ startedAt: plus(DROP, 59_000) }] })).toBeNull();
    expect(judge({ now: plus(DROP, 59_999) })).toBeNull();
    // Back after 90 s: it still fires, with the outage's length.
    expect(judge({ onlines: [{ startedAt: plus(DROP, 90_000) }], now: plus(DROP, 120_000) })?.detail).toMatchObject({
      offlineForSec: 90,
      backAt: plus(DROP, 90_000).toISOString(),
    });
  });

  it("the dropped camera's OWN sighting counts (someone walked up, then it died); the latest sighting is the evidence", () => {
    const own = seen(-100_000, { camera: "back" });
    const later = seen(-10_000, { camera: "stock_cam" });
    expect(judge({ activity: [own] })).toMatchObject({ relatedCamera: "back" });
    expect(judge({ activity: [own, later] })).toMatchObject({ relatedCamera: "stock_cam", detail: { activity: { eventId: later.id.toString() } } });
  });

  it("a person still in view (PR-D's ongoing row) counts over [startedAt, written]", () => {
    const ongoing = seen(-300_000, { kind: "detection_ongoing", endedAt: null, createdAt: plus(DROP, -30_000) });
    expect(judge({ activity: [ongoing] })).toMatchObject({ detail: { activity: { kind: "detection_ongoing" } } });
  });
});
