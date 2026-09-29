/**
 * WARP-2979 (ADR-059 P4 §6.8) — what Droplet's incident summary is written
 * FROM: one incident's structured data, never a person's name, an id, a URL
 * or a picture. Pure; every case runs with the process zone unset and with
 * TZ=Pacific/Kiritimati (UTC+14), and must read the same.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NARRATIVE_INPUT_MAX_CHARS,
  NARRATIVE_MAX_EVENTS,
  SECURITY_NARRATIVE_SYSTEM_PROMPT,
  buildNarrativeInput,
  codeSentence,
  type NarrativeMemberRow,
  type NarrativeReasonRow,
  type NarrativeSource,
} from "./security-narrative-prompt.js";

const TZ = "Europe/London";
/** 02:14 BST on Tuesday 22 September 2026. */
const T = (hhmm: string) => new Date(`2026-09-22T${hhmm}:00+01:00`);

function member(over: Partial<NarrativeMemberRow> & { id: string }): NarrativeMemberRow {
  return {
    source: "frigate",
    sourceRef: `back_cam/1727000000.${over.id}-abcd`,
    kind: "detection",
    camera: "back_cam",
    labels: ["person"],
    cameraZones: [],
    startedAt: T("02:14"),
    endedAt: T("02:15"),
    ...over,
  };
}

function reason(over: Partial<NarrativeReasonRow> = {}): NarrativeReasonRow {
  return {
    code: "after_hours_presence",
    severity: "alert",
    evidenceEventId: "1",
    evidenceCamera: "back_cam",
    evidenceKind: "detection",
    evidenceLabel: "person",
    evidenceAt: T("02:14"),
    detail: { mode: "closed", modeSource: "schedule", nonOpenAt: T("17:00").toISOString(), zoneKind: "restricted" },
    relatedCamera: null,
    relatedLock: false,
    ...over,
  };
}

function source(over: Partial<NarrativeSource> = {}): NarrativeSource {
  return {
    incident: {
      scope: "area",
      zoneName: "Stock room",
      zoneKind: "restricted",
      scopeCamera: null,
      openedInMode: "closed",
      firstActivityAt: T("02:14"),
      eventCount: 1,
      cameras: ["back_cam"],
    },
    reasons: [reason()],
    members: [member({ id: "1" })],
    modeSource: "schedule",
    cameraLabels: new Map([
      ["back_cam", "Back camera"],
      ["till_cam", "Till camera"],
    ]),
    tz: TZ,
    ...over,
  };
}

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe.each([
  ["TZ unset", undefined],
  ["TZ=Pacific/Kiritimati", "Pacific/Kiritimati"],
])("buildNarrativeInput (%s)", (_label, tz) => {
  const setTz = () => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  };

  it("one incident, in the site's own words and clock: place, scope, day, mode, and the evidence event", () => {
    setTz();
    const { input, audience } = buildNarrativeInput(source());
    expect(input).toEqual({
      v: 1,
      place: { name: "Stock room", kind: "staff only" },
      scope: "area",
      day: "Tuesday 22 September",
      siteMode: "closed",
      modeSetBy: "opening hours",
      codes: [{ code: "after_hours_presence", sentence: "Someone was seen inside while the site was closed", facts: { mode: "closed (opening hours)" } }],
      events: [{ at: "2:14 AM", until: "2:15 AM", what: "person", source: "Back camera", part: null, found: "live" }],
      counts: { events: 1, shown: 1 },
      times: ["2:14 AM", "2:15 AM"],
    });
    expect(audience).toEqual({ cameras: ["back_cam"], threats: false, locks: false });
  });

  it("codes first, alert before notice; evidence events first, then the rest in time order", () => {
    setTz();
    const { input } = buildNarrativeInput(
      source({
        incident: { ...source().incident, eventCount: 4, cameras: ["back_cam", "till_cam"] },
        reasons: [
          reason({ code: "camera_offline", severity: "notice", evidenceEventId: "3", evidenceCamera: "till_cam", evidenceKind: "camera_offline", evidenceLabel: null, evidenceAt: T("02:20"), detail: { offlineForSec: 95, backAt: T("02:21").toISOString() } }),
          reason({ evidenceEventId: "2", evidenceAt: T("02:16") }),
        ],
        members: [
          member({ id: "1", startedAt: T("02:10"), endedAt: T("02:11"), cameraZones: ["aisle"] }),
          member({ id: "2", startedAt: T("02:16"), endedAt: T("02:17") }),
          member({ id: "3", kind: "camera_offline", camera: "till_cam", labels: [], startedAt: T("02:20"), endedAt: null }),
          member({ id: "4", kind: "camera_online", camera: "till_cam", labels: [], startedAt: T("02:21"), endedAt: null }),
        ],
      }),
    );
    expect(input.codes.map((c) => c.code)).toEqual(["after_hours_presence", "camera_offline"]);
    expect(input.codes[1]).toEqual({
      code: "camera_offline",
      sentence: "A camera stopped reporting for more than a minute",
      facts: { camera: "Till camera", offlineForSec: 95 },
    });
    expect(input.events.map((e) => [e.at, e.what, e.source, e.part])).toEqual([
      // Evidence first, in the codes' order…
      ["2:16 AM", "person", "Back camera", null],
      ["2:20 AM", "camera stopped reporting", "Till camera", null],
      // …then the other members in time order.
      ["2:10 AM", "person", "Back camera", "the 'aisle' part of the view"],
      ["2:21 AM", "camera back", "Till camera", null],
    ]);
    expect(input.counts).toEqual({ events: 4, shown: 4 });
    expect(input.times).toEqual(["2:16 AM", "2:17 AM", "2:20 AM", "2:10 AM", "2:11 AM", "2:21 AM"]);
  });

  it(`at most ${NARRATIVE_MAX_EVENTS} events and at most ${NARRATIVE_INPUT_MAX_CHARS} chars; counts.shown says how many made it`, () => {
    setTz();
    const many = Array.from({ length: 60 }, (_, n) =>
      member({ id: String(n + 1), startedAt: new Date(T("02:00").getTime() + n * 60_000), endedAt: new Date(T("02:00").getTime() + n * 60_000 + 30_000) }),
    );
    const small = buildNarrativeInput(source({ incident: { ...source().incident, eventCount: 60 }, members: many })).input;
    expect(small.events).toHaveLength(NARRATIVE_MAX_EVENTS);
    expect(small.counts).toEqual({ events: 60, shown: NARRATIVE_MAX_EVENTS });
    // The evidence first: the reason names event "1", and the loaded member row (02:00) wins over the snapshot.
    expect(small.events[0]!.at).toBe("2:00 AM");

    // Long camera names push it over the size cap: members go from the middle, evidence stays.
    const long = new Map([["back_cam", "B".repeat(100)]]);
    const big = buildNarrativeInput(source({ incident: { ...source().incident, eventCount: 60 }, members: many, cameraLabels: long })).input;
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(NARRATIVE_INPUT_MAX_CHARS);
    expect(big.events.length).toBeLessThan(NARRATIVE_MAX_EVENTS);
    expect(big.counts.shown).toBe(big.events.length);
    expect(big.events[0]).toMatchObject({ at: "2:00 AM", what: "person" });
    // What stays is the start and the end of the night, never only one side of it.
    const rest = big.events.slice(1).map((e) => e.at);
    expect(rest[0]).toBe("2:01 AM");
    expect(rest[rest.length - 1]).toBe("2:59 AM");
    // times follow what is shown, nothing more.
    for (const t of big.times) expect(big.events.some((e) => e.at === t || e.until === t)).toBe(true);
  });

  it("🔴 no person names: an acknowledger 'Maria' and a mode-setter 'Stefan' on the rows never reach the JSON", () => {
    setTz();
    const s = source();
    // Everything a loader might carry along beside the columns the builder reads.
    const incident = { ...s.incident, stateChangedById: "maria-id", resolvedById: "maria-id", verdictByName: "Maria", acks: [{ byName: "Maria" }] };
    const rows = s.members.map((m) => ({ ...m, summary: "Person seen — Stefan closed up" }));
    const reasons = s.reasons.map((r) => ({ ...r, evidenceSummary: "Maria's shift", detail: { ...(r.detail as object), setBy: "Stefan", byName: "Stefan" } }));
    const json = JSON.stringify(buildNarrativeInput({ ...s, incident, members: rows, reasons } as NarrativeSource).input);
    expect(json).not.toMatch(/maria|stefan/i);
  });

  it("no Frigate ids, sourceRefs, URLs, scores, event ids or user ids", () => {
    setTz();
    const s = source({ members: [member({ id: "1", sourceRef: "back_cam/1727000000.123456-xyz9" })] });
    const rows = s.members.map((m) => ({ ...m, score: 0.93, thumbnailUrl: "https://box/api/cameras/events/x/thumbnail", frigateEventId: "1727000000.123456-xyz9" }));
    const json = JSON.stringify(buildNarrativeInput({ ...s, members: rows } as NarrativeSource).input);
    for (const leak of ["1727000000", "xyz9", "http", "0.93", "back_cam/", '"id"', "evidenceEventId"]) expect(json).not.toContain(leak);
  });

  it("no site zone → no times at all: at and until null, times [], day null (never UTC)", () => {
    setTz();
    const { input } = buildNarrativeInput(
      source({
        tz: null,
        reasons: [reason({ code: "camera_offline_during_activity", evidenceKind: "camera_offline", evidenceLabel: null, relatedCamera: "till_cam", detail: { offlineForSec: 90, backAt: null, mode: "closed", modeSource: "manual", activity: { eventId: "7", kind: "detection", label: "person", at: T("02:13").toISOString(), zoneId: "z", zoneName: "Stock room" } } })],
      }),
    );
    expect(input.day).toBeNull();
    expect(input.times).toEqual([]);
    expect(input.events.every((e) => e.at === null && e.until === null)).toBe(true);
    expect(JSON.stringify(input)).not.toMatch(/\d:\d\d|UTC|Z"/);
    expect(input.codes[0]!.facts).toEqual({ mode: "closed (by hand)", camera: "Back camera", offlineForSec: 90, seenOn: "Till camera" });
  });

  it("the audience is exactly what the text could name: every camera of the incident and of its reasons, threats, locks", () => {
    setTz();
    const s = source({
      incident: { ...source().incident, cameras: ["back_cam", "yard_cam"] },
      reasons: [reason({ code: "camera_offline_during_activity", evidenceKind: "camera_offline", relatedCamera: "till_cam", detail: { mode: "away", modeSource: "schedule", offlineForSec: 70, activity: { at: T("02:13").toISOString() } } })],
    });
    const { input, audience } = buildNarrativeInput(s);
    expect(audience).toEqual({ cameras: ["back_cam", "till_cam", "yard_cam"], threats: false, locks: false });
    expect(input.codes[0]).toMatchObject({
      sentence: "A camera covering this area stopped reporting soon after someone was seen here, while the site was set to away",
      facts: { mode: "away (opening hours)", camera: "Back camera", offlineForSec: 70, seenOn: "Till camera", seenAt: "2:13 AM" },
    });
    expect(input.times).toContain("2:13 AM");

    const threat = buildNarrativeInput(
      source({
        incident: { ...source().incident, scope: "site_threat", zoneName: null, zoneKind: null, cameras: [] },
        reasons: [reason({ code: "threat_signal", severity: "notice", evidenceCamera: null, evidenceKind: "threat", evidenceLabel: "auth", detail: { activityId: "99", kind: "auth" } })],
        members: [member({ id: "1", source: "activity_mirror", kind: "threat", camera: null, labels: ["auth"], endedAt: null })],
      }),
    );
    expect(threat.audience).toEqual({ cameras: [], threats: true, locks: false });
    expect(threat.input).toMatchObject({ place: null, scope: "network and sign-in" });
    expect(threat.input.events[0]).toMatchObject({ what: "network or sign-in warning", source: "the network" });
    expect(threat.input.codes[0]!.facts).toEqual({ warning: "sign-in" });
  });

  it("a person still in view whose finished row is a member too is one event, not two; a camera-system drop names the camera system", () => {
    setTz();
    const { input } = buildNarrativeInput(
      source({
        incident: { ...source().incident, eventCount: 3 },
        members: [
          member({ id: "1" }),
          member({ id: "5", kind: "detection_ongoing", sourceRef: "back_cam/1727000000.1-abcd", startedAt: T("02:14"), endedAt: null }),
          member({ id: "6", source: "frigate_status", kind: "source_offline", camera: null, labels: [], sourceRef: "frigate", startedAt: T("02:30"), endedAt: null }),
        ],
      }),
    );
    expect(input.events.map((e) => [e.what, e.source])).toEqual([
      ["person", "Back camera"],
      ["camera system stopped", "the camera system"],
    ]);
  });

  it("the modeSetBy fact is the reasons' own, else the loader's history answer, else null (never guessed)", () => {
    setTz();
    expect(buildNarrativeInput(source({ modeSource: null })).input.modeSetBy).toBe("opening hours");
    const noDetail = [reason({ code: "camera_offline", severity: "notice", evidenceKind: "camera_offline", detail: { offlineForSec: 80 } })];
    expect(buildNarrativeInput(source({ reasons: noDetail, modeSource: "manual" })).input.modeSetBy).toBe("by hand");
    expect(buildNarrativeInput(source({ reasons: noDetail, modeSource: null })).input.modeSetBy).toBeNull();
  });
});

describe("the prompt and the code sentences", () => {
  it("the system prompt is v1's, verbatim", () => {
    expect(SECURITY_NARRATIVE_SYSTEM_PROMPT.split("\n")).toEqual([
      "You write a short factual summary of one security incident for the owner of a small business or a home.",
      "Use only the facts in the JSON you are given. Add nothing that is not in it.",
      "Rules:",
      "- Two to four plain sentences, under 600 characters. No lists, no headings, no markdown.",
      '- Say "someone" or "a person". Never name, guess or describe who anyone was, or why they were there.',
      "- Use the times exactly as written in the JSON. Do not convert, round or invent times. If the JSON has no times, give none.",
      "- Use place, camera and lock names exactly as written in the JSON.",
      '- "codes" are the reasons Droplet flagged this incident. Do not contradict them and do not add reasons.',
      "- If an event says it was found when Droplet checked, say that; do not give it as the moment it happened.",
      "- Do not give advice. Do not say the site is safe, secure, protected, monitored or guarded.",
      "Write only the summary.",
    ]);
  });

  it("each code's sentence is the incident page's own (the dashboard's incident-copy.ts), word for word", () => {
    const page = readFileSync(resolve(__dirname, "../../../web-dashboard/src/components/security/incident-copy.ts"), "utf8");
    const sentences = [
      codeSentence("after_hours_presence", { mode: "closed" }, "back_cam"),
      codeSentence("after_hours_presence", { mode: "away" }, "back_cam"),
      codeSentence("camera_offline", {}, "back_cam"),
      codeSentence("camera_offline", {}, null),
      codeSentence("threat_signal", {}, null),
      codeSentence("camera_offline_during_activity", { mode: "closed" }, "back_cam"),
      codeSentence("camera_offline_during_activity", { mode: "away" }, "back_cam"),
    ];
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const s of sentences) expect(page).toContain(`"${s}"`);
  });
});
