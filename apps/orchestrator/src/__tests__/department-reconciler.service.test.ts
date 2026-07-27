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
  ncListGroupMembersMock,
  ncListGroupMembersStrictMock,
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
  // WARP-1274 (T21): drift-overwrite reads actual NC group membership.
  // Default empty — "no drift" — so every pre-existing spec in this file
  // (none of which seed NC-side members) is unaffected.
  //
  // WARP-1565: the sweeps read through the STRICT variant, so that is the
  // mock they seed. The LENIENT one is wired to fail loudly: it collapses
  // every outage to `[]`, which is indistinguishable from "no drift" — if a
  // sweep ever reaches for it again, that must be a red test and not a
  // quiet fiction.
  ncListGroupMembersStrictMock: vi.fn().mockResolvedValue([]),
  ncListGroupMembersMock: vi.fn(async () => {
    throw new Error(
      "reconciler sweeps must call ncListGroupMembersStrict — the lenient " +
        "variant reports an outage as an empty group (WARP-1565)",
    );
  }),
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
  ncListGroupMembers: ncListGroupMembersMock,
  ncListGroupMembersStrict: ncListGroupMembersStrictMock,
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  reconcileDepartments,
  _resetReconcileKickForTests,
} from "../services/department-reconciler.service.js";
import { DROPLET_ADMINS_GROUP, MASK_ADMIN } from "../services/department-provisioner.service.js";
import { createReconcilerSeam } from "./helpers/prisma-tx-harness.js";

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
  // WARP-1526: the admin-group sweep derives its expectation from the role
  // tier. Optional so every pre-existing fixture (which never cared) stays
  // untouched — a missing role is simply not admin-tier.
  role?: string;
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
      // Two call shapes share this mock:
      //   1. sweepMemberships:            where: { syncState: { in: [...] } }
      //   2. removeDriftedGroupMembers:   where: { departmentId, syncState: "synced" }
      // (WARP-1274/T21 — the drift-overwrite pass added shape 2.)
      findMany: vi.fn(
        async ({
          where,
        }: {
          where:
            | { syncState: { in: string[] } }
            | { departmentId: string; syncState: string };
        }) => {
          if (typeof where.syncState === "string") {
            const { departmentId, syncState } = where as {
              departmentId: string;
              syncState: string;
            };
            return [...memRows.values()]
              .filter((m) => m.departmentId === departmentId && m.syncState === syncState)
              .map((m) => ({ ...m }));
          }
          const { in: states } = where.syncState as { in: string[] };
          return [...memRows.values()]
            .filter((m) => states.includes(m.syncState))
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
      // One findMany, two callers on the same tick (rebase union):
      //  - WARP-1531 (T7): the usage-policy sweep's stateless role pass
      //    queries `{ accessRole: { storageQuotaBytes: { not: null } } }`.
      //    No fixture in this suite assigns AccessRoles, so an empty list
      //    is the correct answer — that pass stays a no-op here.
      //  - WARP-1526: the admin-group sweep lists operator-tier users with
      //    a Nextcloud mapping ({ role: { in }, nextcloudUsername:
      //    { not: null } }) — served by filtering the seeded rows.
      // pr-reviewer #1229 N4: discriminate POSITIVELY on each caller's
      // where-shape and throw on anything unrecognized. Falling back to []
      // for "no role filter" silently answered any future query with an
      // empty list, which is how a sweep gets tested into a no-op.
      findMany: vi.fn(
        async ({
          where,
        }: {
          where?: {
            role?: { in?: string[] };
            nextcloudUsername?: { not: null };
            accessRole?: unknown;
            directoryStatus?: string;
          };
        } = {}) => {
          // WARP-1531 (T7) role-default pass: users whose AccessRole sets a
          // storage default. No fixture here assigns AccessRoles.
          if (where?.accessRole) return [];
          // WARP-1526 N1 mirror pass: locally DEACTIVATED rows with an NC
          // mapping. No fixture here seeds deactivated users.
          if (where?.directoryStatus === "DEACTIVATED") return [];
          // WARP-1526 rail 6: operator-tier users with an NC mapping.
          if (where?.role?.in) {
            return [...userRows.values()].filter((u) => {
              const roleOk =
                u.role !== undefined && where.role!.in!.includes(u.role);
              const ncOk =
                where?.nextcloudUsername === undefined ||
                u.nextcloudUsername !== null;
              return roleOk && ncOk;
            });
          }
          throw new Error(
            `user.findMany: unrecognized where-shape ${JSON.stringify(where)} — ` +
              "teach the stub about the new caller instead of returning [].",
          );
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
  ncListGroupMembersStrictMock.mockResolvedValue([]);
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

/**
 * WARP-1526 (rail 6) — stateless tier-vs-group drift correction for the
 * box-wide `droplet-admins` NC group.
 *
 * The role-change post-effects push the group membership best-effort; a
 * Nextcloud outage used to leave user<->group drift with NO reconciler
 * sweep of its own (the people.ts comment said as much). This sweep closes
 * that: the expectation is derived from `User.role` alone (owner∪admin
 * with a Nextcloud mapping — no new columns, Prisma is truth), compared
 * against `ncListGroupMembers(droplet-admins)`, and corrected both ways.
 * The NC system admin account is never removed (it isn't in the local
 * directory but owns the provisioning credential).
 */
describe("WARP-1526 — droplet-admins tier-vs-group drift sweep", () => {
  it("re-adds a missing operator (role is truth) and reports adminGroupAdded", async () => {
    const sam: FakeUser = { id: "u-sam", nextcloudUsername: "sam", role: "admin" };
    const fam: FakeUser = { id: "u-fam", nextcloudUsername: "fam", role: "family" };
    const prisma = buildPrisma([], [], [sam, fam]);
    ncListGroupMembersStrictMock.mockResolvedValue([]); // NC lost the membership

    const result = await reconcileDepartments(prisma as any);

    expect(ncAddUserToGroupMock).toHaveBeenCalledTimes(1);
    expect(ncAddUserToGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "sam",
      DROPLET_ADMINS_GROUP,
    );
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
    expect(result.adminGroupAdded).toBe(1);
    expect(result.adminGroupRemoved).toBe(0);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system",
        what: "Restored drifted admin-group member (role tier is truth)",
      }),
    );
  });

  it("removes a drifted non-operator member but never the NC system admin", async () => {
    const owner: FakeUser = { id: "u-own", nextcloudUsername: "stefan", role: "owner" };
    const prisma = buildPrisma([], [], [owner]);
    ncListGroupMembersStrictMock.mockResolvedValue([
      { id: "stefan" }, // expected (owner)
      { id: "eve" },    // drifted — no operator row backs her
      { id: "admin" },  // NC system admin — excluded from removal
    ]);

    const result = await reconcileDepartments(prisma as any);

    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledTimes(1);
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "eve",
      DROPLET_ADMINS_GROUP,
    );
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    expect(result.adminGroupRemoved).toBe(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system",
        what: "Removed drifted admin-group member (role tier is truth)",
      }),
    );
  });

  it("a converged group is a silent no-op", async () => {
    const owner: FakeUser = { id: "u-own", nextcloudUsername: "stefan", role: "owner" };
    const sam: FakeUser = { id: "u-sam", nextcloudUsername: "sam", role: "admin" };
    const prisma = buildPrisma([], [], [owner, sam]);
    ncListGroupMembersStrictMock.mockResolvedValue([
      { id: "stefan" },
      { id: "sam" },
      { id: "admin" },
    ]);

    const result = await reconcileDepartments(prisma as any);

    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
    expect(result.adminGroupAdded).toBe(0);
    expect(result.adminGroupRemoved).toBe(0);
  });

  it("an NC failure inside the sweep is contained — the tick still completes with zero counts", async () => {
    const sam: FakeUser = { id: "u-sam", nextcloudUsername: "sam", role: "admin" };
    const prisma = buildPrisma([], [], [sam]);
    ncListGroupMembersStrictMock.mockRejectedValue(new Error("nc OCS 503"));

    const result = await reconcileDepartments(prisma as any);

    expect(result.adminGroupAdded).toBe(0);
    expect(result.adminGroupRemoved).toBe(0);
  });

  /**
   * WARP-1565 residual 3 — the defect the containment above could not
   * actually reach.
   *
   * That test proved the sweep survives a listing that THROWS. The shipped
   * `ncListGroupMembers` never threw: it collapsed every outage — OCS 500,
   * proxy hiccup, wedged PHP session store — to `[]`. So in a
   * list-broken/writes-working Nextcloud the sweep read "droplet-admins is
   * empty", concluded every operator was missing, and re-added all of them.
   * Every tick. Forever. Idempotent on the NC side, so nothing visibly
   * broke; the cost was an Activity log full of drift that never happened
   * and a sweep that never converged.
   *
   * The counts alone cannot catch it — a re-add storm reports
   * `adminGroupAdded > 0`, which reads like the sweep WORKING. What pins it
   * is that no write is attempted at all when the actual set is unknown.
   */
  it("does not re-add operators when the listing fails (an outage is not an empty group)", async () => {
    const sam: FakeUser = { id: "u-sam", nextcloudUsername: "sam", role: "admin" };
    const kim: FakeUser = { id: "u-kim", nextcloudUsername: "kim", role: "owner" };
    const prisma = buildPrisma([], [], [sam, kim]);
    ncListGroupMembersStrictMock.mockRejectedValue(new Error("nc OCS 500"));

    const result = await reconcileDepartments(prisma as any);

    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
    expect(result.adminGroupAdded).toBe(0);
    // `failed` is for per-member write failures. Skipping the tick is not a
    // member failing, so it must not be reported as one.
    expect(result.adminGroupFailed).toBe(0);
  });

  it("still converges a genuinely empty group (200 + no members ≠ outage)", async () => {
    const sam: FakeUser = { id: "u-sam", nextcloudUsername: "sam", role: "admin" };
    const prisma = buildPrisma([], [], [sam]);
    ncListGroupMembersStrictMock.mockResolvedValue([]);

    const result = await reconcileDepartments(prisma as any);

    expect(ncAddUserToGroupMock).toHaveBeenCalledWith(
      expect.anything(),
      "sam",
      "droplet-admins",
    );
    expect(result.adminGroupAdded).toBe(1);
  });
});

/**
 * WARP-1526 — pr-reviewer #1229 B4: sweep containment.
 *
 * The first cut wrapped BOTH loops in ONE try/catch. `ncAddUserToGroup`
 * throws on any non-2xx, so a single un-addable expected member (e.g. an
 * operator whose NC account was deleted by DELETE /auth/users, leaving the
 * local row with its nextcloudUsername intact) threw on every tick and the
 * REMOVE loop — the security-relevant direction, pulling a demoted
 * ex-admin OUT of droplet-admins — never ran again. Containment is now
 * per-item, removals run FIRST, and failures are counted rather than
 * silently swallowed.
 */
describe("WARP-1526 B4 — admin-group sweep containment", () => {
  it("a failing ADD cannot starve the REMOVE loop (head-of-line block)", async () => {
    const ghost: FakeUser = { id: "u-ghost", nextcloudUsername: "ghost", role: "admin" };
    const owner: FakeUser = { id: "u-own", nextcloudUsername: "stefan", role: "owner" };
    const prisma = buildPrisma([], [], [ghost, owner]);
    // NC lost `ghost` entirely (account deleted) but still carries a
    // drifted ex-admin `eve` who must be revoked.
    ncListGroupMembersStrictMock.mockResolvedValue([{ id: "stefan" }, { id: "eve" }]);
    ncAddUserToGroupMock.mockRejectedValue(new Error("OCS 404 no such user"));

    const result = await reconcileDepartments(prisma as any);

    // The revocation still happened despite the add blowing up.
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "eve",
      DROPLET_ADMINS_GROUP,
    );
    expect(result.adminGroupRemoved).toBe(1);
    expect(result.adminGroupAdded).toBe(0);
    expect(result.adminGroupFailed).toBe(1);
  });

  it("one failing member does not abort the rest of its own loop", async () => {
    const a: FakeUser = { id: "u-a", nextcloudUsername: "aaa", role: "admin" };
    const b: FakeUser = { id: "u-b", nextcloudUsername: "bbb", role: "admin" };
    const prisma = buildPrisma([], [], [a, b]);
    ncListGroupMembersStrictMock.mockResolvedValue([]);
    ncAddUserToGroupMock
      .mockRejectedValueOnce(new Error("OCS 404"))
      .mockResolvedValueOnce(undefined);

    const result = await reconcileDepartments(prisma as any);

    expect(ncAddUserToGroupMock).toHaveBeenCalledTimes(2);
    expect(result.adminGroupAdded).toBe(1);
    expect(result.adminGroupFailed).toBe(1);
  });

  it("removals run BEFORE adds so revocation is never behind a broken add", async () => {
    const sam: FakeUser = { id: "u-sam", nextcloudUsername: "sam", role: "admin" };
    const prisma = buildPrisma([], [], [sam]);
    ncListGroupMembersStrictMock.mockResolvedValue([{ id: "eve" }]);
    const order: string[] = [];
    ncRemoveUserFromGroupMock.mockImplementation(async () => {
      order.push("remove");
    });
    ncAddUserToGroupMock.mockImplementation(async () => {
      order.push("add");
    });

    await reconcileDepartments(prisma as any);

    expect(order).toEqual(["remove", "add"]);
  });

  it("a listing failure still contains to zero counts (nothing to compare against)", async () => {
    const sam: FakeUser = { id: "u-sam", nextcloudUsername: "sam", role: "admin" };
    const prisma = buildPrisma([], [], [sam]);
    ncListGroupMembersStrictMock.mockRejectedValue(new Error("nc OCS 503"));

    const result = await reconcileDepartments(prisma as any);

    expect(result.adminGroupAdded).toBe(0);
    expect(result.adminGroupRemoved).toBe(0);
    expect(result.adminGroupFailed).toBe(0);
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
  });

  it("N6 — casing is normalized on BOTH sides, so a case-differing uid is not added and removed forever", async () => {
    // Prisma says `Sam`; NC reports `sam`. Exact-match set math would
    // consider Sam missing (add) AND sam unexpected (remove) on every
    // single tick — an infinite flap. One convention, applied throughout.
    const sam: FakeUser = { id: "u-sam", nextcloudUsername: "Sam", role: "admin" };
    const prisma = buildPrisma([], [], [sam]);
    ncListGroupMembersStrictMock.mockResolvedValue([{ id: "sam" }]);

    const result = await reconcileDepartments(prisma as any);

    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
    expect(result.adminGroupAdded).toBe(0);
    expect(result.adminGroupRemoved).toBe(0);
  });
});

// ── Multi-tick convergence through the shared seam (WARP-1570) ─────
//
// Every route suite mocks `kickReconcile` to a bare `vi.fn()`, so everything
// the reconciler does AFTER the response is invisible to it: a route test can
// prove the kick was scheduled and nothing about whether the work it schedules
// ever lands. This file could always call `reconcileDepartments()` twice by
// hand, but "twice" is a guess — nothing failed if convergence actually needed
// three ticks, and nothing failed if it needed infinitely many. The seam turns
// the tick into something a suite can DRIVE: kicks are accounted for, ticks run
// on demand, and convergence is a predicate with a runaway cap.

describe("reconcileDepartments — multi-tick convergence (WARP-1570 seam)", () => {
  /** A pending department whose first provisioning attempt fails at NC. */
  function transientlyFailingProvision() {
    const d = dept({ state: "pending" });
    const m = membership({ syncState: "pending", right: "reader" });
    const u: FakeUser = { id: "user-1", nextcloudUsername: "alice" };
    const prisma = buildPrisma([d], [m], [u]);
    // Tick 1 only: the groupfolder create 5xxs, so the department cannot go
    // active and the membership is parked "department not active yet".
    gfCreateFolderMock.mockRejectedValueOnce(new Error("nc groupfolders 503"));
    return { prisma, d, m };
  }

  it("records the route's kick WITHOUT running it (routes must not block on convergence)", async () => {
    const { prisma } = transientlyFailingProvision();
    const seam = createReconcilerSeam(() => reconcileDepartments(prisma as any));

    seam.kickReconcile();
    seam.kickReconcile();

    expect(seam.kicks()).toBe(2);
    // Nothing has swept yet — the response returned before convergence, which
    // is the whole point of the debounced kick.
    expect(ncEnsureGroupMock).not.toHaveBeenCalled();
    expect(prisma.deptRows.get("dept-1")!.state).toBe("pending");
  });

  it("drainKicks() runs exactly one tick per kick", async () => {
    const { prisma } = transientlyFailingProvision();
    const seam = createReconcilerSeam(() => reconcileDepartments(prisma as any));

    seam.kickReconcile();
    seam.kickReconcile();
    const results = await seam.drainKicks();

    expect(results).toHaveLength(2);
    expect(seam.kicks()).toBe(0);
  });

  it("converges in TWO ticks — the second tick's work is the part route suites cannot see", async () => {
    const { prisma, m } = transientlyFailingProvision();
    const seam = createReconcilerSeam(() => reconcileDepartments(prisma as any));

    const [first] = await seam.runTicks(1);
    // Tick 1: department did not converge, so the membership is parked with
    // the explicit reason — never silently reported as synced.
    expect(first.membershipsSynced).toBe(0);
    expect(prisma.deptRows.get("dept-1")!.state).not.toBe("active");
    expect(prisma.memRows.get(m.id)!.syncState).toBe("failed");
    expect(prisma.memRows.get(m.id)!.syncError).toBe("department not active yet");

    const [second] = await seam.runTicks(1);
    // Tick 2: NC is healthy, the department lands active AND the membership
    // attaches on the same sweep.
    expect(prisma.deptRows.get("dept-1")!.state).toBe("active");
    expect(second.membershipsSynced).toBe(1);
    expect(prisma.memRows.get(m.id)!.syncState).toBe("synced");
    expect(prisma.memRows.get(m.id)!.syncError).toBeNull();
  });

  it("runToConvergence settles on the membership sync, well inside the cap", async () => {
    const { prisma } = transientlyFailingProvision();
    const seam = createReconcilerSeam(() => reconcileDepartments(prisma as any));

    const ticks = await seam.runToConvergence({
      settled: (r) => r.membershipsSynced > 0,
      maxTicks: 5,
    });

    expect(ticks).toHaveLength(2);
    expect(prisma.memRows.get("mem-1")!.syncState).toBe("synced");
  });

  it("a permanently failing sweep is reported as NON-convergence, not as slowness", async () => {
    // The guarantee the hand-rolled "call it twice" idiom never had. A
    // reconciler that re-pushes the same drift on every tick forever is an
    // infinite-work bug; without a cap it reads as a tick that just needs one
    // more try, and a suite asserting a fixed number of ticks says nothing.
    const d = dept({ state: "pending" });
    const prisma = buildPrisma([d]);
    gfCreateFolderMock.mockRejectedValue(new Error("nc groupfolders 503"));
    const seam = createReconcilerSeam(() => reconcileDepartments(prisma as any));

    await expect(
      seam.runToConvergence({
        settled: (r) => r.departmentsConverged > 0,
        maxTicks: 4,
      }),
    ).rejects.toThrow(/did not converge within 4 ticks/i);
    expect(prisma.deptRows.get(d.id)!.state).not.toBe("active");
  });
});
