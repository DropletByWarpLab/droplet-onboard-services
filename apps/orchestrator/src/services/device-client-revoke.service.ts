/**
 * Revoking a `DeviceClient` — shared by the devices routes
 * (`routes/device-clients.ts`) and the owner's "personal drives off" switch
 * (`routes/settings-workspace.ts`, WARP-3318).
 */
import type { PrismaClient } from "@prisma/client";
import { ncDeleteAppPassword } from "./nextcloud.client.js";
import { decryptSecret } from "./encryption.service.js";
import { publish } from "./mqtt.service.js";
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
 * Shared revoke cleanup for BOTH auth paths — the operator session-cookie
 * delete and the WARP-349 device Basic-auth self-revoke: best-effort revoke
 * the Nextcloud app password upstream, mark the row revoked, publish the
 * MQTT event. Idempotent — an already-revoked row is a no-op.
 */
export async function revokeDeviceClient(
  prisma: PrismaClient,
  row: { id: string; userId: string; ncAppPassword: string; status: string },
): Promise<void> {
  if (row.status === "revoked") return;

  try {
    const plaintext = decryptSecret(row.ncAppPassword);
    await ncDeleteAppPassword(plaintext);
  } catch (err) {
    // Best-effort: still mark the row revoked even if Nextcloud can't
    // kill the token (e.g. already expired). Operators can clean up
    // stale tokens via the Nextcloud admin UI if needed.
    logger.warn({ err, deviceId: row.id }, "Failed to revoke Nextcloud app password");
  }

  await prisma.deviceClient.update({
    where: { id: row.id },
    data: { status: "revoked" },
  });

  safePublish(`droplet/devices/${row.userId}/revoked`, { deviceId: row.id });
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
 * (`revokeDeviceClient` swallows a rejection, and `ncDeleteAppPassword` does not
 * check the HTTP status, so a refusal upstream is not seen here).
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
