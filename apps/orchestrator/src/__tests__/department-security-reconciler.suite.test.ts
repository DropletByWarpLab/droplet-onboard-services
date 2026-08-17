/**
 * WARP-1274 (T21) — ADR-029 security checklist automation, part 2:
 * reconciler drift-overwrite + groupfolder-id reassignment.
 *
 * department-reconciler.service.test.ts already covers the reconciler's
 * state-machine convergence, the never-delete-outside-archiving invariant,
 * the droplet-admins-everywhere invariant, and (in isolation) re-discovery
 * of a TEAM's groupfolder id by mount point. What it does NOT cover — and
 * what this file adds:
 *
 *   (c) NC group-MEMBERSHIP drift-overwrite: a user hand-added to a
 *       `dept-<slug>` group via the NC admin UI (out-of-band, unsupported
 *       per ADR-013) must be removed by the next reconcile tick, because
 *       Prisma — not Nextcloud — is truth. This is a genuinely new
 *       production code path (services/nextcloud-groups.client.ts's
 *       `ncListGroupMembersStrict` existed but was never called anywhere before
 *       this ticket).
 *   (d) A groupfolder-id reassignment (NC reinstall) must NOT perturb the
 *       search-corpus sentinel a caller's requests are keyed under — the
 *       sentinel is the immutable Department UUID, never the mutable
 *       `ncGroupfolderId` the reconciler re-discovers by mount point.
 *
 * See docs/security/ADR-029-checklist.md for the full §8 checklist → test
 * mapping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import type { AuthUser } from "../middleware/auth.js";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    MAX_UPLOAD_SIZE_MB: 100,
    NEXTCLOUD_URL: "http://nextcloud.test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const recordActivityMock = vi.fn().mockResolvedValue(null);
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

const {
  gfListFoldersMock,
  gfGetFolderMock,
  gfCreateFolderMock,
  gfDeleteFolderMock,
  gfAddGroupMock,
  gfRemoveGroupMock,
  gfSetGroupPermissionsMock,
  gfSetQuotaMock,
  ncAddUserToGroupMock,
  ncRemoveUserFromGroupMock,
  ncListGroupMembersMock,
  ncListGroupMembersStrictMock,
} = vi.hoisted(() => ({
  gfListFoldersMock: vi.fn().mockResolvedValue([]),
  // groupfolders ≥ 17 duplicate-key fix: ensureAdminsAttached reads the
  // folder before writing. Default null = attach unconditionally, the
  // pre-read behaviour every spec here was written against.
  gfGetFolderMock: vi.fn().mockResolvedValue(null),
  gfCreateFolderMock: vi.fn().mockResolvedValue(42),
  gfDeleteFolderMock: vi.fn().mockResolvedValue(undefined),
  gfAddGroupMock: vi.fn().mockResolvedValue(undefined),
  gfRemoveGroupMock: vi.fn().mockResolvedValue(undefined),
  gfSetGroupPermissionsMock: vi.fn().mockResolvedValue(undefined),
  gfSetQuotaMock: vi.fn().mockResolvedValue(undefined),
  ncAddUserToGroupMock: vi.fn().mockResolvedValue(undefined),
  ncRemoveUserFromGroupMock: vi.fn().mockResolvedValue(undefined),
  // WARP-1565: the drift-overwrite sweep reads through the STRICT variant,
  // so that is the mock these specs seed. The LENIENT one is wired to fail
  // loudly — it collapses an outage to `[]`, which is indistinguishable from
  // "no drift", so a sweep reaching for it again must be red rather than a
  // quiet fiction.
  ncListGroupMembersStrictMock: vi.fn().mockResolvedValue([]),
  ncListGroupMembersMock: vi.fn(async () => {
    throw new Error(
      "reconciler sweeps must call ncListGroupMembersStrict — the lenient " +
        "variant reports an outage as an empty group (WARP-1565)",
    );
  }),
}));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  gfListFolders: gfListFoldersMock,
  gfGetFolder: gfGetFolderMock,
  gfCreateFolder: gfCreateFolderMock,
  gfDeleteFolder: gfDeleteFolderMock,
  gfAddGroup: gfAddGroupMock,
  gfRemoveGroup: gfRemoveGroupMock,
  gfSetGroupPermissions: gfSetGroupPermissionsMock,
  gfSetQuota: gfSetQuotaMock,
  ncAddUserToGroup: ncAddUserToGroupMock,
  ncRemoveUserFromGroup: ncRemoveUserFromGroupMock,
  ncListGroupMembers: ncListGroupMembersMock,
  ncListGroupMembersStrict: ncListGroupMembersStrictMock,
  // WARP-1557: "did this write land?" classifier. Always false here — every
  // fixture in this suite either succeeds or fails unambiguously, so the
  // pinned drift-overwrite / id-reassignment invariants below behave exactly
  // as they did before that ticket. The classifier's own truth table lives in
  // nextcloud-groups.client.test.ts.
  isAmbiguousWriteFailure: vi.fn(() => false),
}));

import { reconcileDepartments, _resetReconcileKickForTests } from "../services/department-reconciler.service.js";
import { createFilesRouter } from "../routes/files.js";

// ── Composite in-memory Prisma double — backs BOTH reconcileDepartments()
//    (department-reconciler.service.ts) AND the real search/content route
//    (routes/files.ts), so item (d) can prove the search-corpus sentinel
//    survives a groupfolder-id reassignment the reconciler just performed.

interface DeptRow {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  state: string;
  provisionError: string | null;
  ncGroupRw: string | null;
  ncGroupRo: string | null;
  ncGroupfolderId: number | null;
  quotaBytes: bigint | null;
  aclVersion: number;
  archivedAt: Date | null;
}
interface MembershipRow {
  id: string;
  departmentId: string;
  userId: string;
  right: "reader" | "contributor" | "manager";
  syncState: string;
  syncError: string | null;
  ncPermissionMask: number | null;
}
interface UserRow {
  id: string;
  nextcloudUsername: string | null;
}

function dept(overrides: Partial<DeptRow> & { id: string }): DeptRow {
  return {
    name: overrides.id,
    slug: overrides.id,
    parentId: null,
    kind: "DEPARTMENT",
    state: "active",
    provisionError: null,
    ncGroupRw: null,
    ncGroupRo: null,
    ncGroupfolderId: null,
    quotaBytes: null,
    aclVersion: 0,
    archivedAt: null,
    ...overrides,
  };
}

function membership(overrides: Partial<MembershipRow> & { id: string; departmentId: string; userId: string }): MembershipRow {
  return {
    right: "contributor",
    syncState: "synced",
    syncError: null,
    ncPermissionMask: null,
    ...overrides,
  };
}

function buildWorld(departmentsSeed: DeptRow[], membershipsSeed: MembershipRow[] = [], usersSeed: UserRow[] = []) {
  const deptRows = new Map<string, DeptRow>(departmentsSeed.map((d) => [d.id, d]));
  const memRows = new Map<string, MembershipRow>(membershipsSeed.map((m) => [m.id, m]));
  const userRows = new Map<string, UserRow>(usersSeed.map((u) => [u.id, u]));

  const prisma = {
    deptRows,
    memRows,
    userRows,
    department: {
      findUnique: vi.fn(async ({ where: { id }, select }: any) => {
        const row = deptRows.get(id);
        if (!row) return null;
        if (!select) return { ...row };
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = (row as any)[k];
        return out;
      }),
      findMany: vi.fn(async ({ where, select }: any) => {
        const wantedStates = typeof where.state === "string" ? [where.state] : where.state.in;
        const matches = [...deptRows.values()].filter((d) => wantedStates.includes(d.state));
        if (!select) return matches.map((d) => ({ ...d }));
        return matches.map((d) => {
          const out: any = {};
          for (const k of Object.keys(select)) out[k] = (d as any)[k];
          return out;
        });
      }),
      update: vi.fn(async ({ where: { id }, data }: any) => {
        const row = deptRows.get(id);
        if (!row) throw new Error(`no such department ${id}`);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    departmentMembership: {
      // Three call shapes:
      //   1. sweepMemberships:            where: { syncState: { in: [...] } }
      //   2. removeDriftedGroupMembers:   where: { departmentId, syncState: "synced" }
      //   3. deptSearchCorpora (non-owner): where: { userId, department: { state } }
      findMany: vi.fn(async ({ where }: any) => {
        if (where.userId !== undefined) {
          const rows = [...memRows.values()].filter((m) => m.userId === where.userId);
          const out: Array<{ department: { id: string; kind: string; aclVersion: number } }> = [];
          for (const row of rows) {
            const d = deptRows.get(row.departmentId);
            if (!d) continue;
            if (where.department?.state && d.state !== where.department.state) continue;
            out.push({ department: { id: d.id, kind: d.kind, aclVersion: d.aclVersion } });
          }
          return out;
        }
        if (where.departmentId !== undefined && typeof where.syncState === "string") {
          return [...memRows.values()]
            .filter((m) => m.departmentId === where.departmentId && m.syncState === where.syncState)
            .map((m) => ({ ...m }));
        }
        const states = where.syncState.in as string[];
        return [...memRows.values()].filter((m) => states.includes(m.syncState)).map((m) => ({ ...m }));
      }),
      update: vi.fn(async ({ where: { id }, data }: any) => {
        const row = memRows.get(id);
        if (!row) throw new Error(`no such membership ${id}`);
        Object.assign(row, data);
        return { ...row };
      }),
      delete: vi.fn(async ({ where: { id } }: any) => {
        const row = memRows.get(id);
        memRows.delete(id);
        return row;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where: { id } }: any) => {
        const row = userRows.get(id);
        return row ? { ...row } : null;
      }),
      // pr-reviewer #1229 N4: positive discrimination — every same-tick
      // caller is named, and an unknown where-shape throws rather than
      // quietly answering []. No fixture in this suite assigns AccessRoles,
      // seeds operator-tier users, or deactivates anyone, so all three
      // sweeps are legitimately no-ops here.
      findMany: vi.fn(async ({ where }: any = {}) => {
        if (where?.accessRole) return [];
        if (where?.directoryStatus === "DEACTIVATED") return [];
        if (where?.role?.in) return [];
        throw new Error(
          `user.findMany: unrecognized where-shape ${JSON.stringify(where)}`,
        );
      }),
    },
    userUsagePolicy: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };

  return prisma;
}

function mkGateUser(role: AuthUser["role"], id: string): AuthUser {
  return { id, username: `${id}-nc`, displayName: id, role };
}

function buildGateApp(prisma: unknown, user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createFilesRouter(prisma as PrismaClient));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetReconcileKickForTests();
  gfListFoldersMock.mockResolvedValue([]);
  gfCreateFolderMock.mockResolvedValue(42);
  gfDeleteFolderMock.mockResolvedValue(undefined);
  gfAddGroupMock.mockResolvedValue(undefined);
  gfRemoveGroupMock.mockResolvedValue(undefined);
  gfSetGroupPermissionsMock.mockResolvedValue(undefined);
  gfSetQuotaMock.mockResolvedValue(undefined);
  ncAddUserToGroupMock.mockResolvedValue(undefined);
  ncRemoveUserFromGroupMock.mockResolvedValue(undefined);
  ncListGroupMembersStrictMock.mockResolvedValue([]);
  searchByLexicalMock.mockResolvedValue([]);
});

// ── (c) reconciler drift-overwrite ──────────────────────────────────────

describe("(c) reconciler drift-overwrite — NC group membership", () => {
  it("removes an NC-side member Prisma doesn't know about, leaves the expected member alone", async () => {
    const d = dept({
      id: "dept-1",
      name: "Engineering",
      slug: "engineering",
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 7,
    });
    // reconcileActiveDepartment re-runs provisionDepartment (idempotent
    // convergence) on every active row every tick — seed gfListFolders so
    // it finds the existing folder by mount point instead of minting a
    // duplicate, keeping the group names/folder id exactly as seeded.
    gfListFoldersMock.mockResolvedValue([
      { id: 7, mountPoint: "Engineering", groups: {}, quota: -3, size: 0, acl: false, manage: [] },
    ]);
    const m = membership({ id: "mem-1", departmentId: "dept-1", userId: "user-1", right: "contributor", syncState: "synced" });
    const prisma = buildWorld([d], [m], [{ id: "user-1", nextcloudUsername: "alice" }]);

    // NC reports TWO members in the rw group: alice (expected, Prisma
    // knows her) and mallory (hand-added out of band — drift).
    ncListGroupMembersStrictMock.mockImplementation(async (_token: string, groupId: string) => {
      if (groupId === "dept-engineering") {
        return [
          { id: "alice", displayName: "alice" },
          { id: "mallory", displayName: "mallory" },
        ];
      }
      return [];
    });

    await reconcileDepartments(prisma as any);

    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(expect.any(String), "mallory", "dept-engineering");
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalledWith(expect.any(String), "alice", "dept-engineering");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "Removed drifted NC group member (Prisma is truth)",
        refs: expect.objectContaining({ ncUsername: "mallory", group: "dept-engineering" }),
      }),
    );
  });

  it("a synced reader is NOT removed from the ro group by drift-check", async () => {
    const d = dept({
      id: "dept-1",
      name: "Engineering",
      slug: "engineering",
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 7,
    });
    // reconcileActiveDepartment re-runs provisionDepartment (idempotent
    // convergence) on every active row every tick — seed gfListFolders so
    // it finds the existing folder by mount point instead of minting a
    // duplicate, keeping the group names/folder id exactly as seeded.
    gfListFoldersMock.mockResolvedValue([
      { id: 7, mountPoint: "Engineering", groups: {}, quota: -3, size: 0, acl: false, manage: [] },
    ]);
    const m = membership({ id: "mem-1", departmentId: "dept-1", userId: "user-1", right: "reader", syncState: "synced" });
    const prisma = buildWorld([d], [m], [{ id: "user-1", nextcloudUsername: "alice" }]);

    ncListGroupMembersStrictMock.mockImplementation(async (_token: string, groupId: string) =>
      groupId === "dept-engineering-ro" ? [{ id: "alice", displayName: "alice" }] : [],
    );

    await reconcileDepartments(prisma as any);

    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalledWith(
      expect.any(String),
      "alice",
      "dept-engineering-ro",
    );
  });

  it("a pending (not-yet-synced) member does not count as expected — a straggler in NC still gets removed, and the very next tick re-adds it once it syncs", async () => {
    const d = dept({
      id: "dept-1",
      name: "Engineering",
      slug: "engineering",
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 7,
    });
    // reconcileActiveDepartment re-runs provisionDepartment (idempotent
    // convergence) on every active row every tick — seed gfListFolders so
    // it finds the existing folder by mount point instead of minting a
    // duplicate, keeping the group names/folder id exactly as seeded.
    gfListFoldersMock.mockResolvedValue([
      { id: 7, mountPoint: "Engineering", groups: {}, quota: -3, size: 0, acl: false, manage: [] },
    ]);
    const m = membership({ id: "mem-1", departmentId: "dept-1", userId: "user-1", right: "contributor", syncState: "pending" });
    const prisma = buildWorld([d], [m], [{ id: "user-1", nextcloudUsername: "alice" }]);

    // Simulate: the immediate inline push in department-membership.service
    // already landed the NC-side add (so alice IS actually in the group),
    // but this tick's read of `synced` rows doesn't know that yet.
    ncListGroupMembersStrictMock.mockImplementation(async (_token: string, groupId: string) =>
      groupId === "dept-engineering" ? [{ id: "alice", displayName: "alice" }] : [],
    );

    await reconcileDepartments(prisma as any);

    // Drift-check bounced her out this tick (not yet "expected") …
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(expect.any(String), "alice", "dept-engineering");
    // … but sweepMemberships (same tick, `pending` sweep) already converged
    // her row to `synced` — the very next tick's drift-check will see her
    // as expected and leave her alone. Never a security hole, at most a
    // one-tick bounce for a straggling add.
    expect(prisma.memRows.get("mem-1")!.syncState).toBe("synced");
  });

  it("never calls ncListGroupMembersStrict for a HOUSEHOLD department's groups (D-5 deferred)", async () => {
    const d = dept({ id: "hh-1", kind: "HOUSEHOLD", state: "active", ncGroupfolderId: 1 });
    const prisma = buildWorld([d]);

    await reconcileDepartments(prisma as any);

    // WARP-1526 note: the tick now ALWAYS reads the box-wide
    // `droplet-admins` group once (the tier-vs-group drift sweep) — that
    // call is unrelated to household rights convergence, so the D-5 pin
    // narrows to "no HOUSEHOLD/department group is ever read": the only
    // membership read on this tick is the admin-group one.
    for (const call of ncListGroupMembersStrictMock.mock.calls) {
      expect(call[1]).toBe("droplet-admins");
    }
  });
});

// ── (d) groupfolder-id reassignment leaves the search-corpus sentinel
//        untouched, and the reconciler re-discovers without duplicating ──

describe("(d) groupfolder-id reassignment simulation", () => {
  it("re-discovers the folder by mount point (no duplicate) while the search-corpus sentinel stays keyed on the Department UUID, not the folder id", async () => {
    const DEPT_ID = "22222222-2222-4222-8222-222222222222";
    const d = dept({
      id: DEPT_ID,
      name: "Finance",
      slug: "finance",
      state: "active",
      ncGroupRw: "dept-finance",
      ncGroupRo: "dept-finance-ro",
      ncGroupfolderId: 7, // the OLD, pre-reinstall id
      aclVersion: 2,
    });
    const m = membership({ id: "mem-1", departmentId: DEPT_ID, userId: "member-1", right: "contributor" });
    const prisma = buildWorld([d], [m], [{ id: "member-1", nextcloudUsername: "member1nc" }]);

    // BEFORE the reinstall: search corpus for member-1 carries the
    // UUID-keyed sentinel.
    const app = buildGateApp(prisma, mkGateUser("family", "member-1"));
    const beforeRes = await request(app).get("/api/files/search/content?q=q1&mode=keyword");
    expect(beforeRes.status).toBe(200);
    const beforeParams = searchByLexicalMock.mock.calls.at(-1)![1] as { additionalUserIds: string[] };
    expect(beforeParams.additionalUserIds).toEqual([`__dept_${DEPT_ID}__`]);

    // Simulate an NC reinstall: the OLD groupfolder id (7) is gone; the
    // SAME mount point ("Finance") now lives under a NEW id (55) — exactly
    // brief §3.6's "NC reinstall reassigns groupfolder ids" bypass-path row.
    // reconcileDepartments only calls gfListFolders for id discovery, never
    // trusts the cached `ncGroupfolderId` as truth.
    gfListFoldersMock.mockResolvedValue([
      { id: 55, mountPoint: "Finance", groups: {}, quota: -3, size: 0, acl: false, manage: [] },
    ]);

    await reconcileDepartments(prisma as any);

    // Re-discovered by mount point — no duplicate folder minted.
    expect(gfCreateFolderMock).not.toHaveBeenCalled();
    expect(prisma.deptRows.get(DEPT_ID)!.ncGroupfolderId).toBe(55);
    // The row's own identity (id) — the ONLY thing the search sentinel is
    // ever keyed on — never changed.
    expect(prisma.deptRows.get(DEPT_ID)!.id).toBe(DEPT_ID);

    // AFTER the reinstall + reconcile: the sentinel is byte-for-byte
    // identical — a stale `ncGroupfolderId` never leaked into it, and
    // there is no crossover with whatever content was previously indexed
    // under the old id 7.
    const afterRes = await request(app).get("/api/files/search/content?q=q1&mode=keyword");
    expect(afterRes.status).toBe(200);
    const afterParams = searchByLexicalMock.mock.calls.at(-1)![1] as { additionalUserIds: string[] };
    expect(afterParams.additionalUserIds).toEqual([`__dept_${DEPT_ID}__`]);
    expect(afterParams.additionalUserIds).toEqual(beforeParams.additionalUserIds);
  });
});
