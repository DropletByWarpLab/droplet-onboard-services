/**
 * WARP-3514 / ADR-070 — collect everything one allocator tick, one API read and
 * one health check decide from, ONCE, so all three agree.
 *
 * Every external source is asked independently and an outage is captured in its
 * own `*Error` field — never thrown, never turned into a default. The consumers
 * rely on that distinction: `host === null` means "the bridge could not be
 * asked", which the allocator answers with NO action at all (an unreachable
 * bridge is neither "recordings are fine" nor "recordings are on the OS disk"),
 * while an empty `drives` list with no error means "there really is no drive".
 */
import type { PrismaClient } from "@prisma/client";
import { getCameraStorageSnapshot } from "./camera-storage.service.js";
import { resolveRetentionDefaults } from "./camera-retention-defaults.js";
import { loadSamplesByCamera } from "./camera-bitrate-sampler.service.js";
import { loadRecordingsAllocations, selectSubjectAllocation } from "./recordings-capacity.js";
import { normalizeBridgeDrive } from "./recordings-eligibility.js";
import { computeSizing, sizingRetentionDays, type SizingRetentionWindows } from "./recordings-sizing.js";
import type { RecordingsBridge } from "./recordings-bridge.client.js";
import type {
  NvrHostStatus,
  NvrMigrationStatus,
  RecordingsDriveCandidate,
  RecordingsFacts,
  RecordingsFrigateFacts,
} from "./recordings.types.js";

type FactsDb = Pick<PrismaClient, "storageAllocation" | "camera" | "cameraBitrateSample">;

export interface FactsDeps {
  prisma: FactsDb;
  bridge: Pick<RecordingsBridge, "getNvrStatus" | "getMigration" | "getDrivesSnapshot">;
  /** Frigate's view, or null when it cannot be reached. Default: the internal camera-storage snapshot. */
  getFrigate?: () => Promise<RecordingsFrigateFacts | null>;
  now?: () => Date;
  /** The retention windows the sizing uses. Default: `resolveRetentionDefaults()` (7 days). */
  resolveDefaults?: () => SizingRetentionWindows;
}

type Settled<T> = { ok: true; value: T } | { ok: false; message: string };

async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function defaultFrigate(): Promise<RecordingsFrigateFacts | null> {
  try {
    const snapshot = await getCameraStorageSnapshot();
    const s = snapshot.storage;
    return {
      volume: s.volume,
      cameras: s.cameras.map((c) => ({ camera: c.camera, usedBytes: c.usedBytes, bytesPerHour: c.bytesPerHour })),
      totalBytesPerHour: s.totalBytesPerHour,
      recordingsOnBootDisk: s.recordingsOnBootDisk,
      effectiveRetentionByCamera: snapshot.effectiveRetentionByCamera,
    };
  } catch {
    // Frigate down: the facts say so (null); the overview then reports what the DB + host support.
    return null;
  }
}

function diskModels(disks: unknown[] | undefined): Map<string, { model?: string }> {
  const out = new Map<string, { model?: string }>();
  for (const d of disks ?? []) {
    if (typeof d === "object" && d !== null) {
      const { name, model } = d as { name?: unknown; model?: unknown };
      if (typeof name === "string") out.set(name, typeof model === "string" ? { model } : {});
    }
  }
  return out;
}

export function createFactsCollector(deps: FactsDeps): () => Promise<RecordingsFacts> {
  const { prisma, bridge } = deps;
  const now = deps.now ?? (() => new Date());
  const getFrigate = deps.getFrigate ?? defaultFrigate;
  const resolveDefaults = deps.resolveDefaults ?? (() => resolveRetentionDefaults());

  return async function collectRecordingsFacts(): Promise<RecordingsFacts> {
    const at = now();
    const [allocations, cameras, host, migration, snapshot, frigate] = await Promise.all([
      loadRecordingsAllocations(prisma),
      prisma.camera.findMany({ where: { adoption: "ADOPTED" }, select: { name: true, displayName: true } }),
      settle(bridge.getNvrStatus()),
      settle(bridge.getMigration()),
      settle(bridge.getDrivesSnapshot()),
      getFrigate(),
    ]);

    let drives: RecordingsDriveCandidate[] = [];
    let drivesError: string | null = null;
    if (snapshot.ok) {
      const ctx = { osDisk: snapshot.value.os_disk, disksByName: diskModels(snapshot.value.disks) };
      drives = snapshot.value.drives
        .map((d) => normalizeBridgeDrive(d, ctx))
        .filter((d): d is RecordingsDriveCandidate => d !== null);
    } else {
      drivesError = snapshot.message;
    }

    const hostStatus: NvrHostStatus | null = host.ok ? host.value : null;
    const migrationStatus: NvrMigrationStatus | null = migration.ok ? migration.value : null;
    const liveFsUuid = hostStatus !== null && hostStatus.kind === "path" && hostStatus.mounted ? hostStatus.fsUuid : null;

    const cameraNames = Object.create(null) as Record<string, string>;
    for (const c of cameras) cameraNames[c.name] = c.displayName;
    const cameraNamesToSize = cameras.map((c) => c.name);
    const defaults = resolveDefaults();
    const defaultDays = sizingRetentionDays(defaults);
    // Missing metadata from injected callers keeps the historical test seam;
    // production always sets this field, including explicit null on config failure.
    const effectiveRetention = frigate?.effectiveRetentionByCamera;
    const retentionDaysByCamera = new Map<string, number>();
    if (effectiveRetention) {
      for (const name of cameraNamesToSize) {
        const windows = Object.hasOwn(effectiveRetention, name) ? effectiveRetention[name] : undefined;
        if (windows) retentionDaysByCamera.set(name, sizingRetentionDays(windows));
      }
    }
    const retentionKnown =
      frigate === null
        ? false
        : effectiveRetention === undefined
          ? true
          : effectiveRetention !== null && cameraNamesToSize.every((name) => Object.hasOwn(effectiveRetention, name));
    const sizing = computeSizing(
      await loadSamplesByCamera(prisma, at),
      at,
      defaultDays,
      cameraNamesToSize,
      effectiveRetention ? retentionDaysByCamera : undefined,
      retentionKnown,
    );

    return {
      at,
      allocation: selectSubjectAllocation(allocations, liveFsUuid),
      allocations,
      host: hostStatus,
      hostError: host.ok ? null : host.message,
      migration: migrationStatus,
      drives,
      drivesError,
      frigate,
      sizing,
      cameraNames,
    };
  };
}
