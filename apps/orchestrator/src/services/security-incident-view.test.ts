/**
 * WARP-2978 (ADR-059 P3 spec §6.8, D27, D34; R6) — DS-005 for incidents, in
 * ONE place. Four surfaces read incidents (the list, the detail, the counts,
 * the notifications) and a second copy of the rule is how a camera leaks, so
 * the projection and the list's SQL filters are pinned here, pure.
 */
import { describe, expect, it } from "vitest";
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
    const p = projectIncident(incident(), [reason("after_hours_presence", "back", "alert"), reason("camera_offline", "front", "notice")], frontOnly)!;
    expect(p.codes).toEqual(["camera_offline"]);
    expect(p.severity).toBe("notice");
    expect(p.eventCount).toBe(2);
    expect(p.labels).toEqual({ person: 2 });
    expect(p.reasons.map((r) => r.evidenceCamera)).toEqual(["front"]);
    expect(p.state).toBe("open");
    expect(p.actionable).toBe(true);
  });

  it("the owner sees everything, as stored", () => {
    const p = projectIncident(incident(), [reason("after_hours_presence", "back", "alert"), reason("camera_offline", "front", "notice")], owner)!;
    expect(p).toMatchObject({ severity: "alert", codes: ["after_hours_presence", "camera_offline"], eventCount: 5, labels: { person: 3, _status: 2 } });
  });

  it("only hidden codes → plain activity: no state, nothing to act on", () => {
    const p = projectIncident(incident({ state: "acknowledged" }), [reason("after_hours_presence", "back", "alert")], frontOnly)!;
    expect(p).toMatchObject({ state: "no_action", severity: "info", codes: [], actionable: false, reasons: [] });
  });

  it("an incident on cameras the viewer cannot see is not visible at all", () => {
    expect(projectIncident(incident({ cameras: ["back"], countsByCamera: { back: { person: 1 } } }), [], frontOnly)).toBeNull();
  });

  it("site_threat is owner/admin only; the camera system is every viewer's", () => {
    const threat = incident({ scope: "site_threat", zoneId: null, zoneName: null, zoneKind: null, cameras: [], countsByCamera: { "": { _threat: 1 } }, reasonCodes: ["threat_signal"], severity: "notice" });
    expect(projectIncident(threat, [reason("threat_signal", null, "notice")], frontOnly)).toBeNull();
    expect(projectIncident(threat, [reason("threat_signal", null, "notice")], owner)).toMatchObject({ codes: ["threat_signal"], eventCount: 1 });
    const system = incident({ scope: "site_camera_system", zoneId: null, zoneName: null, zoneKind: null, cameras: [], countsByCamera: { "": { _status: 2 } }, reasonCodes: ["camera_offline"], severity: "notice" });
    expect(projectIncident(system, [reason("camera_offline", null, "notice")], frontOnly)).toMatchObject({ codes: ["camera_offline"], eventCount: 2, labels: { _status: 2 } });
  });

  it("after the 30-day trim, visibility still comes from the `cameras` snapshot", () => {
    const trimmed = incident({ eventsKept: "removed" });
    expect(projectIncident(trimmed, [reason("camera_offline", "front", "notice")], frontOnly)).toMatchObject({ codes: ["camera_offline"] });
    expect(projectIncident({ ...trimmed, cameras: ["back"] }, [], frontOnly)).toBeNull();
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

  it("`attention` is an open incident with a visible code; `activity` is no visible code at all", () => {
    const attention = incidentListWhere(frontOnly, { state: "attention" }) as { AND: unknown[] };
    expect(attention.AND).toContainEqual({ state: "open", reasons: { some: visibleReasonWhere(frontOnly) } });
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
