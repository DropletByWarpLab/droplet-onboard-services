/**
 * Camera-group service.
 *
 * Operator-defined logical groupings (Front of house / Backyard / etc.)
 * rendered as a navigation rail above the cameras grid. Membership is
 * stored as `CameraGroupMember` rows so we can carry per-group sortOrder
 * and so deletion of either side cascades cleanly via Prisma's
 * `onDelete: Cascade`.
 *
 * The shape we hand to the dashboard is denormalized — each group ships
 * with the names of its member cameras so the frontend doesn't have to
 * cross-reference against `/api/cameras` for the rail render. The full
 * `CameraInfo` (status, IP, etc.) still comes from `/api/cameras`; this
 * service only knows about identity and ordering.
 */

import type { PrismaClient } from "@prisma/client";
import { invalidateCamerasCache } from "./camera.service.js";

export interface GroupMemberDTO {
  /** Frigate-key for the camera; matches CameraInfo.name on the wire.
   *  The DB-side `Camera.id` is intentionally not exposed — clients
   *  reference cameras by name everywhere else in the API. */
  cameraName: string;
  cameraDisplayName: string;
  sortOrder: number;
}

export interface GroupDTO {
  id: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  members: GroupMemberDTO[];
  createdAt: string;
  updatedAt: string;
}

const NAME_RE = /^[\p{L}\p{N} _\-&'()/]{1,60}$/u;

/** True when `name` is a valid group label.
 *
 *  Allows letters, numbers, spaces, common punctuation in names; rejects
 *  newlines, tabs, control chars. Cap is 60 to keep the rail tile from
 *  blowing out on a tiny phone width. */
export function isValidGroupName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name);
}

/** Icon is optional; if present it's stored as plain text (the dashboard
 *  picks an emoji or Lucide-icon name). Cap a few chars to keep the rail
 *  tile compact and to defend against pasting an arbitrary string. */
const ICON_RE = /^[\p{L}\p{N}\p{Emoji_Presentation}\p{Extended_Pictographic}_\-]{0,32}$/u;
export function isValidGroupIcon(icon: unknown): icon is string | null | undefined {
  if (icon === undefined || icon === null) return true;
  return typeof icon === "string" && ICON_RE.test(icon);
}

function toDTO(group: {
  id: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  members: Array<{
    cameraId: string;
    sortOrder: number;
    camera: { name: string; displayName: string };
  }>;
}): GroupDTO {
  return {
    id: group.id,
    name: group.name,
    icon: group.icon,
    sortOrder: group.sortOrder,
    members: group.members
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.camera.displayName.localeCompare(b.camera.displayName))
      .map((m) => ({
        cameraName: m.camera.name,
        cameraDisplayName: m.camera.displayName,
        sortOrder: m.sortOrder,
      })),
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

const memberInclude = {
  members: {
    include: {
      camera: { select: { name: true, displayName: true } },
    },
  },
} as const;

export async function listGroups(prisma: PrismaClient): Promise<GroupDTO[]> {
  const rows = await prisma.cameraGroup.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: memberInclude,
  });
  return rows.map(toDTO);
}

export async function getGroup(
  prisma: PrismaClient,
  id: string,
): Promise<GroupDTO | null> {
  const row = await prisma.cameraGroup.findUnique({
    where: { id },
    include: memberInclude,
  });
  return row ? toDTO(row) : null;
}

/** Resolves a list of Frigate camera names into DB Camera rows, creating
 *  any that don't already have a row. Frigate is the source of truth for
 *  what cameras exist; the Camera Prisma table is just our metadata
 *  attachment point. We upsert by `name` so group membership can survive
 *  a fresh device install where no one has clicked through the
 *  add-camera flow yet. Returns the canonical DB IDs. */
async function ensureCameraRows(
  prisma: PrismaClient,
  cameraNames: string[],
): Promise<Map<string, string>> {
  const idByName = new Map<string, string>();
  if (cameraNames.length === 0) return idByName;
  // De-dupe so we don't spam upsert on a repeated input.
  const unique = Array.from(new Set(cameraNames));
  for (const name of unique) {
    const row = await prisma.camera.upsert({
      where: { name },
      update: {}, // no-op if it already exists
      create: {
        name,
        // Display name defaults to a humanised version of the Frigate
        // key — the operator can rename it later via the metadata
        // endpoint. We don't try to fetch real metadata from Frigate
        // here because that would couple group writes to Frigate's
        // availability.
        displayName: name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        ipAddress: "",
        autoDiscovered: false,
      },
      select: { id: true, name: true },
    });
    idByName.set(row.name, row.id);
  }
  // WARP-1286 follow-up: these upserts can insert brand-new Camera rows (group
  // membership survives a fresh install where no one clicked add-camera yet). A
  // new row is invisible to getCameras()'s 5s `cameras:list` cache until it
  // expires, and group writes don't pass through the router's
  // reconcileFrigateCameras() closure — so bust the cache here at the source.
  // Invalidated unconditionally rather than only-on-insert: telling an insert
  // from a no-op upsert would need an extra pre-read that still races a
  // concurrent delete, while over-invalidating a rare group edit costs at most
  // one rebuild, throttled by the 5s TTL.
  await invalidateCamerasCache();
  return idByName;
}

/** Creates a group and (optionally) seeds its initial members. The
 *  cameraNames are upserted into the Camera table so group membership
 *  is FK-safe even if the operator never visits the add-camera flow. */
export async function createGroup(
  prisma: PrismaClient,
  input: { name: string; icon?: string | null; cameraNames?: string[] },
): Promise<GroupDTO> {
  const cameraNames = input.cameraNames?.filter((s) => typeof s === "string" && s.length > 0) ?? [];

  // sortOrder defaults to one above the current max so a new group lands
  // at the end of the rail by default.
  const maxRow = await prisma.cameraGroup.aggregate({
    _max: { sortOrder: true },
  });
  const nextSort = (maxRow._max.sortOrder ?? -1) + 1;

  const idByName = await ensureCameraRows(prisma, cameraNames);

  const created = await prisma.$transaction(async (tx) => {
    const group = await tx.cameraGroup.create({
      data: {
        name: input.name,
        icon: input.icon ?? null,
        sortOrder: nextSort,
      },
    });
    if (idByName.size > 0) {
      await tx.cameraGroupMember.createMany({
        data: cameraNames
          .filter((n) => idByName.has(n))
          .map((n, idx) => ({
            groupId: group.id,
            cameraId: idByName.get(n)!,
            sortOrder: idx,
          })),
        skipDuplicates: true,
      });
    }
    return tx.cameraGroup.findUnique({
      where: { id: group.id },
      include: memberInclude,
    });
  });
  if (!created) throw new Error("Group disappeared mid-transaction");
  return toDTO(created);
}

export async function updateGroup(
  prisma: PrismaClient,
  id: string,
  input: { name?: string; icon?: string | null; sortOrder?: number },
): Promise<GroupDTO | null> {
  // Build the patch explicitly so an unset field doesn't get clobbered to
  // undefined by Prisma's "set to undefined" semantic.
  const data: { name?: string; icon?: string | null; sortOrder?: number } = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.icon !== undefined) data.icon = input.icon;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (Object.keys(data).length === 0) {
    return getGroup(prisma, id);
  }
  try {
    const updated = await prisma.cameraGroup.update({
      where: { id },
      data,
      include: memberInclude,
    });
    return toDTO(updated);
  } catch (err) {
    // P2025 = record not found
    if ((err as { code?: string })?.code === "P2025") return null;
    throw err;
  }
}

/** Deletes the group; member rows cascade via Prisma's onDelete: Cascade. */
export async function deleteGroup(
  prisma: PrismaClient,
  id: string,
): Promise<boolean> {
  try {
    await prisma.cameraGroup.delete({ where: { id } });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") return false;
    throw err;
  }
}

/** Bulk-add cameras to a group by Frigate name. Camera rows are upserted
 *  on demand. Skips names that are empty strings. Returns the refreshed
 *  group, or null if the group itself doesn't exist. */
export async function addMembers(
  prisma: PrismaClient,
  groupId: string,
  cameraNames: string[],
): Promise<GroupDTO | null> {
  // Verify the group exists first so we don't upsert Camera rows for a
  // request that's going to 404 anyway.
  const group = await prisma.cameraGroup.findUnique({ where: { id: groupId } });
  if (!group) return null;

  const valid = cameraNames.filter((s) => typeof s === "string" && s.length > 0);
  if (valid.length === 0) return getGroup(prisma, groupId);

  const idByName = await ensureCameraRows(prisma, valid);

  // sortOrder for new members starts above the current max within this
  // group so they appear at the end.
  const max = await prisma.cameraGroupMember.aggregate({
    where: { groupId },
    _max: { sortOrder: true },
  });
  const baseSort = (max._max.sortOrder ?? -1) + 1;

  await prisma.cameraGroupMember.createMany({
    data: valid
      .filter((n) => idByName.has(n))
      .map((n, idx) => ({
        groupId,
        cameraId: idByName.get(n)!,
        sortOrder: baseSort + idx,
      })),
    skipDuplicates: true,
  });

  return getGroup(prisma, groupId);
}

/** Removes a member by Frigate camera name. No-op if the camera or
 *  membership doesn't exist. */
export async function removeMember(
  prisma: PrismaClient,
  groupId: string,
  cameraName: string,
): Promise<GroupDTO | null> {
  const cam = await prisma.camera.findUnique({
    where: { name: cameraName },
    select: { id: true },
  });
  if (cam) {
    await prisma.cameraGroupMember.deleteMany({
      where: { groupId, cameraId: cam.id },
    });
  }
  return getGroup(prisma, groupId);
}
