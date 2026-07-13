/**
 * WARP-1014 — dual-shape chunk-owner resolution for `search_content`.
 *
 * Post-WARP-493, `FileContentChunk.userId` carries two key shapes:
 * nextcloud-watcher rows keep the Nextcloud username, brain rows use the
 * local `User.id` UUID. The caller key reaching the mcp-server is
 * single-shape (stdio `_meta.userId` = username; HTTP `claims.sub` =
 * UUID), so `resolveChunkOwnerIds` looks up the counterpart via the User
 * row. These tests pin the shape-routing (UUID → `id` lookup, otherwise
 * `username`), the fallback for unknown keys, and dedup.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { resolveChunkOwnerIds } from "../src/chunk-owner.js";

const UUID = "6f0f5a3e-2f4b-4a4e-9d7e-0a1b2c3d4e5f";

const findUnique = vi.fn();
const prisma = { user: { findUnique } } as unknown as PrismaClient;

beforeEach(() => {
  findUnique.mockReset();
});

describe("resolveChunkOwnerIds", () => {
  it("resolves the UUID counterpart for a username-shaped key (stdio _meta.userId)", async () => {
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice" });
    const ids = await resolveChunkOwnerIds(prisma, "alice");
    expect(ids).toEqual(["alice", UUID]);
    // Shape-routed lookup: non-UUID keys go through the unique
    // `username` column, never a cross-column OR (a caller must not be
    // able to resolve into another user's key set).
    expect(findUnique).toHaveBeenCalledWith({
      where: { username: "alice" },
      select: { id: true, username: true },
    });
  });

  it("resolves the username counterpart for a UUID-shaped key (HTTP claims.sub)", async () => {
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice" });
    const ids = await resolveChunkOwnerIds(prisma, UUID);
    expect(ids).toEqual([UUID, "alice"]);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: UUID },
      select: { id: true, username: true },
    });
  });

  it("falls back to the single incoming key when no User row matches", async () => {
    // Service principals, the auth-disabled dev stub, orphaned keys —
    // exactly the pre-WARP-1014 single-shape scope.
    findUnique.mockResolvedValueOnce(null);
    const ids = await resolveChunkOwnerIds(prisma, "_service:mcp");
    expect(ids).toEqual(["_service:mcp"]);
  });

  it("dedupes when the row echoes the incoming key", async () => {
    findUnique.mockResolvedValueOnce({ id: "dev", username: "dev" });
    const ids = await resolveChunkOwnerIds(prisma, "dev");
    expect(ids).toEqual(["dev"]);
  });
});
