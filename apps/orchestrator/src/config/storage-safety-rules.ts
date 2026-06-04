/**
 * BUG-3 / ADR-019 — Storage safety-tier classification.
 *
 * Every pool mutation is DATA-DESTROYING, so there is no Tier-1 or Tier-2
 * storage write: all writes are Tier-3-class (owner-only, AI-blocked, confirm
 * required). Reads are not classified here — they don't pass through the
 * safety service at all.
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
]);

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
  // Every storage mutation is data-destroying → Tier 3.
  const known = STORAGE_TIER_3_OPERATIONS.has(operation);
  return {
    tier: 3,
    requiresConfirmation: true,
    reason: known
      ? `'${operation}' permanently erases data on the target disks and is owner-only`
      : `'${operation}' is an unrecognised storage operation and is refused`,
  };
}
