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
  isAmbiguousWriteFailureMock,
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
  // WARP-1557: the "did this write land?" classifier. Default false =
  // every failure is an unambiguous rejection, which is exactly the
  // pre-WARP-1557 behaviour every spec below this line was written against.
  // The classifier's own truth table is pinned in
  // nextcloud-groups.client.test.ts.
  isAmbiguousWriteFailureMock: vi.fn().mockReturnValue(false),
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
  isAmbiguousWriteFailure: isAmbiguousWriteFailureMock,
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
  isAmbiguousWriteFailureMock.mockReturnValue(false);
});

/** A groupfolder record matching the shape gfListFolders returns. */
function folder(overrides: Partial<{
  id: number;
  mountPoint: string;
  groups: Record<string, number>;
  quota: number;
}> = {}) {
  return {
    id: 42,
    mountPoint: "Engineering",
    groups: {},
    quota: -3,
    size: 0,
    acl: false,
    manage: [],
    ...overrides,
  };
}

/**
 * The exact NC shape the .87 box showed for a department Prisma had marked
 * `failed`: both member groups and droplet-admins attached at the right
 * masks. `occ groupfolders:list` rendered this as
 *   dept-engineering: read, write, delete       (15)
 *   dept-engineering-ro: read                   (1)
 *   droplet-admins: read, write, share, delete  (31)
 */
function fullyProvisionedFolder(overrides: Record<string, unknown> = {}) {
  return folder({
    id: 42,
    mountPoint: "Engineering",
    groups: {
      "dept-engineering": MASK_RW,
      "dept-engineering-ro": MASK_RO,
      [DROPLET_ADMINS_GROUP]: MASK_ADMIN,
    },
    ...overrides,
  });
}

describe("provisionDepartment — DEPARTMENT happy path", () => {
  it("creates groups + folder, sets masks, sets quota, lands active", async () => {
    const d = dept({ quotaBytes: 1_000_000n });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id);

    expect(ncEnsureGroupMock).toHaveBeenCalledWith("dept-engineering");
    expect(ncEnsureGroupMock).toHaveBeenCalledWith("dept-engineering-ro");
    expect(ncEnsureGroupMock).toHaveBeenCalledWith(DROPLET_ADMINS_GROUP);

    // WARP-1557: the writes now carry a trailing GfWriteOptions. On this
    // (non-retry) path `confirmOnFailure` is false — no read-back.
    const noConfirm = expect.objectContaining({ confirmOnFailure: false });
    expect(gfCreateFolderMock).toHaveBeenCalledWith(
      expect.any(String),
      "Engineering",
      noConfirm,
    );
    expect(gfAddGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "dept-engineering",
      noConfirm,
    );
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "dept-engineering",
      MASK_RW,
      noConfirm,
    );
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "dept-engineering-ro",
      MASK_RO,
      noConfirm,
    );
    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      DROPLET_ADMINS_GROUP,
      MASK_ADMIN,
      noConfirm,
    );
    expect(gfSetQuotaMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      1_000_000,
      noConfirm,
    );

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
      expect.objectContaining({ confirmOnFailure: false }),
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
    expect(gfAddGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      99,
      "dept-engineering",
      expect.objectContaining({ confirmOnFailure: false }),
    );

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

// ── WARP-1557 ────────────────────────────────────────────────────────────
//
// A Nextcloud write that returns 5xx AFTER the write already took effect used
// to park the Department row in terminal `failed` forever: the reconciler
// could only re-issue the failing write, never observe that reality already
// matched intent. Two departments on the .87 box sat `failed` with
// `provisionError = "Groupfolder add group: 500"` while `occ
// groupfolders:list` showed both folders fully provisioned.

describe("WARP-1557 — bounded convergence verification (retry path only)", () => {
  it("REGRESSION: a row whose NC state already matches intent converges to active instead of retrying the failing write forever", async () => {
    // The write that reported 500 on the box. It still fails — the point is
    // that it never even gets called, because the folder already matches.
    gfAddGroupMock.mockRejectedValue(new Error("Groupfolder add group: 500"));
    gfListFoldersMock.mockResolvedValue([fullyProvisionedFolder()]);

    const d = dept({ state: "failed", provisionError: "Groupfolder add group: 500" });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id, { verifyOnFailure: true });

    const row = prisma.rows.get(d.id)!;
    expect(row.state).toBe("active");
    expect(row.provisionError).toBeNull();
    expect(row.ncGroupRw).toBe("dept-engineering");
    expect(row.ncGroupRo).toBe("dept-engineering-ro");
    expect(row.ncGroupfolderId).toBe(42);

    // Converged WITHOUT re-issuing the writes — so a Nextcloud that is 500ing
    // on every write cannot block recovery of a row it has already satisfied.
    expect(gfAddGroupMock).not.toHaveBeenCalled();
    expect(gfSetGroupPermissionsMock).not.toHaveBeenCalled();
    expect(gfCreateFolderMock).not.toHaveBeenCalled();
    expect(ncEnsureGroupMock).not.toHaveBeenCalled();
  });

  it("verification is OFF by default — first provision still writes unconditionally (ADR-029 write-only projection)", async () => {
    gfListFoldersMock.mockResolvedValue([fullyProvisionedFolder()]);
    const d = dept({ state: "pending" });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id);

    // Every push still happens: the read-back exception is scoped strictly
    // to the reconciler's failed-row retry sweep.
    expect(ncEnsureGroupMock).toHaveBeenCalled();
    expect(gfAddGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "dept-engineering",
      expect.objectContaining({ confirmOnFailure: false }),
    );
    expect(prisma.rows.get(d.id)!.state).toBe("active");
  });

  it("a PARTIAL match is not convergence — the writes are re-issued", async () => {
    // droplet-admins missing: the invariant is not satisfied, so this must
    // fall through to the normal write path rather than declaring victory.
    gfListFoldersMock.mockResolvedValue([
      folder({
        groups: { "dept-engineering": MASK_RW, "dept-engineering-ro": MASK_RO },
      }),
    ]);
    const d = dept({ state: "failed" });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id, { verifyOnFailure: true });

    expect(gfAddGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      DROPLET_ADMINS_GROUP,
      expect.objectContaining({ confirmOnFailure: true }),
    );
    expect(prisma.rows.get(d.id)!.state).toBe("active");
  });

  it("a WRONG MASK is not convergence — a folder at read-only does not pass as read-write", async () => {
    gfListFoldersMock.mockResolvedValue([
      fullyProvisionedFolder({
        groups: {
          "dept-engineering": MASK_RO, // drifted down from MASK_RW
          "dept-engineering-ro": MASK_RO,
          [DROPLET_ADMINS_GROUP]: MASK_ADMIN,
        },
      }),
    ]);
    const d = dept({ state: "failed" });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id, { verifyOnFailure: true });

    expect(gfSetGroupPermissionsMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "dept-engineering",
      MASK_RW,
      expect.objectContaining({ confirmOnFailure: true }),
    );
  });

  it("a declared quota that does not match is not convergence", async () => {
    gfListFoldersMock.mockResolvedValue([fullyProvisionedFolder({ quota: 5 })]);
    const d = dept({ state: "failed", quotaBytes: 1_000_000n });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id, { verifyOnFailure: true });

    expect(gfSetQuotaMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      1_000_000,
      expect.objectContaining({ confirmOnFailure: true }),
    );
  });

  it("an unmanaged (null) quota does not block convergence", async () => {
    gfListFoldersMock.mockResolvedValue([fullyProvisionedFolder({ quota: 99 })]);
    const d = dept({ state: "failed", quotaBytes: null });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id, { verifyOnFailure: true });

    expect(prisma.rows.get(d.id)!.state).toBe("active");
    expect(gfSetQuotaMock).not.toHaveBeenCalled();
  });
});

describe("WARP-1557 — write rejected vs write may have landed", () => {
  it("an AMBIGUOUS failure (5xx) parks the row in the non-terminal re-verify state, not terminal failed", async () => {
    isAmbiguousWriteFailureMock.mockReturnValue(true);
    gfCreateFolderMock.mockRejectedValue(new Error("Groupfolder create: 500"));
    const d = dept({ state: "pending" });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id);

    const row = prisma.rows.get(d.id)!;
    // `provisioning` is swept down the provision path next tick, where the
    // verification above gets a chance to observe that the write did land.
    expect(row.state).toBe("provisioning");
    expect(row.provisionError).toContain("500");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "Department provisioning unconfirmed (will re-verify)",
        refs: expect.objectContaining({ ambiguous: true }),
      }),
    );
  });

  it("an UNAMBIGUOUS failure (4xx) still lands in terminal failed", async () => {
    isAmbiguousWriteFailureMock.mockReturnValue(false);
    gfCreateFolderMock.mockRejectedValue(new Error("Groupfolder create: 403"));
    const d = dept({ state: "pending" });
    const prisma = buildPrisma([d]);

    await provisionDepartment(prisma as any, d.id);

    expect(prisma.rows.get(d.id)!.state).toBe("failed");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "Department provisioning failed",
        refs: expect.objectContaining({ ambiguous: false }),
      }),
    );
  });

  it("an ambiguous ARCHIVE failure stays on the archive side of the routing (never re-provisioned)", async () => {
    isAmbiguousWriteFailureMock.mockReturnValue(true);
    gfDeleteFolderMock.mockRejectedValue(new Error("Groupfolder delete 42 failed: 503"));
    const d = dept({
      state: "active",
      ncGroupRw: "dept-engineering",
      ncGroupRo: "dept-engineering-ro",
      ncGroupfolderId: 42,
    });
    const prisma = buildPrisma([d]);

    await archiveDepartment(prisma as any, d.id, { verifyOnFailure: true });

    // `archiving`, NOT `failed` — an unconfirmed archive must never fall into
    // the provision path, which would silently un-archive the department.
    expect(prisma.rows.get(d.id)!.state).toBe("archiving");
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

    const noConfirm = expect.objectContaining({ confirmOnFailure: false });
    expect(gfRemoveGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "dept-engineering",
      noConfirm,
    );
    expect(gfRemoveGroupMock).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "dept-engineering-ro",
      noConfirm,
    );
    expect(gfRemoveGroupMock).not.toHaveBeenCalledWith(
      expect.any(String),
      42,
      DROPLET_ADMINS_GROUP,
      noConfirm,
    );
    expect(gfDeleteFolderMock).toHaveBeenCalledWith(expect.any(String), 42, noConfirm);

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
