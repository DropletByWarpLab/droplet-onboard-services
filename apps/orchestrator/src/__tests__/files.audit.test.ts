/**
 * WARP-3587 — every mutating files route writes ONE activity row naming the
 * person who acted and the path acted on, through the same signed-chain writer
 * the download and share-create rows already use.
 *
 * The REAL `createFilesRouter` and space gate run over a small prisma stub;
 * only the Nextcloud client and the activity recorder are doubled. Rows are
 * matched by `what`, so the space gate's own "Admin space entry" rows do not
 * count against "exactly one".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { userDirectory } from "./helpers/user-directory.js";

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return {
    NextcloudOcsError: actual.NextcloudOcsError,
    NcPreconditionFailedError: actual.NcPreconditionFailedError,
    ncListFiles: vi.fn(),
    ncStageUpload: vi.fn(),
    ncCommitUpload: vi.fn(),
    ncDiscardUpload: vi.fn(),
    ncUploadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncMoveFile: vi.fn(),
    ncCopyFile: vi.fn(),
    ncGetFileId: vi.fn(),
    ncRestoreTrashItem: vi.fn(),
    ncDeleteTrashItem: vi.fn(),
    ncEmptyTrash: vi.fn(),
    ncRestoreVersion: vi.fn(),
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
  invalidatePrefix: vi.fn().mockResolvedValue(0),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../config.js", () => ({
  config: {
    MAX_UPLOAD_SIZE_MB: 10,
    NODE_ENV: "test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { createFilesRouter } from "../routes/files.js";
import * as nc from "../services/nextcloud.client.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import type { RecordParams } from "../services/activity.service.js";

type Mocked<T extends (...a: any[]) => any> = T & ReturnType<typeof vi.fn>;
const ncMock = nc as unknown as { [K in keyof typeof nc]: Mocked<any> };

const WORKSPACE = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Household",
  parentId: null,
  kind: "HOUSEHOLD",
  state: "active",
};
const MEMBER = { id: "u-member", username: "member", role: "family" };
const OWNER = { id: "u-owner", username: "owner1", role: "owner" };
const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };

const prismaStub = {
  department: {
    findFirst: vi.fn(async (args?: { where?: { kind?: string } }) =>
      args?.where?.kind === "HOUSEHOLD" ? WORKSPACE : null,
    ),
    findUnique: vi.fn(async (args?: { where?: { id?: string } }) =>
      args?.where?.id === WORKSPACE.id ? WORKSPACE : null,
    ),
    findMany: vi.fn(async () => []),
  },
  departmentMembership: {
    findUnique: vi.fn(async () => ({ right: "contributor", syncState: "active" })),
    findMany: vi.fn(async () => []),
  },
  departmentShare: { findUnique: vi.fn(async () => null) },
  user: userDirectory([
    { id: "u-member", username: "member", nextcloudUsername: "member", role: "family" },
  ]),
};

function appFor(user: { id: string; username: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof user }).user = user;
    next();
  });
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

const rows: RecordParams[] = [];
const rowsOf = (what: string) => rows.filter((r) => r.what === what);
function onlyRow(what: string): RecordParams {
  const found = rowsOf(what);
  expect(found).toHaveLength(1);
  return found[0];
}

beforeEach(() => {
  rows.length = 0;
  _setActivityRecorderForTests(
    {
      record: async (p) => {
        rows.push(p);
        return {} as never;
      },
    },
    null,
  );
  for (const fn of Object.values(ncMock)) {
    if (typeof (fn as any)?.mockReset === "function") (fn as any).mockReset();
  }
  ncMock.ncStageUpload.mockImplementation(
    async (_t: string, _u: string, _id: string, body: AsyncIterable<Buffer>) => {
      for await (const _c of body) {
        /* drain like the real streamed PUT */
      }
    },
  );
  ncMock.ncCommitUpload.mockResolvedValue("created");
  ncMock.ncDiscardUpload.mockResolvedValue(undefined);
  for (const k of [
    "ncDeleteFile", "ncMoveFile", "ncCopyFile", "ncRestoreTrashItem", "ncDeleteTrashItem",
    "ncEmptyTrash", "ncRestoreVersion", "ncUpdateShare", "ncDeleteShare",
  ] as const) {
    ncMock[k].mockResolvedValue(undefined);
  }
  ncMock.ncGetFileId.mockResolvedValue(42);
  ncMock.ncGetShare.mockResolvedValue({ path: "/Reports/q3.pdf", shareType: 3 });
});

describe("WARP-3587 — file changes are audited with the acting person", () => {
  const humanActor = { type: "user", id: MEMBER.id };

  it("DELETE /files: an image outside the indexer's types still gets a row", async () => {
    const res = await request(appFor(MEMBER)).delete("/api/files").query({ path: "/photos/cat.png" });
    expect(res.status).toBe(200);
    const row = onlyRow("File deleted");
    expect(row.actor).toEqual(humanActor);
    expect(row.sub).toBe("/photos/cat.png");
    expect(row.refs).toMatchObject({ path: "/photos/cat.png", space: "personal" });
  });

  it("DELETE /files: a Workspace file records the Workspace path", async () => {
    const res = await request(appFor(MEMBER))
      .delete("/api/files")
      .query({ path: "/Plan.docx", space: "shared" });
    expect(res.status).toBe(200);
    const row = onlyRow("File deleted");
    expect(row.actor).toEqual(humanActor);
    expect(row.refs).toMatchObject({ path: "/Household/Plan.docx", space: "shared" });
  });

  it("DELETE /files: a failed delete writes no row", async () => {
    ncMock.ncDeleteFile.mockRejectedValueOnce(new Error("WebDAV DELETE failed: 500"));
    const res = await request(appFor(MEMBER)).delete("/api/files").query({ path: "/a.txt" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(rowsOf("File deleted")).toHaveLength(0);
  });

  it("POST /files/bulk-delete: one row listing the paths that were deleted", async () => {
    ncMock.ncDeleteFile.mockImplementation(async (_t: string, _u: string, p: string) => {
      if (p === "/bad.txt") throw new Error("403");
    });
    const res = await request(appFor(MEMBER))
      .post("/api/files/bulk-delete")
      .send({ paths: ["/a.txt", "/bad.txt", "/b.txt"] });
    expect(res.status).toBe(207);
    const row = onlyRow("Files deleted");
    expect(row.actor).toEqual(humanActor);
    expect(row.refs).toMatchObject({ paths: ["/a.txt", "/b.txt"], count: 2, total: 3 });
  });

  it("POST /files/rename", async () => {
    await request(appFor(MEMBER)).post("/api/files/rename").send({ path: "/docs/old.txt", newName: "new.txt" }).expect(200);
    const row = onlyRow("File renamed");
    expect(row.actor).toEqual(humanActor);
    expect(row.refs).toMatchObject({ from: "/docs/old.txt", to: "/docs/new.txt" });
  });

  it("POST /files/move and /files/copy", async () => {
    const app = appFor(MEMBER);
    await request(app).post("/api/files/move").send({ from: "/a.txt", to: "/archive/a.txt" }).expect(200);
    await request(app).post("/api/files/copy").send({ from: "/a.txt", to: "/b.txt" }).expect(200);
    expect(onlyRow("File moved").refs).toMatchObject({ from: "/a.txt", to: "/archive/a.txt" });
    expect(onlyRow("File moved").actor).toEqual(humanActor);
    expect(onlyRow("File copied").refs).toMatchObject({ from: "/a.txt", to: "/b.txt" });
    expect(onlyRow("File copied").actor).toEqual(humanActor);
  });

  it("POST /files/bulk-move and /files/bulk-copy", async () => {
    const app = appFor(MEMBER);
    await request(app).post("/api/files/bulk-move").send({ paths: ["/a.txt", "/b.txt"], toDir: "/archive" }).expect(200);
    await request(app).post("/api/files/bulk-copy").send({ paths: ["/a.txt"], toDir: "/backup" }).expect(200);
    expect(onlyRow("Files moved").refs).toMatchObject({ paths: ["/a.txt", "/b.txt"], toDir: "/archive" });
    expect(onlyRow("Files copied").refs).toMatchObject({ paths: ["/a.txt"], toDir: "/backup" });
  });

  it("trash restore, single purge and empty", async () => {
    const app = appFor(MEMBER);
    await request(app).post("/api/files/trash/restore").send({ name: "a.txt.d123" }).expect(200);
    await request(app).delete("/api/files/trash/item").query({ name: "b.txt.d124" }).expect(200);
    await request(app).delete("/api/files/trash").expect(200);
    expect(onlyRow("File restored from trash").refs).toMatchObject({ name: "a.txt.d123" });
    expect(onlyRow("File purged from trash").refs).toMatchObject({ name: "b.txt.d124" });
    expect(onlyRow("Trash emptied").actor).toEqual(humanActor);
    expect(onlyRow("Trash emptied").refs).toMatchObject({ space: "personal" });
  });

  it("emptying the Workspace trash records the Workspace space", async () => {
    await request(appFor(MEMBER)).delete("/api/files/trash").query({ space: "shared" }).expect(200);
    expect(onlyRow("Trash emptied").refs).toMatchObject({ space: "shared" });
  });

  it("POST /files/versions/restore", async () => {
    await request(appFor(MEMBER)).post("/api/files/versions/restore").send({ path: "/a.txt", versionId: "v1" }).expect(200);
    const row = onlyRow("File version restored");
    expect(row.actor).toEqual(humanActor);
    expect(row.refs).toMatchObject({ path: "/a.txt", versionId: "v1" });
  });

  it("POST /files/upload: one row with the stored paths, never the contents", async () => {
    const res = await request(appFor(MEMBER))
      .post("/api/files/upload")
      .query({ path: "/Reports" })
      .attach("files", Buffer.from("top secret body"), "q3.txt");
    expect(res.status).toBe(200);
    const row = onlyRow("File uploaded");
    expect(row.actor).toEqual(humanActor);
    expect(row.refs).toMatchObject({ paths: ["/Reports/q3.txt"], count: 1 });
    expect(JSON.stringify(row)).not.toContain("top secret body");
  });

  it("PUT /files/share/:id: a password change is recorded as a flag, never the value", async () => {
    const res = await request(appFor(OWNER))
      .put("/api/files/share/9")
      .send({ password: "Hunter2-Hunter2", note: "for the auditor", expireDate: "2027-01-01" });
    expect(res.status).toBe(200);
    const row = onlyRow("Share updated");
    expect(row.actor).toEqual({ type: "user", id: OWNER.id });
    expect(row.refs).toMatchObject({
      shareId: 9,
      path: "/Reports/q3.pdf",
      passwordChanged: true,
      noteChanged: true,
      expireDate: "2027-01-01",
    });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("Hunter2");
    expect(serialized).not.toContain("for the auditor");
  });

  it("DELETE /files/share/:id: a personal share revoke is audited too", async () => {
    await request(appFor(OWNER)).delete("/api/files/share/9").expect(200);
    const row = onlyRow("Share revoked");
    expect(row.actor).toEqual({ type: "user", id: OWNER.id });
    expect(row.refs).toMatchObject({ shareId: 9, path: "/Reports/q3.pdf", departmentId: null });
  });

  it("a share whose path OCS cannot report still audits, by share id", async () => {
    ncMock.ncGetShare.mockRejectedValue(new Error("OCS down"));
    await request(appFor(OWNER)).delete("/api/files/share/9").expect(200);
    const row = onlyRow("Share revoked");
    expect(row.sub).toBe("9");
    expect(row.refs).toMatchObject({ shareId: 9, path: null });
  });

  it("the MCP service principal is attributed to the asserted person, not an anonymous system", async () => {
    const res = await request(appFor(MCP))
      .delete("/api/files")
      .query({ path: "/old.txt" })
      .set("X-Nextcloud-Token", "nct")
      .set("X-Nextcloud-User", "member");
    expect(res.status).toBe(200);
    const row = onlyRow("File deleted");
    expect(row.actor).toEqual({ type: "ai", id: MEMBER.id });
    expect(row.refs).toMatchObject({ path: "/old.txt", principal: "mcp" });

    await request(appFor(MCP))
      .post("/api/files/move")
      .set("X-Nextcloud-Token", "nct")
      .set("X-Nextcloud-User", "member")
      .send({ from: "/docs/a.txt", to: "/docs/b.txt" })
      .expect(200);
    expect(onlyRow("File moved").actor).toEqual({ type: "ai", id: MEMBER.id });
  });
});
