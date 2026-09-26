/**
 * WARP-2980 (ADR-059 P5 §6.3, §5.1) — coverage against REAL Postgres.
 *
 * What the mocked lane cannot prove:
 *   · "one open span per camera" is a DATABASE fact (the partial unique
 *     index), not a hope — a second open span is refused;
 *   · the span CHECK refuses a span that ends before it starts, a closed span
 *     with no closedAt, and a camera name Frigate could never send;
 *   · a real sequence of ticks: open, extend, a health change closes and
 *     reopens WITHOUT overlap, a restart (a new processId) closes the old
 *     process's span at its last confirmation;
 *   · the learning state lands as a row the source CHECK accepts.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 * FIXTURE SCOPING — every camera this file mints is `warp2980c_*`, and every
 * cleanup is scoped to that prefix. Dates are derived from the code's own
 * constants, never hand-written against "today".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

import { COVERAGE_KEEP_MS, recordCoverage, refreshBaselineSources, type CoverageObservation, type CoverageReading } from "./security-coverage.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2980c";
const CAM = `${TAG}_front`;
const CAM2 = `${TAG}_back`;
const T0 = new Date("2032-03-10T12:00:00Z");
const MIN = 60_000;
const at = (min: number) => new Date(T0.getTime() + min * MIN);

function obs(cameraSince: Record<string, Date>, subscribedAt = at(-120), frigateSince = at(-120)): CoverageObservation {
  const readings = new Map<string | null, CoverageReading>([[null, { health: "online", at: at(0), since: frigateSince }]]);
  for (const [c, since] of Object.entries(cameraSince)) readings.set(c, { health: "online", at: at(0), since });
  return {
    ingest: { frigateSubscribed: true, frigateSubscribedAt: subscribedAt, lastRecordedAt: at(-1), lastWriteError: null },
    readings,
    stats: { at: at(0), cameras: new Map(Object.keys(cameraSince).map((c) => [c, { fps: 5, detectionEnabled: true }])) },
  };
}

describe.skipIf(!RUN)("Coverage against real Postgres (WARP-2980)", () => {
  let prisma: PrismaClient;

  async function sweep(): Promise<void> {
    await prisma.securityCoverageSpan.deleteMany({ where: { camera: { startsWith: `${TAG}_` } } });
    await prisma.securityBaselineSource.deleteMany({ where: { camera: { startsWith: `${TAG}_` } } });
  }
  const spans = (camera: string) =>
    prisma.securityCoverageSpan.findMany({ where: { camera }, orderBy: { startedAt: "asc" } });

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });
  beforeEach(sweep);
  afterAll(async () => {
    await sweep();
    await prisma.$disconnect();
  });

  it("a second OPEN span for a camera is refused (SecurityCoverageSpan_one_open); a closed one is fine", async () => {
    const pid = randomUUID();
    await prisma.securityCoverageSpan.create({ data: { camera: CAM, state: "open", startedAt: at(-10), coveredUntil: at(-1), processId: pid } });
    await expect(
      prisma.securityCoverageSpan.create({ data: { camera: CAM, state: "open", startedAt: at(-5), coveredUntil: at(-1), processId: randomUUID() } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await prisma.securityCoverageSpan.create({
      data: { camera: CAM, state: "closed", startedAt: at(-30), coveredUntil: at(-20), processId: pid, closedAt: at(-20) },
    });
  });

  it.each([
    ["coveredUntil before startedAt", { state: "open", startedAt: at(0), coveredUntil: at(-1) }],
    ["closed with no closedAt", { state: "closed", startedAt: at(-2), coveredUntil: at(-1) }],
    ["open with a closedAt", { state: "open", startedAt: at(-2), coveredUntil: at(-1), closedAt: at(-1) }],
    ["a camera name Frigate never sends", { state: "open", startedAt: at(-2), coveredUntil: at(-1), camera: `${TAG} bad` }],
  ] as const)("the span CHECK refuses %s", async (_label, row) => {
    await expect(
      prisma.securityCoverageSpan.create({ data: { camera: CAM, processId: randomUUID(), ...row } as never }),
    ).rejects.toThrow(/SecurityCoverageSpan_shape|check constraint/i);
  });

  it("ticks: open, extend, a health change closes and reopens without overlap, a restart closes at the last confirmation", async () => {
    const p1 = randomUUID();
    // Tick 1 (boot): nothing open → one span per observed camera, from the proof.
    expect(await recordCoverage(prisma, obs({ [CAM]: at(-60), [CAM2]: at(-60) }), p1, at(0), { bootClose: true })).toMatchObject({ opened: 2 });
    // Tick 2: nothing changed → extended.
    expect(await recordCoverage(prisma, obs({ [CAM]: at(-60), [CAM2]: at(-60) }), p1, at(1), { bootClose: false })).toMatchObject({ extended: 2 });
    let rows = await spans(CAM);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "open", startedAt: at(-60), coveredUntil: at(1), processId: p1 });

    // CAM's detect stream blipped at +1.5 min (off and back on): its span closes at +1 and a new one starts at the change.
    const r3 = await recordCoverage(prisma, obs({ [CAM]: at(1.5), [CAM2]: at(-60) }), p1, at(2), { bootClose: false });
    expect(r3).toEqual({ extended: 1, closed: 1, opened: 1 });
    rows = await spans(CAM);
    expect(rows.map((r) => [r.state, r.startedAt.toISOString(), r.coveredUntil.toISOString()])).toEqual([
      ["closed", at(-60).toISOString(), at(1).toISOString()],
      ["open", at(1.5).toISOString(), at(2).toISOString()],
    ]);

    // A restart: a new process. Its first tick closes p1's spans at their last confirmation;
    // the new spans start no earlier than those ended (no minute counted twice).
    const p2 = randomUUID();
    const r4 = await recordCoverage(prisma, obs({ [CAM]: at(-60), [CAM2]: at(-60) }, at(-120)), p2, at(10), { bootClose: true });
    expect(r4.opened).toBe(2);
    rows = await spans(CAM);
    expect(rows.map((r) => [r.state, r.processId])).toEqual([
      ["closed", p1],
      ["closed", p1],
      ["open", p2],
    ]);
    expect(rows[1]!.coveredUntil).toEqual(at(2));
    expect(rows[2]!.startedAt.getTime()).toBeGreaterThanOrEqual(at(2).getTime());
    // One camera's spans never overlap.
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]!.startedAt.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.coveredUntil.getTime());
  });

  it("the learning state lands as rows the source CHECK accepts, and a camera gone 35 days is dropped", async () => {
    const pid = randomUUID();
    // Two full site (UTC) dates inside T0's window, and a camera last seen just past the keep horizon.
    const d7 = new Date("2032-03-07T00:00:00Z");
    const d9 = new Date("2032-03-09T00:00:00Z");
    await prisma.securityCoverageSpan.createMany({
      data: [
        { camera: CAM, state: "closed", startedAt: d7, coveredUntil: d9, processId: pid, closedAt: d9 },
        { camera: CAM2, state: "closed", startedAt: at(-60 * 1440), coveredUntil: new Date(T0.getTime() - COVERAGE_KEEP_MS - MIN), processId: pid, closedAt: at(-40 * 1440) },
      ],
    });
    await prisma.securityBaselineSource.create({
      data: { sourceKey: `camera:${CAM2}`, camera: CAM2, state: "stale", daysObserved: 0, firstSeenAt: at(-60 * 1440), lastSeenAt: at(-40 * 1440), stateChangedAt: at(-38 * 1440) },
    });
    await refreshBaselineSources(prisma, "UTC", T0);
    const rows = await prisma.securityBaselineSource.findMany({ where: { camera: { startsWith: `${TAG}_` } } });
    expect(rows.map((r) => [r.sourceKey, r.state, r.daysObserved])).toEqual([[`camera:${CAM}`, "learning", 2]]);
  });
});
