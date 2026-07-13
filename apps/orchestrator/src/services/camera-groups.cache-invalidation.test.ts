/**
 * WARP-1286 follow-up — camera-groups ensureCameraRows() can insert brand-new
 * Camera rows (group membership survives a fresh install where no one has
 * clicked through add-camera yet). A new row is invisible to getCameras()'s 5s
 * `cameras:list` cache until it expires. Group writes don't go through the
 * router's reconcileFrigateCameras() closure, so ensureCameraRows must bust the
 * cache itself — but only when it actually creates a row. Pure membership edits
 * over already-existing cameras don't change the set and must NOT invalidate.
 *
 * Both createGroup() and addMembers() funnel through ensureCameraRows(), so this
 * exercises the shared choke point via addMembers().
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invalidateCamerasCache = vi.fn(async (..._a: unknown[]) => {});
vi.mock("./camera.service.js", () => ({
  invalidateCamerasCache: (...a: unknown[]) => invalidateCamerasCache(...a),
}));

import { addMembers } from "./camera-groups.service.js";

/** Minimal stateful prisma fake: a Camera table (for ensureCameraRows) plus the
 *  cameraGroup / cameraGroupMember calls addMembers makes on the return path. */
function makePrisma(seedCameraNames: string[]) {
  const cameras = seedCameraNames.map((name, i) => ({ id: `cam-${i}`, name }));
  return {
    camera: {
      findMany: vi.fn(async ({ where }: { where: { name: { in: string[] } } }) => {
        const wanted = new Set(where.name.in);
        return cameras.filter((c) => wanted.has(c.name)).map((c) => ({ name: c.name }));
      }),
      upsert: vi.fn(async ({ where, create }: { where: { name: string }; create: { name: string } }) => {
        let row = cameras.find((c) => c.name === where.name);
        if (!row) {
          row = { id: `cam-${cameras.length}`, name: create.name };
          cameras.push(row);
        }
        return { id: row.id, name: row.name };
      }),
    },
    cameraGroup: {
      // Serves both the existence check (where:{id}) and getGroup's include read.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        name: "Front of house",
        icon: null,
        sortOrder: 0,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        members: [],
      })),
    },
    cameraGroupMember: {
      aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-1286 follow-up — ensureCameraRows invalidates cameras:list when it upserts group members", () => {
  it("invalidates when a member references a camera with no existing row (the add-side bug)", async () => {
    const prisma = makePrisma(["front_door"]);
    await addMembers(prisma as never, "grp-1", ["front_door", "garage"]);
    // "garage" had no row → a new row was inserted → cache must be busted so the
    // new camera is visible in cameras:list before the 5s TTL expires.
    expect(prisma.camera.upsert).toHaveBeenCalledTimes(2);
    expect(invalidateCamerasCache).toHaveBeenCalledTimes(1);
  });

  it("does NOT invalidate when the request has no valid camera names (early return, no upsert)", async () => {
    const prisma = makePrisma(["front_door"]);
    // Empty names are filtered out (length > 0 guard) → addMembers returns before
    // ensureCameraRows, so nothing touches the camera table and the cache is
    // left intact.
    await addMembers(prisma as never, "grp-1", ["", ""]);
    expect(prisma.camera.upsert).not.toHaveBeenCalled();
    expect(invalidateCamerasCache).not.toHaveBeenCalled();
  });
});
