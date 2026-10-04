/**
 * WARP-3610 -- owner-held escrow of the backup repository key, shown ONCE.
 *
 * The restic repository password is derived on the host from DEVICE_SECRET_KEY
 * (scripts/host/droplet-backup-lib.sh, droplet_backup_derive_password). That
 * key lives only in this box's .env, so a replacement box cannot open a copy
 * of the repository made elsewhere. This lets the owner take the derived key
 * off the box one time.
 *
 * Same derivation, byte for byte, as the host script: HKDF-SHA256 (hkdfSync) with salt
 * "droplet-restic-v1" and info "droplet-restic-repository-password", L=32,
 * hex-encoded. Pinned by a known-answer test (here and in
 * tests/restic-backup.test.sh): changing it bricks every existing repository.
 *
 * "Once" is an explicit marker row (SystemFlag), claimed BEFORE the key is
 * derived: the primary key makes the claim atomic, so two concurrent requests
 * cannot both receive it. The key is never logged, never stored, and the
 * activity row records that an export happened, not what was exported.
 */
import { hkdfSync } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { recordActivity } from "./activity.singleton.js";
import type { ActivityActor } from "./activity.service.js";

export const BACKUP_KEY_EXPORT_FLAG = "backup-key-exported";

export class BackupKeyExportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackupKeyExportError";
  }
}

/** RFC 5869 HKDF-SHA256, one output block: identical to the host script's two HMACs. */
export function deriveBackupKey(ikm: string): string {
  return Buffer.from(
    hkdfSync("sha256", ikm, "droplet-restic-v1", "droplet-restic-repository-password", 32),
  ).toString("hex");
}

export async function exportBackupKeyOnce(
  prisma: PrismaClient,
  opts: { deviceSecretKey: string; actor: ActivityActor; actorUsername: string | null },
): Promise<string> {
  if (!opts.deviceSecretKey) {
    throw new BackupKeyExportError(503, "BACKUP_KEY_UNAVAILABLE", "this box has no device secret to derive the backup key from");
  }
  try {
    await prisma.systemFlag.create({
      data: {
        key: BACKUP_KEY_EXPORT_FLAG,
        valueJson: { exportedAt: new Date().toISOString(), by: opts.actorUsername },
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new BackupKeyExportError(409, "BACKUP_KEY_ALREADY_EXPORTED", "the backup key was already exported from this box");
    }
    throw err;
  }
  await recordActivity({
    kind: "system",
    severity: "warn",
    sourceIcon: "key-round",
    what: "Backup key exported",
    sub: "The owner took a copy of the backup repository key",
    refs: { actor: opts.actorUsername, via: "dashboard" },
    actor: opts.actor,
  });
  return deriveBackupKey(opts.deviceSecretKey);
}
