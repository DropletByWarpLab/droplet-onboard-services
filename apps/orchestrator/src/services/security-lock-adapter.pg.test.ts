/**
 * WARP-2977 P2b-2 (spec §6.8, §9 PR-2) — the Matter lock adapter's store
 * against REAL Postgres.
 *
 * WHY THESE CASES RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   one row      — "two bridges (or two replicas) collapse to one row" rests
 *                  on the deterministic dedupeKey landing on the unique
 *                  index. A mocked client proves the key is built; only
 *                  Postgres proves the second insert is absorbed.
 *   outcomes     — `writeSecurityEvent` must tell `duplicate` (count 0 on
 *                  skipDuplicates) from `failed` (the database refused). The
 *                  tracker moves its memory only on the first; a CHECK
 *                  violation is the real "failed".
 *   read-back    — a restart reads the latest reading from the store, newest
 *                  `startedAt` first and the id as tiebreak, on the
 *                  (sourceRef, startedAt) index.
 *   the CHECK    — every draft the adapter builds (each reading, live and
 *                  polled) passes SecurityEvent_lock_shape.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 *
 * FIXTURE SCOPING — a lock row's sourceRef is `matter:<digits>/<digits>` by
 * CHECK, so it cannot carry a text tag. This file owns the node ids
 * 2977000001..2977000099 (no real fabric assigns node ids like that on a CI
 * database), every lock name it writes starts `warp2977b`, and every
 * cleanup is scoped to those refs. Times derive from the clock, inside the
 * retention window, so no other suite's retention trim can reach them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

import {
  createLockTracker,
  createPrismaLockStore,
  createSecurityLockAdapter,
  LOCK_READINGS,
  lockRowDraft,
  type LockDeviceSource,
  type LockLogger,
  type LockObservation,
  type LockReading,
} from "./security-lock-adapter.js";
import { SECURITY_EVENT_RETENTION_DAYS, writeSecurityEvent } from "./security-events.service.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2977b";
const NODE_BASE = 2_977_000_000;
const node = (n: number): string => String(NODE_BASE + n);
const ref = (n: number, ep = 1): string => `matter:${node(n)}/${ep}`;
const ALL_REFS = Array.from({ length: 99 }, (_, i) => [ref(i + 1, 1), ref(i + 1, 2)]).flat();

/** Inside the retention window, derived from the code's own constant. */
const recent = (msAgo: number): Date => new Date(Date.now() - Math.min(msAgo, (SECURITY_EVENT_RETENTION_DAYS - 1) * 86_400_000));

const quiet: LockLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const obs = (n: number, reading: LockReading, ep = 1): LockObservation => ({
  nodeId: node(n),
  endpointId: ep,
  ref: ref(n, ep),
  reading,
});

describe.skipIf(!RUN)("Matter lock adapter store — real Postgres (WARP-2977 P2b-2)", () => {
  let prisma: PrismaClient;

  async function cleanup(): Promise<void> {
    await prisma.securityEvent.deleteMany({ where: { source: "matter_lock", sourceRef: { in: ALL_REFS } } });
  }

  const rowsOf = (r: string) =>
    prisma.securityEvent.findMany({
      where: { source: "matter_lock", sourceRef: r },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: { id: true, labels: true, dedupeKey: true, observed: true, camera: true, kind: true, summary: true, severity: true },
    });

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("first sight writes a baseline; the same reading again writes nothing; a change chains after the stored row", async () => {
    const tracker = createLockTracker({ store: createPrismaLockStore(prisma), logger: quiet, nameOf: () => `${TAG} Back door` });
    expect(await tracker.observe(obs(1, "locked"), "live")).toBe("recorded");
    expect(await tracker.observe(obs(1, "locked"), "live")).toBe("unchanged");
    expect(await tracker.observe(obs(1, "unlocked"), "live")).toBe("recorded");

    const rows = await rowsOf(ref(1));
    expect(rows.map((r) => r.labels)).toEqual([["locked"], ["unlocked"]]);
    expect(rows[0]).toMatchObject({
      kind: "lock_state",
      camera: null,
      observed: "live",
      severity: "info",
      dedupeKey: `matter_lock:${node(1)}/1:after:none:locked`,
      summary: `${TAG} Back door: locked`,
    });
    expect(rows[1]!.dedupeKey).toBe(`matter_lock:${node(1)}/1:after:${rows[0]!.id}:unlocked`);
  });

  it("a restart (a fresh tracker) reads the history back: no repeat of the stored reading, and the next change chains after it", async () => {
    const store = createPrismaLockStore(prisma);
    const before = createLockTracker({ store, logger: quiet });
    await before.observe(obs(2, "unlocked"), "live");
    const [stored] = await rowsOf(ref(2));

    const after = createLockTracker({ store, logger: quiet });
    expect(await after.observe(obs(2, "unlocked"), "live")).toBe("unchanged");
    expect(await after.observe(obs(2, "not_fully_locked"), "live")).toBe("recorded");
    const rows = await rowsOf(ref(2));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ severity: "notice", dedupeKey: `matter_lock:${node(2)}/1:after:${stored!.id}:not_fully_locked` });
  });

  it("two trackers (two bridges) seeing the same change write exactly ONE row — the dedupeKey is deterministic", async () => {
    const store = createPrismaLockStore(prisma);
    const a = createLockTracker({ store, logger: quiet });
    const b = createLockTracker({ store, logger: quiet });
    const outcomes = await Promise.all([a.observe(obs(3, "unlatched"), "live"), b.observe(obs(3, "unlatched"), "live")]);
    expect([...outcomes].sort()).toEqual(["duplicate", "recorded"]);
    expect(await rowsOf(ref(3))).toHaveLength(1);

    // …and both chain the NEXT change after the same row, so it too is one row.
    await Promise.all([a.observe(obs(3, "locked"), "live"), b.observe(obs(3, "locked"), "live")]);
    const rows = await rowsOf(ref(3));
    expect(rows.map((r) => r.labels[0])).toEqual(["unlatched", "locked"]);
  });

  it("writeSecurityEvent: recorded, then duplicate on the same key, and failed when the CHECK refuses — never conflated", async () => {
    const good = lockRowDraft({ obs: obs(4, "locked"), prevId: null, name: `${TAG} Gate`, via: "live", at: recent(1_000) });
    expect(await writeSecurityEvent(prisma, good)).toBe("recorded");
    expect(await writeSecurityEvent(prisma, good)).toBe("duplicate");
    const refused = { ...good, dedupeKey: `${good.dedupeKey}:bad`, labels: ["open"] as never };
    expect(await writeSecurityEvent(prisma, refused)).toBe("failed");
    expect(await rowsOf(ref(4))).toHaveLength(1);
  });

  it("lastReading: the newest startedAt wins, and the larger id breaks a tie", async () => {
    const store = createPrismaLockStore(prisma);
    const at = recent(60_000);
    await writeSecurityEvent(prisma, lockRowDraft({ obs: obs(5, "locked"), prevId: null, name: TAG, via: "live", at: recent(120_000) }));
    await writeSecurityEvent(prisma, lockRowDraft({ obs: obs(5, "unlocked"), prevId: "x", name: TAG, via: "live", at }));
    await writeSecurityEvent(prisma, lockRowDraft({ obs: obs(5, "unlatched"), prevId: "y", name: TAG, via: "live", at }));
    const last = await store.lastReading(ref(5));
    const rows = await rowsOf(ref(5));
    expect(last).toEqual({ id: rows[2]!.id.toString(), reading: "unlatched" });
    expect(await store.lastReading(ref(6))).toBeNull();
  });

  it("every draft the adapter builds passes SecurityEvent_lock_shape — each reading, live and polled", async () => {
    let n = 0;
    for (const reading of LOCK_READINGS) {
      for (const via of ["live", "polled"] as const) {
        const draft = lockRowDraft({ obs: obs(10 + n++, reading), prevId: null, name: `${TAG} Lock`, via, at: recent(1_000) });
        expect(await writeSecurityEvent(prisma, draft), `${reading}/${via}`).toBe("recorded");
      }
    }
  });

  it("the sweep writes a POLLED row, found when Droplet checked, through the real store", async () => {
    const source: LockDeviceSource = {
      list: async () => [
        {
          nodeId: node(30),
          name: "Smart Lock",
          friendlyName: `${TAG} Side door`,
          connectionState: "connected",
          endpoints: [{ endpointId: 1, deviceTypes: [], clusters: [257] }],
          attributes: { lockState: 2 },
        },
      ],
      bridgeUp: () => true,
    };
    const adapter = createSecurityLockAdapter({
      store: createPrismaLockStore(prisma),
      source,
      subscribeStateChanges: () => () => undefined,
      logger: quiet,
    });
    expect(await adapter.sweep()).toMatchObject({ status: "ok", recorded: 1 });
    expect(await rowsOf(ref(30))).toEqual([
      expect.objectContaining({ observed: "polled", labels: ["unlocked"], summary: `${TAG} Side door: unlocked (found when Droplet checked)` }),
    ]);
    // A second sweep with nothing new writes nothing.
    expect(await adapter.sweep()).toMatchObject({ status: "ok", recorded: 0 });
    expect(await rowsOf(ref(30))).toHaveLength(1);
  });
});
