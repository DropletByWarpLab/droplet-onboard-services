/**
 * WARP-2977 P2b (ADR-059 §3.4) — areas ("zones" in code): read-time
 * resolution of SecurityEvent rows to the places they happened in, and the
 * audited writes behind /api/security/zones.
 *
 * Slice B. The exported signatures S0 stubbed are unchanged (spec §6.1, §7
 * routes 3, 4, 8–12); everything after `diffZoneLinks` is new in B.
 *
 * The rules (spec §3, §6.1):
 *   · Resolution is a READ-TIME join on active links of active zones —
 *     SecurityEvent has no zoneId. A link fix applies to history.
 *   · camera `C` matches every row with camera C (detections AND the
 *     camera's offline/online rows). camera_zone `C/F` matches C's detections
 *     whose cameraZones include F, AND C's offline/online rows (an area
 *     watched through part of a view must still show its camera went blind).
 *   · threat, source_offline/online and mode_changed rows are site-wide and
 *     never match an area.
 *   · DS-005 applied to places: an area whose every active link is hidden
 *     from the viewer is hidden entirely; an area with zero links is shown.
 *   · `zoneEventWhere` never returns `{}` or `{OR: []}` — an empty visible
 *     link set is the sentinel "none", and the caller answers an empty page
 *     WITHOUT calling findMany.
 *   · `zonesForEvent` is the in-memory twin of `zoneEventWhere`; a pg-lane
 *     property test (security-zones.pg.test.ts) pins that they agree.
 *
 * Writes (routes 8–12) each run in ONE `READ_COMMITTED_TX` transaction:
 * compare-and-set on `SecurityZone.version`, then the change, then
 * `auditSecurityInTx` LAST — the change and its ActivityRow commit together
 * or not at all. No audit on `changed:false`, a 409 or a lost CAS.
 *
 * `nameKey` is computed IN SQL (`lower(btrim($1))`) inside the write
 * transaction, never in JS: the `SecurityZone_name_key` CHECK is
 * `"nameKey" = lower(btrim("name"))`, and JS `toLowerCase` disagrees with
 * Postgres `lower()` on real names ('İstanbul', a final sigma), which would
 * turn those names into CHECK violations.
 *
 * WARP-2979 (ADR-059 P4 §6.5, §6.7.1) — Droplet's links. A link row now says
 * who created it (`origin`, immutable) and who set its current state
 * (`stateSetBy`), both explicit enums with NO database default: every writer
 * names both (a person's route-12 write is `person`/`person`). What reads
 * them:
 *   · `ActiveZoneLink.setBy` — P3's area choice and alert codes take only
 *     links a PERSON made or kept (`personLinked`, `buildZoneIndex`'s
 *     `personOnly`): a link Droplet activated on its own groups events into
 *     its area (context) but never makes an alert by itself;
 *   · the states `proposed` (Droplet's suggestion) and `rejected` (a person
 *     said no, or undid Droplet's link) are final-for-Droplet memory, like
 *     `removed`; `loadActiveLinks` and every read-time match still read
 *     `active` only.
 */
import type {
  Prisma,
  PrismaClient,
  SecurityLinkActor,
  SecurityZoneKind,
  SecurityZoneLinkState,
  SecurityZoneSourceKind,
  SecurityZoneState,
} from "@prisma/client";
import type { SecurityViewerScope } from "./security-access.js";
import { FRIGATE_NAME, type SecurityEventKind, type SecurityEventSource } from "./security-event-ingest.js";
import { auditSecurityInTx, chainSafeText, stripUnsafeDisplayChars } from "./security-audit.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";
import { linkEvidenceSources, parseLinkEvidence, type LinkEvidenceV1 } from "../lib/security-link-evidence.js";

/** Route 8/11 refuse a 65th ACTIVE area (409 ZONE_LIMIT). */
export const SECURITY_ZONE_ACTIVE_LIMIT = 64;
/** Route 12 accepts at most this many links per area. */
export const SECURITY_ZONE_LINK_LIMIT = 32;

/** One active link of one active area — a row of `loadActiveLinks`. */
export interface ActiveZoneLink {
  linkId: string;
  zoneId: string;
  zoneName: string;
  zoneKind: SecurityZoneKind;
  sourceKind: SecurityZoneSourceKind;
  /** camera: `<frigateCamera>`; camera_zone: `<frigateCamera>/<frigateZone>`. */
  sourceRef: string;
  /**
   * WARP-2979 — who set the link's current (active) state: `person` for a link
   * a person made or kept, `droplet` for one Droplet activated on its own
   * ("Linked by Droplet"). Only `person` links anchor Droplet's suggestions
   * and make alerts (§6.7.1).
   */
  setBy: SecurityLinkActor;
}

/** What a link points at. PR-2 widens this with `{nodeId, endpointId}` for `lock`. */
export interface ParsedLinkRef {
  camera: string;
  /** The Frigate zone for camera_zone; null for a whole-camera link. */
  frigateZone: string | null;
}

/** The fields of a stored SecurityEvent the in-memory matcher reads. */
export interface ZoneMatchableEvent {
  source: SecurityEventSource;
  kind: SecurityEventKind;
  camera: string | null;
  cameraZones: readonly string[];
  /**
   * Read ONLY by PR-2's lock arm (`matter:<nodeId>/<endpointId>`), which
   * matches nothing when it is absent. Optional so PR-1's row decoration can
   * build this from a `listSecurityEvents` page, which does not select it.
   */
  sourceRef?: string;
}

/**
 * The in-memory index `zonesForEvent` matches against, built once per page
 * from the viewer's VISIBLE links of VISIBLE areas. Owned by B, which may
 * reshape it — callers only pass it from `buildZoneIndex` to `zonesForEvent`.
 */
export interface ZoneIndex {
  /** camera → area ids linked to the whole camera. */
  readonly byCamera: ReadonlyMap<string, readonly string[]>;
  /** camera → Frigate zone → area ids linked to that part of the view. */
  readonly byCameraZone: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
}

/** A link as requested by route 12's body. */
export interface DesiredZoneLink {
  sourceKind: SecurityZoneSourceKind;
  sourceRef: string;
}

/** A link row as stored, in any state (WARP-2979: active, removed, proposed or rejected). */
export interface ExistingZoneLink extends DesiredZoneLink {
  id: string;
  state: SecurityZoneLinkState;
  /** WARP-2979 — who created the row. */
  origin: SecurityLinkActor;
  /** WARP-2979 — who set its current state. */
  stateSetBy: SecurityLinkActor;
}

/**
 * Route 12's diff. Its lists are the `zone.links` audit refs (as ref strings).
 * Every write it plans is a PERSON's: `stateSetBy = person` (§6.5's table).
 */
export interface ZoneLinkDiff {
  /** Refs this area never had → create `active`, origin person. */
  added: DesiredZoneLink[];
  /** `removed` (and, WARP-2979, `rejected`) rows asked for again → back to `active`. */
  reactivated: ExistingZoneLink[];
  /**
   * WARP-2979 — Droplet's `proposed` rows the person ticked and saved →
   * `active`, stateSetBy person. A suggestion NOT in the desired set is left
   * alone (routes 24/25 decide suggestions, never a save).
   */
  accepted: ExistingZoneLink[];
  /** `active` rows (any origin or setter) no longer asked for → `removed`, stateSetBy person. */
  removed: ExistingZoneLink[];
}

// ── wire views (routes 3, 4, 8–12) — mirrored in apps/web-dashboard/src/lib/types.ts ──

export interface SecurityZoneLinkView {
  id: string;
  sourceKind: SecurityZoneSourceKind;
  /** camera: `<frigateCamera>`; camera_zone: `<frigateCamera>/<frigateZone>`. */
  sourceRef: string;
  /**
   * ALWAYS the CAMERA's display name — the live `Camera.displayName` when the
   * camera exists, else the `sourceLabel` snapshot — for camera AND
   * camera_zone links alike. It NEVER includes the part: the UI renders a
   * camera_zone link as "<label> (the '<part>' part of the view)", where the
   * part is always `sourceRef.slice(sourceRef.indexOf('/') + 1)`.
   * `SecurityZoneLink.sourceLabel` is snapshotted at link time as that same
   * camera display name (never "camera / part").
   */
  label: string;
  state: SecurityZoneLinkState;
  stateChangedAt: string;
  /** WARP-2979 — who created the link: a person, or Droplet (its suggestion, or its own link). */
  origin: SecurityLinkActor;
  /**
   * WARP-2979 — who set its current state. `origin droplet` + `setBy droplet`
   * is "Linked by Droplet" (Keep / Undo); `origin droplet` + `setBy person` is
   * a suggestion a person added or kept. Only person-set links make alerts.
   */
  setBy: SecurityLinkActor;
  /**
   * WARP-2979 (§7 route 3) — Droplet's evidence, or null: null unless `origin
   * = droplet`, the stored value parses (`parseLinkEvidence`, fail closed),
   * AND this viewer can see every source it names (DS-005: it says when
   * someone was at a camera).
   */
  evidence: LinkEvidenceV1 | null;
}

export interface SecurityZoneView {
  id: string;
  name: string;
  kind: SecurityZoneKind;
  state: SecurityZoneState;
  version: number;
  /** The viewer's VISIBLE active links only. */
  links: SecurityZoneLinkView[];
}

export type SecurityLinkStatus = "present" | "missing" | "unknown";

/**
 * Route 4, GET /api/security/sources. Degrades per half (Camera rows,
 * Frigate's config); a whole 503 only when the viewer's grants or the links
 * themselves cannot be read (there is then nothing safe or true to list).
 */
export interface SecuritySourcesView {
  frigate: "ok" | "unavailable";
  /** Visible cameras only; `parts` are that camera's Frigate zone keys that pass FRIGATE_NAME. */
  cameras: Array<{ name: string; label: string; parts: string[] }>;
  linkStatus: Array<{ linkId: string; status: SecurityLinkStatus }>;
}

// ── read-time resolution ──────────────────────────────────────────────────

/**
 * Every link with state `active` whose area has state `active`, with the
 * area's id, name and kind. One query; small (≤ 64 areas × 32 links).
 */
export async function loadActiveLinks(
  prisma: Pick<PrismaClient, "securityZoneLink">,
): Promise<ActiveZoneLink[]> {
  const rows = await prisma.securityZoneLink.findMany({
    where: { state: "active", zone: { state: "active" } },
    select: {
      id: true,
      zoneId: true,
      sourceKind: true,
      sourceRef: true,
      stateSetBy: true,
      zone: { select: { name: true, kind: true } },
    },
    orderBy: [{ zoneId: "asc" }, { sourceKind: "asc" }, { sourceRef: "asc" }],
  });
  return rows.map((r) => ({
    linkId: r.id,
    zoneId: r.zoneId,
    zoneName: r.zone.name,
    zoneKind: r.zone.kind,
    sourceKind: r.sourceKind,
    sourceRef: r.sourceRef,
    setBy: r.stateSetBy,
  }));
}

/** The single link-ref parser; the DS-005 filter reads the camera from it. Null = malformed. */
export function parseLinkRef(kind: SecurityZoneSourceKind, ref: string): ParsedLinkRef | null {
  switch (kind) {
    case "camera":
      return FRIGATE_NAME.test(ref) ? { camera: ref, frigateZone: null } : null;
    case "camera_zone": {
      const slash = ref.indexOf("/");
      if (slash < 0) return null;
      const camera = ref.slice(0, slash);
      const frigateZone = ref.slice(slash + 1);
      return FRIGATE_NAME.test(camera) && FRIGATE_NAME.test(frigateZone) ? { camera, frigateZone } : null;
    }
    default:
      // A kind this build does not know (PR-2's `lock` on a PR-1 reader) is
      // treated as malformed: never visible, never matched — fail closed.
      return null;
  }
}

/** The inverse of `parseLinkRef`: the `{sourceKind, sourceRef}` a parsed ref is stored as. */
export function formatLinkRef(parsed: ParsedLinkRef): DesiredZoneLink {
  return parsed.frigateZone === null
    ? { sourceKind: "camera", sourceRef: parsed.camera }
    : { sourceKind: "camera_zone", sourceRef: `${parsed.camera}/${parsed.frigateZone}` };
}

/**
 * Keep a camera / camera_zone link only when its camera is in
 * `scope.visibleCameras` (owner/admin: "all"). PR-2 keeps lock links only
 * when `scope.mayReadLocks`. A malformed ref is dropped (fail closed).
 */
export function visibleLinks<L extends Pick<ActiveZoneLink, "sourceKind" | "sourceRef">>(
  links: readonly L[],
  scope: Pick<SecurityViewerScope, "visibleCameras">,
): L[] {
  const cams = scope.visibleCameras;
  return links.filter((l) => {
    const parsed = parseLinkRef(l.sourceKind, l.sourceRef);
    return parsed !== null && (cams === "all" || cams.has(parsed.camera));
  });
}

/** `allActive.length === 0 || visible.length > 0` — a zero-link area shows; an all-hidden one does not. */
export function zoneVisibleTo(
  zone: { id: string },
  allActive: readonly unknown[],
  visible: readonly unknown[],
): boolean {
  void zone;
  return allActive.length === 0 || visible.length > 0;
}

/**
 * Frigate detection rows — the ones a part of a view (`cameraZones`) can
 * narrow. WARP-2978 PR-D: a person's "still in view" row carries the zones
 * they entered so far, and must land in the same areas as their `end` row —
 * or it would group (and alert) elsewhere.
 */
const DETECTION_KINDS = ["detection", "detection_ongoing", "detection_low"] as const;
/** The camera's own health rows — an area watched through any part of the view still shows them. */
const CAMERA_STATUS_KINDS = ["camera_offline", "camera_online"] as const;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whole-camera links and camera → parts, deduped; a whole-camera link subsumes that camera's parts. */
function groupLinks(links: readonly Pick<ActiveZoneLink, "sourceKind" | "sourceRef">[]): {
  whole: string[];
  parts: Array<[camera: string, parts: string[]]>;
} {
  const whole = new Set<string>();
  const parts = new Map<string, Set<string>>();
  for (const l of links) {
    const parsed = parseLinkRef(l.sourceKind, l.sourceRef);
    if (!parsed) continue;
    if (parsed.frigateZone === null) {
      whole.add(parsed.camera);
      continue;
    }
    let set = parts.get(parsed.camera);
    if (!set) parts.set(parsed.camera, (set = new Set()));
    set.add(parsed.frigateZone);
  }
  return {
    whole: [...whole].sort(byString),
    parts: [...parts]
      .filter(([camera]) => !whole.has(camera))
      .map(([camera, set]): [string, string[]] => [camera, [...set].sort(byString)])
      .sort(([a], [b]) => byString(a, b)),
  };
}

/**
 * The feed clause for ONE area's visible links, ANDed after the camera
 * clause (`listSecurityEvents`'s `extraWhere`), or "none" when there is
 * nothing to match. Never `{}` and never `{OR: []}`.
 */
export function zoneEventWhere(
  links: readonly Pick<ActiveZoneLink, "sourceKind" | "sourceRef">[],
): Prisma.SecurityEventWhereInput | "none" {
  const { whole, parts } = groupLinks(links);
  const arms: Prisma.SecurityEventWhereInput[] = [];
  // A whole camera: every row that camera produced — detections and its own
  // offline/online rows. Site-wide rows carry camera NULL and never match.
  for (const camera of whole) arms.push({ camera });
  for (const [camera, zones] of parts) {
    arms.push({
      camera,
      OR: [
        { kind: { in: [...DETECTION_KINDS] }, cameraZones: { hasSome: zones } },
        { kind: { in: [...CAMERA_STATUS_KINDS] } },
      ],
    });
  }
  return arms.length === 0 ? "none" : { OR: arms };
}

/** WARP-2979 — `buildZoneIndex`'s options. */
export interface ZoneIndexOptions {
  /**
   * Only links a PERSON made or kept (`setBy = 'person'`) — the index
   * `camera_offline_during_activity` matches activity against (§6.7.2), so a
   * link Droplet activated on its own can never put someone "in" an area for
   * an alert. A link with no `setBy` is left out (fail closed).
   */
  personOnly?: boolean;
}

/** Build the matcher index from the viewer's visible links of visible areas. */
export function buildZoneIndex(
  links: readonly (Pick<ActiveZoneLink, "zoneId" | "sourceKind" | "sourceRef"> & { setBy?: SecurityLinkActor })[],
  opts: ZoneIndexOptions = {},
): ZoneIndex {
  const byCamera = new Map<string, string[]>();
  const byCameraZone = new Map<string, Map<string, string[]>>();
  const addTo = <K>(map: Map<K, string[]>, key: K, zoneId: string): void => {
    const ids = map.get(key);
    if (!ids) map.set(key, [zoneId]);
    else if (!ids.includes(zoneId)) ids.push(zoneId);
  };
  for (const l of links) {
    if (opts.personOnly && l.setBy !== "person") continue;
    const parsed = parseLinkRef(l.sourceKind, l.sourceRef);
    if (!parsed) continue;
    if (parsed.frigateZone === null) {
      addTo(byCamera, parsed.camera, l.zoneId);
      continue;
    }
    let zones = byCameraZone.get(parsed.camera);
    if (!zones) byCameraZone.set(parsed.camera, (zones = new Map()));
    addTo(zones, parsed.frigateZone, l.zoneId);
  }
  return { byCamera, byCameraZone };
}

/** The area ids one row belongs to — exactly `zoneEventWhere`'s rules, in memory. Sorted. */
export function zonesForEvent(row: ZoneMatchableEvent, index: ZoneIndex): string[] {
  if (row.camera === null) return [];
  const out = new Set<string>(index.byCamera.get(row.camera) ?? []);
  const parts = index.byCameraZone.get(row.camera);
  if (parts) {
    if ((CAMERA_STATUS_KINDS as readonly string[]).includes(row.kind)) {
      for (const ids of parts.values()) for (const id of ids) out.add(id);
    } else if ((DETECTION_KINDS as readonly string[]).includes(row.kind)) {
      for (const z of row.cameraZones) for (const id of parts.get(z) ?? []) out.add(id);
    }
  }
  return [...out].sort(byString);
}

/** One active area an event matched (`matchAreasForEvent`). */
export interface ZoneEventMatch {
  zoneId: string;
  zoneName: string;
  zoneKind: SecurityZoneKind;
  /** The area's active link ids that matched this event, sorted. */
  linkIds: string[];
  /** `part` when a part-of-view (camera_zone) link matched, else `whole`. */
  specificity: "part" | "whole";
  /**
   * WARP-2979 (§6.7.1) — true when ANY matching link was made or kept by a
   * person (`setBy = 'person'`). An area matched only through links Droplet
   * activated on its own is context: it groups, it never alerts, and P3's
   * area choice ranks it below every person-linked area.
   */
  personLinked: boolean;
}

/**
 * WARP-2978 (ADR-059 P3 spec §6.2) — every active area one row matches, from
 * ALL active links (never viewer-filtered: the incident engine groups for
 * everyone, and DS-005 is applied when incidents are read). Exactly
 * `zonesForEvent`'s rules — a whole camera matches every row with that
 * camera; a part of a view matches that camera's detections whose
 * cameraZones include it, and all of that camera's offline/online rows —
 * plus, per area, the link ids that matched and whether a part-of-view link
 * did (`specificity`, for the engine's rank). Sorted by zone id; link ids
 * sorted. A property test pins that the zone ids agree with `zonesForEvent`.
 * WARP-2979: plus whether a person-set link matched (`personLinked`).
 */
export function matchAreasForEvent(row: ZoneMatchableEvent, links: readonly ActiveZoneLink[]): ZoneEventMatch[] {
  if (row.camera === null) return [];
  const isStatus = (CAMERA_STATUS_KINDS as readonly string[]).includes(row.kind);
  const isDetection = (DETECTION_KINDS as readonly string[]).includes(row.kind);
  const byZone = new Map<string, ZoneEventMatch>();
  for (const l of links) {
    const parsed = parseLinkRef(l.sourceKind, l.sourceRef);
    if (!parsed || parsed.camera !== row.camera) continue;
    const matched =
      parsed.frigateZone === null || isStatus || (isDetection && row.cameraZones.includes(parsed.frigateZone));
    if (!matched) continue;
    let m = byZone.get(l.zoneId);
    if (!m) {
      m = { zoneId: l.zoneId, zoneName: l.zoneName, zoneKind: l.zoneKind, linkIds: [], specificity: "whole", personLinked: false };
      byZone.set(l.zoneId, m);
    }
    m.linkIds.push(l.linkId);
    if (parsed.frigateZone !== null) m.specificity = "part";
    if (l.setBy === "person") m.personLinked = true;
  }
  return [...byZone.values()]
    .map((m) => ({ ...m, linkIds: [...new Set(m.linkIds)].sort(byString) }))
    .sort((a, b) => byString(a.zoneId, b.zoneId));
}

const linkKey = (l: DesiredZoneLink): string => `${l.sourceKind}\u0000${l.sourceRef}`;

/**
 * Route 12: requested links vs stored ones (deduped by `sourceKind` + `sourceRef`).
 * WARP-2979 (§6.5) — every cell of the table, each a PERSON's write:
 *
 * | stored row                 | in the desired set              | not in it                |
 * | none                       | added (active, person/person)   | —                        |
 * | active (any origin/setter) | unchanged                       | removed (setter person)  |
 * | removed                    | reactivated (setter person)     | unchanged                |
 * | proposed (Droplet's)       | ACCEPTED (active, setter person)| unchanged — suggestions  |
 * |                            |                                 | are decided by routes    |
 * |                            |                                 | 24/25, never by a save   |
 * | rejected                   | reactivated (a person linked it | unchanged                |
 * |                            | after all; setter person)       |                          |
 *
 * Before P4 a `proposed` row in the desired set matched neither branch and was
 * silently ignored; the pg lane pins the fix.
 */
export function diffZoneLinks(
  existing: readonly ExistingZoneLink[],
  desired: readonly DesiredZoneLink[],
): ZoneLinkDiff {
  const stored = new Map(existing.map((e) => [linkKey(e), e]));
  const wanted = new Set<string>();
  const diff: ZoneLinkDiff = { added: [], reactivated: [], accepted: [], removed: [] };
  for (const d of desired) {
    const key = linkKey(d);
    if (wanted.has(key)) continue;
    wanted.add(key);
    const e = stored.get(key);
    if (!e) diff.added.push({ sourceKind: d.sourceKind, sourceRef: d.sourceRef });
    else if (e.state === "removed" || e.state === "rejected") diff.reactivated.push(e);
    else if (e.state === "proposed") diff.accepted.push(e);
  }
  for (const e of existing) {
    if (e.state === "active" && !wanted.has(linkKey(e))) diff.removed.push(e);
  }
  return diff;
}

// ── B: what one viewer sees ───────────────────────────────────────────────

/** The viewer's visible areas, for the feed's `?zone=` filter and row decoration. */
export interface ViewerAreas {
  /** Area id → name, for every VISIBLE area that has at least one visible link. */
  readonly names: ReadonlyMap<string, string>;
  /** `buildZoneIndex` over the viewer's visible links of visible areas. */
  readonly index: ZoneIndex;
}

/** Group `loadActiveLinks` rows per area and keep only what this viewer may see. */
export function viewerAreas(
  all: readonly ActiveZoneLink[],
  scope: Pick<SecurityViewerScope, "visibleCameras">,
): ViewerAreas {
  const perZone = new Map<string, ActiveZoneLink[]>();
  for (const l of all) {
    const list = perZone.get(l.zoneId);
    if (list) list.push(l);
    else perZone.set(l.zoneId, [l]);
  }
  const names = new Map<string, string>();
  const shown: ActiveZoneLink[] = [];
  for (const [zoneId, links] of perZone) {
    const visible = visibleLinks(links, scope);
    if (!zoneVisibleTo({ id: zoneId }, links, visible)) continue;
    names.set(zoneId, links[0]!.zoneName);
    shown.push(...visible);
  }
  return { names, index: buildZoneIndex(shown) };
}

/**
 * A row's area chips for one viewer — `{id, name}` of the VISIBLE areas it
 * belongs to, sorted by name then id. The ONE resolver behind the feed's
 * `zones` (route 1) and the incident page's member rows (route 18, WARP-2978
 * review A), so the two can never disagree about what a viewer may see.
 */
export function zoneChipsFor(row: ZoneMatchableEvent, areas: ViewerAreas): Array<{ id: string; name: string }> {
  return zonesForEvent(row, areas.index)
    .map((id) => ({ id, name: areas.names.get(id) ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name) || byString(a.id, b.id));
}

/**
 * The `?zone=` clause for one viewer: "none" when the area is missing,
 * archived, hidden from the viewer, or has no visible link — every one of
 * which answers the P2a way (an empty page, never a 403/404 that confirms
 * the area exists).
 */
export function zoneFilterFor(
  all: readonly ActiveZoneLink[],
  zoneId: string,
  scope: Pick<SecurityViewerScope, "visibleCameras">,
): Prisma.SecurityEventWhereInput | "none" {
  const links = all.filter((l) => l.zoneId === zoneId);
  const visible = visibleLinks(links, scope);
  if (!zoneVisibleTo({ id: zoneId }, links, visible)) return "none";
  return zoneEventWhere(visible);
}

/** An area as the writes and the list read it: the area plus its ACTIVE links. */
export interface ZoneRecord {
  id: string;
  name: string;
  kind: SecurityZoneKind;
  state: SecurityZoneState;
  version: number;
  links: StoredZoneLink[];
}

export interface StoredZoneLink {
  id: string;
  sourceKind: SecurityZoneSourceKind;
  sourceRef: string;
  sourceLabel: string;
  state: SecurityZoneLinkState;
  stateChangedAt: Date;
  /** WARP-2979. */
  origin: SecurityLinkActor;
  stateSetBy: SecurityLinkActor;
  evidence: Prisma.JsonValue | null;
}

const LINK_SELECT = {
  id: true,
  sourceKind: true,
  sourceRef: true,
  sourceLabel: true,
  state: true,
  stateChangedAt: true,
  origin: true,
  stateSetBy: true,
  evidence: true,
} satisfies Prisma.SecurityZoneLinkSelect;

/** An area with its ACTIVE links only — removed links are history, never shown. */
const ZONE_SELECT = {
  id: true,
  name: true,
  kind: true,
  state: true,
  version: true,
  links: {
    where: { state: "active" },
    select: LINK_SELECT,
    orderBy: [{ sourceKind: "asc" }, { sourceRef: "asc" }],
  },
} satisfies Prisma.SecurityZoneSelect;

/** Route 3's rows: active areas (plus archived ones when asked), each with its ACTIVE links. */
export async function loadZoneRecords(
  prisma: Pick<PrismaClient, "securityZone">,
  includeArchived: boolean,
): Promise<ZoneRecord[]> {
  return prisma.securityZone.findMany({
    where: includeArchived ? {} : { state: "active" },
    select: ZONE_SELECT,
    orderBy: [{ state: "asc" }, { name: "asc" }, { id: "asc" }],
  });
}

/** Frigate camera name → the camera's display name, from the Camera rows. */
export async function loadCameraLabels(prisma: Pick<PrismaClient, "camera">): Promise<Map<string, string>> {
  const rows = await prisma.camera.findMany({ select: { name: true, displayName: true } });
  return new Map(rows.map((r) => [r.name, r.displayName]));
}

/**
 * WARP-2979 (§7 route 3, D13) — Droplet's evidence for ONE viewer: the parsed
 * `LinkEvidenceV1` when the link is Droplet's (`origin = droplet`), the
 * stored value is exactly that shape, and the viewer can see EVERY source it
 * names (the anchor and the candidate — `linkEvidenceSources`; a lock is
 * never visible before PR-4's `mayReadLocks`). Anything else is null: the
 * evidence says when someone stood at a camera (DS-005), so a viewer who can
 * see the link but not the anchor gets the chip without the numbers.
 */
export function evidenceFor(
  link: { origin: SecurityLinkActor; evidence: unknown },
  scope: Pick<SecurityViewerScope, "visibleCameras"> | null,
): LinkEvidenceV1 | null {
  if (!scope || link.origin !== "droplet") return null;
  const e = parseLinkEvidence(link.evidence);
  if (!e) return null;
  const named = linkEvidenceSources(e);
  const shown = visibleLinks(
    named.filter((s): s is { sourceKind: SecurityZoneSourceKind; sourceRef: string } => s.sourceKind === "camera" || s.sourceKind === "camera_zone"),
    scope,
  );
  return shown.length === named.length ? e : null;
}

/**
 * One area's wire view over the links the CALLER already filtered for the
 * viewer. `label` is the live camera display name, else the snapshot.
 * `scope` (WARP-2979) decides who sees Droplet's evidence; without it no
 * evidence is sent.
 */
export function toZoneView(
  zone: Omit<ZoneRecord, "links">,
  links: readonly StoredZoneLink[],
  cameraLabels: ReadonlyMap<string, string>,
  scope: Pick<SecurityViewerScope, "visibleCameras"> | null = null,
): SecurityZoneView {
  return {
    id: zone.id,
    name: zone.name,
    kind: zone.kind,
    state: zone.state,
    version: zone.version,
    links: links.map((l) => {
      const camera = parseLinkRef(l.sourceKind, l.sourceRef)?.camera;
      return {
        id: l.id,
        sourceKind: l.sourceKind,
        sourceRef: l.sourceRef,
        label: (camera !== undefined ? cameraLabels.get(camera) : undefined) ?? l.sourceLabel,
        state: l.state,
        stateChangedAt: l.stateChangedAt.toISOString(),
        origin: l.origin,
        setBy: l.stateSetBy,
        evidence: evidenceFor(l, scope),
      };
    }),
  };
}

/** Route 3: the areas this viewer may see, each with only its visible links (DS-005). */
export function visibleZoneViews(
  zones: readonly ZoneRecord[],
  scope: Pick<SecurityViewerScope, "visibleCameras">,
  cameraLabels: ReadonlyMap<string, string>,
): SecurityZoneView[] {
  const out: SecurityZoneView[] = [];
  for (const z of zones) {
    const visible = visibleLinks(z.links, scope);
    if (!zoneVisibleTo(z, z.links, visible)) continue;
    out.push(toZoneView(z, visible, cameraLabels, scope));
  }
  return out;
}

// ── B: what a link can point at (route 4, route 12's existence check) ─────

/**
 * What the camera system has, from its two halves. Either half may be
 * unreadable (null) — the sources list degrades per half, and a link whose
 * answer depends on an unreadable half is `unknown`, never `missing`.
 */
export interface SourceCatalog {
  /** Camera rows: Frigate name → display name. Null = could not be read. */
  cameraRows: ReadonlyMap<string, string> | null;
  /** Frigate's config: camera → its parts (zone keys that pass FRIGATE_NAME). Null = unavailable. */
  frigate: ReadonlyMap<string, readonly string[]> | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Frigate's `/api/config` → camera → parts. Camera names and zone keys that
 * fail FRIGATE_NAME are dropped (a link to a name the ingest would refuse
 * could never match a row). Throws when the payload has no `cameras` map —
 * that is an unreadable half, not a system with no cameras.
 */
export function frigatePartsFromConfig(config: unknown): Map<string, string[]> {
  if (!isRecord(config) || !isRecord(config.cameras)) {
    throw new Error("the camera system's config has no cameras map");
  }
  const out = new Map<string, string[]>();
  for (const [name, cam] of Object.entries(config.cameras)) {
    if (!FRIGATE_NAME.test(name)) continue;
    const zones = isRecord(cam) && isRecord(cam.zones) ? Object.keys(cam.zones) : [];
    out.set(name, zones.filter((z) => FRIGATE_NAME.test(z)).sort(byString));
  }
  return out;
}

/**
 * Whether a link still points at something, at read time. Stale sources are
 * never auto-edited (spec §6.1); this is how the page shows them.
 *   · camera C: present when C is a Camera row OR in Frigate's config;
 *     missing only when BOTH halves were read; else unknown.
 *   · camera_zone C/F: only Frigate's config knows parts — present when F is
 *     one of C's zones there, missing when it is not, unknown when the config
 *     could not be read.
 */
export function linkSourceStatus(link: DesiredZoneLink, catalog: SourceCatalog): SecurityLinkStatus {
  const parsed = parseLinkRef(link.sourceKind, link.sourceRef);
  if (!parsed) return "missing";
  if (parsed.frigateZone === null) {
    if (catalog.cameraRows?.has(parsed.camera) || catalog.frigate?.has(parsed.camera)) return "present";
    return catalog.cameraRows && catalog.frigate ? "missing" : "unknown";
  }
  if (!catalog.frigate) return "unknown";
  return catalog.frigate.get(parsed.camera)?.includes(parsed.frigateZone) ? "present" : "missing";
}

/**
 * Route 4's body, pure. `links` are loadActiveLinks rows — read on their
 * own, so a catalog half that could not be read (null) still gets every
 * visible link a status (`unknown` where the answer needed that half). The
 * route answers 503 when the links themselves cannot be read.
 */
export function buildSourcesView(
  catalog: SourceCatalog,
  links: readonly ActiveZoneLink[],
  scope: Pick<SecurityViewerScope, "visibleCameras">,
): SecuritySourcesView {
  const cams = scope.visibleCameras;
  const names = new Set<string>([...(catalog.cameraRows?.keys() ?? []), ...(catalog.frigate?.keys() ?? [])]);
  const cameras = [...names]
    .filter((name) => FRIGATE_NAME.test(name) && (cams === "all" || cams.has(name)))
    .map((name) => ({
      name,
      label: catalog.cameraRows?.get(name) ?? name,
      parts: [...(catalog.frigate?.get(name) ?? [])],
    }))
    .sort((a, b) => byString(a.label, b.label) || byString(a.name, b.name));
  // The visible links of visible areas: an all-hidden area contributes no
  // visible link, so filtering the links IS filtering the areas here.
  const linkStatus = visibleLinks(links, scope).map((l) => ({
    linkId: l.linkId,
    status: linkSourceStatus(l, catalog),
  }));
  return { frigate: catalog.frigate ? "ok" : "unavailable", cameras, linkStatus };
}

// ── B: the audited writes (routes 8–12) ───────────────────────────────────

export type ZoneWriteErrorCode =
  | "VALIDATION_ERROR"
  | "ZONE_NOT_FOUND"
  | "ZONE_ARCHIVED"
  | "VERSION_CONFLICT"
  | "ZONE_NAME_TAKEN"
  | "ZONE_LIMIT"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_CHECK_UNAVAILABLE"
  // WARP-2979 — routes 24/25 (a person decides on Droplet's link).
  | "LINK_NOT_FOUND"
  | "LINK_NOT_DECIDABLE"
  | "LINK_CONFLICT"
  | "LINK_LIMIT";

/** An expected refusal: the route answers `status` with `{error: {code, message, ...extra}}`. */
export class ZoneWriteError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503,
    readonly code: ZoneWriteErrorCode,
    message: string,
    readonly extra: { archivedZoneId?: string; issues?: unknown[] } = {},
  ) {
    super(message);
    this.name = "ZoneWriteError";
  }
}

/** Who is writing and when. `req` carries the audit actor. */
export interface ZoneWriteContext {
  req: { user?: { id: string; role?: string } | undefined };
  now: Date;
}

export const SECURITY_ZONE_KINDS = [
  "entry",
  "interior",
  "perimeter",
  "parking",
  "restricted",
] as const satisfies readonly SecurityZoneKind[];

/** Characters an area name may never hold: C0/C1 controls and line/paragraph separators. */
const NAME_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/**
 * Invisible characters an area name may never hold, anywhere in what was
 * sent (edges included — JS `trim` would quietly drop an edge U+FEFF). The
 * whole format class \p{Cf}, not a hand list:
 *   · bidi embeddings / overrides / isolates and the LRM / RLM / ALM marks —
 *     they reorder what follows, so a name can read as something else on the
 *     Areas page, on feed rows and on /admin/audit;
 *   · zero-width characters, the word joiner, U+FEFF, the soft hyphen, the
 *     invisible math operators, the Mongolian vowel separator — two names
 *     that look the same would be two different areas;
 *   · the TAG block U+E0000–U+E007F — ASCII text a person cannot see but a
 *     language model reads (chat tools will read area names).
 * Plus the blank letters and marks that are not \p{Cf} but render as
 * nothing: CGJ U+034F, the Hangul fillers U+115F / U+1160 / U+3164 / U+FFA0,
 * the Khmer inherent vowels U+17B4 / U+17B5, and the Braille blank U+2800.
 * Variation selectors stay allowed: iOS types a heart emoji with VS16.
 */
const NAME_INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0]/u;
/**
 * One character a person can actually see: not whitespace, not a control,
 * format, unassigned or private-use character (\p{C}), not a separator, not
 * a lone combining mark, and not default-ignorable.
 */
const NAME_VISIBLE = /[^\p{White_Space}\p{C}\p{Z}\p{M}\p{Default_Ignorable_Code_Point}]/u;
/** Mirrors `SecurityZone.name @db.VarChar(60)` and the CHECK's `length(btrim(name)) BETWEEN 1 AND 60`. */
export const SECURITY_ZONE_NAME_MAX = 60;

/**
 * Route 8/9's name rule, checked BEFORE the transaction: Unicode NFC, then
 * trimmed, every run of space characters (\p{Zs}: a no-break space, a double
 * space) made one U+0020, 1–60 characters (code points, as Postgres counts
 * them), at least one of them visible, no control or invisible characters
 * (`NAME_FORBIDDEN`, `NAME_INVISIBLE`), and storable in the audit chain
 * (`chainSafeText`). Returns the name to store, or null (→ 400
 * VALIDATION_ERROR). The stored name is the normalised one, so 'Café' typed
 * as NFD and as NFC, or 'Front  door' and 'Front door', get the same nameKey
 * and collide (409 ZONE_NAME_TAKEN). Look-alike letters from other scripts
 * still pass: this makes names unambiguous, not unique by sight. JS `trim` is
 * wider than Postgres `btrim` (which strips only spaces), so the stored name
 * has no edge whitespace of any kind and `btrim(name) = name` in the CHECK.
 */
export function normaliseZoneName(raw: string): string | null {
  const nfc = raw.normalize("NFC");
  if (NAME_INVISIBLE.test(nfc)) return null;
  const name = nfc.trim().replace(/\p{Zs}+/gu, " ");
  if (!chainSafeText(name) || NAME_FORBIDDEN.test(name) || !NAME_VISIBLE.test(name)) return null;
  const length = [...name].length;
  return length >= 1 && length <= SECURITY_ZONE_NAME_MAX ? name : null;
}

type ZoneTx = Prisma.TransactionClient;

/** `lower(btrim(name))` computed by Postgres — the only thing the CHECK accepts as nameKey. */
async function sqlNameKey(tx: Pick<ZoneTx, "$queryRaw">, name: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ k: string }>>`SELECT lower(btrim(${name}::text)) AS k`;
  const key = rows[0]?.k;
  if (typeof key !== "string") throw new Error("nameKey: Postgres returned no row");
  return key;
}

/**
 * Serialises the "fewer than 64 active areas" check-then-write of create and
 * unarchive. Taken before any SecurityZone row (spec §6.3 lock order), and by
 * nothing else, so it cannot deadlock with the other writes.
 */
const ZONE_LIMIT_LOCK_KEY = "droplet:security-zone-limit";
async function lockZoneLimit(tx: Pick<ZoneTx, "$queryRaw">): Promise<void> {
  // `IS NULL` so the row has a boolean column: Prisma cannot deserialise `void`.
  await tx.$queryRaw`SELECT (pg_advisory_xact_lock(hashtext(${ZONE_LIMIT_LOCK_KEY}::text)) IS NULL) AS locked`;
}

async function assertBelowZoneLimit(tx: Pick<ZoneTx, "securityZone">): Promise<void> {
  const active = await tx.securityZone.count({ where: { state: "active" } });
  if (active >= SECURITY_ZONE_ACTIVE_LIMIT) {
    throw new ZoneWriteError(409, "ZONE_LIMIT", `There can be at most ${SECURITY_ZONE_ACTIVE_LIMIT} areas`);
  }
}

const notFound = (): ZoneWriteError => new ZoneWriteError(404, "ZONE_NOT_FOUND", "No such area");
const archived = (): ZoneWriteError => new ZoneWriteError(409, "ZONE_ARCHIVED", "The area was removed; restore it first");
const versionConflict = (): ZoneWriteError =>
  new ZoneWriteError(409, "VERSION_CONFLICT", "Someone else changed this area; reload and try again");

/**
 * A CAS reported count 0: say why, from the row as it is now. Every write
 * bumps the version, so a lost race is always at least a VERSION_CONFLICT;
 * `activeRequired` names the more useful ZONE_ARCHIVED when the area was
 * removed underneath an edit.
 */
async function casLost(
  tx: Pick<ZoneTx, "securityZone">,
  id: string,
  activeRequired: boolean,
): Promise<ZoneWriteError> {
  const now = await tx.securityZone.findUnique({ where: { id }, select: { state: true } });
  if (!now) return notFound();
  return activeRequired && now.state !== "active" ? archived() : versionConflict();
}

/** A unique violation on `nameKey` — P2002 from the model API, P2010/23505 from raw SQL. */
export function isZoneNameTaken(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { target?: unknown; code?: unknown; message?: unknown } } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === "P2002") {
    const target = e.meta?.target;
    return Array.isArray(target) ? target.includes("nameKey") : String(target ?? "").includes("nameKey");
  }
  if (e.code === "P2010" && e.meta?.code === "23505") return String(e.meta?.message ?? "").includes("nameKey");
  return false;
}

/** A violation of the `SecurityZone_name_key` CHECK (23514), whichever Prisma error carried it. */
export function isZoneNameCheckViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown } } | null;
  if (!e || typeof e !== "object") return false;
  const text = `${String(e.message ?? "")} ${String(e.meta?.message ?? "")}`;
  if (!text.includes("SecurityZone_name_key")) return false;
  return e.meta?.code === "23514" || text.includes("23514") || /check constraint/i.test(text);
}

/**
 * Map a failed name write to its refusal: a taken name is 409 ZONE_NAME_TAKEN
 * (with `archivedZoneId` when the holder is a removed area, so the page can
 * offer to restore it), a CHECK violation is 400. Anything else is returned
 * as is.
 */
async function translateNameError(
  prisma: Pick<PrismaClient, "$queryRaw">,
  err: unknown,
  name: string | undefined,
): Promise<unknown> {
  if (isZoneNameCheckViolation(err)) {
    return new ZoneWriteError(400, "VALIDATION_ERROR", "That name can't be used for an area", {
      issues: [{ path: ["name"], message: "invalid name" }],
    });
  }
  if (!isZoneNameTaken(err) || name === undefined) return err;
  let archivedZoneId: string | undefined;
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; state: string }>>`
      SELECT "id", "state"::text AS "state" FROM "SecurityZone"
      WHERE "nameKey" = lower(btrim(${name}::text)) LIMIT 1`;
    if (rows[0]?.state === "archived") archivedZoneId = rows[0].id;
  } catch {
    // The refusal stands without the hint.
  }
  return new ZoneWriteError(
    409,
    "ZONE_NAME_TAKEN",
    "There is already an area with that name",
    archivedZoneId ? { archivedZoneId } : {},
  );
}

/** Route 8. 201 → the new area (no links). */
export async function createZone(
  prisma: PrismaClient,
  ctx: ZoneWriteContext,
  input: { name: string; kind: SecurityZoneKind },
): Promise<ZoneRecord> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockZoneLimit(tx);
      await assertBelowZoneLimit(tx);
      const nameKey = await sqlNameKey(tx, input.name);
      const zone = await tx.securityZone.create({
        data: { name: input.name, nameKey, kind: input.kind, createdById: ctx.req.user?.id ?? null },
        select: ZONE_SELECT,
      });
      await auditSecurityInTx(tx, ctx.req, {
        action: "zone.create",
        what: `Security: added the area "${zone.name}"`,
        refs: { zoneId: zone.id, name: zone.name, kind: zone.kind },
      });
      return zone;
    }, READ_COMMITTED_TX);
  } catch (err) {
    throw await translateNameError(prisma, err, input.name);
  }
}

/** Route 9. Nothing to change → `changed:false`, no write, no audit. */
export async function updateZone(
  prisma: PrismaClient,
  ctx: ZoneWriteContext,
  id: string,
  input: { name?: string; kind?: SecurityZoneKind; expectedVersion: number },
): Promise<{ zone: ZoneRecord; changed: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.securityZone.findUnique({ where: { id }, select: ZONE_SELECT });
      if (!current) throw notFound();
      if (current.state !== "active") throw archived();
      if (current.version !== input.expectedVersion) throw versionConflict();
      const name = input.name ?? current.name;
      const kind = input.kind ?? current.kind;
      if (name === current.name && kind === current.kind) return { zone: current, changed: false };
      const renamed = name !== current.name;
      const { count } = await tx.securityZone.updateMany({
        where: { id, version: input.expectedVersion, state: "active" },
        data: {
          kind,
          ...(renamed ? { name, nameKey: await sqlNameKey(tx, name) } : {}),
          version: { increment: 1 },
        },
      });
      if (count !== 1) throw await casLost(tx, id, true);
      const zone = await tx.securityZone.findUnique({ where: { id }, select: ZONE_SELECT });
      if (!zone) throw notFound();
      await auditSecurityInTx(tx, ctx.req, {
        action: "zone.update",
        what: renamed
          ? `Security: renamed the area "${current.name}" to "${zone.name}"`
          : `Security: changed the area "${zone.name}"`,
        refs: {
          zoneId: zone.id,
          before: { name: current.name, kind: current.kind },
          after: { name: zone.name, kind: zone.kind },
        },
      });
      return { zone, changed: true };
    }, READ_COMMITTED_TX);
  } catch (err) {
    throw await translateNameError(prisma, err, input.name);
  }
}

/**
 * Routes 10 (→ archived, "Remove area") and 11 (→ active, "Restore").
 * Already in that state → `changed:false`. Areas are never row-deleted:
 * events keep flowing, and P3/P5 rows will point here.
 */
export async function setZoneState(
  prisma: PrismaClient,
  ctx: ZoneWriteContext,
  id: string,
  to: SecurityZoneState,
  expectedVersion: number,
): Promise<{ zone: ZoneRecord; changed: boolean }> {
  return prisma.$transaction(async (tx) => {
    if (to === "active") await lockZoneLimit(tx);
    const current = await tx.securityZone.findUnique({ where: { id }, select: ZONE_SELECT });
    if (!current) throw notFound();
    if (current.version !== expectedVersion) throw versionConflict();
    if (current.state === to) return { zone: current, changed: false };
    if (to === "active") await assertBelowZoneLimit(tx);
    const { count } = await tx.securityZone.updateMany({
      where: { id, version: expectedVersion, state: current.state },
      data: { state: to, version: { increment: 1 } },
    });
    if (count !== 1) throw await casLost(tx, id, false);
    const zone = await tx.securityZone.findUnique({ where: { id }, select: ZONE_SELECT });
    if (!zone) throw notFound();
    await auditSecurityInTx(tx, ctx.req, {
      action: to === "archived" ? "zone.archive" : "zone.unarchive",
      what: to === "archived" ? `Security: removed the area "${zone.name}"` : `Security: restored the area "${zone.name}"`,
      refs: { zoneId: zone.id, name: zone.name },
    });
    return { zone, changed: true };
  }, READ_COMMITTED_TX);
}

/** Thrown inside route 12's transaction to roll back a CAS that turned out to change nothing. */
class NoLinkChange extends Error {}

/** Snapshot a camera display name into `sourceLabel` (VarChar(120), cut on code points). */
function labelSnapshot(label: string): string {
  const cps = [...label];
  return cps.length <= 120 ? label : cps.slice(0, 120).join("");
}

/**
 * Route 12 — replace an area's link set.
 *
 *   1. Read the area and ALL its links (any state) outside the transaction;
 *      404 / 409 archived / 409 version before anything else.
 *   2. Diff. Nothing to do → `changed:false` (no transaction, no audit).
 *   3. Verify only the NEW refs (added + reactivated) — an existing link that
 *      went stale does not block saving the rest. Camera: a Camera row, else
 *      Frigate's config (fetched only when needed, before the transaction —
 *      it can take up to its own timeout). Part: Frigate's config. Missing →
 *      422 SOURCE_NOT_FOUND; couldn't check → 503 SOURCE_CHECK_UNAVAILABLE.
 *   4. One transaction: CAS the area version FIRST (locks the area row), then
 *      re-read and re-diff the links under that lock, apply, audit LAST.
 *      Every link write bumps the version, so a won CAS means the links are
 *      exactly what step 1 read; a re-diff that disagrees is a 409 anyway.
 *
 * DS-005: links the viewer cannot see are left exactly as they are and are
 * not in the diff; asking for a hidden camera is SOURCE_NOT_FOUND (the same
 * answer as a camera that does not exist). Manage is owner/admin, who see
 * every camera, so this is defence in depth.
 */
export async function replaceZoneLinks(
  prisma: PrismaClient,
  ctx: ZoneWriteContext,
  id: string,
  input: { links: readonly DesiredZoneLink[]; expectedVersion: number },
  sources: {
    scope: Pick<SecurityViewerScope, "visibleCameras">;
    /** `loadCameraLabels`, read by the caller before the write (it also labels the response). */
    cameraLabels: ReadonlyMap<string, string>;
    frigateConfig: () => Promise<unknown>;
  },
): Promise<{ zone: ZoneRecord; changed: boolean }> {
  const zone = await prisma.securityZone.findUnique({ where: { id }, select: ZONE_SELECT });
  if (!zone) throw notFound();
  if (zone.state !== "active") throw archived();
  if (zone.version !== input.expectedVersion) throw versionConflict();

  const hidden = input.links.filter((l) => visibleLinks([l], sources.scope).length === 0);
  if (hidden.length > 0) {
    throw new ZoneWriteError(422, "SOURCE_NOT_FOUND", "A camera to link was not found", {
      issues: hidden.map((l) => ({ sourceKind: l.sourceKind, sourceRef: l.sourceRef, status: "missing" })),
    });
  }
  const readLinks = async (client: Pick<ZoneTx, "securityZoneLink">): Promise<ExistingZoneLink[]> =>
    visibleLinks(
      await client.securityZoneLink.findMany({
        where: { zoneId: id },
        select: { id: true, sourceKind: true, sourceRef: true, state: true, origin: true, stateSetBy: true },
        orderBy: [{ sourceKind: "asc" }, { sourceRef: "asc" }],
      }),
      sources.scope,
    );
  const planned = diffZoneLinks(await readLinks(prisma), input.links);
  // Every ref that becomes active now is verified — Droplet's suggestions a person ticked included.
  const fresh: DesiredZoneLink[] = [...planned.added, ...planned.reactivated, ...planned.accepted];
  if (fresh.length === 0 && planned.removed.length === 0) return { zone, changed: false };

  const cameraRows = sources.cameraLabels;
  let frigate: Map<string, string[]> | null = null;
  const needsFrigate = fresh.some((l) => l.sourceKind !== "camera" || !cameraRows.has(l.sourceRef));
  if (needsFrigate) {
    try {
      frigate = frigatePartsFromConfig(await sources.frigateConfig());
    } catch {
      frigate = null;
    }
  }
  const catalog: SourceCatalog = { cameraRows, frigate };
  const statuses = fresh.map((l) => ({ l, status: linkSourceStatus(l, catalog) }));
  const bad = statuses.filter((s) => s.status !== "present");
  const issues = bad.map((s) => ({ sourceKind: s.l.sourceKind, sourceRef: s.l.sourceRef, status: s.status }));
  if (bad.some((s) => s.status === "missing")) {
    throw new ZoneWriteError(422, "SOURCE_NOT_FOUND", "A camera or part of a view to link was not found", { issues });
  }
  if (bad.length > 0) {
    throw new ZoneWriteError(503, "SOURCE_CHECK_UNAVAILABLE", "Couldn't check the camera system", { issues });
  }
  const verified = new Set(fresh.map(linkKey));
  const labelFor = (ref: DesiredZoneLink): string => {
    const camera = parseLinkRef(ref.sourceKind, ref.sourceRef)?.camera ?? ref.sourceRef;
    return labelSnapshot(cameraRows.get(camera) ?? camera);
  };
  const actorId = ctx.req.user?.id ?? null;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const { count } = await tx.securityZone.updateMany({
        where: { id, version: input.expectedVersion, state: "active" },
        data: { version: { increment: 1 } },
      });
      if (count !== 1) throw await casLost(tx, id, true);
      const diff = diffZoneLinks(await readLinks(tx), input.links);
      if (diff.added.length + diff.reactivated.length + diff.accepted.length + diff.removed.length === 0) throw new NoLinkChange();
      if ([...diff.added, ...diff.reactivated, ...diff.accepted].some((l) => !verified.has(linkKey(l)))) throw versionConflict();

      if (diff.added.length > 0) {
        await tx.securityZoneLink.createMany({
          data: diff.added.map((l) => ({
            zoneId: id,
            sourceKind: l.sourceKind,
            sourceRef: l.sourceRef,
            sourceLabel: labelFor(l),
            state: "active" as const,
            // WARP-2979 — a person made it: both explicit, no database default.
            origin: "person" as const,
            stateSetBy: "person" as const,
            createdById: actorId,
            stateChangedAt: ctx.now,
          })),
        });
      }
      for (const l of diff.reactivated) {
        // One row at a time: each gets its own fresh label snapshot. `removed`, or (WARP-2979) a
        // `rejected` suggestion a person now links themselves: its origin and evidence stay Droplet's.
        await tx.securityZoneLink.updateMany({
          where: { id: l.id, state: l.state },
          data: { state: "active", stateSetBy: "person", sourceLabel: labelFor(l), decidedById: actorId, stateChangedAt: ctx.now },
        });
      }
      for (const l of diff.accepted) {
        // WARP-2979 — Droplet's suggestion, ticked and saved: a person's link from now on.
        await tx.securityZoneLink.updateMany({
          where: { id: l.id, state: "proposed", origin: "droplet", stateSetBy: "droplet" },
          data: { state: "active", stateSetBy: "person", sourceLabel: labelFor(l), decidedById: actorId, stateChangedAt: ctx.now },
        });
      }
      if (diff.removed.length > 0) {
        await tx.securityZoneLink.updateMany({
          where: { id: { in: diff.removed.map((l) => l.id) }, state: "active" },
          // WARP-2979 — `removed` is always a person's (CHECK SecurityZoneLink_origin_shape),
          // including a person unticking a link Droplet activated on its own.
          data: { state: "removed", stateSetBy: "person", decidedById: actorId, stateChangedAt: ctx.now },
        });
      }
      const after = await tx.securityZone.findUnique({ where: { id }, select: ZONE_SELECT });
      if (!after) throw notFound();
      await auditSecurityInTx(tx, ctx.req, {
        action: "zone.links",
        what: `Security: changed what covers the area "${after.name}"`,
        refs: {
          zoneId: id,
          added: diff.added.map((l) => l.sourceRef),
          removed: diff.removed.map((l) => l.sourceRef),
          reactivated: diff.reactivated.map((l) => l.sourceRef),
          accepted: diff.accepted.map((l) => l.sourceRef),
        },
      });
      return after;
    }, READ_COMMITTED_TX);
    return { zone: updated, changed: true };
  } catch (err) {
    if (err instanceof NoLinkChange) return { zone, changed: false };
    throw err;
  }
}

// ── WARP-2979: a person decides on Droplet's link (routes 24, 25; §6.5) ────

export type LinkDecision = "accept" | "reject";

/** Thrown inside a decision's transaction when the area CAS lost: re-read and re-plan once. */
class DecisionCasLost extends Error {}

const linkNotFound = (): ZoneWriteError => new ZoneWriteError(404, "LINK_NOT_FOUND", "No such link");
const notDecidable = (): ZoneWriteError =>
  new ZoneWriteError(409, "LINK_NOT_DECIDABLE", "That link was set by a person or already decided; there is nothing for Droplet to ask about");

/** How the audit line names a link's view: `Back camera`, or `the "till" part of Back camera`. */
function linkPhrase(l: { sourceKind: SecurityZoneSourceKind; sourceRef: string; sourceLabel: string }, labels: ReadonlyMap<string, string>): string {
  const parsed = parseLinkRef(l.sourceKind, l.sourceRef);
  const label = stripUnsafeDisplayChars((parsed ? labels.get(parsed.camera) : undefined) ?? l.sourceLabel);
  return parsed?.frigateZone ? `the "${parsed.frigateZone}" part of ${label}` : label;
}

/**
 * Routes 24 (accept) and 25 (reject): INTENTS on the link's current state, not
 * client-versioned — a stale page must not 409 because the hourly job
 * refreshed a suggestion (the P2b mode-action rule).
 *
 *   accept: `proposed` → active, setter person ("Add it");
 *           active set by Droplet → still active, setter person ("Keep": from
 *           now on it counts for alerts and anchors further suggestions);
 *           already active and set by a person → `changed: false`, no audit.
 *   reject: `proposed` → `rejected` ("Not this");
 *           active set by Droplet → `rejected` ("Undo");
 *           already `rejected` → `changed: false`, no audit.
 *   Anything else (a person's own link, a `removed` row, accepting a
 *   rejected one) → 409 LINK_NOT_DECIDABLE: a person decides those with
 *   route 12.
 *
 * One READ_COMMITTED transaction: read the link and its area (missing, or
 * its camera hidden from the actor → 404 LINK_NOT_FOUND, one body for both;
 * archived area → 409 ZONE_ARCHIVED); CAS the area version (the area row
 * first — P2b's lock order); the guarded update `{id, state: from, origin:
 * droplet, stateSetBy: droplet}` (count 0 → LINK_NOT_DECIDABLE); accepting
 * into an area already at 32 active links → 409 LINK_LIMIT; the audit LAST.
 * A lost CAS is re-read and re-planned once, then 409 LINK_CONFLICT.
 */
export async function decideDropletLink(
  prisma: PrismaClient,
  ctx: ZoneWriteContext,
  linkId: string,
  decision: LinkDecision,
  sources: { scope: Pick<SecurityViewerScope, "visibleCameras">; cameraLabels: ReadonlyMap<string, string> },
): Promise<{ zone: ZoneRecord; changed: boolean }> {
  const actorId = ctx.req.user?.id ?? null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const link = await tx.securityZoneLink.findUnique({
          where: { id: linkId },
          select: {
            id: true,
            zoneId: true,
            sourceKind: true,
            sourceRef: true,
            sourceLabel: true,
            state: true,
            origin: true,
            stateSetBy: true,
            zone: { select: { id: true, name: true, state: true, version: true } },
          },
        });
        if (!link || visibleLinks([link], sources.scope).length === 0) throw linkNotFound();
        if (link.zone.state !== "active") throw archived();
        const droplets = link.origin === "droplet" && link.stateSetBy === "droplet";
        let from: "proposed" | "active";
        if (decision === "accept") {
          if (link.state === "active" && link.stateSetBy === "person") {
            const zone = await tx.securityZone.findUnique({ where: { id: link.zoneId }, select: ZONE_SELECT });
            if (!zone) throw linkNotFound();
            return { zone, changed: false };
          }
          if (!droplets || (link.state !== "proposed" && link.state !== "active")) throw notDecidable();
          from = link.state;
        } else {
          if (link.state === "rejected") {
            const zone = await tx.securityZone.findUnique({ where: { id: link.zoneId }, select: ZONE_SELECT });
            if (!zone) throw linkNotFound();
            return { zone, changed: false };
          }
          if (!droplets || (link.state !== "proposed" && link.state !== "active")) throw notDecidable();
          from = link.state;
        }

        const { count } = await tx.securityZone.updateMany({
          where: { id: link.zoneId, version: link.zone.version, state: "active" },
          data: { version: { increment: 1 } },
        });
        if (count !== 1) throw new DecisionCasLost();

        if (decision === "accept" && from === "proposed") {
          const active = await tx.securityZoneLink.count({ where: { zoneId: link.zoneId, state: "active" } });
          if (active >= SECURITY_ZONE_LINK_LIMIT) {
            throw new ZoneWriteError(409, "LINK_LIMIT", `An area can have at most ${SECURITY_ZONE_LINK_LIMIT} links`);
          }
        }
        const to = decision === "accept" ? "active" : "rejected";
        const updated = await tx.securityZoneLink.updateMany({
          where: { id: link.id, state: from, origin: "droplet", stateSetBy: "droplet" },
          data: { state: to, stateSetBy: "person", decidedById: actorId, stateChangedAt: ctx.now },
        });
        if (updated.count !== 1) throw notDecidable();

        const zone = await tx.securityZone.findUnique({ where: { id: link.zoneId }, select: ZONE_SELECT });
        if (!zone) throw linkNotFound();
        const phrase = linkPhrase(link, sources.cameraLabels);
        await auditSecurityInTx(
          tx,
          ctx.req,
          decision === "accept"
            ? {
                action: "link.accepted",
                what:
                  from === "proposed"
                    ? `Security: added Droplet's suggestion ${phrase} to the area "${zone.name}"`
                    : `Security: kept Droplet's link ${phrase} in the area "${zone.name}"`,
                refs: { zoneId: zone.id, linkId: link.id, sourceRef: link.sourceRef, from },
              }
            : {
                action: "link.rejected",
                what:
                  from === "proposed"
                    ? `Security: turned down Droplet's suggestion ${phrase} for the area "${zone.name}"`
                    : `Security: undid Droplet's link ${phrase} in the area "${zone.name}"`,
                refs: { zoneId: zone.id, linkId: link.id, sourceRef: link.sourceRef, from, undo: from === "active" },
              },
        );
        return { zone, changed: true };
      }, READ_COMMITTED_TX);
    } catch (err) {
      if (err instanceof DecisionCasLost) continue;
      throw err;
    }
  }
  throw new ZoneWriteError(409, "LINK_CONFLICT", "Someone else changed this area at the same moment; try again");
}

// ── WARP-2979: Droplet's open suggestions (route 23) ──────────────────────

/** One suggestion as route 23 sends it. */
export interface SecurityLinkProposalView {
  linkId: string;
  zone: { id: string; name: string; kind: SecurityZoneKind };
  sourceKind: SecurityZoneSourceKind;
  sourceRef: string;
  /** The camera's display name (never the part). */
  label: string;
  /** Wilson lower bound, 0..1. */
  confidence: number;
  /** Null unless the viewer can see every source it names (the same rule as route 3). */
  evidence: LinkEvidenceV1 | null;
  /** When the evidence behind it was computed. */
  suggestedAt: string;
}

/**
 * Every open suggestion (`proposed`, Droplet's) in an active area whose
 * camera the viewer can see, ordered: a name match first (the tiebreak
 * §6.2.4 allows on the page), then confidence, then the area and the ref.
 */
export async function listLinkProposals(
  prisma: Pick<PrismaClient, "securityZoneLink">,
  scope: Pick<SecurityViewerScope, "visibleCameras">,
  cameraLabels: ReadonlyMap<string, string>,
): Promise<SecurityLinkProposalView[]> {
  const rows = await prisma.securityZoneLink.findMany({
    where: { state: "proposed", origin: "droplet", zone: { state: "active" } },
    select: {
      id: true,
      sourceKind: true,
      sourceRef: true,
      sourceLabel: true,
      origin: true,
      evidence: true,
      confidence: true,
      evidenceAt: true,
      stateChangedAt: true,
      zone: { select: { id: true, name: true, kind: true } },
    },
  });
  const out = visibleLinks(rows, scope).map((r) => {
    const camera = parseLinkRef(r.sourceKind, r.sourceRef)?.camera;
    const evidence = evidenceFor(r, scope);
    return {
      match: evidence?.names.match ?? false,
      view: {
        linkId: r.id,
        zone: { id: r.zone.id, name: r.zone.name, kind: r.zone.kind },
        sourceKind: r.sourceKind,
        sourceRef: r.sourceRef,
        label: (camera !== undefined ? cameraLabels.get(camera) : undefined) ?? r.sourceLabel,
        confidence: r.confidence ?? 0,
        evidence,
        suggestedAt: (r.evidenceAt ?? r.stateChangedAt).toISOString(),
      } satisfies SecurityLinkProposalView,
    };
  });
  out.sort(
    (a, b) =>
      Number(b.match) - Number(a.match) ||
      b.view.confidence - a.view.confidence ||
      byString(a.view.zone.name, b.view.zone.name) ||
      byString(a.view.sourceRef, b.view.sourceRef),
  );
  return out.map((o) => o.view);
}

// ── WARP-2979: retention of Droplet's link evidence (§6.16) ───────────────

const TRIM_PAGE = 200;

/**
 * Link evidence SAMPLES are presence data (when someone stood at a door).
 * Runs in the 03:50 retention leg right after `trimSecurityEvents` and P3's
 * `trimSecurityIncidents`, with THE SAME `before` (now − 30 d): for every
 * `origin = droplet` row whose `evidence.samples` has an `anchorAt` or
 * `hitAt` before `before`, rewrite `evidence` without those samples and set
 * `samplesTrimmedBefore` to `before`. The aggregates (counts, lift,
 * confidence, the window's dates) stay: they name no moment, and they are
 * what the link was decided on. Rows are never deleted — `removed` and
 * `rejected` rows are the memory that stops re-proposals.
 *
 * In pages of 200 by id, in JS. Evidence this build cannot parse loses ALL
 * its samples (fail closed on presence data), keeping everything else. Each
 * rewrite is guarded on the `evidenceAt` it read, so a refresh by the hourly
 * job in between is never clobbered (the refresh's samples are newer). A
 * rerun is a no-op.
 */
export async function trimLinkEvidence(
  prisma: Pick<PrismaClient, "securityZoneLink">,
  before: Date,
): Promise<{ trimmed: number }> {
  const cut = before.getTime();
  const at = before.toISOString();
  let trimmed = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: Array<{ id: string; evidence: Prisma.JsonValue | null; evidenceAt: Date | null }> = await prisma.securityZoneLink.findMany({
      where: { origin: "droplet", ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, evidence: true, evidenceAt: true },
      orderBy: { id: "asc" },
      take: TRIM_PAGE,
    });
    for (const row of page) {
      const raw = row.evidence;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const samples = (raw as { samples?: unknown }).samples;
      if (!Array.isArray(samples) || samples.length === 0) continue;
      const parsed = parseLinkEvidence(raw);
      let kept: unknown[];
      if (parsed) {
        kept = parsed.samples.filter((s) => Date.parse(s.anchorAt) >= cut && Date.parse(s.hitAt) >= cut);
        if (kept.length === parsed.samples.length) continue;
      } else {
        kept = [];
      }
      const next = { ...(raw as Record<string, unknown>), samples: kept, samplesTrimmedBefore: at };
      const r = await prisma.securityZoneLink.updateMany({
        where: { id: row.id, origin: "droplet", evidenceAt: row.evidenceAt },
        data: { evidence: next as Prisma.InputJsonValue },
      });
      trimmed += r.count;
    }
    if (page.length < TRIM_PAGE) break;
    cursor = page[page.length - 1]!.id;
  }
  return { trimmed };
}
