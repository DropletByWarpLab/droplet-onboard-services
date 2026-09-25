/**
 * WARP-2978 (ADR-059 P3 spec §6.8, D27, D34; R6) — DS-005 for incidents, in
 * ONE place. Four surfaces read incidents (the list, the detail, the counts,
 * the notifications) and a second copy of the rule is how a camera leaks, so
 * the projection and the list's SQL filters are pinned here, pure.
 *
 * WARP-2980 PR-B (spec D16; review items 2, 3): who sees a pattern flag, and
 * what a viewer can judge.
 */
import { describe, expect, it } from "vitest";
import { QUIET_MS, SETTLE_MS } from "../lib/security-rules.js";
import {
  flagCamerasVisible,
  flagVisible,
  judgeableCodes,
  seesEverything,
  type FlagForView,
  incidentListWhere,
  incidentVisibilityWhere,
  projectIncident,
  projectedLastActivity,
  visibleReasonWhere,
  type IncidentRowForView,
  type IncidentViewer,
  type ReasonRowForView,
} from "./security-incident-view.js";

const T = new Date("2026-09-23T21:14:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const NOW = plus(T, 60_000);

const owner: IncidentViewer = { userId: "u-owner", visibleCameras: "all", mayReadThreats: true, mayReadLocks: true, ownerOrAdmin: true };
const frontOnly: IncidentViewer = { userId: "u-maria", visibleCameras: new Set(["front"]), mayReadThreats: false, mayReadLocks: false, ownerOrAdmin: false };

function incident(over: Partial<IncidentRowForView> = {}): IncidentRowForView {
  return {
    id: "i1",
    scope: "area",
    zoneId: "z1",
    zoneName: "Stock room",
    zoneKind: "interior",
    scopeCamera: null,
    state: "open",
    severity: "alert",
    reasonCodes: ["after_hours_presence", "camera_offline"],
    grouping: "collecting",
    openedInMode: "closed",
    firstActivityAt: T,
    lastActivityAt: T,
    eventCount: 5,
    countsByCamera: { front: { person: 2 }, back: { person: 1, _status: 2 } },
    cameras: ["back", "front"],
    spanByCamera: {},
    eventsKept: "kept",
    ...over,
  };
}

function reason(code: ReasonRowForView["code"], camera: string | null, severity: ReasonRowForView["severity"]): ReasonRowForView {
  return {
    code,
    severity,
    evidenceEventId: 1n,
    evidenceCamera: camera,
    evidenceSource: "frigate",
    evidenceKind: "detection",
    evidenceLabel: "person",
    evidenceAt: T,
    evidenceSummary: "x",
    detail: {},
  };
}

describe("projectIncident — what one viewer may know", () => {
  it("an incident on cameras A and B, for an A-only viewer: A's counts, labels and codes only", () => {
    const p = projectIncident(incident(), [reason("after_hours_presence", "back", "alert"), reason("camera_offline", "front", "notice")], frontOnly, NOW)!;
    expect(p.codes).toEqual(["camera_offline"]);
    expect(p.severity).toBe("notice");
    expect(p.eventCount).toBe(2);
    expect(p.labels).toEqual({ person: 2 });
    expect(p.reasons.map((r) => r.evidenceCamera)).toEqual(["front"]);
  });

  // Review #1 (DS-005): the front notice is visible, the back ALERT is not.
  describe("mixed visibility — a lower code visible, the top one hidden (a PARTIAL view)", () => {
    const mixed = [reason("after_hours_presence", "back", "alert"), reason("camera_offline", "front", "notice")];

    it("cannot act on the incident: acting would handle an alert she cannot see", () => {
      const p = projectIncident(incident(), mixed, frontOnly, NOW)!;
      expect(p).toMatchObject({ partial: true, actionable: false, severity: "notice", codes: ["camera_offline"], state: "open" });
    });

    it("the hidden escalation never shows: acknowledged, and reopened by the hidden alert, both read `open`", () => {
      expect(projectIncident(incident({ state: "acknowledged" }), mixed, frontOnly, NOW)!.state).toBe("open");
      expect(projectIncident(incident({ state: "open" }), mixed, frontOnly, NOW)!.state).toBe("open");
    });

    it("a resolved incident reads resolved (a person's act on the whole incident, never caused by a camera)", () => {
      expect(projectIncident(incident({ state: "resolved", grouping: "closed" }), mixed, frontOnly, NOW)!.state).toBe("resolved");
    });

    it("a viewer who can see every alert is a FULL viewer — a hidden notice BELOW the top severity does not matter: stored state, actionable", () => {
      const flipped = [reason("after_hours_presence", "front", "alert"), reason("camera_offline", "back", "notice")];
      expect(projectIncident(incident({ state: "acknowledged" }), flipped, frontOnly, NOW)).toMatchObject({
        partial: false,
        actionable: true,
        severity: "alert",
        state: "acknowledged",
      });
    });
  });

  // Review b7e1 (blocking): reasons are per (code, evidence), so the SAME code on
  // a hidden camera is a hidden reason. Stock room, closed: a person on `front`
  // (Maria sees it) and a second person on `back` (she does not).
  describe("the same code on a hidden camera — a PARTIAL view", () => {
    const twoAlerts = [reason("after_hours_presence", "front", "alert"), reason("after_hours_presence", "back", "alert")];

    it("front-only viewer of [after_hours_presence@front, after_hours_presence@back]: partial, not actionable, open", () => {
      for (const state of ["open", "acknowledged"] as const) {
        const p = projectIncident(incident({ state, reasonCodes: ["after_hours_presence"] }), twoAlerts, frontOnly, NOW)!;
        expect(p, state).toMatchObject({
          partial: true,
          actionable: false,
          state: "open",
          severity: "alert",
          codes: ["after_hours_presence"],
        });
        expect(p.reasons.map((r) => r.evidenceCamera)).toEqual(["front"]);
      }
      const resolved = incident({ state: "resolved", grouping: "closed", reasonCodes: ["after_hours_presence"] });
      expect(projectIncident(resolved, twoAlerts, frontOnly, NOW)).toMatchObject({ partial: true, actionable: false, state: "resolved" });
    });

    it("a viewer who sees both cameras, and the owner, are full", () => {
      const both = { ...frontOnly, visibleCameras: new Set(["front", "back"]) };
      const i = incident({ state: "acknowledged", reasonCodes: ["after_hours_presence"] });
      expect(projectIncident(i, twoAlerts, both, NOW)).toMatchObject({ partial: false, actionable: true, state: "acknowledged" });
      expect(projectIncident(i, twoAlerts, owner, NOW)).toMatchObject({ partial: false, actionable: true, state: "acknowledged" });
    });

    // The notice twin: acknowledge / resolve settle the incident for everyone at
    // ANY top severity, so a hidden notice under a notice-level incident counts.
    it("notice level: [camera_offline@front, camera_offline@back] with top severity notice is partial for a front-only viewer", () => {
      const twoNotices = [reason("camera_offline", "front", "notice"), reason("camera_offline", "back", "notice")];
      const i = incident({ severity: "notice", state: "acknowledged", reasonCodes: ["camera_offline"] });
      expect(projectIncident(i, twoNotices, frontOnly, NOW)).toMatchObject({
        partial: true,
        actionable: false,
        state: "open",
        severity: "notice",
        codes: ["camera_offline"],
      });
      // …and a notice-level incident whose every notice she sees is hers to act on.
      expect(projectIncident(i, [reason("camera_offline", "front", "notice")], frontOnly, NOW)).toMatchObject({ partial: false, actionable: true });
    });

    it("a hidden reason BELOW the top severity never makes it partial, whatever its code", () => {
      const i = incident({ state: "open" });
      const below = [reason("after_hours_presence", "front", "alert"), reason("camera_offline", "back", "notice"), reason("camera_offline", "front", "notice")];
      expect(projectIncident(i, below, frontOnly, NOW)).toMatchObject({ partial: false, actionable: true, codes: ["after_hours_presence", "camera_offline"] });
    });
  });

  it("the owner sees everything, as stored", () => {
    const p = projectIncident(incident(), [reason("after_hours_presence", "back", "alert"), reason("camera_offline", "front", "notice")], owner, NOW)!;
    expect(p).toMatchObject({ severity: "alert", codes: ["after_hours_presence", "camera_offline"], eventCount: 5, labels: { person: 3, _status: 2 } });
  });

  it("only hidden codes → plain activity: no state, nothing to act on", () => {
    const p = projectIncident(incident({ state: "acknowledged" }), [reason("after_hours_presence", "back", "alert")], frontOnly, NOW)!;
    expect(p).toMatchObject({ state: "no_action", severity: "info", codes: [], actionable: false, reasons: [] });
  });

  it("an incident on cameras the viewer cannot see is not visible at all", () => {
    expect(projectIncident(incident({ cameras: ["back"], countsByCamera: { back: { person: 1 } } }), [], frontOnly, NOW)).toBeNull();
  });

  it("site_threat is owner/admin only; the camera system is every viewer's", () => {
    const threat = incident({ scope: "site_threat", zoneId: null, zoneName: null, zoneKind: null, cameras: [], countsByCamera: { "": { _threat: 1 } }, reasonCodes: ["threat_signal"], severity: "notice" });
    expect(projectIncident(threat, [reason("threat_signal", null, "notice")], frontOnly, NOW)).toBeNull();
    expect(projectIncident(threat, [reason("threat_signal", null, "notice")], owner, NOW)).toMatchObject({ codes: ["threat_signal"], eventCount: 1 });
    const system = incident({ scope: "site_camera_system", zoneId: null, zoneName: null, zoneKind: null, cameras: [], countsByCamera: { "": { _status: 2 } }, reasonCodes: ["camera_offline"], severity: "notice" });
    expect(projectIncident(system, [reason("camera_offline", null, "notice")], frontOnly, NOW)).toMatchObject({ codes: ["camera_offline"], eventCount: 2, labels: { _status: 2 } });
  });

  it("after the 30-day trim, visibility still comes from the `cameras` snapshot", () => {
    const trimmed = incident({ eventsKept: "removed" });
    expect(projectIncident(trimmed, [reason("camera_offline", "front", "notice")], frontOnly, NOW)).toMatchObject({ codes: ["camera_offline"] });
    expect(projectIncident({ ...trimmed, cameras: ["back"] }, [], frontOnly, NOW)).toBeNull();
  });
});

// Review #4 (DS-005): times and "still happening" come from the viewer's own cameras.
describe("projectIncident — the span and the grouping a viewer may know", () => {
  const span = (first: Date, last: Date) => ({ first: first.toISOString(), last: last.toISOString() });
  // front (visible to Maria) 21:14–21:15; back (hidden) 21:05–21:45 — a person on back long after.
  const spans = { front: span(T, plus(T, 60_000)), back: span(plus(T, -540_000), plus(T, 1_860_000)) };
  const i = incident({ firstActivityAt: plus(T, -540_000), lastActivityAt: plus(T, 1_860_000), spanByCamera: spans });
  const codes = [reason("camera_offline", "front", "notice"), reason("after_hours_presence", "back", "alert")];

  it("a viewer who cannot see every camera: first/last from her cameras only", () => {
    const p = projectIncident(i, codes, frontOnly, NOW)!;
    expect(p.firstActivityAt).toEqual(T);
    expect(p.lastActivityAt).toEqual(plus(T, 60_000));
  });

  it("…and `collecting` ends for her once HER cameras have been quiet for quiet + settle, whatever a hidden camera does", () => {
    const quietAt = plus(T, 60_000 + QUIET_MS + SETTLE_MS);
    expect(projectIncident(i, codes, frontOnly, plus(quietAt, -1))!.grouping).toBe("collecting");
    expect(projectIncident(i, codes, frontOnly, quietAt)!.grouping).toBe("closed");
    // Stored `closed` is closed for everyone.
    expect(projectIncident({ ...i, grouping: "closed" }, codes, frontOnly, NOW)!.grouping).toBe("closed");
  });

  it("WARP-2978 PR-D: a person still in view on HER camera keeps it happening past her quiet; one on a hidden camera never does", () => {
    const quietAt = plus(T, 60_000 + QUIET_MS + SETTLE_MS);
    const onFront = new Set(["front"]);
    expect(projectIncident(i, codes, frontOnly, quietAt, onFront)!.grouping).toBe("collecting");
    // DS-005: the back person holds it open for everyone else, not for her.
    expect(projectIncident(i, codes, frontOnly, quietAt, new Set(["back"]))!.grouping).toBe("closed");
    expect(projectIncident(i, codes, frontOnly, quietAt, new Set(["back"]))).toEqual(projectIncident(i, codes, frontOnly, quietAt));
    // The hold moves none of her times, and reopens nothing sealed.
    expect(projectIncident(i, codes, frontOnly, quietAt, onFront)).toMatchObject({ firstActivityAt: T, lastActivityAt: plus(T, 60_000) });
    expect(projectIncident({ ...i, grouping: "closed" }, codes, frontOnly, quietAt, onFront)!.grouping).toBe("closed");
  });

  it("the owner (every camera) gets the stored values", () => {
    const p = projectIncident(i, codes, owner, plus(T, 3_600_000))!;
    expect(p).toMatchObject({ firstActivityAt: i.firstActivityAt, lastActivityAt: i.lastActivityAt, grouping: "collecting" });
  });

  it("a viewer who can see every camera of THIS incident gets the stored values too", () => {
    const onlyFront = incident({ cameras: ["front"], spanByCamera: { front: span(T, plus(T, 60_000)) }, lastActivityAt: plus(T, 60_000) });
    expect(projectIncident(onlyFront, [reason("camera_offline", "front", "notice")], frontOnly, plus(T, 3_600_000))!.grouping).toBe("collecting");
  });

  describe("projectedLastActivity — the key route 16 orders and pages her list by (review R1)", () => {
    it("her cameras only: a hidden camera's later activity never moves it", () => {
      expect(projectedLastActivity(i, frontOnly)).toEqual(plus(T, 60_000));
      expect(projectedLastActivity(i, frontOnly)).toEqual(projectIncident(i, codes, frontOnly, NOW)!.lastActivityAt);
    });

    it("the stored column for a viewer who sees every camera, every entry, or none of them", () => {
      expect(projectedLastActivity(i, owner)).toEqual(i.lastActivityAt);
      expect(projectedLastActivity(i, { ...frontOnly, visibleCameras: new Set(["front", "back"]) })).toEqual(i.lastActivityAt);
      expect(projectedLastActivity(i, { ...frontOnly, visibleCameras: new Set(["side"]) })).toEqual(i.lastActivityAt);
      expect(projectedLastActivity(incident({ spanByCamera: {}, lastActivityAt: plus(T, 5_000) }), frontOnly)).toEqual(plus(T, 5_000));
    });

    it("a camera-less (`\"\"`) entry counts only on a site-scoped incident", () => {
      const withSite = { front: span(T, plus(T, 60_000)), back: span(T, plus(T, 900_000)), "": span(T, plus(T, 300_000)) };
      const site = incident({ scope: "site_camera_system", zoneId: null, zoneName: null, zoneKind: null, spanByCamera: withSite, lastActivityAt: plus(T, 900_000) });
      expect(projectedLastActivity(site, frontOnly)).toEqual(plus(T, 300_000));
      const area = incident({ spanByCamera: withSite, lastActivityAt: plus(T, 900_000) });
      expect(projectedLastActivity(area, frontOnly)).toEqual(plus(T, 60_000));
    });
  });
});

describe("the list's SQL mirrors the projection (DS-005 in the query, visibility first)", () => {
  it("owner/admin: no constraint; family: their cameras, the camera system, never threats", () => {
    expect(incidentVisibilityWhere(owner)).toEqual({});
    expect(incidentVisibilityWhere(frontOnly)).toEqual({
      OR: [{ scope: { in: ["area", "camera"] }, cameras: { hasSome: ["front"] } }, { scope: "site_camera_system" }],
    });
  });

  it("a visible reason is one on a visible camera (or a site-wide one on a visible incident)", () => {
    expect(visibleReasonWhere(owner)).toEqual({});
    expect(visibleReasonWhere(frontOnly)).toEqual({ OR: [{ evidenceCamera: { in: ["front"] } }, { evidenceCamera: null }] });
  });

  it("the visibility clause is AND[0], and `severity=alert` counts only VISIBLE alert codes", () => {
    const w = incidentListWhere(frontOnly, { state: "all", severity: "alert" }) as { AND: unknown[] };
    expect(w.AND[0]).toEqual(incidentVisibilityWhere(frontOnly));
    expect(w.AND).toContainEqual({ reasons: { some: { AND: [visibleReasonWhere(frontOnly), { severity: "alert" }] } } });
  });

  it("`attention` is an open incident with a visible code — for a PARTIAL view, open or acknowledged (it reads open); `activity` is no visible code at all", () => {
    const attention = incidentListWhere(frontOnly, { state: "attention" }) as { AND: unknown[] };
    const vis = visibleReasonWhere(frontOnly);
    // Partial: a reason at the incident's own severity on a hidden camera (review b7e1).
    const full = {
      OR: [
        { severity: "info" },
        { severity: "alert", reasons: { none: { severity: "alert", NOT: vis } } },
        { severity: "notice", reasons: { none: { severity: "notice", NOT: vis } } },
      ],
    };
    const topHidden = {
      OR: [
        { severity: "alert", reasons: { some: { severity: "alert", NOT: vis } } },
        { severity: "notice", reasons: { some: { severity: "notice", NOT: vis } } },
      ],
    };
    expect(attention.AND).toContainEqual({
      reasons: { some: vis },
      OR: [
        { state: "open", ...full },
        { state: { in: ["open", "acknowledged"] }, ...topHidden },
      ],
    });
    const acknowledged = incidentListWhere(frontOnly, { state: "acknowledged" }) as { AND: unknown[] };
    expect(acknowledged.AND).toContainEqual({ state: "acknowledged", reasons: { some: vis }, ...full });
    // The owner can never be partial: the plain filters.
    expect((incidentListWhere(owner, { state: "attention" }) as { AND: unknown[] }).AND).toContainEqual({ state: "open", reasons: { some: {} } });
    const activity = incidentListWhere(frontOnly, { state: "activity" }) as { AND: unknown[] };
    expect(activity.AND).toContainEqual({ OR: [{ state: "no_action" }, { reasons: { none: visibleReasonWhere(frontOnly) } }] });
  });

  it("`severity=notice` means a visible notice and no visible alert", () => {
    const w = incidentListWhere(frontOnly, { state: "all", severity: "notice" }) as { AND: unknown[] };
    expect(w.AND).toContainEqual({
      AND: [
        { reasons: { some: { AND: [visibleReasonWhere(frontOnly), { severity: "notice" }] } } },
        { reasons: { none: { AND: [visibleReasonWhere(frontOnly), { severity: "alert" }] } } },
      ],
    });
  });
});

// ── WARP-2980 PR-B: pattern flags and what a viewer can judge ──────────────

describe("flagVisible (D16) — owner/admin, AND the evidence camera, AND every camera behind the key", () => {
  const flag = (over: Partial<FlagForView> = {}): FlagForView => ({
    code: "out_of_place",
    effect: "trial",
    severity: "alert",
    evidenceCamera: "front",
    keyCameras: ["front"],
    ...over,
  });
  const bothCameras: IncidentViewer = { ...frontOnly, visibleCameras: new Set(["front", "back"]) };

  it("owner/admin → yes", () => {
    expect(flagVisible(flag({ keyCameras: ["back", "front"] }), owner)).toBe(true);
  });

  it("family → no in PR-B, even granted every camera behind it (the trial rule: shown to owner/admin)", () => {
    expect(flagVisible(flag(), frontOnly)).toBe(false);
    expect(flagVisible(flag({ keyCameras: ["back", "front"] }), bothCameras)).toBe(false);
  });

  it("the camera clauses PR-D will lean on: the evidence camera AND every key camera", () => {
    expect(flagCamerasVisible(flag(), frontOnly)).toBe(true);
    expect(flagCamerasVisible(flag({ keyCameras: ["back", "front"] }), frontOnly)).toBe(false);
    expect(flagCamerasVisible(flag({ evidenceCamera: "back", keyCameras: ["back"] }), frontOnly)).toBe(false);
    expect(flagCamerasVisible(flag({ keyCameras: ["back", "front"] }), bothCameras)).toBe(true);
  });

  it("an owner narrowed to some cameras (no such shape today) would still be refused a key camera it cannot see", () => {
    const narrowOwner: IncidentViewer = { ...owner, visibleCameras: new Set(["front"]) };
    expect(flagVisible(flag({ keyCameras: ["back", "front"] }), narrowOwner)).toBe(false);
    expect(flagVisible(flag(), narrowOwner)).toBe(true);
  });

  it("seesEverything is every camera AND the threats (review item 2)", () => {
    expect(seesEverything(owner)).toBe(true);
    expect(seesEverything(frontOnly)).toBe(false);
    expect(seesEverything({ ...owner, mayReadThreats: false })).toBe(false);
  });
});

describe("judgeableCodes (D16, review item 3) — visible counted codes plus the visible flags that would have been RAISED", () => {
  const f = (code: FlagForView["code"], over: Partial<FlagForView> = {}): FlagForView => ({
    code,
    effect: "trial",
    severity: "notice",
    evidenceCamera: "front",
    keyCameras: ["front"],
    ...over,
  });

  it("in declaration order, P3 codes first", () => {
    const p = projectIncident(incident({ severity: "notice", reasonCodes: ["camera_offline"] }), [reason("camera_offline", "front", "notice")], owner, NOW)!;
    expect(judgeableCodes(p, [f("long_dwell"), f("out_of_place")], owner)).toEqual(["camera_offline", "out_of_place", "long_dwell"]);
  });

  it("a flag expected activity quietened, or one at info, was never raised: not judgeable", () => {
    const p = projectIncident(incident({ severity: "info", state: "no_action", reasonCodes: [] }), [], owner, NOW)!;
    expect(judgeableCodes(p, [f("out_of_place", { effect: "suppressed" }), f("unusual_volume", { severity: "info" })], owner)).toEqual([]);
    expect(judgeableCodes(p, [f("unusual_volume")], owner)).toEqual(["unusual_volume"]);
  });

  it("family on a trial-only incident → nothing (flags are owner/admin's in PR-B)", () => {
    const p = projectIncident(incident({ severity: "info", state: "no_action", reasonCodes: [] }), [], frontOnly, NOW)!;
    expect(judgeableCodes(p, [f("out_of_place")], frontOnly)).toEqual([]);
  });
});
