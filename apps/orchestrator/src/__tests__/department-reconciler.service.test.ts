/**
 * WARP-1257 (T5) — department-reconciler.service unit tests.
 *
 * Mocks the NC client modules + activity.singleton, and a minimal
 * in-memory Prisma stub covering Department / DepartmentMembership /
 * User, mirroring the guest-expiry-sweep.test.ts pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  ncEnsureGroupMock,
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
  isAmbiguousWriteFailureMock,
  recordActivityMock,
} = vi.hoisted(() => ({
  ncEnsureGroupMock: vi.fn().mockResolvedValue(undefined),
  gfListFoldersMock: vi.fn().mockResolvedValue([]),
  // groupfolders ≥ 17 duplicate-key fix: ensureAdminsAttached reads the
  // folder before writing. Default null ("folder not visible") = the
  // pre-read behaviour every earlier spec assumed — attach unconditionally.
  gfGetFolderMock: vi.fn().mockResolvedValue(null),
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
  // WARP-1557: "did this write land?" classifier. Default false = every
  // failure is an unambiguous rejection, i.e. exactly the pre-WARP-1557
  // behaviour every spec written before this ticket assumes. Its own truth
  // table is pinned in nextcloud-groups.client.test.ts.
  isAmbiguousWriteFailureMock: vi.fn().mockReturnValue(false),
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncEnsureGroup: ncEnsureGroupMock,
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
  isAmbiguousWriteFailure: isAmbiguousWriteFailureMock,
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  reconcileDepartments,
  _resetReconcileKickForTests,
} from "../services/department-reconciler.service.js";
import {
  DROPLET_ADMINS_GROUP,
  MASK_ADMIN,
  MASK_RW,
  MASK_RO,
} from "../services/department-provisioner.service.js";
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
  /** WARP-1651 — the durable escalation clock; null while converging. */
  nonConvergedSince: Date | null;
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
    nonConvergedSince: null,
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
  gfGetFolderMock.mockResolvedValue(null);
  gfCreateFolderMock.mockResolvedValue(42);
  gfDeleteFolderMock.mockResolvedValue(undefined);
  gfAddGroupMock.mockResolvedValue(undefined);
  gfRemoveGroupMock.mockResolvedValue(undefined);
  gfSetGroupPermissionsMock.mockResolvedValue(undefined);
  gfSetQuotaMock.mockResolvedValue(undefined);
  ncAddUserToGroupMock.mockResolvedValue(undefined);
  ncRemoveUserFromGroupMock.mockResolvedValue(undefined);
  ncListGroupMembersStrictMock.mockResolvedValue([]);
  isAmbiguousWriteFailureMock.mockReturnValue(false);
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
    // WARP-1557: `archiving` is a RE-VERIFY state (a prior attempt may have
    // landed), so the archive retry carries confirmOnFailure.
    expect(gfDeleteFolderMock).toHaveBeenCalledWith(
      expect.any(String),
      7,
      expect.objectContaining({ confirmOnFailure: true }),
    );
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

    // The seeded folder (groups: {}) does NOT match intent, so the drift
    // pass falls through to the full overwrite path. Since groupfolders ≥ 17
    // turned redundant re-adds into duplicate-key 500s, the steady-state
    // pass runs with `verifyOnFailure` — its writes carry
    // `confirmOnFailure: true` so a 500 fired after an effective write
    // resolves via its postcondition.
    expect(gfAddGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      7,
      DROPLET_ADMINS_GROUP,
      expect.objectContaining({ confirmOnFailure: true }),
    );
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      7,
      DROPLET_ADMINS_GROUP,
      MASK_ADMIN,
      expect.objectContaining({ confirmOnFailure: true }),
    );
  });

  it("REGRESSION (groupfolders ≥ 17): an active DEPARTMENT already matching intent issues ZERO groupfolder writes — and stays quiet", async () => {
    // On droplet-sys the re-add of an attached group 500s (duplicate key), so
    // the pre-fix unconditional overwrite failed every tick and knocked the
    // converged row into `provisioning`. Prove no write is even attempted.
    gfAddGroupMock.mockRejectedValue(new Error("Groupfolder add group: 500"));
    const active = dept({
      id: "d-active",
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 7,
    });
    gfListFoldersMock.mockResolvedValue([
      {
        id: 7,
        mountPoint: "Engineering",
        groups: {
          "dept-engineering": MASK_RW,
          "dept-engineering-ro": MASK_RO,
          [DROPLET_ADMINS_GROUP]: MASK_ADMIN,
        },
        quota: -3,
        size: 0,
        acl: false,
        manage: [],
      },
    ]);
    const prisma = buildPrisma([active]);

    const result = await reconcileDepartments(prisma as any);

    expect(gfAddGroupMock).not.toHaveBeenCalled();
    expect(gfSetGroupPermissionsMock).not.toHaveBeenCalled();
    expect(gfCreateFolderMock).not.toHaveBeenCalled();
    expect(prisma.deptRows.get("d-active")!.state).toBe("active");
    expect(result.departmentsStillFailed).toBe(0);
    // Quiet: a healthy row re-verified on the steady-state pass must not
    // emit a "converged" ActivityRow every 5 minutes.
    expect(recordActivityMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ what: "Department converged (already provisioned)" }),
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

    // gfGetFolder default (null): the folder can't be read, so the invariant
    // is asserted the pre-read way — attach + mask, confirm-on-failure.
    expect(gfAddGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      3,
      DROPLET_ADMINS_GROUP,
      expect.objectContaining({ confirmOnFailure: true }),
    );
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      3,
      DROPLET_ADMINS_GROUP,
      MASK_ADMIN,
      expect.objectContaining({ confirmOnFailure: true }),
    );
  });

  it("REGRESSION (groupfolders ≥ 17): a HOUSEHOLD folder already carrying droplet-admins at MASK_ADMIN gets NO writes", async () => {
    // The droplet-sys spam: folder 1 converged since the first-ever tick,
    // yet every 5-minute tick re-added droplet-admins and logged the
    // duplicate-key 500 as a level-50 error. Steady state must now be a
    // single read.
    gfAddGroupMock.mockRejectedValue(new Error("Groupfolder add group: 500"));
    gfGetFolderMock.mockResolvedValue({
      id: 3,
      mountPoint: "Household",
      groups: { household: 1, [DROPLET_ADMINS_GROUP]: MASK_ADMIN },
      quota: -3,
      size: 0,
      acl: false,
      manage: [],
    });
    const household = dept({
      id: "d-household",
      kind: "HOUSEHOLD",
      state: "active",
      ncGroupfolderId: 3,
    });
    const prisma = buildPrisma([household]);

    const result = await reconcileDepartments(prisma as any);

    expect(gfGetFolderMock).toHaveBeenCalledWith(expect.any(String), 3);
    expect(gfAddGroupMock).not.toHaveBeenCalled();
    expect(gfSetGroupPermissionsMock).not.toHaveBeenCalled();
    expect(result.departmentsStillFailed).toBe(0);
  });

  it("corrects a wrong droplet-admins mask with set-permissions ONLY — no doomed re-add of an attached group", async () => {
    gfGetFolderMock.mockResolvedValue({
      id: 3,
      mountPoint: "Household",
      groups: { [DROPLET_ADMINS_GROUP]: 15 }, // attached, drifted below MASK_ADMIN
      quota: -3,
      size: 0,
      acl: false,
      manage: [],
    });
    const household = dept({
      id: "d-household",
      kind: "HOUSEHOLD",
      state: "active",
      ncGroupfolderId: 3,
    });
    const prisma = buildPrisma([household]);

    await reconcileDepartments(prisma as any);

    // Re-adding an attached group is a duplicate-key 500 on groupfolders
    // ≥ 17 — the mask fix must go straight to set-permissions.
    expect(gfAddGroupMock).not.toHaveBeenCalled();
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      3,
      DROPLET_ADMINS_GROUP,
      MASK_ADMIN,
      expect.objectContaining({ confirmOnFailure: true }),
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

// ── WARP-1557 ────────────────────────────────────────────────────────────
//
// THE regression this ticket exists for. On the .87 box, 2026-07-24:
//
//   Department      | State  | provisionError
//   Dental Hygenist | failed | Groupfolder add group: 500
//   Finance         | failed | Groupfolder add group: 500
//
// …while `occ groupfolders:list` showed BOTH folders fully provisioned with
// the correct masks and real group members, and all 7 DepartmentMembership
// rows were `synced`. The reconciler logged
// `departmentsSwept: 3, departmentsConverged: 0, departmentsStillFailed: 2`
// every five minutes, indefinitely: it could only re-issue the write that
// was failing, never observe that reality already matched intent.

describe("WARP-1557 — a 5xx on a write that SUCCEEDED upstream must not latch the row", () => {
  /** The .87 box's NC state for a department Prisma had marked `failed`. */
  function provisionedFolder() {
    return {
      id: 2,
      mountPoint: "Engineering",
      groups: {
        "dept-engineering": MASK_RW,
        "dept-engineering-ro": MASK_RO,
        [DROPLET_ADMINS_GROUP]: MASK_ADMIN,
      },
      quota: -3,
      size: 0,
      acl: false,
      manage: [],
    };
  }

  it("REGRESSION: converges the row to active on the next tick instead of retrying forever", async () => {
    // The write keeps returning 500 — exactly as it did on the box, and as it
    // would keep doing until WARP-1537 (the Redis/session bug) is fixed.
    gfAddGroupMock.mockRejectedValue(new Error("Groupfolder add group: 500"));
    gfListFoldersMock.mockResolvedValue([provisionedFolder()]);

    const d = dept({
      state: "failed",
      provisionError: "Groupfolder add group: 500",
    });
    const prisma = buildPrisma([d]);

    const result = await reconcileDepartments(prisma as any);

    const row = prisma.deptRows.get(d.id)!;
    expect(row.state).toBe("active");
    expect(row.provisionError).toBeNull();
    expect(row.ncGroupfolderId).toBe(2);

    // The tick reports progress instead of the box's eternal
    // `departmentsConverged: 0, departmentsStillFailed: 2`.
    expect(result.departmentsConverged).toBe(1);
    expect(result.departmentsStillFailed).toBe(0);
    expect(result.departmentsStuck).toBe(0);
  });

  it("a `pending` row is NOT verified — the read-back exception stays scoped to the retry path", async () => {
    gfListFoldersMock.mockResolvedValue([provisionedFolder()]);
    const d = dept({ state: "pending" });
    const prisma = buildPrisma([d]);

    await reconcileDepartments(prisma as any);

    // A never-attempted row has no prior write that could have landed, so it
    // takes the normal unconditional write path.
    expect(gfAddGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      2,
      "dept-engineering",
      expect.objectContaining({ confirmOnFailure: false }),
    );
  });

  it("an ambiguous failure is reported as re-verifying, not as a terminal failure", async () => {
    isAmbiguousWriteFailureMock.mockReturnValue(true);
    gfCreateFolderMock.mockRejectedValue(new Error("Groupfolder create: 503"));
    const d = dept({ state: "pending" });
    const prisma = buildPrisma([d]);

    const result = await reconcileDepartments(prisma as any);

    expect(prisma.deptRows.get(d.id)!.state).toBe("provisioning");
    expect(result.departmentsReverifying).toBe(1);
    expect(result.departmentsStillFailed).toBe(0);
  });
});

/**
 * WARP-1557's escalation, re-based on a DURABLE clock by WARP-1651.
 *
 * The budget is unchanged — 6 ticks × the 5-minute cron interval — but it is
 * now measured in wall-clock against `Department.nonConvergedSince` instead of
 * counted in a module-level in-memory Map. These tests therefore drive the
 * clock rather than the tick count; the restart property the change exists for
 * is pinned in the WARP-1651 block below.
 */
describe("WARP-1557 — stuck rows get a louder signal than a debug log line", () => {
  const TICK_MS = 5 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts a row as stuck only once the budget is spent, then demotes the re-verify state", async () => {
    // Ambiguous failures forever: NC is genuinely down, nothing converges.
    isAmbiguousWriteFailureMock.mockReturnValue(true);
    gfCreateFolderMock.mockRejectedValue(new Error("Groupfolder create: 503"));
    const d = dept({ state: "pending" });
    const prisma = buildPrisma([d]);

    // Ticks 1-5 (0-20 min elapsed): unconfirmed, parked in the non-terminal
    // re-verify state.
    for (let i = 0; i < 5; i += 1) {
      const r = await reconcileDepartments(prisma as any);
      expect(r.departmentsStuck).toBe(0);
      expect(prisma.deptRows.get(d.id)!.state).toBe("provisioning");
      vi.setSystemTime(new Date(Date.now() + TICK_MS));
    }

    // At 25 min the budget is still unspent — the boundary is 30, and a test
    // that passed at 25 would not be testing the threshold.
    const fifth = await reconcileDepartments(prisma as any);
    expect(fifth.departmentsStuck).toBe(0);
    expect(prisma.deptRows.get(d.id)!.state).toBe("provisioning");

    // 30 min: budget spent. The row is reported stuck AND demoted to its
    // terminal failure state rather than implying work is still in progress.
    vi.setSystemTime(new Date(Date.now() + TICK_MS));
    const sixth = await reconcileDepartments(prisma as any);
    expect(sixth.departmentsStuck).toBe(1);
    expect(prisma.deptRows.get(d.id)!.state).toBe("failed");
  });

  it("a row that converges stops its clock", async () => {
    isAmbiguousWriteFailureMock.mockReturnValue(true);
    gfCreateFolderMock.mockRejectedValue(new Error("Groupfolder create: 503"));
    const d = dept({ state: "pending" });
    const prisma = buildPrisma([d]);

    await reconcileDepartments(prisma as any);
    expect(prisma.deptRows.get(d.id)!.nonConvergedSince).not.toBeNull();
    vi.setSystemTime(new Date(Date.now() + TICK_MS));
    await reconcileDepartments(prisma as any);

    // NC recovers.
    gfCreateFolderMock.mockResolvedValue(42);
    const recovered = await reconcileDepartments(prisma as any);
    expect(prisma.deptRows.get(d.id)!.state).toBe("active");
    expect(recovered.departmentsStuck).toBe(0);
    // The clock is cleared, so the NEXT failure episode gets a full budget
    // rather than inheriting a spent one.
    expect(prisma.deptRows.get(d.id)!.nonConvergedSince).toBeNull();

    // Break it again — one bad tick is not immediately "stuck".
    gfCreateFolderMock.mockRejectedValue(new Error("Groupfolder create: 503"));
    prisma.deptRows.get(d.id)!.state = "pending";
    prisma.deptRows.get(d.id)!.ncGroupfolderId = null;
    const again = await reconcileDepartments(prisma as any);
    expect(again.departmentsStuck).toBe(0);
  });

  it("the stuck ActivityRow carries how long the row has been failing", async () => {
    gfCreateFolderMock.mockRejectedValue(new Error("nc unreachable"));
    const d = dept({ state: "failed", provisionError: "previous failure" });
    const prisma = buildPrisma([d]);

    await reconcileDepartments(prisma as any);
    vi.setSystemTime(new Date(Date.now() + 12 * 60 * 1000));
    await reconcileDepartments(prisma as any);

    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "Department stuck in failed state",
        severity: "err",
        refs: expect.objectContaining({ minutesStuck: 12 }),
      }),
    );
  });
});

/**
 * WARP-1651 — the escalation survives an orchestrator restart.
 *
 * WARP-1557 counted consecutive ticks in a module-level in-memory Map, and
 * its comment claimed a restart "at worst delays an escalation by
 * STUCK_TICK_THRESHOLD ticks". On a box restarting more often than the
 * threshold — a deploy, a reboot, an OOM, or the very infra instability that
 * produced the 5xx — the counter never reached the threshold, the demotion
 * NEVER fired, and the owner saw "Setting up…" with no error text forever.
 *
 * A restart is modelled the only way it can be: the process keeps no memory
 * of previous ticks, so a row whose clock says 40 minutes must escalate on
 * the very first sweep it is seen in.
 */
describe("WARP-1651 — the re-verify budget is durable across restarts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T01:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("escalates on the FIRST tick after a restart when the row is already past budget", async () => {
    isAmbiguousWriteFailureMock.mockReturnValue(true);
    gfCreateFolderMock.mockRejectedValue(new Error("Groupfolder create: 503"));
    // The row as a restarted process finds it: parked in the re-verify state
    // with a clock that started 40 minutes ago.
    const d = dept({
      state: "provisioning",
      provisionError: "Groupfolder create: 503",
      nonConvergedSince: new Date(Date.now() - 40 * 60 * 1000),
    });
    const prisma = buildPrisma([d]);

    const first = await reconcileDepartments(prisma as any);

    expect(first.departmentsStuck).toBe(1);
    expect(prisma.deptRows.get(d.id)!.state).toBe("failed");
  });

  it("does not restart the clock on a row that is already counting", async () => {
    // The bug in counter form: every fresh process began at zero. The stamp
    // has to be written once per failure EPISODE and read back afterwards.
    isAmbiguousWriteFailureMock.mockReturnValue(true);
    gfCreateFolderMock.mockRejectedValue(new Error("Groupfolder create: 503"));
    const started = new Date(Date.now() - 10 * 60 * 1000);
    const d = dept({ state: "provisioning", nonConvergedSince: started });
    const prisma = buildPrisma([d]);

    await reconcileDepartments(prisma as any);

    expect(prisma.deptRows.get(d.id)!.nonConvergedSince?.getTime()).toBe(
      started.getTime(),
    );
  });

  it("keeps the clock when it demotes, so the row cannot re-arm its own budget", async () => {
    isAmbiguousWriteFailureMock.mockReturnValue(true);
    gfCreateFolderMock.mockRejectedValue(new Error("Groupfolder create: 503"));
    const started = new Date(Date.now() - 40 * 60 * 1000);
    const d = dept({ state: "provisioning", nonConvergedSince: started });
    const prisma = buildPrisma([d]);

    await reconcileDepartments(prisma as any);

    expect(prisma.deptRows.get(d.id)!.state).toBe("failed");
    expect(prisma.deptRows.get(d.id)!.nonConvergedSince).not.toBeNull();
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

    expect(gfDeleteFolderMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      expect.objectContaining({ confirmOnFailure: true }),
    );
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

/**
 * WARP-1558 — the sweep above IS the backfill, once it can create the group.
 *
 * ADR-029 §2.5 Tier-1 admin see-all is exactly `droplet-admins` membership,
 * and ADR-032 §7 / O-5 (2026-07-27) confirms that tier is unconditional and
 * not narrowable by a custom role.
 *
 * THE DEFECT IS A FRESH-INSTALL ONE. `droplet-admins` is created LAZILY by
 * provisionDepartment, so an install with **no departments** has no group at
 * all — and every add against a non-existent group dies on OCS 102, forever.
 * The create-path fix (routes/auth-groups.ts) stops NEW admin-tier accounts
 * from landing in that state; these specs cover the sweep that has to create
 * the group before it can converge membership into it.
 *
 * A NOTE ON PROVENANCE, because the original framing was different. This work
 * was motivated by the .87 box, where the group was attached at MASK_ADMIN to
 * every groupfolder with ZERO members. **That state no longer reproduces**:
 * re-probed 2026-07-28 on the box at 192.168.1.250, `droplet-admins` holds
 * exactly the three admin-tier users and the reconciler reports
 * adminGroupAdded/Removed/Failed = 0 every tick. Why it differs is NOT
 * established — the box changed address and hostname, and re-provisioned vs
 * rebuilt vs different appliance cannot be distinguished from here, so no
 * causal claim is made. The already-broken-install justification is therefore
 * withdrawn; the zero-department case above is the one these specs defend, and
 * it is unaffected by whatever happened to that box.
 *
 * The answer is deliberately not a migration or a one-shot script: the sweep
 * is stateless, so "an install that never had a member" and "an install whose
 * members an outage dropped" are the same input to it, and the boot tick plus
 * the 5-minute cron converge both.
 *
 * That diagnosis originally rested on `ncListGroupMembers` returning `[]` for
 * "no such group" exactly as it does for "empty", leaving the sweep unable to
 * tell the two apart. WARP-1565 has since landed on main and removed that
 * half: the sweep now reads through `ncListGroupMembersStrict`, which throws
 * on everything except a real 404, so "no group" IS distinguishable. The fix
 * here is unchanged and still required — knowing the group is absent does not
 * create it — but these specs seed the STRICT mock accordingly, and the
 * lenient one is wired to throw (see the mock factory at the top of the file).
 */
describe("WARP-1558 — droplet-admins membership backfill", () => {
  const OPERATORS: FakeUser[] = [
    { id: "u-1", nextcloudUsername: "rjouffret", role: "owner" },
    { id: "u-2", nextcloudUsername: "scruceru", role: "admin" },
    { id: "u-3", nextcloudUsername: "srubinchik", role: "admin" },
  ];

  it("backfills every admin-tier user into an EMPTY group, creating the group first", async () => {
    // A fresh install: three admin-tier users, and no group for them to be in.
    const prisma = buildPrisma([], [], [...OPERATORS, {
      id: "u-4",
      nextcloudUsername: "kid",
      role: "family",
    }]);
    ncListGroupMembersStrictMock.mockResolvedValue([]);

    const order: string[] = [];
    ncEnsureGroupMock.mockImplementation(async (group: string) => {
      order.push(`ensure:${group}`);
    });
    ncAddUserToGroupMock.mockImplementation(async (_t: string, uid: string) => {
      order.push(`add:${uid}`);
    });

    const result = await reconcileDepartments(prisma as any);

    // The group is created BEFORE anyone is added to it — the whole point.
    expect(order[0]).toBe(`ensure:${DROPLET_ADMINS_GROUP}`);
    expect(order.slice(1).sort()).toEqual([
      "add:rjouffret",
      "add:scruceru",
      "add:srubinchik",
    ]);
    // The family user is NOT admin-tier and must not be swept in.
    expect(order).not.toContain("add:kid");
    expect(result.adminGroupAdded).toBe(3);
    expect(result.adminGroupFailed).toBe(0);
  });

  it("is idempotent — the tick after a backfill is a silent no-op with no ensure write", async () => {
    const prisma = buildPrisma([], [], OPERATORS);
    ncListGroupMembersStrictMock.mockResolvedValue([]);

    const first = await reconcileDepartments(prisma as any);
    expect(first.adminGroupAdded).toBe(3);

    // Second tick: NC now reports the members the first tick added.
    vi.clearAllMocks();
    ncEnsureGroupMock.mockResolvedValue(undefined);
    ncListGroupMembersStrictMock.mockResolvedValue(
      OPERATORS.map((u) => ({ id: u.nextcloudUsername! })),
    );

    const second = await reconcileDepartments(prisma as any);

    expect(second.adminGroupAdded).toBe(0);
    expect(second.adminGroupRemoved).toBe(0);
    expect(second.adminGroupFailed).toBe(0);
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    // A converged box pays NO ensure round-trip: the ensure is gated on there
    // being someone to add, so this costs nothing every 5 minutes forever.
    expect(ncEnsureGroupMock).not.toHaveBeenCalledWith(DROPLET_ADMINS_GROUP);
  });

  it("a failed ensure is contained — the sweep still reports the adds as failed and the tick completes", async () => {
    const prisma = buildPrisma([], [], OPERATORS);
    ncListGroupMembersStrictMock.mockResolvedValue([]);
    ncEnsureGroupMock.mockRejectedValue(new Error("OCS 503"));
    // With no group, OCS answers 102 for every add.
    ncAddUserToGroupMock.mockRejectedValue(new Error("group does not exist"));

    const result = await reconcileDepartments(prisma as any);

    // Not a throw, not a silent zero: the failure is visible and the next
    // tick retries, exactly like the sibling sweeps.
    expect(result.adminGroupAdded).toBe(0);
    expect(result.adminGroupFailed).toBe(3);
  });

  it("an ensure failure never starves the revocation direction", async () => {
    // Removals run first and do not depend on the ensure at all — a demoted
    // ex-admin must come OUT of the group even on a box where the adds are
    // all failing.
    const prisma = buildPrisma([], [], [OPERATORS[0]]);
    ncListGroupMembersStrictMock.mockResolvedValue([{ id: "eve" }]);
    ncEnsureGroupMock.mockRejectedValue(new Error("OCS 503"));

    const result = await reconcileDepartments(prisma as any);

    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "eve",
      DROPLET_ADMINS_GROUP,
    );
    expect(result.adminGroupRemoved).toBe(1);
  });

  it("backfilling is loud — each restored operator emits an ActivityRow", async () => {
    const prisma = buildPrisma([], [], [OPERATORS[0]]);
    ncListGroupMembersStrictMock.mockResolvedValue([]);

    await reconcileDepartments(prisma as any);

    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system",
        severity: "warn",
        what: "Restored drifted admin-group member (role tier is truth)",
        refs: expect.objectContaining({
          ncUsername: "rjouffret",
          group: DROPLET_ADMINS_GROUP,
        }),
      }),
    );
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
