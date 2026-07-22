/**
 * WARP-1258 (T6) — departments CRUD route tests.
 *
 * Happy path: create department, create team under department, update, archive.
 * Validations: reserved names, duplicates, hierarchy constraints.
 * RBAC: owner+admin allowed, family/guest/service 403.
 * Archive semantics: state=archiving + kick reconciler.
 * Team constraints: teams nest one level deep (team-under-team → 400).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

// ── Config mock ──
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_VOICE: "test-voice-token-32chars-padding-xyz",
    SERVICE_TOKEN_MCP: "test-mcp-token-32chars-padding-1234a",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

// Mock the reconciler kick
vi.mock("../services/department-reconciler.service.js", () => ({
  kickReconcile: vi.fn(),
}));

// Mock the NC groups client
vi.mock("../services/nextcloud-groups.client.js", () => ({
  gfListFolders: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:dGVzdDp0ZXN0"),
}));

import { type AuthUser } from "../middleware/auth.js";
import type { Role } from "../services/jwt.service.js";
import { createDepartmentsRouter } from "../routes/departments.js";

// ── Test fixtures ──────────────────────────────────────────────────

function buildDeptApp(
  prisma: PrismaClient,
  user: AuthUser | null,
): express.Express {
  const app = express();
  app.use(express.json());

  // Synthetic auth middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });

  app.use("/api", createDepartmentsRouter(prisma));
  return app;
}

function mkUser(role: Role, id = `user-${role}`): AuthUser {
  return {
    id,
    username: `${role}-user`,
    displayName: `${role} User`,
    role,
  };
}

/**
 * Build a mock kind=HOUSEHOLD department row (mirrors the seed shape from
 * WARP-1263). Household membership AND rights are immutable across all three
 * verbs — see the HOUSEHOLD guards in routes/departments.ts (WARP-1263 PATCH,
 * WARP-1295 POST/DELETE).
 */
function mkHouseholdDept() {
  return {
    id: "household-1",
    name: "Household",
    slug: "household",
    kind: "HOUSEHOLD",
    parentId: null,
    state: "active",
    quotaBytes: null,
    ncGroupRw: "household",
    ncGroupRo: null,
    ncGroupfolderId: 1,
    description: "Legacy household",
    createdBy: "system",
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    aclVersion: 0,
    provisionError: null,
    syncError: null,
  };
}

/**
 * Helper to create a mock Prisma client for testing.
 * Tracks created departments and teams in memory.
 */
function createMockPrisma(): PrismaClient & {
  _departments: Map<string, any>;
  _memberships: Map<string, any>;
} {
  const departments = new Map<string, any>();
  const memberships = new Map<string, any>();
  let nextId = 1;
  let nextMemberId = 1;

  const mockPrisma = {
    _departments: departments,
    _memberships: memberships,

    department: {
      findMany: vi.fn(async (query?: any) => {
        const depts = Array.from(departments.values());
        if (query?.where?.state?.not === "archived") {
          return depts.filter((d) => d.state !== "archived");
        }
        return depts;
      }),

      findUnique: vi.fn(async (query: any) => {
        const dept = departments.get(query.where.id);
        if (query.include?._count) {
          return {
            ...dept,
            _count: {
              memberships: Array.from(memberships.values()).filter(
                (m) => m.departmentId === query.where.id,
              ).length,
              teams: Array.from(departments.values()).filter(
                (d) => d.parentId === query.where.id && d.kind === "TEAM",
              ).length,
            },
          };
        }
        if (query.include?.memberships) {
          return {
            ...dept,
            memberships: Array.from(memberships.values()).filter(
              (m) => m.departmentId === query.where.id,
            ),
          };
        }
        if (query.include?.teams) {
          return {
            ...dept,
            teams: Array.from(departments.values()).filter(
              (d) => d.parentId === query.where.id && d.kind === "TEAM",
            ),
          };
        }
        return dept;
      }),

      findFirst: vi.fn(async (query: any) => {
        for (const dept of departments.values()) {
          if (query.where.OR) {
            // OR condition — match if any condition matches
            if (
              query.where.OR.some((cond: any) => {
                if (cond.name && dept.name === cond.name) return true;
                if (cond.slug && dept.slug === cond.slug) return true;
                return false;
              })
            ) {
              return dept;
            }
          } else if (query.where.parentId !== undefined && query.where.name) {
            // Team search — both parentId AND name must match
            if (
              dept.parentId === query.where.parentId &&
              dept.name === query.where.name
            ) {
              return dept;
            }
          }
        }
        return null;
      }),

      create: vi.fn(async (query: any) => {
        const dept = {
          id: `dept-${nextId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          archivedAt: null,
          ...query.data,
        };
        departments.set(dept.id, dept);
        if (query.include?._count) {
          return {
            ...dept,
            _count: {
              memberships: Array.from(memberships.values()).filter(
                (m) => m.departmentId === dept.id,
              ).length,
              teams: Array.from(departments.values()).filter(
                (d) => d.parentId === dept.id && d.kind === "TEAM",
              ).length,
            },
          };
        }
        return dept;
      }),

      update: vi.fn(async (query: any) => {
        const dept = departments.get(query.where.id);
        if (!dept) throw new Error("Not found");
        Object.assign(dept, query.data);
        dept.updatedAt = new Date();
        if (query.include?._count) {
          return {
            ...dept,
            _count: {
              memberships: Array.from(memberships.values()).filter(
                (m) => m.departmentId === query.where.id,
              ).length,
              teams: Array.from(departments.values()).filter(
                (d) => d.parentId === query.where.id && d.kind === "TEAM",
              ).length,
            },
          };
        }
        return dept;
      }),

      delete: vi.fn(async (query: any) => {
        const dept = departments.get(query.where.id);
        if (!dept) throw new Error("Not found");
        departments.delete(query.where.id);
        return dept;
      }),
    },

    departmentMembership: {
      create: vi.fn(async (query: any) => {
        const mem = {
          id: `mem-${nextMemberId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...query.data,
        };
        memberships.set(mem.id, mem);
        return mem;
      }),

      deleteMany: vi.fn(async () => ({ count: 0 })),

      // WARP-1270 (T18): the GET /api/departments list route now reads the
      // caller's own memberships (myRight + non-admin scoping). Filters on
      // whatever subset of {userId, departmentId} the caller's `where`
      // supplies — every call site in departments.ts uses one or the other.
      findMany: vi.fn(async (query?: any) => {
        let results = Array.from(memberships.values());
        if (query?.where?.userId) {
          results = results.filter((m) => m.userId === query.where.userId);
        }
        if (query?.where?.departmentId) {
          results = results.filter((m) => m.departmentId === query.where.departmentId);
        }
        return results;
      }),
    },

    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
      // Run the transaction function, then when it returns, add the _count fields
      const result = await fn(mockPrisma);
      // If it's a department with _count requested, recalculate it
      if (result && result.id && departments.has(result.id)) {
        const dept = departments.get(result.id);
        if (!result._count) {
          result._count = {
            memberships: Array.from(memberships.values()).filter(
              (m) => m.departmentId === result.id,
            ).length,
            teams: Array.from(departments.values()).filter(
              (d) => d.parentId === result.id && d.kind === "TEAM",
            ).length,
          };
        }
      }
      return result;
    }),
  } as any as PrismaClient & {
    _departments: Map<string, any>;
    _memberships: Map<string, any>;
  };

  return mockPrisma;
}

describe("departments CRUD routes (WARP-1258)", () => {
  let prisma: PrismaClient & {
    _departments: Map<string, any>;
    _memberships: Map<string, any>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
  });

  describe("GET /api/departments", () => {
    it("returns empty list initially", async () => {
      const app = buildDeptApp(prisma, mkUser("owner"));
      const res = await request(app).get("/api/departments");

      expect(res.status).toBe(200);
      expect(res.body.departments).toEqual([]);
    });

    it("lists created departments (non-archived)", async () => {
      const owner = mkUser("owner", "owner-id");
      const app = buildDeptApp(prisma, owner);

      // Create a department
      const createRes = await request(app)
        .post("/api/departments")
        .send({ name: "Sales" });

      expect(createRes.status).toBe(201);
      const deptId = createRes.body.department.id;

      // List should include it
      const listRes = await request(app).get("/api/departments");
      expect(listRes.status).toBe(200);
      expect(listRes.body.departments).toHaveLength(1);
      expect(listRes.body.departments[0].name).toBe("Sales");
      expect(listRes.body.departments[0].id).toBe(deptId);
    });
  });

  describe("POST /api/departments", () => {
    it("happy path: creates a department", async () => {
      const owner = mkUser("owner", "owner-id");
      const app = buildDeptApp(prisma, owner);

      const res = await request(app)
        .post("/api/departments")
        .send({
          name: "Engineering",
          description: "Engineering team",
          quotaBytes: "1099511627776",
        });

      expect(res.status).toBe(201);
      expect(res.body.department.name).toBe("Engineering");
      expect(res.body.department.slug).toBe("engineering");
      expect(res.body.department.kind).toBe("DEPARTMENT");
      expect(res.body.department.state).toBe("pending");
      expect(res.body.department.quotaBytes).toBe("1099511627776");
      expect(res.body.department.description).toBe("Engineering team");
    });

    it("surfaces an NC mount-point warning when a matching groupfolder already exists", async () => {
      const { gfListFolders } = await import(
        "../services/nextcloud-groups.client.js"
      );
      vi.mocked(gfListFolders).mockResolvedValueOnce([
        {
          id: 1,
          mountPoint: "Design",
          groups: {},
          quota: -3,
          size: 0,
          acl: true,
        },
      ] as never);

      const owner = mkUser("owner", "owner-id-2");
      const app = buildDeptApp(prisma, owner);

      const res = await request(app)
        .post("/api/departments")
        .send({ name: "Design" });

      expect(res.status).toBe(201);
      expect(res.body.warning).toMatch(
        /mount point "Design" already exists/,
      );
    });

    it("rejects reserved name", async () => {
      const app = buildDeptApp(prisma, mkUser("owner"));

      const res = await request(app)
        .post("/api/departments")
        .send({ name: "Household" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("RESERVED_NAME");
    });

    it("rejects duplicate name", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      const res1 = await request(app)
        .post("/api/departments")
        .send({ name: "Marketing" });
      expect(res1.status).toBe(201);

      const res2 = await request(app)
        .post("/api/departments")
        .send({ name: "Marketing" });

      expect(res2.status).toBe(400);
      expect(res2.body.code).toBe("DUPLICATE_NAME");
    });

    it("rejects family/guest/service", async () => {
      for (const role of ["family" as Role, "guest" as Role, "service" as Role]) {
        const app = buildDeptApp(prisma, mkUser(role));
        const res = await request(app)
          .post("/api/departments")
          .send({ name: "Dept" });
        expect(res.status).toBe(403);
      }
    });
  });

  describe("POST /api/departments/:id/teams", () => {
    it("happy path: creates a team under a department", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      const deptRes = await request(app)
        .post("/api/departments")
        .send({ name: "Engineering" });
      const deptId = deptRes.body.department.id;

      // Activate the department (required before creating teams)
      prisma._departments.get(deptId).state = "active";

      const teamRes = await request(app)
        .post(`/api/departments/${deptId}/teams`)
        .send({ name: "Backend" });

      expect(teamRes.status).toBe(201);
      expect(teamRes.body.team?.name).toBe("Backend");
      expect(teamRes.body.team?.slug).toBe("engineering-backend");
      expect(teamRes.body.team?.kind).toBe("TEAM");
      expect(teamRes.body.team?.parentId).toBe(deptId);
    });

    it("rejects team-under-team", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      const deptRes = await request(app)
        .post("/api/departments")
        .send({ name: "Dept" });
      const deptId = deptRes.body.department.id;
      prisma._departments.get(deptId).state = "active";

      const team1Res = await request(app)
        .post(`/api/departments/${deptId}/teams`)
        .send({ name: "Team1" });
      const team1Id = team1Res.body.team.id;

      const res = await request(app)
        .post(`/api/departments/${team1Id}/teams`)
        .send({ name: "Team2" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_PARENT_KIND");
    });

    it("rejects team creation on pending department", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      const deptRes = await request(app)
        .post("/api/departments")
        .send({ name: "Dept" });

      const res = await request(app)
        .post(`/api/departments/${deptRes.body.department.id}/teams`)
        .send({ name: "Team" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("PARENT_NOT_ACTIVE");
    });

    it("rejects family/guest/service", async () => {
      const ownerApp = buildDeptApp(prisma, mkUser("owner"));
      const deptRes = await request(ownerApp)
        .post("/api/departments")
        .send({ name: "Dept" });
      prisma._departments.get(deptRes.body.department.id).state = "active";

      for (const role of ["family" as Role, "guest" as Role, "service" as Role]) {
        const app = buildDeptApp(prisma, mkUser(role));
        const res = await request(app)
          .post(`/api/departments/${deptRes.body.department.id}/teams`)
          .send({ name: "Team" });
        expect(res.status).toBe(403);
      }
    });
  });

  describe("PATCH /api/departments/:id", () => {
    it("happy path: updates description", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      const deptRes = await request(app)
        .post("/api/departments")
        .send({ name: "Sales" });
      const deptId = deptRes.body.department.id;

      const patchRes = await request(app)
        .patch(`/api/departments/${deptId}`)
        .send({ description: "Updated" });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.department.description).toBe("Updated");
    });

    it("rejects rename attempts", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      const deptRes = await request(app)
        .post("/api/departments")
        .send({ name: "Sales" });

      const patchRes = await request(app)
        .patch(`/api/departments/${deptRes.body.department.id}`)
        .send({ name: "NewName" });

      expect(patchRes.status).toBe(400);
      expect(patchRes.body.code).toBe("RENAME_NOT_SUPPORTED");
    });

    it("rejects family/guest/service", async () => {
      const ownerApp = buildDeptApp(prisma, mkUser("owner"));
      const deptRes = await request(ownerApp)
        .post("/api/departments")
        .send({ name: "Dept" });

      for (const role of ["family" as Role, "guest" as Role, "service" as Role]) {
        const app = buildDeptApp(prisma, mkUser(role));
        const res = await request(app)
          .patch(`/api/departments/${deptRes.body.department.id}`)
          .send({ description: "new" });
        expect(res.status).toBe(403);
      }
    });
  });

  describe("DELETE /api/departments/:id", () => {
    it("happy path: archives a department", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      const deptRes = await request(app)
        .post("/api/departments")
        .send({ name: "Sales" });
      const deptId = deptRes.body.department.id;

      const deleteRes = await request(app).delete(
        `/api/departments/${deptId}`,
      );

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.department.state).toBe("archiving");
      expect(deleteRes.body.department.archivedAt).toBeDefined();
    });

    it("rejects deletion of DEPARTMENT with active teams", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      const deptRes = await request(app)
        .post("/api/departments")
        .send({ name: "Dept" });
      const deptId = deptRes.body.department.id;
      prisma._departments.get(deptId).state = "active";

      const teamRes = await request(app)
        .post(`/api/departments/${deptId}/teams`)
        .send({ name: "Team" });
      expect(teamRes.status).toBe(201);

      const deleteRes = await request(app).delete(
        `/api/departments/${deptId}`,
      );

      expect(deleteRes.status).toBe(409);
      expect(deleteRes.body.code).toBe("DEPARTMENT_HAS_TEAMS");
    });

    it("rejects family/guest/service", async () => {
      const ownerApp = buildDeptApp(prisma, mkUser("owner"));
      const deptRes = await request(ownerApp)
        .post("/api/departments")
        .send({ name: "Dept" });

      for (const role of ["family" as Role, "guest" as Role, "service" as Role]) {
        const app = buildDeptApp(prisma, mkUser(role));
        const res = await request(app).delete(
          `/api/departments/${deptRes.body.department.id}`,
        );
        expect(res.status).toBe(403);
      }
    });
  });

  describe("PATCH /api/departments/:id/members/:userId — HOUSEHOLD guard", () => {
    it("rejects right changes on HOUSEHOLD department (WARP-1263)", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      // Create a mock HOUSEHOLD department
      const householdDept = {
        id: "household-1",
        name: "Household",
        slug: "household",
        kind: "HOUSEHOLD",
        parentId: null,
        state: "active",
        quotaBytes: null,
        ncGroupRw: "household",
        ncGroupRo: null,
        ncGroupfolderId: 1,
        description: "Legacy household",
        createdBy: "system",
        createdAt: new Date(),
        updatedAt: new Date(),
        archivedAt: null,
        aclVersion: 0,
        provisionError: null,
        syncError: null,
      };
      prisma._departments.set(householdDept.id, householdDept);

      // Add owner as a member of household
      prisma._memberships.set("household-owner-1", {
        id: "household-owner-1",
        departmentId: householdDept.id,
        userId: owner.id,
        right: "manager",
        syncState: "synced",
        ncPermissionMask: 31,
        grantedBy: "system",
        grantedAt: new Date(),
        updatedAt: new Date(),
      });

      // Add another user as contributor
      const memberId = "household-family-1";
      prisma._memberships.set(memberId, {
        id: memberId,
        departmentId: householdDept.id,
        userId: "family-user",
        right: "contributor",
        syncState: "synced",
        ncPermissionMask: 31,
        grantedBy: "system",
        grantedAt: new Date(),
        updatedAt: new Date(),
      });

      // Attempt to change the family user's right to reader
      const patchRes = await request(app)
        .patch(`/api/departments/${householdDept.id}/members/family-user`)
        .send({ right: "reader" });

      expect(patchRes.status).toBe(400);
      expect(patchRes.body.code).toBe("HOUSEHOLD_RIGHTS_IMMUTABLE");
      expect(patchRes.body.error).toContain(
        "Cannot change member rights for the Household department"
      );

      // Verify the membership was not changed
      const membership = prisma._memberships.get(memberId);
      expect(membership.right).toBe("contributor");
    });
  });

  describe("POST /api/departments/:id/members — HOUSEHOLD guard (WARP-1295)", () => {
    it("rejects adding a member to a HOUSEHOLD department", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      const householdDept = mkHouseholdDept();
      prisma._departments.set(householdDept.id, householdDept);

      const membershipsBefore = prisma._memberships.size;

      const res = await request(app)
        .post(`/api/departments/${householdDept.id}/members`)
        .send({
          userId: "11111111-1111-1111-1111-111111111111",
          right: "contributor",
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("HOUSEHOLD_MEMBERSHIP_IMMUTABLE");
      expect(res.body.error).toContain("Household");

      // No membership row was created — the delete-then-re-add bypass of the
      // WARP-1263 immutability invariant is closed.
      expect(prisma._memberships.size).toBe(membershipsBefore);
    });
  });

  describe("DELETE /api/departments/:id/members/:userId — HOUSEHOLD guard (WARP-1295)", () => {
    it("rejects removing a member from a HOUSEHOLD department", async () => {
      const owner = mkUser("owner");
      const app = buildDeptApp(prisma, owner);

      const householdDept = mkHouseholdDept();
      prisma._departments.set(householdDept.id, householdDept);

      // A role-driven household membership (seeded, syncState=synced).
      const memberId = "household-family-1";
      prisma._memberships.set(memberId, {
        id: memberId,
        departmentId: householdDept.id,
        userId: "family-user",
        right: "contributor",
        syncState: "synced",
        ncPermissionMask: 31,
        grantedBy: "system",
        grantedAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await request(app).delete(
        `/api/departments/${householdDept.id}/members/family-user`,
      );

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("HOUSEHOLD_MEMBERSHIP_IMMUTABLE");
      expect(res.body.error).toContain("Household");

      // The membership was not removed.
      expect(prisma._memberships.get(memberId)).toBeDefined();
    });
  });
});
