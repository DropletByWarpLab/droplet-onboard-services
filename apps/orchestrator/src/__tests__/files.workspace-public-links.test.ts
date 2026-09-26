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
import { libraryOfHomePath, mayCreatePublicLink } from "../services/share-policy.js";

const ncMock = nc as unknown as Record<string, ReturnType<typeof vi.fn>>;

const HOUSEHOLD = { id: "hh", name: "Household", parentId: null, kind: "HOUSEHOLD", state: "active" };
const ALPHA = { id: "11111111-1111-4111-8111-111111111111", name: "Alpha", parentId: null, kind: "DEPARTMENT", state: "active" };
const OPS = { id: "33333333-3333-4333-8333-333333333333", name: "Ops", parentId: ALPHA.id, kind: "TEAM", state: "active" };

const MEMBER = { id: "u-member", username: "mia", role: "family" };
const ADMIN = { id: "u-admin", username: "ada", role: "admin" };
const OWNER = { id: "u-owner", username: "olly", role: "owner" };
const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };

function makePrisma() {
  const depts = [HOUSEHOLD, ALPHA, OPS];
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

  it("classifies by the first home segment only", () => {
    const roots = ["Household", "Alpha"];
    expect(libraryOfHomePath("/Household", roots)).toBe("company");
    expect(libraryOfHomePath("//Alpha/x", roots)).toBe("company");
    expect(libraryOfHomePath("/Docs/Household/x", roots)).toBe("personal");
    expect(libraryOfHomePath("/Householder", roots)).toBe("personal");
    expect(libraryOfHomePath("/", roots)).toBe("personal");
  });
});
