/**
 * WARP-1269 (T17) — manager-minted department shares + the
 * `DepartmentShare` registry.
 *
 * Builds the real `createFilesRouter` (like files.space-threading.test.ts)
 * with a configurable prisma stub for `department` / `departmentMembership`
 * / `departmentShare` — the REAL `requireSpaceAccess` + the route's own
 * authz/credential-selection logic run; only the Nextcloud client + DB
 * writes are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return {
    NextcloudOcsError: actual.NextcloudOcsError,
    ncListFiles: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncUploadFile: vi.fn(),
    ncDownloadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncListShares: vi.fn(),
    ncMoveFile: vi.fn(),
    ncCopyFile: vi.fn(),
    ncGetFileId: vi.fn(),
    ncListTrash: vi.fn(),
    ncRestoreTrashItem: vi.fn(),
    ncDeleteTrashItem: vi.fn(),
    ncEmptyTrash: vi.fn(),
    ncListVersions: vi.fn(),
    ncRestoreVersion: vi.fn(),
    ncSetFavorite: vi.fn(),
    ncListFavorites: vi.fn(),
    ncSearchFiles: vi.fn(),
    ncListRecents: vi.fn(),
    ncFetchThumbnail: vi.fn(),
    ncCreateShareV2: vi.fn(),
    ncUpdateShare: vi.fn(),
    ncDeleteShare: vi.fn(),
    ncListSharedWithMe: vi.fn(),
    ncListMyShares: vi.fn(),
    ncGetShare: vi.fn(),
  };
});

const mockResolveNcToken = vi.fn();
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: (...a: unknown[]) => mockResolveNcToken(...a),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config.js", () => ({
  config: {
    MAX_UPLOAD_SIZE_MB: 10,
    NODE_ENV: "test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    NEXTCLOUD_URL: "http://nextcloud.test",
  },
}));

import { createFilesRouter } from "../routes/files.js";
import * as nc from "../services/nextcloud.client.js";
import { recordActivity } from "../services/activity.singleton.js";

type Mocked<T extends (...a: any[]) => any> = T & ReturnType<typeof vi.fn>;
const ncMock = nc as unknown as { [K in keyof typeof nc]: Mocked<any> };
const recordActivityMock = recordActivity as unknown as Mocked<any>;

interface DeptRow {
  id: string;
  name: string;
  parentId: string | null;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  state: string;
}

interface ShareRow {
  departmentId: string;
  ncShareId: number;
  createdById: string;
  shareType: number;
  path: string;
  revokedAt: Date | null;
}

function makePrismaStub(opts: {
  departments?: DeptRow[];
  memberships?: Array<{ departmentId: string; userId: string; right: string }>;
  shares?: ShareRow[];
}) {
  const byId = new Map<string, DeptRow>();
  for (const d of opts.departments ?? []) byId.set(d.id, d);
  const shareStore = new Map<number, ShareRow>();
  for (const s of opts.shares ?? []) shareStore.set(s.ncShareId, s);

  return {
    department: {
      findFirst: vi.fn(async (args?: { where?: { kind?: string } }) =>
        args?.where?.kind === "HOUSEHOLD"
          ? [...byId.values()].find((d) => d.kind === "HOUSEHOLD") ?? null
          : null,
      ),
      findUnique: vi.fn(async (args?: { where?: { id?: string } }) => {
        const id = args?.where?.id;
        return (id && byId.get(id)) ?? null;
      }),
    },
    departmentMembership: {
      findUnique: vi.fn(
        async (args?: { where?: { departmentId_userId?: { departmentId: string; userId: string } } }) => {
          const key = args?.where?.departmentId_userId;
          if (!key) return null;
          const found = (opts.memberships ?? []).find(
            (m) => m.departmentId === key.departmentId && m.userId === key.userId,
          );
          return found ? { right: found.right } : null;
        },
      ),
    },
    departmentShare: {
      findUnique: vi.fn(async (args?: { where?: { ncShareId?: number } }) => {
        const id = args?.where?.ncShareId;
        if (id === undefined) return null;
        const row = shareStore.get(id);
        return row ? { departmentId: row.departmentId, createdById: row.createdById } : null;
      }),
      findMany: vi.fn(async (args?: { where?: { createdById?: string; revokedAt?: null } }) => {
        const createdById = args?.where?.createdById;
        return [...shareStore.values()]
          .filter((s) => (createdById === undefined || s.createdById === createdById) && s.revokedAt === null)
          .map((s) => ({ ncShareId: s.ncShareId }));
      }),
      create: vi.fn(async (args: { data: ShareRow }) => {
        shareStore.set(args.data.ncShareId, { ...args.data, revokedAt: null });
        return args.data;
      }),
      update: vi.fn(async (args: { where: { ncShareId: number }; data: { revokedAt: Date } }) => {
        const row = shareStore.get(args.where.ncShareId);
        if (row) shareStore.set(args.where.ncShareId, { ...row, revokedAt: args.data.revokedAt });
        return row;
      }),
    },
    __shareStore: shareStore,
  };
}

function buildApp(prisma: ReturnType<typeof makePrismaStub>, asUser: { id: string; username: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createFilesRouter(prisma as never));
  return app;
}

const DEPT_A: DeptRow = { id: "11111111-1111-4111-8111-111111111111", name: "Alpha", parentId: null, kind: "DEPARTMENT", state: "active" };
const DEPT_B: DeptRow = { id: "22222222-2222-4222-8222-222222222222", name: "Beta", parentId: null, kind: "DEPARTMENT", state: "active" };

const MANAGER_A = { id: "u-manager-a", username: "manager-a", role: "family" };
const CONTRIB_A = { id: "u-contrib-a", username: "contrib-a", role: "family" };
const OTHER_MANAGER = { id: "u-other-manager", username: "other-manager", role: "family" };
const NO_MEMBER = { id: "u-no-member", username: "no-member", role: "family" };
const OWNER = { id: "u-owner", username: "dev", role: "owner" };

function baseMemberships() {
  return [
    { departmentId: DEPT_A.id, userId: MANAGER_A.id, right: "manager" },
    { departmentId: DEPT_A.id, userId: CONTRIB_A.id, right: "contributor" },
    { departmentId: DEPT_B.id, userId: OTHER_MANAGER.id, right: "manager" },
  ];
}

beforeEach(() => {
  for (const key of Object.keys(ncMock)) {
    const fn = (ncMock as any)[key];
    if (typeof fn?.mockReset === "function") fn.mockReset();
  }
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
  recordActivityMock.mockClear();
});

describe("WARP-1269 (T17) — POST /files/share on a dept space", () => {
  it("manager on the dept: mints with the ADMIN credential + writes a DepartmentShare row", async () => {
    const prisma = makePrismaStub({ departments: [DEPT_A], memberships: baseMemberships() });
    ncMock.ncCreateShareV2.mockResolvedValue({
      id: 101,
      url: null,
      token: null,
      shareType: 3,
      permissions: 1,
      path: "/Alpha/Reports",
      expireDate: null,
      hasPassword: false,
      note: null,
      shareWith: null,
      shareWithDisplayName: null,
      uidOwner: "admin",
      ownerDisplayName: "admin",
      stime: 1712860391,
    });
    const app = buildApp(prisma, MANAGER_A);

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/Reports", space: `dept:${DEPT_A.id}` });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(101);
    expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
      expect.stringMatching(/^basic:/),
      "/Alpha/Reports",
      expect.objectContaining({ shareType: 3 }),
    );
    expect(prisma.departmentShare.create).toHaveBeenCalledWith({
      data: {
        departmentId: DEPT_A.id,
        ncShareId: 101,
        createdById: MANAGER_A.id,
        shareType: 3,
        path: "/Reports",
      },
    });
  });

  it("contributor (non-manager) on the dept: 403 before any OCS call", async () => {
    const prisma = makePrismaStub({ departments: [DEPT_A], memberships: baseMemberships() });
    const app = buildApp(prisma, CONTRIB_A);

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/Reports", space: `dept:${DEPT_A.id}` });

    expect(res.status).toBe(403);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
    expect(prisma.departmentShare.create).not.toHaveBeenCalled();
  });

  it("non-member (family) on the dept: 403 before any OCS call", async () => {
    const prisma = makePrismaStub({ departments: [DEPT_A], memberships: baseMemberships() });
    const app = buildApp(prisma, NO_MEMBER);

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/Reports", space: `dept:${DEPT_A.id}` });

    expect(res.status).toBe(403);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
    expect(prisma.departmentShare.create).not.toHaveBeenCalled();
  });

  it("OCS failure: no DepartmentShare row written, error surfaced honestly", async () => {
    const prisma = makePrismaStub({ departments: [DEPT_A], memberships: baseMemberships() });
    const { NextcloudOcsError } = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
      "../services/nextcloud.client.js",
    );
    ncMock.ncCreateShareV2.mockRejectedValue(new NextcloudOcsError("share denied", 403));
    const app = buildApp(prisma, MANAGER_A);

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/Reports", space: `dept:${DEPT_A.id}` });

    expect(res.status).toBe(403);
    expect(prisma.departmentShare.create).not.toHaveBeenCalled();
  });

  it("personal share path is untouched: caller's own token, no DepartmentShare row", async () => {
    const prisma = makePrismaStub({ departments: [DEPT_A], memberships: baseMemberships() });
    ncMock.ncCreateShareV2.mockResolvedValue({
      id: 5,
      url: "https://nextcloud/s/abc",
      token: "abc",
      shareType: 3,
      permissions: 1,
      path: "/a.txt",
      expireDate: null,
      hasPassword: false,
      note: null,
      shareWith: null,
      shareWithDisplayName: null,
      uidOwner: "dev",
      ownerDisplayName: "Developer",
      stime: 1712860391,
    });
    const app = buildApp(prisma, OWNER);

    const res = await request(app).post("/api/files/share").send({ path: "/a.txt" });

    expect(res.status).toBe(200);
    expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
      "session-token",
      "/a.txt",
      expect.objectContaining({ shareType: 3 }),
    );
    expect(prisma.departmentShare.create).not.toHaveBeenCalled();
  });

  it("path traversal ('..') is rejected before OCS is ever called", async () => {
    const prisma = makePrismaStub({ departments: [DEPT_A], memberships: baseMemberships() });
    const app = buildApp(prisma, MANAGER_A);

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/../secret", space: `dept:${DEPT_A.id}` });

    expect(res.status).toBe(400);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });
});

describe("WARP-1269 (T17) — PUT/DELETE /files/share/:id authz matrix", () => {
  function seededPrisma() {
    return makePrismaStub({
      departments: [DEPT_A, DEPT_B],
      memberships: baseMemberships(),
      shares: [
        {
          departmentId: DEPT_A.id,
          ncShareId: 101,
          createdById: MANAGER_A.id,
          shareType: 3,
          path: "/Reports",
          revokedAt: null,
        },
      ],
    });
  }

  it("creator (the manager who minted it) can update — admin credential used", async () => {
    const prisma = seededPrisma();
    ncMock.ncUpdateShare.mockResolvedValue(undefined);
    const app = buildApp(prisma, MANAGER_A);

    const res = await request(app).put("/api/files/share/101").send({ note: "updated" });

    expect(res.status).toBe(200);
    expect(ncMock.ncUpdateShare).toHaveBeenCalledWith(
      expect.stringMatching(/^basic:/),
      101,
      "note",
      "updated",
    );
  });

  it("another manager of the SAME department can update/revoke", async () => {
    const prisma = seededPrisma();
    // Give a second manager on dept A.
    prisma.departmentMembership.findUnique = vi.fn(async (args: any) => {
      const key = args?.where?.departmentId_userId;
      if (key?.departmentId === DEPT_A.id && key.userId === "u-second-manager") {
        return { right: "manager" };
      }
      if (key?.departmentId === DEPT_A.id && key.userId === MANAGER_A.id) {
        return { right: "manager" };
      }
      return null;
    });
    const secondManager = { id: "u-second-manager", username: "second-manager", role: "family" };
    ncMock.ncDeleteShare.mockResolvedValue(undefined);
    const app = buildApp(prisma, secondManager);

    const res = await request(app).delete("/api/files/share/101");

    expect(res.status).toBe(200);
    expect(ncMock.ncDeleteShare).toHaveBeenCalledWith(expect.stringMatching(/^basic:/), 101);
    const row = (prisma as any).__shareStore.get(101);
    expect(row.revokedAt).not.toBeNull();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: "Share revoked" }),
    );
  });

  it("manager of an UNRELATED department is denied (403, no OCS call)", async () => {
    const prisma = seededPrisma();
    const app = buildApp(prisma, OTHER_MANAGER);

    const res = await request(app).delete("/api/files/share/101");

    expect(res.status).toBe(403);
    expect(ncMock.ncDeleteShare).not.toHaveBeenCalled();
    const row = (prisma as any).__shareStore.get(101);
    expect(row.revokedAt).toBeNull();
  });

  it("unrelated family member (no membership at all) is denied (403, no OCS call)", async () => {
    const prisma = seededPrisma();
    const app = buildApp(prisma, NO_MEMBER);

    const res = await request(app).put("/api/files/share/101").send({ note: "x" });

    expect(res.status).toBe(403);
    expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
  });

  it("owner/admin can always update/revoke regardless of membership", async () => {
    const prisma = seededPrisma();
    ncMock.ncDeleteShare.mockResolvedValue(undefined);
    const app = buildApp(prisma, OWNER);

    const res = await request(app).delete("/api/files/share/101");

    expect(res.status).toBe(200);
    expect(ncMock.ncDeleteShare).toHaveBeenCalledWith(expect.stringMatching(/^basic:/), 101);
  });

  it("a shareId with NO DepartmentShare row is a personal share — unchanged behavior", async () => {
    const prisma = makePrismaStub({ departments: [DEPT_A], memberships: baseMemberships() });
    ncMock.ncUpdateShare.mockResolvedValue(undefined);
    const app = buildApp(prisma, OWNER);

    const res = await request(app).put("/api/files/share/999").send({ note: "hi" });

    expect(res.status).toBe(200);
    expect(ncMock.ncUpdateShare).toHaveBeenCalledWith("session-token", 999, "note", "hi");
  });

  it("response payload never contains the admin credential", async () => {
    const prisma = seededPrisma();
    ncMock.ncUpdateShare.mockResolvedValue(undefined);
    const app = buildApp(prisma, MANAGER_A);

    const res = await request(app).put("/api/files/share/101").send({ note: "updated" });

    expect(JSON.stringify(res.body)).not.toMatch(/basic:/);
    expect(JSON.stringify(res.body)).not.toMatch(/YWRtaW4/); // base64("admin:...") prefix
  });
});

describe("WARP-1269 (T17) — GET /files/shared-by-me", () => {
  it("merges the caller's personal OCS shares with their non-revoked DepartmentShare rows", async () => {
    const prisma = makePrismaStub({
      departments: [DEPT_A],
      memberships: baseMemberships(),
      shares: [
        {
          departmentId: DEPT_A.id,
          ncShareId: 101,
          createdById: MANAGER_A.id,
          shareType: 3,
          path: "/Reports",
          revokedAt: null,
        },
        {
          departmentId: DEPT_A.id,
          ncShareId: 102,
          createdById: MANAGER_A.id,
          shareType: 3,
          path: "/Old",
          revokedAt: new Date(),
        },
      ],
    });
    ncMock.ncListMyShares.mockResolvedValue([
      { id: 5, url: null, token: null, shareType: 3, permissions: 1, path: "/a.txt", expireDate: null, hasPassword: false, note: null, shareWith: null, shareWithDisplayName: null, uidOwner: "manager-a", ownerDisplayName: null, stime: 1 },
    ]);
    ncMock.ncGetShare.mockImplementation(async (_token: string, id: number) =>
      id === 101
        ? { id: 101, url: null, token: null, shareType: 3, permissions: 1, path: "/Alpha/Reports", expireDate: null, hasPassword: false, note: null, shareWith: null, shareWithDisplayName: null, uidOwner: "admin", ownerDisplayName: null, stime: 2 }
        : null,
    );
    const app = buildApp(prisma, MANAGER_A);

    const res = await request(app).get("/api/files/shared-by-me");

    expect(res.status).toBe(200);
    expect(res.body.shares).toHaveLength(2);
    expect(res.body.shares.map((s: any) => s.id).sort((a: number, b: number) => a - b)).toEqual([5, 101]);
    // The revoked row (102) was never queried against OCS.
    expect(ncMock.ncGetShare).not.toHaveBeenCalledWith(expect.any(String), 102);
    // ncGetShare uses the admin credential.
    expect(ncMock.ncGetShare).toHaveBeenCalledWith(expect.stringMatching(/^basic:/), 101);
  });
});
