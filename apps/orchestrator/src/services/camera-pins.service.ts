/**
 * Per-user camera pin service.
 *
 * Pins are operator preferences — "show this camera at the top of my
 * grid" — keyed by Frigate camera NAME rather than a DB Camera FK. We
 * pay no FK cost because pins are low-stakes prefs: if the underlying
 * camera disappears we just filter the dangling pin on read instead of
 * cascading deletes. Pins are scoped to a user, NOT shared, so two
 * operators on the same Droplet can pin different sets.
 *
 * The orchestrator's auth middleware populates req.user.id; that's the
 * userId we key on. The Camera Prisma table doesn't need to have a row
 * for the camera being pinned (Frigate is the source of truth for
 * which cameras exist).
 */

import type { PrismaClient } from "@prisma/client";

export interface PinDTO {
  cameraName: string;
  sortOrder: number;
  createdAt: string;
}

export async function listPins(
  prisma: PrismaClient,
  userId: string,
): Promise<PinDTO[]> {
  const rows = await prisma.cameraPin.findMany({
    where: { userId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({
    cameraName: r.cameraName,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Idempotent. Pinning an already-pinned camera updates sortOrder
 *  (so a "pin again" can move it to the top) but otherwise no-ops. */
export async function addPin(
  prisma: PrismaClient,
  userId: string,
  cameraName: string,
): Promise<PinDTO> {
  // Place new pins at the top by default (lowest sortOrder seen so far
  // minus 1). The dashboard usually wants the most-recently-pinned to
  // jump above existing pins; an explicit reorder call follows if the
  // operator drags it elsewhere.
  const min = await prisma.cameraPin.aggregate({
    where: { userId },
    _min: { sortOrder: true },
  });
  const nextSort = (min._min.sortOrder ?? 0) - 1;

  const pin = await prisma.cameraPin.upsert({
    where: { userId_cameraName: { userId, cameraName } },
    create: { userId, cameraName, sortOrder: nextSort },
    update: { sortOrder: nextSort },
  });
  return {
    cameraName: pin.cameraName,
    sortOrder: pin.sortOrder,
    createdAt: pin.createdAt.toISOString(),
  };
}

/** Idempotent — unpin of a never-pinned camera is a no-op (200 OK). */
export async function removePin(
  prisma: PrismaClient,
  userId: string,
  cameraName: string,
): Promise<void> {
  await prisma.cameraPin.deleteMany({ where: { userId, cameraName } });
}

/** Replace this user's pin order with the supplied list. Cameras in
 *  the list keep their pin (and get sortOrder=index); cameras NOT in
 *  the list lose their pin entirely. We delete-then-recreate inside a
 *  transaction so the new ordering doesn't leave half-applied state on
 *  failure. */
export async function reorderPins(
  prisma: PrismaClient,
  userId: string,
  cameraNames: string[],
): Promise<PinDTO[]> {
  await prisma.$transaction(async (tx) => {
    await tx.cameraPin.deleteMany({ where: { userId } });
    if (cameraNames.length > 0) {
      await tx.cameraPin.createMany({
        data: cameraNames.map((cameraName, idx) => ({
          userId,
          cameraName,
          sortOrder: idx,
        })),
        skipDuplicates: true,
      });
    }
  });
  return listPins(prisma, userId);
}
