/**
 * WARP-1257 (T5) — department-provisioner.service unit tests.
 *
 * Mocks the NC client modules + a minimal in-memory Prisma stub (mirrors
 * the pattern in guest-expiry-sweep.test.ts: a Map-backed fake with the
 * subset of Prisma methods the service actually calls).
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
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  provisionDepartment,
  archiveDepartment,
  MASK_RW,
  MASK_RO,
  MASK_ADMIN,
  DROPLET_ADMINS_GROUP,
} from "../services/department-provisioner.service.js";

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

function buildPrisma(departments: FakeDepartment[]) {
  const rows = new Map<string, FakeDepartment>(departments.map((d) => [d.id, d]));
  return {
    rows,
    department: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const row = rows.get(id);
        return row ? { ...row } : null;
      }),
      update: vi.fn(
        async ({
          where: { id },
          data,
        }: {
          where: { id: string };
          data: Partial<FakeDepartment>;
        }) => {
          const row = rows.get(id);
          if (!row) throw new Error(`no such department ${id}`);
          Object.assign(row, data);
          return { ...row };
        },
      ),
    },
  };
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

beforeEach(() => {
  vi.clearAllMocks();
  ncEnsureGroupMock.mockResolvedValue(undefined);
  gfListFoldersMock.mockResolvedValue([]);
  gfCreateFolderMock.mockResolvedValue(42);
  gfDeleteFolderMock.mockResolvedValue(undefined);
  gfAddGroupMock.mockResolvedValue(undefined);
  gfRemoveGroupMock.mockResolvedValue(undefined);
  gfSetGroupPermissionsMock.mockResolvedValue(undefined);
  gfSetQuotaMock.mockResolvedValue(undefined);
});

describe("provisionDepartment — DEPARTMENT happy path", () => {
  it("creates groups + folder, sets masks, sets quota, lands active", async () => {
    const d = dept({ quotaBytes: 1_000_000n });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id);

    expect(ncEnsureGroupMock).toHaveBeenCalledWith("dept-engineering");
    expect(ncEnsureGroupMock).toHaveBeenCalledWith("dept-engineering-ro");
    expect(ncEnsureGroupMock).toHaveBeenCalledWith(DROPLET_ADMINS_GROUP);

    expect(gfCreateFolderMock).toHaveBeenCalledWith(expect.any(String), "Engineering");
    expect(gfAddGroupMock).toHaveBeenCalledWith(expect.any(String), 42, "dept-engineering");
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "dept-engineering",
      MASK_RW,
    );
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "dept-engineering-ro",
      MASK_RO,
    );
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      DROPLET_ADMINS_GROUP,
      MASK_ADMIN,
    );
    expect(gfSetQuotaMock).toHaveBeenCalledWith(expect.any(String), 42, 1_000_000);

    const row = prisma.rows.get(d.id)!;
    expect(row.state).toBe("active");
    expect(row.provisionError).toBeNull();
    expect(row.ncGroupRw).toBe("dept-engineering");
    expect(row.ncGroupRo).toBe("dept-engineering-ro");
    expect(row.ncGroupfolderId).toBe(42);
  });
});

describe("provisionDepartment — TEAM happy path", () => {
  it("namespaces groups under the parent slug and mounts FLAT 'Parent — Team'", async () => {
    const parent = dept({ id: "dept-parent", name: "Engineering", slug: "engineering" });
    const team = dept({
      id: "dept-team",
      name: "Platform",
      slug: "platform",
      parentId: "dept-parent",
      kind: "TEAM",
    });
    const prisma = buildPrisma([parent, team]);

    await provisionDepartment(prisma as any, team.id);

    expect(ncEnsureGroupMock).toHaveBeenCalledWith("dept-engineering-platform");
    expect(ncEnsureGroupMock).toHaveBeenCalledWith("dept-engineering-platform-ro");
    expect(gfCreateFolderMock).toHaveBeenCalledWith(
      expect.any(String),
      "Engineering — Platform",
    );

    const row = prisma.rows.get(team.id)!;
    expect(row.state).toBe("active");
    expect(row.ncGroupRw).toBe("dept-engineering-platform");
    expect(row.ncGroupRo).toBe("dept-engineering-platform-ro");
  });
});

describe("provisionDepartment — HOUSEHOLD skip", () => {
  it("never calls any NC client and goes straight to active", async () => {
    const d = dept({ kind: "HOUSEHOLD", name: "Household", slug: "household" });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id);

    expect(ncEnsureGroupMock).not.toHaveBeenCalled();
    expect(gfCreateFolderMock).not.toHaveBeenCalled();
    expect(gfListFoldersMock).not.toHaveBeenCalled();
    expect(gfAddGroupMock).not.toHaveBeenCalled();

    const row = prisma.rows.get(d.id)!;
    expect(row.state).toBe("active");
  });
});

describe("provisionDepartment — dedupe by mount point", () => {
  it("reuses an existing groupfolder instead of creating a duplicate", async () => {
    gfListFoldersMock.mockResolvedValue([
      { id: 99, mountPoint: "Engineering", groups: {}, quota: -3, size: 0, acl: false, manage: [] },
    ]);
    const d = dept({});
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id);

    expect(gfCreateFolderMock).not.toHaveBeenCalled();
    expect(gfAddGroupMock).toHaveBeenCalledWith(expect.any(String), 99, "dept-engineering");

    const row = prisma.rows.get(d.id)!;
    expect(row.ncGroupfolderId).toBe(99);
  });
});

describe("provisionDepartment — failure handling", () => {
  it("flips to failed with a truncated provisionError on NC failure", async () => {
    gfCreateFolderMock.mockRejectedValue(new Error("x".repeat(2000)));
    const d = dept({});
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id);

    const row = prisma.rows.get(d.id)!;
    expect(row.state).toBe("failed");
    expect(row.provisionError).toBeTruthy();
    expect(row.provisionError!.length).toBeLessThanOrEqual(1025); // 1024 + ellipsis char
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "err", what: "Department provisioning failed" }),
    );
  });

  it("never calls gfDeleteFolder from the provisioning path", async () => {
    gfCreateFolderMock.mockRejectedValue(new Error("boom"));
    const d = dept({});
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id);

    expect(gfDeleteFolderMock).not.toHaveBeenCalled();
  });
});

describe("archiveDepartment", () => {
  it("removes rw/ro groups, keeps droplet-admins, deletes the folder, lands archived", async () => {
    const d = dept({
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 42,
    });
    const prisma = buildPrisma([d]);

    await archiveDepartment(prisma as any, d.id);

    expect(gfRemoveGroupMock).toHaveBeenCalledWith(expect.any(String), 42, "dept-engineering");
    expect(gfRemoveGroupMock).toHaveBeenCalledWith(expect.any(String), 42, "dept-engineering-ro");
    expect(gfRemoveGroupMock).not.toHaveBeenCalledWith(
      expect.any(String),
      42,
      DROPLET_ADMINS_GROUP,
    );
    expect(gfDeleteFolderMock).toHaveBeenCalledWith(expect.any(String), 42);

    const row = prisma.rows.get(d.id)!;
    expect(row.state).toBe("archived");
    expect(row.archivedAt).toBeInstanceOf(Date);
  });

  it("skips NC mutation entirely for HOUSEHOLD rows", async () => {
    const d = dept({ kind: "HOUSEHOLD", state: "active", ncGroupfolderId: 1 });
    const prisma = buildPrisma([d]);

    await archiveDepartment(prisma as any, d.id);

    expect(gfRemoveGroupMock).not.toHaveBeenCalled();
    expect(gfDeleteFolderMock).not.toHaveBeenCalled();
    expect(prisma.rows.get(d.id)!.state).toBe("archived");
  });

  // WARP-1257 CR (blocking): an archive that fails partway must land in the
  // archive-specific failure state so the reconciler retries it down the
  // ARCHIVE path — never the generic `failed` the provision path picks up.
  it("flips to archive_failed (not archived, not generic failed) when gfDeleteFolder throws", async () => {
    gfDeleteFolderMock.mockRejectedValue(new Error("nc down"));
    const d = dept({
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 42,
    });
    const prisma = buildPrisma([d]);

    await archiveDepartment(prisma as any, d.id);

    const row = prisma.rows.get(d.id)!;
    expect(row.state).toBe("archive_failed");
    expect(row.provisionError).toContain("nc down");
  });
});
