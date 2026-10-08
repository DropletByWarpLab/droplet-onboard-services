/**
 * WARP-3514 / ADR-070 — data helpers every reader of the recordings allocation
 * shares.
 *
 * Two jobs, both deliberately tiny and dependency-free so anything (the
 * near-full check in camera-storage, the storage routes, the allocator, the
 * budget route) can import them without pulling in the bridge client or Frigate:
 *
 *   1. `effectiveCapacityBytes` — the capacity "full" is measured against:
 *      `min(reserved, volume total)`. Frigate's own `volume.totalBytes` already
 *      equals the project quota when the quota is live (the slice looks like a
 *      smaller drive), and is the whole filesystem while it is not — the
 *      reservation caps the second case and agrees with the first.
 *
 *   2. the ONE place a `StorageAllocation` row (BIGINT) becomes the plain-number
 *      `AllocationRecord` the maths works in (see recordings.types.ts: convert at
 *      the repository boundary, never inside the maths), plus the lookups built
 *      on it.
 *
 * Prisma is typed structurally (`Pick<PrismaClient, "storageAllocation">`) so a
 * transaction client or a test fake works too.
 */
import type { PrismaClient } from "@prisma/client";
import type { AllocationModeName, AllocationRecord, AllocationStatusName } from "./recordings.types.js";

/** The columns of a `StorageAllocation` row these helpers read (Prisma's BIGINT arrives as bigint). */
export interface StorageAllocationRow {
  id: string;
  fsUuid: string;
  mode: AllocationModeName;
  reservedBytes: bigint | number;
  status: AllocationStatusName;
  /** Optional so older fixtures keep working; absent means 0 / null. */
  migrationFailures?: number;
  lastFailureAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type AllocationDb = Pick<PrismaClient, "storageAllocation">;

/** A positive, finite number — anything else is "not known", never a capacity of 0. */
function positive(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The capacity the near-full check measures against.
 *
 *   reserved and volume known   → min of the two
 *   no usable reservation       → the volume (null / 0 / negative / NaN reservation = none)
 *   no usable volume figure     → the reservation
 *   neither                     → null (unknown — never 0)
 *
 * A reservation larger than the volume cannot raise the capacity: it means the
 * quota is not live yet (or the drive shrank), and the volume is the real limit.
 */
export function effectiveCapacityBytes(
  reservedBytes: number | bigint | null | undefined,
  volumeTotalBytes: number | null | undefined,
): number | null {
  const reserved = positive(reservedBytes == null ? null : Number(reservedBytes));
  const volume = positive(volumeTotalBytes);
  if (reserved === null) return volume;
  if (volume === null) return reserved;
  return Math.min(reserved, volume);
}

/** A `StorageAllocation` row as the plain-number record the allocator, the API and the guards use. */
export function toAllocationRecord(row: StorageAllocationRow): AllocationRecord {
  return {
    id: row.id,
    fsUuid: row.fsUuid,
    mode: row.mode,
    reservedBytes: Number(row.reservedBytes),
    status: row.status,
    migrationFailures: row.migrationFailures ?? 0,
    lastFailureAt: row.lastFailureAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * ACTIVE first, then the most recently updated, then the most recently created,
 * then by id — a total order, so the choice never depends on the order the
 * database happened to return rows in.
 */
function byPreference(a: StorageAllocationRow, b: StorageAllocationRow): number {
  const active = Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE");
  if (active !== 0) return active;
  const updated = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (updated !== 0) return updated;
  const created = b.createdAt.getTime() - a.createdAt.getTime();
  if (created !== 0) return created;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function recordingsRows(prisma: AllocationDb): Promise<StorageAllocationRow[]> {
  return prisma.storageAllocation.findMany({ where: { role: "RECORDINGS" } });
}

/**
 * The recordings allocation, or null when there is none.
 *
 * At most one RECORDINGS row exists (the allocator enforces it; the schema only
 * guarantees one row per filesystem). Should several ever exist, the ACTIVE one
 * wins — it is where footage is going — then the most recently updated.
 */
export async function loadRecordingsAllocation(prisma: AllocationDb): Promise<AllocationRecord | null> {
  const rows = await recordingsRows(prisma);
  if (rows.length === 0) return null;
  return toAllocationRecord([...rows].sort(byPreference)[0]);
}

/** Every RECORDINGS row as records, in the `byPreference` order. Two exist only while a drive switch is in flight. */
export async function loadRecordingsAllocations(prisma: AllocationDb): Promise<AllocationRecord[]> {
  const rows = await recordingsRows(prisma);
  return [...rows].sort(byPreference).map(toAllocationRecord);
}

/** Statuses of a row that is NOT yet (or no longer) where Frigate records. */
const IN_FLIGHT: ReadonlySet<AllocationStatusName> = new Set<AllocationStatusName>(["PENDING", "MIGRATING", "DEGRADED", "MISSING"]);

/**
 * The row the API and the status are ABOUT. The row Frigate records onto is the
 * one whose filesystem the host reports (`hostFsUuid`). While a move onto a
 * DIFFERENT drive is in flight, that target row is the subject (it is the thing
 * that is pending / migrating / failing); otherwise the live row; with no host
 * answer, the first row in preference order.
 */
export function selectSubjectAllocation(rows: readonly AllocationRecord[], hostFsUuid: string | null): AllocationRecord | null {
  if (rows.length === 0) return null;
  const live = hostFsUuid === null ? undefined : rows.find((r) => r.fsUuid === hostFsUuid);
  const target = rows.find((r) => r !== live && IN_FLIGHT.has(r.status) && (live !== undefined || rows.length > 1));
  return target ?? live ?? rows[0] ?? null;
}

/** The reservation of the recordings allocation in bytes, or null when there is none. */
export async function getRecordingsReservedBytes(prisma: AllocationDb): Promise<number | null> {
  return (await loadRecordingsAllocation(prisma))?.reservedBytes ?? null;
}

/**
 * Filesystem uuid → `usage` for `GET /api/storage/drives` (the WARP-3512 drive
 * contract: `usage.role` is "recordings" on the allocated drive and null on
 * every other, which is simply absent from this map). It reports every
 * RECORDINGS row the database holds, so the drive list never hides one.
 */
export async function recordingsUsageByFsUuid(
  prisma: AllocationDb,
): Promise<Map<string, { role: "recordings"; reservedBytes: number }>> {
  // The purpose stays assigned while a move is pending or the drive is absent.
  // This role does not claim footage already exists or that recording is active;
  // the recordings API reports that lifecycle separately. The route joins only
  // present data drives, so a MISSING row cannot fabricate an inventory card.
  const rows = await loadRecordingsAllocations(prisma);
  return new Map(rows.map((r) => [r.fsUuid, { role: "recordings" as const, reservedBytes: r.reservedBytes }]));
}
