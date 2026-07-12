/**
 * WARP-1258 — reserved-name guard vs a non-default DROPLET_SHARED_FOLDER_NAME.
 *
 * Regression guard for the RESERVED_NAMES collision bug: the configured
 * shared-folder name must be inserted into RESERVED_NAMES in the SAME
 * normalized forms the check uses (lowercased display name + lowercase-dash
 * slug). Otherwise a deployment with a mixed-case / multi-word
 * DROPLET_SHARED_FOLDER_NAME (e.g. "Family Drive") stores the literal
 * "Family Drive" in the set while the check produces "family drive" /
 * "family-drive" — no match — and a department whose NC groupfolder mount
 * point collides with the real shared folder is wrongly accepted.
 *
 * This file mocks the config with a non-default value so RESERVED_NAMES is
 * built from "Family Drive" at module-load time (unlike departments.test.ts,
 * which uses the default "Household").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

// ── Config mock: NON-default, mixed-case, multi-word shared-folder name ──
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_VOICE: "test-voice-token-32chars-padding-xyz",
    SERVICE_TOKEN_MCP: "test-mcp-token-32chars-padding-1234a",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DROPLET_SHARED_FOLDER_NAME: "Family Drive",
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/department-reconciler.service.js", () => ({
  kickReconcile: vi.fn(),
}));

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

function buildDeptApp(prisma: PrismaClient, user: AuthUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createDepartmentsRouter(prisma));
  return app;
}

function mkOwner(): AuthUser {
  return {
    id: "owner-id",
    username: "owner-user",
    displayName: "Owner User",
    role: "owner" as Role,
  };
}

/**
 * Compact in-memory Prisma stub. The reserved-name check returns before any
 * Prisma call, so the rejection cases never touch the create path; the
 * create-path methods exist only for the "non-reserved name still creates"
 * control case. `setParent` seeds the row returned by `findUnique` so the team
 * route can reach its own reserved-name check with an active parent.
 */
function mkStubPrisma(): {
  prisma: PrismaClient;
  setParent: (row: Record<string, unknown> | null) => void;
} {
  let nextId = 1;
  let parentRow: Record<string, unknown> | null = null;
  const depts = new Map<string, Record<string, unknown>>();
  const p = {
    department: {
      findUnique: vi.fn(async () => parentRow),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (q: { data: Record<string, unknown> }) => {
        const d = {
          id: `dept-${nextId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          archivedAt: null,
          aclVersion: 0,
          quotaBytes: null,
          ...q.data,
          _count: { memberships: 0, teams: 0 },
        };
        depts.set(d.id as string, d);
        return d;
      }),
      update: vi.fn(async (q: { where: { id: string }; data: Record<string, unknown> }) => {
        const d = depts.get(q.where.id) ?? {};
        Object.assign(d, q.data);
        return d;
      }),
    },
    departmentMembership: {
      create: vi.fn(async (q: { data: Record<string, unknown> }) => ({
        id: "mem-1",
        ...q.data,
      })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(p)),
  } as unknown as PrismaClient;
  return {
    prisma: p,
    setParent: (row) => {
      parentRow = row;
    },
  };
}

describe("departments reserved-name guard with non-default DROPLET_SHARED_FOLDER_NAME", () => {
  let prisma: PrismaClient;
  let setParent: (row: Record<string, unknown> | null) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ prisma, setParent } = mkStubPrisma());
  });

  // Every casing/spacing of the configured shared-folder name — and its slug
  // form — must be rejected, because each maps to the same NC mount point.
  const reservedVariants = [
    "Family Drive", // exact configured value
    "family drive", // lowercased (matches name.toLowerCase() path)
    "FAMILY DRIVE", // upper-cased
    "family-drive", // slug form (matches slug path)
  ];

  for (const name of reservedVariants) {
    it(`rejects "${name}" as RESERVED_NAME`, async () => {
      const app = buildDeptApp(prisma, mkOwner());
      const res = await request(app).post("/api/departments").send({ name });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("RESERVED_NAME");
    });

    it(`rejects "${name}" as a team name too`, async () => {
      // Stand up an active parent department to hang the team off of.
      setParent({
        id: "parent-1",
        name: "Engineering",
        slug: "engineering",
        kind: "DEPARTMENT",
        state: "active",
      });

      const app = buildDeptApp(prisma, mkOwner());
      const res = await request(app)
        .post("/api/departments/parent-1/teams")
        .send({ name });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("RESERVED_NAME");
    });
  }

  it("still accepts a non-reserved department name (guard is not over-broad)", async () => {
    const app = buildDeptApp(prisma, mkOwner());
    const res = await request(app)
      .post("/api/departments")
      .send({ name: "Engineering" });

    expect(res.status).toBe(201);
    expect(res.body.department.name).toBe("Engineering");
    expect(res.body.department.slug).toBe("engineering");
  });
});
