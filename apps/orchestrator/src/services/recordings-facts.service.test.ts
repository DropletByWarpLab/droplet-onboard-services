import { describe, expect, it, vi } from "vitest";
import { createFactsCollector, type FactsDeps } from "./recordings-facts.service.js";
import { GIB, MIB } from "./recordings-sizing.js";
import type { NvrHostStatus, NvrMigrationStatus, RecordingsFrigateFacts } from "./recordings.types.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const FS_A = "aaaaaaaa-0000-0000-0000-000000000001";
const FS_B = "bbbbbbbb-0000-0000-0000-000000000002";

const hostOn = (fsUuid: string | null, over: Partial<NvrHostStatus> = {}): NvrHostStatus => ({
  source: fsUuid ? "/mnt/droplet/bay-aaaaaaaa/nvr" : "nvrdata",
  kind: fsUuid ? "path" : "volume",
  fsUuid,
  mountPath: fsUuid ? "/mnt/droplet/bay-aaaaaaaa" : null,
  physicalDisk: fsUuid ? "sdb" : "nvme0n1",
  backingDevices: [],
  isSystemDisk: !fsUuid,
  encrypted: !!fsUuid,
  mounted: true,
  rw: true,
  projectId: fsUuid ? 4096 : null,
  limitBytes: null,
  usedBytes: null,
  fsSizeBytes: null,
  fsFreeBytes: null,
  ...over,
});

const IDLE: NvrMigrationStatus = {
  state: "idle", job: null, phase: null, progressPct: 0, bytesCopied: 0, bytesTotal: 0,
  startedAt: null, finishedAt: null, error: null, errorCode: null, oldSource: null,
};

const driveRaw = (uuid: string, over: Record<string, unknown> = {}) => ({
  device: "/dev/mapper/x", parent_disk: "sdb", mount: `/mnt/droplet/bay-${uuid.slice(0, 8)}`, label: "Bay",
  uuid, size_bytes: 1000 * GIB, used_bytes: 100 * GIB, free_bytes: 900 * GIB, mounted: true, fs: "ext4",
  encryption: "luks2", preparation: "prepared", ...over,
});

function row(id: string, fsUuid: string, status: string) {
  return {
    id, fsUuid, role: "RECORDINGS", mode: "AUTO_RESERVED", reservedBytes: BigInt(100 * GIB), status,
    migrationFailures: 0, lastFailureAt: null,
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-02T00:00:00Z"),
  };
}

function deps(over: {
  rows?: ReturnType<typeof row>[];
  host?: NvrHostStatus | Error;
  migration?: NvrMigrationStatus | Error;
  snapshot?: { drives: unknown[]; os_disk?: string; disks?: unknown[] } | Error;
  frigate?: RecordingsFrigateFacts | null;
  samples?: Array<{ camera: string; sampledAt: Date; mbPerHour: number }>;
  cameras?: Array<{ name: string; displayName: string; adoption: "CANDIDATE" | "ADOPTED" }>;
} = {}): FactsDeps {
  const fail = <T>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return {
    prisma: {
      storageAllocation: { findMany: vi.fn(async () => over.rows ?? []) },
      camera: { findMany: vi.fn(async (args: { where?: { adoption?: string } }) =>
        (over.cameras ?? [
          { name: "front", displayName: "Front Door", adoption: "ADOPTED" },
          { name: "garage", displayName: "Garage", adoption: "ADOPTED" },
        ]).filter((camera) => !args.where?.adoption || camera.adoption === args.where.adoption),
      ) },
      cameraBitrateSample: { findMany: vi.fn(async () => over.samples ?? []) },
    } as never,
    bridge: {
      getNvrStatus: vi.fn(() => fail(over.host ?? hostOn(FS_A))),
      getMigration: vi.fn(() => fail(over.migration ?? IDLE)),
      getDrivesSnapshot: vi.fn(() => fail(over.snapshot ?? { drives: [driveRaw(FS_A)] })),
    },
    getFrigate: vi.fn(async () => (over.frigate === undefined ? null : over.frigate)),
    now: () => NOW,
    resolveDefaults: () => ({ continuousDays: 7, motionDays: 7, alertsRetainDays: 7, detectionsRetainDays: 7 }),
  };
}

describe("collectRecordingsFacts (WARP-3514)", () => {
  it("does not reserve space or expose a label for a discovery candidate with stale matching bitrate history", async () => {
    const facts = await createFactsCollector(deps({
      cameras: [
        { name: "front", displayName: "Front Door", adoption: "ADOPTED" },
        { name: "old_candidate", displayName: "Unadopted candidate", adoption: "CANDIDATE" },
      ],
      samples: [
        { camera: "front", sampledAt: NOW, mbPerHour: 1000 },
        { camera: "old_candidate", sampledAt: NOW, mbPerHour: 100_000 },
      ],
    }))();
    expect(facts.cameraNames).toEqual({ front: "Front Door" });
    expect(facts.sizing.cameras.map((camera) => camera.name)).toEqual(["front"]);
    expect(facts.sizing.sumBytes).toBe(facts.sizing.cameras[0].needBytes);
  });

  it("assembles allocation, host, drives, migration, names and sizing", async () => {
    const samples = [
      { camera: "front", sampledAt: new Date(NOW.getTime() - 3_600_000), mbPerHour: 1000 },
      { camera: "front", sampledAt: new Date(NOW.getTime() - 7_200_000), mbPerHour: 900 },
    ];
    const facts = await createFactsCollector(deps({ rows: [row("1", FS_A, "ACTIVE")], samples }))();
    expect(facts.at).toEqual(NOW);
    expect(facts.allocation?.fsUuid).toBe(FS_A);
    expect(facts.allocations).toHaveLength(1);
    expect(typeof facts.allocation?.reservedBytes).toBe("number");
    expect(facts.host?.source).toBe("/mnt/droplet/bay-aaaaaaaa/nvr");
    expect(facts.hostError).toBeNull();
    expect(facts.drives.map((d) => d.fsUuid)).toEqual([FS_A]);
    expect(facts.drives[0]).toMatchObject({ encryption: "luks2", preparation: "prepared", isSystemDisk: false });
    expect(facts.cameraNames).toEqual({ front: "Front Door", garage: "Garage" });
    // history branch: max(p95, latest) = 1000 MiB/h x 24 x 7 x 1.25 x 1.02
    const front = facts.sizing.cameras.find((c) => c.name === "front");
    expect(front?.basis).toBe("history");
    expect(front?.needBytes).toBe(Math.ceil(1000 * MIB * 24 * 7 * 1.25 * 1.02));
    expect(facts.sizing.needTotalBytes).toBeGreaterThanOrEqual(20 * GIB);
    expect(facts.sizing.retentionDays).toBe(7);
  });

  it("a bridge outage is captured per source and NEVER thrown or defaulted", async () => {
    const facts = await createFactsCollector(
      deps({ host: new Error("status down"), migration: new Error("mig down"), snapshot: new Error("drives down") }),
    )();
    expect(facts.host).toBeNull();
    expect(facts.hostError).toBe("status down");
    expect(facts.migration).toBeNull();
    expect(facts.drives).toEqual([]);
    expect(facts.drivesError).toBe("drives down");
  });

  it("an empty drive list with no error is a real answer: no drives", async () => {
    const facts = await createFactsCollector(deps({ snapshot: { drives: [] } }))();
    expect(facts.drives).toEqual([]);
    expect(facts.drivesError).toBeNull();
  });

  it("drives the normaliser rejects are dropped; the OS disk flag and disk model flow through the snapshot context", async () => {
    const facts = await createFactsCollector(
      deps({
        snapshot: {
          drives: [driveRaw(FS_A, { parent_disk: "nvme0n1" }), { no: "uuid" }, driveRaw(FS_B, { parent_disk: "sdb" })],
          os_disk: "nvme0n1",
          disks: [{ name: "sdb", model: "Seagate" }],
        },
      }),
    )();
    expect(facts.drives.map((d) => [d.fsUuid, d.isSystemDisk, d.model])).toEqual([
      [FS_A, true, ""],
      [FS_B, false, "Seagate"],
    ]);
  });

  it("Frigate being unreachable is null in the facts, not a failure", async () => {
    const facts = await createFactsCollector(deps({ frigate: null }))();
    expect(facts.frigate).toBeNull();
  });

  it("while a switch is in flight the TARGET row is the subject and both rows are listed", async () => {
    const facts = await createFactsCollector(
      deps({ rows: [row("old", FS_A, "ACTIVE"), row("new", FS_B, "PENDING")], host: hostOn(FS_A) }),
    )();
    expect(facts.allocations.map((r) => r.id).sort()).toEqual(["new", "old"]);
    expect(facts.allocation?.id).toBe("new");
  });

  it("an unmounted bay source is not 'live': the host's fsUuid is ignored for subject selection", async () => {
    const facts = await createFactsCollector(
      deps({ rows: [row("1", FS_A, "ACTIVE")], host: hostOn(FS_A, { mounted: false }) }),
    )();
    expect(facts.allocation?.id).toBe("1");
  });
});
