/**
 * WARP-2979 (ADR-059 P4 §6.3, §6.6, §6.15, §9) — Droplet's hourly link
 * proposals, over an in-memory store with the shared transaction seam (a
 * throw rolls the area back). Every row of §6.3's decision table, the
 * settings, the caps, the lost CAS, the audit order, the anchors, the budget
 * and the rotation, and the `links` health row.
 *
 * The co-occurrence numbers themselves are lib/security-cooccurrence.test.ts's;
 * here a "linked" camera sees a person 2 s after every one of the anchor's
 * visits, which passes `auto` both ways by a wide margin.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const audit = vi.hoisted(() => ({
  calls: [] as Array<{ action: string; what: string; refs: Record<string, unknown> }>,
  fail: false,
  log: null as string[] | null,
}));
vi.mock("./security-audit.js", async (orig) => {
  const real = await orig<typeof import("./security-audit.js")>();
  return {
    ...real,
    auditSecuritySystemInTx: vi.fn(async (_tx: unknown, entry: { action: string; what: string; refs?: Record<string, unknown> }) => {
      real.securityRefs({ ...(entry.refs ?? {}) }); // the real refs rules (integers only)
      if (audit.fail) throw new real.SecurityAuditUnavailableError(new Error("chain down"));
      audit.calls.push({ action: entry.action, what: entry.what, refs: entry.refs ?? {} });
      audit.log?.push(`audit:${entry.action}`);
      return { id: BigInt(audit.calls.length) };
    }),
  };
});

import {
  LINK_HEALTH_STALE_MS,
  MAX_NEW_LINK_ROWS_PER_RUN,
  planLinkChanges,
  MAX_OPEN_SUGGESTIONS_PER_AREA,
  SECURITY_LINK_INTERVAL_MS,
  SECURITY_LINK_LOCK_KEY,
  _resetLinkHealthForTests,
  linkHealthRow,
  linkHealthState,
  registerSecurityLinkJobs,
  runSecurityLinkProposals,
  securityLinksHealth,
  tickSecurityLinkProposals,
  type LinkHealthState,
} from "./security-link-proposals.service.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";
import { LINK_RULES_VERSION, type PairCandidateResult } from "../lib/security-cooccurrence.js";
import { parseLinkEvidence } from "../lib/security-link-evidence.js";
import { LOCK_BASELINE_KEY_MARK } from "../lib/security-lock-changes.js";
import { lockDedupeKey, type LockReading } from "./security-lock-adapter.js";

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = new Date(Date.UTC(2026, 8, 24, 14, 0, 0));
const FROM = NOW.getTime() - 14 * DAY;

type State = "active" | "removed" | "proposed" | "rejected";
type Actor = "person" | "droplet";

interface Link {
  id: string;
  zoneId: string;
  sourceKind: "camera" | "camera_zone" | "lock";
  sourceRef: string;
  sourceLabel: string;
  state: State;
  origin: Actor;
  stateSetBy: Actor;
  evidence: unknown;
  confidence: number | null;
  rulesVersion: number | null;
  evidenceAt: Date | null;
  createdById: string | null;
  decidedById: string | null;
  stateChangedAt: Date;
}
interface Zone {
  id: string;
  name: string;
  state: "active" | "archived";
  version: number;
}
interface Ev {
  kind: string;
  camera: string | null;
  labels: string[];
  cameraZones: string[];
  startedAt: Date;
  endedAt: Date | null;
}
/** A `lock_state` row (P2b-2). */
interface LockEv {
  sourceRef: string;
  labels: string[];
  observed: "live" | "polled";
  dedupeKey: string;
  startedAt: Date;
}
interface World {
  settings: { linking: "link_and_suggest" | "suggest_only" | "off"; summaries: "on" | "off"; version: number } | null;
  zones: Zone[];
  links: Link[];
  events: Ev[];
  /** WARP-2979 PR-4 — lock_state rows. */
  locks?: LockEv[];
  cameras: Array<{ name: string; displayName: string; enabled: boolean }>;
  log: string[];
  updateWheres: unknown[];
}

let seq = 0;
function link(zoneId: string, sourceRef: string, over: Partial<Link> = {}): Link {
  seq += 1;
  const droplet = over.origin === "droplet";
  return {
    id: `l${String(seq).padStart(3, "0")}`,
    zoneId,
    sourceKind: sourceRef.startsWith("matter:") ? "lock" : sourceRef.includes("/") ? "camera_zone" : "camera",
    sourceRef,
    sourceLabel: sourceRef,
    state: "active",
    origin: "person",
    stateSetBy: "person",
    evidence: droplet ? { v: 1 } : null,
    confidence: droplet ? 0.5 : null,
    rulesVersion: droplet ? 1 : null,
    evidenceAt: droplet ? new Date(NOW.getTime() - 5 * DAY) : null,
    createdById: droplet ? null : "u-owner",
    decidedById: null,
    stateChangedAt: new Date(NOW.getTime() - 20 * DAY),
    ...over,
  };
}

const person = (camera: string, at: number, zones: string[] = []): Ev => ({
  kind: "detection",
  camera,
  labels: ["person"],
  cameraZones: zones,
  startedAt: new Date(at),
  endedAt: new Date(at + 4 * S),
});

/**
 * `visits` visits of the anchor camera, 3 h apart; every camera in `linked`
 * sees someone 2 s later (and, `lateBy`, some of them only in a part).
 */
function traffic(anchor: string, linked: string[], visits = 40, opts: { only?: Record<string, number> } = {}): Ev[] {
  const out: Ev[] = [];
  for (let i = 0; i < visits; i += 1) {
    const t = FROM + 2 * H + i * (3 * H + 7 * MIN);
    out.push(person(anchor, t));
    for (const cam of linked) if (i < (opts.only?.[cam] ?? visits)) out.push(person(cam, t + 2 * S));
  }
  return out;
}

function world(over: Partial<World> = {}): World {
  return {
    settings: { linking: "link_and_suggest", summaries: "on", version: 0 },
    zones: [{ id: "z-stock", name: "Stock room", state: "active", version: 5 }],
    links: [link("z-stock", "cam_a")],
    events: traffic("cam_a", ["cam_b"]),
    cameras: [
      { name: "cam_a", displayName: "Stock cam A", enabled: true },
      { name: "cam_b", displayName: "Stock cam B", enabled: true },
      { name: "cam_c", displayName: "Yard camera", enabled: true },
    ],
    log: [],
    updateWheres: [],
    ...over,
  };
}

/** Just enough of Prisma for the job's queries, plus the shared transaction seam. */
function fake(w: World) {
  const inRange = (d: Date, r: { gte: Date; lte: Date }) => d >= r.gte && d <= r.lte;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const self: any = {
    securityAiSettings: {
      findUnique: vi.fn(async () => (w.settings ? { ...w.settings } : null)),
      createMany: vi.fn(async () => {
        if (!w.settings) w.settings = { linking: "link_and_suggest", summaries: "on", version: 0 };
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ ...w.settings! })),
    },
    securitySiteHours: { findUnique: vi.fn(async () => null) },
    securityZoneLink: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: vi.fn(async (args: any) => {
        const where = args.where;
        if (where.zoneId?.in) {
          return w.links.filter((l) => where.zoneId.in.includes(l.zoneId)).map((l) => ({ ...l }));
        }
        // the anchors query
        return w.links
          .filter(
            (l) =>
              // An absent filter matches any value, as Prisma's does (a dropped `stateSetBy` must widen, not empty, the anchors).
              (where.state === undefined || l.state === where.state) &&
              (where.stateSetBy === undefined || l.stateSetBy === where.stateSetBy) &&
              where.sourceKind.in.includes(l.sourceKind) &&
              w.zones.find((z) => z.id === l.zoneId)?.state === where.zone.state,
          )
          .sort((a, b) => (a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : a.sourceRef < b.sourceRef ? -1 : 1))
          .map((l) => {
            const z = w.zones.find((zz) => zz.id === l.zoneId)!;
            return { ...l, zone: { name: z.name, version: z.version } };
          });
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createMany: vi.fn(async ({ data }: any) => {
        for (const d of data) {
          if (w.links.some((l) => l.zoneId === d.zoneId && l.sourceKind === d.sourceKind && l.sourceRef === d.sourceRef)) {
            throw Object.assign(new Error("unique"), { code: "P2002" });
          }
          w.links.push({ decidedById: null, ...d });
          w.log.push(`create:${d.sourceRef}:${d.state}`);
        }
        return { count: data.length };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMany: vi.fn(async ({ where, data }: any) => {
        w.updateWheres.push(where);
        let count = 0;
        for (const l of w.links) {
          if (l.id !== where.id) continue;
          if (where.state && l.state !== where.state) continue;
          if (where.origin && l.origin !== where.origin) continue;
          if (where.stateSetBy && l.stateSetBy !== where.stateSetBy) continue;
          Object.assign(l, data);
          count += 1;
          w.log.push(`update:${l.sourceRef}:${data.state ?? "refresh"}`);
        }
        return { count };
      }),
    },
    securityZone: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMany: vi.fn(async ({ where }: any) => {
        const z = w.zones.find((zz) => zz.id === where.id && zz.version === where.version && zz.state === where.state);
        if (!z) return { count: 0 };
        z.version += 1;
        w.log.push(`cas:${z.id}`);
        return { count: 1 };
      }),
    },
    securityEvent: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: vi.fn(async ({ where }: any) => {
        if (where.kind === "lock_state") {
          return (w.locks ?? [])
            .filter((l) => where.source === "matter_lock" && inRange(l.startedAt, where.startedAt))
            .map((l) => ({ sourceRef: l.sourceRef, labels: l.labels, observed: l.observed, dedupeKey: l.dedupeKey, startedAt: l.startedAt }));
        }
        if (where.kind === "detection") {
          return w.events
            .filter((e) => e.kind === "detection" && e.labels.includes(where.labels.has) && e.camera !== null && inRange(e.startedAt, where.startedAt))
            .map((e) => ({ camera: e.camera, cameraZones: e.cameraZones, startedAt: e.startedAt, endedAt: e.endedAt }));
        }
        return w.events
          .filter((e) => where.kind.in.includes(e.kind) && inRange(e.startedAt, where.startedAt))
          .map((e) => ({ kind: e.kind, camera: e.camera, startedAt: e.startedAt }));
      }),
    },
    camera: { findMany: vi.fn(async () => w.cameras.map((c) => ({ ...c }))) },
  };
  const seam = createTransactionSeam({ client: () => self, stores: { links: w.links, zones: w.zones, log: w.log } });
  self.$transaction = seam.$transaction;
  return { prisma: self, seam };
}

beforeEach(() => {
  audit.calls = [];
  audit.fail = false;
  audit.log = null;
  seq = 0;
  _resetLinkHealthForTests();
});

async function runOn(w: World, opts: Parameters<typeof runSecurityLinkProposals>[2] = {}) {
  const { prisma, seam } = fake(w);
  audit.log = w.log;
  const summary = await runSecurityLinkProposals(prisma, NOW, opts);
  return { summary, prisma, seam };
}

const rowOf = (w: World, ref: string, zoneId = "z-stock") => w.links.find((l) => l.zoneId === zoneId && l.sourceRef === ref);

describe("§6.3's decision table", () => {
  it("none + auto + link_and_suggest + room → created ACTIVE, origin and setter droplet, with evidence; audited link.activated from none", async () => {
    const w = world();
    const { summary, seam } = await runOn(w);
    const b = rowOf(w, "cam_b")!;
    expect(b).toMatchObject({
      state: "active",
      origin: "droplet",
      stateSetBy: "droplet",
      sourceKind: "camera",
      sourceLabel: "Stock cam B",
      createdById: null,
      rulesVersion: LINK_RULES_VERSION,
      evidenceAt: NOW,
      stateChangedAt: NOW,
    });
    expect(parseLinkEvidence(b.evidence)).toMatchObject({ kind: "camera_camera", gate: "auto", anchor: { sourceRef: "cam_a" } });
    expect(b.confidence).toBeGreaterThan(0.6);
    expect(summary).toMatchObject({ activated: 1, proposed: 0, refreshed: 0 });
    expect(audit.calls).toEqual([
      {
        action: "link.activated",
        what: 'Security: Droplet linked Stock cam B to the area "Stock room"',
        refs: {
          zoneId: "z-stock",
          linkId: b.id,
          sourceKind: "camera",
          sourceRef: "cam_b",
          kind: "camera_camera",
          gate: "auto",
          confidenceBp: Math.round(b.confidence! * 10_000),
          rulesVersion: LINK_RULES_VERSION,
          from: "none",
        },
      },
    ]);
    // One READ_COMMITTED transaction for the area; the CAS first, the audit last.
    expect(seam.calls()).toEqual([READ_COMMITTED_TX]);
    expect(w.log).toEqual(["cas:z-stock", "create:cam_b:active", "audit:link.activated"]);
    expect(w.zones[0]!.version).toBe(6);
  });

  it("none + auto while suggest_only → PROPOSED (never activated), audited link.proposed", async () => {
    const w = world({ settings: { linking: "suggest_only", summaries: "on", version: 3 } });
    const { summary } = await runOn(w);
    expect(rowOf(w, "cam_b")).toMatchObject({ state: "proposed", origin: "droplet", stateSetBy: "droplet" });
    expect(summary).toMatchObject({ activated: 0, proposed: 1 });
    expect(audit.calls.map((a) => [a.action, a.what])).toEqual([
      ["link.proposed", 'Security: Droplet suggested Stock cam B for the area "Stock room"'],
    ]);
    expect(audit.calls[0]!.refs).not.toHaveProperty("from");
  });

  it("none + propose → proposed", async () => {
    // 24 visits: enough to propose (n ≥ 20) but not to link on its own (n < 30).
    const w = world({ events: traffic("cam_a", ["cam_b"], 24) });
    await runOn(w);
    expect(rowOf(w, "cam_b")).toMatchObject({ state: "proposed" });
    expect(parseLinkEvidence(rowOf(w, "cam_b")!.evidence)).toMatchObject({ gate: "propose" });
  });

  it("proposed + auto + link_and_suggest → ACTIVE (guarded on Droplet's own row), new evidence, audited link.activated from proposed", async () => {
    const w = world();
    w.links.push(link("z-stock", "cam_b", { state: "proposed", origin: "droplet", stateSetBy: "droplet" }));
    const before = rowOf(w, "cam_b")!.id;
    await runOn(w);
    const b = rowOf(w, "cam_b")!;
    expect(b).toMatchObject({ id: before, state: "active", stateSetBy: "droplet", evidenceAt: NOW, stateChangedAt: NOW });
    expect(w.links.filter((l) => l.sourceRef.startsWith("cam_b"))).toHaveLength(1);
    expect(w.updateWheres).toEqual([{ id: before, state: "proposed", origin: "droplet", stateSetBy: "droplet" }]);
    expect(audit.calls.map((a) => [a.action, a.refs.from, a.refs.linkId])).toEqual([["link.activated", "proposed", before]]);
    expect(w.log).toEqual(["cas:z-stock", "update:cam_b:active", "audit:link.activated"]);
  });

  it("proposed + a gate while suggest_only → the evidence is REFRESHED: no state change, no audit, no version bump", async () => {
    const w = world({ settings: { linking: "suggest_only", summaries: "on", version: 0 } });
    w.links.push(link("z-stock", "cam_b", { state: "proposed", origin: "droplet", stateSetBy: "droplet", confidence: 0.41 }));
    const { summary, seam } = await runOn(w);
    const b = rowOf(w, "cam_b")!;
    expect(b).toMatchObject({ state: "proposed", evidenceAt: NOW });
    expect(b.confidence).toBeGreaterThan(0.6);
    expect(b.stateChangedAt).not.toEqual(NOW);
    expect(summary).toMatchObject({ refreshed: 1, proposed: 0, activated: 0 });
    expect(audit.calls).toEqual([]);
    expect(w.zones[0]!.version).toBe(5);
    expect(seam.calls()).toEqual([]);
    expect(w.updateWheres).toEqual([{ id: b.id, state: "proposed", origin: "droplet", stateSetBy: "droplet" }]);
  });

  it("proposed + no gate → left exactly as it is (its evidence keeps its date)", async () => {
    const w = world({ events: traffic("cam_a", ["cam_b"], 40, { only: { cam_b: 3 } }) });
    const old = link("z-stock", "cam_b", { state: "proposed", origin: "droplet", stateSetBy: "droplet" });
    w.links.push(old);
    const snapshot = { ...old };
    await runOn(w);
    expect(rowOf(w, "cam_b")).toEqual(snapshot);
    expect(audit.calls).toEqual([]);
  });

  it.each<[string, Partial<Link>]>([
    ["active, set by a person", { state: "active" }],
    ["active, Linked by Droplet", { state: "active", origin: "droplet", stateSetBy: "droplet" }],
    ["active, kept by a person", { state: "active", origin: "droplet", stateSetBy: "person" }],
    ["removed", { state: "removed" }],
    ["rejected", { state: "rejected", origin: "droplet", stateSetBy: "person" }],
  ])("%s → NOTHING: never re-scored, re-proposed or touched, not even another view of that camera", async (_n, over) => {
    const w = world({ events: traffic("cam_a", ["cam_b"]).map((e) => (e.camera === "cam_b" ? { ...e, cameraZones: ["door"] } : e)) });
    const row = link("z-stock", "cam_b", over);
    w.links.push(row);
    const snapshot = { ...row };
    for (let run = 0; run < 2; run += 1) await runOn(w);
    expect(w.links.filter((l) => l.sourceRef.startsWith("cam_b"))).toEqual([snapshot]);
    expect(audit.calls).toEqual([]);
  });

  it("a proposal goes into the ANCHOR's area; another area without an anchor gets nothing", async () => {
    const w = world({ zones: [...world().zones, { id: "z-yard", name: "Yard", state: "active", version: 0 }] });
    await runOn(w);
    expect(w.links.filter((l) => l.zoneId === "z-yard")).toEqual([]);
    expect(rowOf(w, "cam_b", "z-stock")).toBeDefined();
  });
});

describe("the settings", () => {
  it("linking OFF → nothing read past the settings, nothing written", async () => {
    const w = world({ settings: { linking: "off", summaries: "on", version: 1 } });
    const { prisma, summary } = await runOn(w);
    expect(summary).toMatchObject({ scored: 0, proposed: 0, activated: 0 });
    expect(prisma.securityZoneLink.findMany).not.toHaveBeenCalled();
    expect(prisma.securityEvent.findMany).not.toHaveBeenCalled();
    expect(w.links).toHaveLength(1);
  });

  it("no settings row yet → created with its defaults (link_and_suggest) and used", async () => {
    const w = world({ settings: null });
    const { prisma } = await runOn(w);
    expect(prisma.securityAiSettings.createMany).toHaveBeenCalledWith({ data: [{ id: "singleton" }], skipDuplicates: true });
    expect(rowOf(w, "cam_b")).toMatchObject({ state: "active" });
  });
});

describe("the anchors", () => {
  it("a link Droplet activated on its own is never an anchor — Droplet never builds on its own guesses", async () => {
    // cam_b is Droplet's link; cam_c always sees someone with cam_b, never with cam_a.
    const events = [...traffic("cam_a", []), ...traffic("cam_b", ["cam_c"]).map((e) => ({
        ...e,
        startedAt: new Date(e.startedAt.getTime() + 90 * MIN),
        endedAt: new Date(e.endedAt!.getTime() + 90 * MIN),
      }))];
    const w = world({ events });
    w.links.push(link("z-stock", "cam_b", { origin: "droplet", stateSetBy: "droplet" }));
    await runOn(w);
    expect(rowOf(w, "cam_c")).toBeUndefined();
    // Once a person keeps it, it anchors.
    rowOf(w, "cam_b")!.stateSetBy = "person";
    await runOn(w);
    expect(rowOf(w, "cam_c")).toMatchObject({ state: "active", origin: "droplet" });
  });

  it("no anchors → nothing loaded, nothing written", async () => {
    const w = world({ links: [] });
    const { prisma } = await runOn(w);
    expect(prisma.securityEvent.findMany).not.toHaveBeenCalled();
    expect(w.links).toEqual([]);
  });

  it("an anchor in an archived area is not an anchor", async () => {
    const w = world();
    w.zones[0]!.state = "archived";
    await runOn(w);
    expect(rowOf(w, "cam_b")).toBeUndefined();
  });

  it("a camera disabled on the box is never a candidate", async () => {
    const w = world();
    w.cameras[1]!.enabled = false;
    await runOn(w);
    expect(rowOf(w, "cam_b")).toBeUndefined();
  });
});

// WARP-2977 P2b-2 x WARP-2979 P4 PR-1: door locks are not Droplet's to link. PR-1 scores the camera arm only; the
// lock arm is P4 PR-4's to design. A person's lock link sits in the area like any other row and nothing more.
describe("door-lock links are not Droplet's (P4 scores cameras only)", () => {
  const LOCK = "matter:4660/1";
  const lockLink = (over: Partial<Link> = {}) => link("z-stock", LOCK, { sourceKind: "lock", sourceLabel: "Back door lock", ...over });

  it("a person's lock link is never an anchor: an area made only of a lock scores nothing and reads no events", async () => {
    const w = world({ links: [lockLink()] });
    const before = structuredClone(w.links);
    const { prisma } = await runOn(w);
    expect(prisma.securityEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.securityZoneLink.createMany).not.toHaveBeenCalled();
    expect(w.links).toEqual(before);
    expect(w.log.filter((l) => l.startsWith("create:") || l.startsWith("update:"))).toEqual([]);
  });

  it("beside a camera anchor, the lock link is left exactly as it is and only cameras are ever created", async () => {
    const w = world();
    w.links.push(lockLink());
    const lockBefore = structuredClone(rowOf(w, LOCK));
    await runOn(w);
    expect(rowOf(w, "cam_b")).toMatchObject({ state: "active", origin: "droplet", sourceKind: "camera" });
    expect(rowOf(w, LOCK)).toEqual(lockBefore);
    expect(w.links.filter((l) => l.origin === "droplet").map((l) => l.sourceKind)).toEqual(["camera"]);
    expect(w.log.some((l) => l.includes(LOCK))).toBe(false);
  });

  it("a lock link still counts toward the area's 32 active links (the cap is per area, whatever the kind)", async () => {
    const w = world();
    w.links.push(lockLink());
    for (let i = 0; i < 30; i += 1) w.links.push(link("z-stock", `filler_${i}`)); // cam_a + lock + 30 = 32 active
    await runOn(w);
    expect(rowOf(w, "cam_b")).toMatchObject({ state: "proposed" });
  });

  it("a lock row on the feed (camera NULL) is not a sighting: it feeds no co-occurrence", async () => {
    const w = world();
    w.links.push(lockLink());
    w.events.push({ kind: "lock_state", camera: null, labels: [], cameraZones: [], startedAt: new Date(FROM + 2 * H), endedAt: null });
    const { summary } = await runOn(w);
    const clean = world();
    clean.links.push(lockLink());
    const { summary: baseline } = await runOn(clean);
    expect(summary.scored).toBe(baseline.scored);
    expect(w.links.map((l) => `${l.sourceRef}:${l.state}`)).toEqual(clean.links.map((l) => `${l.sourceRef}:${l.state}`));
  });
});

describe("the caps", () => {
  /** Area z-stock anchored on cam_a; cameras c01…cNN each see someone after most of cam_a's visits. */
  function many(n: number): World {
    const cams = Array.from({ length: n }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
    // Descending confidence: c01 sees all 40 visits, later cameras fewer (never under the auto bar).
    const only = Object.fromEntries(cams.map((c, i) => [c, 40 - (i % 8)]));
    return world({
      events: traffic("cam_a", cams, 40, { only }),
      cameras: [...world().cameras, ...cams.map((c) => ({ name: c, displayName: `Cam ${c}`, enabled: true }))],
    });
  }

  it("at 32 active links a candidate is PROPOSED, not activated", async () => {
    const w = world();
    for (let i = 0; i < 31; i += 1) w.links.push(link("z-stock", `filler_${i}`));
    await runOn(w);
    expect(rowOf(w, "cam_b")).toMatchObject({ state: "proposed" });
  });

  it("at most 8 open suggestions per area", async () => {
    const w = many(5);
    w.settings!.linking = "suggest_only";
    for (let i = 0; i < 6; i += 1) w.links.push(link("z-stock", `old_${i}`, { state: "proposed", origin: "droplet", stateSetBy: "droplet" }));
    await runOn(w);
    expect(w.links.filter((l) => l.state === "proposed")).toHaveLength(MAX_OPEN_SUGGESTIONS_PER_AREA);
    // The two added are the two most confident.
    expect(w.links.filter((l) => l.state === "proposed" && !l.sourceRef.startsWith("old_")).map((l) => l.sourceRef)).toEqual(["c01", "c02"]);
  });

  // Review #2418 (follow-up 6): the run's cap is applied BEFORE a create takes an area's slot. A create the cap
  // drops must not use up the area's 32nd active link — which an existing suggestion could have been promoted to.
  it("a create the run's cap drops never takes an area's slot: the suggestion behind it is still promoted", () => {
    const res = (zoneId: string, cam: string, confidence: number): PairCandidateResult => ({
      anchor: { linkId: `anchor-${zoneId}`, zoneId, zoneName: zoneId, sourceKind: "camera", sourceRef: `anchor_${zoneId}`, label: "Anchor" },
      camera: cam,
      part: null,
      sourceKind: "camera",
      sourceRef: cam,
      label: cam,
      forward: { n: 40, k: 36, lambda: 1, lift: 36, pChance: 1e-12, confidence },
      reverse: { n: 40, k: 36, lambda: 1, lift: 36, pChance: 1e-12, confidence },
      forwardPAdj: 1e-10,
      reversePAdj: 1e-10,
      gate: "auto",
      confidence,
      wholeK: null,
      names: { match: false, shared: [] },
    }) as unknown as PairCandidateResult;
    const row = (zoneId: string, ref: string, state: "active" | "proposed", by: "person" | "droplet") => ({
      id: `${zoneId}-${ref}`,
      zoneId,
      sourceKind: "camera",
      sourceRef: ref,
      state,
      origin: by,
      stateSetBy: by,
    });
    // Area A: 31 active links and Droplet's open suggestion on z_cam. Area B: empty.
    const areaA = {
      zoneId: "z-a",
      zoneName: "A",
      version: 1,
      rows: [...Array.from({ length: 31 }, (_, i) => row("z-a", `filler_${i}`, "active", "person")), row("z-a", "z_cam", "proposed", "droplet")],
    };
    const areaB = { zoneId: "z-b", zoneName: "B", version: 1, rows: [] };
    const results = [
      res("z-a", "x_cam", 0.7), // new, auto: would take A's 32nd slot — but 20 creates outrank it
      res("z-a", "z_cam", 0.6), // A's open suggestion, auto: the 32nd slot is its to take
      ...Array.from({ length: MAX_NEW_LINK_ROWS_PER_RUN }, (_, i) => res("z-b", `b_${String(i).padStart(2, "0")}`, 0.9)),
    ];
    const plans = planLinkChanges([areaA, areaB], results, "link_and_suggest");
    const a = plans.get("z-a")!;
    expect(a.map((c) => `${c.op}:${c.op === "create" ? c.result.sourceRef : c.row.sourceRef}`)).toEqual(["activate:z_cam"]);
    expect(plans.get("z-b")!.filter((c) => c.op === "create")).toHaveLength(MAX_NEW_LINK_ROWS_PER_RUN);
  });

  it("at most 20 new rows a run, the highest confidence first", async () => {
    const w = many(24);
    await runOn(w);
    const made = w.links.filter((l) => l.origin === "droplet");
    expect(made).toHaveLength(MAX_NEW_LINK_ROWS_PER_RUN);
    const skipped = ["c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08", "c09", "c10", "c11", "c12", "c13", "c14", "c15", "c16", "c17", "c18", "c19", "c20", "c21", "c22", "c23", "c24"].filter(
      (c) => !made.some((l) => l.sourceRef === c),
    );
    const conf = (c: string) => 40 - ((Number(c.slice(1)) - 1) % 8);
    expect(Math.max(...skipped.map(conf))).toBeLessThanOrEqual(Math.min(...made.map((l) => conf(l.sourceRef))));
  });
});

describe("the transaction", () => {
  it("a lost CAS (someone changed the area since the read) skips the area: nothing written, nothing audited", async () => {
    const w = world();
    const { prisma } = fake(w);
    audit.log = w.log;
    // A person saves the area between the job's read and its write.
    const read = prisma.securityZoneLink.findMany.getMockImplementation()!;
    prisma.securityZoneLink.findMany.mockImplementation(async (args: unknown) => {
      const out = await read(args);
      w.zones[0]!.version += 1;
      return out;
    });
    const summary = await runSecurityLinkProposals(prisma, NOW);
    expect(rowOf(w, "cam_b")).toBeUndefined();
    expect(audit.calls).toEqual([]);
    expect(summary).toMatchObject({ activated: 0, proposed: 0 });
  });

  it("an audit that cannot be written rolls the whole area back — no link without its record", async () => {
    const w = world();
    const { prisma } = fake(w);
    audit.fail = true;
    await expect(runSecurityLinkProposals(prisma, NOW)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(rowOf(w, "cam_b")).toBeUndefined();
    expect(w.zones[0]!.version).toBe(5);
  });

  it("two runs → one set of rows and audits (idempotent through the unique key and the decision table)", async () => {
    const w = world();
    await runOn(w);
    await runOn(w);
    expect(w.links.filter((l) => l.origin === "droplet")).toHaveLength(1);
    expect(audit.calls).toHaveLength(1);
  });
});

describe("the budget and the rotation", () => {
  function twoAreas(): World {
    const w = world({
      zones: [
        { id: "z-a", name: "Aisle", state: "active", version: 0 },
        { id: "z-b", name: "Back room", state: "active", version: 0 },
      ],
      links: [link("z-a", "cam_a"), link("z-b", "cam_a")],
    });
    return w;
  }

  it("out of time → stop at an area boundary; the next run starts with the area after the last one done", async () => {
    const w = twoAreas();
    let t = 0;
    // Each area apply "takes" 31 s of the 30 s budget.
    const clock = () => t;
    const { prisma } = fake(w);
    audit.log = w.log;
    const orig = prisma.$transaction;
    prisma.$transaction = vi.fn(async (fn: unknown, o: unknown) => {
      const r = await orig(fn, o);
      t += 31_000;
      return r;
    });
    await runSecurityLinkProposals(prisma, NOW, { clock });
    expect(w.links.filter((l) => l.origin === "droplet").map((l) => l.zoneId)).toEqual(["z-a"]);
    await runSecurityLinkProposals(prisma, NOW, { clock });
    // z-b first this time (then z-a has nothing left to do).
    expect(w.links.filter((l) => l.origin === "droplet").map((l) => l.zoneId)).toEqual(["z-a", "z-b"]);
  });
});

describe("the `links` health row (§6.15)", () => {
  const T0 = new Date(Date.UTC(2026, 8, 24, 20, 0, 0));
  const state = (over: Partial<LinkHealthState> = {}): LinkHealthState => ({
    registeredAt: T0,
    lastOkAt: null,
    lastError: null,
    lastRun: null,
    ...over,
  });
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const TZ = "America/Los_Angeles";

  it("down 'Not running' when the job is not registered (the boot assertion)", () => {
    expect(linkHealthRow(state({ registeredAt: null }), { linking: "link_and_suggest" }, TZ, T0)).toEqual({
      id: "links",
      state: "down",
      detail: "Not running",
      lastSeenAt: null,
    });
  });

  it("the first hour: ok 'First look by <site time>' (minutes-free without a site zone)", () => {
    expect(linkHealthRow(state(), { linking: "link_and_suggest" }, TZ, at(5 * MIN))).toMatchObject({ state: "ok", detail: "First look by 2:00 PM" });
    expect(linkHealthRow(state(), { linking: "link_and_suggest" }, null, at(5 * MIN))).toMatchObject({ state: "ok", detail: "First look within the hour" });
  });

  it("ok after a run, worded by the setting; lastSeenAt is the last run", () => {
    const s = state({ lastOkAt: at(H) });
    expect(linkHealthRow(s, { linking: "link_and_suggest" }, TZ, at(H + MIN))).toEqual({
      id: "links",
      state: "ok",
      detail: "Looks every hour for cameras that cover your areas",
      lastSeenAt: at(H).toISOString(),
    });
    expect(linkHealthRow(s, { linking: "suggest_only" }, TZ, at(H + MIN)).detail).toBe(
      "Looks every hour for cameras that cover your areas, and only suggests them",
    );
  });

  it("not_configured when linking is off", () => {
    expect(linkHealthRow(state({ lastOkAt: at(H) }), { linking: "off" }, TZ, at(H + MIN))).toMatchObject({
      state: "not_configured",
      detail: "Turned off in Security settings",
    });
  });

  it("down 'Couldn't look for links: <reason>' when the last error is newer than the last run", () => {
    const s = state({ lastOkAt: at(H), lastError: { at: at(2 * H), message: "the database didn't answer" } });
    expect(linkHealthRow(s, { linking: "link_and_suggest" }, TZ, at(2 * H + MIN))).toMatchObject({
      state: "down",
      detail: "Couldn't look for links: the database didn't answer",
    });
    // An older error no longer counts.
    const later = state({ lastOkAt: at(3 * H), lastError: { at: at(2 * H), message: "x" } });
    expect(linkHealthRow(later, { linking: "link_and_suggest" }, TZ, at(3 * H + MIN)).state).toBe("ok");
  });

  it("the 70-minute grace: down 'Hasn't looked for links since …' only past it", () => {
    const s = state({ lastOkAt: at(H) });
    expect(linkHealthRow(s, { linking: "link_and_suggest" }, TZ, at(H + LINK_HEALTH_STALE_MS)).state).toBe("ok");
    expect(linkHealthRow(s, { linking: "link_and_suggest" }, TZ, at(H + LINK_HEALTH_STALE_MS + 1))).toMatchObject({
      state: "down",
      detail: "Hasn't looked for links since 2:00 PM",
    });
    expect(linkHealthRow(s, { linking: "link_and_suggest" }, null, at(H + 2 * H)).detail).toBe("Hasn't looked for links for 120 minutes");
    // Never ran at all, past the grace.
    expect(linkHealthRow(state(), { linking: "link_and_suggest" }, TZ, at(LINK_HEALTH_STALE_MS + 1)).state).toBe("down");
  });

  it("securityLinksHealth never throws: unreadable settings or zone degrade the copy, never the header", async () => {
    const prisma = {
      securityAiSettings: { findUnique: vi.fn().mockRejectedValue(new Error("db down")) },
      securitySiteHours: { findUnique: vi.fn().mockRejectedValue(new Error("db down")) },
    };
    expect(await securityLinksHealth(prisma as never, T0)).toEqual({ id: "links", state: "down", detail: "Not running", lastSeenAt: null });
  });
});

// ── P4 PR-4: lock anchors (§6.2.1–§6.2.3, D31) ───────────────────────────────

const LOCK = "matter:4660/1";
const LOCK_KEY = (prev: string | null, reading: string) => lockDedupeKey({ nodeId: "4660", endpointId: 1, reading: reading as LockReading }, prev);

/** A live lock change (after an earlier row) at `at`, unless said otherwise. */
const turn = (at: number, over: Partial<LockEv> = {}): LockEv => ({
  sourceRef: LOCK,
  labels: [over.labels?.[0] ?? "unlocked"],
  observed: "live",
  dedupeKey: LOCK_KEY(`${at}`, over.labels?.[0] ?? "unlocked"),
  startedAt: new Date(at),
  ...over,
});

/** `n` lock changes, 3 h apart; every camera in `linked` sees someone 2 s after each. */
function lockTraffic(linked: string[], n = 20, over: Partial<LockEv> = {}): { locks: LockEv[]; events: Ev[] } {
  const locks: LockEv[] = [];
  const events: Ev[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = FROM + 2 * H + i * (3 * H + 7 * MIN);
    locks.push(turn(t, { labels: [i % 2 === 0 ? "unlocked" : "locked"], dedupeKey: LOCK_KEY(`p${i}`, i % 2 === 0 ? "unlocked" : "locked"), ...over }));
    for (const cam of linked) events.push(person(cam, t + 2 * S));
  }
  return { locks, events };
}

/** The Back door area, its lock linked by a person; cam_b sees someone at every lock change. */
function lockWorld(over: Partial<LockEv> = {}): World {
  const { locks, events } = lockTraffic(["cam_b"], 20, over);
  return world({
    zones: [{ id: "z-back", name: "Back door", state: "active", version: 2 }],
    links: [link("z-back", LOCK, { sourceLabel: "Smart Lock (as linked)" })],
    events,
    locks,
  });
}

const KNOWN = [{ ref: LOCK, name: "Back door lock" }];

describe("P4 PR-4 — a person-linked lock's changes anchor (lock ↔ camera)", () => {
  it("a camera that sees someone within 10 s of the lock's LIVE changes becomes 'Linked by Droplet' — lock_camera evidence, one direction", async () => {
    const w = lockWorld();
    const { summary } = await runOn(w, { knownLocks: () => KNOWN });
    const b = rowOf(w, "cam_b", "z-back")!;
    expect(b).toMatchObject({ state: "active", origin: "droplet", stateSetBy: "droplet", sourceKind: "camera", sourceLabel: "Stock cam B" });
    const e = parseLinkEvidence(b.evidence)!;
    expect(e).toMatchObject({
      kind: "lock_camera",
      reverse: null,
      chosen: "whole",
      gate: "auto",
      anchor: { sourceKind: "lock", sourceRef: LOCK, label: "Back door lock" },
      candidate: { sourceKind: "camera", sourceRef: "cam_b", label: "Stock cam B" },
    });
    expect(e.forward).toMatchObject({ n: 20, k: 20 });
    expect(summary).toMatchObject({ activated: 1, scored: 1 });
    expect(audit.calls).toEqual([
      expect.objectContaining({
        action: "link.activated",
        what: 'Security: Droplet linked Stock cam B to the area "Back door"',
        refs: expect.objectContaining({ kind: "lock_camera", sourceKind: "camera", sourceRef: "cam_b", gate: "auto", from: "none" }),
      }),
    ]);
  });

  it("🔴 POLLED lock rows are never anchors: the same changes, found by the 60 s check, link nothing", async () => {
    const w = lockWorld({ observed: "polled" });
    const { summary } = await runOn(w, { knownLocks: () => KNOWN });
    expect(rowOf(w, "cam_b", "z-back")).toBeUndefined();
    expect(summary.scored).toBe(0);
  });

  it("the BASELINE row is never an anchor — the mark is P2b PR-2's own builder's (`lockDedupeKey(obs, null)`)", async () => {
    expect(LOCK_KEY(null, "locked")).toContain(LOCK_BASELINE_KEY_MARK);
    expect(LOCK_KEY("42", "locked")).not.toContain(LOCK_BASELINE_KEY_MARK);
    const w = lockWorld();
    for (const l of w.locks!) l.dedupeKey = LOCK_KEY(null, l.labels[0]!);
    await runOn(w, { knownLocks: () => KNOWN });
    expect(rowOf(w, "cam_b", "z-back")).toBeUndefined();
  });

  it("only a lock TURNING anchors: not_fully_locked and unknown readings are not", async () => {
    for (const reading of ["not_fully_locked", "unknown"]) {
      const w = lockWorld({ labels: [reading] });
      await runOn(w, { knownLocks: () => KNOWN });
      expect(rowOf(w, "cam_b", "z-back"), reading).toBeUndefined();
    }
  });

  it("the lock rows are read once, by source, kind and the window — every other rule is the one pure predicate's", async () => {
    const w = lockWorld();
    const { prisma } = await runOn(w, { knownLocks: () => KNOWN });
    const lockQuery = prisma.securityEvent.findMany.mock.calls.map((c: unknown[]) => c[0]).find((a: { where: { kind: unknown } }) => a.where.kind === "lock_state");
    expect(lockQuery).toEqual({
      where: {
        source: "matter_lock",
        kind: "lock_state",
        startedAt: { gte: new Date(FROM - 30 * MIN), lte: new Date(NOW.getTime() - 15 * MIN) },
      },
      select: { sourceRef: true, labels: true, observed: true, dedupeKey: true, startedAt: true },
    });
  });

  it("a lock link Droplet set on its own is never an anchor", async () => {
    const w = lockWorld();
    w.links[0] = { ...w.links[0]!, origin: "droplet", stateSetBy: "droplet", evidence: { v: 1 }, confidence: 0.6, rulesVersion: 1, evidenceAt: NOW };
    await runOn(w, { knownLocks: () => KNOWN });
    expect(rowOf(w, "cam_b", "z-back")).toBeUndefined();
  });

  it("camera anchor → the lock: a LOCK candidate, its sourceLabel the lock's device-list name, snapshotted", async () => {
    // cam_a (person-linked to the Stock room) sees someone 2 s before every lock change.
    const { locks, events } = lockTraffic([], 20);
    const w = world({ events: [...events, ...locks.map((l) => person("cam_a", l.startedAt.getTime() - 2 * S))], locks });
    await runOn(w, { knownLocks: () => KNOWN });
    const lock = rowOf(w, LOCK)!;
    expect(lock).toMatchObject({ state: "active", origin: "droplet", sourceKind: "lock", sourceLabel: "Back door lock" });
    expect(parseLinkEvidence(lock.evidence)).toMatchObject({ kind: "lock_camera", chosen: "lock", anchor: { sourceKind: "camera", sourceRef: "cam_a" }, candidate: { sourceKind: "lock", label: "Back door lock" } });
    expect(audit.calls.map((a) => a.what)).toContain('Security: Droplet linked Back door lock to the area "Stock room"');
  });

  it("the lock's name: the device list's, else the snapshot a person's link of it holds, else 'Lock …<last 4>'", async () => {
    const { locks, events } = lockTraffic([], 20);
    const withCam = () => world({ events: [...events, ...locks.map((l) => person("cam_a", l.startedAt.getTime() - 2 * S))], locks });
    const none = withCam();
    await runOn(none, {});
    expect(rowOf(none, LOCK)!.sourceLabel).toBe("Lock …4660");
    const snap = withCam();
    snap.zones.push({ id: "z-hall", name: "Hall", state: "active", version: 0 });
    snap.links.push(link("z-hall", LOCK, { sourceLabel: "Hall door lock" }));
    await runOn(snap, { knownLocks: () => [] });
    expect(rowOf(snap, LOCK)!.sourceLabel).toBe("Hall door lock");
  });

  it("a lock the area already holds a row on — removed, rejected, or a person's — is never proposed again", async () => {
    const { locks, events } = lockTraffic([], 20);
    for (const state of ["removed", "rejected"] as const) {
      const w = world({ events: [...events, ...locks.map((l) => person("cam_a", l.startedAt.getTime() - 2 * S))], locks });
      w.links.push(link("z-stock", LOCK, { state, origin: state === "rejected" ? "droplet" : "person", stateSetBy: "person" }));
      await runOn(w, { knownLocks: () => KNOWN });
      expect(rowOf(w, LOCK)!.state, state).toBe(state);
      expect(audit.calls.filter((a) => a.refs.sourceRef === LOCK), state).toEqual([]);
    }
  });
});

describe("registration and the tick", () => {
  it("scheduleInterval(1 h, …, {lockKey}) and registeredAt — the boot assertion", () => {
    const scheduleInterval = vi.fn();
    expect(linkHealthState().registeredAt).toBeNull();
    registerSecurityLinkJobs({ scheduleInterval }, {} as never);
    expect(scheduleInterval).toHaveBeenCalledTimes(1);
    expect(scheduleInterval.mock.calls[0]![0]).toBe(SECURITY_LINK_INTERVAL_MS);
    expect(scheduleInterval.mock.calls[0]![2]).toEqual({ lockKey: SECURITY_LINK_LOCK_KEY });
    expect(linkHealthState().registeredAt).toBeInstanceOf(Date);
  });

  it("PR-4: the registered tick names a lock candidate from the running lock adapter's list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const scheduleInterval = vi.fn();
      const { locks, events } = lockTraffic([], 20);
      const w = world({ events: [...events, ...locks.map((l) => person("cam_a", l.startedAt.getTime() - 2 * S))], locks });
      const { prisma } = fake(w);
      const knownLocks = vi.fn(() => KNOWN);
      registerSecurityLinkJobs({ scheduleInterval }, prisma, { knownLocks });
      await scheduleInterval.mock.calls[0]![1]();
      expect(knownLocks).toHaveBeenCalled();
      expect(rowOf(w, LOCK)).toMatchObject({ sourceLabel: "Back door lock" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a completed tick records lastOkAt and lastRun; a throw records a fixed reason (never the raw error) and rethrows", async () => {
    const w = world();
    const { prisma } = fake(w);
    await tickSecurityLinkProposals(prisma, NOW);
    expect(linkHealthState()).toMatchObject({ lastOkAt: NOW, lastRun: { activated: 1 } });
    prisma.securityAiSettings.findUnique.mockRejectedValue(Object.assign(new Error("connection refused at 10.0.0.5:5432"), { code: "P1001" }));
    const later = new Date(NOW.getTime() + H);
    await expect(tickSecurityLinkProposals(prisma, later)).rejects.toThrow(/connection refused/);
    expect(linkHealthState().lastError).toEqual({ at: later, message: "the database didn't answer" });
  });
});
