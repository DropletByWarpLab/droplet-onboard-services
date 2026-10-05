/**
 * WARP-3510 — which Camera row is the real camera.
 *
 * Two writers create Camera rows for one physical device: camera-discovery
 * (via MQTT, a row per candidate it finds) and the operator (POST /cameras).
 * `Camera.adoption` is the explicit state that tells them apart — CANDIDATE is
 * a placeholder discovery may rename, merge or delete; ADOPTED is a camera in
 * Frigate that nothing but the operator may remove. It replaces the old guess
 * that `enabled = false` meant "never adopted", which made an operator-disabled
 * live camera look like a placeholder and renamable.
 *
 * This module holds what the two sides share: matching rows to a device, and
 * the operator's adoption transition (`adoptCameraRow`, used by manual add and
 * accept). The discovery side's merge lives with the MQTT handler in
 * camera.service.ts and uses the same helpers.
 */
import type { PrismaClient } from "@prisma/client";

import type { CameraKeySnapshot } from "./frigate.client.js";

export type CameraAdoptionState = "CANDIDATE" | "ADOPTED";

/**
 * The camera's hardware address, or null when camera-discovery only had a
 * placeholder.
 *
 * `_synthetic_lease_records` / the ONVIF branch in
 * `services/camera-discovery/main.py` key a camera by `ip:<addr>` or
 * `onvif_<addr>` when DHCP hasn't produced a real MAC yet. Those tokens are
 * per-IP, not per-device: the same camera carries `ip:192.168.9.219` on one
 * sweep and `e4:30:22:50:2a:fd` on the next. Storing them in `macAddress`
 * made them look like two different cameras to every reader.
 */
export function realMac(mac: unknown): string | null {
  const m = typeof mac === "string" ? mac.trim().toLowerCase() : "";
  if (!m || m.startsWith("ip:") || m.startsWith("onvif_")) return null;
  return m;
}

/** `camera_<ip>` is `_sanitize_camera_name`'s no-hostname fallback, not a name. */
export function isPlaceholderName(name: string): boolean {
  return /^camera_\d{1,3}_\d{1,3}_\d{1,3}_\d{1,3}$/.test(name);
}

/**
 * Of the rows that matched on name, MAC or IP, the ones that are the SAME
 * device. An IP match alone is not proof: DHCP recycles addresses, so when both
 * sides carry a real MAC the MAC is the only thing that decides. A row that
 * already owns `name` is always the same device (it is the one the unique
 * constraint would collide with).
 */
export function sameDeviceRows<T extends { name: string; macAddress: string | null }>(
  rows: T[],
  name: string,
  mac: string | null,
): T[] {
  return rows.filter((row) => {
    if (row.name === name) return true;
    const rowMac = realMac(row.macAddress);
    if (mac && rowMac) return rowMac === mac;
    return true;
  });
}

/**
 * Survivor order for rows of one device: ADOPTED first, then the oldest. The
 * oldest row used to win outright — and the oldest is usually the discovery
 * placeholder, so the operator's live camera was the one deleted.
 */
export function rankForSurvival<T extends { adoption: CameraAdoptionState; createdAt: Date }>(
  rows: T[],
): T[] {
  const rank = (r: T): number => (r.adoption === "ADOPTED" ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * What a Frigate reconcile needs from the DB: every row's name, and which of
 * them are ADOPTED. Read INSIDE the Frigate config lock (see
 * `syncCamerasFromDb`), never before it.
 */
export async function readCameraKeySnapshot(prisma: PrismaClient): Promise<CameraKeySnapshot> {
  const rows = await prisma.camera.findMany({ select: { name: true, adoption: true } });
  return {
    names: rows.map((r) => r.name),
    adopted: rows.filter((r) => r.adoption === "ADOPTED").map((r) => r.name),
  };
}

export interface AdoptCameraInput {
  /** The camera's Frigate key — `toFrigateKey` of what the operator typed. */
  key: string;
  /** The household-facing label (derived from what the operator typed). */
  displayName: string;
  ipAddress: string;
  /** A real hardware address when the request or the live candidate carries one. */
  macAddress?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  /** Set when the camera came from discovery (an accept), for a row created here. */
  autoDiscovered?: boolean;
}

export interface AdoptCameraResult {
  id: string;
  created: boolean;
  /** Names of the placeholder rows for the same device that were folded in. */
  absorbed: string[];
}

/**
 * The operator adopts a camera: make exactly one row for the device, ADOPTED,
 * named by its Frigate key.
 *
 * Looks for the device by name, then MAC, then IP, and prefers (1) the row that
 * already owns the key, else (2) the oldest discovery placeholder — adopted in
 * place, renamed to the key — over minting a duplicate. Other placeholders for
 * the same device are folded in (deleted). An ADOPTED row for the same device
 * under a different name is left strictly alone: that is a second camera (a
 * second stream profile), and renaming or removing it would orphan its
 * recordings.
 *
 * One transaction, and the CANDIDATE status is checked in the DELETE's own
 * WHERE (not only in the code that read the row), so a row adopted by another
 * request in the meantime survives.
 */
export async function adoptCameraRow(
  prisma: PrismaClient,
  input: AdoptCameraInput,
): Promise<AdoptCameraResult> {
  try {
    return await adoptOnce(prisma, input);
  } catch (err) {
    // Another writer — usually discovery's own upsert of the same camera, which
    // lands within milliseconds of an accept — created the row between this
    // transaction's read and its INSERT. The camera is already in Frigate, so
    // failing the request would be a lie: read again, and this time the row is
    // there to adopt.
    if ((err as { code?: unknown } | null)?.code === "P2002") return adoptOnce(prisma, input);
    throw err;
  }
}

async function adoptOnce(
  prisma: PrismaClient,
  input: AdoptCameraInput,
): Promise<AdoptCameraResult> {
  const mac = realMac(input.macAddress);
  const ip = input.ipAddress;

  return prisma.$transaction(async (tx) => {
    const matches = await tx.camera.findMany({
      where: {
        OR: [
          { name: input.key },
          ...(mac ? [{ macAddress: { equals: mac, mode: "insensitive" as const } }] : []),
          ...(ip ? [{ ipAddress: ip }] : []),
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    const same = sameDeviceRows(matches, input.key, mac);
    const candidates = same.filter((r) => r.adoption === "CANDIDATE");
    const target = same.find((r) => r.name === input.key) ?? candidates[0];

    if (!target) {
      const created = await tx.camera.create({
        data: {
          name: input.key,
          displayName: input.displayName,
          manufacturer: input.manufacturer || null,
          model: input.model || null,
          ipAddress: ip,
          macAddress: mac,
          enabled: true,
          autoDiscovered: input.autoDiscovered ?? false,
          adoption: "ADOPTED",
          lastSeen: new Date(),
        },
      });
      return { id: created.id, created: true, absorbed: [] };
    }

    const victims = candidates.filter((r) => r.id !== target.id);
    if (victims.length > 0) {
      await tx.camera.deleteMany({
        where: { id: { in: victims.map((v) => v.id) }, adoption: "CANDIDATE" },
      });
    }
    await tx.camera.update({
      where: { id: target.id },
      data: {
        name: input.key,
        displayName: input.displayName,
        // `|| undefined` is deliberate (not `?? null`): a manual add that omits
        // the address, manufacturer or model must KEEP what discovery already
        // learned, never clear it — Prisma skips `undefined` fields on update.
        ipAddress: ip || undefined,
        // Only ever upgrade toward a real MAC; never wipe one discovery learned.
        ...(mac ? { macAddress: mac } : {}),
        manufacturer: input.manufacturer || undefined,
        model: input.model || undefined,
        enabled: true,
        adoption: "ADOPTED",
        lastSeen: new Date(),
      },
    });
    return { id: target.id, created: false, absorbed: victims.map((v) => v.name) };
  });
}
