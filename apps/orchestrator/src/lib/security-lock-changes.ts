/**
 * WARP-2979 (ADR-059 P4 PR-4, p4-spec §6.2.1, D12) — which `lock_state` rows
 * are a door lock TURNING. PURE. The one definition both readers use: the
 * link job's lock anchors (lib/security-cooccurrence.ts) and the lock arm of
 * camera_offline_during_activity (lib/security-rules.ts).
 *
 * A row counts only when ALL hold:
 *   · 🔴 `observed = live`. A `polled` row's time is when Droplet's 60 s check
 *     FOUND the change (a sidecar restart, a dropped stream frame, a lock
 *     replaying what changed while it was away), not when the lock turned
 *     (P2b-2 §4.2). Timing evidence needs the moment itself;
 *   · the reading is `locked`, `unlocked` or `unlatched`. `not_fully_locked`
 *     is a bolt that jammed, `unknown` a lock that stopped answering: neither
 *     is someone at the door;
 *   · it is not the lock's BASELINE (`SecurityEvent.baseline`, set by the
 *     lock adapter's `lockRowDraft` when the store held no earlier reading
 *     to compare against: the lock's first row, or the first after retention
 *     emptied its history). Its time is when Droplet first saw the lock, not
 *     when it turned. Read from the explicit column, never inferred from the
 *     dedupe key.
 */

/** The readings that are a lock turning. */
export const LOCK_CHANGE_READINGS = ["locked", "unlocked", "unlatched"] as const;
export type LockChangeReading = (typeof LOCK_CHANGE_READINGS)[number];

/** The columns the rule reads: `reading` is the row's `labels[0]`. */
export interface LockChangeFields {
  reading: string | undefined;
  observed: string;
  /** `SecurityEvent.baseline`. */
  baseline: boolean;
}

export function isLockChange(r: LockChangeFields): boolean {
  return (
    r.observed === "live" &&
    r.reading !== undefined &&
    (LOCK_CHANGE_READINGS as readonly string[]).includes(r.reading) &&
    !r.baseline
  );
}
