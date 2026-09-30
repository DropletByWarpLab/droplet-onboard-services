/**
 * WARP-3195 (ADR-059 P4 §6.7.1, §8) — route 18's `dropletLinks`: the links
 * only Droplet made that back an incident, which a person may Keep so the
 * camera counts for alerts. Pure, pinned here:
 *
 *   · THE VIEWER RULE (`mayKeepIncidentLinks`) — manage level, owner/admin
 *     (route 24's role floor) AND sees everything (P5's verdict rule, P4
 *     PR-2's summary rule). Independent of the incident, so a camera-limited
 *     viewer's route-18 answer is `null` whatever the incident holds — the R1
 *     pg pin (security-incident-list.pg.test.ts) cannot tell her two worlds
 *     apart by it.
 *   · THE INCIDENT RULE (`dropletOnlyLinks`) — an area incident's cameras
 *     whose every active link into that area was set by Droplet; each such
 *     link, with DS-005's `visibleLinks` applied first (the second fence,
 *     unreachable for today's admitted viewers, like `flagCamerasVisible`).
 */
import { describe, expect, it } from "vitest";
import {
  dropletOnlyLinks,
  mayKeepIncidentLinks,
  type IncidentLinkRow,
  type IncidentLinksIncident,
} from "./security-incident-links.js";
import type { IncidentViewer } from "./security-incident-view.js";

const ZONE = { id: "z1", name: "Stock room", kind: "interior" as const };
const OTHER_ZONE = { id: "z2", name: "Office", kind: "interior" as const };

const owner: IncidentViewer = { userId: "u-owner", visibleCameras: "all", mayReadThreats: true, ownerOrAdmin: true };
const frontOnly: IncidentViewer = { userId: "u-maria", visibleCameras: new Set(["front"]), mayReadThreats: false, ownerOrAdmin: false };

function link(id: string, sourceRef: string, setBy: "person" | "droplet", over: Partial<IncidentLinkRow> = {}): IncidentLinkRow {
  return {
    id,
    zoneId: ZONE.id,
    sourceKind: sourceRef.includes("/") ? "camera_zone" : "camera",
    sourceRef,
    sourceLabel: `${sourceRef.split("/")[0]} (snapshot)`,
    origin: setBy === "droplet" ? "droplet" : "person",
    stateSetBy: setBy,
    zone: ZONE,
    ...over,
  };
}

function incident(over: Partial<IncidentLinksIncident> = {}): IncidentLinksIncident {
  return { scope: "area", zoneId: ZONE.id, cameras: ["back", "front"], ...over };
}

const LABELS = new Map([
  ["back", "Back camera"],
  ["front", "Front door"],
]);

describe("mayKeepIncidentLinks — the viewer rule (manage, owner/admin, sees everything)", () => {
  it("an owner or admin at manage who sees every camera and may read threats", () => {
    expect(mayKeepIncidentLinks(owner, "manage")).toBe(true);
  });

  it.each(["act", "view"] as const)("never below manage (%s): Keep is route 24, a manage route", (level) => {
    expect(mayKeepIncidentLinks(owner, level)).toBe(false);
  });

  it("never a viewer who cannot see every camera, even at manage", () => {
    expect(mayKeepIncidentLinks({ ...owner, visibleCameras: new Set(["back", "front"]) }, "manage")).toBe(false);
  });

  it("never a viewer who may not read threats, even at manage", () => {
    expect(mayKeepIncidentLinks({ ...owner, mayReadThreats: false }, "manage")).toBe(false);
  });

  it("never anyone below route 24's role floor (owner/admin), even at manage", () => {
    expect(mayKeepIncidentLinks({ ...owner, ownerOrAdmin: false }, "manage")).toBe(false);
  });

  it("a camera-limited family viewer: never, at any level (the R1 pin's viewer)", () => {
    for (const level of ["view", "act", "manage"] as const) expect(mayKeepIncidentLinks(frontOnly, level)).toBe(false);
  });
});

describe("dropletOnlyLinks — the cameras of an area incident linked there only by Droplet", () => {
  it("back is linked only by Droplet, front by a person: back's link, with its area and the camera's name", () => {
    const out = dropletOnlyLinks(incident(), [link("l-front", "front", "person"), link("l-back", "back", "droplet")], owner, LABELS);
    expect(out).toEqual([
      { linkId: "l-back", zone: ZONE, sourceKind: "camera", sourceRef: "back", camera: "back", label: "Back camera" },
    ]);
  });

  it("a camera a person linked too (any part of its view) is not Droplet-only: nothing for it", () => {
    const out = dropletOnlyLinks(incident(), [link("l-back", "back", "droplet"), link("l-back-till", "back/till", "person")], owner, LABELS);
    expect(out).toEqual([]);
  });

  it("a link Droplet made and a person KEPT counts for alerts already: nothing to keep", () => {
    const kept = link("l-back", "back", "person", { origin: "droplet" });
    expect(dropletOnlyLinks(incident(), [kept], owner, LABELS)).toEqual([]);
  });

  it("several Droplet parts of one camera: each, in sourceKind then sourceRef order", () => {
    const out = dropletOnlyLinks(
      incident({ cameras: ["back"] }),
      [link("l-b2", "back/till", "droplet"), link("l-b1", "back/door", "droplet")],
      owner,
      LABELS,
    );
    expect(out.map((l) => [l.linkId, l.sourceKind, l.sourceRef, l.camera])).toEqual([
      ["l-b1", "camera_zone", "back/door", "back"],
      ["l-b2", "camera_zone", "back/till", "back"],
    ]);
  });

  it("only the incident's own cameras: a Droplet link on a camera none of its events came from is not offered", () => {
    const out = dropletOnlyLinks(incident({ cameras: ["front"] }), [link("l-front", "front", "person"), link("l-back", "back", "droplet")], owner, LABELS);
    expect(out).toEqual([]);
  });

  it("only the incident's own area: another area's Droplet link on the same camera is not offered", () => {
    const elsewhere = link("l-back-office", "back", "droplet", { zoneId: OTHER_ZONE.id, zone: OTHER_ZONE });
    expect(dropletOnlyLinks(incident(), [elsewhere], owner, LABELS)).toEqual([]);
  });

  it.each([
    ["camera", { scope: "camera" as const, zoneId: null }],
    ["site_camera_system", { scope: "site_camera_system" as const, zoneId: null }],
    ["site_threat", { scope: "site_threat" as const, zoneId: null }],
  ])("a %s incident has no area, so no area link to keep", (_s, over) => {
    expect(dropletOnlyLinks(incident(over), [link("l-back", "back", "droplet")], owner, LABELS)).toEqual([]);
  });

  it("the label is the camera's name now, else the link's snapshot (a camera no longer set up)", () => {
    const out = dropletOnlyLinks(incident({ cameras: ["gone"] }), [link("l-gone", "gone", "droplet")], owner, LABELS);
    expect(out.map((l) => l.label)).toEqual(["gone (snapshot)"]);
  });

  it("a malformed ref is never offered (fail closed, parseLinkRef)", () => {
    const bad = link("l-bad", "back/", "droplet");
    expect(dropletOnlyLinks(incident(), [bad], owner, LABELS)).toEqual([]);
  });

  it("🔴 DS-005: a camera the viewer cannot see is never named, nor its area through it", () => {
    const links = [link("l-back", "back", "droplet"), link("l-front", "front", "droplet")];
    expect(dropletOnlyLinks(incident(), links, frontOnly, LABELS).map((l) => l.linkId)).toEqual(["l-front"]);
    expect(dropletOnlyLinks(incident({ cameras: ["back"] }), [link("l-back", "back", "droplet")], frontOnly, LABELS)).toEqual([]);
  });
});
