/**
 * WARP-1270 (T18) — route-level tests for the additions this ticket makes
 * to routes/departments.ts: `myRight` + admin-visible-archived scoping on
 * the list route, the new GET /api/departments/:id detail route, and the
 * new POST /api/departments/:id/restore route.
 *
 * The pre-existing CRUD routes (create/update/archive/membership writes)
 * already have coverage elsewhere in the ADR-029 test suite (WARP-1274)
 * and service-level tests (department-membership.service.test.ts); this
 * file only covers the NEW surface. Prisma is a lightweight hand-rolled
 * mock (mirrors admin-files.test.ts's `mkUsagePrisma` pattern) — no real
 * DB, no real Nextcloud.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { gfListFoldersMock, kickReconcileMock, recordActivityMock } = vi.hoisted(() => ({
  gfListFoldersMock: vi.fn(),
  kickReconcileMock: vi.fn(),
  recordActivityMock: vi.fn(),
}));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  gfListFolders: gfListFoldersMock,
}));
vi.mock("../services/department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:dGVzdDp0ZXN0"),
}));
vi.mock("../services/department-reconciler.service.js", () => ({
  kickReconcile: kickReconcileMock,
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));
vi.mock("../services/activity.service.js", () => ({
  actorFromRequest: vi.fn(() => ({ type: "user", id: "caller" })),
}));
vi.mock("../services/department-validation.js", () => ({
  validateDepartmentHierarchy: vi.fn(),
}));

import { createDepartmentsRouter } from "./departments.js";

function mkPrisma(overrides: Record<string, any> = {}) {
  const self: any = {
    department: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      create: vi.fn(),
    },
    departmentMembership: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  };
  self.$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(self));
  return self;
}

function mkApp(prisma: ReturnType<typeof mkPrisma>, user: { id: string; role?: string; username?: string } | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use("/api", createDepartmentsRouter(prisma));
  return app;
}

const DEPT_ROW = {
  id: "d1",
  name: "Finance",
  slug: "finance",
  kind: "DEPARTMENT",
  parentId: null,
  description: null,
  state: "active",
  quotaBytes: null,
  aclVersion: 1,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  archivedAt: null,
  ncGroupfolderId: 7,
  _count: { memberships: 2, teams: 0 },
};

beforeEach(() => {
  gfListFoldersMock.mockReset();
  kickReconcileMock.mockReset();
  recordActivityMock.mockReset();
});

describe("GET /api/departments — myRight + admin-visible-archived scoping", () => {
  it("owner sees archived rows and an unfiltered findMany (no state/id restriction)", async () => {
    const archived = { ...DEPT_ROW, id: "d2", state: "archived" };
    const prisma = mkPrisma();
    prisma.department.findMany.mockResolvedValue([DEPT_ROW, archived]);
    prisma.departmentMembership.findMany.mockResolvedValue([
      { departmentId: "d1", right: "manager" },
    ]);
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkApp(prisma, { id: "owner-1", role: "owner" });

    const res = await request(app).get("/api/departments");
    expect(res.status).toBe(200);
    expect(res.body.departments).toHaveLength(2);
    expect(res.body.departments.find((d: any) => d.id === "d1").myRight).toBe("manager");
    expect(res.body.departments.find((d: any) => d.id === "d2").state).toBe("archived");
    // Owner/admin: no state filter, no id-in scoping.
    const whereArg = prisma.department.findMany.mock.calls[0][0].where;
    expect(whereArg).toEqual({});
  });

  it("attaches usedBytes from one batch groupfolder lookup, never fabricated on a miss", async () => {
    const noFolder = { ...DEPT_ROW, id: "d3", ncGroupfolderId: null };
    const prisma = mkPrisma();
    prisma.department.findMany.mockResolvedValue([DEPT_ROW, noFolder]);
    prisma.departmentMembership.findMany.mockResolvedValue([]);
    gfListFoldersMock.mockResolvedValue([
      { id: 7, mountPoint: "Finance", groups: {}, quota: -3, size: 14_179_869_184, acl: true, manage: [] },
    ]);
    const app = mkApp(prisma, { id: "owner-1", role: "owner" });

    const res = await request(app).get("/api/departments");
    expect(res.status).toBe(200);
    expect(res.body.departments.find((d: any) => d.id === "d1").usedBytes).toBe("14179869184");
    expect(res.body.departments.find((d: any) => d.id === "d3").usedBytes).toBeNull();
    expect(gfListFoldersMock).toHaveBeenCalledTimes(1);
  });

  it("a non-admin caller only sees departments they hold a membership in, archived excluded", async () => {
    const prisma = mkPrisma();
    prisma.departmentMembership.findMany.mockResolvedValue([
      { departmentId: "d1", right: "contributor" },
    ]);
    prisma.department.findMany.mockResolvedValue([DEPT_ROW]);
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkApp(prisma, { id: "u1", role: "family" });

    const res = await request(app).get("/api/departments");
    expect(res.status).toBe(200);
    expect(res.body.departments).toEqual([
      expect.objectContaining({ id: "d1", myRight: "contributor" }),
    ]);
    const whereArg = prisma.department.findMany.mock.calls[0][0].where;
    expect(whereArg).toEqual({ state: { not: "archived" }, id: { in: ["d1"] } });
  });

  it("a non-admin caller with zero memberships gets an empty list, not every department", async () => {
    const prisma = mkPrisma();
    prisma.departmentMembership.findMany.mockResolvedValue([]);
    prisma.department.findMany.mockResolvedValue([]);
    const app = mkApp(prisma, { id: "u2", role: "guest" });

    const res = await request(app).get("/api/departments");
    expect(res.status).toBe(200);
    expect(res.body.departments).toEqual([]);
    const whereArg = prisma.department.findMany.mock.calls[0][0].where;
    expect(whereArg.id).toEqual({ in: [] });
  });

  // WARP-1507: the panel's "Needs attention" badge has to be able to SAY what
  // needs attention, so the failure reason the schema already stores
  // (Department.provisionError) must be serialized read-only to the client.
  it("serializes provisionError so the UI can explain a failed department", async () => {
    const failed = {
      ...DEPT_ROW,
      id: "d9",
      state: "failed",
      provisionError: "Groupfolder create: CSRF check failed (412)",
    };
    const prisma = mkPrisma();
    prisma.department.findMany.mockResolvedValue([failed]);
    prisma.departmentMembership.findMany.mockResolvedValue([]);
    const app = mkApp(prisma, { id: "owner-1", role: "owner" });

    const res = await request(app).get("/api/departments");
    expect(res.status).toBe(200);
    expect(res.body.departments[0].provisionError).toBe(
      "Groupfolder create: CSRF check failed (412)",
    );
  });

  it("truncates a very long provisionError server-side (≤300 chars)", async () => {
    const longMsg = "x".repeat(600);
    const failed = { ...DEPT_ROW, id: "d9", state: "failed", provisionError: longMsg };
    const prisma = mkPrisma();
    prisma.department.findMany.mockResolvedValue([failed]);
    prisma.departmentMembership.findMany.mockResolvedValue([]);
    const app = mkApp(prisma, { id: "owner-1", role: "owner" });

    const res = await request(app).get("/api/departments");
    expect(res.status).toBe(200);
    expect(res.body.departments[0].provisionError.length).toBeLessThanOrEqual(300);
  });

  it("provisionError is null when the department has no failure recorded", async () => {
    const prisma = mkPrisma();
    prisma.department.findMany.mockResolvedValue([{ ...DEPT_ROW, provisionError: null }]);
    prisma.departmentMembership.findMany.mockResolvedValue([]);
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkApp(prisma, { id: "owner-1", role: "owner" });

    const res = await request(app).get("/api/departments");
    expect(res.status).toBe(200);
    expect(res.body.departments[0].provisionError).toBeNull();
  });
});

describe("GET /api/departments/:id — detail", () => {
  it("404 when the department doesn't exist", async () => {
    const prisma = mkPrisma();
    prisma.department.findUnique.mockResolvedValue(null);
    const app = mkApp(prisma, { id: "owner-1", role: "owner" });
    const res = await request(app).get("/api/departments/nope");
    expect(res.status).toBe(404);
  });

  it("403 for a caller with no membership on the unit or its parent", async () => {
    const prisma = mkPrisma();
    prisma.department.findUnique.mockResolvedValue({ ...DEPT_ROW, teams: [] });
    prisma.departmentMembership.findUnique.mockResolvedValue(null);
    const app = mkApp(prisma, { id: "u1", role: "family" });
    const res = await request(app).get("/api/departments/d1");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_A_MEMBER");
  });

  it("200 for a member, with the roster (no email) + usedBytes from the discovered groupfolder", async () => {
    const prisma = mkPrisma();
    prisma.department.findUnique.mockResolvedValue({ ...DEPT_ROW, teams: [] });
    prisma.departmentMembership.findUnique.mockResolvedValue({ right: "contributor" });
    prisma.departmentMembership.findMany.mockResolvedValue([
      {
        userId: "u1",
        right: "contributor",
        syncState: "synced",
        user: { id: "u1", displayName: "Priya Nair", username: "priya" },
      },
      {
        userId: "u2",
        right: "manager",
        syncState: "pending",
        user: { id: "u2", displayName: "", username: "dana" },
      },
    ]);
    gfListFoldersMock.mockResolvedValue([
      { id: 7, mountPoint: "Finance", groups: {}, quota: -3, size: 14_179_869_184, acl: true, manage: [] },
    ]);
    const app = mkApp(prisma, { id: "u1", role: "family" });

    const res = await request(app).get("/api/departments/d1");
    expect(res.status).toBe(200);
    expect(res.body.department).toEqual(expect.objectContaining({ id: "d1", myRight: "contributor" }));
    expect(res.body.usedBytes).toBe("14179869184");
    expect(res.body.members).toEqual([
      { userId: "u1", displayName: "Priya Nair", right: "contributor", syncState: "synced", syncError: null },
      { userId: "u2", displayName: "dana", right: "manager", syncState: "pending", syncError: null },
    ]);
    // No email anywhere in the payload — the member table doesn't need it
    // and the column is encrypted-at-rest.
    expect(JSON.stringify(res.body)).not.toMatch(/email/i);
  });

  it("serializes department.provisionError + members[].syncError so the UI can explain the failure", async () => {
    // WARP-1507: a failed department stalled by the 412 CSRF bug shows
    // "Needs attention" (provisionError) and per-member "Retrying"
    // (syncError). Both reasons the schema already stores must reach the panel.
    const prisma = mkPrisma();
    prisma.department.findUnique.mockResolvedValue({
      ...DEPT_ROW,
      state: "failed",
      provisionError: "Groupfolder create: CSRF check failed (412)",
      teams: [],
    });
    prisma.departmentMembership.findUnique.mockResolvedValue({ right: "manager" });
    prisma.departmentMembership.findMany.mockResolvedValue([
      {
        userId: "u1",
        right: "contributor",
        syncState: "failed",
        syncError: "gfAddGroup: CSRF check failed (412)",
        user: { id: "u1", displayName: "Priya Nair", username: "priya" },
      },
      {
        userId: "u2",
        right: "manager",
        syncState: "synced",
        syncError: null,
        user: { id: "u2", displayName: "Dana Lee", username: "dana" },
      },
    ]);
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkApp(prisma, { id: "owner-1", role: "owner" });

    const res = await request(app).get("/api/departments/d1");
    expect(res.status).toBe(200);
    expect(res.body.department.provisionError).toBe(
      "Groupfolder create: CSRF check failed (412)",
    );
    expect(res.body.members).toEqual([
      {
        userId: "u1",
        displayName: "Priya Nair",
        right: "contributor",
        syncState: "failed",
        syncError: "gfAddGroup: CSRF check failed (412)",
      },
      {
        userId: "u2",
        displayName: "Dana Lee",
        right: "manager",
        syncState: "synced",
        syncError: null,
      },
    ]);
  });

  it("truncates a very long member syncError server-side (≤300 chars)", async () => {
    const prisma = mkPrisma();
    prisma.department.findUnique.mockResolvedValue({ ...DEPT_ROW, teams: [] });
    prisma.departmentMembership.findUnique.mockResolvedValue({ right: "manager" });
    prisma.departmentMembership.findMany.mockResolvedValue([
      {
        userId: "u1",
        right: "contributor",
        syncState: "failed",
        syncError: "y".repeat(600),
        user: { id: "u1", displayName: "Priya Nair", username: "priya" },
      },
    ]);
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkApp(prisma, { id: "owner-1", role: "owner" });

    const res = await request(app).get("/api/departments/d1");
    expect(res.status).toBe(200);
    expect(res.body.members[0].syncError.length).toBeLessThanOrEqual(300);
  });

  it("a team member is authorized via the PARENT department's membership (inherited-manager read)", async () => {
    const team = { ...DEPT_ROW, id: "t1", kind: "TEAM", parentId: "d1", teams: [] };
    const prisma = mkPrisma();
    prisma.department.findUnique.mockResolvedValue(team);
    // No direct membership on the team itself...
    prisma.departmentMembership.findUnique.mockImplementation(({ where }: any) => {
      if (where.departmentId_userId.departmentId === "d1") {
        return Promise.resolve({ right: "manager" });
      }
      return Promise.resolve(null);
    });
    prisma.departmentMembership.findMany.mockResolvedValue([]);
    gfListFoldersMock.mockResolvedValue([]);
    const app = mkApp(prisma, { id: "mgr-1", role: "family" });

    const res = await request(app).get("/api/departments/t1");
    expect(res.status).toBe(200);
  });

  it("usedBytes is null (not fabricated) when the groupfolder read fails", async () => {
    const prisma = mkPrisma();
    prisma.department.findUnique.mockResolvedValue({ ...DEPT_ROW, teams: [] });
    prisma.departmentMembership.findUnique.mockResolvedValue({ right: "manager" });
    prisma.departmentMembership.findMany.mockResolvedValue([]);
    gfListFoldersMock.mockRejectedValue(new Error("nc down"));
    const app = mkApp(prisma, { id: "u1", role: "family" });

    const res = await request(app).get("/api/departments/d1");
    expect(res.status).toBe(200);
    expect(res.body.usedBytes).toBeNull();
  });
});

describe("POST /api/departments/:id/restore", () => {
  it("403 for a non-admin caller", async () => {
    const prisma = mkPrisma();
    const app = mkApp(prisma, { id: "u1", role: "family" });
    const res = await request(app).post("/api/departments/d1/restore");
    expect(res.status).toBe(403);
  });

  it("404 when the department doesn't exist", async () => {
    const prisma = mkPrisma();
    prisma.department.findUnique.mockResolvedValue(null);
    const app = mkApp(prisma, { id: "owner-1", role: "owner" });
    const res = await request(app).post("/api/departments/nope/restore");
    expect(res.status).toBe(404);
  });

  it("400 when the department isn't archived", async () => {
    const prisma = mkPrisma();
    prisma.department.findUnique.mockResolvedValue({ ...DEPT_ROW, state: "active" });
    const app = mkApp(prisma, { id: "owner-1", role: "owner" });
    const res = await request(app).post("/api/departments/d1/restore");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_ARCHIVED");
  });

  it("200 sets state back to pending, bumps aclVersion, and kicks the reconciler", async () => {
    const prisma = mkPrisma();
    prisma.department.findUnique.mockResolvedValue({ ...DEPT_ROW, state: "archived" });
    prisma.department.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ ...DEPT_ROW, ...data, _count: DEPT_ROW._count }),
    );
    const app = mkApp(prisma, { id: "owner-1", role: "owner", username: "owner" });

    const res = await request(app).post("/api/departments/d1/restore");
    expect(res.status).toBe(200);
    expect(res.body.department.state).toBe("pending");
    expect(res.body.department.archivedAt).toBeNull();
    // Two updates in the tx: the state flip + the aclVersion bump.
    expect(prisma.department.update).toHaveBeenCalledTimes(2);
    expect(kickReconcileMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });
});
