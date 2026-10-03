/**
 * Revoking a `DeviceClient` — shared by the devices routes
 * (`routes/device-clients.ts`), the owner's "personal drives off" switch
 * (`routes/settings-workspace.ts`, WARP-3318) and the leaver flows (a person
 * who is deactivated or deleted loses every paired device, WARP-3384).
 */
import type { PrismaClient } from "@prisma/client";
import { ncDeleteAppPassword } from "./nextcloud.client.js";
import { decryptSecret } from "./encryption.service.js";
import { publish } from "./mqtt.service.js";
import { recordActivity } from "./activity.singleton.js";
import type { ActivityActor } from "./activity.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("device-client-revoke");

export function safePublish(topic: string, payload: Record<string, unknown>): void {
  try {
    publish(topic, payload);
  } catch (err) {
    logger.warn({ err, topic }, "MQTT publish failed (non-fatal)");
  }
}

/**
 * What a revoke did to the Nextcloud app password — an explicit answer, never
 * inferred (WARP-3383). `not_deleted`: the row is marked revoked but Nextcloud
 * did not confirm the delete, so the credential may still work.
 */
export type DeviceClientRevokeOutcome = "deleted" | "not_deleted" | "already_revoked";

/**
 * Shared revoke cleanup for BOTH auth paths — the operator session-cookie
 * delete and the WARP-349 device Basic-auth self-revoke: best-effort revoke
 * the Nextcloud app password upstream, mark the row revoked, publish the
 * MQTT event. Idempotent — an already-revoked row is a no-op. Returns whether
 * Nextcloud confirmed the delete; callers that tell a person or an audit log
 * "revoked" must say so when it did not.
 */
export async function revokeDeviceClient(
  prisma: PrismaClient,
  row: { id: string; userId: string; ncAppPassword: string; status: string },
): Promise<DeviceClientRevokeOutcome> {
  if (row.status === "revoked") return "already_revoked";

  let deleted = false;
  try {
    const plaintext = decryptSecret(row.ncAppPassword);
    deleted = (await ncDeleteAppPassword(plaintext)) === true;
  } catch (err) {
    logger.warn({ err, deviceId: row.id }, "Failed to revoke Nextcloud app password");
  }
  // Best-effort: still mark the row revoked even if Nextcloud can't kill the
  // token (e.g. already expired, or the account is disabled). The outcome is
  // returned so nobody is told the credential is dead when it may not be.
  if (!deleted) {
    logger.warn({ deviceId: row.id }, "Nextcloud app password not confirmed deleted; row marked revoked anyway");
  }

  await prisma.deviceClient.update({
    where: { id: row.id },
    data: { status: "revoked" },
  });

  safePublish(`droplet/devices/${row.userId}/revoked`, { deviceId: row.id });
  return deleted ? "deleted" : "not_deleted";
}

export interface RevokedDriveLogin {
  clientId: string;
  userId: string;
}

/**
 * Revoke every ACTIVE personal-drive login (`kind: personal_drive`) — the
 * Finder / File Explorer WebDAV logins. Native-app pairings
 * (`kind: app_pairing`) are never selected. "Revoked" here means the row was
 * MARKED revoked: the Nextcloud app-password delete is best-effort
 * (`revokeDeviceClient` returns `not_deleted` when Nextcloud did not confirm
 * it, but this sweep does not surface that outcome).
 *
 * Each login is appended to `revoked` (and returned) as soon as its row is
 * marked, so a caller whose call throws still holds the progress made before
 * the failure. A database failure propagates; because the selection is "still
 * active", a repeat call picks up whatever is left.
 */
export async function revokeActivePersonalDriveLogins(
  prisma: PrismaClient,
  revoked: RevokedDriveLogin[] = [],
): Promise<RevokedDriveLogin[]> {
  const rows = await prisma.deviceClient.findMany({
    where: { kind: "personal_drive", status: "active" },
    select: { id: true, userId: true, ncAppPassword: true, status: true },
  });
  // Serial on purpose: one Nextcloud round-trip per row. Fine at box scale
  // (tens of users, a few logins each); not a bulk API.
  for (const row of rows) {
    await revokeDeviceClient(prisma, row);
    revoked.push({ clientId: row.id, userId: row.userId });
  }
  return revoked;
}

// --- Leaver sweep (WARP-3384) ----------------------------------------------
//
// The lifecycle post-effects (disable, delete, SCIM, the hand-over flow) carry
// no Prisma client, so the box wires one here at boot, next to
// initVpnDeviceRevoke. Same pattern.

let boundPrisma: PrismaClient | null = null;

export function initDeviceClientRevoke(prisma: PrismaClient): void {
  boundPrisma = prisma;
}

export type DeviceClientSweepReason = "deactivation" | "removal";

export interface DeviceClientSweepSummary {
  /** Rows marked revoked. */
  revoked: number;
  /** Of those, how many Nextcloud app passwords Nextcloud did NOT confirm deleting. */
  appPasswordsNotDeleted: number;
  /** Rows that could not be marked revoked; still `active`, the admin must retry. */
  failed: number;
}

/**
 * Revoke every ACTIVE device client `username` owns, of both kinds
 * (`app_pairing` and `personal_drive`): delete each Nextcloud app password,
 * mark the row, and write ONE audit row naming the actor, the person and the
 * counts. Best-effort and never throws: the directory write that triggered it
 * has already committed. Not best-effort about the record: an app password
 * Nextcloud did not confirm deleting, or a row that could not be marked, is on
 * the audit row (`appPasswordsNotDeleted`, `failed`), never hidden.
 *
 * Call it BEFORE the person's Nextcloud account is disabled where the flow
 * allows: a disabled account cannot authenticate its own app-password delete,
 * so afterwards the delete is refused and the credential revives if the person
 * is ever reactivated. Idempotent, so the lifecycle post-effects call it too as
 * the backstop for the flows that cannot (SCIM, the legacy NC-only account).
 *
 * Returns null when nothing ran: not wired (unit tests, logged loudly) or the
 * sweep itself failed (recorded on its own audit row). A person with no active
 * device client returns a zero summary and writes no row.
 */
export async function revokeDeviceClientsForUser(
  username: string,
  actor: ActivityActor,
  reason: DeviceClientSweepReason,
): Promise<DeviceClientSweepSummary | null> {
  const summary: DeviceClientSweepSummary = { revoked: 0, appPasswordsNotDeleted: 0, failed: 0 };
  if (!username) return summary;
  const prisma = boundPrisma;
  if (!prisma) {
    logger.error(
      { username, reason },
      "WARP-3384: device-client revoke not wired (initDeviceClientRevoke) — the person's paired devices were NOT revoked",
    );
    return null;
  }
  try {
    const rows = await prisma.deviceClient.findMany({
      where: { userId: username, status: "active" },
      select: { id: true, userId: true, ncAppPassword: true, status: true },
    });
    if (rows.length === 0) return summary;
    // Serial on purpose: one Nextcloud round-trip per row. Box scale: a few
    // devices per person.
    for (const row of rows) {
      try {
        const outcome = await revokeDeviceClient(prisma, row);
        summary.revoked += 1;
        if (outcome === "not_deleted") summary.appPasswordsNotDeleted += 1;
      } catch (err) {
        summary.failed += 1;
        logger.error({ err, deviceId: row.id }, "WARP-3384: device client revoke failed; row left active");
      }
    }
    await recordActivity({
      kind: "auth",
      severity: summary.failed > 0 ? "err" : "warn",
      sourceIcon: "smartphone",
      what: summary.failed > 0 ? "Some paired devices could not be revoked" : "Paired devices revoked",
      sub: `${username}: ${reason}`,
      refs: {
        event: "device_clients_revoked",
        reason,
        targetUsername: username,
        revoked: summary.revoked,
        appPasswordsNotDeleted: summary.appPasswordsNotDeleted,
        failed: summary.failed,
      },
      actor,
    });
    return summary;
  } catch (err) {
    logger.error({ err, username, reason }, "WARP-3384: device-client sweep failed — paired devices may NOT be revoked");
    await recordActivity({
      kind: "auth",
      severity: "err",
      sourceIcon: "smartphone",
      what: "Paired devices could not be revoked",
      sub: `${username}: ${reason}`,
      refs: { event: "device_clients_revoked", reason, targetUsername: username, sweepFailed: true },
      actor,
    }).catch(() => undefined);
    return null;
  }
}
