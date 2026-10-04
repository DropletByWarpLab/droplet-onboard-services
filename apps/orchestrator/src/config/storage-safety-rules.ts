/**
 * BUG-3 / ADR-019 — Storage safety-tier classification.
 *
 * Pool mutations are Tier 3. Recording allocation changes are Tier 2: they
 * require an owner/admin confirmation but do not erase data. Reads are not
 * classified here — they don't pass through the safety service at all.
 *
 * Mirrors network-safety-rules.ts / safety-rules.ts.
 */

import type { TierClassification } from "./safety-rules.js";

/**
 * Destructive storage operations. All are Tier 3: blocked for the AI,
 * dashboard-owner-only, and require a single-use confirm token.
 */
export const STORAGE_TIER_3_OPERATIONS = new Set([
  "pool_create",
  "pool_destroy",
  "pool_format",
  "pool_set_level",
  "pool_add_spare",
  "pool_remove_disk",
  // WARP-662: adopt (wipe + reformat + mount) a previously-used disk. Equally
  // destructive — owner-only, AI-blocked, single-use confirm token.
  "drive_adopt",
  // WARP-1048: reclaim a pool-member disk — detach it from its md array then
  // adopt it. Equally destructive; same owner-only / AI-blocked / confirm gate.
  "drive_reclaim",
  "recordings_old_footage_delete",
]);

/** Writes that need an explicit owner/admin confirmation but do not erase data. */
export const STORAGE_TIER_2_OPERATIONS = new Set(["recordings_set"]);

export function endpointMismatchReason(service: string): string {
  return `A '${service}' confirmation cannot be executed at this endpoint`;
}

/** Confirm token expiry — short, like the network/smart-home tokens. */
export const STORAGE_CONFIRMATION_TOKEN_EXPIRY_MS = 60_000;

/** Bound on outstanding pending confirmations (DoS guard). */
export const STORAGE_MAX_PENDING_CONFIRMATIONS = 200;

/**
 * Classify a storage operation. Unknown ops are treated as Tier 3 too —
 * fail safe: if we don't recognise a storage mutation, it does NOT get the
 * benefit of the doubt. (There is no legitimate Tier-1 storage write.)
 */
export function classifyStorageCommand(operation: string): TierClassification {
  const tier2 = STORAGE_TIER_2_OPERATIONS.has(operation);
  const known = tier2 || STORAGE_TIER_3_OPERATIONS.has(operation);
  return {
    tier: tier2 ? 2 : 3,
    requiresConfirmation: true,
    reason: tier2
      ? `'${operation}' changes where camera recordings are stored and requires owner/admin confirmation`
      : known
      ? `'${operation}' permanently erases data on the target disks and is owner-only`
      : `'${operation}' is an unrecognised storage operation and is refused`,
  };
}
