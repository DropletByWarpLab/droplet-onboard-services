/**
 * WARP-1257 (T5) — department-reconciler.service unit tests.
 *
 * Mocks the NC client modules + activity.singleton, and a minimal
 * in-memory Prisma stub covering Department / DepartmentMembership /
 * User, mirroring the guest-expiry-sweep.test.ts pattern.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  ncEnsureGroupMock,
  gfListFoldersMock,
  gfCreateFolderMock,
  gfDeleteFolderMock,
  gfAddGroupMock,
  gfRemoveGroupMock,
  gfSetGroupPermissionsMock,
  gfSetQuotaMock,
  ncAddUserToGroupMock,
  ncRemoveUserFromGroupMock,
  recordActivityMock,
} = vi.hoisted(() => ({
  ncEnsureGroupMock: vi.fn().mockResolvedValue(undefined),
  gfListFoldersMock: vi.fn().mockResolvedValue([]),
  gfCreateFolderMock: vi.fn().mockResolvedValue(42),
  gfDeleteFolderMock: vi.fn().mockResolvedValue(undefined),
  gfAddGroupMock: vi.fn().mockResolvedValue(undefined),
  gfRemoveGroupMock: vi.fn().mockResolvedValue(undefined),
  gfSetGroupPermissionsMock: vi.fn().mockResolvedValue(undefined),
  gfSetQuotaMock: vi.fn().mockResolvedValue(undefined),
  ncAddUserToGroupMock: vi.fn().mockResolvedValue(undefined),
  ncRemoveUserFromGroupMock: vi.fn().mockResolvedValue(undefined),
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncEnsureGroup: ncEnsureGroupMock,
}));

vi.mock("../services/nextcloud-groups.client.js", () => ({
  gfListFolders: gfListFoldersMock,
  gfCreateFolder: gfCreateFolderMock,
  gfDeleteFolder: gfDeleteFolderMock,
  gfAddGroup: gfAddGroupMock,
  gfRemoveGroup: gfRemoveGroupMock,
  gfSetGroupPermissions: gfSetGroupPermissionsMock,
  gfSetQuota: gfSetQuotaMock,
  ncAddUserToGroup: ncAddUserToGroupMock,
  ncRemoveUserFromGroup: ncRemoveUserFromGroupMock,
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  reconcileDepartments,
  _resetReconcileKickForTests,
} from "../services/department-reconciler.service.js";
import { DROPLET_ADMINS_GROUP, MASK_ADMIN } from "../services/department-provisioner.service.js";

interface FakeDepartment {
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
  archivedAt: Date | null;
}

interface FakeMembership {
  id: string;
  departmentId: string;
  userId: string;
  right: "reader" | "contributor" | "manager";
  syncState: string;
  syncError: string | null;
  ncPermissionMask: number | null;
}

interface FakeUser {
  id: string;
  nextcloudUsername: string | null;
}

function dept(overrides: Partial<FakeDepartment>): FakeDepartment {
  return {
    id: "dept-1",
    name: "Engineering",
    slug: "engineering",
    parentId: null,
    kind: "DEPARTMENT",
    state: "pending",
    provisionError: null,
    ncGroupRw: null,
    ncGroupRo: null,
    ncGroupfolderId: null,
    quotaBytes: null,
    archivedAt: null,
    ...overrides,
  };
}

function membership(overrides: Partial<FakeMembership>): FakeMembership {
  return {
    id: "mem-1",
    departmentId: "dept-1",
    userId: "user-1",
    right: "contributor",
    syncState: "pending",
    syncError: null,
    ncPermissionMask: null,
    ...overrides,
  };
}

function buildPrisma(
  departments: FakeDepartment[],
  memberships: FakeMembership[] = [],
  users: FakeUser[] = [],
) {
  const deptRows = new Map<string, FakeDepartment>(departments.map((d) => [d.id, d]));
  const memRows = new Map<string, FakeMembership>(memberships.map((m) => [m.id, m]));
  const userRows = new Map<string, FakeUser>(users.map((u) => [u.id, u]));

  return {
    deptRows,
    memRows,
    userRows,
    department: {
      findUnique: vi.fn(
        async ({
          where: { id },
          select,
        }: {
          where: { id: string };
          select?: Record<string, boolean>;
        }) => {
          const row = deptRows.get(id);
          if (!row) return null;
          if (!select) return { ...row };
          const projected: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            projected[key] = (row as any)[key];
          }
          return projected;
        },
      ),
      findMany: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { state: { in: string[] } | string };
          select?: Record<string, boolean>;
        }) => {
          const wantedStates =
            typeof where.state === "string" ? [where.state] : where.state.in;
          const matches = [...deptRows.values()].filter((d) =>
            wantedStates.includes(d.state),
          );
          if (!select) return matches.map((d) => ({ ...d }));
          return matches.map((d) => {
            const projected: Record<string, unknown> = {};
            for (const key of Object.keys(select)) {
              projected[key] = (d as any)[key];
            }
            return projected;
          });
        },
      ),
      update: vi.fn(
        async ({
          where: { id },
          data,
        }: {
          where: { id: string };
          data: Partial<FakeDepartment>;
        }) => {
          const row = deptRows.get(id);
          if (!row) throw new Error(`no such department ${id}`);
          Object.assign(row, data);
          return { ...row };
        },
      ),
    },
    departmentMembership: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { syncState: { in: string[] } };
        }) => {
          return [...memRows.values()]
            .filter((m) => where.syncState.in.includes(m.syncState))
            .map((m) => ({ ...m }));
        },
      ),
      update: vi.fn(
        async ({
          where: { id },
          data,
        }: {
          where: { id: string };
          data: Partial<FakeMembership>;
        }) => {
          const row = memRows.get(id);
          if (!row) throw new Error(`no such membership ${id}`);
          Object.assign(row, data);
          return { ...row };
        },
      ),
      delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const row = memRows.get(id);
        memRows.delete(id);
        return row;
      }),
    },
    user: {
      findUnique: vi.fn(
        async ({
          where: { id },
        }: {
          where: { id: string };
        }) => {
          const row = userRows.get(id);
          return row ? { ...row } : null;
        },
      ),
    },
    // WARP-1271 (T19a): reconcileDepartments() also sweeps UserUsagePolicy
    // rows (usage-policy-reconciler.service.ts) on the same tick. No fixture
    // in this suite seeds any policy rows, so an empty list is the correct
    // default — the sweep is a no-op that doesn't disturb the department/
    // membership assertions below.
    userUsagePolicy: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetReconcileKickForTests();
  ncEnsureGroupMock.mockResolvedValue(undefined);
  gfListFoldersMock.mockResolvedValue([]);
  gfCreateFolderMock.mockResolvedValue(42);
  gfDeleteFolderMock.mockResolvedValue(undefined);
  gfAddGroupMock.mockResolvedValue(undefined);
  gfRemoveGroupMock.mockResolvedValue(undefined);
  gfSetGroupPermissionsMock.mockResolvedValue(undefined);
  gfSetQuotaMock.mockResolvedValue(undefined);
  ncAddUserToGroupMock.mockResolvedValue(undefined);
  ncRemoveUserFromGroupMock.mockResolvedValue(undefined);
});

describe("reconcileDepartments — membership convergence", () => {
  it("converges a failed membership back to synced against an active department", async () => {
    const d = dept({
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 42,
    });
    const m = membership({ syncState: "failed", syncError: "boom", right: "reader" });
    const u: FakeUser = { id: "user-1", nextcloudUsername: "alice" };
    const prisma = buildPrisma([d], [m], [u]);

    const result = await reconcileDepartments(prisma as any);

    expect(ncAddUserToGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "alice",
      "dept-engineering-ro",
    );
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "alice",
      "dept-engineering",
    );

    const row = prisma.memRows.get(m.id)!;
    expect(row.syncState).toBe("synced");
    expect(row.syncError).toBeNull();
    expect(result.membershipsSynced).toBe(1);
  });

  it("removes a membership from both groups then deletes the row when syncState=removing", async () => {
    const d = dept({
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 42,
    });
    const m = membership({ syncState: "removing", right: "manager" });
    const u: FakeUser = { id: "user-1", nextcloudUsername: "alice" };
    const prisma = buildPrisma([d], [m], [u]);

    const result = await reconcileDepartments(prisma as any);

    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "alice",
      "dept-engineering",
    );
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "alice",
      "dept-engineering-ro",
    );
    expect(prisma.memRows.has(m.id)).toBe(false);
    expect(result.membershipsRemoved).toBe(1);
  });

  it("skips HOUSEHOLD memberships entirely (D-5 deferred to post-GA)", async () => {
    const d = dept({ kind: "HOUSEHOLD", state: "active", ncGroupfolderId: 1 });
    const m = membership({ syncState: "pending" });
    const u: FakeUser = { id: "user-1", nextcloudUsername: "alice" };
    const prisma = buildPrisma([d], [m], [u]);

    await reconcileDepartments(prisma as any);

    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
    // Row untouched.
    expect(prisma.memRows.get(m.id)!.syncState).toBe("pending");
  });
});

describe("reconcileDepartments — never-delete-outside-archiving", () => {
  it("never calls gfDeleteFolder for a pending/failed/active department", async () => {
    const pending = dept({ id: "d-pending", state: "pending" });
    const active = dept({
      id: "d-active",
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 7,
    });
    gfListFoldersMock.mockResolvedValue([
      { id: 7, mountPoint: "Engineering", groups: {}, quota: -3, size: 0, acl: false, manage: [] },
    ]);
    const prisma = buildPrisma([pending, active]);

    await reconcileDepartments(prisma as any);

    expect(gfDeleteFolderMock).not.toHaveBeenCalled();
  });

  it("calls gfDeleteFolder exactly for a row in archiving state", async () => {
    const archiving = dept({
      id: "d-archiving",
      state: "archiving",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 7,
    });
    const prisma = buildPrisma([archiving]);

    await reconcileDepartments(prisma as any);

    expect(gfDeleteFolderMock).toHaveBeenCalledTimes(1);
    expect(gfDeleteFolderMock).toHaveBeenCalledWith(expect.any(String), 7);
    expect(prisma.deptRows.get("d-archiving")!.state).toBe("archived");
  });
});

describe("reconcileDepartments — droplet-admins invariant", () => {
  it("re-attaches droplet-admins at MASK_ADMIN on every active DEPARTMENT/TEAM folder", async () => {
    const active = dept({
      id: "d-active",
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 7,
    });
    gfListFoldersMock.mockResolvedValue([
      { id: 7, mountPoint: "Engineering", groups: {}, quota: -3, size: 0, acl: false, manage: [] },
    ]);
    const prisma = buildPrisma([active]);

    await reconcileDepartments(prisma as any);

    expect(gfAddGroupMock).toHaveBeenCalledWith(expect.any(String), 7, DROPLET_ADMINS_GROUP);
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      7,
      DROPLET_ADMINS_GROUP,
      MASK_ADMIN,
    );
  });

  it("re-attaches droplet-admins on an active HOUSEHOLD folder when a folder id is known", async () => {
    const household = dept({
      id: "d-household",
      kind: "HOUSEHOLD",
      state: "active",
      ncGroupfolderId: 3,
    });
    const prisma = buildPrisma([household]);

    await reconcileDepartments(prisma as any);

    expect(gfAddGroupMock).toHaveBeenCalledWith(expect.any(String), 3, DROPLET_ADMINS_GROUP);
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      3,
      DROPLET_ADMINS_GROUP,
      MASK_ADMIN,
    );
  });

  it("is a clean no-op for an active HOUSEHOLD row with no folder id yet", async () => {
    const household = dept({
      id: "d-household",
      kind: "HOUSEHOLD",
      state: "active",
      ncGroupfolderId: null,
    });
    const prisma = buildPrisma([household]);

    await expect(reconcileDepartments(prisma as any)).resolves.toBeDefined();
    expect(gfAddGroupMock).not.toHaveBeenCalled();
  });
});

describe("reconcileDepartments — flat team mount name", () => {
  it("re-discovers a TEAM's groupfolder id by its FLAT 'Parent — Team' mount point", async () => {
    const parent = dept({
      id: "d-parent",
      name: "Engineering",
      slug: "engineering",
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 1,
    });
    const team = dept({
      id: "d-team",
      name: "Platform",
      slug: "platform",
      parentId: "d-parent",
      kind: "TEAM",
      state: "pending",
    });
    gfListFoldersMock.mockResolvedValue([
      {
        id: 1,
        mountPoint: "Engineering",
        groups: {},
        quota: -3,
        size: 0,
        acl: false,
        manage: [],
      },
      {
        id: 55,
        mountPoint: "Engineering — Platform",
        groups: {},
        quota: -3,
        size: 0,
        acl: false,
        manage: [],
      },
    ]);
    const prisma = buildPrisma([parent, team]);

    await reconcileDepartments(prisma as any);

    expect(gfCreateFolderMock).not.toHaveBeenCalled();
    const row = prisma.deptRows.get("d-team")!;
    expect(row.state).toBe("active");
    expect(row.ncGroupfolderId).toBe(55);
    expect(row.ncGroupRw).toBe("dept-engineering-platform");
  });
});

describe("reconcileDepartments — stuck-failed alert", () => {
  it("emits an alert ActivityRow when a row entering the sweep already failed is still failed after retry", async () => {
    gfCreateFolderMock.mockRejectedValue(new Error("nc unreachable"));
    const d = dept({ state: "failed", provisionError: "previous failure" });
    const prisma = buildPrisma([d]);

    await reconcileDepartments(prisma as any);

    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: "Department stuck in failed state", severity: "err" }),
    );
  });
});

// WARP-1257 CR (blocking): the reconciler must preserve the ORIGINAL intent
// of a row whose NC-side operation failed partway. A transient NC error mid-
// archive must NOT get retried down the provision path (which silently un-
// archives the department and restores group access). The explicit-state,
// never-guess rule (CLAUDE.md) is honoured with a distinct `archive_failed`
// ProvisionState — the retry routes on that, never on an overloaded `failed`.
describe("reconcileDepartments — intent-preserving archive retry (WARP-1257 CR)", () => {
  it("retries a partially-failed archive down the archive path, never re-provisioning it", async () => {
    // An operator archived this department; the reconciler picked it up in
    // `archiving` state with its NC groups + folder still populated.
    const d = dept({
      state: "archiving",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 42,
    });
    const prisma = buildPrisma([d]);

    // Tick 1: the folder delete hits a transient NC error partway through the
    // archive (groups already removed, folder delete 5xx).
    gfDeleteFolderMock.mockRejectedValueOnce(new Error("nc groupfolders 503"));
    await reconcileDepartments(prisma as any);

    // The row must retain its archive intent — it is NOT parked in the generic
    // `failed`/`active` buckets the provision path would resurrect.
    expect(prisma.deptRows.get(d.id)!.state).not.toBe("failed");
    expect(prisma.deptRows.get(d.id)!.state).not.toBe("active");

    // Tick 2: NC is healthy again.
    await reconcileDepartments(prisma as any);

    const row = prisma.deptRows.get(d.id)!;
    expect(row.state).toBe("archived"); // archive completed, not silently reversed
    expect(gfDeleteFolderMock).toHaveBeenCalledTimes(2); // archive retried, not provisioned
    // provisionDepartment is the ONLY caller of ncEnsureGroup / gfCreateFolder;
    // neither firing proves the row never went down the provision path.
    expect(ncEnsureGroupMock).not.toHaveBeenCalled();
    expect(gfCreateFolderMock).not.toHaveBeenCalled();
  });

  it("routes an archive_failed row to the archive path (not provision) on the next sweep", async () => {
    const d = dept({
      state: "archive_failed",
      provisionError: "nc groupfolders 503",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 42,
    });
    const prisma = buildPrisma([d]);

    await reconcileDepartments(prisma as any);

    expect(gfDeleteFolderMock).toHaveBeenCalledWith(expect.any(String), 42);
    expect(ncEnsureGroupMock).not.toHaveBeenCalled();
    expect(prisma.deptRows.get(d.id)!.state).toBe("archived");
  });
});

// WARP-1257 CR (blocking, security-relevant): a membership whose removal
// failed partway must be retried as a REMOVAL, never re-synced (which silently
// re-grants revoked access and reports the row `synced`). Distinct
// `remove_failed` NcSyncState carries the removal intent across the failure.
describe("reconcileDepartments — intent-preserving removal retry (WARP-1257 CR)", () => {
  const activeDept = () =>
    dept({
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 42,
    });

  // Keep the active-department convergence pass from spuriously creating a
  // duplicate folder while we exercise the membership state machine.
  const folderKnown = () =>
    gfListFoldersMock.mockResolvedValue([
      { id: 42, mountPoint: "Engineering", groups: {}, quota: -3, size: 0, acl: false, manage: [] },
    ]);

  it("retries a partially-failed membership removal as a removal, never re-syncing it", async () => {
    const d = activeDept();
    const m = membership({ syncState: "removing", right: "contributor" });
    const u: FakeUser = { id: "user-1", nextcloudUsername: "alice" };
    const prisma = buildPrisma([d], [m], [u]);
    folderKnown();

    // Tick 1: the first NC group removal hits a transient error.
    ncRemoveUserFromGroupMock.mockRejectedValueOnce(new Error("nc OCS 503"));
    await reconcileDepartments(prisma as any);

    // The row survives and retains its removal intent — NOT parked in the
    // generic `failed`/`synced` buckets the re-sync path would re-add.
    expect(prisma.memRows.has(m.id)).toBe(true);
    expect(prisma.memRows.get(m.id)!.syncState).not.toBe("failed");
    expect(prisma.memRows.get(m.id)!.syncState).not.toBe("synced");

    // Tick 2: NC healthy — removal retried to completion.
    await reconcileDepartments(prisma as any);

    expect(prisma.memRows.has(m.id)).toBe(false); // removed, not restored
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled(); // access never re-granted
  });

  it("routes a remove_failed membership to the removal path (not re-sync) on the next sweep", async () => {
    const d = activeDept();
    const m = membership({
      syncState: "remove_failed",
      right: "manager",
      syncError: "nc OCS 503",
    });
    const u: FakeUser = { id: "user-1", nextcloudUsername: "alice" };
    const prisma = buildPrisma([d], [m], [u]);
    folderKnown();

    const result = await reconcileDepartments(prisma as any);

    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "alice",
      "dept-engineering",
    );
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "alice",
      "dept-engineering-ro",
    );
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    expect(prisma.memRows.has(m.id)).toBe(false);
    expect(result.membershipsRemoved).toBe(1);
  });

  it("marks a failed removal as remove_failed (preserving intent), not the generic failed", async () => {
    const d = activeDept();
    const m = membership({ syncState: "removing", right: "contributor" });
    const u: FakeUser = { id: "user-1", nextcloudUsername: "alice" };
    const prisma = buildPrisma([d], [m], [u]);
    folderKnown();
    ncRemoveUserFromGroupMock.mockRejectedValue(new Error("nc OCS 503"));

    await reconcileDepartments(prisma as any);

    const row = prisma.memRows.get(m.id)!;
    expect(row.syncState).toBe("remove_failed");
    expect(prisma.memRows.has(m.id)).toBe(true);
  });
});
