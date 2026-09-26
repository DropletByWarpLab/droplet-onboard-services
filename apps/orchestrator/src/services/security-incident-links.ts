/**
 * WARP-3195 (ADR-059 P4 §6.7.1, §8) — route 18's `dropletLinks`: the links
 * only Droplet made that back an incident. An event matched to an area only
 * through Droplet's links groups there but never alerts (§6.7.1); the
 * incident page says "Droplet linked this camera. Keep the link to get alerts
 * from it." next to Keep (route 24), and a kept link counts from the next
 * event on.
 *
 * THE VIEWER FIRST (`mayKeepIncidentLinks`): the list goes only to a viewer at
 * manage — route 24's level — who is owner/admin (route 24's role floor) AND
 * sees every camera and may read threats (`seesEverything`, P5's verdict rule
 * and P4 PR-2's summary rule). Everyone else gets `null` on every incident.
 * The rule never looks at the incident, and that is what keeps the R1 pin
 * (security-incident-list.pg.test.ts): a camera-limited viewer's route-18
 * answer for an incident with activity on a hidden camera must equal the one
 * for the same incident built from her own cameras alone, `actionable` aside.
 * Any per-incident list — even one filtered to her cameras — would move with
 * the hidden camera's links, and that difference is the hint DS-005 forbids;
 * `null` in both worlds cannot. The cost is none today: below manage there is
 * no Keep to offer, and only owner/admin reach manage.
 *
 * Then the incident (`dropletOnlyLinks`), from the links as they are NOW —
 * a Keep or an Undo takes the line away at once:
 *   · an area incident only (a camera or site incident has no area link);
 *   · the area's ACTIVE links while the area is active (an archived area's
 *     Keep is route 24's 409 ZONE_ARCHIVED; a suggestion is decided on the
 *     Areas page, never here);
 *   · DS-005 first — `visibleLinks`, the one per-camera filter every area
 *     surface uses — the second fence, unreachable for today's admitted
 *     viewers, who see every camera (the `flagCamerasVisible` precedent). A
 *     visible link makes its area visible (`zoneVisibleTo`), so no area is
 *     named through a camera the viewer cannot see;
 *   · per camera of the incident's `cameras` snapshot (it survives the 30-day
 *     event trim): when EVERY active link of that camera into the area was
 *     set by Droplet (`origin` and `stateSetBy` droplet — "Linked by
 *     Droplet"), each of those links. A camera a person linked there too, in
 *     any part of its view, already alerts through that link: nothing to
 *     keep for it.
 *
 * No `version`: route 24 is an intent on the link's current state (body
 * `{}`), never client-versioned (§6.5), so the page has nothing to echo.
 */
import type { Prisma, PrismaClient, SecurityIncidentScope, SecurityZoneKind, SecurityZoneSourceKind } from "@prisma/client";
import { seesEverything, type IncidentViewer } from "./security-incident-view.js";
import { loadCameraLabels, parseLinkRef, visibleLinks } from "./security-zones.service.js";

/** One line on the incident page: a link only Droplet set, into the incident's area. */
export interface IncidentDropletLinkView {
  /** Route 24's `:linkId`. */
  linkId: string;
  /** The area as it is now (the incident's own `zone` is its snapshot at open). */
  zone: { id: string; name: string; kind: SecurityZoneKind };
  sourceKind: SecurityZoneSourceKind;
  /** camera: `<frigateCamera>`; camera_zone: `<frigateCamera>/<frigateZone>`. */
  sourceRef: string;
  /** The Frigate camera the link points at. */
  camera: string;
  /** The camera's display name now, else the link's snapshot — never the part (SecurityZoneLinkView.label's contract). */
  label: string;
}

/** The link columns the list is built from. */
export const INCIDENT_LINK_SELECT = {
  id: true,
  zoneId: true,
  sourceKind: true,
  sourceRef: true,
  sourceLabel: true,
  origin: true,
  stateSetBy: true,
  zone: { select: { id: true, name: true, kind: true } },
} as const satisfies Prisma.SecurityZoneLinkSelect;

/** An ACTIVE link of an ACTIVE area (the loader's where). */
export type IncidentLinkRow = Prisma.SecurityZoneLinkGetPayload<{ select: typeof INCIDENT_LINK_SELECT }>;

/** The incident columns the list reads. */
export interface IncidentLinksIncident {
  scope: SecurityIncidentScope;
  zoneId: string | null;
  cameras: readonly string[];
}

/** The viewer rule (see the header): manage, owner/admin, sees everything. Never the incident. */
export function mayKeepIncidentLinks(viewer: IncidentViewer, level: "view" | "act" | "manage"): boolean {
  return level === "manage" && viewer.ownerOrAdmin && seesEverything(viewer);
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Droplet made it and Droplet set its current state: "Linked by Droplet" (the CHECK allows it only on an active or proposed row). */
const dropletSet = (l: Pick<IncidentLinkRow, "origin" | "stateSetBy">): boolean => l.origin === "droplet" && l.stateSetBy === "droplet";

/** The incident rule (see the header), pure. `links` are active links of active areas; any area's may be passed. */
export function dropletOnlyLinks(
  incident: IncidentLinksIncident,
  links: readonly IncidentLinkRow[],
  viewer: Pick<IncidentViewer, "visibleCameras">,
  cameraLabels: ReadonlyMap<string, string>,
): IncidentDropletLinkView[] {
  if (incident.scope !== "area" || incident.zoneId === null) return [];
  const byCamera = new Map<string, IncidentLinkRow[]>();
  for (const l of visibleLinks(
    links.filter((l) => l.zoneId === incident.zoneId),
    viewer,
  )) {
    const camera = parseLinkRef(l.sourceKind, l.sourceRef)!.camera;
    const list = byCamera.get(camera);
    if (list) list.push(l);
    else byCamera.set(camera, [l]);
  }
  const out: IncidentDropletLinkView[] = [];
  for (const camera of [...new Set(incident.cameras)].sort(byString)) {
    const onCamera = byCamera.get(camera);
    if (!onCamera || !onCamera.every(dropletSet)) continue;
    const ordered = [...onCamera].sort((a, b) => byString(a.sourceKind, b.sourceKind) || byString(a.sourceRef, b.sourceRef));
    for (const l of ordered) {
      out.push({
        linkId: l.id,
        zone: { id: l.zone.id, name: l.zone.name, kind: l.zone.kind },
        sourceKind: l.sourceKind,
        sourceRef: l.sourceRef,
        camera,
        label: cameraLabels.get(camera) ?? l.sourceLabel,
      });
    }
  }
  return out;
}

/**
 * Route 18's `dropletLinks`: null unless the viewer rule admits (no query is
 * made otherwise), else the incident rule over its area's links as they are
 * now. Camera names are read only when there is a line to name.
 */
export async function loadIncidentDropletLinks(
  prisma: Pick<PrismaClient, "securityZoneLink" | "camera">,
  incident: IncidentLinksIncident,
  viewer: IncidentViewer,
  level: "view" | "act" | "manage",
): Promise<IncidentDropletLinkView[] | null> {
  if (!mayKeepIncidentLinks(viewer, level)) return null;
  if (incident.scope !== "area" || incident.zoneId === null) return [];
  const links = await prisma.securityZoneLink.findMany({
    where: { zoneId: incident.zoneId, state: "active", zone: { state: "active" } },
    select: INCIDENT_LINK_SELECT,
  });
  if (!links.some(dropletSet)) return [];
  return dropletOnlyLinks(incident, links, viewer, await loadCameraLabels(prisma));
}
