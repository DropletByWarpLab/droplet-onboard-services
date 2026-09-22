/**
 * WARP-2976 (ADR-059 P1) — GET/PUT /api/departments/:id/profile, and the
 * profile summary the list route now carries for the department switcher.
 *
 * Mounted through the real createDepartmentsRouter (the profile routes are
 * registered from inside it), so the mount itself is under test. Prisma is a
 * hand-rolled mock in the style of departments.detail.test.ts; the real
 * departmentManagerOrAdmin runs against it, so the manager rule tested here is
 * the one production uses — not a stub that agrees with the route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { recordActivityMock } = vi.hoisted(() => ({ recordActivityMock: vi.fn() }));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  gfListFolders: vi.fn().mockResolvedValue([]),
}));
vi.mock("../services/department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:dGVzdDp0ZXN0"),
}));
vi.mock("../services/department-reconciler.service.js", () => ({
  kickReconcile: vi.fn(),
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

type Row = { id: string; name: string; kind: string; parentId: string | null; state: string };
type Membership = { departmentId: string; userId: string; right: string };

const SECURITY: Row = { id: "d-sec", name: "Security", kind: "DEPARTMENT", parentId: null, state: "active" };
const NIGHTS: Row = { id: "t-nights", name: "Nights", kind: "TEAM", parentId: "d-sec", state: "active" };
const HOUSEHOLD: Row = { id: "d-home", name: "Household", kind: "HOUSEHOLD", parentId: null, state: "active" };
const OLD: Row = { id: "d-old", name: "Old", kind: "DEPARTMENT", parentId: null, state: "archived" };

const PROFILE = {
  departmentId: "d-sec",
  template: "security",
  icon: "shield-check",
  navHrefs: ["/cameras", "/events"],
  homeWidgets: [{ widget: "cameras", size: "m" }],
  updatedBy: "u-owner",
  createdAt: new Date("2026-09-22T10:00:00Z"),
  updatedAt: new Date("2026-09-22T10:00:00Z"),
};

const VALID_BODY = {
  template: "security",
  icon: "shield-check",
  navHrefs: ["/cameras", "/events", "/network"],
  homeWidgets: [
    { widget: "cameras", size: "m" },
    { widget: "quick-links", size: "l" },
  ],
};

function mkPrisma(opts: {
  rows?: Row[];
  memberships?: Membership[];
  profiles?: Array<typeof PROFILE>;
} = {}) {
  const rows = opts.rows ?? [SECURITY, NIGHTS, HOUSEHOLD, OLD];
  const memberships = opts.memberships ?? [];
  const profiles = opts.profiles ?? [];
  const self: any = {
    department: {
      findUnique: vi.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    departmentMembership: {
      findUnique: vi.fn(async ({ where }: any) => {
        const k = where.departmentId_userId;
        return memberships.find((m) => m.departmentId === k.departmentId && m.userId === k.userId) ?? null;
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    departmentProfile: {
      findUnique: vi.fn(async ({ where }: any) => profiles.find((p) => p.departmentId === where.departmentId) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const found = profiles.find((p) => p.departmentId === where.departmentId);
        return {
          ...(found ? { ...found, ...update } : { ...create, createdAt: new Date() }),
          updatedAt: new Date("2026-09-22T11:00:00Z"),
        };
      }),
    },
  };
  self.$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(self));
  return self;
}

function mkApp(prisma: any, user?: { id: string; role: string; username?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use("/api", createDepartmentsRouter(prisma));
  return app;
}

const OWNER = { id: "u-owner", role: "owner", username: "owner" };
const FAMILY = (id: string) => ({ id, role: "family", username: id });

beforeEach(() => {
  recordActivityMock.mockReset();
});

describe("GET /api/departments/:id/profile", () => {
  it("401 without a session", async () => {
    const res = await request(mkApp(mkPrisma())).get("/api/departments/d-sec/profile");
    expect(res.status).toBe(401);
  });

  it("404 for an unknown department", async () => {
    const res = await request(mkApp(mkPrisma(), OWNER)).get("/api/departments/nope/profile");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("403 NOT_A_MEMBER for a family member outside the department", async () => {
    const res = await request(mkApp(mkPrisma({ profiles: [PROFILE] }), FAMILY("u-x"))).get(
      "/api/departments/d-sec/profile",
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_A_MEMBER");
    expect(res.body.profile).toBeUndefined();
  });

  it("a reader sees the profile and may not edit it", async () => {
    const prisma = mkPrisma({
      profiles: [PROFILE],
      memberships: [{ departmentId: "d-sec", userId: "u-r", right: "reader" }],
    });
    const res = await request(mkApp(prisma, FAMILY("u-r"))).get("/api/departments/d-sec/profile");
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ template: "security", navHrefs: ["/cameras", "/events"] });
    expect(res.body.inheritedFrom).toBeNull();
    expect(res.body.canEdit).toBe(false);
  });

  it("a manager may edit", async () => {
    const prisma = mkPrisma({
      profiles: [PROFILE],
      memberships: [{ departmentId: "d-sec", userId: "u-m", right: "manager" }],
    });
    const res = await request(mkApp(prisma, FAMILY("u-m"))).get("/api/departments/d-sec/profile");
    expect(res.body.canEdit).toBe(true);
  });

  it("an unset department is the explicit not-set-up state (null), editable by the owner", async () => {
    const res = await request(mkApp(mkPrisma(), OWNER)).get("/api/departments/d-sec/profile");
    expect(res.status).toBe(200);
    expect(res.body.profile).toBeNull();
    expect(res.body.canEdit).toBe(true);
  });

  it("a team reads its parent's profile, names where it came from, and is never editable", async () => {
    const prisma = mkPrisma({
      profiles: [PROFILE],
      memberships: [{ departmentId: "d-sec", userId: "u-m", right: "manager" }],
    });
    const res = await request(mkApp(prisma, FAMILY("u-m"))).get("/api/departments/t-nights/profile");
    expect(res.status).toBe(200);
    expect(res.body.profile.departmentId).toBe("d-sec");
    expect(res.body.inheritedFrom).toBe("d-sec");
    expect(res.body.canEdit).toBe(false);
  });

  it("the household never has a profile and never reads the table", async () => {
    const prisma = mkPrisma();
    const res = await request(mkApp(prisma, OWNER)).get("/api/departments/d-home/profile");
    expect(res.body).toEqual({ profile: null, inheritedFrom: null, canEdit: false });
    expect(prisma.departmentProfile.findUnique).not.toHaveBeenCalled();
  });

  it("an archived department is not editable", async () => {
    const res = await request(mkApp(mkPrisma(), OWNER)).get("/api/departments/d-old/profile");
    expect(res.body.canEdit).toBe(false);
  });
});

describe("PUT /api/departments/:id/profile", () => {
  it("the owner sets a department up: upsert with updatedBy = the caller's id, audited as 'Department set up'", async () => {
    const prisma = mkPrisma();
    const res = await request(mkApp(prisma, OWNER)).put("/api/departments/d-sec/profile").send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ departmentId: "d-sec", template: "security", icon: "shield-check" });
    const arg = prisma.departmentProfile.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ departmentId: "d-sec" });
    expect(arg.create).toMatchObject({ departmentId: "d-sec", updatedBy: "u-owner", navHrefs: VALID_BODY.navHrefs });
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0][0]).toMatchObject({
      what: "Department set up",
      refs: { departmentId: "d-sec", template: "security", navHrefCount: 3, homeWidgetCount: 2 },
    });
  });

  it("changing an existing profile is audited as an update", async () => {
    const prisma = mkPrisma({ profiles: [PROFILE] });
    const res = await request(mkApp(prisma, OWNER)).put("/api/departments/d-sec/profile").send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(recordActivityMock.mock.calls[0][0].what).toBe("Department arrangement updated");
  });

  it("a manager of the department may change it", async () => {
    const prisma = mkPrisma({ memberships: [{ departmentId: "d-sec", userId: "u-m", right: "manager" }] });
    const res = await request(mkApp(prisma, FAMILY("u-m"))).put("/api/departments/d-sec/profile").send(VALID_BODY);
    expect(res.status).toBe(200);
  });

  it.each(["contributor", "reader"])("a %s may not, and nothing is written", async (right) => {
    const prisma = mkPrisma({ memberships: [{ departmentId: "d-sec", userId: "u-c", right }] });
    const res = await request(mkApp(prisma, FAMILY("u-c"))).put("/api/departments/d-sec/profile").send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(prisma.departmentProfile.upsert).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("authorisation comes before the kind check: a non-manager learns nothing about a team", async () => {
    const prisma = mkPrisma({ memberships: [{ departmentId: "d-sec", userId: "u-c", right: "contributor" }] });
    const res = await request(mkApp(prisma, FAMILY("u-c"))).put("/api/departments/t-nights/profile").send(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it("a team cannot hold its own profile", async () => {
    const prisma = mkPrisma();
    const res = await request(mkApp(prisma, OWNER)).put("/api/departments/t-nights/profile").send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TEAM_INHERITS_PROFILE");
    expect(prisma.departmentProfile.upsert).not.toHaveBeenCalled();
  });

  it("the household cannot hold one", async () => {
    const res = await request(mkApp(mkPrisma(), OWNER)).put("/api/departments/d-home/profile").send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("HOUSEHOLD_HAS_NO_PROFILE");
  });

  it("an archived department must be restored first", async () => {
    const res = await request(mkApp(mkPrisma(), OWNER)).put("/api/departments/d-old/profile").send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ARCHIVED");
  });

  it("404 for an unknown department", async () => {
    const res = await request(mkApp(mkPrisma(), OWNER)).put("/api/departments/nope/profile").send(VALID_BODY);
    expect(res.status).toBe(404);
  });

  it.each([
    ["an unknown template", { ...VALID_BODY, template: "alarm" }],
    ["an off-box link", { ...VALID_BODY, navHrefs: ["https://evil.example"] }],
    ["a javascript: href", { ...VALID_BODY, navHrefs: ["javascript:alert(1)"] }],
    ["a protocol-relative href", { ...VALID_BODY, navHrefs: ["//evil"] }],
    ["an href with a trailing slash", { ...VALID_BODY, navHrefs: ["/cameras/"] }],
    ["an href with a query string", { ...VALID_BODY, navHrefs: ["/cameras?x=1"] }],
    ["duplicate hrefs", { ...VALID_BODY, navHrefs: ["/cameras", "/cameras"] }],
    ["too many hrefs", { ...VALID_BODY, navHrefs: Array.from({ length: 41 }, (_, i) => `/p${i}`) }],
    ["a widget size outside s/m/l", { ...VALID_BODY, homeWidgets: [{ widget: "cameras", size: "xl" }] }],
    ["an extra key on a widget", { ...VALID_BODY, homeWidgets: [{ widget: "cameras", size: "s", html: "<b>" }] }],
    ["an icon that is not a lucide name", { ...VALID_BODY, icon: "<svg>" }],
    ["an unexpected top-level key", { ...VALID_BODY, departmentId: "d-other" }],
    ["a missing field", { template: "security", icon: "shield-check", navHrefs: [] }],
  ])("400 VALIDATION_ERROR for %s, before any database read", async (_label, body) => {
    const prisma = mkPrisma();
    const res = await request(mkApp(prisma, OWNER)).put("/api/departments/d-sec/profile").send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(prisma.department.findUnique).not.toHaveBeenCalled();
    expect(prisma.departmentProfile.upsert).not.toHaveBeenCalled();
  });

  it("accepts an empty arrangement (custom template, nothing chosen yet)", async () => {
    const res = await request(mkApp(mkPrisma(), OWNER))
      .put("/api/departments/d-sec/profile")
      .send({ template: "custom", icon: "building-2", navHrefs: [], homeWidgets: [] });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/departments — the switcher's profile summary", () => {
  const LIST_ROW = {
    id: "d-sec",
    name: "Security",
    slug: "security",
    kind: "DEPARTMENT",
    parentId: null,
    description: null,
    state: "active",
    provisionError: null,
    quotaBytes: null,
    aclVersion: 1,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    archivedAt: null,
    ncGroupfolderId: null,
    _count: { memberships: 3, teams: 0 },
  };

  it("loads the summary in the same query and returns {template, icon} — or null when not set up", async () => {
    const prisma = mkPrisma();
    prisma.department.findMany.mockResolvedValue([
      { ...LIST_ROW, profile: { template: "security", icon: "shield-check" } },
      { ...LIST_ROW, id: "d-sales", slug: "sales", name: "Sales", profile: null },
    ]);
    const res = await request(mkApp(prisma, OWNER)).get("/api/departments");
    expect(res.status).toBe(200);
    expect(prisma.department.findMany.mock.calls[0][0].include.profile).toEqual({
      select: { template: true, icon: true },
    });
    const byId = Object.fromEntries(res.body.departments.map((d: any) => [d.id, d]));
    expect(byId["d-sec"].profile).toEqual({ template: "security", icon: "shield-check" });
    expect(byId["d-sales"].profile).toBeNull();
  });
});
