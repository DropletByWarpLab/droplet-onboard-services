/**
 * WARP-3113 — deleting a leaver.
 *
 * An employee's work files belong to the business, so Delete never purges
 * them on the spot. DELETE /api/auth/users/:username revokes the person
 * (the same DEACTIVATED lever Deactivate uses) and parks the row on
 * `deletionStatus=PENDING` with a due date RETENTION_DAYS out. Until then an
 * admin can cancel (POST /api/auth/users/:username/cancel-deletion) and the
 * files are untouched. This module's nightly job completes the removal once
 * the date passes.
 *
 * Hand-over to a recipient (the other option Romain accepted on 2026-09-25)
 * needs a server-side move between two Nextcloud homes, which the box cannot
 * do today without a design choice; tracked as WARP-3169.
 */
import type { PrismaClient } from "@prisma/client";
import { ncDeleteUser } from "./nextcloud.client.js";
import { adminBasicToken } from "./department-provisioner.service.js";
import { purgeUserData } from "./brain-memory.service.js";
import { purgeM365ForUser } from "./m365/m365-auth.service.js";
import { runRemovalPostEffects, type NcMirror } from "./role-mutation-guard.service.js";
import type { ActivityActor } from "./activity.service.js";
import type { Role } from "./jwt.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("leaver-deletion");

export const RETENTION_DAYS = 30;
export const LEAVER_DELETION_LOCK_KEY = "droplet:leaver-deletion-purge";

export function deletionDueAt(now: Date): Date {
  return new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

interface RemovableRow {
  id: string;
  username: string;
  nextcloudUsername: string | null;
  role: Role;
}

/**
 * Finish removing a person whose row the caller has already revoked and
 * claimed (`deletionStatus=PURGING`, `directoryStatus=DEACTIVATED`).
 *
 * ORDER IS THE CONTRACT (WARP-1565): Nextcloud first, the local row last. A
 * failing Nextcloud delete throws and leaves the revoked, claimed row for the
 * next run to retry; the reverse order would strand an account with working
 * WebDAV and nothing local to reconcile it from.
 */
export async function completeUserDeletion(
  prisma: PrismaClient,
  row: RemovableRow,
  audit: { actor: ActivityActor; actorUsername: string | null },
): Promise<{ ncMirror: NcMirror }> {
  let ncMirror: NcMirror = "no_account";
  if (row.nextcloudUsername !== null) {
    await ncDeleteUser(adminBasicToken(), row.nextcloudUsername);
    ncMirror = "synced";
  }

  try {
    // WARP-2858: brain memory keys on the local User.id (WARP-493).
    const purged = await purgeUserData(prisma, row.id);
    logger.info(
      { username: row.username, items: purged.items, chunks: purged.chunks },
      "Cascaded brain-memory purge after user delete",
    );
  } catch (err) {
    // Best-effort: the Nextcloud account is already gone. Log loud.
    logger.error(
      { err, username: row.username },
      "Brain-memory cascade purge failed (user already deleted in Nextcloud)",
    );
  }

  // Pinned to the claim, so a row an admin somehow re-activated is never
  // removed as a silent second decision.
  const removed = await prisma.user.deleteMany({
    where: { id: row.id, directoryStatus: "DEACTIVATED", deletionStatus: "PURGING" },
  });
  if (removed.count === 0) {
    logger.warn(
      { username: row.username, userId: row.id },
      "local row not deleted after Nextcloud removal — state changed concurrently; left for operator review",
    );
  } else {
    // WARP-2115 — a Microsoft 365 link holds a live refresh token and nothing
    // cascades (userId is not an FK). Purged only on a confirmed row delete.
    try {
      await purgeM365ForUser(prisma, row.id);
    } catch (err) {
      logger.error(
        { err, username: row.username, userId: row.id },
        "Microsoft 365 purge failed after user delete — a live refresh token may remain",
      );
    }
  }

  await runRemovalPostEffects({
    targetUserId: row.id,
    targetUsername: row.username,
    targetRole: row.role,
    actorUsername: audit.actorUsername,
    actor: audit.actor,
  });
  return { ncMirror };
}

/**
 * The nightly job: complete every deletion whose retention has run out.
 * Rows left on PURGING by a failed earlier run are retried. One person's
 * failure never stops the others.
 */
export async function purgeDueDeletions(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<{ completed: number; failed: number }> {
  const due = await prisma.user.findMany({
    where: {
      directoryStatus: "DEACTIVATED",
      OR: [
        { deletionStatus: "PENDING", deletionDueAt: { lte: now } },
        { deletionStatus: "PURGING" },
      ],
    },
    select: {
      id: true,
      username: true,
      nextcloudUsername: true,
      role: true,
      deletionRequestedBy: true,
    },
  });

  let completed = 0;
  let failed = 0;
  for (const row of due) {
    try {
      // Claim: a cancel matches PENDING only, so once this lands the cancel
      // refuses and the removal cannot be half-undone.
      const claim = await prisma.user.updateMany({
        where: {
          id: row.id,
          directoryStatus: "DEACTIVATED",
          deletionStatus: { in: ["PENDING", "PURGING"] },
        },
        data: { deletionStatus: "PURGING" },
      });
      if (claim.count === 0) continue; // cancelled since the read
      await completeUserDeletion(prisma, row as RemovableRow, {
        actor: { type: "system" },
        // Who asked for it 30 days ago — the job is only the clock.
        actorUsername: row.deletionRequestedBy,
      });
      completed += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { err, username: row.username, userId: row.id },
        "leaver deletion failed; the row stays PURGING and is retried on the next run",
      );
    }
  }
  return { completed, failed };
}
