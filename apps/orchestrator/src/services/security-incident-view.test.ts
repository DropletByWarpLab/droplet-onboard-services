/**
 * WARP-2978 (ADR-059 P3 spec §6.8, D27, D34; R6) — DS-005 for incidents, in
 * ONE place. Four surfaces read incidents (the list, the detail, the counts,
 * the notifications) and a second copy of the rule is how a camera leaks, so
 * the projection and the list's SQL filters are pinned here, pure.
 */
import { describe, expect, it } from "vitest";
import { QUIET_MS, SETTLE_MS } from "../lib/security-rules.js";
import {
  incidentListWhere,
  incidentVisibilityWhere,
  projectIncident,
  visibleReasonWhere,
  type IncidentRowForView,
  type IncidentViewer,
  type ReasonRowForView,
} from "./security-incident-view.js";

const T = new Date("2026-09-23T21:14:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const NOW = plus(T, 60_000);

const owner: IncidentViewer = { userId: "u-owner", visibleCameras: "all", mayReadThreats: true, ownerOrAdmin: true };
const frontOnly: IncidentViewer = { userId: "u-maria", visibleCameras: new Set(["front"]), mayReadThreats: false, ownerOrAdmin: false };

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

    it("a viewer who can see the alert code is a FULL viewer: stored state, actionable", () => {
      const flipped = [reason("after_hours_presence", "front", "alert"), reason("camera_offline", "back", "notice")];
      expect(projectIncident(incident({ state: "acknowledged" }), flipped, frontOnly, NOW)).toMatchObject({
        partial: false,
        actionable: true,
        severity: "alert",
        state: "acknowledged",
      });
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

  it("the owner (every camera) gets the stored values", () => {
    const p = projectIncident(i, codes, owner, plus(T, 3_600_000))!;
    expect(p).toMatchObject({ firstActivityAt: i.firstActivityAt, lastActivityAt: i.lastActivityAt, grouping: "collecting" });
  });

  it("a viewer who can see every camera of THIS incident gets the stored values too", () => {
    const onlyFront = incident({ cameras: ["front"], spanByCamera: { front: span(T, plus(T, 60_000)) }, lastActivityAt: plus(T, 60_000) });
    expect(projectIncident(onlyFront, [reason("camera_offline", "front", "notice")], frontOnly, plus(T, 3_600_000))!.grouping).toBe("collecting");
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
    expect(attention.AND).toContainEqual({
      reasons: { some: vis },
      OR: [
        { state: "open", OR: [{ severity: { not: "alert" } }, { reasons: { some: { AND: [vis, { severity: "alert" }] } } }] },
        { state: { in: ["open", "acknowledged"] }, severity: "alert", reasons: { none: { AND: [vis, { severity: "alert" }] } } },
      ],
    });
    const acknowledged = incidentListWhere(frontOnly, { state: "acknowledged" }) as { AND: unknown[] };
    expect(acknowledged.AND).toContainEqual({
      state: "acknowledged",
      reasons: { some: vis },
      OR: [{ severity: { not: "alert" } }, { reasons: { some: { AND: [vis, { severity: "alert" }] } } }],
    });
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
