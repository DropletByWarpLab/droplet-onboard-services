/**
 * BUG-3 / ADR-019 — Storage safety-tier classification.
 *
 * Every pool/drive mutation is DATA-DESTROYING, so those writes are all
 * Tier-3-class (owner-only, AI-blocked, confirm required). Reads are not
 * classified here — they don't pass through the safety service at all.
 *
 * WARP-3513 adds the recovery-key operations for the bay drives every Prepare now
 * encrypts (storage decision record ADR-070, section 8.5). The one-time reveal is the first
 * Tier-2 storage action: it erases nothing, but it hands out the secret that unlocks
 * the drive's data without the TPM, so it is owner-only and needs one confirmation
 * round-trip. "Regenerate recovery key" replaces that secret (the old key stops
 * working), so it is Tier 3. The AI is hard-blocked from both like from every other
 * storage operation (see evaluateStorageCommand).
 *
 * Mirrors network-safety-rules.ts / safety-rules.ts.
 */

import type { TierClassification } from "./safety-rules.js";

/** Host operation that reveals a bay drive's escrowed recovery key, once (Tier 2). */
export const RECOVERY_KEY_REVEAL_OPERATION = "recovery_key_reveal";

/** Host operation that enrols a new recovery keyslot and wipes the old one (Tier 3). */
export const RECOVERY_KEY_REGENERATE_OPERATION = "recovery_key_regenerate";

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
  // WARP-3513: replace a bay drive's recovery key — a new keyslot is enrolled and the
  // old one wiped, so the key the owner holds stops working. Owner-only, AI-blocked,
  // single-use confirm token.
  RECOVERY_KEY_REGENERATE_OPERATION,
]);

/**
 * WARP-3513: non-destructive but secret-revealing storage operations. Tier 2:
 * owner-only, one confirmation round-trip, still AI-blocked.
 */
export const STORAGE_TIER_2_OPERATIONS = new Set<string>([RECOVERY_KEY_REVEAL_OPERATION]);

/**
 * The reason shown when a confirmation token is presented to an endpoint that
 * cannot execute the operation it was minted for.
 */
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
 * benefit of the doubt. The match is exact, so a near-miss spelling of a
 * Tier-2 operation is an unknown (Tier 3, refused) one.
 */
export function classifyStorageCommand(operation: string): TierClassification {
  if (STORAGE_TIER_2_OPERATIONS.has(operation)) {
    return {
      tier: 2,
      requiresConfirmation: true,
      reason:
        "Shows this drive's recovery key one time. Anyone who has the key can unlock the " +
        "drive's data without this Droplet, so only the owner can ask for it — copy it " +
        "somewhere safe, because it cannot be shown again",
    };
  }
  if (operation === RECOVERY_KEY_REGENERATE_OPERATION) {
    return {
      tier: 3,
      requiresConfirmation: true,
      reason:
        "Replaces this drive's recovery key: a new key is issued and the old one stops working. " +
        "The drive stays encrypted and keeps unlocking with this Droplet's TPM. Owner-only",
    };
  }
  // Every other storage mutation is data-destroying → Tier 3.
  const known = STORAGE_TIER_3_OPERATIONS.has(operation);
  return {
    tier: 3,
    requiresConfirmation: true,
    reason: known
      ? `'${operation}' permanently erases data on the target disks and is owner-only`
      : `'${operation}' is an unrecognised storage operation and is refused`,
  };
}
