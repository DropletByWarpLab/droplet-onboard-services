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
    ncIsDirectory: vi.fn(),
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
import {
  defaultPublicLinkExpiry,
  exposesOutside,
  isWorkspacePath,
  libraryOfHomePath,
  mayCreatePublicLink,
  memberPublicLinkWriteRefused,
  publicLinkExpiryViolation,
  publicLinkPasswordViolation,
} from "../services/share-policy.js";

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

function app(asUser: { id: string; username: string; role: string }, db = makePrisma()) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { user: typeof asUser }).user = asUser;
    next();
  });
  a.use("/api", createFilesRouter(db as never));
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
    expect(res.body.error).toBe("workspace_share_admin_only");
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

  // Types 5 and 6 (and 2, 7) no longer reach the policy: the request schema
  // refuses them with 400 first (WARP-3622; files.test.ts), so the allowlist
  // below only ever sees the offered types.
  it.each([
    ["email (4)", 4],
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

  // WARP-3168 ruling: members share nothing from the Workspace, internal
  // shares included — Nextcloud refuses the same (Workspace group mask 15).
  it("member, internal GROUP share (1) of a Workspace item: 403 (WARP-3168)", async () => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Household/Plan.pdf", shareType: 1, shareWith: "staff", permissions: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("workspace_share_admin_only");
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("member, internal share of a department item: still allowed (departments keep WARP-3053)", async () => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Alpha/Reports/q3.pdf", shareType: 0, shareWith: "ada", permissions: 1 });
    expect(res.status).toBe(200);
  });

  it("member, public link on a department item: still the WARP-3053 refusal", async () => {
    const res = await request(app(MEMBER)).post("/api/files/share").send({ path: "/Alpha/Reports/q3.pdf" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("public_link_company_data");
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

  it("member, internal share of a Workspace item with a colleague: 403 (WARP-3168)", async () => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Household/Plan.pdf", shareType: 0, shareWith: "ada", permissions: 3 });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("admin, internal share of a Workspace item: allowed", async () => {
    const res = await request(app(ADMIN))
      .post("/api/files/share")
      .send({ path: "/Household/Plan.pdf", shareType: 0, shareWith: "mia", permissions: 1 });
    expect(res.status).toBe(200);
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

  it("member editing an internal Workspace share: 403 (WARP-3168)", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, shareType: 0, path: "/Household/Plan.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ permissions: 3 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("workspace_share_admin_only");
    expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
  });

  it("member (creator) editing a recorded space=shared share: 403 (WARP-3168)", async () => {
    const db = makePrisma();
    db.departmentShare.findUnique.mockResolvedValue({
      departmentId: HOUSEHOLD.id,
      createdById: MEMBER.id,
      shareType: 0,
    } as never);
    const res = await request(app(MEMBER, db)).put("/api/files/share/7").send({ permissions: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("workspace_share_admin_only");
    expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
  });

  it("member editing an internal department share without re-share: allowed", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, shareType: 0, path: "/Alpha/a.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ permissions: 3 });
    expect(res.status).toBe(200);
  });

  it("member editing their personal public link: allowed", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, path: "/Documents/a.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ note: "hi" });
    expect(res.status).toBe(200);
    expect(ncMock.ncUpdateShare).toHaveBeenCalledWith("session-token", 7, "note", "hi");
  });

  it("admin editing a Workspace public link: allowed, no policy lookup needed", async () => {
    const res = await request(app(ADMIN)).put("/api/files/share/7").send({ note: "hi" });
    expect(res.status).toBe(200);
    // The one lookup is the audit row's path (WARP-3587), made after the policy
    // check; the policy itself needs none for an admin.
    expect(ncMock.ncGetShare).toHaveBeenCalledTimes(1);
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

  it("isWorkspacePath: whole-prefix, NFC, case-insensitive, fail closed", () => {
    expect(isWorkspacePath("/Household/x", "Household")).toBe(true);
    expect(isWorkspacePath("/household", "Household")).toBe(true);
    expect(isWorkspacePath("/./Household/x", "Household")).toBe(true);
    expect(isWorkspacePath("/Householder/x", "Household")).toBe(false);
    expect(isWorkspacePath("/Alpha/x", "Household")).toBe(false);
    expect(isWorkspacePath("\\Household\\x", "Household")).toBe(true);
  });

  it("exposesOutside is an allowlist: only user/group without re-share is internal", () => {
    expect(exposesOutside(0, 3)).toBe(false);
    expect(exposesOutside(1, 1)).toBe(false);
    expect(exposesOutside(0, 19)).toBe(true);
    for (const t of [3, 4, 6, 7, 9, 10, 12, 15, 42]) expect(exposesOutside(t, 1)).toBe(true);
  });
});

// ── WARP-3586 — what a public link may be, for every caller ───────────────
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("WARP-3586 — POST /files/share public-link hygiene", () => {
  it("no expireDate on a link: the 30-day default is sent to Nextcloud", async () => {
    const res = await request(app(MEMBER)).post("/api/files/share").send({ path: "/Documents/a.pdf" });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
      "session-token",
      "/Documents/a.pdf",
      expect.objectContaining({ shareType: 3, expireDate: defaultPublicLinkExpiry() }),
    );
  });

  it("an email link (4) gets the default expiry too", async () => {
    const res = await request(app(ADMIN))
      .post("/api/files/share")
      .send({ path: "/Documents/a.pdf", shareType: 4, shareWith: "x@example.com" });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
      expect.any(String),
      "/Documents/a.pdf",
      expect.objectContaining({ expireDate: defaultPublicLinkExpiry() }),
    );
  });

  it("an internal share (user) keeps no forced expiry", async () => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Documents/a.pdf", shareType: 0, shareWith: "ada", permissions: 1 });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateShareV2.mock.calls[0][2].expireDate).toBeUndefined();
  });

  it.each([
    ["member", MEMBER],
    ["admin", ADMIN],
    ["owner", OWNER],
  ])("%s: an expireDate beyond 90 days is rejected, nothing created", async (_l, who) => {
    const res = await request(app(who))
      .post("/api/files/share")
      .send({ path: "/Documents/a.pdf", expireDate: inDays(120) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("public_link_expiry_too_far");
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("an expireDate inside the ceiling passes through unchanged", async () => {
    const d = inDays(45);
    const res = await request(app(MEMBER)).post("/api/files/share").send({ path: "/Documents/a.pdf", expireDate: d });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
      "session-token",
      "/Documents/a.pdf",
      expect.objectContaining({ expireDate: d }),
    );
  });

  it("a one-character password is rejected and never echoed", async () => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Documents/a.pdf", password: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("public_link_password_too_short");
    expect(JSON.stringify(res.body)).not.toContain('"x"');
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("an 8-character password is accepted", async () => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Documents/a.pdf", password: "12345678" });
    expect(res.status).toBe(200);
  });

  it.each([
    ["create+read on a folder (5)", 5],
    ["delete+read (9)", 9],
    ["full folder edit (15)", 15],
  ])("member: public link with %s is refused without a folder lookup", async (_l, permissions) => {
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Documents/Reports", permissions });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("public_link_edit_admin_only");
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("member: update bit (3) on a FOLDER is refused", async () => {
    ncMock.ncIsDirectory.mockResolvedValue(true);
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Documents/Reports", permissions: 3 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("public_link_edit_admin_only");
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("member: update bit (3) on a single FILE stays allowed (the 'can edit' level)", async () => {
    ncMock.ncIsDirectory.mockResolvedValue(false);
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Documents/a.docx", permissions: 3 });
    expect(res.status).toBe(200);
  });

  it("member: an unanswerable folder lookup fails closed", async () => {
    ncMock.ncIsDirectory.mockRejectedValue(new Error("PROPFIND failed: 500"));
    const res = await request(app(MEMBER))
      .post("/api/files/share")
      .send({ path: "/Documents/a.docx", permissions: 3 });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
  });

  it("admin: a writable folder link is still allowed", async () => {
    const res = await request(app(ADMIN))
      .post("/api/files/share")
      .send({ path: "/Documents/Reports", permissions: 15 });
    expect(res.status).toBe(200);
    expect(ncMock.ncIsDirectory).not.toHaveBeenCalled();
  });
});

describe("WARP-3586 — PUT /files/share/:id keeps the rules", () => {
  it("clearing the expiry of a public link is rejected", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, path: "/Documents/a.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ expireDate: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("public_link_expiry_required");
    expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
  });

  it("pushing the expiry beyond 90 days is rejected, even for an admin", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, path: "/Documents/a.pdf" });
    const res = await request(app(ADMIN)).put("/api/files/share/7").send({ expireDate: inDays(400) });
    expect(res.status).toBe(400);
    expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
  });

  it("a short replacement password is rejected", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, path: "/Documents/a.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ password: "short" });
    expect(res.status).toBe(400);
    expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
  });

  it("member raising a personal link to folder write access is refused", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, path: "/Documents/Reports" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ permissions: 15 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("public_link_edit_admin_only");
    expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
  });

  it("a valid expiry and password update goes through", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, path: "/Documents/a.pdf" });
    const d = inDays(10);
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ expireDate: d, password: "longenough" });
    expect(res.status).toBe(200);
    expect(ncMock.ncUpdateShare).toHaveBeenCalledWith("session-token", 7, "expireDate", d);
  });

  it("an internal share's fields are not policed as a public link", async () => {
    ncMock.ncGetShare.mockResolvedValue({ ...created, shareType: 0, path: "/Documents/a.pdf" });
    const res = await request(app(MEMBER)).put("/api/files/share/7").send({ expireDate: "" });
    expect(res.status).toBe(200);
  });
});

describe("WARP-3586 — share-policy public-link rules", () => {
  const now = new Date("2026-10-03T12:00:00Z");

  it("expiry: the ceiling is day 90 inclusive; missing, malformed and empty are violations", () => {
    expect(publicLinkExpiryViolation("2027-01-01", now)).toBeNull(); // day 90
    expect(publicLinkExpiryViolation("2027-01-02", now)?.error).toBe("public_link_expiry_too_far");
    expect(publicLinkExpiryViolation("", now)?.error).toBe("public_link_expiry_required");
    expect(publicLinkExpiryViolation(undefined, now)?.error).toBe("public_link_expiry_required");
    expect(publicLinkExpiryViolation("next week", now)?.error).toBe("public_link_expiry_required");
  });

  it("default expiry is 30 days out", () => {
    expect(defaultPublicLinkExpiry(now)).toBe("2026-11-02");
  });

  it("password: optional, 8+ when present", () => {
    expect(publicLinkPasswordViolation(undefined)).toBeNull();
    expect(publicLinkPasswordViolation("1234567")?.error).toBe("public_link_password_too_short");
    expect(publicLinkPasswordViolation("12345678")).toBeNull();
  });

  it("member write cap: create/delete always, update only on a folder; owner/admin never", () => {
    expect(memberPublicLinkWriteRefused("family", 1, true)).toBe(false);
    expect(memberPublicLinkWriteRefused("family", 3, false)).toBe(false);
    expect(memberPublicLinkWriteRefused("family", 3, true)).toBe(true);
    expect(memberPublicLinkWriteRefused("family", 5, false)).toBe(true);
    expect(memberPublicLinkWriteRefused("family", 9, false)).toBe(true);
    expect(memberPublicLinkWriteRefused(undefined, 15, true)).toBe(true);
    expect(memberPublicLinkWriteRefused("admin", 15, true)).toBe(false);
    expect(memberPublicLinkWriteRefused("owner", 15, true)).toBe(false);
  });
});
