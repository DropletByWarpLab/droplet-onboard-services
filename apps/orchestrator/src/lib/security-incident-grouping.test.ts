/**
 * WARP-2978 (ADR-059 P3 spec §6.2–6.3, D12–D14) — which incident an event
 * belongs to. Pure: scope and area choice, the join window, the counts.
 *
 * The numbers (D13): 5 min of event-time quiet ends an incident; 90 s is the
 * settle (how far BEFORE an incident's first activity an event may start and
 * still join — Frigate reports on `end`, so a longer-tracked object arrives
 * after shorter ones); 60 min is the span cap; and an event never joins across
 * a mode change.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SPAN_MS,
  QUIET_MS,
  SETTLE_MS,
  eventSpan,
  joinPatch,
  openingFields,
  parseCounts,
  pickIncident,
  planTriage,
  rankPick,
  scopeFor,
  type AreaMatch,
  type GroupableIncident,
  type TriageEvent,
} from "./security-rules.js";

const T0 = new Date("2026-09-23T21:14:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

let nextId = 1n;
function ev(over: Partial<TriageEvent> = {}): TriageEvent {
  const startedAt = over.startedAt ?? T0;
  return {
    id: nextId++,
    source: "frigate",
    kind: "detection",
    camera: "back",
    sourceRef: "back/1.5-a",
    labels: ["person"],
    cameraZones: [],
    startedAt,
    endedAt: plus(startedAt, 10_000),
    createdAt: plus(startedAt, 11_000),
    summary: "Person seen by back",
    ...over,
  };
}

function incident(over: Partial<GroupableIncident> = {}): GroupableIncident {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    firstActivityAt: T0,
    lastActivityAt: plus(T0, 10_000),
    openedInMode: "closed",
    ...over,
  };
}

function area(zoneId: string, zoneKind: AreaMatch["zoneKind"], specificity: AreaMatch["specificity"] = "whole"): AreaMatch {
  return { zoneId, zoneName: `Area ${zoneId}`, zoneKind, linkIds: [`l-${zoneId}`], specificity };
}

describe("scopeFor — which scope an event groups under (D14)", () => {
  it("detection_low → low; mode_changed and unknown kinds (a lock reading) → context", () => {
    expect(scopeFor(ev({ kind: "detection_low" }), [])).toEqual({ outcome: "low" });
    expect(scopeFor(ev({ kind: "mode_changed", camera: null }), [])).toEqual({ outcome: "context" });
    expect(scopeFor(ev({ kind: "lock_state", source: "matter_lock", camera: null }), [])).toEqual({ outcome: "context" });
  });

  it("a camera row with an area → area scope, the primary by rank, the rest recorded", () => {
    const d = scopeFor(ev(), [area("b", "entry"), area("a", "interior")]);
    expect(d).toEqual({
      outcome: "group",
      key: { scope: "area", zoneId: "a", scopeCamera: null },
      area: area("a", "interior"),
      alsoZoneIds: ["b"],
      matchedLinkIds: ["l-a"],
      joinOnly: false,
    });
  });

  it("a camera row no area covers → camera scope", () => {
    expect(scopeFor(ev({ kind: "camera_offline", labels: [] }), [])).toMatchObject({
      outcome: "group",
      key: { scope: "camera", zoneId: null, scopeCamera: "back" },
      area: null,
      joinOnly: false,
    });
  });

  it("threats → site_threat; Frigate-wide rows → site_camera_system", () => {
    expect(scopeFor(ev({ kind: "threat", camera: null, source: "activity_mirror" }), [])).toMatchObject({
      key: { scope: "site_threat", zoneId: null, scopeCamera: null },
    });
    expect(scopeFor(ev({ kind: "source_offline", camera: null, source: "frigate_status" }), [])).toMatchObject({
      key: { scope: "site_camera_system" },
      joinOnly: false,
    });
  });

  it("online rows only JOIN (a lone recovery is not news)", () => {
    expect(scopeFor(ev({ kind: "camera_online", labels: [] }), [])).toMatchObject({ joinOnly: true });
    expect(scopeFor(ev({ kind: "source_online", camera: null }), [])).toMatchObject({ joinOnly: true });
  });
});

describe("rankPick — one event, one incident: the most sensitive area (D12)", () => {
  it("restricted > interior > entry > perimeter > parking", () => {
    const all = [area("p", "parking"), area("e", "entry"), area("r", "restricted"), area("per", "perimeter"), area("i", "interior")];
    expect(rankPick(all).zoneId).toBe("r");
    expect(rankPick(all.filter((m) => m.zoneId !== "r")).zoneId).toBe("i");
    expect(rankPick([area("p", "parking"), area("per", "perimeter")]).zoneId).toBe("per");
  });

  it("same kind: a part-of-view link beats a whole-camera link", () => {
    expect(rankPick([area("a", "interior", "whole"), area("b", "interior", "part")]).zoneId).toBe("b");
  });

  it("same kind and specificity: the lowest zone id", () => {
    expect(rankPick([area("c", "interior"), area("a", "interior"), area("b", "interior")]).zoneId).toBe("a");
  });
});

describe("pickIncident — the join window (D13)", () => {
  const mode = "closed" as const;

  it("joins inside 5 min of quiet; a new incident at 5 min + 1 s", () => {
    const i = incident();
    expect(pickIncident([i], eventSpan(ev({ startedAt: plus(i.lastActivityAt, QUIET_MS) })), mode)).toBe(i);
    expect(pickIncident([i], eventSpan(ev({ startedAt: plus(i.lastActivityAt, QUIET_MS + 1_000) })), mode)).toBeNull();
  });

  it("the backward settle: a long-tracked object that started before the incident joins; one that ENDED 91 s before it does not", () => {
    const i = incident();
    const longObject = ev({ startedAt: plus(T0, -300_000), endedAt: plus(T0, -SETTLE_MS) });
    expect(pickIncident([i], eventSpan(longObject), mode)).toBe(i);
    const early = ev({ startedAt: plus(T0, -400_000), endedAt: plus(T0, -SETTLE_MS - 1_000) });
    expect(pickIncident([i], eventSpan(early), mode)).toBeNull();
  });

  it("never spans more than 60 min", () => {
    const i = incident({ firstActivityAt: T0, lastActivityAt: plus(T0, MAX_SPAN_MS - 60_000) });
    expect(pickIncident([i], eventSpan(ev({ startedAt: plus(T0, MAX_SPAN_MS - 30_000), endedAt: plus(T0, MAX_SPAN_MS) })), mode)).toBe(i);
    expect(pickIncident([i], eventSpan(ev({ startedAt: plus(T0, MAX_SPAN_MS - 30_000), endedAt: plus(T0, MAX_SPAN_MS + 1) })), mode)).toBeNull();
  });

  it("never joins across a mode change", () => {
    const i = incident({ openedInMode: "open" });
    expect(pickIncident([i], eventSpan(ev({ startedAt: plus(T0, 20_000) })), "closed")).toBeNull();
  });

  it("several fits → the latest activity wins, then the smallest id", () => {
    const older = incident({ id: "00000000-0000-4000-8000-00000000000a", lastActivityAt: plus(T0, 10_000) });
    const newer = incident({ id: "00000000-0000-4000-8000-00000000000b", lastActivityAt: plus(T0, 20_000) });
    const tie = incident({ id: "00000000-0000-4000-8000-000000000009", lastActivityAt: plus(T0, 20_000) });
    const span = eventSpan(ev({ startedAt: plus(T0, 30_000) }));
    expect(pickIncident([older, newer], span, mode)).toBe(newer);
    expect(pickIncident([older, newer, tie], span, mode)).toBe(tie);
  });

  it("an event whose end precedes its start spans only its start", () => {
    expect(eventSpan(ev({ startedAt: T0, endedAt: plus(T0, -5_000) }))).toEqual({ s: T0, e: T0 });
    expect(eventSpan(ev({ startedAt: T0, endedAt: null }))).toEqual({ s: T0, e: T0 });
  });
});

describe("planTriage — join, open, or leave as context", () => {
  it("a lone online row with nothing to join → context, never an incident of its own", () => {
    const d = scopeFor(ev({ kind: "camera_online", labels: [] }), []);
    expect(planTriage(d, [], eventSpan(ev()), "closed")).toEqual({ action: "context" });
  });

  it("an online row with a fitting incident joins it", () => {
    const i = incident();
    const d = scopeFor(ev({ kind: "camera_online", labels: [] }), []);
    expect(planTriage(d, [i], eventSpan(ev({ startedAt: plus(T0, 30_000) })), "closed")).toEqual({ action: "join", incident: i });
  });

  it("a detection with nothing to join opens an incident", () => {
    expect(planTriage(scopeFor(ev(), []), [], eventSpan(ev()), "closed")).toEqual({ action: "open" });
  });

  it("low and context decisions pass straight through", () => {
    expect(planTriage({ outcome: "low" }, [], eventSpan(ev()), "open")).toEqual({ action: "low" });
    expect(planTriage({ outcome: "context" }, [], eventSpan(ev()), "open")).toEqual({ action: "context" });
  });
});

describe("the counts that survive the event trim (DS-005)", () => {
  it("an opening event: its span, one event, its camera's label count", () => {
    const e = ev();
    expect(openingFields(e, eventSpan(e))).toEqual({
      firstActivityAt: e.startedAt,
      lastActivityAt: e.endedAt,
      lastArrivalAt: e.createdAt,
      eventCount: 1,
      countsByCamera: { back: { person: 1 } },
      cameras: ["back"],
    });
  });

  it("joining widens the span, moves the arrival clock, and counts per camera — status rows as _status, threats under ''", () => {
    const i = {
      ...incident(),
      lastArrivalAt: plus(T0, 11_000),
      eventCount: 1,
      countsByCamera: { back: { person: 1 } },
      cameras: ["back"],
    };
    const offline = ev({ kind: "camera_offline", camera: "front", labels: [], startedAt: plus(T0, -30_000), endedAt: null, createdAt: plus(T0, 60_000) });
    const p = joinPatch(i, offline, eventSpan(offline));
    expect(p).toEqual({
      firstActivityAt: plus(T0, -30_000),
      lastActivityAt: i.lastActivityAt,
      lastArrivalAt: plus(T0, 60_000),
      eventCount: 2,
      countsByCamera: { back: { person: 1 }, front: { _status: 1 } },
      cameras: ["back", "front"],
    });
    const threat = ev({ kind: "threat", camera: null, labels: ["auth"], source: "activity_mirror" });
    expect(openingFields(threat, eventSpan(threat)).countsByCamera).toEqual({ "": { _threat: 1 } });
    const frigate = ev({ kind: "source_offline", camera: null, labels: [], source: "frigate_status" });
    expect(openingFields(frigate, eventSpan(frigate))).toMatchObject({ countsByCamera: { "": { _status: 1 } }, cameras: [] });
  });

  it("parseCounts keeps only the validated shape", () => {
    expect(parseCounts({ back: { person: 2, _status: 1 }, "": { _threat: 3 } })).toEqual({
      back: { person: 2, _status: 1 },
      "": { _threat: 3 },
    });
    expect(parseCounts(null)).toEqual({});
    expect(parseCounts([1])).toEqual({});
    expect(parseCounts({ back: { person: -1, car: 1.5, bike: 2 }, x: "y" })).toEqual({ back: { bike: 2 } });
  });
});
