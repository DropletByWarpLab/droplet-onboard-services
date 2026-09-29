/**
 * WARP-3053 — a public link to company data (the Workspace, or any
 * department/team library) is owner/admin only, enforced by the box whatever
 * shape the client used: the explicit shape (`space` + space-relative path)
 * or the web/Mac shape (full home path, no `space`). Members still share
 * their personal files and share internally with people.
 *
 * Real `createFilesRouter` + real space middleware; only Nextcloud and the
 * DB are stubbed (same harness as files.manager-shares.test.ts).
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
    ncCreateShareV2: vi.fn(),
    ncUpdateShare: vi.fn(),
    ncDeleteShare: vi.fn(),
    ncGetShare: vi.fn(),
  };
});

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("session-token"),
}));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../config.js", () => ({
  config: {
    MAX_UPLOAD_SIZE_MB: 10,
    NODE_ENV: "test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    NEXTCLOUD_URL: "http://nextcloud.test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { createFilesRouter } from "../routes/files.js";
import * as nc from "../services/nextcloud.client.js";
import { exposesOutside, libraryOfHomePath, mayCreatePublicLink } from "../services/share-policy.js";

const ncMock = nc as unknown as Record<string, ReturnType<typeof vi.fn>>;

const HOUSEHOLD = { id: "hh", name: "Household", parentId: null, kind: "HOUSEHOLD", state: "active" };
const ALPHA = { id: "11111111-1111-4111-8111-111111111111", name: "Alpha", parentId: null, kind: "DEPARTMENT", state: "active" };
const OPS = { id: "33333333-3333-4333-8333-333333333333", name: "Ops", parentId: ALPHA.id, kind: "TEAM", state: "active" };
const SALES_EMEA = { id: "44444444-4444-4444-8444-444444444444", name: "Sales/EMEA", parentId: null, kind: "DEPARTMENT", state: "active" };
const NORTH = { id: "55555555-5555-4555-8555-555555555555", name: "North", parentId: SALES_EMEA.id, kind: "TEAM", state: "active" };
const CAFE = { id: "66666666-6666-4666-8666-666666666666", name: "Caf\u00e9", parentId: null, kind: "DEPARTMENT", state: "active" };

const MEMBER = { id: "u-member", username: "mia", role: "family" };
const ADMIN = { id: "u-admin", username: "ada", role: "admin" };
const OWNER = { id: "u-owner", username: "olly", role: "owner" };
const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };

function makePrisma() {
  const depts = [HOUSEHOLD, ALPHA, OPS, SALES_EMEA, NORTH, CAFE];
  const users = [
    { id: MEMBER.id, username: MEMBER.username, role: MEMBER.role, directoryStatus: "ACTIVE", nextcloudUsername: "mia" },
    { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role, directoryStatus: "ACTIVE", nextcloudUsername: "ada" },
  ];
  return {
    department: {
      findFirst: vi.fn(async (a?: { where?: { kind?: string } }) =>
        a?.where?.kind === "HOUSEHOLD" ? HOUSEHOLD : null,
      ),
      findUnique: vi.fn(async (a?: { where?: { id?: string } }) => depts.find((d) => d.id === a?.where?.id) ?? null),
      findMany: vi.fn(async (a?: { where?: { kind?: { in?: string[] } } }) =>
        depts.filter((d) => !a?.where?.kind?.in || a.where.kind.in.includes(d.kind)),
      ),
    },
    departmentMembership: { findUnique: vi.fn(async () => null) },
    departmentShare: { findUnique: vi.fn(async () => null), create: vi.fn() },
    user: {
      findMany: vi.fn(async (a?: { where?: { OR?: Array<Record<string, string>> } }) => {
        const or = a?.where?.OR;
        if (!or) return users;
        return users.filter((u) => or.some((c) => Object.entries(c).every(([k, v]) => (u as never)[k] === v)));
      }),
      findUnique: vi.fn(async (a?: { where?: { id?: string } }) => users.find((u) => u.id === a?.where?.id) ?? null),
    },
  };
}

function app(asUser: { id: string; username: string; role: string }) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { user: typeof asUser }).user = asUser;
    next();
  });
  a.use("/api", createFilesRouter(makePrisma() as never));
  return a;
}

const created = { id: 7, url: "https://box/s/x", token: "x", shareType: 3, permissions: 1, path: "/x" };

beforeEach(() => {
  for (const fn of Object.values(ncMock)) if (typeof fn?.mockReset === "function") fn.mockReset();
  ncMock.ncCreateShareV2.mockResolvedValue(created);
  ncMock.ncUpdateShare.mockResolvedValue(undefined);
  ncMock.ncDeleteShare.mockResolvedValue(undefined);
});

describe("WARP-3053 — POST /files/share public links on company data", () => {
  it("member, web shape (home path, no space) on the Workspace: 403, no OCS call", async () => {
    const res = await request(app(MEMBER)).post("/api/files/share").send({ path: "/Household/Plan.pdf" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("public_link_company_data");
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("member, explicit shape (space=shared) on the Workspace: 403, no OCS call", async () => {
    const res = await request(app(MEMBER)).post("/api/files/share").send({ path: "/Plan.pdf", space: "shared" });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it.each([
    ["department", "/Alpha/Reports/q3.pdf"],
    ["team", "/Alpha — Ops/runbook.md"],
    ["case variant of the Workspace (fail closed)", "/household/Plan.pdf"],
    ["dot segment before the Workspace", "/./Household/Plan.pdf"],
  ])("member, web shape on a %s path: 403", async (_label, path) => {
    const res = await request(app(MEMBER)).post("/api/files/share").send({ path });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it.each([
    ["email (4)", 4],
    ["federated (6)", 6],
    ["an unknown type (5)", 5],
    ["a group share with re-share (1 + bit 16)", 1],
  ])("member, %s on a Workspace item: 403 (allowlist, not denylist)", async (_label, shareType) => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({
        path: "/Household/Plan.pdf",
        shareType,
        shareWith: "someone@example.com",
        permissions: shareType === 1 ? 17 : 1,
      });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("member, internal GROUP share (1) of a Workspace item without re-share: allowed", async () => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Household/Plan.pdf", shareType: 1, shareWith: "staff", permissions: 1 });
    expect(res.status).toBe(200);
  });

  it("admin, email share (4) of a Workspace item: allowed", async () => {
    const res = await request(app(ADMIN))
      .post("/api/files/share")
      .send({ path: "/Household/Plan.pdf", shareType: 4, shareWith: "x@example.com" });
    expect(res.status).toBe(200);
  });

  it("a backslash path is refused outright (400), whoever asks", async () => {
    for (const who of [MEMBER, ADMIN]) {
      const res = await request(app(who)).post("/api/files/share").send({ path: "\\Household\\x" });
      expect(res.status).toBe(400);
    }
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it.each([
    ["a department name sent in NFD", "/Cafe\u0301/menu.pdf"],
    ["a department whose name contains a slash", "/Sales/EMEA/q3.pdf"],
    ["that department's root itself", "/Sales/EMEA"],
    ["a team under it, in the Parent — Team form", "/Sales/EMEA — North/plan.pdf"],
  ])("member, public link on %s: 403", async (_label, path) => {
    const res = await request(app(MEMBER)).post("/api/files/share").send({ path });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("member, public link on a personal folder that only shares a first segment with a library: allowed", async () => {
    const res = await request(app(MEMBER)).post("/api/files/share").send({ path: "/Sales/pipeline.xlsx" });
    expect(res.status).toBe(200);
  });

  it("member granting the re-share bit on a Workspace item internally: 403", async () => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Household/Plan.pdf", shareType: 0, shareWith: "ada", permissions: 19 });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("admin, web shape on the Workspace: allowed with the caller's own token", async () => {
    const res = await request(app(ADMIN)).post("/api/files/share").send({ path: "/Household/Plan.pdf" });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
      "session-token",
      "/Household/Plan.pdf",
      expect.objectContaining({ shareType: 3 }),
    );
  });

  it("owner, explicit shape on the Workspace: allowed", async () => {
    const res = await request(app(OWNER)).post("/api/files/share").send({ path: "/Plan.pdf", space: "shared" });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
      expect.any(String), // the Workspace branch mints with the admin credential
      "/Household/Plan.pdf",
      expect.objectContaining({ shareType: 3 }),
    );
  });

  it("member, public link on their own personal file: allowed", async () => {
    const res = await request(app(MEMBER)).post("/api/files/share").send({ path: "/Documents/Householder notes.pdf" });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
      "session-token",
      "/Documents/Householder notes.pdf",
      expect.objectContaining({ shareType: 3 }),
    );
  });

  it("member, internal share of a Workspace item with a colleague: allowed", async () => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Household/Plan.pdf", shareType: 0, shareWith: "ada", permissions: 3 });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
      "session-token",
      "/Household/Plan.pdf",
      expect.objectContaining({ shareType: 0, shareWith: "ada" }),
    );
  });

  it("share_file tool (MCP service) acting for a member on the Workspace: 403", async () => {
    const res = await request(app(MCP))
      .post("/api/files/share")
      .set("X-Nextcloud-Token", "member-token")
      .set("X-Nextcloud-User", "mia")
      .send({ path: "/Household/Plan.pdf", shareType: 3 });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("share_file tool (MCP service) acting for an admin on the Workspace: allowed", async () => {
    const res = await request(app(MCP))
      .post("/api/files/share")
      .set("X-Nextcloud-Token", "admin-token")
      .set("X-Nextcloud-User", "ada")
      .send({ path: "/Household/Plan.pdf", shareType: 3 });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith("admin-token", "/Household/Plan.pdf", expect.anything());
  });
});

describe("WARP-3053 — PUT/DELETE /files/share/:id on company data", () => {
  it("member editing an existing Workspace public link: 403, nothing changed", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, path: "/Household/Plan.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ expireDate: "2099-01-01" });
    expect(res.status).toBe(403);
    expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
  });

  it.each([4, 6, 5])("member editing an existing type-%i share on a Workspace item: 403", async (shareType) => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, shareType, path: "/Household/Plan.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ note: "hi" });
    expect(res.status).toBe(403);
    expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
  });

  it("member editing a Workspace share whose NC path is in NFD form: 403", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, path: "/Cafe\u0301/menu.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ note: "hi" });
    expect(res.status).toBe(403);
  });

  it("member adding the re-share bit to an internal Workspace share: 403", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, shareType: 0, path: "/Household/Plan.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ permissions: 19 });
    expect(res.status).toBe(403);
    expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
  });

  it("member editing an internal Workspace share without re-share: allowed", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, shareType: 0, path: "/Household/Plan.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ permissions: 3 });
    expect(res.status).toBe(200);
  });

  it("member editing their personal public link: allowed", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, path: "/Documents/a.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ note: "hi" });
    expect(res.status).toBe(200);
    expect(ncMock.ncUpdateShare).toHaveBeenCalledWith("session-token", 7, "note", "hi");
  });

  it("admin editing a Workspace public link: allowed, no lookup needed", async () => {
    const res = await request(app(ADMIN)).put("/api/files/share/7").send({ note: "hi" });
    expect(res.status).toBe(200);
    expect(ncMock.ncGetShare).not.toHaveBeenCalled();
  });

  it("member revoking a Workspace public link stays allowed", async () => {
    const res = await request(app(MEMBER)).delete("/api/files/share/7");
    expect(res.status).toBe(200);
    expect(ncMock.ncDeleteShare).toHaveBeenCalledWith("session-token", 7);
  });
});

describe("WARP-3053 — share-policy", () => {
  it("one function decides; personal is open, company is owner/admin", () => {
    expect(mayCreatePublicLink("family", "personal")).toBe(true);
    expect(mayCreatePublicLink("family", "company")).toBe(false);
    expect(mayCreatePublicLink(undefined, "company")).toBe(false);
    expect(mayCreatePublicLink("admin", "company")).toBe(true);
    expect(mayCreatePublicLink("owner", "company")).toBe(true);
  });

  it("classifies by whole-prefix match on normalized paths", () => {
    const roots = ["Household", "Alpha", "Sales/EMEA", "Caf\u00e9"];
    expect(libraryOfHomePath("/Household", roots)).toBe("company");
    expect(libraryOfHomePath("//Alpha/x", roots)).toBe("company");
    expect(libraryOfHomePath("/Docs/Household/x", roots)).toBe("personal");
    expect(libraryOfHomePath("/Householder", roots)).toBe("personal");
    expect(libraryOfHomePath("/Sales/EMEA/x", roots)).toBe("company");
    expect(libraryOfHomePath("/Sales/EMEAx", roots)).toBe("personal");
    expect(libraryOfHomePath("/Sales", roots)).toBe("personal");
    expect(libraryOfHomePath("/Cafe\u0301/x", roots)).toBe("company");
    expect(libraryOfHomePath("/Cafe\u0301/x", ["Cafe\u0301"])).toBe("company");
    expect(libraryOfHomePath("\\Household\\x", roots)).toBe("company");
    expect(libraryOfHomePath("/", roots)).toBe("personal");
  });

  it("exposesOutside is an allowlist: only user/group without re-share is internal", () => {
    expect(exposesOutside(0, 3)).toBe(false);
    expect(exposesOutside(1, 1)).toBe(false);
    expect(exposesOutside(0, 19)).toBe(true);
    for (const t of [3, 4, 6, 7, 9, 10, 12, 15, 42]) expect(exposesOutside(t, 1)).toBe(true);
  });
});
