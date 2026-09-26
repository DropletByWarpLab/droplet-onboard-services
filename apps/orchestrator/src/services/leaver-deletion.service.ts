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
 * WARP-3169 — the other option Romain accepted on 2026-09-25: hand the files
 * to a recipient (`handOverAndDeleteUser`). The move runs through the host
 * helper's fixed `nc-transfer-ownership` subcommand (host-compose-runner.ts);
 * once it succeeds the deletion completes at once, with no retention.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ncDeleteUser, ncSetUserEnabled } from "./nextcloud.client.js";
import { adminBasicToken } from "./department-provisioner.service.js";
import { purgeUserData } from "./brain-memory.service.js";
import { purgeM365ForUser } from "./m365/m365-auth.service.js";
import {
  assertRemovalAllowed,
  assertRemovalInvariantsTx,
  readGuardTargetTx,
  RoleMutationRefusedError,
  runDisablePostEffects,
  runRemovalPostEffects,
  SERIALIZABLE_TX,
  type GuardActor,
  type NcMirror,
} from "./role-mutation-guard.service.js";
import type { ActivityActor } from "./activity.service.js";
import { ACCESS_TOKEN_TTL_SECONDS, type Role } from "./jwt.service.js";
import { denylistUser } from "./auth-denylist.service.js";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";
import { getOtaHost } from "./update-agent/host-exec.js";
import { ncTransferOwnership, NcTransferError } from "./update-agent/host-compose-runner.js";

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

/** What happens to a leaver's files: kept RETENTION_DAYS, or handed over
 *  to a recipient now (WARP-3169). */
export type DeletionDisposition = "retention" | "handover";

/** A delete request's body. `disposition` is optional: a client that sends
 *  none (iOS and the Mac on main) gets "retention", recorded as defaulted. An
 *  unknown value is refused by the routes (400 UNKNOWN_DISPOSITION).
 *  `recipientId` (the recipient's local user id, stable across renames) is
 *  read for "handover" only. */
export const deleteDispositionSchema = z.object({
  disposition: z.enum(["retention", "handover"]).optional(),
  recipientId: z.string().min(1).max(128).optional(),
});

export const UNKNOWN_DISPOSITION_BODY = {
  error:
    "Unknown disposition. Use \"retention\" (keep the files 30 days, then delete) or \"handover\" with a recipientId.",
  code: "UNKNOWN_DISPOSITION",
} as const;

/**
 * Schedule a person's deletion — THE path for every delete surface
 * (DELETE /api/auth/users/:username and DELETE /api/people/:id).
 *
 * Revocation happens now, exactly as Deactivate does it: the WARP-1526
 * removal rails, then DEACTIVATED + PENDING in one SERIALIZABLE write pinned
 * to the evaluated role, then the Nextcloud enable-flag mirror (WebDAV and
 * sync are proxied without orchestrator auth, so this is what cuts them) and
 * the SAME shared disable post-effects the disable route runs
 * (`runDisablePostEffects`: sessions + the "User disabled" row, and whatever
 * else hooks that step). Plus the access-token denylist, as the old
 * immediate delete had, so a sid-less token doesn't live out its TTL.
 * Nothing is purged here. Idempotent: an already-scheduled person keeps the
 * first date.
 *
 * Throws RoleMutationRefusedError on a rail refusal or a lost race.
 */
export async function scheduleUserDeletion(
  prisma: PrismaClient,
  target: RemovableRow & { deletionStatus?: string | null; deletionDueAt?: Date | null },
  req: {
    guardActor: GuardActor;
    actorUsername: string | null;
    actor: ActivityActor;
    disposition: DeletionDisposition;
    /** True when the client sent no disposition and the box chose retention. */
    dispositionDefaulted: boolean;
  },
): Promise<{ deletionDueAt: Date; ncMirror: NcMirror | null; alreadyScheduled: boolean }> {
  if (target.deletionStatus === "PENDING" || target.deletionStatus === "PURGING") {
    return { deletionDueAt: target.deletionDueAt as Date, ncMirror: null, alreadyScheduled: true };
  }
  if (target.deletionStatus === "HANDING_OVER") {
    throw new HandoverRefusedError(409, "HANDOVER_IN_PROGRESS", "This person's files are being handed over right now.");
  }
  assertRemovalAllowed({ actor: req.guardActor, target });
  const dueAt = deletionDueAt(new Date());
  await prisma.$transaction(async (tx) => {
    const fresh = await readGuardTargetTx(tx, target.id);
    if (!fresh) throw RoleMutationRefusedError.concurrentMutation();
    await assertRemovalInvariantsTx(tx, { target: fresh });
    // Pinned to NONE: a hand-over's HANDING_OVER claim landing in between
    // makes this miss (P2025, a 409), never overwrite it.
    await tx.user.update({
      where: { id: fresh.id, role: fresh.role, deletionStatus: "NONE" },
      data: {
        directoryStatus: "DEACTIVATED",
        deletionStatus: "PENDING",
        deletionDueAt: dueAt,
        deletionRequestedBy: req.actorUsername,
      },
    });
  }, SERIALIZABLE_TX);

  // Best-effort, as on disable: the reconciler's mirror pass converges it.
  let ncMirror: NcMirror = "no_account";
  if (target.nextcloudUsername !== null) {
    try {
      await ncSetUserEnabled(adminBasicToken(), target.nextcloudUsername, false);
      ncMirror = "synced";
    } catch (err) {
      ncMirror = "failed";
      logger.error(
        { err, username: target.username },
        "schedule deletion: Nextcloud disable mirror failed (non-blocking)",
      );
    }
  }
  await runDisablePostEffects({
    targetUserId: target.id,
    username: target.username,
    actor: req.actor,
    ncMirror,
  });
  await denylistUser(target.id, ACCESS_TOKEN_TTL_SECONDS);
  // WARP-3160: call revokeOverlayDevicesForUser once #2403 is on stage
  // (a scheduled leaver's overlay/VPN devices are revoked now, not at purge).
  await recordActivity({
    kind: "auth",
    severity: "warn",
    sourceIcon: "user-x",
    what: "User deletion scheduled",
    sub: `${target.username} · files kept until ${dueAt.toISOString().slice(0, 10)}`,
    refs: {
      actor: req.actorUsername,
      targetUserId: target.id,
      targetUsername: target.username,
      role: target.role,
      disposition: req.disposition,
      dispositionDefaulted: req.dispositionDefaulted,
      ...(req.dispositionDefaulted
        ? { dispositionNote: "disposition defaulted: retention (client sent none)" }
        : {}),
      deletionDueAt: dueAt.toISOString(),
      ncMirror,
    },
    actor: req.actor,
  });
  return { deletionDueAt: dueAt, ncMirror, alreadyScheduled: false };
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

  // WARP-3160: call revokeOverlayDevicesForUser once #2403 is on stage
  // (or pass #2403's `devices` field here).
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
      // The due date is re-checked here, not trusted from the read: a
      // cancel + re-delete between the read and this claim sets a NEW date.
      const claim = await prisma.user.updateMany({
        where: {
          id: row.id,
          directoryStatus: "DEACTIVATED",
          OR: [
            { deletionStatus: "PENDING", deletionDueAt: { lte: now } },
            { deletionStatus: "PURGING" },
          ],
        },
        data: { deletionStatus: "PURGING" },
      });
      if (claim.count === 0) continue; // cancelled or re-scheduled since the read
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

// ── WARP-3169: hand-over ─────────────────────────────────────────────────

/** A hand-over refused or failed before the leaver's state changed. */
export class HandoverRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HandoverRefusedError";
  }
  toJSON(): { error: string; code: string } {
    return { error: this.message, code: this.code };
  }
}

/** Who may receive a leaver's files: an owner, admin or member (wire role
 *  `family`). Never an external guest or a service account. */
const HANDOVER_RECIPIENT_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "family"]);

/** Moves `from`'s Nextcloud files to `to`. Injectable for tests. */
export type NcTransferFn = (from: string, to: string) => Promise<{ folder: string | null }>;

/** Production transfer: the host helper, when this box has it provisioned. */
const hostTransfer: NcTransferFn = async (from, to) => {
  const host = getOtaHost();
  if (!host) {
    throw new HandoverRefusedError(
      503,
      "HANDOVER_UNAVAILABLE",
      "Handing files over needs the box's host helper, which is off on this box. Use \"Keep for 30 days, then delete\" instead.",
    );
  }
  return ncTransferOwnership({
    exec: host.exec,
    scriptPath: host.helperPath,
    composeFile: host.composeFile,
    from,
    to,
  });
};

const refuse = (status: number, code: string, message: string) =>
  new HandoverRefusedError(status, code, message);

/**
 * Delete a person and hand their files to a recipient (by local user id) —
 * `{ disposition: "handover", recipientId }` on either delete route.
 *
 * Order is the contract:
 *   1. every check that can refuse (the WARP-1526 removal rails, the
 *      recipient, the in-transaction last-owner/last-operator invariants);
 *   2. the CLAIM: deletionStatus NONE|PENDING -> HANDING_OVER, pinned to the
 *      value read, so a second concurrent hand-over (or a retention delete,
 *      cancel, reactivate) misses and is refused with 409;
 *   3. the transfer. If it fails, the claim is rolled back to the value it
 *      replaced and nothing is deleted. A failure after occ started (timeout,
 *      non-zero exit) may have moved SOME files: the error says so and an
 *      audit row records it;
 *   4. only then revoke (DEACTIVATED + PURGING, pinned to the claim) and
 *      complete the deletion right away, with no retention.
 * If step 4's revoke is refused (someone demoted the last operator in
 * between), the files have already moved; the claim is rolled back, the
 * "Files handed over" row says so, and the error is returned. If the
 * Nextcloud account delete fails, the row stays PURGING and the nightly job
 * retries it, as for any deletion.
 *
 * ponytail: a crash between claim and rollback leaves HANDING_OVER set; an
 * operator resets it. A stale-claim sweep is the upgrade if that ever bites.
 */
export async function handOverAndDeleteUser(
  prisma: PrismaClient,
  target: RemovableRow & { deletionStatus?: string | null },
  req: {
    guardActor: GuardActor;
    actorUsername: string | null;
    actor: ActivityActor;
    recipientId: string | undefined;
    transfer?: NcTransferFn;
  },
): Promise<{ recipient: string; folder: string | null; removed: boolean }> {
  if (!req.recipientId) {
    throw refuse(400, "RECIPIENT_REQUIRED", "Choose who receives the files.");
  }
  const prior = target.deletionStatus ?? "NONE";
  if (prior !== "NONE" && prior !== "PENDING") {
    throw refuse(409, "DELETION_IN_PROGRESS", "This person is already being deleted or handed over.");
  }
  assertRemovalAllowed({ actor: req.guardActor, target });

  const recipient = await prisma.user.findUnique({
    where: { id: req.recipientId },
    select: {
      id: true,
      username: true,
      nextcloudUsername: true,
      role: true,
      directoryStatus: true,
      deletionStatus: true,
    },
  });
  if (!recipient) {
    throw refuse(400, "RECIPIENT_UNKNOWN", "The recipient isn't a person on this box.");
  }
  if (recipient.id === target.id) {
    throw refuse(400, "RECIPIENT_IS_LEAVER", "The recipient can't be the person being deleted.");
  }
  if (recipient.directoryStatus !== "ACTIVE" || recipient.deletionStatus !== "NONE") {
    throw refuse(400, "RECIPIENT_NOT_ACTIVE", "The recipient must be an active person.");
  }
  if (!HANDOVER_RECIPIENT_ROLES.has(recipient.role)) {
    throw refuse(
      400,
      "RECIPIENT_ROLE",
      "Files can only go to an owner, admin or member, never an external guest.",
    );
  }
  if (target.nextcloudUsername === null) {
    throw refuse(
      409,
      "NO_FILES_ACCOUNT",
      "This person has no files account, so there is nothing to hand over. Use \"Keep for 30 days, then delete\".",
    );
  }
  if (recipient.nextcloudUsername === null) {
    throw refuse(409, "RECIPIENT_NO_FILES_ACCOUNT", "The recipient has no files account to receive them.");
  }

  // Steps 1 + 2 in one SERIALIZABLE transaction: the invariants the revoke
  // re-checks, then the claim, pinned to the deletion state we read.
  await prisma.$transaction(async (tx) => {
    const fresh = await readGuardTargetTx(tx, target.id);
    if (!fresh) throw RoleMutationRefusedError.concurrentMutation();
    await assertRemovalInvariantsTx(tx, { target: fresh });
    try {
      await tx.user.update({
        where: { id: fresh.id, deletionStatus: prior as "NONE" | "PENDING" },
        data: { deletionStatus: "HANDING_OVER" },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2025") {
        throw refuse(409, "HANDOVER_IN_PROGRESS", "This person is already being handed over or deleted.");
      }
      throw err;
    }
  }, SERIALIZABLE_TX);

  const releaseClaim = () =>
    prisma.user
      .update({
        where: { id: target.id, deletionStatus: "HANDING_OVER" },
        data: { deletionStatus: prior as "NONE" | "PENDING" },
      })
      .catch((err: unknown) =>
        logger.error(
          { err, username: target.username },
          "hand-over: could not release the HANDING_OVER claim; an operator must reset it",
        ),
      );

  let folder: string | null;
  try {
    ({ folder } = await (req.transfer ?? hostTransfer)(
      target.nextcloudUsername,
      recipient.nextcloudUsername,
    ));
  } catch (err) {
    await releaseClaim();
    if (err instanceof HandoverRefusedError) throw err;
    const partial = err instanceof NcTransferError ? err.mayBePartial : true;
    const reason = err instanceof NcTransferError ? err.reason : "transfer failed";
    await recordActivity({
      kind: "auth",
      severity: partial ? "err" : "warn",
      sourceIcon: "user-x",
      what: partial ? "File hand-over failed, may be partial" : "File hand-over refused",
      sub: `${target.username} → ${recipient.username} · ${reason}`,
      refs: {
        actor: req.actorUsername,
        targetUserId: target.id,
        targetUsername: target.username,
        recipientUserId: recipient.id,
        recipientUsername: recipient.username,
        reason,
        mayBePartial: partial,
      },
      actor: req.actor,
    });
    if (partial) {
      throw refuse(
        502,
        "HANDOVER_INCOMPLETE",
        `The hand-over didn't finish. Some files may already be in ${recipient.username}'s "Transferred from…" folder. Nothing was deleted.`,
      );
    }
    throw refuse(
      502,
      "HANDOVER_FAILED",
      err instanceof NcTransferError
        ? err.message
        : "The files could not be handed over, so nothing was changed.",
    );
  }

  await recordActivity({
    kind: "auth",
    severity: "warn",
    sourceIcon: "user-x",
    what: "Files handed over",
    sub: `${target.username} → ${recipient.username}${folder ? ` · ${folder}` : ""}`,
    refs: {
      actor: req.actorUsername,
      targetUserId: target.id,
      targetUsername: target.username,
      recipientUserId: recipient.id,
      recipientUsername: recipient.username,
      folder,
      disposition: "handover",
    },
    actor: req.actor,
  });

  try {
    await prisma.$transaction(async (tx) => {
      const fresh = await readGuardTargetTx(tx, target.id);
      if (!fresh) throw RoleMutationRefusedError.concurrentMutation();
      await assertRemovalInvariantsTx(tx, { target: fresh });
      await tx.user.update({
        where: { id: fresh.id, role: fresh.role, deletionStatus: "HANDING_OVER" },
        data: {
          directoryStatus: "DEACTIVATED",
          deletionStatus: "PURGING",
          deletionRequestedBy: req.actorUsername,
        },
      });
    }, SERIALIZABLE_TX);
  } catch (err) {
    await releaseClaim();
    throw err;
  }

  try {
    await completeUserDeletion(prisma, target, {
      actor: req.actor,
      actorUsername: req.actorUsername,
    });
    return { recipient: recipient.username, folder, removed: true };
  } catch (err) {
    logger.error(
      { err, username: target.username },
      "hand-over done, account removal failed; the row stays PURGING and the nightly job retries it",
    );
    // Still cut them off now, as a scheduled deletion does.
    await runDisablePostEffects({
      targetUserId: target.id,
      username: target.username,
      actor: req.actor,
      ncMirror: "failed",
    }).catch(() => undefined);
    await denylistUser(target.id, ACCESS_TOKEN_TTL_SECONDS).catch(() => undefined);
    return { recipient: recipient.username, folder, removed: false };
  }
}
