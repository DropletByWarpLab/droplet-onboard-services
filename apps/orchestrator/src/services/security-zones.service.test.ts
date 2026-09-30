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
  evidenceFor,
  trimLinkEvidence,
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

const onlyFront = { visibleCameras: new Set(["front"]) as ReadonlySet<string> };
const everyone = { visibleCameras: "all" as const };

function link(
  zoneId: string,
  sourceKind: "camera" | "camera_zone",
  sourceRef: string,
  name = zoneId,
  setBy: "person" | "droplet" = "person",
): ActiveZoneLink {
  return { linkId: `${zoneId}:${sourceRef}`, zoneId, zoneName: name, zoneKind: "interior", sourceKind, sourceRef, setBy };
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
    ["lock", "matter:1/1"],
  ])("rejects %s %j", (kind, ref) => {
    expect(parseLinkRef(kind as "camera", ref)).toBeNull();
  });
});

describe("visibleLinks / zoneVisibleTo — DS-005 applied to places", () => {
  const links = [link("x", "camera", "front"), link("x", "camera_zone", "back/porch"), link("x", "camera", "bad/ref")];

  it("keeps a link only when its camera is granted; a malformed ref is never visible", () => {
    expect(visibleLinks(links, onlyFront).map((l) => l.sourceRef)).toEqual(["front"]);
    expect(visibleLinks(links, everyone).map((l) => l.sourceRef)).toEqual(["front", "back/porch"]);
    expect(visibleLinks(links, { visibleCameras: new Set() })).toEqual([]);
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
});

describe("diffZoneLinks — route 12's plan", () => {
  const stored: ExistingZoneLink[] = [
    { id: "1", sourceKind: "camera", sourceRef: "front", state: "active", origin: "person", stateSetBy: "person" },
    { id: "2", sourceKind: "camera_zone", sourceRef: "back/till", state: "removed", origin: "person", stateSetBy: "person" },
    { id: "3", sourceKind: "camera", sourceRef: "side", state: "active", origin: "person", stateSetBy: "person" },
    { id: "4", sourceKind: "camera", sourceRef: "old", state: "removed", origin: "person", stateSetBy: "person" },
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
      accepted: [],
      removed: [stored[2]],
    });
  });

  it("the same set is no diff; a removed row nobody asks for stays out of it", () => {
    expect(
      diffZoneLinks(stored, [
        { sourceKind: "camera", sourceRef: "front" },
        { sourceKind: "camera", sourceRef: "side" },
      ]),
    ).toEqual({ added: [], reactivated: [], accepted: [], removed: [] });
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
      { id: "l1", zoneId: "z1", sourceKind: "camera", sourceRef: "front", stateSetBy: "person", zone: { name: "Shop", kind: "entry" } },
      { id: "l2", zoneId: "z1", sourceKind: "camera", sourceRef: "back", stateSetBy: "droplet", zone: { name: "Shop", kind: "entry" } },
    ]);
    const out = await loadActiveLinks({ securityZoneLink: { findMany } } as never);
    expect(findMany.mock.calls[0][0].where).toEqual({ state: "active", zone: { state: "active" } });
    // WARP-2979 — who set the link is read, never inferred (a NULL decidedById says nothing).
    expect(findMany.mock.calls[0][0].select).toMatchObject({ stateSetBy: true });
    expect(out).toEqual([
      { linkId: "l1", zoneId: "z1", zoneName: "Shop", zoneKind: "entry", sourceKind: "camera", sourceRef: "front", setBy: "person" },
      { linkId: "l2", zoneId: "z1", zoneName: "Shop", zoneKind: "entry", sourceKind: "camera", sourceRef: "back", setBy: "droplet" },
    ]);
  });
});

describe("the sources list (route 4) and link status", () => {
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
  ] as const)("%s → %s", (_n, l, catalog, status) => {
    expect(linkSourceStatus(l, catalog)).toBe(status);
  });

  it("family sees only granted cameras, and statuses only for links it can see", () => {
    const links = [link("shop", "camera", "front"), link("shop", "camera_zone", "back/till"), link("yard", "camera", "back")];
    expect(buildSourcesView(both, links, onlyFront)).toEqual({
      frigate: "ok",
      cameras: [{ name: "front", label: "Front camera", parts: ["porch"] }],
      linkStatus: [{ linkId: "shop:front", status: "present" }],
    });
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
      origin: "person",
      stateSetBy: "person",
      evidence: null,
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
            setBy: "person",
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
      { linkId: "a1", zoneId: "za", zoneName: "Shop", zoneKind: "interior", sourceKind: "camera", sourceRef: "front", setBy: "person" },
      { linkId: "b1", zoneId: "zb", zoneName: "Till", zoneKind: "restricted", sourceKind: "camera_zone", sourceRef: "front/till", setBy: "person" },
      { linkId: "b2", zoneId: "zb", zoneName: "Till", zoneKind: "restricted", sourceKind: "camera_zone", sourceRef: "front/porch", setBy: "person" },
    ];
    expect(matchAreasForEvent({ source: "frigate", kind: "detection", camera: "front", cameraZones: ["till"] }, links)).toEqual([
      { zoneId: "za", zoneName: "Shop", zoneKind: "interior", linkIds: ["a1"], specificity: "whole", personLinked: true },
      { zoneId: "zb", zoneName: "Till", zoneKind: "restricted", linkIds: ["b1"], specificity: "part", personLinked: true },
    ]);
    // A camera's own offline row reaches every part of its view.
    expect(
      matchAreasForEvent({ source: "frigate_status", kind: "camera_offline", camera: "front", cameraZones: [] }, links).find((m) => m.zoneId === "zb"),
    ).toMatchObject({ linkIds: ["b1", "b2"], specificity: "part" });
    expect(matchAreasForEvent({ source: "activity_mirror", kind: "threat", camera: null, cameraZones: [] }, links)).toEqual([]);
  });

  // WARP-2979 (§6.7.1) — an area matched only through links Droplet activated on its own is context:
  // it still matches (so the event still groups there), but it is not person-linked.
  it("personLinked: true when ANY matching link was set by a person; false when only Droplet's links matched", () => {
    const links: ActiveZoneLink[] = [
      link("za", "camera", "front", "Shop", "droplet"),
      link("zb", "camera", "front", "Till", "droplet"),
      link("zb", "camera_zone", "front/till", "Till", "person"),
    ];
    const at = (cameraZones: string[]) =>
      matchAreasForEvent({ source: "frigate", kind: "detection", camera: "front", cameraZones }, links).map((m) => [m.zoneId, m.personLinked]);
    // za matches through Droplet's link only; zb through Droplet's whole-camera link AND a person's part.
    expect(at(["till"])).toEqual([
      ["za", false],
      ["zb", true],
    ]);
    // Away from the till only Droplet's links match zb: still grouped there, not person-linked.
    expect(at([])).toEqual([
      ["za", false],
      ["zb", false],
    ]);
  });
});

describe("buildZoneIndex — personOnly (WARP-2979: the index camera_offline_during_activity matches against)", () => {
  const links = [
    link("za", "camera", "front", "Shop", "person"),
    link("zb", "camera", "front", "Yard", "droplet"),
    link("zc", "camera_zone", "back/door", "Door", "droplet"),
    link("zd", "camera_zone", "back/door", "Stock", "person"),
  ];

  it("leaves out every link Droplet set; the default index keeps them all", () => {
    const person = buildZoneIndex(links, { personOnly: true });
    const all = buildZoneIndex(links);
    expect(zonesForEvent(row({ camera: "front" }), person)).toEqual(["za"]);
    expect(zonesForEvent(row({ camera: "front" }), all)).toEqual(["za", "zb"]);
    expect(zonesForEvent(row({ camera: "back", cameraZones: ["door"] }), person)).toEqual(["zd"]);
    expect(zonesForEvent(row({ camera: "back", cameraZones: ["door"] }), all)).toEqual(["zc", "zd"]);
  });

  it("fails closed: a link with no setBy is not a person's", () => {
    const bare = [{ zoneId: "za", sourceKind: "camera" as const, sourceRef: "front" }];
    expect(zonesForEvent(row({ camera: "front" }), buildZoneIndex(bare, { personOnly: true }))).toEqual([]);
    expect(zonesForEvent(row({ camera: "front" }), buildZoneIndex(bare))).toEqual(["za"]);
  });
});

// ── WARP-2979 (P4 §6.5, §7 route 3, §6.16) ────────────────────────────────

describe("diffZoneLinks — every cell of §6.5's table (route 12, a person's save)", () => {
  const row = (id: string, sourceRef: string, state: ExistingZoneLink["state"], origin: "person" | "droplet" = "person", stateSetBy: "person" | "droplet" = "person"): ExistingZoneLink => ({
    id,
    sourceKind: "camera",
    sourceRef,
    state,
    origin,
    stateSetBy,
  });
  const stored: ExistingZoneLink[] = [
    row("a", "active_person", "active"),
    row("b", "active_droplet", "active", "droplet", "droplet"),
    row("c", "active_kept", "active", "droplet", "person"),
    row("d", "removed", "removed"),
    row("e", "proposed", "proposed", "droplet", "droplet"),
    row("f", "rejected", "rejected", "droplet", "person"),
  ];
  const want = (...refs: string[]) => refs.map((sourceRef) => ({ sourceKind: "camera" as const, sourceRef }));

  it("in the desired set: none → added; active (any setter) → unchanged; removed → reactivated; PROPOSED → ACCEPTED; rejected → reactivated", () => {
    expect(diffZoneLinks(stored, want("new", "active_person", "active_droplet", "active_kept", "removed", "proposed", "rejected"))).toEqual({
      added: [{ sourceKind: "camera", sourceRef: "new" }],
      reactivated: [stored[3], stored[5]],
      accepted: [stored[4]],
      removed: [],
    });
  });

  it("not in the desired set: every active row → removed (Droplet's too); removed, PROPOSED and rejected → unchanged", () => {
    expect(diffZoneLinks(stored, [])).toEqual({ added: [], reactivated: [], accepted: [], removed: [stored[0], stored[1], stored[2]] });
  });
});

describe("evidenceFor — Droplet's evidence only for a viewer who can see every source it names (route 3, D13)", () => {
  const evidence = {
    v: 1,
    kind: "camera_camera",
    window: { from: "2026-09-06T09:45:00.000Z", to: "2026-09-20T09:45:00.000Z" },
    anchor: { linkId: "l-anchor", sourceKind: "camera", sourceRef: "back", label: "Back camera" },
    candidate: { sourceKind: "camera_zone", sourceRef: "front/porch", label: "Front camera" },
    forward: { n: 40, k: 34, excluded: 0, lambdaMilli: 2000, liftTenths: 170, confidenceBp: 7090 },
    reverse: { n: 45, k: 36, excluded: 1, lambdaMilli: 2700, liftTenths: 133, confidenceBp: 6620 },
    chosen: "part",
    wholeK: 35,
    names: { match: false, shared: [] },
    hypotheses: 12,
    pAdj: "1.1e-27",
    gate: "auto",
    samples: [],
    samplesTrimmedBefore: null,
  };

  it("everyone who sees both cameras gets it; a viewer missing either gets null", () => {
    expect(evidenceFor({ origin: "droplet", evidence }, everyone)).toEqual(evidence);
    expect(evidenceFor({ origin: "droplet", evidence }, { visibleCameras: new Set(["front", "back"]) })).toEqual(evidence);
    expect(evidenceFor({ origin: "droplet", evidence }, onlyFront)).toBeNull();
    expect(evidenceFor({ origin: "droplet", evidence }, { visibleCameras: new Set(["back"]) })).toBeNull();
  });

  it("null for a person's link, without a scope, for evidence that does not parse, and for a lock it names (PR-4)", () => {
    expect(evidenceFor({ origin: "person", evidence }, everyone)).toBeNull();
    expect(evidenceFor({ origin: "droplet", evidence }, null)).toBeNull();
    expect(evidenceFor({ origin: "droplet", evidence: { ...evidence, v: 2 } }, everyone)).toBeNull();
    const lock = { ...evidence, kind: "lock_camera", reverse: null, chosen: "lock", wholeK: null, anchor: { ...evidence.anchor, sourceKind: "lock", sourceRef: "matter:4/1" } };
    expect(evidenceFor({ origin: "droplet", evidence: lock }, everyone)).toBeNull();
  });
});

describe("trimLinkEvidence — samples are presence data (§6.16)", () => {
  const BEFORE = new Date("2026-08-25T03:50:00.000Z");
  const base = {
    v: 1,
    kind: "camera_camera",
    window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" },
    anchor: { linkId: "l-anchor", sourceKind: "camera", sourceRef: "back", label: "Back camera" },
    candidate: { sourceKind: "camera", sourceRef: "front", label: "Front camera" },
    forward: { n: 40, k: 34, excluded: 0, lambdaMilli: 2000, liftTenths: 170, confidenceBp: 7090 },
    reverse: { n: 45, k: 36, excluded: 1, lambdaMilli: 2700, liftTenths: 133, confidenceBp: 6620 },
    chosen: "whole",
    wholeK: null,
    names: { match: false, shared: [] },
    hypotheses: 12,
    pAdj: "1.1e-27",
    gate: "auto",
    samplesTrimmedBefore: null,
  };
  const OLD = { anchorAt: "2026-08-10T10:00:00.000Z", hitAt: "2026-08-10T10:00:03.000Z" };
  const NEW = { anchorAt: "2026-08-30T10:00:00.000Z", hitAt: "2026-08-30T10:00:03.000Z" };
  const EDGE = { anchorAt: "2026-08-25T03:49:59.999Z", hitAt: "2026-08-25T03:50:02.000Z" };

  function db(rows: Array<{ id: string; evidence: unknown; evidenceAt: Date | null }>) {
    return {
      rows,
      securityZoneLink: {
        findMany: vi.fn(async (args: { where: { id?: { gt: string } }; take: number }) =>
          rows.filter((r) => !args.where.id || r.id > args.where.id.gt).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, args.take),
        ),
        updateMany: vi.fn(async (args: { where: { id: string; evidenceAt: Date | null }; data: { evidence: unknown } }) => {
          const r = rows.find((x) => x.id === args.where.id && x.evidenceAt === args.where.evidenceAt);
          if (!r) return { count: 0 };
          r.evidence = args.data.evidence;
          return { count: 1 };
        }),
      },
    };
  }

  it("drops only the samples before `before` (either instant), keeps every aggregate, stamps samplesTrimmedBefore; a rerun is a no-op", async () => {
    const at = new Date("2026-08-15T00:00:00.000Z");
    const p = db([
      { id: "a", evidence: { ...base, samples: [NEW, EDGE, OLD] }, evidenceAt: at },
      { id: "b", evidence: { ...base, samples: [NEW] }, evidenceAt: at },
      { id: "c", evidence: { ...base, samples: [] }, evidenceAt: at },
    ]);
    expect(await trimLinkEvidence(p as never, BEFORE)).toEqual({ trimmed: 1 });
    expect(p.rows[0]!.evidence).toEqual({ ...base, samples: [NEW], samplesTrimmedBefore: BEFORE.toISOString() });
    expect(p.rows[1]!.evidence).toEqual({ ...base, samples: [NEW] });
    expect(p.securityZoneLink.findMany.mock.calls[0]![0]).toMatchObject({ where: { origin: "droplet" } });
    expect(await trimLinkEvidence(p as never, BEFORE)).toEqual({ trimmed: 0 });
  });

  it("evidence this build cannot read loses ALL its samples (fail closed on presence data), nothing else", async () => {
    const p = db([{ id: "a", evidence: { v: 9, samples: [NEW], mystery: 1 }, evidenceAt: null }]);
    expect(await trimLinkEvidence(p as never, BEFORE)).toEqual({ trimmed: 1 });
    expect(p.rows[0]!.evidence).toEqual({ v: 9, samples: [], mystery: 1, samplesTrimmedBefore: BEFORE.toISOString() });
  });

  it("never clobbers a refresh the hourly job made in between (the write is guarded on the evidenceAt it read)", async () => {
    const p = db([{ id: "a", evidence: { ...base, samples: [OLD] }, evidenceAt: new Date("2026-08-15T00:00:00.000Z") }]);
    const read = p.securityZoneLink.findMany.getMockImplementation()!;
    p.securityZoneLink.findMany.mockImplementationOnce(async (args) => {
      const out = await read(args);
      p.rows[0] = { ...p.rows[0]!, evidence: { ...base, samples: [NEW] }, evidenceAt: new Date("2026-09-01T00:00:00.000Z") };
      return out;
    });
    expect(await trimLinkEvidence(p as never, BEFORE)).toEqual({ trimmed: 0 });
    expect(p.rows[0]!.evidence).toEqual({ ...base, samples: [NEW] });
  });

  it("pages through every row, 200 at a time", async () => {
    const at = new Date("2026-08-15T00:00:00.000Z");
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}`, evidence: { ...base, samples: [OLD] }, evidenceAt: at }));
    const p = db(rows);
    expect(await trimLinkEvidence(p as never, BEFORE)).toEqual({ trimmed: 450 });
    expect(p.securityZoneLink.findMany).toHaveBeenCalledTimes(3);
  });
});
