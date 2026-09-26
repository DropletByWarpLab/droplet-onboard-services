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
 *   · it is not the lock's BASELINE: the first row a lock wrote (or the first
 *     after retention emptied its history) has no earlier row to be "after",
 *     so its dedupe key reads `…:after:none:…` (P2b-2 §6.8's
 *     `lockDedupeKey(obs, null)` — the service test pins the mark against
 *     that builder). Its time is when Droplet first saw the lock.
 */

/** The readings that are a lock turning. */
export const LOCK_CHANGE_READINGS = ["locked", "unlocked", "unlatched"] as const;
export type LockChangeReading = (typeof LOCK_CHANGE_READINGS)[number];

/** In a baseline row's dedupe key (`matter_lock:<node>/<ep>:after:none:<reading>`), and in no other. */
export const LOCK_BASELINE_KEY_MARK = ":after:none:";

/** The columns the rule reads: `reading` is the row's `labels[0]`. */
export interface LockChangeFields {
  reading: string | undefined;
  observed: string;
  dedupeKey: string;
}

export function isLockChange(r: LockChangeFields): boolean {
  return (
    r.observed === "live" &&
    r.reading !== undefined &&
    (LOCK_CHANGE_READINGS as readonly string[]).includes(r.reading) &&
    !r.dedupeKey.includes(LOCK_BASELINE_KEY_MARK)
  );
}
