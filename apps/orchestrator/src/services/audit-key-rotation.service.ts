/**
 * WARP-3165 — rotate the audit chain's HMAC key.
 *
 * Every audit export made before WARP-3153 carried the key, so a box that
 * exported one must be able to retire it without losing its history. The
 * design, and why (docs/security/audit-bundle-verification.md has the
 * operator steps):
 *
 *   - The old key is ARCHIVED, read-only, for verification: rows signed
 *     before the rotation keep verifying. Destroying it would leave those
 *     rows checkable only against the daily device-key roots (WARP-237).
 *   - No per-row key column. Verification walks the keyring under the epoch
 *     rule (`createEpochVerifier`): each row must verify under the current
 *     epoch's key or a newer one, and the first new-key row closes the old
 *     epoch for good. So a row forged with the leaked key after the rotation
 *     is a break, and the rows before it are pinned by the first new-key
 *     row's link. A column would add a migration and an unsigned field that
 *     a forger could set to the old key's id; the chain order already says
 *     which key applies.
 *   - The key file is written on the HOST (the orchestrator mounts it
 *     read-only, WARP-235 decision-4), by the OTA helper's fixed
 *     `rotate-audit-key` subcommand: archive the old key under
 *     data/secrets/audit-retired/, then overwrite audit.key in place (same
 *     inode, so the single-file bind mount sees it). This process then
 *     reloads it and swaps its signer, and the next row, "Audit key
 *     rotated", is the first one signed by the new key.
 *   - A box without the host helper rotates with scripts/rotate-audit-key.sh
 *     and a restart; `recordRotationFoundAtBoot` then writes that row.
 */
import * as fs from "node:fs";
import type { PrismaClient } from "@prisma/client";
import {
  AUDIT_RETIRED_DIR,
  auditKeyId,
  loadAuditKeyFromDisk,
  loadRetiredAuditKeys,
} from "./audit-signing.service.js";
import {
  adoptAuditKey,
  getAuditKeyring,
  getCurrentAuditKeyId,
  recordActivity,
} from "./activity.singleton.js";
import type { ActivityActor } from "./activity.service.js";
import { activityRowContent } from "./audit-verify.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("audit-key-rotation");

/** A rotation refused or failed; `status` is the HTTP answer. */
export class AuditKeyRotationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuditKeyRotationError";
  }
  toJSON(): { error: string; code: string } {
    return { error: this.message, code: this.code };
  }
}

/** Runs the host helper's `rotate-audit-key`. Null when this box has none. */
export type RotateOnHost = (() => Promise<void>) | null;

export async function rotateAuditKey(opts: {
  runOnHost: RotateOnHost;
  actor: ActivityActor;
  actorUsername: string | null;
  /** Test seams; production reads the real paths. */
  retiredDir?: string;
  loadKey?: () => Buffer;
}): Promise<{ previousKeyId: string; newKeyId: string }> {
  const retiredDir = opts.retiredDir ?? AUDIT_RETIRED_DIR;
  const previousKeyId = getCurrentAuditKeyId();
  if (!previousKeyId) {
    throw new AuditKeyRotationError(503, "AUDIT_SIGNER_UNAVAILABLE", "The audit signer isn't running.");
  }
  if (!opts.runOnHost) {
    throw new AuditKeyRotationError(
      503,
      "HOST_HELPER_UNAVAILABLE",
      "This box can't rotate the key from the dashboard (its host helper is off). Run scripts/rotate-audit-key.sh on the box instead.",
    );
  }
  // Refuse BEFORE touching the key if the archive isn't visible here: a new
  // key without its predecessor readable would break the chain at the next
  // restart. The directory is a mount this release's compose file adds.
  if (!fs.existsSync(retiredDir)) {
    throw new AuditKeyRotationError(
      409,
      "RETIRED_KEY_DIR_MISSING",
      "This box needs its latest update applied before the audit key can be rotated.",
    );
  }

  try {
    await opts.runOnHost();
  } catch (err) {
    logger.error({ err }, "audit key rotation: host helper failed");
    throw new AuditKeyRotationError(502, "ROTATION_FAILED", "The key could not be rotated. Nothing changed.");
  }

  const newKey = (opts.loadKey ?? loadAuditKeyFromDisk)();
  const newKeyId = auditKeyId(newKey);
  if (newKeyId === previousKeyId) {
    throw new AuditKeyRotationError(502, "ROTATION_FAILED", "The key could not be rotated. Nothing changed.");
  }
  if (!loadRetiredAuditKeys(retiredDir).some((k) => k.keyId === previousKeyId)) {
    // The helper archives before it overwrites, so this is a mount fault.
    // Swapping anyway is still right: the new key is already on disk and
    // is what a restart would load; say loudly what to fix.
    logger.error(
      { previousKeyId, retiredDir },
      "audit key rotated but the retired key isn't readable here — rows signed before the rotation will not verify until data/secrets/audit-retired is mounted",
    );
  }

  const swap = adoptAuditKey(newKey);
  // The first row signed with the new key: the epoch switch point.
  await recordActivity({
    kind: "system",
    severity: "warn",
    sourceIcon: "key-round",
    what: "Audit key rotated",
    sub: `${swap.previousKeyId} → ${swap.newKeyId}`,
    refs: {
      actor: opts.actorUsername,
      previousKeyId: swap.previousKeyId,
      newKeyId: swap.newKeyId,
      via: "dashboard",
    },
    actor: opts.actor,
  });
  return swap;
}

/**
 * Boot check for a rotation done while the orchestrator was down
 * (scripts/rotate-audit-key.sh): the chain's last row was signed by a
 * retired key, so the next row is the switch point. Write "Audit key
 * rotated" as that row, with actor system. Run once, after
 * initActivityRecorder. A tail that verifies under no key is left to the
 * chain verifier to report.
 */
export async function recordRotationFoundAtBoot(prisma: PrismaClient): Promise<boolean> {
  const ring = getAuditKeyring();
  const current = ring[ring.length - 1];
  if (!current || ring.length < 2) return false;
  const tail = await prisma.activityRow.findFirst({ orderBy: { id: "desc" } });
  if (!tail) return false;
  const content = activityRowContent(tail);
  const signedBy = (k: (typeof ring)[number]) => {
    try {
      return k.signer.verify(content, tail.prevSignatureHash, tail.signature);
    } catch {
      return false;
    }
  };
  if (signedBy(current)) return false;
  const previous = ring.slice(0, -1).reverse().find(signedBy);
  if (!previous) return false;
  await recordActivity({
    kind: "system",
    severity: "warn",
    sourceIcon: "key-round",
    what: "Audit key rotated",
    sub: `${previous.keyId} → ${current.keyId}`,
    refs: {
      actor: null,
      previousKeyId: previous.keyId,
      newKeyId: current.keyId,
      via: "script",
    },
    actor: { type: "system", id: null },
  });
  return true;
}
