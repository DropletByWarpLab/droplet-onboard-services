/**
 * WARP-3061 — content search through the assistant widens to the ACTING
 * person's departments, and SSO / SCIM people are people too.
 *
 * `GET /api/files/search/content` adds one `__dept_<uuid>__` corpus per
 * department the caller may read. For `_service:mcp` the caller is whoever
 * `X-Nextcloud-User` names, which is `User.username` (stdio) or `User.id`
 * (HTTP transport), never `nextcloudUsername`: that column is NULL on every
 * SSO- and SCIM-created row, and resolving by it dropped those people to
 * their personal corpus alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";

const { searchByLexicalSpy } = vi.hoisted(() => ({ searchByLexicalSpy: vi.fn() }));
vi.mock("../services/file-search.service.js", () => ({
  searchByLexical: (...args: unknown[]) => searchByLexicalSpy(...args),
  searchHybrid: vi.fn(),
}));

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return { NextcloudOcsError: actual.NextcloudOcsError, ncSearchFiles: vi.fn(async () => []) };
});
vi.mock("../services/nextcloud-session.service.js", () => ({ resolveNcToken: vi.fn() }));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  invalidatePrefix: vi.fn().mockResolvedValue(0),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../config.js", () => ({
  config: { MAX_UPLOAD_SIZE_MB: 10, NODE_ENV: "test", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { createFilesRouter } from "../routes/files.js";

const FINANCE = { id: "dept-finance", kind: "DEPARTMENT", aclVersion: 3 };
const MARIA: DirectoryUser = { id: "u-maria", username: "maria", nextcloudUsername: null, role: "family" };

function appWith(users: DirectoryUser[], memberOf: Record<string, (typeof FINANCE)[]>) {
  const prisma = {
    user: userDirectory(users),
    departmentMembership: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        (memberOf[where.userId] ?? []).map((department) => ({ department })),
      ),
    },
    department: { findMany: vi.fn(async () => []) },
  };
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: object }).user = { id: "_service:mcp", username: "_service:mcp", role: "service" };
    next();
  });
  app.use("/api", createFilesRouter(prisma as never));
  return app;
}

async function searchAs(app: express.Express, asserted: string) {
  const res = await request(app)
    .get("/api/files/search/content?q=budget&mode=keyword")
    .set("X-Nextcloud-User", asserted)
    .set("X-Nextcloud-Token", "nc-app-password");
  expect(res.status).toBe(200);
  expect(searchByLexicalSpy).toHaveBeenCalledTimes(1);
  return searchByLexicalSpy.mock.calls[0][1] as { userId: string; additionalUserIds: string[] };
}

beforeEach(() => {
  searchByLexicalSpy.mockReset().mockResolvedValue([]);
});

describe("WARP-3061 — the assistant searches an SSO person's departments", () => {
  it("adds the department corpus of an SSO member named by username", async () => {
    const params = await searchAs(appWith([MARIA], { "u-maria": [FINANCE] }), "maria");
    expect(params.additionalUserIds).toEqual(["__dept_dept-finance__"]);
  });

  it("adds it when the HTTP transport names them by User.id", async () => {
    const params = await searchAs(appWith([MARIA], { "u-maria": [FINANCE] }), "u-maria");
    expect(params.additionalUserIds).toEqual(["__dept_dept-finance__"]);
  });

  it("searches personal files only when the value is two different people", async () => {
    // maria's username is marianne's nextcloudUsername. Before WARP-3061 this
    // searched MARIANNE's departments on maria's behalf.
    const marianne: DirectoryUser = {
      id: "u-marianne",
      username: "marianne",
      nextcloudUsername: "maria",
      role: "family",
    };
    const params = await searchAs(appWith([MARIA, marianne], { "u-marianne": [FINANCE] }), "maria");
    expect(params.additionalUserIds).toEqual([]);
  });
});
