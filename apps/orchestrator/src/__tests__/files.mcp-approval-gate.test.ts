/**
 * WARP-3193 SEC-INJ-2 — the file writes that destroy or expose data need the
 * user, not just the model.
 *
 * move_file / copy_file reach POST /files/move|copy as `_service:mcp`, so the
 * routes mirror the tools-core refusal for that principal: no overwrite, and
 * no move/copy of a file INTO a shared folder (Household or a department
 * mount) from outside it — that would publish a private file without
 * share_file's gate. write_file asks /files/upload for a create-only write
 * (`createOnly: true` → `If-None-Match: *` → 409 when the target exists).
 *
 * A human session is untouched: the dashboard click IS the approval.
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
    NcPreconditionFailedError: actual.NcPreconditionFailedError,
    ncUploadFile: vi.fn(),
    ncMoveFile: vi.fn(),
    ncCopyFile: vi.fn(),
    ncGetFileId: vi.fn(),
  };
});

vi.mock("../services/file-registry.service.js", () => ({
  resolveFileDepartment: vi.fn().mockResolvedValue(null),
  upsertFileRegistryEntry: vi.fn().mockResolvedValue(undefined),
  findSameContentCandidates: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("session-token"),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  invalidatePrefix: vi.fn().mockResolvedValue(0),
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
import { userDirectory } from "./helpers/user-directory.js";

const ncUploadFile = nc.ncUploadFile as unknown as ReturnType<typeof vi.fn>;
const ncMoveFile = nc.ncMoveFile as unknown as ReturnType<typeof vi.fn>;
const ncCopyFile = nc.ncCopyFile as unknown as ReturnType<typeof vi.fn>;
const ncGetFileId = nc.ncGetFileId as unknown as ReturnType<typeof vi.fn>;

function buildApp(
  asUser: { id: string; username: string; role: string },
  opts: { deptLookupFails?: boolean } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  const prismaStub = {
    department: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      // One active department mounted as "/Engineering" in every member's home.
      findMany: opts.deptLookupFails
        ? vi.fn().mockRejectedValue(new Error("db down"))
        : vi.fn().mockResolvedValue([
            { name: "Engineering", kind: "DEPARTMENT", parentId: null, memberships: [] },
          ]),
    },
    departmentMembership: { findUnique: vi.fn().mockResolvedValue(null) },
    user: userDirectory([{ id: "u-alice", username: "alice", nextcloudUsername: "alice", role: "family" }]),
    userUsagePolicy: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };
const FAMILY = { id: "u-1", username: "romain", role: "family" };

function asMcp(r: request.Test): request.Test {
  return r.set("X-Nextcloud-Token", "nct").set("X-Nextcloud-User", "alice");
}

beforeEach(() => {
  ncUploadFile.mockReset().mockResolvedValue("created");
  ncMoveFile.mockReset().mockResolvedValue(undefined);
  ncCopyFile.mockReset().mockResolvedValue(undefined);
  ncGetFileId.mockReset().mockResolvedValue(null);
});

describe("SEC-INJ-2 — /files/move and /files/copy for the mcp principal", () => {
  for (const [route, fn] of [
    ["move", () => ncMoveFile],
    ["copy", () => ncCopyFile],
  ] as const) {
    it(`${route}: fails CLOSED when the department list cannot be resolved`, async () => {
      const res = await asMcp(request(buildApp(MCP, { deptLookupFails: true })).post(`/api/files/${route}`)).send({
        from: "/private/a.txt",
        to: "/Engineering/specs/a.txt",
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("USER_APPROVAL_REQUIRED");
      expect(fn()).not.toHaveBeenCalled();
    });

    it(`${route}: still allows a move within one folder when the department list cannot be resolved`, async () => {
      const res = await asMcp(request(buildApp(MCP, { deptLookupFails: true })).post(`/api/files/${route}`)).send({
        from: "/private/a.txt",
        to: "/private/b.txt",
      });
      expect(res.body.code).not.toBe("USER_APPROVAL_REQUIRED");
      expect(fn()).toHaveBeenCalled();
    });

    it(`${route}: refuses overwrite=true with USER_APPROVAL_REQUIRED`, async () => {
      const res = await asMcp(request(buildApp(MCP)).post(`/api/files/${route}`)).send({
        from: "/a.txt",
        to: "/Finance",
        overwrite: true,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("USER_APPROVAL_REQUIRED");
      expect(fn()).not.toHaveBeenCalled();
    });

    it.each(["/Household/a.txt", "/Household", "/Engineering/specs/a.txt"])(
      `${route}: refuses a private file into the shared folder %s`,
      async (to) => {
        const res = await asMcp(request(buildApp(MCP)).post(`/api/files/${route}`)).send({
          from: "/private/a.txt",
          to,
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("USER_APPROVAL_REQUIRED");
        expect(res.body.error).toMatch(/shared folder/);
        expect(fn()).not.toHaveBeenCalled();
      },
    );

    // The tool never sends a space; an explicit toSpace is refused either by
    // the space gate or by the mount check (rootForSpace yields /Household/…).
    it(`${route}: refuses toSpace=shared from a personal source`, async () => {
      const res = await asMcp(request(buildApp(MCP)).post(`/api/files/${route}`)).send({
        from: "/private/a.txt",
        to: "/a.txt",
        toSpace: "shared",
      });
      expect(res.status).toBe(403);
      expect(fn()).not.toHaveBeenCalled();
    });

    it(`${route}: allows a move inside the same shared folder`, async () => {
      const res = await asMcp(request(buildApp(MCP)).post(`/api/files/${route}`)).send({
        from: "/Household/a.txt",
        to: "/Household/Trips/a.txt",
      });
      expect(res.status).toBe(200);
      expect(fn()).toHaveBeenCalled();
    });

    it(`${route}: allows an ordinary personal move`, async () => {
      const res = await asMcp(request(buildApp(MCP)).post(`/api/files/${route}`)).send({
        from: "/a.txt",
        to: "/Notes/a.txt",
      });
      expect(res.status).toBe(200);
      expect(fn()).toHaveBeenCalledWith("nct", "alice", "/a.txt", "/Notes/a.txt", false);
    });

    it(`${route}: a human session keeps overwrite and shared destinations`, async () => {
      const res = await request(buildApp(FAMILY)).post(`/api/files/${route}`).send({
        from: "/a.txt",
        to: "/Household/a.txt",
        overwrite: true,
      });
      expect(res.status).toBe(200);
      expect(fn()).toHaveBeenCalledWith("session-token", "romain", "/a.txt", "/Household/a.txt", true);
    });
  }
});

describe("SEC-INJ-2 — /files/upload createOnly (write_file)", () => {
  const body = { dir: "/Notes", filename: "a.md", contentBase64: Buffer.from("x").toString("base64") };

  it("createOnly=true PUTs with If-None-Match", async () => {
    const res = await asMcp(request(buildApp(MCP)).post("/api/files/upload")).send({
      ...body,
      createOnly: true,
    });
    expect(res.status).toBe(200);
    expect(ncUploadFile).toHaveBeenCalledWith("nct", "alice", "/Notes", "a.md", expect.any(Buffer), {
      ifNoneMatch: true,
    });
  });

  it("createOnly=true over an existing file answers 409", async () => {
    ncUploadFile.mockRejectedValueOnce(new nc.NcPreconditionFailedError());
    const res = await asMcp(request(buildApp(MCP)).post("/api/files/upload")).send({
      ...body,
      createOnly: true,
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "file already exists", path: "/Notes/a.md" });
  });
});
