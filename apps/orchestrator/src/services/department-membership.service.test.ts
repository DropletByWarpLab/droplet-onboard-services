/**
 * WARP-1259 (T7) — department membership service tests.
 *
 * Covers: departmentManagerOrAdmin authz matrix (incl. inherited-manager
 * rule), in-tx aclVersion bump on every public mutation, rights-transition
 * NC ordering (upgrade vs downgrade vs policy-only), removal ordering +
 * fail-closed retry state, and the last-manager invariant.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    NEXTCLOUD_URL: "http://nextcloud.test",
  },
}));

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

const { callOrder, ncAddUserToGroupMock, ncRemoveUserFromGroupMock } = vi.hoisted(() => {
  const order: string[] = [];
  return {
    callOrder: order,
    ncAddUserToGroupMock: vi.fn(async (_token: string, uid: string, groupId: string) => {
      order.push(`add:${uid}:${groupId}`);
    }),
    ncRemoveUserFromGroupMock: vi.fn(async (_token: string, uid: string, groupId: string) => {
      order.push(`remove:${uid}:${groupId}`);
    }),
  };
});
vi.mock("./nextcloud-groups.client.js", () => ({
  ncAddUserToGroup: ncAddUserToGroupMock,
  ncRemoveUserFromGroup: ncRemoveUserFromGroupMock,
}));

vi.mock("./department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:dGVzdDp0ZXN0"),
  DROPLET_ADMINS_GROUP: "droplet-admins",
  MASK_RW: 15,
  MASK_RO: 1,
  MASK_ADMIN: 31,
}));

import {
  departmentManagerOrAdmin,
  addMembership,
  updateMembershipRight,
  removeMembership,
  UserNotFoundError,
  DepartmentNotFoundError,
  DuplicateMembershipError,
  MembershipNotFoundError,
  LastManagerError,
} from "./department-membership.service.js";

// ── Mock Prisma ──────────────────────────────────────────────────────

function createMockPrisma() {
  const departments = new Map<string, any>();
  const membershipsByKey = new Map<string, any>();
  const membershipsById = new Map<string, any>();
  const users = new Map<string, any>();
  let memberSeq = 1;

  const self: any = {};
  self.$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(self));

  self.department = {
    findUnique: vi.fn(async ({ where, select }: any) => {
      const dept = departments.get(where.id);
      if (!dept) return null;
      if (select) {
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = dept[k];
        return out;
      }
      return { ...dept };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const dept = departments.get(where.id);
      if (!dept) throw new Error(`department not found: ${where.id}`);
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
        const row = membershipsByKey.get(key);
        return row ? { ...row } : null;
      }
      const row = membershipsById.get(where.id);
      return row ? { ...row } : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const row = {
        id: `mem-${memberSeq++}`,
        syncError: null,
        ncPermissionMask: null,
        grantedAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      membershipsByKey.set(`${row.departmentId}:${row.userId}`, row);
      membershipsById.set(row.id, row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      let row: any;
      if (where.departmentId_userId) {
        row = membershipsByKey.get(
          `${where.departmentId_userId.departmentId}:${where.departmentId_userId.userId}`,
        );
      } else {
        row = membershipsById.get(where.id);
      }
      if (!row) throw new Error("membership not found");
      Object.assign(row, data);
      row.updatedAt = new Date();
      return { ...row };
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = membershipsById.get(where.id);
      if (!row) throw new Error("membership not found");
      membershipsById.delete(where.id);
      membershipsByKey.delete(`${row.departmentId}:${row.userId}`);
      return { ...row };
    }),
    count: vi.fn(async ({ where }: any) => {
      let n = 0;
      for (const m of membershipsByKey.values()) {
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

  return {
    prisma: self as PrismaClient,
    departments,
    membershipsByKey,
    membershipsById,
    users,
  };
}

function seedDept(
  departments: Map<string, any>,
  over: Partial<{
    id: string;
    parentId: string | null;
    state: string;
    ncGroupRw: string | null;
    ncGroupRo: string | null;
    aclVersion: number;
    kind: string;
  }> = {},
) {
  const dept = {
    id: over.id ?? `dept-${Math.random().toString(16).slice(2, 8)}`,
    parentId: over.parentId ?? null,
    state: over.state ?? "active",
    ncGroupRw: over.ncGroupRw ?? "dept-sales",
    ncGroupRo: over.ncGroupRo ?? "dept-sales-ro",
    aclVersion: over.aclVersion ?? 0,
    kind: over.kind ?? "DEPARTMENT",
  };
  departments.set(dept.id, dept);
  return dept;
}

function seedUser(users: Map<string, any>, id: string, nextcloudUsername: string | null) {
  users.set(id, { id, nextcloudUsername });
}

function seedMembership(
  membershipsByKey: Map<string, any>,
  membershipsById: Map<string, any>,
  over: {
    id: string;
    departmentId: string;
    userId: string;
    right: string;
    syncState?: string;
  },
) {
  const row = {
    syncState: "synced",
    syncError: null,
    ncPermissionMask: null,
    grantedBy: "seed",
    grantedAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  membershipsByKey.set(`${row.departmentId}:${row.userId}`, row);
  membershipsById.set(row.id, row);
  return row;
}

beforeEach(() => {
  callOrder.length = 0;
  ncAddUserToGroupMock.mockClear();
  ncRemoveUserFromGroupMock.mockClear();
  ncAddUserToGroupMock.mockImplementation(async (_t: string, uid: string, g: string) => {
    callOrder.push(`add:${uid}:${g}`);
  });
  ncRemoveUserFromGroupMock.mockImplementation(async (_t: string, uid: string, g: string) => {
    callOrder.push(`remove:${uid}:${g}`);
  });
});

// ── departmentManagerOrAdmin ─────────────────────────────────────────

describe("departmentManagerOrAdmin", () => {
  it("owner passes unconditionally, even with no membership row", async () => {
    const { prisma, departments } = createMockPrisma();
    const dept = seedDept(departments);
    const ok = await departmentManagerOrAdmin(prisma, dept.id, { id: "u1", role: "owner" });
    expect(ok).toBe(true);
  });

  it("admin passes unconditionally", async () => {
    const { prisma, departments } = createMockPrisma();
    const dept = seedDept(departments);
    const ok = await departmentManagerOrAdmin(prisma, dept.id, { id: "u1", role: "admin" });
    expect(ok).toBe(true);
  });

  it("manager of the department itself passes", async () => {
    const { prisma, departments, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments);
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "mgr1",
      right: "manager",
    });
    const ok = await departmentManagerOrAdmin(prisma, dept.id, { id: "mgr1", role: "family" });
    expect(ok).toBe(true);
  });

  it("manager of the PARENT department passes on a child TEAM (inherited-manager rule)", async () => {
    const { prisma, departments, membershipsByKey, membershipsById } = createMockPrisma();
    const parent = seedDept(departments, { id: "dept-parent" });
    const team = seedDept(departments, { id: "team-child", parentId: parent.id, kind: "TEAM" });
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: parent.id,
      userId: "mgr1",
      right: "manager",
    });
    const ok = await departmentManagerOrAdmin(prisma, team.id, { id: "mgr1", role: "family" });
    expect(ok).toBe(true);
  });

  it("plain (non-manager) member of the department is refused", async () => {
    const { prisma, departments, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments);
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "u1",
      right: "contributor",
    });
    const ok = await departmentManagerOrAdmin(prisma, dept.id, { id: "u1", role: "family" });
    expect(ok).toBe(false);
  });

  it("plain (non-manager) member of the PARENT gets no implicit team access", async () => {
    const { prisma, departments, membershipsByKey, membershipsById } = createMockPrisma();
    const parent = seedDept(departments, { id: "dept-parent" });
    const team = seedDept(departments, { id: "team-child", parentId: parent.id, kind: "TEAM" });
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: parent.id,
      userId: "u1",
      right: "contributor",
    });
    const ok = await departmentManagerOrAdmin(prisma, team.id, { id: "u1", role: "family" });
    expect(ok).toBe(false);
  });

  it("a non-member family caller is refused", async () => {
    const { prisma, departments } = createMockPrisma();
    const dept = seedDept(departments);
    const ok = await departmentManagerOrAdmin(prisma, dept.id, { id: "stranger", role: "family" });
    expect(ok).toBe(false);
  });

  it("returns false for an unknown department", async () => {
    const { prisma } = createMockPrisma();
    const ok = await departmentManagerOrAdmin(prisma, "nope", { id: "u1", role: "family" });
    expect(ok).toBe(false);
  });
});

// ── addMembership ────────────────────────────────────────────────────

describe("addMembership", () => {
  it("happy path: creates the row, bumps aclVersion, and syncs to the target NC group", async () => {
    const { prisma, departments, users } = createMockPrisma();
    const dept = seedDept(departments, { aclVersion: 3 });
    seedUser(users, "u1", "u1-nc");

    const row = await addMembership(prisma, dept.id, "u1", "contributor", "grantor-1");

    expect(row.right).toBe("contributor");
    expect(row.syncState).toBe("synced");
    expect((row as any).ncPermissionMask).toBe(15); // MASK_RW
    expect(ncAddUserToGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "u1-nc",
      "dept-sales",
    );
    expect(departments.get(dept.id).aclVersion).toBe(4);
  });

  it("reader right syncs to the ro group with MASK_RO", async () => {
    const { prisma, departments, users } = createMockPrisma();
    const dept = seedDept(departments);
    seedUser(users, "u1", "u1-nc");

    const row = await addMembership(prisma, dept.id, "u1", "reader", "grantor-1");

    expect((row as any).ncPermissionMask).toBe(1); // MASK_RO
    expect(ncAddUserToGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      "u1-nc",
      "dept-sales-ro",
    );
  });

  it("leaves the row pending (no NC call) when the department isn't active yet", async () => {
    const { prisma, departments, users } = createMockPrisma();
    const dept = seedDept(departments, { state: "provisioning" });
    seedUser(users, "u1", "u1-nc");

    const row = await addMembership(prisma, dept.id, "u1", "contributor", "grantor-1");

    expect(row.syncState).toBe("pending");
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    // aclVersion still bumps — the mutation itself committed even though
    // NC convergence is deferred to the reconciler.
    expect(departments.get(dept.id).aclVersion).toBe(1);
  });

  it("throws UserNotFoundError for an unknown local user", async () => {
    const { prisma, departments } = createMockPrisma();
    const dept = seedDept(departments);
    await expect(
      addMembership(prisma, dept.id, "ghost", "contributor", "grantor-1"),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it("throws DepartmentNotFoundError for an unknown department", async () => {
    const { prisma, users } = createMockPrisma();
    seedUser(users, "u1", "u1-nc");
    await expect(
      addMembership(prisma, "nope", "u1", "contributor", "grantor-1"),
    ).rejects.toBeInstanceOf(DepartmentNotFoundError);
  });

  it("throws DuplicateMembershipError when the user is already a member", async () => {
    const { prisma, departments, users, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments);
    seedUser(users, "u1", "u1-nc");
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "u1",
      right: "reader",
    });

    await expect(
      addMembership(prisma, dept.id, "u1", "contributor", "grantor-1"),
    ).rejects.toBeInstanceOf(DuplicateMembershipError);
  });
});

// ── updateMembershipRight — transition ordering ─────────────────────

describe("updateMembershipRight", () => {
  it("UPGRADE (reader -> contributor): add-to-rw THEN remove-from-ro", async () => {
    const { prisma, departments, users, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments, { aclVersion: 0 });
    seedUser(users, "u1", "u1-nc");
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "u1",
      right: "reader",
    });

    const row = await updateMembershipRight(prisma, dept.id, "u1", "contributor");

    expect(callOrder).toEqual(["add:u1-nc:dept-sales", "remove:u1-nc:dept-sales-ro"]);
    expect(row.syncState).toBe("synced");
    expect((row as any).ncPermissionMask).toBe(15);
    expect(departments.get(dept.id).aclVersion).toBe(1);
  });

  it("DOWNGRADE (manager -> reader): remove-from-rw THEN add-to-ro", async () => {
    const { prisma, departments, users, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments, { aclVersion: 0 });
    seedUser(users, "u1", "u1-nc");
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "u1",
      right: "manager",
    });

    const row = await updateMembershipRight(prisma, dept.id, "u1", "reader");

    expect(callOrder).toEqual(["remove:u1-nc:dept-sales", "add:u1-nc:dept-sales-ro"]);
    expect(row.syncState).toBe("synced");
    expect((row as any).ncPermissionMask).toBe(1);
    expect(departments.get(dept.id).aclVersion).toBe(1);
  });

  it("contributor <-> manager is policy-only: no NC calls, still bumps aclVersion", async () => {
    const { prisma, departments, users, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments, { aclVersion: 5 });
    seedUser(users, "u1", "u1-nc");
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "u1",
      right: "contributor",
    });

    const row = await updateMembershipRight(prisma, dept.id, "u1", "manager");

    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
    expect(row.right).toBe("manager");
    expect(row.syncState).toBe("synced");
    expect(departments.get(dept.id).aclVersion).toBe(6);
  });

  it("no-op when the requested right equals the current right (no bump, no NC calls)", async () => {
    const { prisma, departments, users, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments, { aclVersion: 2 });
    seedUser(users, "u1", "u1-nc");
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "u1",
      right: "contributor",
    });

    await updateMembershipRight(prisma, dept.id, "u1", "contributor");

    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
    expect(departments.get(dept.id).aclVersion).toBe(2);
  });

  it("throws MembershipNotFoundError when there is no existing row", async () => {
    const { prisma, departments } = createMockPrisma();
    const dept = seedDept(departments);
    await expect(
      updateMembershipRight(prisma, dept.id, "ghost", "manager"),
    ).rejects.toBeInstanceOf(MembershipNotFoundError);
  });
});

// ── removeMembership — ordering + last-manager invariant ────────────

describe("removeMembership", () => {
  it("happy path: removes from both NC groups THEN deletes the row, bumps aclVersion", async () => {
    const { prisma, departments, users, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments, { aclVersion: 0 });
    seedUser(users, "u1", "u1-nc");
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "u1",
      right: "contributor",
    });

    const result = await removeMembership(prisma, dept.id, "u1");

    expect(result.kind).toBe("ok");
    expect(callOrder).toEqual(["remove:u1-nc:dept-sales", "remove:u1-nc:dept-sales-ro"]);
    expect(membershipsById.has("m1")).toBe(false);
    expect(departments.get(dept.id).aclVersion).toBe(1);
  });

  it("last-manager invariant: refuses to remove the sole manager, row untouched", async () => {
    const { prisma, departments, users, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments, { aclVersion: 0 });
    seedUser(users, "mgr1", "mgr1-nc");
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "mgr1",
      right: "manager",
    });

    await expect(removeMembership(prisma, dept.id, "mgr1")).rejects.toBeInstanceOf(
      LastManagerError,
    );

    // Nothing mutated: no NC calls, row still present with its original
    // syncState, aclVersion NOT bumped (the tx returned "last-manager"
    // before the update/bump ran).
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
    expect(membershipsById.get("m1")?.right).toBe("manager");
    expect(membershipsById.get("m1")?.syncState).toBe("synced");
    expect(departments.get(dept.id).aclVersion).toBe(0);
  });

  it("allows removing a manager when a second manager remains", async () => {
    const { prisma, departments, users, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments);
    seedUser(users, "mgr1", "mgr1-nc");
    seedUser(users, "mgr2", "mgr2-nc");
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "mgr1",
      right: "manager",
    });
    seedMembership(membershipsByKey, membershipsById, {
      id: "m2",
      departmentId: dept.id,
      userId: "mgr2",
      right: "manager",
    });

    const result = await removeMembership(prisma, dept.id, "mgr1");
    expect(result.kind).toBe("ok");
    expect(membershipsById.has("m1")).toBe(false);
    expect(membershipsById.has("m2")).toBe(true);
  });

  it("fail-closed: row stays 'removing' (not deleted) when the NC push fails", async () => {
    const { prisma, departments, users, membershipsByKey, membershipsById } = createMockPrisma();
    const dept = seedDept(departments);
    seedUser(users, "u1", "u1-nc");
    seedMembership(membershipsByKey, membershipsById, {
      id: "m1",
      departmentId: dept.id,
      userId: "u1",
      right: "contributor",
    });
    ncRemoveUserFromGroupMock.mockImplementationOnce(async () => {
      throw new Error("nc unreachable");
    });

    const result = await removeMembership(prisma, dept.id, "u1");

    expect(result.kind).toBe("ok"); // the request-level mutation (tx) succeeded
    const row = membershipsById.get("m1");
    expect(row).toBeDefined();
    expect(row.syncState).toBe("removing");
    expect(row.syncError).toMatch(/nc unreachable/);
  });

  it("throws MembershipNotFoundError for a user who isn't a member", async () => {
    const { prisma, departments } = createMockPrisma();
    const dept = seedDept(departments);
    await expect(removeMembership(prisma, dept.id, "ghost")).rejects.toBeInstanceOf(
      MembershipNotFoundError,
    );
  });

  it("throws DepartmentNotFoundError for an unknown department", async () => {
    const { prisma } = createMockPrisma();
    await expect(removeMembership(prisma, "nope", "u1")).rejects.toBeInstanceOf(
      DepartmentNotFoundError,
    );
  });
});
