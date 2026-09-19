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
const deptFindMany = vi.fn();
const memberFindMany = vi.fn();
const prisma = {
  user: { findUnique },
  department: { findMany: deptFindMany },
  departmentMembership: { findMany: memberFindMany },
} as unknown as PrismaClient;

beforeEach(() => {
  findUnique.mockReset();
  // Default: the caller belongs to no department, so the pre-WARP-2821
  // expectations below read exactly as they always did.
  deptFindMany.mockReset().mockResolvedValue([]);
  memberFindMany.mockReset().mockResolvedValue([]);
});

describe("resolveChunkOwnerIds", () => {
  it("resolves the UUID counterpart for a username-shaped key (stdio _meta.userId)", async () => {
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice", role: "family" });
    const ids = await resolveChunkOwnerIds(prisma, "alice");
    expect(ids).toEqual(["alice", UUID]);
    // Shape-routed lookup: non-UUID keys go through the unique
    // `username` column, never a cross-column OR (a caller must not be
    // able to resolve into another user's key set).
    expect(findUnique).toHaveBeenCalledWith({
      where: { username: "alice" },
      select: { id: true, username: true, role: true },
    });
  });

  it("resolves the username counterpart for a UUID-shaped key (HTTP claims.sub)", async () => {
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice", role: "family" });
    const ids = await resolveChunkOwnerIds(prisma, UUID);
    expect(ids).toEqual([UUID, "alice"]);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: UUID },
      select: { id: true, username: true, role: true },
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
    findUnique.mockResolvedValueOnce({ id: "dev", username: "dev", role: "family" });
    const ids = await resolveChunkOwnerIds(prisma, "dev");
    expect(ids).toEqual(["dev"]);
  });
});


/**
 * WARP-2821 — the shared corpus the assistant could not see.
 *
 * The file-indexer writes every groupfolder document under a sentinel owner
 * (`__household__`, or `__dept_<uuid>__` since WARP-1264). This resolver
 * returned only the caller's two personal key shapes, so `search_content`
 * silently returned fewer hits and `read_document_text` answered NOT_INDEXED
 * for a file the Files page was listing on the same screen.
 *
 * The rule mirrored here is `deptSearchCorpora` / `visibleDeptsForCaller` in
 * `apps/orchestrator/src/routes/files.ts`. Widening it beyond that rule would
 * let the assistant read what the caller cannot open.
 */
const DEPT_A = "6e2c9e2a-1111-4c1a-9c1a-000000000001";
const HOUSE = "6e2c9e2a-9999-4c1a-9c1a-000000000009";

describe("resolveChunkOwnerIds — department corpora (WARP-2821)", () => {
  it("adds one sentinel per department the caller is a member of", async () => {
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice", role: "family" });
    memberFindMany.mockResolvedValueOnce([{ department: { id: DEPT_A, kind: "TEAM" } }]);

    const ids = await resolveChunkOwnerIds(prisma, "alice");
    expect(ids).toEqual(["alice", UUID, `__dept_${DEPT_A}__`]);
  });

  it("scopes a non-privileged caller to their OWN active memberships", async () => {
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice", role: "family" });
    memberFindMany.mockResolvedValueOnce([]);

    await resolveChunkOwnerIds(prisma, "alice");
    // Never a bare department scan for a member: that is the difference
    // between "the departments I am in" and "every department on the box".
    // The BRANCH is what matters here; the query's exact shape belongs to
    // `visibleDepartmentsFor` and is pinned by its own suite in tools-core.
    expect(deptFindMany).not.toHaveBeenCalled();
    expect(memberFindMany).toHaveBeenCalledOnce();
    expect(memberFindMany.mock.calls[0]![0]).toMatchObject({
      where: { userId: UUID, department: { state: "active" } },
    });
  });

  it("gives an owner every ACTIVE department, matching the Files rule", async () => {
    findUnique.mockResolvedValueOnce({ id: UUID, username: "stefan", role: "owner" });
    deptFindMany.mockResolvedValueOnce([{ id: DEPT_A, kind: "TEAM" }]);

    const ids = await resolveChunkOwnerIds(prisma, "stefan");
    expect(ids).toContain(`__dept_${DEPT_A}__`);
    expect(memberFindMany).not.toHaveBeenCalled();
    expect(deptFindMany).toHaveBeenCalledOnce();
    expect(deptFindMany.mock.calls[0]![0]).toMatchObject({ where: { state: "active" } });
  });

  it("admins are privileged too", async () => {
    findUnique.mockResolvedValueOnce({ id: UUID, username: "romain", role: "admin" });
    deptFindMany.mockResolvedValueOnce([{ id: DEPT_A, kind: "TEAM" }]);
    const ids = await resolveChunkOwnerIds(prisma, "romain");
    expect(ids).toContain(`__dept_${DEPT_A}__`);
  });

  it("dual-sentinels the HOUSEHOLD department, both forms", async () => {
    // Old watcher builds wrote `__household__`; WARP-1264 builds write the
    // uuid form. Neither is reindexed, so a caller needs both or half the
    // shared drive stays invisible.
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice", role: "family" });
    memberFindMany.mockResolvedValueOnce([{ department: { id: HOUSE, kind: "HOUSEHOLD" } }]);

    const ids = await resolveChunkOwnerIds(prisma, "alice");
    expect(ids).toContain("__household__");
    expect(ids).toContain(`__dept_${HOUSE}__`);
  });

  it("gives an UNKNOWN key no department corpora at all", async () => {
    // A service principal or an orphaned key must never widen into shared
    // content — it stays exactly the pre-WARP-1014 single-shape scope.
    findUnique.mockResolvedValueOnce(null);
    const ids = await resolveChunkOwnerIds(prisma, "_service:mcp");
    expect(ids).toEqual(["_service:mcp"]);
    expect(deptFindMany).not.toHaveBeenCalled();
    expect(memberFindMany).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED — a department lookup error yields personal keys only", async () => {
    // Narrowing can only hide content. Widening on a half-answered query
    // would disclose it, so the error path must never fall back to "all".
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice", role: "family" });
    memberFindMany.mockRejectedValueOnce(new Error("db down"));

    const ids = await resolveChunkOwnerIds(prisma, "alice");
    expect(ids).toEqual(["alice", UUID]);
  });

  it("SAYS SO on the way down — the fail-closed path is not silent", async () => {
    // Degrading quietly makes a real bug in this lookup indistinguishable from
    // "this caller is in no departments", forever: the assistant just stops
    // finding shared documents and nothing anywhere says why. The orchestrator's
    // equivalent catch already logs; this one has to as well.
    //
    // STDERR, never stdout: the stdio transport carries JSON-RPC on stdout and
    // any other byte on it corrupts the stream.
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      findUnique.mockResolvedValueOnce({ id: UUID, username: "alice", role: "family" });
      memberFindMany.mockRejectedValueOnce(new Error("db down"));

      await resolveChunkOwnerIds(prisma, "alice");

      expect(stderr).toHaveBeenCalledTimes(1);
      const [message, err] = stderr.mock.calls[0];
      expect(String(message)).toContain("department lookup failed");
      expect((err as Error).message).toBe("db down");
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it("dedupes when two departments would emit the same sentinel", async () => {
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice", role: "family" });
    memberFindMany.mockResolvedValueOnce([
      { department: { id: HOUSE, kind: "HOUSEHOLD" } },
      { department: { id: HOUSE, kind: "HOUSEHOLD" } },
    ]);
    const ids = await resolveChunkOwnerIds(prisma, "alice");
    expect(ids.filter((k) => k === "__household__")).toHaveLength(1);
    expect(ids.filter((k) => k === `__dept_${HOUSE}__`)).toHaveLength(1);
  });

  it("keeps the incoming key FIRST, so the historical $1 binding is unchanged", async () => {
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice", role: "family" });
    memberFindMany.mockResolvedValueOnce([{ department: { id: DEPT_A, kind: "TEAM" } }]);
    const ids = await resolveChunkOwnerIds(prisma, "alice");
    expect(ids[0]).toBe("alice");
  });

  it("emits the EXACT sentinel the indexer writes", async () => {
    // `watcher.py:176` writes f"__dept_{id}__". Any other spelling here is
    // silent and reads as "the department has no documents".
    findUnique.mockResolvedValueOnce({ id: UUID, username: "alice", role: "family" });
    memberFindMany.mockResolvedValueOnce([{ department: { id: "dept-uuid-42", kind: "TEAM" } }]);
    const ids = await resolveChunkOwnerIds(prisma, "alice");
    expect(ids).toContain("__dept_dept-uuid-42__");
  });
});
