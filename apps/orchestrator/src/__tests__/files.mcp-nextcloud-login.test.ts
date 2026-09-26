/**
 * WARP-3117 — /api/files acts as the asserted person's Nextcloud LOGIN.
 *
 * The MCP file tools reach these routes as `_service:mcp` with the person in
 * X-Nextcloud-User: `User.username` on stdio, `User.id` over the HTTP
 * transport, never `User.nextcloudUsername`. `getUser()` used to hand that
 * value straight to the Nextcloud client as the WebDAV user, so over HTTP
 * every file call went to /remote.php/dav/files/<User.id>/…, and a header
 * naming two people, nobody, or a deactivated person was never checked.
 *
 * The person is now resolved (`resolveAssertedUser`) and mapped to their
 * `nextcloudUsername`. A person with none — every SSO / SCIM row — has no
 * Nextcloud account and is refused with 403 before any Nextcloud call. Human
 * sessions are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return {
    NextcloudOcsError: actual.NextcloudOcsError,
    ncListFiles: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncDownloadFile: vi.fn(),
  };
});

const mockResolveNcToken = vi.fn();
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: (...a: unknown[]) => mockResolveNcToken(...a),
}));

// Pass-through misses so every request reaches the (mocked) Nextcloud client.
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  invalidatePrefix: vi.fn().mockResolvedValue(0),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    MAX_UPLOAD_SIZE_MB: 10,
    NODE_ENV: "test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Same guard doubles as files.mcp-service.test.ts: this file is about WHO the
// Nextcloud client is called as, not which guard a route uses.
vi.mock("../middleware/auth.js", () => ({
  requireRole:
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as Request & { user?: { role?: string } }).user?.role;
      if (!role || !roles.includes(role)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    },
  requireRoleOrMcpService:
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const u = (req as Request & { user?: { id?: string; role?: string } }).user;
      if (u?.id === "_service:mcp" && u.role === "service") {
        next();
        return;
      }
      if (!u?.role || !roles.includes(u.role)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    },
}));

import { createFilesRouter } from "../routes/files.js";
import * as nc from "../services/nextcloud.client.js";

const ncListFiles = nc.ncListFiles as unknown as ReturnType<typeof vi.fn>;
const ncCreateDirectory = nc.ncCreateDirectory as unknown as ReturnType<typeof vi.fn>;
const ncDownloadFile = nc.ncDownloadFile as unknown as ReturnType<typeof vi.fn>;

// ALICE's Nextcloud login differs from her handle, as ADR-013 allows.
const ALICE: DirectoryUser = { id: "u-alice", username: "alice", nextcloudUsername: "alice.nc", role: "family" };
// SSO / SCIM-provisioned: an active person with no Nextcloud account.
const CAROL: DirectoryUser = { id: "u-carol", username: "carol", nextcloudUsername: null, role: "owner" };
// "sam" is SAM's username and SAMANTHA's Nextcloud login: two people.
const SAM: DirectoryUser = { id: "u-sam", username: "sam", nextcloudUsername: "samuel", role: "family" };
const SAMANTHA: DirectoryUser = { id: "u-samantha", username: "samantha", nextcloudUsername: "sam", role: "family" };
const GONE: DirectoryUser = { id: "u-gone", username: "gone", nextcloudUsername: "gone", role: "family", directoryStatus: "DEACTIVATED" };

function buildApp(asUser: { id: string; username: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  const prismaStub = {
    fileCitation: { findMany: vi.fn().mockResolvedValue([]) },
    user: userDirectory([ALICE, CAROL, SAM, SAMANTHA, GONE]),
  };
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };
const HUMAN = { id: "u-1", username: "romain", role: "family" };

function listAs(asserted: string) {
  return request(buildApp(MCP))
    .get("/api/files?path=/photos")
    .set("X-Nextcloud-Token", "nct-user-cred")
    .set("X-Nextcloud-User", asserted);
}

beforeEach(() => {
  ncListFiles.mockReset().mockResolvedValue([{ name: "a.txt" }]);
  ncCreateDirectory.mockReset().mockResolvedValue(undefined);
  ncDownloadFile.mockReset().mockResolvedValue(null);
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
});

describe("WARP-3117 — /api/files for the MCP principal acts as the person's Nextcloud login", () => {
  it("maps a User.id (the HTTP transport) to the Nextcloud login", async () => {
    const res = await listAs("u-alice");

    expect(res.status).toBe(200);
    expect(ncListFiles).toHaveBeenCalledWith("nct-user-cred", "alice.nc", "/photos");
  });

  it("maps a username (stdio) to the Nextcloud login, not the username", async () => {
    const res = await listAs("alice");

    expect(res.status).toBe(200);
    expect(ncListFiles).toHaveBeenCalledWith("nct-user-cred", "alice.nc", "/photos");
  });

  it("uses the same login on a write route (mkdir)", async () => {
    const res = await request(buildApp(MCP))
      .post("/api/files/mkdir")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "u-alice")
      .send({ path: "/new-folder" });

    expect(res.status).toBe(200);
    expect(ncCreateDirectory).toHaveBeenCalledWith("nct-user-cred", "alice.nc", "/new-folder");
  });

  it("uses the same login on a download", async () => {
    await request(buildApp(MCP))
      .get("/api/files/download?path=/photos/a.jpg")
      .set("X-Nextcloud-Token", "nct-user-cred")
      .set("X-Nextcloud-User", "u-alice");

    expect(ncDownloadFile).toHaveBeenCalledWith("nct-user-cred", "alice.nc", "/photos/a.jpg");
  });

  it("refuses a value naming two people with 403, before any Nextcloud call", async () => {
    const res = await listAs("sam");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "asserted_user_unresolved", reason: "ambiguous" });
    expect(ncListFiles).not.toHaveBeenCalled();
  });

  it("refuses an SSO / SCIM person with 403 no_nextcloud_account, and never falls back to the username", async () => {
    for (const asserted of ["u-carol", "carol"]) {
      const res = await listAs(asserted);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("no_nextcloud_account");
    }
    expect(ncListFiles).not.toHaveBeenCalled();
  });

  it("refuses a deactivated person, whose Nextcloud token may still be live", async () => {
    const res = await listAs("u-gone");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "asserted_user_unresolved", reason: "deactivated" });
    expect(ncListFiles).not.toHaveBeenCalled();
  });

  it("refuses a value naming nobody", async () => {
    const res = await listAs("u-nobody");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "asserted_user_unresolved", reason: "not_found" });
    expect(ncListFiles).not.toHaveBeenCalled();
  });

  it("leaves human sessions on their own username and session token", async () => {
    const res = await request(buildApp(HUMAN))
      .get("/api/files?path=/")
      .set("X-Nextcloud-Token", "attacker-token")
      .set("X-Nextcloud-User", "u-alice");

    expect(res.status).toBe(200);
    expect(ncListFiles).toHaveBeenCalledWith("session-token", "romain", "/");
  });
});
