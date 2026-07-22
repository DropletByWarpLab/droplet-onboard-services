/**
 * WARP-1274 (T21) — ADR-029 security checklist automation, part 1.
 *
 * AGGREGATES scenarios that chain multiple already-shipped units together
 * to prove properties the checklist promises but no single existing spec
 * exercises end-to-end. Does NOT duplicate:
 *   - the full requireSpaceAccess/checkSpaceAccess truth table
 *     (space-access.test.ts)
 *   - department-membership.service's authz / transition-ordering /
 *     last-manager unit tests (department-membership.service.test.ts)
 *   - the search-corpus / aclVersion-cache-key mechanics in isolation
 *     (files-search-content.test.ts)
 *   - provisionDepartment's single-call dedupe-by-mount-point unit test
 *     (department-provisioner.service.test.ts)
 *
 * See docs/security/ADR-029-checklist.md for the full §8 checklist → test
 * mapping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

// ── Shared module mocks (mirrors space-access.test.ts / files-search-
//    content.test.ts / department-membership.service.test.ts — the three
//    real production modules this suite drives together) ─────────────────

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    MAX_UPLOAD_SIZE_MB: 100,
    NEXTCLOUD_URL: "http://nextcloud.test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const recordActivityMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...args: unknown[]) => recordActivityMock(...args),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("ncTokenStub"),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncEnsureGroup: vi.fn().mockResolvedValue(undefined),
  ncGetFileId: vi.fn(),
  ncListFiles: vi.fn(),
  ncUploadFile: vi.fn(),
  ncDownloadFile: vi.fn(),
  ncDeleteFile: vi.fn(),
  ncCreateDirectory: vi.fn(),
  ncListShares: vi.fn(),
  ncMoveFile: vi.fn(),
  ncCopyFile: vi.fn(),
  ncListTrash: vi.fn(),
  ncRestoreTrashItem: vi.fn(),
  ncDeleteTrashItem: vi.fn(),
  ncEmptyTrash: vi.fn(),
  ncListVersions: vi.fn(),
  ncRestoreVersion: vi.fn(),
  ncSetFavorite: vi.fn(),
  ncListFavorites: vi.fn(),
  ncSearchFiles: vi.fn().mockResolvedValue([]),
  ncListRecents: vi.fn(),
  ncFetchThumbnail: vi.fn(),
  ncCreateShareV2: vi.fn(),
  ncUpdateShare: vi.fn(),
  ncDeleteShare: vi.fn(),
  ncListSharedWithMe: vi.fn(),
  ncListMyShares: vi.fn(),
  ncGetShare: vi.fn(),
  ncDirExists: vi.fn(),
  NextcloudOcsError: class NextcloudOcsError extends Error {
    ocsStatus: number;
    constructor(message: string, ocsStatus = 400) {
      super(message);
      this.ocsStatus = ocsStatus;
    }
  },
}));

const searchByLexicalMock = vi.fn();
vi.mock("../services/file-search.service.js", () => ({
  searchByLexical: (...args: unknown[]) => searchByLexicalMock(...args),
  searchHybrid: vi.fn(),
}));

// department-membership.service.ts AND department-provisioner.service.ts
// (real modules under test in this file) both talk to NC through this
// module — mocked so the real functions run end to end but never touch a
// network.
const {
  ncAddUserToGroupMock,
  ncRemoveUserFromGroupMock,
  gfListFoldersMock,
  gfCreateFolderMock,
  gfAddGroupMock,
  gfSetGroupPermissionsMock,
  gfSetQuotaMock,
} = vi.hoisted(() => ({
  ncAddUserToGroupMock: vi.fn().mockResolvedValue(undefined),
  ncRemoveUserFromGroupMock: vi.fn().mockResolvedValue(undefined),
  gfListFoldersMock: vi.fn().mockResolvedValue([]),
  gfCreateFolderMock: vi.fn().mockResolvedValue(101),
  gfAddGroupMock: vi.fn().mockResolvedValue(undefined),
  gfSetGroupPermissionsMock: vi.fn().mockResolvedValue(undefined),
  gfSetQuotaMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  ncAddUserToGroup: ncAddUserToGroupMock,
  ncRemoveUserFromGroup: ncRemoveUserFromGroupMock,
  gfListFolders: gfListFoldersMock,
  gfCreateFolder: gfCreateFolderMock,
  gfAddGroup: gfAddGroupMock,
  gfSetGroupPermissions: gfSetGroupPermissionsMock,
  gfSetQuota: gfSetQuotaMock,
}));

import { createFilesRouter } from "../routes/files.js";
import { checkSpaceAccess, type SpaceAccessCaller } from "../middleware/space.js";
import { removeMembership } from "../services/department-membership.service.js";
import { provisionDepartment } from "../services/department-provisioner.service.js";
import type { AuthUser } from "../middleware/auth.js";

// ── A single composite in-memory Prisma double the whole suite shares.
//    Backs THREE real production modules at once (department-membership.
//    service.ts, middleware/space.ts, routes/files.ts) so a single mutation
//    (removeMembership) can be observed moving all three surfaces together
//    in one scenario — that combination is the actual gap this ticket
//    closes, not any one surface in isolation. ─────────────────────────────

interface DeptRow {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  kind: string;
  state: string;
  ncGroupRw: string | null;
  ncGroupRo: string | null;
  ncGroupfolderId: number | null;
  quotaBytes: bigint | null;
  aclVersion: number;
}
interface MembershipRow {
  id: string;
  departmentId: string;
  userId: string;
  right: string;
  syncState: string;
  syncError: string | null;
}
interface UserRow {
  id: string;
  nextcloudUsername: string | null;
}

function buildWorld() {
  const departments = new Map<string, DeptRow>();
  const membershipsById = new Map<string, MembershipRow>();
  const users = new Map<string, UserRow>();
  let memSeq = 1;

  const byKey = () => {
    const m = new Map<string, MembershipRow>();
    for (const row of membershipsById.values()) {
      m.set(`${row.departmentId}:${row.userId}`, row);
    }
    return m;
  };

  const self: any = {};
  self.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(self));

  self.department = {
    findUnique: vi.fn(async ({ where, select }: any) => {
      const dept = departments.get(where.id);
      if (!dept) return null;
      if (select) {
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = (dept as any)[k];
        return out;
      }
      return { ...dept };
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      for (const d of departments.values()) {
        if (where?.kind && d.kind === where.kind) return { ...d };
      }
      return null;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const dept = departments.get(where.id);
      if (!dept) throw new Error(`no such department ${where.id}`);
      if (data.aclVersion?.increment) {
        dept.aclVersion = (dept.aclVersion ?? 0) + data.aclVersion.increment;
      }
      for (const [k, v] of Object.entries(data)) {
        if (k !== "aclVersion") (dept as any)[k] = v;
      }
      return { ...dept };
    }),
  };

  self.departmentMembership = {
    findUnique: vi.fn(async ({ where }: any) => {
      if (where.departmentId_userId) {
        const key = `${where.departmentId_userId.departmentId}:${where.departmentId_userId.userId}`;
        const row = byKey().get(key);
        return row ? { ...row } : null;
      }
      const row = membershipsById.get(where.id);
      return row ? { ...row } : null;
    }),
    // deptSearchCorpora's non-owner branch: departmentMembership.findMany({
    //   where: { userId, department: { state: "active" } },
    //   select: { department: { select: { id, kind, aclVersion } } },
    // })
    findMany: vi.fn(async ({ where }: any) => {
      const rows = [...membershipsById.values()].filter((m) => m.userId === where.userId);
      const out: Array<{ department: { id: string; kind: string; aclVersion: number } }> = [];
      for (const row of rows) {
        const dept = departments.get(row.departmentId);
        if (!dept) continue;
        if (where.department?.state && dept.state !== where.department.state) continue;
        out.push({ department: { id: dept.id, kind: dept.kind, aclVersion: dept.aclVersion } });
      }
      return out;
    }),
    create: vi.fn(async ({ data }: any) => {
      const row: MembershipRow = {
        id: `mem-${memSeq++}`,
        syncError: null,
        ...data,
      };
      membershipsById.set(row.id, row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      let row: MembershipRow | undefined;
      if (where.departmentId_userId) {
        row = byKey().get(`${where.departmentId_userId.departmentId}:${where.departmentId_userId.userId}`);
      } else {
        row = membershipsById.get(where.id);
      }
      if (!row) throw new Error("membership not found");
      Object.assign(row, data);
      return { ...row };
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = membershipsById.get(where.id);
      if (!row) throw new Error("membership not found");
      membershipsById.delete(where.id);
      return { ...row };
    }),
    count: vi.fn(async ({ where }: any) => {
      let n = 0;
      for (const m of membershipsById.values()) {
        if (m.departmentId !== where.departmentId) continue;
        if (where.right && m.right !== where.right) continue;
        n += 1;
      }
      return n;
    }),
  };

  self.user = {
    findUnique: vi.fn(async ({ where }: any) => {
      const u = users.get(where.id);
      return u ? { ...u } : null;
    }),
  };

  return { prisma: self as PrismaClient, departments, membershipsById, users };
}

function seedDept(departments: Map<string, DeptRow>, over: Partial<DeptRow> & { id: string }): DeptRow {
  const dept: DeptRow = {
    name: over.id,
    slug: over.id,
    parentId: null,
    kind: "DEPARTMENT",
    state: "active",
    ncGroupRw: `dept-${over.id}`,
    ncGroupRo: `dept-${over.id}-ro`,
    ncGroupfolderId: null,
    quotaBytes: null,
    aclVersion: 0,
    ...over,
  };
  departments.set(dept.id, dept);
  return dept;
}

function seedUser(users: Map<string, UserRow>, id: string, nextcloudUsername: string | null): void {
  users.set(id, { id, nextcloudUsername });
}

function seedMembership(
  membershipsById: Map<string, MembershipRow>,
  row: Omit<MembershipRow, "syncError"> & { syncError?: string | null },
): void {
  membershipsById.set(row.id, { syncError: null, ...row });
}

function mkGateUser(role: AuthUser["role"], id: string): AuthUser {
  return { id, username: `${id}-nc`, displayName: id, role };
}

function buildGateApp(prisma: PrismaClient, user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createFilesRouter(prisma));
  return app;
}

/** Minimal fake `Request` for calling `checkSpaceAccess` directly (mirrors
 * space-access.test.ts's buildReq). */
function fakeReq(user: { id: string; role: string }): Request {
  return {
    user,
    method: "GET",
    path: "/api/files/whatever",
    header: () => undefined,
  } as unknown as Request;
}

beforeEach(() => {
  recordActivityMock.mockClear();
  ncAddUserToGroupMock.mockClear();
  ncRemoveUserFromGroupMock.mockClear();
  ncAddUserToGroupMock.mockResolvedValue(undefined);
  ncRemoveUserFromGroupMock.mockResolvedValue(undefined);
  gfListFoldersMock.mockReset().mockResolvedValue([]);
  gfCreateFolderMock.mockReset().mockResolvedValue(101);
  gfAddGroupMock.mockReset().mockResolvedValue(undefined);
  gfSetGroupPermissionsMock.mockReset().mockResolvedValue(undefined);
  gfSetQuotaMock.mockReset().mockResolvedValue(undefined);
  searchByLexicalMock.mockReset();
  searchByLexicalMock.mockResolvedValue([]);
});

// ── (a) Revocation end-to-end ───────────────────────────────────────────
//
// One removeMembership() call must simultaneously: (1) make the search
// corpus stop including the department, (2) change the search cache key
// (so a request racing the revocation can never be served a pre-revocation
// cached result), and (3) make the policy-layer gate (checkSpaceAccess —
// the same function every metadata route composes) deny the caller. All
// three read Prisma directly with no ACL cache, so all three must move at
// the SAME commit — this is the "zero staleness window" claim from brief
// §3.1/§3.2, proven as one scenario instead of three separate assumptions.

describe("(a) revocation end-to-end", () => {
  it("removeMembership makes the search corpus, the cache key, AND checkSpaceAccess all move together", async () => {
    const { prisma, departments, membershipsById, users } = buildWorld();
    const dept = seedDept(departments, { id: "dept-fin", aclVersion: 5 });
    seedUser(users, "member-1", "member1nc");
    seedMembership(membershipsById, {
      id: "mem-1",
      departmentId: dept.id,
      userId: "member-1",
      right: "contributor",
      syncState: "synced",
    });

    const caller: SpaceAccessCaller = { id: "member-1", role: "family" };

    // BEFORE: policy access is granted …
    const before = await checkSpaceAccess(prisma, fakeReq(caller), caller, dept.id, "contributor");
    expect(before).toEqual({ allowed: true, departmentId: dept.id });

    // … and the search corpus includes the department's sentinel via the
    // real createFilesRouter route (mode=keyword avoids the gRPC embed).
    const app = buildGateApp(prisma, mkGateUser("family", "member-1"));
    const beforeRes = await request(app).get("/api/files/search/content?q=alpha&mode=keyword");
    expect(beforeRes.status).toBe(200);
    const beforeParams = searchByLexicalMock.mock.calls.at(-1)![1] as {
      additionalUserIds: string[];
    };
    expect(beforeParams.additionalUserIds).toEqual([`__dept_${dept.id}__`]);

    // ACT: remove the membership through the real service function — the
    // same one routes/departments.ts's DELETE /members/:userId calls.
    const result = await removeMembership(prisma, dept.id, "member-1");
    expect(result.kind).toBe("ok");

    // AFTER (1): aclVersion bumped in the same transaction as the removal —
    // this is what busts the search cache key even for callers who remain
    // visible into OTHER unrelated departments.
    expect(departments.get(dept.id)!.aclVersion).toBe(6);

    // AFTER (2): the removed member's corpus no longer carries the
    // department sentinel — search-cache staleness is structurally
    // impossible here because there's nothing left to key by.
    const afterRes = await request(app).get("/api/files/search/content?q=alpha&mode=keyword");
    expect(afterRes.status).toBe(200);
    const afterParams = searchByLexicalMock.mock.calls.at(-1)![1] as {
      additionalUserIds: string[];
    };
    expect(afterParams.additionalUserIds).toEqual([]);

    // AFTER (3): the metadata gate (checkSpaceAccess) now denies — the row
    // is gone entirely (NC push succeeded synchronously in this scenario).
    const after = await checkSpaceAccess(prisma, fakeReq(caller), caller, dept.id, "reader");
    expect(after).toEqual({
      allowed: false,
      status: 403,
      error: "Forbidden: not a member of this space",
    });

    // NC removal actually ran, both groups, before the row was deleted.
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "member1nc",
      dept.ncGroupRw,
    );
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "member1nc",
      dept.ncGroupRo,
    );
  });
});

// ── (b) NC-push-failure leaves membership 'removing' AND policy-denied ──
//
// department-membership.service.test.ts already proves the row stays
// `removing` (not deleted) when the immediate NC push throws — that's a
// DB-state assertion. What's NOT tested anywhere: that a `removing` row,
// while it's still sitting in Prisma waiting for the reconciler retry,
// does NOT keep granting policy access through checkSpaceAccess. Brief §4:
// "Policy access dies at commit; byte access at the NC call" — i.e. policy
// denial must NOT wait for the NC call to succeed.

describe("(b) NC-push-failure leaves membership 'removing' AND policy-denied", () => {
  it("a stuck 'removing' row denies checkSpaceAccess even though it still exists in Prisma", async () => {
    const { prisma, departments, membershipsById, users } = buildWorld();
    const dept = seedDept(departments, { id: "dept-eng" });
    seedUser(users, "u1", "u1nc");
    seedMembership(membershipsById, {
      id: "mem-1",
      departmentId: dept.id,
      userId: "u1",
      right: "manager",
      syncState: "synced",
    });
    // Second manager so the last-manager invariant doesn't short-circuit
    // this removal before it reaches the NC push.
    seedUser(users, "u2", "u2nc");
    seedMembership(membershipsById, {
      id: "mem-2",
      departmentId: dept.id,
      userId: "u2",
      right: "manager",
      syncState: "synced",
    });

    ncRemoveUserFromGroupMock.mockRejectedValueOnce(new Error("nc unreachable"));

    const caller: SpaceAccessCaller = { id: "u1", role: "family" };
    const beforeRemoval = await checkSpaceAccess(prisma, fakeReq(caller), caller, dept.id, "reader");
    expect(beforeRemoval.allowed).toBe(true);

    const result = await removeMembership(prisma, dept.id, "u1");
    expect(result.kind).toBe("ok");

    // The row is NOT deleted — it's stuck 'removing' for the reconciler.
    const row = membershipsById.get("mem-1");
    expect(row).toBeDefined();
    expect(row!.syncState).toBe("removing");
    expect(row!.syncError).toMatch(/nc unreachable/);

    // But checkSpaceAccess must ALREADY deny it — this is the fix under
    // test (middleware/space.ts): a 'removing' membership no longer counts
    // as a valid membership for policy purposes, independent of whether
    // the NC-side byte layer has converged yet.
    const afterRemoval = await checkSpaceAccess(prisma, fakeReq(caller), caller, dept.id, "reader");
    expect(afterRemoval).toEqual({
      allowed: false,
      status: 403,
      error: "Forbidden: not a member of this space",
    });
  });

  it("an owner's 'removing' membership no longer suppresses the audited admin-space-entry row", async () => {
    const { prisma, departments, membershipsById, users } = buildWorld();
    const dept = seedDept(departments, { id: "dept-ops" });
    seedUser(users, "owner-1", "owner1nc");
    seedMembership(membershipsById, {
      id: "mem-owner",
      departmentId: dept.id,
      userId: "owner-1",
      right: "manager",
      syncState: "removing",
    });

    const caller: SpaceAccessCaller = { id: "owner-1", role: "owner" };
    const result = await checkSpaceAccess(prisma, fakeReq(caller), caller, dept.id, "reader");

    // Owner short-circuit still passes (owners always can) …
    expect(result).toEqual({ allowed: true, departmentId: dept.id });
    // … but since the membership is mid-revocation, this now counts as a
    // non-member admin entry and gets the loud audit row, not the silent
    // "you're a real member" path.
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: "Admin space entry (non-member)" }),
    );
  });
});

// ── (e) Double-create idempotency ───────────────────────────────────────
//
// department-provisioner.service.test.ts's "dedupe by mount point" spec
// pre-seeds an existing folder and provisions ONCE. What's not covered:
// calling provisionDepartment TWICE back-to-back against the SAME row (the
// double-click-submit / duplicate-reconciler-kick race) — the second call
// must discover the folder the first call just created and NOT mint a
// second one.

describe("(e) double-create idempotency", () => {
  it("provisioning the same department twice creates exactly one groupfolder", async () => {
    const { prisma, departments } = buildWorld();
    seedDept(departments, { id: "dept-idem", state: "pending", ncGroupRw: null, ncGroupRo: null });

    // 1st call: no existing folder — gfCreateFolder mints one. From then on
    // gfListFolders must reflect the folder that now exists, exactly like a
    // real NC server would report it on the next GET.
    await provisionDepartment(prisma, "dept-idem");
    expect(gfCreateFolderMock).toHaveBeenCalledTimes(1);
    expect(departments.get("dept-idem")!.state).toBe("active");
    const mountPoint = "dept-idem"; // seedDept's default name === id
    gfListFoldersMock.mockResolvedValue([
      { id: 101, mountPoint, groups: {}, quota: -3, size: 0, acl: true },
    ]);

    // 2nd call (double-click / duplicate reconciler kick racing the first):
    // findExistingFolderId now finds the folder by mount point and MUST
    // skip gfCreateFolder entirely.
    await provisionDepartment(prisma, "dept-idem");

    expect(gfCreateFolderMock).toHaveBeenCalledTimes(1);
    expect(departments.get("dept-idem")!.ncGroupfolderId).toBe(101);
    expect(departments.get("dept-idem")!.state).toBe("active");
  });
});
