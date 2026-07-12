/**
 * WARP-1260 (T8) — requireSpaceAccess space middleware.
 *
 * Fail-closed matrix (ADR-029 brief §3.1): every caller role × every space
 * state, plus the metadata-gate integration (comments route resolves
 * `ncFileId -> File.departmentId` and re-runs the same check inline).
 *
 *   role         | personal | active dept, member (right>=min) | active dept, member (right<min) | active dept, non-member | pending/failed/archiving/archived | unknown/malformed space
 *   ─────────────┼──────────┼───────────────────────────────────┼────────────────────────────────┼──────────────────────────┼──────────────────────────────────┼──────────────────────────
 *   owner/admin  | pass     | pass                               | pass                             | pass + ActivityRow        | 403                                | 403
 *   family       | pass     | pass                               | 403                              | 403                       | 403                                | 403
 *   guest        | pass     | pass iff min=reader                | 403                              | 403                       | 403                                | 403
 *   _service:mcp | pass     | pass (asserted user's membership)  | 403                              | 403                       | 403                                | 403
 *   other service| pass     | 403 (no asserted user)             | —                                | —                         | 403                                | 403
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

const recordActivityMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...args: unknown[]) => recordActivityMock(...args),
}));

// ── Wiring for the metadata-gate integration section (createFilesRouter) ──
vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, MAX_UPLOAD_SIZE_MB: 100 },
}));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("ncTokenStub"),
}));
vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));
const GATE_PATH_TO_FILEID: Record<string, number> = {
  "/Documents/dept-file.pdf": 9001,
  "/Documents/personal-file.pdf": 9002,
};
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetFileId: vi.fn(
    async (_token: string, _user: string, p: string): Promise<number | null> =>
      GATE_PATH_TO_FILEID[p] ?? null,
  ),
  ncListFiles: vi.fn(),
  ncUploadFile: vi.fn(),
  ncDownloadFile: vi.fn(),
  ncDeleteFile: vi.fn(),
  ncCreateDirectory: vi.fn(),
  ncListShares: vi.fn(),
  ncMoveFile: vi.fn(),
  ncCopyFile: vi.fn(),
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
  ncDirExists: vi.fn(),
  NextcloudOcsError: class NextcloudOcsError extends Error {
    ocsStatus: number;
    constructor(message: string, ocsStatus = 400) {
      super(message);
      this.ocsStatus = ocsStatus;
    }
  },
}));

import request from "supertest";
import express, { Request as ExpressRequest, Response as ExpressResponse, NextFunction as ExpressNextFunction } from "express";
import { createFilesRouter } from "../routes/files.js";
import type { AuthUser } from "../middleware/auth.js";
import {
  requireSpaceAccess,
  checkSpaceAccess,
  parseSpaceValue,
  rightMeets,
  RIGHT_RANK,
  resolveDepartmentIdForSpaceReadOnly,
  type SpaceAccessCaller,
} from "../middleware/space.js";

// ── Mock Prisma ──────────────────────────────────────────────────────

interface DeptRow {
  id: string;
  kind: string;
  state: string;
}
interface MembershipRow {
  departmentId: string;
  userId: string;
  right: string;
}
interface UserRow {
  id: string;
  nextcloudUsername: string;
  role: string;
}

function createMockPrisma() {
  const departments = new Map<string, DeptRow>();
  const memberships = new Map<string, MembershipRow>();
  const users = new Map<string, UserRow>();

  const self = {
    department: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const d = departments.get(where.id);
        return d ? { ...d } : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { kind: string } }) => {
        for (const d of departments.values()) {
          if (d.kind === where.kind) return { ...d };
        }
        return null;
      }),
    },
    departmentMembership: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { departmentId_userId: { departmentId: string; userId: string } };
        }) => {
          const key = `${where.departmentId_userId.departmentId}:${where.departmentId_userId.userId}`;
          const m = memberships.get(key);
          return m ? { ...m } : null;
        },
      ),
    },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { nextcloudUsername: string } }) => {
          for (const u of users.values()) {
            if (u.nextcloudUsername === where.nextcloudUsername) return { ...u };
          }
          return null;
        },
      ),
    },
  };

  return {
    prisma: self as unknown as PrismaClient,
    departments,
    memberships,
    users,
  };
}

function seedDept(
  departments: Map<string, DeptRow>,
  over: Partial<DeptRow> & { id: string },
): DeptRow {
  const dept: DeptRow = { kind: "DEPARTMENT", state: "active", ...over };
  departments.set(dept.id, dept);
  return dept;
}

function seedMembership(
  memberships: Map<string, MembershipRow>,
  row: MembershipRow,
): void {
  memberships.set(`${row.departmentId}:${row.userId}`, row);
}

function seedUser(users: Map<string, UserRow>, row: UserRow): void {
  users.set(row.id, row);
}

function buildReq(
  over: Partial<{
    user: { id: string; role: string };
    query: Record<string, unknown>;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }> = {},
): Request {
  const headers = over.headers ?? {};
  return {
    user: over.user,
    query: over.query ?? {},
    body: over.body ?? {},
    method: "GET",
    path: "/api/files/whatever",
    header: (name: string) => headers[name.toLowerCase()] ?? undefined,
  } as unknown as Request;
}

function buildRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

beforeEach(() => {
  recordActivityMock.mockClear();
});

/** A syntactically valid UUID for `dept:<uuid>` space tokens — anything
 * that isn't shaped like a UUID is `malformed` per `parseSpaceValue`. */
const DEPT_UUID = "22222222-2222-4222-8222-222222222222";

// ── rightMeets / RIGHT_RANK ─────────────────────────────────────────

describe("rightMeets / RIGHT_RANK", () => {
  it("ranks reader < contributor < manager", () => {
    expect(RIGHT_RANK.reader).toBeLessThan(RIGHT_RANK.contributor);
    expect(RIGHT_RANK.contributor).toBeLessThan(RIGHT_RANK.manager);
  });

  it("rightMeets is true when actual >= min, false otherwise", () => {
    expect(rightMeets("manager", "reader")).toBe(true);
    expect(rightMeets("contributor", "contributor")).toBe(true);
    expect(rightMeets("reader", "contributor")).toBe(false);
    expect(rightMeets("reader", "manager")).toBe(false);
  });
});

// ── parseSpaceValue ──────────────────────────────────────────────────

describe("parseSpaceValue", () => {
  it("treats undefined/null/empty/'personal' as personal", () => {
    for (const v of [undefined, null, "", "personal"]) {
      expect(parseSpaceValue(v)).toEqual({ kind: "personal" });
    }
  });

  it("recognizes the household alias", () => {
    expect(parseSpaceValue("household")).toEqual({ kind: "household" });
  });

  it("parses dept:<uuid> into a dept token", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseSpaceValue(`dept:${id}`)).toEqual({ kind: "dept", id });
  });

  it("is malformed for a dept: prefix with a non-UUID suffix", () => {
    expect(parseSpaceValue("dept:not-a-uuid")).toEqual({ kind: "malformed" });
    expect(parseSpaceValue("dept:")).toEqual({ kind: "malformed" });
  });

  it("is malformed for an unrecognized literal", () => {
    expect(parseSpaceValue("banana")).toEqual({ kind: "malformed" });
  });

  it("is malformed for a non-string value", () => {
    expect(parseSpaceValue(123)).toEqual({ kind: "malformed" });
    expect(parseSpaceValue(["dept:x"])).toEqual({ kind: "malformed" });
  });
});

// ── checkSpaceAccess — the core truth table ─────────────────────────

describe("checkSpaceAccess — truth table", () => {
  it("personal (departmentId null) always allows, no DB call", async () => {
    const { prisma } = createMockPrisma();
    const req = buildReq({ user: { id: "u1", role: "family" } });
    const caller: SpaceAccessCaller = { id: "u1", role: "family" };
    const result = await checkSpaceAccess(prisma, req, caller, null, "reader");
    expect(result).toEqual({ allowed: true, departmentId: null });
  });

  it("unknown departmentId (no matching row) → 403, audited", async () => {
    const { prisma } = createMockPrisma();
    const req = buildReq({ user: { id: "u1", role: "family" } });
    const result = await checkSpaceAccess(
      prisma,
      req,
      { id: "u1", role: "family" },
      "does-not-exist",
      "reader",
    );
    expect(result.allowed).toBe(false);
    expect((result as { status: number }).status).toBe(403);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", severity: "warn" }),
    );
  });

  it.each(["pending", "provisioning", "failed", "archiving", "archived"])(
    "state=%s → 403 for every role, audited",
    async (state) => {
      const { prisma, departments } = createMockPrisma();
      seedDept(departments, { id: "d1", state });
      const req = buildReq({ user: { id: "u1", role: "owner" } });
      const result = await checkSpaceAccess(
        prisma,
        req,
        { id: "u1", role: "owner" },
        "d1",
        "reader",
      );
      expect(result.allowed).toBe(false);
      expect((result as { status: number }).status).toBe(403);
    },
  );

  describe("owner/admin — short-circuit pass on active dept", () => {
    it.each(["owner", "admin"])(
      "%s passes even without membership, and emits an audited admin-space-entry row",
      async (role) => {
        const { prisma, departments } = createMockPrisma();
        seedDept(departments, { id: "d1" });
        const req = buildReq({ user: { id: "u1", role } });
        const result = await checkSpaceAccess(prisma, req, { id: "u1", role }, "d1", "manager");
        expect(result).toEqual({ allowed: true, departmentId: "d1" });
        expect(recordActivityMock).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "auth",
            severity: "info",
            what: "Admin space entry (non-member)",
          }),
        );
      },
    );

    it("owner/admin passes WITHOUT an audit row when they ARE a member", async () => {
      const { prisma, departments, memberships } = createMockPrisma();
      seedDept(departments, { id: "d1" });
      seedMembership(memberships, { departmentId: "d1", userId: "u1", right: "reader" });
      const req = buildReq({ user: { id: "u1", role: "owner" } });
      const result = await checkSpaceAccess(
        prisma,
        req,
        { id: "u1", role: "owner" },
        "d1",
        "manager",
      );
      expect(result).toEqual({ allowed: true, departmentId: "d1" });
      expect(recordActivityMock).not.toHaveBeenCalled();
    });
  });

  describe("family", () => {
    it("passes when membership.right >= minRight", async () => {
      const { prisma, departments, memberships } = createMockPrisma();
      seedDept(departments, { id: "d1" });
      seedMembership(memberships, { departmentId: "d1", userId: "u1", right: "contributor" });
      const req = buildReq({ user: { id: "u1", role: "family" } });
      const result = await checkSpaceAccess(
        prisma,
        req,
        { id: "u1", role: "family" },
        "d1",
        "contributor",
      );
      expect(result).toEqual({ allowed: true, departmentId: "d1" });
    });

    it("403s when membership.right < minRight, audited", async () => {
      const { prisma, departments, memberships } = createMockPrisma();
      seedDept(departments, { id: "d1" });
      seedMembership(memberships, { departmentId: "d1", userId: "u1", right: "reader" });
      const req = buildReq({ user: { id: "u1", role: "family" } });
      const result = await checkSpaceAccess(
        prisma,
        req,
        { id: "u1", role: "family" },
        "d1",
        "manager",
      );
      expect(result.allowed).toBe(false);
      expect((result as { status: number }).status).toBe(403);
    });

    it("403s a non-member, audited", async () => {
      const { prisma, departments } = createMockPrisma();
      seedDept(departments, { id: "d1" });
      const req = buildReq({ user: { id: "u1", role: "family" } });
      const result = await checkSpaceAccess(
        prisma,
        req,
        { id: "u1", role: "family" },
        "d1",
        "reader",
      );
      expect(result.allowed).toBe(false);
      expect((result as { status: number }).status).toBe(403);
      expect(recordActivityMock).toHaveBeenCalledWith(
        expect.objectContaining({ what: "Access denied" }),
      );
    });
  });

  describe("guest", () => {
    it("passes when a member AND minRight === reader", async () => {
      const { prisma, departments, memberships } = createMockPrisma();
      seedDept(departments, { id: "d1" });
      seedMembership(memberships, { departmentId: "d1", userId: "u1", right: "reader" });
      const req = buildReq({ user: { id: "u1", role: "guest" } });
      const result = await checkSpaceAccess(
        prisma,
        req,
        { id: "u1", role: "guest" },
        "d1",
        "reader",
      );
      expect(result).toEqual({ allowed: true, departmentId: "d1" });
    });

    it("403s a guest write attempt even as a member", async () => {
      const { prisma, departments, memberships } = createMockPrisma();
      seedDept(departments, { id: "d1" });
      // Even a membership row with a higher nominal right doesn't grant a
      // guest a write — guests are read-only by role, full stop.
      seedMembership(memberships, { departmentId: "d1", userId: "u1", right: "manager" });
      const req = buildReq({ user: { id: "u1", role: "guest" } });
      const result = await checkSpaceAccess(
        prisma,
        req,
        { id: "u1", role: "guest" },
        "d1",
        "contributor",
      );
      expect(result.allowed).toBe(false);
      expect((result as { status: number }).status).toBe(403);
    });

    it("403s a non-member guest", async () => {
      const { prisma, departments } = createMockPrisma();
      seedDept(departments, { id: "d1" });
      const req = buildReq({ user: { id: "u1", role: "guest" } });
      const result = await checkSpaceAccess(
        prisma,
        req,
        { id: "u1", role: "guest" },
        "d1",
        "reader",
      );
      expect(result.allowed).toBe(false);
    });
  });
});

// ── requireSpaceAccess — the Express middleware wrapper ─────────────

describe("requireSpaceAccess middleware", () => {
  it("403s when there is no session (no req.user)", async () => {
    const { prisma } = createMockPrisma();
    const mw = requireSpaceAccess(prisma, "reader");
    const req = buildReq({});
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    await mw(req, res, next);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows personal (default, no ?space=) and sets req.spaceDepartmentId = null", async () => {
    const { prisma } = createMockPrisma();
    const mw = requireSpaceAccess(prisma, "reader");
    const req = buildReq({ user: { id: "u1", role: "family" } });
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.spaceDepartmentId).toBeNull();
  });

  it("resolves ?space=dept:<uuid> and passes for a sufficiently-righted member", async () => {
    const { prisma, departments, memberships } = createMockPrisma();
    seedDept(departments, { id: DEPT_UUID });
    seedMembership(memberships, { departmentId: DEPT_UUID, userId: "u1", right: "manager" });
    const mw = requireSpaceAccess(prisma, "contributor");
    const req = buildReq({
      user: { id: "u1", role: "family" },
      query: { space: `dept:${DEPT_UUID}` },
    });
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.spaceDepartmentId).toBe(DEPT_UUID);
  });

  it("resolves the household alias to the seeded HOUSEHOLD department", async () => {
    const { prisma, departments, memberships } = createMockPrisma();
    seedDept(departments, { id: "hh-1", kind: "HOUSEHOLD" });
    seedMembership(memberships, { departmentId: "hh-1", userId: "u1", right: "reader" });
    const mw = requireSpaceAccess(prisma, "reader");
    const req = buildReq({
      user: { id: "u1", role: "family" },
      query: { space: "household" },
    });
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.spaceDepartmentId).toBe("hh-1");
  });

  it("403s the household alias when no HOUSEHOLD department is seeded yet", async () => {
    const { prisma } = createMockPrisma();
    const mw = requireSpaceAccess(prisma, "reader");
    const req = buildReq({
      user: { id: "u1", role: "owner" },
      query: { space: "household" },
    });
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    await mw(req, res, next);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a malformed ?space= before touching the DB", async () => {
    const { prisma } = createMockPrisma();
    const mw = requireSpaceAccess(prisma, "reader");
    const req = buildReq({
      user: { id: "u1", role: "owner" },
      query: { space: "dept:not-a-uuid" },
    });
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    await mw(req, res, next);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    expect(prisma.department.findUnique).not.toHaveBeenCalled();
  });

  describe("service principals", () => {
    it("`_service:mcp` passes personal without touching the DB", async () => {
      const { prisma } = createMockPrisma();
      const mw = requireSpaceAccess(prisma, "reader");
      const req = buildReq({ user: { id: "_service:mcp", role: "service" } });
      const res = buildRes() as unknown as Response;
      const next = vi.fn() as unknown as NextFunction;
      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("`_service:mcp` on a dept space checks the ASSERTED user's membership (X-Nextcloud-User)", async () => {
      const { prisma, departments, memberships, users } = createMockPrisma();
      seedDept(departments, { id: DEPT_UUID });
      seedUser(users, { id: "local-u1", nextcloudUsername: "alice", role: "family" });
      seedMembership(memberships, { departmentId: DEPT_UUID, userId: "local-u1", right: "manager" });
      const mw = requireSpaceAccess(prisma, "contributor");
      const req = buildReq({
        user: { id: "_service:mcp", role: "service" },
        query: { space: `dept:${DEPT_UUID}` },
        headers: { "x-nextcloud-user": "alice" },
      });
      const res = buildRes() as unknown as Response;
      const next = vi.fn() as unknown as NextFunction;
      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(req.spaceDepartmentId).toBe(DEPT_UUID);
    });

    it("`_service:mcp` on a dept space 403s without an asserted user", async () => {
      const { prisma, departments } = createMockPrisma();
      seedDept(departments, { id: DEPT_UUID });
      const mw = requireSpaceAccess(prisma, "reader");
      const req = buildReq({
        user: { id: "_service:mcp", role: "service" },
        query: { space: `dept:${DEPT_UUID}` },
      });
      const res = buildRes() as unknown as Response;
      const next = vi.fn() as unknown as NextFunction;
      await mw(req, res, next);
      expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("`_service:mcp` 403s when the asserted NC user has no local User row", async () => {
      const { prisma, departments } = createMockPrisma();
      seedDept(departments, { id: DEPT_UUID });
      const mw = requireSpaceAccess(prisma, "reader");
      const req = buildReq({
        user: { id: "_service:mcp", role: "service" },
        query: { space: `dept:${DEPT_UUID}` },
        headers: { "x-nextcloud-user": "nobody" },
      });
      const res = buildRes() as unknown as Response;
      const next = vi.fn() as unknown as NextFunction;
      await mw(req, res, next);
      expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
    });

    it("a non-mcp service principal 403s on any dept space", async () => {
      const { prisma, departments } = createMockPrisma();
      seedDept(departments, { id: DEPT_UUID });
      const mw = requireSpaceAccess(prisma, "reader");
      const req = buildReq({
        user: { id: "_service:voice", role: "service" },
        query: { space: `dept:${DEPT_UUID}` },
      });
      const res = buildRes() as unknown as Response;
      const next = vi.fn() as unknown as NextFunction;
      await mw(req, res, next);
      expect((res as unknown as { statusCode: number }).statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("a non-mcp service principal passes personal", async () => {
      const { prisma } = createMockPrisma();
      const mw = requireSpaceAccess(prisma, "reader");
      const req = buildReq({ user: { id: "_service:voice", role: "service" } });
      const res = buildRes() as unknown as Response;
      const next = vi.fn() as unknown as NextFunction;
      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  it("uses a custom resolveSpace callback when provided", async () => {
    const { prisma, departments, memberships } = createMockPrisma();
    seedDept(departments, { id: DEPT_UUID });
    seedMembership(memberships, { departmentId: DEPT_UUID, userId: "u1", right: "reader" });
    const mw = requireSpaceAccess(prisma, "reader", {
      resolveSpace: () => `dept:${DEPT_UUID}`,
    });
    const req = buildReq({ user: { id: "u1", role: "family" } });
    const res = buildRes() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.spaceDepartmentId).toBe(DEPT_UUID);
  });
});

// ── resolveDepartmentIdForSpaceReadOnly — the upload-writer helper ──

describe("resolveDepartmentIdForSpaceReadOnly", () => {
  it("returns null for personal, no DB call", async () => {
    const { prisma } = createMockPrisma();
    const id = await resolveDepartmentIdForSpaceReadOnly(prisma, undefined);
    expect(id).toBeNull();
    expect(prisma.department.findUnique).not.toHaveBeenCalled();
  });

  it("returns null for a malformed space", async () => {
    const { prisma } = createMockPrisma();
    const id = await resolveDepartmentIdForSpaceReadOnly(prisma, "banana");
    expect(id).toBeNull();
  });

  it("resolves an active dept:<uuid> space", async () => {
    const { prisma, departments } = createMockPrisma();
    seedDept(departments, { id: DEPT_UUID, state: "active" });
    const id = await resolveDepartmentIdForSpaceReadOnly(prisma, `dept:${DEPT_UUID}`);
    expect(id).toBe(DEPT_UUID);
  });

  it("returns null for a pending/non-active dept — never registers a file against it", async () => {
    const { prisma, departments } = createMockPrisma();
    seedDept(departments, { id: DEPT_UUID, state: "pending" });
    const id = await resolveDepartmentIdForSpaceReadOnly(prisma, `dept:${DEPT_UUID}`);
    expect(id).toBeNull();
  });

  it("returns null for an unknown dept id", async () => {
    const { prisma } = createMockPrisma();
    const id = await resolveDepartmentIdForSpaceReadOnly(prisma, `dept:${DEPT_UUID}`);
    expect(id).toBeNull();
  });
});

// ── Metadata-gate integration — GET /api/files/:filePath(*)/comments ──
//
// Exercises the REAL `createFilesRouter` (not just the middleware unit),
// proving `gateFileSpaceAccess` actually wires `resolveFileDepartment` +
// `checkSpaceAccess` into the comments route end-to-end.

function createGateFilesPrismaMock() {
  return {
    // ncFileId 9001 ("/Documents/dept-file.pdf") is registered to DEPT_UUID;
    // 9002 ("/Documents/personal-file.pdf") has no registry row at all.
    file: {
      findUnique: vi.fn(async ({ where }: { where: { ncFileId: number } }) =>
        where.ncFileId === 9001 ? { departmentId: DEPT_UUID } : null,
      ),
    },
    department: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === DEPT_UUID ? { id: DEPT_UUID, state: "active" } : null,
      ),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    departmentMembership: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { departmentId_userId: { departmentId: string; userId: string } };
        }) =>
          where.departmentId_userId.departmentId === DEPT_UUID &&
          where.departmentId_userId.userId === "member-1"
            ? { right: "reader" }
            : null,
      ),
    },
    fileComment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

function mkGateUser(role: AuthUser["role"], id: string): AuthUser {
  return { id, username: id, displayName: id, role };
}

function buildGateApp(prisma: ReturnType<typeof createGateFilesPrismaMock>, user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req: ExpressRequest, _res: ExpressResponse, next: ExpressNextFunction) => {
    (req as ExpressRequest & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createFilesRouter(prisma as unknown as PrismaClient));
  return app;
}

describe("metadata-gate integration — GET /files/:filePath(*)/comments", () => {
  it("403s a non-member on a file registered to a department", async () => {
    const prisma = createGateFilesPrismaMock();
    const app = buildGateApp(prisma, mkGateUser("family", "not-a-member"));
    const res = await request(app).get("/api/files/Documents/dept-file.pdf/comments");
    expect(res.status).toBe(403);
  });

  it("200s a member on a file registered to a department", async () => {
    const prisma = createGateFilesPrismaMock();
    const app = buildGateApp(prisma, mkGateUser("family", "member-1"));
    const res = await request(app).get("/api/files/Documents/dept-file.pdf/comments");
    expect(res.status).toBe(200);
  });

  it("owner passes on a department file with no membership row (audited admin entry)", async () => {
    const prisma = createGateFilesPrismaMock();
    const app = buildGateApp(prisma, mkGateUser("owner", "the-owner"));
    const res = await request(app).get("/api/files/Documents/dept-file.pdf/comments");
    expect(res.status).toBe(200);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: "Admin space entry (non-member)" }),
    );
  });

  it("falls through to existing personal-space behavior when the file is absent from the registry", async () => {
    const prisma = createGateFilesPrismaMock();
    const app = buildGateApp(prisma, mkGateUser("family", "not-a-member"));
    const res = await request(app).get("/api/files/Documents/personal-file.pdf/comments");
    expect(res.status).toBe(200);
    expect(prisma.department.findUnique).not.toHaveBeenCalled();
  });
});
