/**
 * WARP-2978 (ADR-059 P3 spec §6.5, D18–D22) — the reason-code rules, one
 * block per code, plus how a reason moves the incident (severity, state,
 * notify) and the per-camera evidence cap. Pure.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  EVIDENCE_PER_CAMERA,
  RULESET,
  afterHoursPresence,
  cameraOfflineVerdict,
  capEvidence,
  parseActivityRef,
  reasonPatch,
  threatSignal,
  type ReasonDraft,
  type ReasonState,
  type TriageEvent,
} from "./security-rules.js";
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
    const r = afterHoursPresence({ scope: "area", zoneKind, event: e, timeline: tl });
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
    expect(afterHoursPresence({ scope: "area", zoneKind: "interior", event: e, timeline: tl })?.detail).toMatchObject({
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
    expect(afterHoursPresence({ scope, zoneKind, event: ev(over as Partial<TriageEvent>), timeline: tl })).toBeNull();
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

describe("the database pins D18: the CHECK's code/severity pairs are exactly the RULESET's", () => {
  it("SecurityIncidentReason_code_severity matches RULESET", () => {
    const sql = readFileSync(
      path.join(PACKAGE_ROOT, "prisma", "migrations", "20260924050000_warp_2978_security_incidents", "migration.sql"),
      "utf8",
    );
    const check = /"SecurityIncidentReason_code_severity" CHECK \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
    const pairs = new Map<string, string>();
    for (const m of check.matchAll(/"code" (?:= '(\w+)'|IN \(([^)]*)\)) AND "severity" = '(\w+)'/g)) {
      const codes = m[1] ? [m[1]] : m[2]!.split(",").map((c) => c.trim().replace(/'/g, ""));
      for (const c of codes) pairs.set(c, m[3]!);
    }
    expect(Object.fromEntries(pairs)).toEqual(
      Object.fromEntries(Object.entries(RULESET).map(([code, rule]) => [code, rule.severity])),
    );
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
