/**
 * WARP-2979 (ADR-059 P4 §6.3, §9 pg lane) — Droplet's link proposals against
 * REAL Postgres.
 *
 *   CHECK-valid     — every row the job writes passes SecurityZoneLink_origin_shape
 *                     (evidence, confidence, rules version and time on
 *                     Droplet's rows; `proposed` droplet/droplet).
 *   the chain       — one ActivityRow per state change, the system actor, and
 *                     audit-verify passes after the run.
 *   two runs at once — one set of rows and audits (the area CAS).
 *   never again     — `removed` and `rejected` rows: two runs, nothing.
 *   rollback        — an audit that cannot be written leaves no link, no
 *                     version bump and no ActivityRow (a real ROLLBACK).
 *   route 12 races  — a person's save and the job on one area: whichever
 *                     loses the CAS gives way (the person gets exactly one
 *                     409; the job skips the area this hour); no link is lost.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL. FIXTURE SCOPING: every area,
 * camera and event is tagged `warp2979j`; the AI settings row is set for the
 * file and restored after it; the chain is walked only past this file's floor.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

import { _resetLinkHealthForTests, runSecurityLinkProposals } from "./security-link-proposals.service.js";
import { replaceZoneLinks, type ZoneWriteContext } from "./security-zones.service.js";
import { createActivityRecorder } from "./activity.service.js";
import { isSecurityAuditUnavailable } from "./security-audit.js";
import { _setActivityRecorderForTests } from "./activity.singleton.js";
import { createHmacSigner } from "./audit-signing.service.js";
import { verifyActivityChain } from "./audit-verify.service.js";
import { parseLinkEvidence } from "../lib/security-link-evidence.js";
import { chainFloor, deleteAfterFloor, type ChainFloor } from "../__tests__/helpers/activity-chain-floor.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2979j";
const A = `${TAG}_a`;
const B = `${TAG}_b`;
const C = `${TAG}_c`;
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const DAY = 24 * H;
/** The run's "now"; every fixture time derives from it and the job's own window (14 d, settled 15 min). */
const NOW = new Date("2026-09-24T14:00:00.000Z");
const FROM = NOW.getTime() - 14 * DAY;

describe.skipIf(!RUN)("Droplet's link proposals against real Postgres (WARP-2979)", () => {
  let prisma: PrismaClient;
  let floor: ChainFloor | null = null;
  let settingsBefore: { linking: string; summaries: string; version: number } | null = null;
  const signer = createHmacSigner(Buffer.alloc(32, 29));
  const ctx: ZoneWriteContext = { req: { user: { id: `${TAG}-owner`, role: "owner" } }, now: NOW };

  async function sweep(): Promise<void> {
    const zones = await prisma.securityZone.findMany({ where: { name: { startsWith: `${TAG} ` } }, select: { id: true } });
    const ids = zones.map((z) => z.id);
    await prisma.securityZoneLink.deleteMany({ where: { zoneId: { in: ids } } });
    await prisma.securityZone.deleteMany({ where: { id: { in: ids } } });
    await prisma.securityEvent.deleteMany({ where: { dedupeKey: { startsWith: `${TAG}:` } } });
    await prisma.camera.deleteMany({ where: { name: { startsWith: TAG } } });
  }

  /**
   * 40 visits of A, 3 h 7 min apart: B sees someone 2 s after every one (a
   * mutual `auto`), C after the first 24 only (a `propose`).
   */
  async function traffic(): Promise<void> {
    const rows: Array<{ camera: string; at: number }> = [];
    for (let i = 0; i < 40; i += 1) {
      const t = FROM + 2 * H + i * (3 * H + 7 * MIN);
      rows.push({ camera: A, at: t }, { camera: B, at: t + 2 * S });
      if (i < 24) rows.push({ camera: C, at: t + 3 * S });
    }
    await prisma.securityEvent.createMany({
      data: rows.map((r, i) => ({
        source: "frigate" as const,
        kind: "detection" as const,
        severity: "info" as const,
        camera: r.camera,
        sourceRef: `${r.camera}/${TAG}-${i}`,
        dedupeKey: `${TAG}:${i}`,
        labels: ["person"],
        cameraZones: [],
        score: 0.9,
        startedAt: new Date(r.at),
        endedAt: new Date(r.at + 4 * S),
        summary: `${TAG} person`,
      })),
    });
  }

  async function area(name: string, links: Array<Record<string, unknown>> = [{ sourceKind: "camera", sourceRef: A }]) {
    const zone = await prisma.securityZone.create({ data: { name: `${TAG} ${name}`, nameKey: `${TAG} ${name}`.toLowerCase(), kind: "interior" } });
    for (const l of links) {
      await prisma.securityZoneLink.create({
        data: {
          zoneId: zone.id,
          sourceKind: "camera",
          sourceLabel: String(l.sourceRef),
          state: "active",
          origin: "person",
          stateSetBy: "person",
          ...(l as { sourceRef: string }),
        },
      });
    }
    return zone;
  }

  const links = (zoneId: string) => prisma.securityZoneLink.findMany({ where: { zoneId }, orderBy: { sourceRef: "asc" } });
  const auditsFor = async (zoneId: string) =>
    prisma.$queryRaw<Array<{ action: string; actorType: string | null }>>`
      SELECT "refs"->>'action' AS action, "actorType"::text AS "actorType" FROM "ActivityRow"
      WHERE "refs"->>'zoneId' = ${zoneId} AND "refs"->>'action' LIKE 'link.%' ORDER BY id`;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
    floor = await chainFloor(prisma);
    await sweep();
    settingsBefore = await prisma.securityAiSettings.findUnique({ where: { id: "singleton" }, select: { linking: true, summaries: true, version: true } });
    await prisma.securityAiSettings.createMany({ data: [{ id: "singleton" }], skipDuplicates: true });
    await prisma.camera.createMany({
      data: [A, B, C].map((name, i) => ({ name, displayName: `${TAG} cam ${"ABC"[i]}`, ipAddress: `10.29.79.${i + 1}` })),
    });
    await traffic();
  });

  beforeEach(async () => {
    _resetLinkHealthForTests();
    await prisma.securityAiSettings.update({ where: { id: "singleton" }, data: { linking: "link_and_suggest" } });
    const zones = await prisma.securityZone.findMany({ where: { name: { startsWith: `${TAG} ` } }, select: { id: true } });
    await prisma.securityZoneLink.deleteMany({ where: { zoneId: { in: zones.map((z) => z.id) } } });
    await prisma.securityZone.deleteMany({ where: { id: { in: zones.map((z) => z.id) } } });
  });

  afterAll(async () => {
    await sweep();
    if (settingsBefore) {
      await prisma.securityAiSettings.update({ where: { id: "singleton" }, data: settingsBefore as never });
    } else {
      await prisma.securityAiSettings.deleteMany({ where: { id: "singleton" } });
    }
    await deleteAfterFloor(prisma, floor);
    _setActivityRecorderForTests(null, null);
    await prisma.$disconnect();
  });

  it("links B on its own and suggests C: CHECK-valid rows, one system ActivityRow each, and the chain verifies", async () => {
    const zone = await area("Stock room");
    const run = await runSecurityLinkProposals(prisma, NOW);
    expect(run).toMatchObject({ activated: 1, proposed: 1 });
    const rows = await links(zone.id);
    const b = rows.find((r) => r.sourceRef === B)!;
    const c = rows.find((r) => r.sourceRef === C)!;
    expect(b).toMatchObject({ state: "active", origin: "droplet", stateSetBy: "droplet", sourceLabel: `${TAG} cam B`, createdById: null, rulesVersion: 1 });
    expect(c).toMatchObject({ state: "proposed", origin: "droplet", stateSetBy: "droplet" });
    expect(parseLinkEvidence(b.evidence)).toMatchObject({ gate: "auto", forward: { n: 40, k: 40 } });
    expect(parseLinkEvidence(c.evidence)).toMatchObject({ gate: "propose", forward: { n: 40, k: 24 } });
    expect(await prisma.securityZone.findUniqueOrThrow({ where: { id: zone.id } })).toMatchObject({ version: 1 });
    expect(await auditsFor(zone.id)).toEqual([
      { action: "link.activated", actorType: "system" },
      { action: "link.proposed", actorType: "system" },
    ]);
    expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
  });

  it("two runs at once → one set of rows and one set of audits", async () => {
    const zone = await area("Twice");
    const outcomes = await Promise.allSettled([runSecurityLinkProposals(prisma, NOW), runSecurityLinkProposals(prisma, NOW)]);
    expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
    expect((await links(zone.id)).filter((r) => r.origin === "droplet")).toHaveLength(2);
    expect(await auditsFor(zone.id)).toHaveLength(2);
    expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
  });

  it("removed and rejected are final: two runs later, nothing proposed, nothing touched", async () => {
    const zone = await area("Final", [
      { sourceKind: "camera", sourceRef: A },
      { sourceKind: "camera", sourceRef: B, state: "removed" },
    ]);
    await prisma.securityZoneLink.create({
      data: {
        zoneId: zone.id,
        sourceKind: "camera",
        sourceRef: C,
        sourceLabel: "C",
        state: "rejected",
        origin: "droplet",
        stateSetBy: "person",
        evidence: { v: 1 },
        confidence: 0.5,
        rulesVersion: 1,
        evidenceAt: new Date(NOW.getTime() - DAY),
      },
    });
    const before = await links(zone.id);
    await runSecurityLinkProposals(prisma, NOW);
    await runSecurityLinkProposals(prisma, new Date(NOW.getTime() + H));
    expect(await links(zone.id)).toEqual(before);
    expect(await auditsFor(zone.id)).toEqual([]);
  });

  it("an audit that cannot be written rolls the area back: no link, no version bump, no ActivityRow", async () => {
    const zone = await area("Rollback");
    const rowsBefore = await prisma.activityRow.count();
    _setActivityRecorderForTests(null, null);
    let err: unknown = null;
    try {
      await runSecurityLinkProposals(prisma, NOW);
    } catch (e) {
      err = e;
    } finally {
      _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
    }
    expect(isSecurityAuditUnavailable(err)).toBe(true);
    expect((await links(zone.id)).map((r) => r.sourceRef)).toEqual([A]);
    expect(await prisma.securityZone.findUniqueOrThrow({ where: { id: zone.id } })).toMatchObject({ version: 0 });
    expect(await prisma.activityRow.count()).toBe(rowsBefore);
  });

  describe("a person's route-12 save racing the job on one area", () => {
    const deps = () => ({
      scope: { visibleCameras: "all" as const },
      cameraLabels: new Map([[A, "A"], [B, "B"], [C, "C"]]),
      frigateConfig: async () => ({ cameras: {} }),
    });

    it("the job first: the person's save (on the version they read) is exactly one 409, and the job's links stand", async () => {
      const zone = await area("Race one");
      const read = await prisma.securityZone.findUniqueOrThrow({ where: { id: zone.id } });
      await runSecurityLinkProposals(prisma, NOW);
      const err = await replaceZoneLinks(prisma, ctx, zone.id, { links: [{ sourceKind: "camera", sourceRef: A }, { sourceKind: "camera", sourceRef: C }], expectedVersion: read.version }, deps()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
      const rows = await links(zone.id);
      expect(rows.find((r) => r.sourceRef === B)).toMatchObject({ state: "active", origin: "droplet" });
    });

    it("the person first: the job loses its CAS and skips the area this hour — the person's links stand, nothing half-written", async () => {
      const zone = await area("Race two");
      // The job reads the area (version 0), then the person saves before the job writes: the save
      // runs inside the job's first event read, which comes after its area read.
      let saved = false;
      const racing = new Proxy(prisma, {
        get(target, prop) {
          if (prop === "securityEvent") {
            return {
              findMany: async (args: never) => {
                if (!saved) {
                  saved = true;
                  await replaceZoneLinks(prisma, ctx, zone.id, { links: [{ sourceKind: "camera", sourceRef: A }, { sourceKind: "camera", sourceRef: C }], expectedVersion: 0 }, deps());
                }
                return target.securityEvent.findMany(args);
              },
            };
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const run = await runSecurityLinkProposals(racing, NOW);
      expect(run).toMatchObject({ activated: 0, proposed: 0 });
      const rows = await links(zone.id);
      expect(rows.map((r) => [r.sourceRef, r.state, r.origin])).toEqual([
        [A, "active", "person"],
        [C, "active", "person"],
      ]);
      expect(await auditsFor(zone.id)).toEqual([]);
      // Next hour it looks again, against what the person saved.
      await runSecurityLinkProposals(prisma, new Date(NOW.getTime() + H));
      expect((await links(zone.id)).find((r) => r.sourceRef === B)).toMatchObject({ state: "active", origin: "droplet" });
      expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
    });
  });
});
