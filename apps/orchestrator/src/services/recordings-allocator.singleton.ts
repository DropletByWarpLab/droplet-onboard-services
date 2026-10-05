/**
 * WARP-3514 — process-wide handle on the recordings allocator.
 *
 * The allocator is composed once at boot (index.ts) because its collaborators
 * (the device-bridge client, Frigate, Prisma) are heavy. Everything that needs
 * it LATER — the `/api/storage/recordings` routes, the "a drive was just
 * prepared" hook in the storage routes, the camera-storage AI summary — reads it
 * from here and stays decoupled from how it was built. Same shape as
 * `activity.singleton.ts`: before `setRecordingsAllocator` runs every accessor
 * is a safe no-op / null, so import order in tests never matters.
 */
import type { RecordingsAllocator } from "./recordings.types.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("recordings-allocator");

let allocator: RecordingsAllocator | null = null;

export function setRecordingsAllocator(next: RecordingsAllocator | null): void {
  allocator = next;
}

/** The composed allocator, or null before boot wiring (and in unit tests). */
export function getRecordingsAllocator(): RecordingsAllocator | null {
  return allocator;
}

/**
 * Ask the allocator to reconcile NOW — called after a drive is prepared so a
 * freshly encrypted bay drive is adopted for recordings without waiting up to
 * an hour for the cron. Fire-and-forget by design: the caller (a storage route
 * that already answered its own request) must never block on, or fail because
 * of, an allocation attempt. A failure is logged and the hourly cron retries.
 */
export function kickRecordingsAllocator(): void {
  const current = allocator;
  if (!current) return;
  void current.reconcile({ reason: "kick" }).catch((err: unknown) => {
    logger.warn({ err }, "recordings allocator kick failed — the hourly reconcile will retry");
  });
}
