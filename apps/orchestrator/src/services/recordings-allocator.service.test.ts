import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRecordingsAllocator,
  MAX_AUTO_RETRIES,
  RETRY_DELAYS_MS,
  TITLE_MOVE_GAVE_UP,
  TITLE_MOVED,
  TITLE_SETTING_ASIDE,
} from "./recordings-allocator.service.js";
import { GIB } from "./recordings-sizing.js";
import {
  RecordingsError,
  type AllocationRecord,
  type NvrHostStatus,
  type NvrMigrationStatus,
  type RecordingsDriveCandidate,
  type RecordingsFacts,
} from "./recordings.types.js";
import type { RecordingsBridge } from "./recordings-bridge.client.js";

const T0 = new Date("2026-10-03T12:00:00.000Z");
const FS_A = "aaaaaaaa-0000-0000-0000-000000000001";
const FS_B = "bbbbbbbb-0000-0000-0000-000000000002";
const g = (n: number): number => n * GIB;
const HOUR = 3_600_000;

// ── fakes ─────────────────────────────────────────────────────────────────────
type Row = {
  id: string; fsUuid: string; role: "RECORDINGS"; mode: "AUTO_RESERVED" | "FULL"; reservedBytes: bigint;
  status: AllocationRecord["status"]; migrationFailures: number; lastFailureAt: Date | null; createdAt: Date; updatedAt: Date;
};
const mkRow = (over: Partial<Row> & { id: string; fsUuid: string }): Row => ({
  role: "RECORDINGS", mode: "AUTO_RESERVED", reservedBytes: BigInt(g(100)), status: "ACTIVE",
  migrationFailures: 0, lastFailureAt: null, createdAt: T0, updatedAt: T0, ...over,
});

type Where = { id?: string | { not: string }; fsUuid?: string | { not: string }; role?: string; status?: { in: string[] } };
function matches(r: Row, w: Where | undefined): boolean {
  if (!w) return true;
  const eq = (v: string, c: string | { not: string } | undefined) => c === undefined || (typeof c === "string" ? v === c : v !== c.not);
  return eq(r.id, w.id) && eq(r.fsUuid, w.fsUuid) && (w.role === undefined || r.role === w.role) &&
    (w.status === undefined || w.status.in.includes(r.status));
}

function fakeDb(initial: Row[] = []) {
  const rows = [...initial];
  let seq = 1;
  const storageAllocation = {
    findMany: vi.fn(async (a?: { where?: Where }) => rows.filter((r) => matches(r, a?.where)).map((r) => ({ ...r }))),
    create: vi.fn(async (a: { data: Partial<Row> & { fsUuid: string } }) => {
      if (rows.some((r) => r.fsUuid === a.data.fsUuid)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
      const r = mkRow({ id: `row-${seq++}`, status: "PENDING", ...a.data });
      rows.push(r);
      return { ...r };
    }),
    updateMany: vi.fn(async (a: { where: Where; data: Partial<Row> }) => {
      let count = 0;
      for (const r of rows) if (matches(r, a.where)) { Object.assign(r, a.data); count++; }
      return { count };
    }),
    deleteMany: vi.fn(async (a: { where: Where }) => {
      const keep = rows.filter((r) => !matches(r, a.where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    }),
  };
  return { rows, prisma: { storageAllocation } as never };
}

const IDLE: NvrMigrationStatus = {
  state: "idle", job: null, phase: null, progressPct: 0, bytesCopied: 0, bytesTotal: 0, startedAt: null,
  finishedAt: null, error: null, errorCode: null, oldSource: null,
};
const mig = (over: Partial<NvrMigrationStatus>): NvrMigrationStatus => ({ ...IDLE, ...over });

const volumeHost = (): NvrHostStatus => ({
  source: "nvrdata", kind: "volume", fsUuid: null, mountPath: null, physicalDisk: "nvme0n1", backingDevices: [],
  isSystemDisk: true, encrypted: true, mounted: true, rw: true, projectId: null, limitBytes: null, usedBytes: null,
  fsSizeBytes: g(1000), fsFreeBytes: g(400),
});
const bayHost = (fsUuid: string, over: Partial<NvrHostStatus> = {}): NvrHostStatus => ({
  source: `/mnt/droplet/bay-${fsUuid.slice(0, 8)}/nvr`, kind: "path", fsUuid, mountPath: `/mnt/droplet/bay-${fsUuid.slice(0, 8)}`,
  physicalDisk: "sdb", backingDevices: ["sdb"], isSystemDisk: false, encrypted: true, mounted: true, rw: true,
  projectId: 4096, limitBytes: g(100), usedBytes: g(10), fsSizeBytes: g(1000), fsFreeBytes: g(800), ...over,
});
const drive = (fsUuid: string, over: Partial<RecordingsDriveCandidate> = {}): RecordingsDriveCandidate => ({
  fsUuid, label: "SECRET-LABEL", model: "M", sizeBytes: g(1000), usedBytes: g(100), freeBytes: g(900),
  mountPath: `/mnt/droplet/secret-${fsUuid.slice(0, 8)}`, mounted: true, readOnly: false, fsType: "ext4",
  encryption: "luks2", preparation: "prepared", isSystemDisk: false, smart: "PASSED", parentDisk: "sdb", ...over,
});

function factsFor(rows: Row[], over: Partial<RecordingsFacts> = {}, needGiB = 60): RecordingsFacts {
  const allocations: AllocationRecord[] = rows.map((r) => ({
    id: r.id, fsUuid: r.fsUuid, mode: r.mode, reservedBytes: Number(r.reservedBytes), status: r.status,
    migrationFailures: r.migrationFailures, lastFailureAt: r.lastFailureAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
  }));
  return {
    at: T0, allocation: allocations[0] ?? null, allocations, host: volumeHost(), hostError: null, migration: IDLE,
    drives: [drive(FS_A)], drivesError: null, frigate: null,
    sizing: { retentionDays: 7, cameras: [], sumBytes: g(needGiB), needTotalBytes: g(needGiB) },
    cameraNames: {}, ...over,
  };
}

function harness(initial: Row[] = [], factsOver: ((rows: Row[]) => Partial<RecordingsFacts>) | Partial<RecordingsFacts> = {}, needGiB = 60) {
  const db = fakeDb(initial);
  let clock = T0;
  const calls: string[] = [];
  const bridge = {
    getNvrStatus: vi.fn(), getDrivesSnapshot: vi.fn(),
    getMigration: vi.fn(async () => IDLE),
    applyNvrTarget: vi.fn(async (r: { fsUuid: string; mode: string; limitBytes?: number }) => { calls.push(`apply ${r.fsUuid} ${r.mode} ${r.limitBytes ?? "-"}`); }),
    resizeNvr: vi.fn(async (n: number) => { calls.push(`resize ${n}`); }),
    startMigration: vi.fn(async (fs: string) => { calls.push(`migrate ${fs}`); }),
    deleteOldFootage: vi.fn(async () => { calls.push("delete-old"); }),
  } satisfies Record<keyof RecordingsBridge, unknown>;
  const notifyOwners = vi.fn(async (_t: string, _b: string) => undefined);
  const recordActivity = vi.fn(async (_p: unknown) => null);
  const collectFacts = vi.fn(async () => {
    const o = typeof factsOver === "function" ? factsOver(db.rows) : factsOver;
    return factsFor(db.rows, { at: clock, ...o }, needGiB);
  });
  const sampleBitrates = vi.fn(async () => undefined);
  const allocator = createRecordingsAllocator({
    prisma: db.prisma, bridge: bridge as unknown as RecordingsBridge, collectFacts, sampleBitrates, notifyOwners,
    recordActivity: recordActivity as never, now: () => clock,
  });
  return { ...db, allocator, bridge, calls, notifyOwners, recordActivity, collectFacts, sampleBitrates, setClock: (d: Date) => { clock = d; } };
}

const all = (h: ReturnType<typeof harness>) => JSON.stringify([h.notifyOwners.mock.calls, h.recordActivity.mock.calls]);

describe("recordings allocator (WARP-3514)", () => {
  describe("no allocation yet", () => {
    it("no eligible drive → nothing happens (this is the box until a prepared drive exists)", async () => {
      const h = harness([], { drives: [drive(FS_A, { encryption: "unknown", preparation: "unknown" })] });
      expect(await h.allocator.reconcile()).toEqual({ action: "no_eligible_drive" });
      expect(h.rows).toHaveLength(0);
      expect(h.calls).toEqual([]);
      expect(h.sampleBitrates).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["unencrypted", { encryption: "none" as const }],
      ["not prepared", { preparation: "needs_preparing" as const }],
      ["the OS disk", { isSystemDisk: true }],
      ["read-only", { readOnly: true }],
      ["SMART failed", { smart: "FAILED" as const }],
    ])("never allocates on a drive that is %s", async (_n, over) => {
      const h = harness([], { drives: [drive(FS_A, over)] });
      expect((await h.allocator.reconcile()).action).toBe("no_eligible_drive");
      expect(h.rows).toHaveLength(0);
    });

    it("creates an AUTO_RESERVED row (reserved = need), applies it, starts the move, tells the owner once", async () => {
      const h = harness([], { drives: [drive(FS_A, { freeBytes: g(900) }), drive(FS_B, { freeBytes: g(300) })] }, 60);
      const out = await h.allocator.reconcile();
      expect(out).toEqual({ action: "created", detail: "applied_and_migrating" });
      expect(h.rows).toHaveLength(1);
      expect(h.rows[0]).toMatchObject({ fsUuid: FS_A, mode: "AUTO_RESERVED", status: "MIGRATING", reservedBytes: BigInt(g(60)) });
      expect(h.calls).toEqual([`apply ${FS_A} reserved ${g(60)}`, `migrate ${FS_A}`]);
      expect(h.notifyOwners).toHaveBeenCalledTimes(1);
      expect(h.notifyOwners.mock.calls[0]![0]).toBe(TITLE_SETTING_ASIDE);
      expect(h.recordActivity).toHaveBeenCalledTimes(1);
    });

    it("waits without creating or migrating while resolved Frigate retention is unknown", async () => {
      const h = harness([], { sizing: { ...factsFor([]).sizing, retentionKnown: false } }, 90);
      expect(await h.allocator.reconcile()).toEqual({
        action: "none",
        detail: "waiting for Frigate's resolved recording retention settings",
      });
      expect(h.rows).toHaveLength(0);
      expect(h.bridge.applyNvrTarget).not.toHaveBeenCalled();
      expect(h.bridge.startMigration).not.toHaveBeenCalled();
    });

    it("leaves an existing AUTO_RESERVED target pending until its retention is verified", async () => {
      const h = harness(
        [mkRow({ id: "r1", fsUuid: FS_A, status: "PENDING" })],
        { sizing: { ...factsFor([]).sizing, retentionKnown: false } },
      );
      expect(await h.allocator.reconcile()).toEqual({
        action: "none",
        detail: "waiting for Frigate's resolved recording retention settings",
      });
      expect(h.rows[0]!.status).toBe("PENDING");
      expect(h.bridge.applyNvrTarget).not.toHaveBeenCalled();
      expect(h.bridge.startMigration).not.toHaveBeenCalled();
    });

    it("the reservation never exceeds what the drive has free", async () => {
      const h = harness([], { drives: [drive(FS_A, { freeBytes: g(50) })] }, 80);
      await h.allocator.reconcile();
      expect(h.rows[0]!.reservedBytes).toBe(BigInt(g(50)));
    });

    it("a refused apply leaves the row PENDING (retried next tick) and does not start a move", async () => {
      const h = harness([], { drives: [drive(FS_A)] });
      h.bridge.applyNvrTarget.mockRejectedValueOnce(new RecordingsError("host_refused", "no", "os_disk"));
      const out = await h.allocator.reconcile();
      expect(out.action).toBe("created");
      expect(out.detail).toBe("none");
      expect(h.rows[0]!.status).toBe("PENDING");
      expect(h.bridge.startMigration).not.toHaveBeenCalled();
    });

    it("no label or mount path ever reaches a notification or an audit row (WARP-3466)", async () => {
      const h = harness([], { drives: [drive(FS_A)] });
      await h.allocator.reconcile();
      expect(all(h)).not.toMatch(/SECRET-LABEL|\/mnt\//);
    });
  });

  describe("an unreachable bridge is not an answer", () => {
    it.each([["host", { hostError: "down", host: null }], ["drives", { drivesError: "down", drives: [] }]])(
      "%s outage → no state change, no host call, no row",
      async (_n, over) => {
        const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "ACTIVE" })], over as Partial<RecordingsFacts>);
        expect((await h.allocator.reconcile()).action).toBe("bridge_unavailable");
        expect(h.rows[0]!.status).toBe("ACTIVE");
        expect(h.calls).toEqual([]);
        expect(h.notifyOwners).not.toHaveBeenCalled();
      },
    );
  });

  describe("the move", () => {
    const pending = () => [mkRow({ id: "r1", fsUuid: FS_A, status: "PENDING" })];

    it("PENDING → apply → migrate → MIGRATING", async () => {
      const h = harness(pending());
      expect((await h.allocator.reconcile()).action).toBe("applied_and_migrating");
      expect(h.rows[0]!.status).toBe("MIGRATING");
      expect(h.calls).toEqual([`apply ${FS_A} reserved ${g(100)}`, `migrate ${FS_A}`]);
    });

    it("FULL rows apply with mode full and no limit", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "PENDING", mode: "FULL", reservedBytes: BigInt(g(1000)) })]);
      await h.allocator.reconcile();
      expect(h.calls[0]).toBe(`apply ${FS_A} full -`);
    });

    it("busy after a successful apply means the job is already running — recorded as MIGRATING", async () => {
      const h = harness(pending());
      h.bridge.startMigration.mockRejectedValueOnce(new RecordingsError("busy", "running"));
      expect((await h.allocator.reconcile()).action).toBe("applied_and_migrating");
      expect(h.rows[0]!.status).toBe("MIGRATING");
    });

    it("running → left alone", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "MIGRATING" })], { migration: mig({ state: "running", job: "migrate" }) });
      expect((await h.allocator.reconcile()).action).toBe("migration_running");
      expect(h.calls).toEqual([]);
    });

    it("done → ACTIVE, counters reset, the owner is told", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "MIGRATING", migrationFailures: 2 })], { migration: mig({ state: "done", job: "migrate" }) });
      expect((await h.allocator.reconcile()).action).toBe("migration_done");
      expect(h.rows[0]).toMatchObject({ status: "ACTIVE", migrationFailures: 0, lastFailureAt: null });
      expect(h.notifyOwners.mock.calls[0]![0]).toBe(TITLE_MOVED);
    });

    it("a drive SWITCH: on success the OLD row is deleted and the new one is ACTIVE", async () => {
      const h = harness(
        [mkRow({ id: "old", fsUuid: FS_A, status: "ACTIVE" }), mkRow({ id: "new", fsUuid: FS_B, status: "MIGRATING" })],
        { host: bayHost(FS_A), drives: [drive(FS_A), drive(FS_B)], migration: mig({ state: "done", job: "migrate" }) },
      );
      await h.allocator.reconcile();
      expect(h.rows.map((r) => [r.id, r.status])).toEqual([["new", "ACTIVE"]]);
    });

    it("failed → DEGRADED, one failure counted, the clock set", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "MIGRATING" })], { migration: mig({ state: "failed", job: "migrate", errorCode: "copy_failed" }) });
      expect((await h.allocator.reconcile()).action).toBe("migration_failed");
      expect(h.rows[0]).toMatchObject({ status: "DEGRADED", migrationFailures: 1, lastFailureAt: T0 });
      expect(h.notifyOwners).not.toHaveBeenCalled();
    });

    it("idle (the bridge lost its record) → the move is started again", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "MIGRATING" })], { migration: IDLE });
      await h.allocator.reconcile();
      expect(h.calls).toEqual([`migrate ${FS_A}`]);
      expect(h.rows[0]!.status).toBe("MIGRATING");
    });

    it("a drive that vanishes mid-move is marked MISSING, and is picked up again when it returns", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "MIGRATING" })], { drives: [] });
      expect((await h.allocator.reconcile()).action).toBe("marked_missing");
      expect(h.rows[0]!.status).toBe("MISSING");
      const back = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "MISSING" })]);
      expect((await back.allocator.reconcile()).action).toBe("recovered");
      expect(back.rows[0]!.status).toBe("MIGRATING");
    });
  });

  describe("retries after a failed move: 1 h, 6 h, 24 h, then the owner", () => {
    it("the schedule is the decided one", () => {
      expect(RETRY_DELAYS_MS).toEqual([1 * HOUR, 6 * HOUR, 24 * HOUR]);
      expect(MAX_AUTO_RETRIES).toBe(3);
    });

    it.each([
      [1, 1 * HOUR],
      [2, 6 * HOUR],
      [3, 24 * HOUR],
    ])("after failure %i the retry waits its delay, then runs", async (failures, delay) => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "DEGRADED", migrationFailures: failures, lastFailureAt: T0 })]);
      h.setClock(new Date(T0.getTime() + delay - 1));
      expect((await h.allocator.reconcile()).action).toBe("none");
      expect(h.calls).toEqual([]);
      h.setClock(new Date(T0.getTime() + delay));
      expect((await h.allocator.reconcile()).action).toBe("applied_and_migrating");
      expect(h.rows[0]!.status).toBe("MIGRATING");
    });

    it("the 4th failure ends the automatic attempts: PENDING, one 'gave up' notification, no more retries", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "MIGRATING", migrationFailures: 3, lastFailureAt: T0 })], {
        migration: mig({ state: "failed", job: "migrate", errorCode: "verify_failed" }),
      });
      await h.allocator.reconcile();
      expect(h.rows[0]).toMatchObject({ status: "PENDING", migrationFailures: 4 });
      expect(h.notifyOwners.mock.calls.map((c) => c[0])).toEqual([TITLE_MOVE_GAVE_UP]);
      h.setClock(new Date(T0.getTime() + 1000 * HOUR));
      const again = await h.allocator.reconcile();
      expect(again.action).toBe("none");
      expect(h.calls).toEqual([]);
    });
  });

  describe("the live slice", () => {
    const live = (over: Partial<Row> = {}) => [mkRow({ id: "r1", fsUuid: FS_A, status: "ACTIVE", ...over })];
    const bay = (over: Partial<NvrHostStatus> = {}) => ({ host: bayHost(FS_A, over), drives: [drive(FS_A)] });

    it("a healthy slice with room: nothing to do", async () => {
      const h = harness(live(), bay(), 60);
      expect((await h.allocator.reconcile()).action).toBe("none");
      expect(h.calls).toEqual([]);
    });

    it("grows when the need passes 85 % of the reservation: to need x 1.1", async () => {
      const h = harness(live({ reservedBytes: BigInt(g(100)) }), bay({ usedBytes: g(40) }), 95);
      const out = await h.allocator.reconcile();
      expect(out.action).toBe("grew");
      expect(h.calls).toEqual([`resize ${Math.ceil(g(95) * 1.1)}`]);
      expect(h.rows[0]!.reservedBytes).toBe(BigInt(Math.ceil(g(95) * 1.1)));
      expect(h.rows[0]!.status).toBe("ACTIVE");
    });

    it("does not grow an AUTO_RESERVED slice from fallback sizing while Frigate retention is unknown", async () => {
      const h = harness(
        live({ reservedBytes: BigInt(g(100)) }),
        { ...bay({ usedBytes: g(40) }), sizing: { ...factsFor([]).sizing, retentionKnown: false } },
        500,
      );
      expect(await h.allocator.reconcile()).toEqual({ action: "none" });
      expect(h.calls).toEqual([]);
      expect(h.rows[0]!.reservedBytes).toBe(BigInt(g(100)));
      expect(h.rows[0]!.status).toBe("ACTIVE");
    });

    it("never shrinks: a smaller need leaves the reservation alone", async () => {
      const h = harness(live({ reservedBytes: BigInt(g(500)) }), bay({ limitBytes: g(500) }), 30);
      await h.allocator.reconcile();
      expect(h.calls).toEqual([]);
      expect(h.rows[0]!.reservedBytes).toBe(BigInt(g(500)));
    });

    it("grows only as far as the drive allows: partial growth is DEGRADED", async () => {
      const h = harness(live({ reservedBytes: BigInt(g(100)) }), bay({ usedBytes: g(90), fsFreeBytes: g(30), fsSizeBytes: g(1000) }), 130);
      await h.allocator.reconcile();
      expect(h.calls).toEqual([`resize ${g(120)}`]);
      expect(h.rows[0]!.status).toBe("DEGRADED");
    });

    it("no room at all: DEGRADED and no resize", async () => {
      const h = harness(live({ reservedBytes: BigInt(g(100)) }), bay({ usedBytes: g(95), fsFreeBytes: 0 }), 130);
      expect((await h.allocator.reconcile()).action).toBe("degraded");
      expect(h.calls).toEqual([]);
      expect(h.rows[0]!.status).toBe("DEGRADED");
    });

    it("a DEGRADED slice recovers to ACTIVE once the room is back", async () => {
      const h = harness(live({ status: "DEGRADED" }), bay(), 60);
      expect((await h.allocator.reconcile()).action).toBe("recovered");
      expect(h.rows[0]!.status).toBe("ACTIVE");
    });

    it("FULL: the quota is brought up to the filesystem size", async () => {
      const h = harness(live({ mode: "FULL", reservedBytes: BigInt(g(1000)) }), bay({ limitBytes: g(100) }));
      await h.allocator.reconcile();
      expect(h.calls).toEqual([`resize ${g(1000)}`]);
    });

    it.each([
      ["read-only", { readOnly: true }],
      ["SMART failed", { smart: "FAILED" as const }],
    ])("a %s drive is DEGRADED and is never moved", async (_n, over) => {
      const h = harness(live(), { host: bayHost(FS_A), drives: [drive(FS_A, over)] });
      await h.allocator.reconcile();
      expect(h.rows[0]!.status).toBe("DEGRADED");
      expect(h.calls).toEqual([]);
    });

    it("the drive disappears → MISSING; back → ACTIVE", async () => {
      const gone = harness(live(), { host: bayHost(FS_A, { mounted: false }), drives: [] });
      expect((await gone.allocator.reconcile()).action).toBe("marked_missing");
      expect(gone.rows[0]!.status).toBe("MISSING");
      const back = harness(live({ status: "MISSING" }), bay());
      expect((await back.allocator.reconcile()).action).toBe("recovered");
      expect(back.rows[0]!.status).toBe("ACTIVE");
    });

    it("drift: the row says bay drive but Frigate records on the OS volume → prepared and moved again", async () => {
      const h = harness(live(), { host: volumeHost(), drives: [drive(FS_A)] });
      expect((await h.allocator.reconcile()).action).toBe("applied_and_migrating");
      expect(h.calls).toEqual([`apply ${FS_A} reserved ${g(100)}`, `migrate ${FS_A}`]);
    });

    it("a refused resize keeps the size and degrades (never throws into the cron)", async () => {
      const h = harness(live({ reservedBytes: BigInt(g(100)) }), bay({ usedBytes: g(40) }), 95);
      h.bridge.resizeNvr.mockRejectedValueOnce(new RecordingsError("host_refused", "x", "quota_failed"));
      expect((await h.allocator.reconcile()).action).toBe("degraded");
      expect(h.rows[0]!.status).toBe("DEGRADED");
    });
  });

  describe("concurrency", () => {
    it("a tick that finds the lock held returns at once; the first one finishes normally", async () => {
      const h = harness([], { drives: [] });
      let release: () => void = () => undefined;
      h.collectFacts.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(factsFor([], { drives: [] })); }));
      const first = h.allocator.reconcile();
      await Promise.resolve();
      expect(await h.allocator.reconcile()).toEqual({ action: "none", detail: "another recordings operation is running" });
      release();
      expect((await first).action).toBe("no_eligible_drive");
    });
  });

  describe("pollMigration", () => {
    it("does nothing (no bridge call) unless a row is MIGRATING", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "ACTIVE" })]);
      await h.allocator.pollMigration();
      expect(h.bridge.getMigration).not.toHaveBeenCalled();
    });

    it("moves a finished job to ACTIVE", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "MIGRATING" })]);
      h.bridge.getMigration.mockResolvedValueOnce(mig({ state: "done", job: "migrate" }));
      await h.allocator.pollMigration();
      expect(h.rows[0]!.status).toBe("ACTIVE");
    });

    it("an unreachable status changes nothing", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A, status: "MIGRATING" })]);
      h.bridge.getMigration.mockRejectedValueOnce(new RecordingsError("bridge_unavailable", "down"));
      await h.allocator.pollMigration();
      expect(h.rows[0]!.status).toBe("MIGRATING");
    });
  });

  describe("setAllocation (the owner's confirmed PUT)", () => {
    const actor = { type: "user" as const, id: "u-1" };
    const liveA = () => [mkRow({ id: "old", fsUuid: FS_A, status: "ACTIVE" })];
    const onA = { host: bayHost(FS_A), drives: [drive(FS_A), drive(FS_B)] };

    it("a different drive: the live row stays, a PENDING target is created, prepared and moved", async () => {
      const h = harness(liveA(), onA);
      await h.allocator.setAllocation({ fsUuid: FS_B }, actor);
      expect(h.rows.map((r) => [r.fsUuid, r.status])).toEqual([[FS_A, "ACTIVE"], [FS_B, "MIGRATING"]]);
      expect(h.calls).toEqual([`apply ${FS_B} reserved ${g(60)}`, `migrate ${FS_B}`]);
      expect(h.recordActivity.mock.calls[0]![0]).toMatchObject({ actor });
    });

    it("an ineligible drive is refused before anything changes", async () => {
      const h = harness(liveA(), { host: bayHost(FS_A), drives: [drive(FS_A), drive(FS_B, { encryption: "none" })] });
      await expect(h.allocator.setAllocation({ fsUuid: FS_B }, actor)).rejects.toMatchObject({ code: "not_eligible" });
      expect(h.rows).toHaveLength(1);
      expect(h.calls).toEqual([]);
    });

    it("a host refusal surfaces to the owner and leaves no stray row behind", async () => {
      const h = harness(liveA(), onA);
      h.bridge.applyNvrTarget.mockRejectedValueOnce(new RecordingsError("host_refused", "no", "files_not_empty"));
      await expect(h.allocator.setAllocation({ fsUuid: FS_B, mode: "full" }, actor)).rejects.toMatchObject({ hostCode: "files_not_empty" });
      expect(h.rows.map((r) => r.fsUuid)).toEqual([FS_A]);
    });

    it("the first allocation can be chosen by hand (no row yet)", async () => {
      const h = harness([], { host: volumeHost(), drives: [drive(FS_A)] });
      await h.allocator.setAllocation({ fsUuid: FS_A, mode: "full" }, actor);
      expect(h.rows[0]).toMatchObject({ fsUuid: FS_A, mode: "FULL", status: "MIGRATING", reservedBytes: BigInt(g(1000)) });
      expect(h.calls[0]).toBe(`apply ${FS_A} full -`);
    });

    it("AUTO → FULL on the live drive: a quota change to the filesystem size, no move", async () => {
      const h = harness(liveA(), onA);
      await h.allocator.setAllocation({ mode: "full" }, actor);
      expect(h.calls).toEqual([`resize ${g(1000)}`]);
      expect(h.rows[0]).toMatchObject({ mode: "FULL", reservedBytes: BigInt(g(1000)) });
    });

    it("FULL → AUTO never goes below used x 1.1", async () => {
      const h = harness(
        [mkRow({ id: "old", fsUuid: FS_A, status: "ACTIVE", mode: "FULL", reservedBytes: BigInt(g(1000)) })],
        { host: bayHost(FS_A, { usedBytes: g(200), fsFreeBytes: g(800) }), drives: [drive(FS_A)] },
        60,
      );
      await h.allocator.setAllocation({ mode: "auto_reserved" }, actor);
      expect(h.calls).toEqual([`resize ${Math.ceil(g(200) * 1.1)}`]);
      expect(h.rows[0]!.mode).toBe("AUTO_RESERVED");
    });

    it("asking for what already is → no_change", async () => {
      const h = harness(liveA(), onA);
      await expect(h.allocator.setAllocation({ mode: "auto_reserved" }, actor)).rejects.toMatchObject({ code: "no_change" });
      await expect(h.allocator.setAllocation({ fsUuid: FS_A }, actor)).rejects.toMatchObject({ code: "no_change" });
    });

    it("a move that gave up is retried by the owner re-confirming the same drive (counters reset)", async () => {
      const h = harness(
        [mkRow({ id: "old", fsUuid: FS_A, status: "ACTIVE" }), mkRow({ id: "new", fsUuid: FS_B, status: "PENDING", migrationFailures: 4, lastFailureAt: T0 })],
        onA,
      );
      await h.allocator.setAllocation({ fsUuid: FS_B }, actor);
      const target = h.rows.find((r) => r.id === "new")!;
      expect(target).toMatchObject({ status: "MIGRATING", migrationFailures: 0, lastFailureAt: null });
    });

    it("a running job → busy; an unreachable bridge → bridge_unavailable", async () => {
      const busy = harness(liveA(), { ...onA, migration: mig({ state: "running", job: "migrate" }) });
      await expect(busy.allocator.setAllocation({ fsUuid: FS_B }, actor)).rejects.toMatchObject({ code: "busy" });
      const down = harness(liveA(), { hostError: "x", host: null });
      await expect(down.allocator.setAllocation({ fsUuid: FS_B }, actor)).rejects.toMatchObject({ code: "bridge_unavailable" });
    });

    it("the lock is released after a refusal, so the next call is not stuck", async () => {
      const h = harness(liveA(), onA);
      await expect(h.allocator.setAllocation({ mode: "auto_reserved" }, actor)).rejects.toBeInstanceOf(RecordingsError);
      await expect(h.allocator.setAllocation({ mode: "full" }, actor)).resolves.toEqual({ accepted: true });
    });
  });

  describe("deleteOldFootage", () => {
    const actor = { type: "user" as const, id: "owner-1" };
    const old = { kind: "volume" as const, source: "nvrdata", bytes: g(40), deleted: false };

    it("deletes the kept footage and audits it with the actor", async () => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A })], { host: bayHost(FS_A), migration: mig({ state: "done", job: "migrate", oldSource: old }) });
      await h.allocator.deleteOldFootage(actor);
      expect(h.calls).toEqual(["delete-old"]);
      expect(h.recordActivity.mock.calls[0]![0]).toMatchObject({ actor });
    });

    it.each([
      ["nothing kept", mig({}), "no_old_footage"],
      ["already deleted", mig({ oldSource: { ...old, deleted: true } }), "no_old_footage"],
      ["a job running", mig({ state: "running", job: "migrate", oldSource: old }), "busy"],
    ])("%s → %s", async (_n, migration, code) => {
      const h = harness([mkRow({ id: "r1", fsUuid: FS_A })], { host: bayHost(FS_A), migration });
      await expect(h.allocator.deleteOldFootage(actor)).rejects.toMatchObject({ code });
      expect(h.calls).toEqual([]);
    });
  });

  describe("getOverview / getFacts", () => {
    beforeEach(() => undefined);
    it("builds the contract shape from the same facts", async () => {
      const h = harness([], { drives: [drive(FS_A)], host: null });
      const o = await h.allocator.getOverview();
      expect(o.status).toBe("pending");
      expect(o.eligibleDrives).toHaveLength(1);
      expect((await h.allocator.getFacts()).allocations).toEqual([]);
    });
  });
});
