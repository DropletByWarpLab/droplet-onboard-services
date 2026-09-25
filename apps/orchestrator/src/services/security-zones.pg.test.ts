/**
 * WARP-2977 P2b (spec §6.1, §9 pg lane) — areas against REAL Postgres.
 *
 * WHY THESE CASES RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   the twin      — `zoneEventWhere` (SQL) and `zonesForEvent` (memory) must
 *                   pick exactly the same rows. Only Postgres can say what
 *                   `hasSome` on a text[] and an enum `in` really select; 200
 *                   generated rows × random link sets pin the agreement.
 *   active only   — `loadActiveLinks` drops removed links and archived areas:
 *                   a relation filter the fake cannot prove.
 *   nameKey       — the `SecurityZone_name_key` CHECK demands Postgres's own
 *                   lower(btrim(name)). JS lowercasing disagrees on 'İ' and
 *                   final sigma, so the key is computed IN SQL; this proves
 *                   those names are accepted AND collide with their case
 *                   variants, and that the refusals arrive in the shapes the
 *                   routes map (409 ZONE_NAME_TAKEN, 400 on the CHECK).
 *   the CAS       — two link PUTs on the same expectedVersion: one wins, one
 *                   409, and exactly one ActivityRow; the chain still verifies.
 *   rollback      — an in-tx audit that cannot be written leaves no area, no
 *                   link, no version bump and no ActivityRow (a real ROLLBACK,
 *                   not the unit lane's fake).
 *   the limit     — a restore and an add racing for the 64th place: the
 *                   area-limit advisory lock makes exactly one win. The
 *                   interleaving is forced with a held row lock, so the test
 *                   fails deterministically when the lock is missing.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 * FIXTURE SCOPING — every area, camera name and event this file mints is
 * tagged `warp2977b` and every cleanup is scoped to that tag. ActivityRow is
 * never truncated: the chain's tail is recorded before the file
 * (`chainFloor`), the chain checks walk only the rows after it, and the
 * cleanup deletes only those (__tests__/helpers/activity-chain-floor.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

import {
  ZoneWriteError,
  buildZoneIndex,
  createZone,
  loadActiveLinks,
  normaliseZoneName,
  replaceZoneLinks,
  setZoneState,
  updateZone,
  zoneEventWhere,
  zonesForEvent,
  type ActiveZoneLink,
  type DesiredZoneLink,
  type ZoneWriteContext,
} from "./security-zones.service.js";
import { createActivityRecorder } from "./activity.service.js";
import { isSecurityAuditUnavailable } from "./security-audit.js";
import { _setActivityRecorderForTests } from "./activity.singleton.js";
import { createHmacSigner } from "./audit-signing.service.js";
import { verifyActivityChain } from "./audit-verify.service.js";
import {
  appendForeignRow,
  chainFloor,
  deleteAfterFloor,
  removeForeignRow,
  type ChainFloor,
} from "../__tests__/helpers/activity-chain-floor.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2977b";
const CAMS = [`${TAG}_c1`, `${TAG}_c2`, `${TAG}_c3`];
/** A camera no area links — its rows must match nothing. */
const UNLINKED = `${TAG}_c9`;
const PARTS = ["porch", "drive", "yard", "till"];
const T0 = new Date("2026-09-23T02:00:00Z");

/** Deterministic PRNG (mulberry32) — a failure reproduces from its seed. */
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
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

describe.skipIf(!RUN)("Areas against real Postgres (WARP-2977 P2b)", () => {
  let prisma: PrismaClient;
  let floor: ChainFloor | null = null;
  let foreignRowId = 0n;
  const signer = createHmacSigner(Buffer.alloc(32, 11));
  const ctx: ZoneWriteContext = { req: { user: { id: `${TAG}-owner`, role: "owner" } }, now: T0 };

  async function sweep(): Promise<void> {
    // `warp2977b ` WITH the space: security-schema-checks.pg.test.ts owns `warp2977b-`.
    const zones = await prisma.securityZone.findMany({ where: { name: { startsWith: `${TAG} ` } }, select: { id: true } });
    const ids = zones.map((z) => z.id);
    await prisma.securityZoneLink.deleteMany({ where: { zoneId: { in: ids } } });
    await prisma.securityZone.deleteMany({ where: { id: { in: ids } } });
    await prisma.securityEvent.deleteMany({ where: { dedupeKey: { startsWith: `${TAG}:` } } });
    // WARP-2978 PR-D — the generated still-in-view rows live in their own key namespace.
    await prisma.securityEvent.deleteMany({ where: { dedupeKey: { startsWith: `frigate-ongoing:${TAG}-` } } });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
    // A row another pg file left behind, under another key: a whole-table walk
    // with this file's signer would fail on it, so the chain checks here walk
    // only the rows after the floor — and never delete what came before it.
    foreignRowId = await appendForeignRow(prisma, `${TAG} another file's row`);
    floor = await chainFloor(prisma);
    await sweep();
  });

  afterAll(async () => {
    await sweep();
    await deleteAfterFloor(prisma, floor);
    const foreignRowKept = await removeForeignRow(prisma, foreignRowId);
    _setActivityRecorderForTests(null, null);
    await prisma.$disconnect();
    expect(foreignRowKept).toBe(true);
  });

  /** An area straight into the table (ASCII name, so the JS key is the SQL key). */
  async function rawZone(name: string, links: Array<DesiredZoneLink & { state?: "active" | "removed" }>, archived = false) {
    const zone = await prisma.securityZone.create({
      data: { name, nameKey: name.toLowerCase(), kind: "interior", state: archived ? "archived" : "active" },
    });
    if (links.length > 0) {
      await prisma.securityZoneLink.createMany({
        data: links.map((l) => ({
          zoneId: zone.id,
          sourceKind: l.sourceKind,
          sourceRef: l.sourceRef,
          sourceLabel: l.sourceRef,
          state: l.state ?? "active",
          origin: "person" as const,
          stateSetBy: "person" as const,
        })),
      });
    }
    return zone;
  }

  describe("zoneEventWhere and zonesForEvent are twins", () => {
    type Gen = { source: string; kind: string; camera: string | null; cameraZones: string[] };
    const generated: Gen[] = [];

    beforeAll(async () => {
      const r = rng(2977);
      for (let i = 0; i < 200; i++) {
        const shape = pick(r, ["det", "det", "det", "low", "ongoing", "status", "status", "site", "threat", "mode"] as const);
        let g: Gen;
        if (shape === "det" || shape === "low" || shape === "ongoing") {
          const zones = PARTS.filter(() => r() < 0.35);
          const kind = shape === "det" ? "detection" : shape === "low" ? "detection_low" : "detection_ongoing";
          g = { source: "frigate", kind, camera: pick(r, [...CAMS, UNLINKED]), cameraZones: zones };
        } else if (shape === "status") {
          g = { source: "frigate_status", kind: pick(r, ["camera_offline", "camera_online"]), camera: pick(r, [...CAMS, UNLINKED]), cameraZones: [] };
        } else if (shape === "site") {
          g = { source: "frigate_status", kind: pick(r, ["source_offline", "source_online"]), camera: null, cameraZones: [] };
        } else if (shape === "threat") {
          g = { source: "activity_mirror", kind: "threat", camera: null, cameraZones: [] };
        } else {
          g = { source: "site_mode", kind: "mode_changed", camera: null, cameraZones: [] };
        }
        generated.push(g);
      }
      await prisma.securityEvent.createMany({
        data: generated.map((g, i) => ({
          source: g.source as never,
          kind: g.kind as never,
          severity: "info" as const,
          camera: g.camera,
          sourceRef: `${TAG}/prop-${i}`,
          // A still-in-view row's key is in its own namespace (SecurityEvent_ongoing_shape).
          dedupeKey: g.kind === "detection_ongoing" ? `frigate-ongoing:${TAG}-prop-${i}` : `${TAG}:prop:${i}`,
          labels: g.kind === "mode_changed" ? ["closed", "manual", "open"] : ["person"],
          cameraZones: g.cameraZones,
          score: null,
          startedAt: new Date(T0.getTime() - i * 1000),
          summary: `${TAG} generated`,
        })),
      });
    });

    async function assertTwins(links: ActiveZoneLink[], zoneIds: string[], label: string): Promise<number> {
      const rows = await prisma.securityEvent.findMany({
        where: { sourceRef: { startsWith: `${TAG}/prop-` } },
        select: { id: true, source: true, kind: true, camera: true, cameraZones: true },
      });
      const index = buildZoneIndex(links);
      let matched = 0;
      for (const zoneId of zoneIds) {
        const own = links.filter((l) => l.zoneId === zoneId);
        const clause = zoneEventWhere(own);
        const inMemory = rows.filter((row) => zonesForEvent(row, index).includes(zoneId)).map((row) => row.id).sort();
        if (clause === "none") {
          expect(inMemory, `${label} zone ${zoneId}: "none" but memory matched`).toEqual([]);
          continue;
        }
        const inSql = (
          await prisma.securityEvent.findMany({
            where: { AND: [{ sourceRef: { startsWith: `${TAG}/prop-` } }, clause] },
            select: { id: true },
          })
        )
          .map((row) => row.id)
          .sort();
        expect(inSql, `${label} zone ${zoneId} links ${JSON.stringify(own.map((l) => l.sourceRef))}`).toEqual(inMemory);
        matched += inSql.length;
      }
      return matched;
    }

    it("over links read back by loadActiveLinks — which drops removed links and archived areas", async () => {
      const a = await rawZone(`${TAG} twin a`, [
        { sourceKind: "camera", sourceRef: CAMS[0]! },
        { sourceKind: "camera_zone", sourceRef: `${CAMS[1]}/porch` },
        { sourceKind: "camera_zone", sourceRef: `${CAMS[2]}/till`, state: "removed" },
      ]);
      const b = await rawZone(`${TAG} twin b`, [
        { sourceKind: "camera_zone", sourceRef: `${CAMS[1]}/drive` },
        { sourceKind: "camera_zone", sourceRef: `${CAMS[1]}/yard` },
        { sourceKind: "camera_zone", sourceRef: `${CAMS[2]}/porch` },
      ]);
      const archived = await rawZone(`${TAG} twin archived`, [{ sourceKind: "camera", sourceRef: CAMS[2]! }], true);
      const mine = (await loadActiveLinks(prisma)).filter((l) => [a.id, b.id, archived.id].includes(l.zoneId));
      expect(mine.map((l) => [l.zoneId === a.id ? "a" : l.zoneId === b.id ? "b" : "archived", l.sourceRef]).sort()).toEqual(
        [
          ["a", CAMS[0]],
          ["a", `${CAMS[1]}/porch`],
          ["b", `${CAMS[1]}/drive`],
          ["b", `${CAMS[1]}/yard`],
          ["b", `${CAMS[2]}/porch`],
        ].sort(),
      );
      expect(await assertTwins(mine, [a.id, b.id], "stored")).toBeGreaterThan(0);
    });

    it("over 25 rounds of random link sets (5 areas each, whole cameras and parts mixed)", async () => {
      const r = rng(59);
      let total = 0;
      for (let round = 0; round < 25; round++) {
        const links: ActiveZoneLink[] = [];
        const ids: string[] = [];
        for (let z = 0; z < 5; z++) {
          const zoneId = `r${round}z${z}`;
          ids.push(zoneId);
          const n = Math.floor(r() * 5); // 0–4 links; 0 exercises "none"
          for (let k = 0; k < n; k++) {
            const camera = pick(r, CAMS);
            const whole = r() < 0.3;
            links.push({
              linkId: `${zoneId}-${k}`,
              zoneId,
              zoneName: zoneId,
              zoneKind: "interior",
              sourceKind: whole ? "camera" : "camera_zone",
              sourceRef: whole ? camera : `${camera}/${pick(r, PARTS)}`,
              setBy: "person",
            });
          }
        }
        total += await assertTwins(links, ids, `round ${round}`);
      }
      // Not vacuous: the generated rows really fell inside areas.
      expect(total).toBeGreaterThan(100);
    });

    it("hasSome on the text[] really selects: only rows that entered the linked part, plus the camera's status rows", async () => {
      const cam = `${TAG}_hs`;
      await prisma.securityEvent.createMany({
        data: [
          ["hs-1", "detection", ["porch", "drive"]],
          ["hs-2", "detection", ["yard"]],
          ["hs-3", "detection", []],
          ["hs-4", "detection_low", ["drive"]],
          ["hs-5", "camera_offline", []],
        ].map(([key, kind, zones]) => ({
          source: (kind === "camera_offline" ? "frigate_status" : "frigate") as never,
          kind: kind as never,
          severity: "info" as const,
          camera: cam,
          sourceRef: `${cam}/${key}`,
          dedupeKey: `${TAG}:${key}`,
          labels: ["person"],
          cameraZones: zones as string[],
          score: null,
          startedAt: T0,
          summary: `${TAG} hasSome`,
        })),
      });
      const clause = zoneEventWhere([{ sourceKind: "camera_zone", sourceRef: `${cam}/drive` }]);
      expect(clause).not.toBe("none");
      const got = await prisma.securityEvent.findMany({
        where: { AND: [{ dedupeKey: { startsWith: `${TAG}:hs-` } }, clause as object] },
        select: { dedupeKey: true },
      });
      expect(got.map((g) => g.dedupeKey).sort()).toEqual([`${TAG}:hs-1`, `${TAG}:hs-4`, `${TAG}:hs-5`]);
    });
  });

  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error("expected a refusal");
  };

  describe("nameKey is Postgres's own lower(btrim(name))", () => {
    const sqlLower = async (s: string) =>
      (await prisma.$queryRaw<Array<{ k: string }>>`SELECT lower(btrim(${s}::text)) AS k`)[0]!.k;

    it.each([
      ["a dotted capital I", `${TAG} İstanbul`, `${TAG.toUpperCase()} İSTANBUL`],
      ["a final sigma", `${TAG} ΟΔΟΣ`, `${TAG} οδοσ`],
      ["plain case", `${TAG} Stock Room`, `${TAG} STOCK room`],
    ])("%s: the name is accepted, and its case variant collides (409 ZONE_NAME_TAKEN)", async (_n, name, variant) => {
      const zone = await createZone(prisma, ctx, { name, kind: "entry" });
      const stored = await prisma.securityZone.findUniqueOrThrow({ where: { id: zone.id } });
      expect(stored.nameKey).toBe(await sqlLower(name));
      const err = await refusal(createZone(prisma, ctx, { name: variant, kind: "entry" }));
      expect(err).toBeInstanceOf(ZoneWriteError);
      expect(err).toMatchObject({ status: 409, code: "ZONE_NAME_TAKEN", extra: {} });
    });

    it("through the route's name rule, an NFD name and a double-spaced one collide with their plain twins (409 ZONE_NAME_TAKEN)", async () => {
      const nfc = normaliseZoneName(`${TAG} Café till`)!;
      await createZone(prisma, ctx, { name: nfc, kind: "interior" });
      const nfd = normaliseZoneName(`${TAG} Cafe\u0301 till`)!;
      expect(await refusal(createZone(prisma, ctx, { name: nfd, kind: "interior" }))).toMatchObject({ status: 409, code: "ZONE_NAME_TAKEN" });
      await createZone(prisma, ctx, { name: normaliseZoneName(`${TAG} Front door`)!, kind: "entry" });
      const spaced = normaliseZoneName(`${TAG} Front\u00A0 door`)!;
      expect(await refusal(createZone(prisma, ctx, { name: spaced, kind: "entry" }))).toMatchObject({ status: 409, code: "ZONE_NAME_TAKEN" });
    });

    it("JS lowercasing really disagrees on these names — the reason the key is computed in SQL", async () => {
      expect(await sqlLower(`${TAG} İstanbul`)).not.toBe(`${TAG} İstanbul`.toLowerCase());
      expect(await sqlLower(`${TAG} ΟΔΟΣ`)).not.toBe(`${TAG} ΟΔΟΣ`.toLowerCase());
    });

    it("a name held by a removed area → ZONE_NAME_TAKEN with archivedZoneId", async () => {
      const zone = await createZone(prisma, ctx, { name: `${TAG} Back office`, kind: "restricted" });
      await setZoneState(prisma, ctx, zone.id, "archived", 0);
      const err = await refusal(createZone(prisma, ctx, { name: `${TAG} BACK OFFICE`, kind: "entry" }));
      expect(err).toMatchObject({ status: 409, code: "ZONE_NAME_TAKEN", extra: { archivedZoneId: zone.id } });
    });

    it("a rename onto another area's name is refused by the unique index in the same shape", async () => {
      const a = await createZone(prisma, ctx, { name: `${TAG} Rename a`, kind: "entry" });
      await createZone(prisma, ctx, { name: `${TAG} Rename b`, kind: "entry" });
      const err = await refusal(updateZone(prisma, ctx, a.id, { name: `${TAG} RENAME B`, expectedVersion: 0 }));
      expect(err).toMatchObject({ status: 409, code: "ZONE_NAME_TAKEN" });
      expect(await prisma.securityZone.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ name: `${TAG} Rename a`, version: 0 });
    });

    it("a name the CHECK refuses arrives as a 400 VALIDATION_ERROR, not a 500", async () => {
      // Routes never send this (normaliseZoneName refuses it first); the service must still map it.
      const err = await refusal(createZone(prisma, ctx, { name: "   ", kind: "entry" }));
      expect(err).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    });
  });

  describe("the link set is compare-and-set on the area version", () => {
    const frigateConfig = async () => ({
      cameras: { [CAMS[0]!]: { zones: { porch: {}, till: {} } }, [CAMS[1]!]: { zones: {} } },
    });
    const auditRows = async (zoneId: string) =>
      (
        await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM "ActivityRow"
          WHERE "refs"->>'zoneId' = ${zoneId} AND "refs"->>'action' = 'zone.links'`
      )[0]!.n;

    it("two concurrent PUTs on the same expectedVersion: one wins, one 409, one ActivityRow — five times over", async () => {
      for (let round = 0; round < 5; round++) {
        const zone = await createZone(prisma, ctx, { name: `${TAG} Race ${round}`, kind: "entry" });
        const sets: DesiredZoneLink[][] = [
          [{ sourceKind: "camera", sourceRef: CAMS[0]! }],
          [
            { sourceKind: "camera_zone", sourceRef: `${CAMS[0]}/porch` },
            { sourceKind: "camera", sourceRef: CAMS[1]! },
          ],
        ];
        const outcomes = await Promise.allSettled(
          sets.map((links) =>
            replaceZoneLinks(prisma, ctx, zone.id, { links, expectedVersion: 0 }, {
              scope: { visibleCameras: "all" },
              cameraLabels: new Map(),
              frigateConfig,
            }),
          ),
        );
        const won = outcomes.filter((o) => o.status === "fulfilled");
        const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
        expect(won, `round ${round}`).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(lost[0]!.reason).toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
        const winner = sets[outcomes.findIndex((o) => o.status === "fulfilled")]!;
        const active = await prisma.securityZoneLink.findMany({ where: { zoneId: zone.id, state: "active" } });
        expect(active.map((l) => l.sourceRef).sort()).toEqual(winner.map((l) => l.sourceRef).sort());
        expect(await prisma.securityZone.findUniqueOrThrow({ where: { id: zone.id } })).toMatchObject({ version: 1 });
        expect(await auditRows(zone.id)).toBe(1);
      }
      expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
    });

    it("remove then re-add: the row is reused (removed → active), never duplicated", async () => {
      const zone = await createZone(prisma, ctx, { name: `${TAG} Reuse`, kind: "entry" });
      const deps = { scope: { visibleCameras: "all" as const }, cameraLabels: new Map([[CAMS[0]!, "Front camera"]]), frigateConfig };
      const porch: DesiredZoneLink = { sourceKind: "camera_zone", sourceRef: `${CAMS[0]}/porch` };
      await replaceZoneLinks(prisma, ctx, zone.id, { links: [porch], expectedVersion: 0 }, deps);
      await replaceZoneLinks(prisma, ctx, zone.id, { links: [], expectedVersion: 1 }, deps);
      const back = await replaceZoneLinks(prisma, ctx, zone.id, { links: [porch], expectedVersion: 2 }, deps);
      expect(back.changed).toBe(true);
      const rows = await prisma.securityZoneLink.findMany({ where: { zoneId: zone.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "active", sourceLabel: "Front camera", decidedById: `${TAG}-owner` });
      expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
    });
  });

  describe("an audit that cannot be written takes the change with it", () => {
    it("add and link PUT with the recorder down: AUDIT_UNAVAILABLE, no area, no link, no version bump, no ActivityRow", async () => {
      const zone = await createZone(prisma, ctx, { name: `${TAG} Rollback`, kind: "entry" });
      const rowsBefore = await prisma.activityRow.count();
      // The in-tx append refuses to run (recorder not initialised) AFTER the area row was written
      // in the same transaction — so only a real rollback leaves nothing behind.
      _setActivityRecorderForTests(null, null);
      try {
        const add = await refusal(createZone(prisma, ctx, { name: `${TAG} Unaudited`, kind: "entry" }));
        expect(isSecurityAuditUnavailable(add)).toBe(true);
        const put = await refusal(
          replaceZoneLinks(prisma, ctx, zone.id, { links: [{ sourceKind: "camera", sourceRef: CAMS[0]! }], expectedVersion: 0 }, {
            scope: { visibleCameras: "all" },
            cameraLabels: new Map([[CAMS[0]!, "Front camera"]]),
            frigateConfig: async () => ({ cameras: {} }),
          }),
        );
        expect(isSecurityAuditUnavailable(put)).toBe(true);
      } finally {
        _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
      }
      expect(await prisma.securityZone.findFirst({ where: { name: `${TAG} Unaudited` } })).toBeNull();
      expect(await prisma.securityZoneLink.count({ where: { zoneId: zone.id } })).toBe(0);
      expect(await prisma.securityZone.findUniqueOrThrow({ where: { id: zone.id } })).toMatchObject({ version: 0 });
      expect(await prisma.activityRow.count()).toBe(rowsBefore);
      expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
    });
  });

  // LAST in this file: it fills the table to the 64-area limit (and empties it again).
  describe("the 64-area limit holds when two writers race for the last place", () => {
    /** Wait until `n` backends are queued on a lock (a row lock or an advisory lock). */
    async function lockWaiters(n: number): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
          SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks WHERE NOT granted`;
        if ((rows[0]?.waiting ?? 0) >= n) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`fewer than ${n} backends ever queued on a lock`);
    }

    it("a restore and an add at 63 active areas: exactly one wins, the other is ZONE_LIMIT, 64 stay active", async () => {
      const active = await prisma.securityZone.count({ where: { state: "active" } });
      expect(active, "another file left active areas behind").toBeLessThan(63);
      const fill = Array.from({ length: 63 - active }, (_, i) => `${TAG} limit fill ${i}`);
      let release!: () => void;
      let holder: Promise<unknown> | null = null;
      try {
        await prisma.securityZone.createMany({ data: fill.map((name) => ({ name, nameKey: name, kind: "interior" as const })) });
        const removed = await rawZone(`${TAG} limit removed`, [], true);

        // Deterministic interleaving: hold the removed area's row, so the restore takes its
        // locks, COUNTS 63, and then queues on this row. Only then does the add start. With
        // the area-limit lock the add queues behind the restore; without it the add also
        // counts 63 and both commit — 65 active areas.
        let locked!: () => void;
        const isLocked = new Promise<void>((r) => (locked = r));
        const gate = new Promise<void>((r) => (release = r));
        holder = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1 FROM "SecurityZone" WHERE "id" = ${removed.id} FOR UPDATE`;
            locked();
            await gate;
          },
          { timeout: 20_000 },
        );
        await isLocked;
        const restore = setZoneState(prisma, ctx, removed.id, "active", 0);
        await lockWaiters(1);
        const add = createZone(prisma, ctx, { name: `${TAG} limit added`, kind: "entry" });
        await Promise.race([add.then(() => undefined, () => undefined), lockWaiters(2)]);
        release();
        await holder;
        holder = null;

        const outcomes = await Promise.allSettled([restore, add]);
        expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
        const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
        expect(lost).toHaveLength(1);
        expect(lost[0]!.reason).toMatchObject({ status: 409, code: "ZONE_LIMIT" });
        expect(await prisma.securityZone.count({ where: { state: "active" } })).toBe(64);
      } finally {
        release?.();
        await holder?.catch(() => undefined);
        await sweep();
      }
    });
  });
});
