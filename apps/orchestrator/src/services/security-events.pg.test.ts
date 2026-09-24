/**
 * WARP-2977 (ADR-059 §3.3, DS-005) — the Security event store against REAL
 * Postgres.
 *
 * WHY THESE CASES RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   redelivery   — "a walk past a camera yields exactly one row" rests on the
 *                  unique `dedupeKey` + `createMany({ skipDuplicates })`. A
 *                  mocked client proves the flag is passed; only Postgres
 *                  proves the second insert lands on the constraint.
 *   visibility   — a camera outside the viewer's grant must be ABSENT. The
 *                  `where` is built in code; whether it really excludes a row
 *                  (NULL camera included, threats removed) is a database fact.
 *   paging       — rows sharing a `startedAt` must neither repeat nor vanish
 *                  across a page boundary.
 *   mirror       — the cursor really advances past ActivityRow ids, and a
 *                  second tick adds nothing.
 *   retention    — the trim deletes by `startedAt`, not `createdAt`.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 *
 * FIXTURE SCOPING — the DB is shared by the pg suites. Every row this file
 * mints is namespaced `warp2977` (dedupe keys, camera names, ActivityRow
 * text) and every cleanup is scoped to it. The one unscoped statement is the
 * code under test, `trimSecurityEvents`, which only reaches rows older than
 * 30 days — and no other suite writes SecurityEvent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

import {
  feedVisibilityWhere,
  listSecurityEvents,
  mirrorThreatRows,
  recordSecurityEvent,
  trimSecurityEvents,
} from "./security-events.service.js";
import { frigateEndToDraft, type SecurityEventDraft } from "./security-event-ingest.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2977";
const FRONT = `${TAG}_front`;
const BACK = `${TAG}_back`;
const NOW = new Date("2026-09-23T02:14:00Z");

function ev(key: string, over: Partial<SecurityEventDraft> = {}): SecurityEventDraft {
  return {
    source: "frigate",
    kind: "detection",
    severity: "info",
    camera: FRONT,
    sourceRef: `${FRONT}/${key}`,
    dedupeKey: `${TAG}:${key}`,
    labels: ["person"],
    cameraZones: [],
    score: 0.9,
    startedAt: NOW,
    endedAt: NOW,
    summary: "Person",
    observed: "live",
    ...over,
  };
}

describe.skipIf(!RUN)("Security event store — real Postgres (WARP-2977)", () => {
  let prisma: PrismaClient;
  const activityIds: bigint[] = [];

  async function cleanup() {
    await prisma.securityEvent.deleteMany({
      where: {
        OR: [
          { dedupeKey: { startsWith: `${TAG}:` } },
          { dedupeKey: { startsWith: "frigate:warp2977" } },
          { dedupeKey: { in: activityIds.map((id) => `activity:${id}`) } },
        ],
      },
    });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanup();
    if (activityIds.length > 0) await prisma.activityRow.deleteMany({ where: { id: { in: activityIds } } });
    await prisma.securityIngestState.deleteMany({ where: { id: "singleton" } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("a QoS-1 redelivered Frigate `end` is ONE row", async () => {
    const message = {
      type: "end",
      after: {
        id: `${TAG}-e1`,
        camera: FRONT,
        label: "person",
        start_time: NOW.getTime() / 1000,
        end_time: NOW.getTime() / 1000 + 9,
        top_score: 0.88,
        entered_zones: ["porch"],
      },
    };
    const first = frigateEndToDraft(message)!;
    const again = frigateEndToDraft(message)!;
    expect(await recordSecurityEvent(prisma, first)).toBe(true);
    expect(await recordSecurityEvent(prisma, again)).toBe(false);
    const rows = await prisma.securityEvent.findMany({ where: { dedupeKey: first.dedupeKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "detection", camera: FRONT, cameraZones: ["porch"], score: 0.88 });
    expect(rows[0].endedAt!.getTime() - rows[0].startedAt.getTime()).toBe(9_000);
  });

  it("a camera outside the grant is absent; camera-less rows stay; threats go for non-admins; locks go without Devices view", async () => {
    await prisma.securityEvent.createMany({
      data: [
        ev("front"),
        ev("back", { camera: BACK, sourceRef: `${BACK}/back` }),
        ev("frigate-down", {
          source: "frigate_status",
          kind: "source_offline",
          camera: null,
          sourceRef: "frigate/available",
        }),
        ev("threat", { source: "activity_mirror", kind: "threat", camera: null, sourceRef: "activity:0" }),
        // WARP-2977 P2b-2: a lock row is camera-less too — only the lock gate can remove it.
        ev("lock", {
          source: "matter_lock",
          kind: "lock_state",
          camera: null,
          sourceRef: "matter:2977000077/1",
          labels: ["unlocked"],
          score: null,
          endedAt: null,
        }),
      ],
    });
    const ours = { dedupeKey: { startsWith: `${TAG}:` } };
    const keys = async (visibility: ReturnType<typeof feedVisibilityWhere>) =>
      (await prisma.securityEvent.findMany({ where: { AND: [visibility, ours] }, select: { dedupeKey: true } }))
        .map((r) => r.dedupeKey.slice(TAG.length + 1))
        .sort();

    expect(await keys(feedVisibilityWhere("all", true, true))).toEqual(["back", "frigate-down", "front", "lock", "threat"]);
    expect(await keys(feedVisibilityWhere("all", true, false))).toEqual(["back", "frigate-down", "front", "threat"]);
    expect(await keys(feedVisibilityWhere(new Set([FRONT]), false, true))).toEqual(["frigate-down", "front", "lock"]);
    expect(await keys(feedVisibilityWhere(new Set([FRONT]), false, false))).toEqual(["frigate-down", "front"]);
    // No grants at all: an empty IN must match nothing, not everything.
    expect(await keys(feedVisibilityWhere(new Set(), false, false))).toEqual(["frigate-down"]);
  });

  it("paging over rows that share a startedAt neither repeats nor skips", async () => {
    await prisma.securityEvent.createMany({ data: ["p1", "p2", "p3", "p4", "p5"].map((k) => ev(k)) });
    const visibility = { AND: [feedVisibilityWhere(new Set([FRONT]), false, false), { dedupeKey: { startsWith: `${TAG}:p` } }] };
    const seen: string[] = [];
    let cursor: { startedAt: Date; id: bigint } | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await listSecurityEvents(prisma, visibility, { limit: 2, cursor, includeLow: false });
      seen.push(...page.events.map((e) => e.id));
      if (!page.nextCursor) break;
      const [ms, id] = page.nextCursor.split(".");
      cursor = { startedAt: new Date(Number(ms)), id: BigInt(id) };
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("detection_low is stored but hidden unless asked for", async () => {
    await prisma.securityEvent.createMany({ data: [ev("hi"), ev("lo", { kind: "detection_low", score: 0.4 })] });
    const visibility = { dedupeKey: { in: [`${TAG}:hi`, `${TAG}:lo`] } };
    const def = await listSecurityEvents(prisma, visibility, { limit: 10, includeLow: false });
    const all = await listSecurityEvents(prisma, visibility, { limit: 10, includeLow: true });
    expect(def.events.map((e) => e.kind)).toEqual(["detection"]);
    expect(all.events).toHaveLength(2);
  });

  it("the threat mirror copies warn/err network/auth rows once, and the cursor moves past them", async () => {
    const floor = await prisma.activityRow.aggregate({ _max: { id: true } });
    await prisma.securityIngestState.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", threatCursor: floor._max.id ?? 0n },
      update: { threatCursor: floor._max.id ?? 0n },
    });
    const mk = (kind: "auth" | "network" | "file", severity: "warn" | "err" | "info", what: string) =>
      prisma.activityRow.create({
        data: {
          kind,
          severity,
          what: `${TAG} ${what}`,
          sourceIcon: "shield",
          signature: `${TAG}-sig-${what}`,
          prevSignatureHash: "",
          schemaVersion: 2,
          actorType: "system",
          at: new Date(),
        },
        select: { id: true },
      });
    const rows = [
      await mk("auth", "warn", "failed sign-ins"),
      await mk("network", "err", "port scan"),
      await mk("auth", "info", "signed in"),
      await mk("file", "err", "indexer error"),
    ];
    activityIds.push(...rows.map((r) => r.id));

    const first = await mirrorThreatRows(prisma);
    const second = await mirrorThreatRows(prisma);
    expect(second.mirrored).toBe(0);
    expect(first.cursor).toBeGreaterThanOrEqual(rows[1].id);

    const mirrored = await prisma.securityEvent.findMany({
      where: { dedupeKey: { in: activityIds.map((id) => `activity:${id}`) } },
      orderBy: { id: "asc" },
    });
    expect(mirrored.map((m) => [m.summary, m.severity])).toEqual([
      [`${TAG} failed sign-ins`, "notice"],
      [`${TAG} port scan`, "alert"],
    ]);
  });

  it("retention deletes by when the event STARTED", async () => {
    const old = new Date(Date.now() - 31 * 86_400_000);
    await prisma.securityEvent.createMany({ data: [ev("old", { startedAt: old, endedAt: old }), ev("new", { startedAt: new Date() })] });
    const r = await trimSecurityEvents(prisma);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const left = await prisma.securityEvent.findMany({
      where: { dedupeKey: { in: [`${TAG}:old`, `${TAG}:new`] } },
      select: { dedupeKey: true },
    });
    expect(left.map((l) => l.dedupeKey)).toEqual([`${TAG}:new`]);
    const state = await prisma.securityIngestState.findUnique({ where: { id: "singleton" } });
    expect(state?.retentionRanAt).toBeInstanceOf(Date);
  });
});
