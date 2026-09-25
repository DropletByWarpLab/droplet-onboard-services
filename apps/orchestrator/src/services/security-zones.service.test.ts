/**
 * WARP-2977 P2b (spec §6.1, §9) — the pure half of areas: link refs, who
 * sees which link and which area (DS-005), the feed clause and its in-memory
 * twin, the link diff, and the sources list.
 *
 * The SQL half of the "twin" claim — that `zoneEventWhere` selects exactly
 * the rows `zonesForEvent` matches — is a database fact, pinned on real
 * Postgres in security-zones.pg.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildSourcesView,
  buildZoneIndex,
  diffZoneLinks,
  formatLinkRef,
  frigatePartsFromConfig,
  isZoneNameCheckViolation,
  isZoneNameTaken,
  linkSourceStatus,
  loadActiveLinks,
  normaliseZoneName,
  parseLinkRef,
  toZoneView,
  viewerAreas,
  visibleLinks,
  visibleZoneViews,
  zoneEventWhere,
  zoneFilterFor,
  zoneVisibleTo,
  zonesForEvent,
  type ActiveZoneLink,
  type ExistingZoneLink,
  type SourceCatalog,
  type ZoneMatchableEvent,
  type ZoneRecord,
  matchAreasForEvent,
} from "./security-zones.service.js";

const onlyFront = { visibleCameras: new Set(["front"]) as ReadonlySet<string>, mayReadLocks: false };
const everyone = { visibleCameras: "all" as const, mayReadLocks: true };
/** WARP-2977 P2b-2: a family member granted camera `front` AND Devices (smart_home) view. */
const frontAndLocks = { ...onlyFront, mayReadLocks: true };
/** An owner/admin narrowed off Devices: every camera, no locks. */
const camerasOnly = { visibleCameras: "all" as const, mayReadLocks: false };

const LOCK_A = "matter:4660/1";
const LOCK_B = "matter:99/2";

function link(
  zoneId: string,
  sourceKind: "camera" | "camera_zone" | "lock",
  sourceRef: string,
  name = zoneId,
): ActiveZoneLink {
  return { linkId: `${zoneId}:${sourceRef}`, zoneId, zoneName: name, zoneKind: "interior", sourceKind, sourceRef };
}

function row(over: Partial<ZoneMatchableEvent> = {}): ZoneMatchableEvent {
  return { source: "frigate", kind: "detection", camera: "front", cameraZones: [], ...over };
}

describe("parseLinkRef — the one parser", () => {
  it.each([
    ["camera", "front", { camera: "front", frigateZone: null }],
    ["camera", "Cam_3-b", { camera: "Cam_3-b", frigateZone: null }],
    ["camera_zone", "back/till", { camera: "back", frigateZone: "till" }],
  ] as const)("%s %j", (kind, ref, parsed) => {
    expect(parseLinkRef(kind, ref)).toEqual(parsed);
    // Round-trip: what it parses to is stored back as exactly the same link.
    expect(formatLinkRef(parsed)).toEqual({ sourceKind: kind, sourceRef: ref });
  });

  it.each([
    ["camera", "back/till"],
    ["camera", ""],
    ["camera", "front door"],
    ["camera", "a".repeat(65)],
    ["camera_zone", "back"],
    ["camera_zone", "back/"],
    ["camera_zone", "/till"],
    ["camera_zone", "back/till/x"],
    ["camera_zone", "back/ti ll"],
    // WARP-2977 P2b-2: `lock` is a kind now — but only the canonical lock ref, and never a camera name.
    ["lock", "front"],
    ["lock", "matter:04660/1"],
    ["lock", "matter:4660/0"],
    ["lock", "matter:4660"],
    ["camera", "matter:4660/1"],
    ["camera_zone", "matter:4660/1"],
  ])("rejects %s %j", (kind, ref) => {
    expect(parseLinkRef(kind as "camera", ref)).toBeNull();
  });

  it("WARP-2977 P2b-2: lock matter:<node>/<endpoint> → {nodeId, endpointId}, and back", () => {
    expect(parseLinkRef("lock", LOCK_A)).toEqual({ nodeId: "4660", endpointId: 1 });
    expect(formatLinkRef({ nodeId: "4660", endpointId: 1 })).toEqual({ sourceKind: "lock", sourceRef: LOCK_A });
  });

  it("a kind this build does not know is malformed — never visible, never matched (fail closed)", () => {
    expect(parseLinkRef("access_point" as "camera", "ap-1")).toBeNull();
  });
});

describe("visibleLinks / zoneVisibleTo — DS-005 applied to places", () => {
  const links = [link("x", "camera", "front"), link("x", "camera_zone", "back/porch"), link("x", "camera", "bad/ref")];

  it("keeps a link only when its camera is granted; a malformed ref is never visible", () => {
    expect(visibleLinks(links, onlyFront).map((l) => l.sourceRef)).toEqual(["front"]);
    expect(visibleLinks(links, everyone).map((l) => l.sourceRef)).toEqual(["front", "back/porch"]);
    expect(visibleLinks(links, { visibleCameras: new Set(), mayReadLocks: false })).toEqual([]);
  });

  it("WARP-2977 P2b-2 (DS-019): a lock link is kept only with mayReadLocks — whatever the camera grant", () => {
    const withLock = [...links, link("x", "lock", LOCK_A), link("x", "lock", "matter:007/1")];
    expect(visibleLinks(withLock, frontAndLocks).map((l) => l.sourceRef)).toEqual(["front", LOCK_A]);
    expect(visibleLinks(withLock, onlyFront).map((l) => l.sourceRef)).toEqual(["front"]);
    expect(visibleLinks(withLock, camerasOnly).map((l) => l.sourceRef)).toEqual(["front", "back/porch"]);
    // A scope that does not say is read as "may not" (fail closed).
    expect(visibleLinks([link("x", "lock", LOCK_A)], { visibleCameras: "all" } as never)).toEqual([]);
  });

  it("an area whose every link is hidden is hidden; one with no links at all is shown", () => {
    expect(zoneVisibleTo({ id: "x" }, [link("x", "camera", "back")], [])).toBe(false);
    expect(zoneVisibleTo({ id: "x" }, [], [])).toBe(true);
    expect(zoneVisibleTo({ id: "x" }, links, [links[0]])).toBe(true);
  });
});

describe("zoneEventWhere — the feed clause for one area", () => {
  it("a whole camera matches every row that camera produced", () => {
    expect(zoneEventWhere([link("x", "camera", "front")])).toEqual({ OR: [{ camera: "front" }] });
  });

  it("parts of a view match those parts' detections AND that camera's offline/online rows", () => {
    expect(zoneEventWhere([link("x", "camera_zone", "back/till"), link("x", "camera_zone", "back/door")])).toEqual({
      OR: [
        {
          camera: "back",
          OR: [
            { kind: { in: ["detection", "detection_ongoing", "detection_low"] }, cameraZones: { hasSome: ["door", "till"] } },
            { kind: { in: ["camera_offline", "camera_online"] } },
          ],
        },
      ],
    });
  });

  it("a whole-camera link subsumes that camera's parts; arms are sorted and deduped", () => {
    expect(
      zoneEventWhere([
        link("x", "camera_zone", "front/porch"),
        link("x", "camera", "side"),
        link("x", "camera", "front"),
        link("x", "camera", "front"),
      ]),
    ).toEqual({ OR: [{ camera: "front" }, { camera: "side" }] });
  });

  it('nothing to match is the sentinel "none" — never {} and never {OR: []}', () => {
    expect(zoneEventWhere([])).toBe("none");
    expect(zoneEventWhere([link("x", "camera", "bad/ref")])).toBe("none");
    expect(zoneEventWhere([link("x", "lock", "matter:007/1")])).toBe("none");
  });

  it("WARP-2977 P2b-2: lock links match that endpoint's lock_state rows, in one sorted, deduped arm after the cameras", () => {
    expect(
      zoneEventWhere([link("x", "lock", LOCK_B), link("x", "camera", "front"), link("x", "lock", LOCK_A), link("y", "lock", LOCK_A)]),
    ).toEqual({ OR: [{ camera: "front" }, { source: "matter_lock", sourceRef: { in: [LOCK_A, LOCK_B] } }] });
    expect(zoneEventWhere([link("x", "lock", LOCK_A)])).toEqual({
      OR: [{ source: "matter_lock", sourceRef: { in: [LOCK_A] } }],
    });
  });
});

describe("zonesForEvent — the in-memory twin", () => {
  const index = buildZoneIndex([
    link("shop", "camera", "front"),
    link("shop", "camera_zone", "back/porch"),
    link("yard", "camera", "back"),
    link("till", "camera_zone", "back/till"),
    link("till", "camera_zone", "back/till"), // a duplicate never doubles an id
  ]);

  it("a row can sit in several areas; ids come back sorted", () => {
    expect(zonesForEvent(row({ camera: "back", cameraZones: ["porch", "till"] }), index)).toEqual([
      "shop",
      "till",
      "yard",
    ]);
  });

  it("a part matches only detections in that part — other Frigate zones do not", () => {
    expect(zonesForEvent(row({ camera: "back", cameraZones: ["gate"] }), index)).toEqual(["yard"]);
    expect(zonesForEvent(row({ camera: "back", kind: "detection_low", cameraZones: ["till"] }), index)).toEqual([
      "till",
      "yard",
    ]);
  });

  it("WARP-2978 PR-D — a person's still-in-view row lands in the same areas as their detection", () => {
    // Otherwise it would group (and alert) somewhere other than the `end` row it precedes.
    for (const cameraZones of [["till"], ["gate"], [], ["porch", "till"]]) {
      expect(zonesForEvent(row({ camera: "back", kind: "detection_ongoing", cameraZones }), index)).toEqual(
        zonesForEvent(row({ camera: "back", kind: "detection", cameraZones }), index),
      );
    }
    expect(zonesForEvent(row({ camera: "back", kind: "detection_ongoing", cameraZones: ["till"] }), index)).toEqual([
      "till",
      "yard",
    ]);
  });

  it("a camera's offline/online rows belong to every area watching any part of it", () => {
    for (const kind of ["camera_offline", "camera_online"] as const) {
      expect(zonesForEvent(row({ source: "frigate_status", kind, camera: "back" }), index)).toEqual([
        "shop",
        "till",
        "yard",
      ]);
    }
  });

  it("site-wide rows never match an area", () => {
    expect(zonesForEvent(row({ source: "activity_mirror", kind: "threat", camera: null }), index)).toEqual([]);
    expect(zonesForEvent(row({ source: "frigate_status", kind: "source_offline", camera: null }), index)).toEqual([]);
    expect(zonesForEvent(row({ source: "site_mode", kind: "mode_changed", camera: null }), index)).toEqual([]);
  });

  it("an unlinked camera matches nothing", () => {
    expect(zonesForEvent(row({ camera: "side", cameraZones: ["porch"] }), index)).toEqual([]);
  });

  it("WARP-2977 P2b-2: a lock row belongs to the areas its endpoint is linked to — by sourceRef, exactly", () => {
    const withLocks = buildZoneIndex([
      link("shop", "camera", "front"),
      link("door", "lock", LOCK_A),
      link("shop", "lock", LOCK_A),
      link("gate", "lock", LOCK_B),
    ]);
    const lockRow = (sourceRef?: string) => row({ source: "matter_lock", kind: "lock_state", camera: null, sourceRef });
    expect(zonesForEvent(lockRow(LOCK_A), withLocks)).toEqual(["door", "shop"]);
    expect(zonesForEvent(lockRow(LOCK_B), withLocks)).toEqual(["gate"]);
    expect(zonesForEvent(lockRow("matter:4660/2"), withLocks)).toEqual([]);
    // Without its sourceRef a lock row matches nothing; a camera row never matches a lock link.
    expect(zonesForEvent(lockRow(undefined), withLocks)).toEqual([]);
    expect(zonesForEvent(row({ camera: "front", sourceRef: LOCK_A }), withLocks)).toEqual(["shop"]);
  });
});

describe("viewerAreas / zoneFilterFor — what one viewer's feed resolves", () => {
  const all = [
    link("shop", "camera", "front", "Shop floor"),
    link("shop", "camera_zone", "back/porch", "Shop floor"),
    link("yard", "camera", "back", "Yard"),
  ];

  it("names and indexes only visible areas, through their visible links only", () => {
    const areas = viewerAreas(all, onlyFront);
    expect([...areas.names]).toEqual([["shop", "Shop floor"]]);
    expect(zonesForEvent(row({ camera: "back", cameraZones: ["porch"] }), areas.index)).toEqual([]);
    expect(zonesForEvent(row({ camera: "front" }), areas.index)).toEqual(["shop"]);
  });

  it('a hidden, unknown or unlinked area filters to "none"; a partly visible one to its visible links', () => {
    expect(zoneFilterFor(all, "yard", onlyFront)).toBe("none");
    expect(zoneFilterFor(all, "nope", everyone)).toBe("none");
    expect(zoneFilterFor(all, "shop", onlyFront)).toEqual({ OR: [{ camera: "front" }] });
  });

  it("WARP-2977 P2b-2: an area made only of locks is hidden without Devices view, and its lock links never leak into another's", () => {
    const withLocks = [...all, link("door", "lock", LOCK_A, "Back door"), link("shop", "lock", LOCK_B, "Shop floor")];
    const noLocks = viewerAreas(withLocks, camerasOnly);
    expect([...noLocks.names.keys()].sort()).toEqual(["shop", "yard"]);
    expect(zoneFilterFor(withLocks, "door", camerasOnly)).toBe("none");
    expect(zoneFilterFor(withLocks, "shop", camerasOnly)).toEqual({ OR: [{ camera: "front" }, { camera: "back", OR: expect.any(Array) }] });
    const lockRow = row({ source: "matter_lock", kind: "lock_state", camera: null, sourceRef: LOCK_B });
    expect(zonesForEvent(lockRow, noLocks.index)).toEqual([]);

    const locks = viewerAreas(withLocks, everyone);
    expect([...locks.names.keys()].sort()).toEqual(["door", "shop", "yard"]);
    expect(zonesForEvent(lockRow, locks.index)).toEqual(["shop"]);
    expect(zoneFilterFor(withLocks, "door", frontAndLocks)).toEqual({
      OR: [{ source: "matter_lock", sourceRef: { in: [LOCK_A] } }],
    });
  });
});

describe("diffZoneLinks — route 12's plan", () => {
  const stored: ExistingZoneLink[] = [
    { id: "1", sourceKind: "camera", sourceRef: "front", state: "active" },
    { id: "2", sourceKind: "camera_zone", sourceRef: "back/till", state: "removed" },
    { id: "3", sourceKind: "camera", sourceRef: "side", state: "active" },
    { id: "4", sourceKind: "camera", sourceRef: "old", state: "removed" },
  ];

  it("new → added, removed-and-asked-again → reactivated, active-and-dropped → removed", () => {
    expect(
      diffZoneLinks(stored, [
        { sourceKind: "camera", sourceRef: "front" },
        { sourceKind: "camera_zone", sourceRef: "back/till" },
        { sourceKind: "camera_zone", sourceRef: "back/door" },
        { sourceKind: "camera_zone", sourceRef: "back/door" },
      ]),
    ).toEqual({
      added: [{ sourceKind: "camera_zone", sourceRef: "back/door" }],
      reactivated: [stored[1]],
      removed: [stored[2]],
    });
  });

  it("the same set is no diff; a removed row nobody asks for stays out of it", () => {
    expect(
      diffZoneLinks(stored, [
        { sourceKind: "camera", sourceRef: "front" },
        { sourceKind: "camera", sourceRef: "side" },
      ]),
    ).toEqual({ added: [], reactivated: [], removed: [] });
  });

  it("the same name as a different kind is a different link", () => {
    expect(diffZoneLinks(stored, [{ sourceKind: "camera_zone", sourceRef: "front/porch" }]).added).toEqual([
      { sourceKind: "camera_zone", sourceRef: "front/porch" },
    ]);
  });
});

describe("loadActiveLinks", () => {
  it("asks for active links of ACTIVE areas only, and flattens the area onto each link", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "l1", zoneId: "z1", sourceKind: "camera", sourceRef: "front", zone: { name: "Shop", kind: "entry" } },
    ]);
    const out = await loadActiveLinks({ securityZoneLink: { findMany } } as never);
    expect(findMany.mock.calls[0][0].where).toEqual({ state: "active", zone: { state: "active" } });
    expect(out).toEqual([
      { linkId: "l1", zoneId: "z1", zoneName: "Shop", zoneKind: "entry", sourceKind: "camera", sourceRef: "front" },
    ]);
  });
});

describe("the sources list (route 4) and link status", () => {
  const LOCKS = new Map([
    [LOCK_A, { ref: LOCK_A, nodeId: "4660", endpointId: 1, label: "Back door lock", room: "Hall", connected: true }],
    [LOCK_B, { ref: LOCK_B, nodeId: "99", endpointId: 2, label: "Annex lock", room: null, connected: false }],
  ]);
  const both: SourceCatalog = {
    cameraRows: new Map([
      ["front", "Front camera"],
      ["back", "Back camera"],
    ]),
    frigate: new Map([
      ["front", ["porch"]],
      ["back", ["door", "till"]],
      ["side", []],
    ]),
    locks: LOCKS,
  };

  it("frigatePartsFromConfig: camera → zone keys that pass FRIGATE_NAME, sorted; no cameras map = unreadable", () => {
    const parts = frigatePartsFromConfig({
      cameras: {
        back: { zones: { till: {}, door: {}, "bad zone": {} } },
        front: {},
        "bad cam": { zones: { a: {} } },
      },
    });
    expect([...parts]).toEqual([
      ["back", ["door", "till"]],
      ["front", []],
    ]);
    expect(() => frigatePartsFromConfig({})).toThrow();
    expect(() => frigatePartsFromConfig(null)).toThrow();
  });

  it.each([
    ["a camera row", { sourceKind: "camera", sourceRef: "back" }, both, "present"],
    ["a camera only Frigate knows", { sourceKind: "camera", sourceRef: "side" }, both, "present"],
    ["a camera neither half knows", { sourceKind: "camera", sourceRef: "cam3" }, both, "missing"],
    ["a camera row, Frigate down", { sourceKind: "camera", sourceRef: "back" }, { ...both, frigate: null }, "present"],
    ["an unknown camera, Frigate down", { sourceKind: "camera", sourceRef: "cam3" }, { ...both, frigate: null }, "unknown"],
    ["an unknown camera, rows unreadable", { sourceKind: "camera", sourceRef: "cam3" }, { ...both, cameraRows: null }, "unknown"],
    ["a part Frigate has", { sourceKind: "camera_zone", sourceRef: "back/till" }, both, "present"],
    ["a part that was removed", { sourceKind: "camera_zone", sourceRef: "back/gate" }, both, "missing"],
    ["a part of a camera Frigate lost", { sourceKind: "camera_zone", sourceRef: "cam3/till" }, both, "missing"],
    ["a part, Frigate down", { sourceKind: "camera_zone", sourceRef: "back/till" }, { ...both, frigate: null }, "unknown"],
    ["a paired lock", { sourceKind: "lock", sourceRef: LOCK_A }, both, "present"],
    ["a paired lock that is not reporting", { sourceKind: "lock", sourceRef: LOCK_B }, both, "present"],
    ["a lock the smart-home service no longer lists", { sourceKind: "lock", sourceRef: "matter:1/1" }, both, "missing"],
    ["a lock, smart-home service unreachable", { sourceKind: "lock", sourceRef: LOCK_A }, { ...both, locks: null }, "unknown"],
    ["a lock ref that is not canonical", { sourceKind: "lock", sourceRef: "matter:04660/1" }, both, "missing"],
  ] as const)("%s → %s", (_n, l, catalog, status) => {
    expect(linkSourceStatus(l, catalog)).toBe(status);
  });

  it("family sees only granted cameras, and statuses only for links it can see", () => {
    const links = [
      link("shop", "camera", "front"),
      link("shop", "camera_zone", "back/till"),
      link("yard", "camera", "back"),
      link("shop", "lock", LOCK_A),
    ];
    expect(buildSourcesView(both, links, onlyFront)).toEqual({
      frigate: "ok",
      cameras: [{ name: "front", label: "Front camera", parts: ["porch"] }],
      linkStatus: [{ linkId: "shop:front", status: "present" }],
      locks: { state: "hidden", items: [] },
    });
  });

  it("WARP-2977 P2b-2: with Devices view the locks half lists every paired lock endpoint, sorted by label, and lock links get a status", () => {
    const view = buildSourcesView(both, [link("shop", "lock", LOCK_A), link("gate", "lock", "matter:1/1")], frontAndLocks);
    expect(view.locks).toEqual({
      state: "ok",
      items: [
        { ref: LOCK_B, nodeId: "99", endpointId: 2, label: "Annex lock", room: null, connected: false },
        { ref: LOCK_A, nodeId: "4660", endpointId: 1, label: "Back door lock", room: "Hall", connected: true },
      ],
    });
    expect(view.linkStatus).toEqual([
      { linkId: "shop:" + LOCK_A, status: "present" },
      { linkId: "gate:matter:1/1", status: "missing" },
    ]);
  });

  it("WARP-2977 P2b-2: the smart-home service unreachable → the locks half is unavailable (never an empty 'no locks'), lock links unknown", () => {
    const view = buildSourcesView({ ...both, locks: null }, [link("shop", "lock", LOCK_A)], everyone);
    expect(view.locks).toEqual({ state: "unavailable", items: [] });
    expect(view.linkStatus).toEqual([{ linkId: "shop:" + LOCK_A, status: "unknown" }]);
    // …and the camera half is untouched by it.
    expect(view.frigate).toBe("ok");
  });

  it("owner: every camera from either half, labelled, sorted by label; degrades per half", () => {
    const view = buildSourcesView(both, [], everyone);
    expect(view.cameras.map((c) => [c.name, c.label, c.parts])).toEqual([
      ["back", "Back camera", ["door", "till"]],
      ["front", "Front camera", ["porch"]],
      ["side", "side", []],
    ]);
    const noFrigate = buildSourcesView({ ...both, frigate: null }, [link("z", "camera_zone", "back/till")], everyone);
    expect(noFrigate.frigate).toBe("unavailable");
    expect(noFrigate.cameras.map((c) => c.parts)).toEqual([[], []]);
    expect(noFrigate.linkStatus).toEqual([{ linkId: "z:back/till", status: "unknown" }]);
  });
});

describe("the areas list (route 3)", () => {
  const at = new Date("2026-09-23T10:00:00Z");
  const zone = (id: string, refs: Array<["camera" | "camera_zone", string]>): ZoneRecord => ({
    id,
    name: id,
    kind: "entry",
    state: "active",
    version: 2,
    links: refs.map(([sourceKind, sourceRef], i) => ({
      id: `${id}-${i}`,
      sourceKind,
      sourceRef,
      sourceLabel: `snapshot of ${sourceRef}`,
      state: "active",
      stateChangedAt: at,
    })),
  });

  it("hides an all-hidden area, keeps a zero-link one, and shows only visible links", () => {
    const views = visibleZoneViews(
      [zone("both", [["camera", "front"], ["camera_zone", "back/till"]]), zone("backOnly", [["camera", "back"]]), zone("none", [])],
      onlyFront,
      new Map([["front", "Front camera"]]),
    );
    expect(views.map((v) => [v.id, v.links.map((l) => l.sourceRef)])).toEqual([
      ["both", ["front"]],
      ["none", []],
    ]);
  });

  it("label is the live camera name, else the snapshot — never the part", () => {
    const view = toZoneView(
      zone("z", [["camera_zone", "back/till"], ["camera", "cam3"]]),
      zone("z", [["camera_zone", "back/till"], ["camera", "cam3"]]).links,
      new Map([["back", "Back camera"]]),
    );
    expect(view.links.map((l) => l.label)).toEqual(["Back camera", "snapshot of cam3"]);
    expect(view.links[0].stateChangedAt).toBe(at.toISOString());
  });

  it("WARP-2977 P2b-2: a lock link's label is the lock's current name, else the snapshot taken when it was linked", () => {
    const z: ZoneRecord = {
      ...zone("z", []),
      links: [
        { id: "l1", sourceKind: "lock", sourceRef: LOCK_A, sourceLabel: "Smart Lock", state: "active", stateChangedAt: at },
        { id: "l2", sourceKind: "lock", sourceRef: LOCK_B, sourceLabel: "Old gate lock", state: "active", stateChangedAt: at },
      ],
    };
    const view = toZoneView(z, z.links, new Map(), new Map([[LOCK_A, "Back door lock"]]));
    expect(view.links.map((l) => l.label)).toEqual(["Back door lock", "Old gate lock"]);
  });

  it("WARP-2977 P2b-2: an area made only of locks is hidden from a viewer without Devices view", () => {
    const lockOnly: ZoneRecord = {
      ...zone("door", []),
      links: [{ id: "l1", sourceKind: "lock", sourceRef: LOCK_A, sourceLabel: "Back door lock", state: "active", stateChangedAt: at }],
    };
    expect(visibleZoneViews([lockOnly], camerasOnly, new Map()).map((v) => v.id)).toEqual([]);
    expect(visibleZoneViews([lockOnly], everyone, new Map()).map((v) => v.id)).toEqual(["door"]);
  });
});

describe("normaliseZoneName", () => {
  it("trims every kind of edge whitespace (wider than Postgres btrim) and counts code points", () => {
    expect(normaliseZoneName("  Stock room  ")).toBe("Stock room");
    expect(normaliseZoneName("🚪".repeat(60))).toBe("🚪".repeat(60));
    expect(normaliseZoneName("a".repeat(60))).toBe("a".repeat(60));
  });

  it.each([
    ["empty after trim", "   "],
    ["61 characters", "a".repeat(61)],
    ["a tab", "Front\tdoor"],
    ["a newline", "Front\ndoor"],
    ["a line separator", "Front door"],
    ["U+0000", "Front\u0000door"],
    ["a lone surrogate", "Front\ud800door"],
  ])("refuses %s", (_n, raw) => {
    expect(normaliseZoneName(raw)).toBeNull();
  });

  // Z1: names that read as something else, or as nothing.
  const BIDI = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
  it.each([...BIDI, ...ZERO_WIDTH].map((c) => [`U+${c.toString(16).toUpperCase().padStart(4, "0")}`, String.fromCodePoint(c)]))(
    "refuses %s anywhere — inside, leading or trailing (never quietly trimmed away)",
    (_n, ch) => {
      expect(normaliseZoneName(`Stock${ch}room`)).toBeNull();
      expect(normaliseZoneName(`${ch}Stock room`)).toBeNull();
      expect(normaliseZoneName(`Stock room${ch}`)).toBeNull();
    },
  );

  it.each([
    ["a no-break space", "\u00A0"],
    ["an ideographic space", "\u3000"],
    ["the Hangul filler (a letter that renders as nothing)", "\u3164\u3164"],
    ["a lone combining mark", "\u0301"],
    ["left-to-right marks", "\u200E\u200E"],
    ["a soft hyphen", "\u00AD"],
  ])("refuses a name with no visible character: %s", (_n, raw) => {
    expect(normaliseZoneName(raw)).toBeNull();
  });

  it.each([
    ["Caf\u00E9"],
    ["\u0130stanbul"],
    ["\u05DE\u05D7\u05E1\u05DF (right-to-left script, no controls)"],
    ["Stock room 2"],
    ["\u{1F6AA} Back door"],
    ["\u2764\uFE0F Kitchen (an emoji with the VS16 iOS types)"],
  ])("still accepts %s", (raw) => {
    expect(normaliseZoneName(`  ${raw} `)).toBe(raw);
  });

  // The deny-list was the gap: the whole \p{Cf} class, plus the blanks that are not Cf.
  it.each([
    ["a soft hyphen inside", "Front do\u00ADor"],
    ["a TAG-block suffix (text only a model can read)", `Front door${String.fromCodePoint(0xe0069, 0xe0067, 0xe006e)}`],
    ["an invisible times U+2062", "Front\u2062door"],
    ["a left-to-right mark inside", "Front\u200E door"],
    ["a right-to-left mark trailing", "Front door\u200F"],
    ["an Arabic letter mark", "Front\u061C door"],
    ["the Mongolian vowel separator", "Front\u180Edoor"],
    ["a combining grapheme joiner", "Front\u034F door"],
    ["a Hangul filler inside", "Front\u3164door"],
    ["a halfwidth Hangul filler inside", "Front\uFFA0door"],
    ["the Braille blank alone", "\u2800"],
    ["the Braille blank inside", "Front\u2800door"],
  ])("refuses %s", (_n, raw) => {
    expect(normaliseZoneName(raw)).toBeNull();
  });

  it("stores the NFC form, so an NFD 'Cafe\u0301' is the same name as the NFC 'Caf\u00E9'", () => {
    expect(normaliseZoneName("Cafe\u0301")).toBe("Caf\u00E9");
    expect(normaliseZoneName("Cafe\u0301 room")).toBe(normaliseZoneName("Caf\u00E9 room"));
  });

  it("makes every run of space characters one plain space, so 'Front  door' is 'Front door'", () => {
    expect(normaliseZoneName("Front  door")).toBe("Front door");
    expect(normaliseZoneName("Front\u00A0door")).toBe("Front door");
    expect(normaliseZoneName("Front \u3000 door")).toBe("Front door");
  });
});

describe("Prisma error shapes the writes map", () => {
  it("a unique violation on nameKey, from the model API or raw SQL", () => {
    expect(isZoneNameTaken({ code: "P2002", meta: { target: ["nameKey"] } })).toBe(true);
    expect(isZoneNameTaken({ code: "P2002", meta: { target: "SecurityZone_nameKey_key" } })).toBe(true);
    expect(isZoneNameTaken({ code: "P2010", meta: { code: "23505", message: 'Key ("nameKey")=(x) already exists.' } })).toBe(true);
    expect(isZoneNameTaken({ code: "P2002", meta: { target: ["zoneId", "sourceKind", "sourceRef"] } })).toBe(false);
    expect(isZoneNameTaken(new Error("boom"))).toBe(false);
  });

  it("the name CHECK, from the model API or raw SQL — and no other CHECK", () => {
    expect(
      isZoneNameCheckViolation({
        message: 'new row for relation "SecurityZone" violates check constraint "SecurityZone_name_key"',
      }),
    ).toBe(true);
    expect(
      isZoneNameCheckViolation({
        code: "P2010",
        meta: { code: "23514", message: 'violates check constraint "SecurityZone_name_key"' },
      }),
    ).toBe(true);
    expect(isZoneNameCheckViolation({ message: 'violates check constraint "SecurityZoneLink_ref"' })).toBe(false);
  });
});

// ── WARP-2978 (ADR-059 P3 §6.2): the engine's matcher agrees with the feed's ──

describe("matchAreasForEvent — exactly zonesForEvent's rules, plus the rank inputs", () => {
  /** Deterministic PRNG (mulberry32): a failure reproduces from its seed. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const CAMS = ["c1", "c2", "c3"];
  const PARTS = ["porch", "drive", "yard", "till"];
  const KINDS = [
    "detection",
    "detection_ongoing",
    "detection_low",
    "camera_offline",
    "camera_online",
    "source_offline",
    "threat",
    "mode_changed",
  ] as const;
  const ZONES = ["z1", "z2", "z3", "z4"];

  it("agrees on zone ids with zonesForEvent over 200 generated events × random link sets", () => {
    const r = rng(2978);
    for (let round = 0; round < 20; round++) {
      const links: ActiveZoneLink[] = [];
      for (const zoneId of ZONES) {
        const n = Math.floor(r() * 4);
        for (let k = 0; k < n; k++) {
          const camera = pick(r, CAMS);
          const whole = r() < 0.4;
          links.push({
            linkId: `${zoneId}-${round}-${k}`,
            zoneId,
            zoneName: zoneId,
            zoneKind: "interior",
            sourceKind: whole ? "camera" : "camera_zone",
            sourceRef: whole ? camera : `${camera}/${pick(r, PARTS)}`,
          });
        }
      }
      const index = buildZoneIndex(links);
      for (let e = 0; e < 10; e++) {
        const kind = pick(r, KINDS);
        const siteWide = kind === "source_offline" || kind === "threat" || kind === "mode_changed";
        const row = {
          source: "frigate" as const,
          kind,
          camera: siteWide ? null : pick(r, CAMS),
          cameraZones: PARTS.filter(() => r() < 0.3),
        };
        const got = matchAreasForEvent(row, links).map((m) => m.zoneId);
        expect(got, JSON.stringify({ row, links })).toEqual(zonesForEvent(row, index));
      }
    }
  });

  it("carries the matched link ids and 'part' when a part-of-view link matched", () => {
    const links: ActiveZoneLink[] = [
      { linkId: "a1", zoneId: "za", zoneName: "Shop", zoneKind: "interior", sourceKind: "camera", sourceRef: "front" },
      { linkId: "b1", zoneId: "zb", zoneName: "Till", zoneKind: "restricted", sourceKind: "camera_zone", sourceRef: "front/till" },
      { linkId: "b2", zoneId: "zb", zoneName: "Till", zoneKind: "restricted", sourceKind: "camera_zone", sourceRef: "front/porch" },
    ];
    expect(matchAreasForEvent({ source: "frigate", kind: "detection", camera: "front", cameraZones: ["till"] }, links)).toEqual([
      { zoneId: "za", zoneName: "Shop", zoneKind: "interior", linkIds: ["a1"], specificity: "whole" },
      { zoneId: "zb", zoneName: "Till", zoneKind: "restricted", linkIds: ["b1"], specificity: "part" },
    ]);
    // A camera's own offline row reaches every part of its view.
    expect(
      matchAreasForEvent({ source: "frigate_status", kind: "camera_offline", camera: "front", cameraZones: [] }, links).find((m) => m.zoneId === "zb"),
    ).toMatchObject({ linkIds: ["b1", "b2"], specificity: "part" });
    expect(matchAreasForEvent({ source: "activity_mirror", kind: "threat", camera: null, cameraZones: [] }, links)).toEqual([]);
  });
});
