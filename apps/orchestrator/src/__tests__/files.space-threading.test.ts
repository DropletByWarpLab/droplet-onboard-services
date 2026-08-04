/**
 * WARP-1262 (T10) — server-side `?space=` threading on write routes +
 * the move/copy cross-space dual-check.
 *
 * Builds the real `createFilesRouter` directly (like files.mcp-service.test.ts)
 * with a tiny configurable prisma stub for `department`/`departmentMembership`
 * — the REAL `requireSpaceAccess`/`checkSpaceAccess`/`rootForSpace` machinery
 * runs, only the Nextcloud client + DB reads are mocked. This is what proves
 * each write ROUTE actually composes the gate + resolves the operational path
 * (the truth table itself is exhaustively covered by space-access.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return {
    NextcloudOcsError: actual.NextcloudOcsError,
    ncListFiles: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncUploadFile: vi.fn(),
    ncDownloadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncListShares: vi.fn(),
    ncMoveFile: vi.fn(),
    ncCopyFile: vi.fn(),
    ncGetFileId: vi.fn(),
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
  };
});

const mockResolveNcToken = vi.fn();
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: (...a: unknown[]) => mockResolveNcToken(...a),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  // WARP-1682: invalidateListing falls back to a prefix sweep when the
  // caller's ACL tag cannot be resolved, which is the state these stubs put
  // it in — the double has to carry the whole module surface it exercises.
  invalidatePrefix: vi.fn().mockResolvedValue(0),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

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

type Mocked<T extends (...a: any[]) => any> = T & ReturnType<typeof vi.fn>;
const ncMock = nc as unknown as { [K in keyof typeof nc]: Mocked<any> };

// ── Configurable prisma stub — `department` + `departmentMembership` only;
// every other model write routes touch (file registry) is left undefined so
// its non-fatal try/catch paths absorb the TypeError (mirrors setup.ts's
// documented tolerance for the same shape in files.test.ts).
interface DeptRow {
  id: string;
  name: string;
  parentId: string | null;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  state: string;
}

function makePrismaStub(opts: {
  household?: DeptRow;
  departments?: DeptRow[];
  memberships?: Array<{ departmentId: string; userId: string; right: string }>;
}) {
  const byId = new Map<string, DeptRow>();
  if (opts.household) byId.set(opts.household.id, opts.household);
  for (const d of opts.departments ?? []) byId.set(d.id, d);

  return {
    department: {
      findFirst: vi.fn(async (args?: { where?: { kind?: string } }) =>
        args?.where?.kind === "HOUSEHOLD" ? opts.household ?? null : null,
      ),
      findUnique: vi.fn(async (args?: { where?: { id?: string } }) => {
        const id = args?.where?.id;
        return (id && byId.get(id)) ?? null;
      }),
    },
    departmentMembership: {
      findUnique: vi.fn(
        async (args?: { where?: { departmentId_userId?: { departmentId: string; userId: string } } }) => {
          const key = args?.where?.departmentId_userId;
          if (!key) return null;
          const found = (opts.memberships ?? []).find(
            (m) => m.departmentId === key.departmentId && m.userId === key.userId,
          );
          return found ? { right: found.right } : null;
        },
      ),
    },
  };
}

function buildApp(prisma: ReturnType<typeof makePrismaStub>, asUser: { id: string; username: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createFilesRouter(prisma as never));
  return app;
}

const DEPT_A: DeptRow = { id: "11111111-1111-4111-8111-111111111111", name: "Alpha", parentId: null, kind: "DEPARTMENT", state: "active" };
const DEPT_B: DeptRow = { id: "22222222-2222-4222-8222-222222222222", name: "Beta", parentId: null, kind: "DEPARTMENT", state: "active" };
const DEPT_PENDING: DeptRow = { id: "33333333-3333-4333-8333-333333333333", name: "Gamma", parentId: null, kind: "DEPARTMENT", state: "pending" };

const CONTRIB_A = { id: "u-contrib-a", username: "contrib-a", role: "family" };
const READER_A = { id: "u-reader-a", username: "reader-a", role: "family" };
const CONTRIB_B = { id: "u-contrib-b", username: "contrib-b", role: "family" };
const NO_MEMBER = { id: "u-no-member", username: "no-member", role: "family" };

const prismaFull = makePrismaStub({
  departments: [DEPT_A, DEPT_B, DEPT_PENDING],
  memberships: [
    { departmentId: DEPT_A.id, userId: CONTRIB_A.id, right: "contributor" },
    { departmentId: DEPT_A.id, userId: READER_A.id, right: "reader" },
    { departmentId: DEPT_B.id, userId: CONTRIB_B.id, right: "contributor" },
  ],
});

beforeEach(() => {
  for (const key of Object.keys(ncMock)) {
    const fn = (ncMock as any)[key];
    if (typeof fn?.mockReset === "function") fn.mockReset();
  }
  ncMock.ncCreateDirectory.mockResolvedValue(undefined);
  ncMock.ncUploadFile.mockResolvedValue(undefined);
  ncMock.ncDeleteFile.mockResolvedValue(undefined);
  ncMock.ncMoveFile.mockResolvedValue(undefined);
  ncMock.ncCopyFile.mockResolvedValue(undefined);
  ncMock.ncSetFavorite.mockResolvedValue(undefined);
  ncMock.ncEmptyTrash.mockResolvedValue(undefined);
  ncMock.ncRestoreTrashItem.mockResolvedValue(undefined);
  ncMock.ncDeleteTrashItem.mockResolvedValue(undefined);
  ncMock.ncGetFileId.mockResolvedValue(null);
  ncMock.ncRestoreVersion.mockResolvedValue(undefined);
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
});

describe("WARP-1262 (T10) — single-space write routes", () => {
  const app = buildApp(prismaFull, CONTRIB_A);
  const appReader = buildApp(prismaFull, READER_A);
  const appNoMember = buildApp(prismaFull, NO_MEMBER);

  it("mkdir: personal (no space param) behaves exactly like before — regression", async () => {
    const res = await request(app).post("/api/files/mkdir").send({ path: "/Documents/Invoices" });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateDirectory).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "/Documents/Invoices",
    );
  });

  it("mkdir: dept space resolves the path server-side under the dept mount", async () => {
    const res = await request(app)
      .post("/api/files/mkdir")
      .send({ path: "/Reports", space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(200);
    expect(ncMock.ncCreateDirectory).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "/Alpha/Reports",
    );
  });

  it("mkdir: reader-only member is denied contributor-gated mkdir (403, NC never called)", async () => {
    const res = await request(appReader)
      .post("/api/files/mkdir")
      .send({ path: "/Reports", space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateDirectory).not.toHaveBeenCalled();
  });

  it("mkdir: non-member of the dept is denied (403, NC never called)", async () => {
    const res = await request(appNoMember)
      .post("/api/files/mkdir")
      .send({ path: "/Reports", space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateDirectory).not.toHaveBeenCalled();
  });

  it("mkdir: pending (not-yet-active) dept space fails closed (403)", async () => {
    const res = await request(app)
      .post("/api/files/mkdir")
      .send({ path: "/Reports", space: `dept:${DEPT_PENDING.id}` });
    expect(res.status).toBe(403);
    expect(ncMock.ncCreateDirectory).not.toHaveBeenCalled();
  });

  it("delete: `?space=` (query) threads through to the resolved path", async () => {
    const res = await request(app)
      .delete("/api/files")
      .query({ path: "/Reports/old.pdf", space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(200);
    expect(ncMock.ncDeleteFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "/Alpha/Reports/old.pdf",
    );
  });

  it("delete: personal (no space) behaves exactly like before — regression", async () => {
    const res = await request(app).delete("/api/files").query({ path: "/old.pdf" });
    expect(res.status).toBe(200);
    expect(ncMock.ncDeleteFile).toHaveBeenCalledWith(expect.any(String), expect.any(String), "/old.pdf");
  });

  it("upload: `?space=` (query only — precedes multer) resolves the target dir", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .query({ path: "/Reports", space: `dept:${DEPT_A.id}` })
      .attach("files", Buffer.from("hello"), "report.txt");
    expect(res.status).toBe(200);
    expect(ncMock.ncUploadFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "/Alpha/Reports",
      "report.txt",
      expect.any(Buffer),
    );
  });

  it("upload: reader-only member is denied (403, NC never called)", async () => {
    const res = await request(appReader)
      .post("/api/files/upload")
      .query({ path: "/Reports", space: `dept:${DEPT_A.id}` })
      .attach("files", Buffer.from("hello"), "report.txt");
    expect(res.status).toBe(403);
    expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });

  it("rename: household alias ('shared') resolves under the configured shared-folder name", async () => {
    const householdApp = buildApp(
      makePrismaStub({
        household: { id: "44444444-4444-4444-8444-444444444444", name: "Household", parentId: null, kind: "HOUSEHOLD", state: "active" },
      }),
      { id: "u-owner", username: "dev", role: "owner" },
    );
    const res = await request(householdApp)
      .post("/api/files/rename")
      .send({ path: "/old.txt", newName: "new.txt", space: "shared" });
    expect(res.status).toBe(200);
    expect(ncMock.ncMoveFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "/Household/old.txt",
      "/Household/new.txt",
      false,
    );
  });

  it("favorite toggle: contributor gate + resolved path", async () => {
    const res = await request(app)
      .post("/api/files/favorite")
      .send({ path: "/Reports/q3.pdf", favorite: true, space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(200);
    expect(ncMock.ncSetFavorite).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "/Alpha/Reports/q3.pdf",
      true,
    );
  });

  it("version restore: resolved path feeds ncGetFileId + gate denies non-members", async () => {
    ncMock.ncGetFileId.mockResolvedValue(42);
    const res = await request(app)
      .post("/api/files/versions/restore")
      .send({ path: "/Reports/q3.pdf", versionId: "v1", space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(200);
    expect(ncMock.ncGetFileId).toHaveBeenCalledWith(expect.any(String), expect.any(String), "/Alpha/Reports/q3.pdf");
    ncMock.ncRestoreVersion.mockClear();

    const denied = await request(appNoMember)
      .post("/api/files/versions/restore")
      .send({ path: "/Reports/q3.pdf", versionId: "v1", space: `dept:${DEPT_A.id}` });
    expect(denied.status).toBe(403);
    expect(ncMock.ncRestoreVersion).not.toHaveBeenCalled();
  });

  it("trash restore/empty: gated `contributor`, personal default unchanged", async () => {
    const res = await request(app).post("/api/files/trash/restore").send({ name: "photo.jpg.d123" });
    expect(res.status).toBe(200);
    expect(ncMock.ncRestoreTrashItem).toHaveBeenCalledWith(expect.any(String), expect.any(String), "photo.jpg.d123");

    const empty = await request(app).delete("/api/files/trash");
    expect(empty.status).toBe(200);
    expect(ncMock.ncEmptyTrash).toHaveBeenCalled();

    // A reader-only member restoring/emptying "as" a dept space is denied —
    // reader can't satisfy the contributor gate even though the underlying
    // NC call itself is user-token-scoped, not path-scoped.
    const denied = await request(appReader)
      .post("/api/files/trash/restore")
      .send({ name: "photo.jpg.d123", space: `dept:${DEPT_A.id}` });
    expect(denied.status).toBe(403);
  });

  it("bulk-delete: single-space threading resolves every path under the same dept", async () => {
    const res = await request(app)
      .post("/api/files/bulk-delete")
      .send({ paths: ["/Reports/a.pdf", "/Reports/b.pdf"], space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(200);
    expect(ncMock.ncDeleteFile).toHaveBeenNthCalledWith(1, expect.any(String), expect.any(String), "/Alpha/Reports/a.pdf");
    expect(ncMock.ncDeleteFile).toHaveBeenNthCalledWith(2, expect.any(String), expect.any(String), "/Alpha/Reports/b.pdf");
  });
});

describe("WARP-1262 (T10) — move/copy cross-space dual-check matrix", () => {
  it("1. contributor on BOTH sides → move allowed", async () => {
    const app = buildApp(prismaFull, CONTRIB_A);
    // CONTRIB_A only holds contributor on dept A, not dept B — grant a
    // second stub where the acting user has contributor on both sides via
    // two membership rows for the same user id.
    const prisma = makePrismaStub({
      departments: [DEPT_A, DEPT_B],
      memberships: [
        { departmentId: DEPT_A.id, userId: CONTRIB_A.id, right: "contributor" },
        { departmentId: DEPT_B.id, userId: CONTRIB_A.id, right: "contributor" },
      ],
    });
    const dualApp = buildApp(prisma, CONTRIB_A);
    const res = await request(dualApp)
      .post("/api/files/move")
      .send({ from: "/a.pdf", to: "/a.pdf", fromSpace: `dept:${DEPT_A.id}`, toSpace: `dept:${DEPT_B.id}` });
    expect(res.status).toBe(200);
    expect(ncMock.ncMoveFile).toHaveBeenCalledWith(expect.any(String), expect.any(String), "/Alpha/a.pdf", "/Beta/a.pdf", false);
  });

  it("2. reader-only source + contributor target → MOVE denied, COPY allowed (the asymmetry)", async () => {
    const prisma = makePrismaStub({
      departments: [DEPT_A, DEPT_B],
      memberships: [
        { departmentId: DEPT_A.id, userId: READER_A.id, right: "reader" },
        { departmentId: DEPT_B.id, userId: READER_A.id, right: "contributor" },
      ],
    });
    const app = buildApp(prisma, READER_A);

    const moveRes = await request(app)
      .post("/api/files/move")
      .send({ from: "/a.pdf", to: "/a.pdf", fromSpace: `dept:${DEPT_A.id}`, toSpace: `dept:${DEPT_B.id}` });
    expect(moveRes.status).toBe(403);
    expect(ncMock.ncMoveFile).not.toHaveBeenCalled();

    const copyRes = await request(app)
      .post("/api/files/copy")
      .send({ from: "/a.pdf", to: "/a.pdf", fromSpace: `dept:${DEPT_A.id}`, toSpace: `dept:${DEPT_B.id}` });
    expect(copyRes.status).toBe(200);
    expect(ncMock.ncCopyFile).toHaveBeenCalledWith(expect.any(String), expect.any(String), "/Alpha/a.pdf", "/Beta/a.pdf", false);
  });

  it("3. contributor source + insufficient target → both MOVE and COPY denied", async () => {
    const prisma = makePrismaStub({
      departments: [DEPT_A, DEPT_B],
      memberships: [
        { departmentId: DEPT_A.id, userId: CONTRIB_A.id, right: "contributor" },
        // No membership row on DEPT_B at all for this user.
      ],
    });
    const app = buildApp(prisma, CONTRIB_A);

    const moveRes = await request(app)
      .post("/api/files/move")
      .send({ from: "/a.pdf", to: "/a.pdf", fromSpace: `dept:${DEPT_A.id}`, toSpace: `dept:${DEPT_B.id}` });
    expect(moveRes.status).toBe(403);
    expect(ncMock.ncMoveFile).not.toHaveBeenCalled();

    const copyRes = await request(app)
      .post("/api/files/copy")
      .send({ from: "/a.pdf", to: "/a.pdf", fromSpace: `dept:${DEPT_A.id}`, toSpace: `dept:${DEPT_B.id}` });
    expect(copyRes.status).toBe(403);
    expect(ncMock.ncCopyFile).not.toHaveBeenCalled();
  });

  it("4. no space params at all → personal→personal, unchanged from pre-T10 (regression)", async () => {
    const app = buildApp(prismaFull, CONTRIB_A);
    const res = await request(app).post("/api/files/move").send({ from: "/a.pdf", to: "/b.pdf" });
    expect(res.status).toBe(200);
    expect(ncMock.ncMoveFile).toHaveBeenCalledWith(expect.any(String), expect.any(String), "/a.pdf", "/b.pdf", false);

    const copyRes = await request(app).post("/api/files/copy").send({ from: "/a.pdf", to: "/b.pdf" });
    expect(copyRes.status).toBe(200);
    expect(ncMock.ncCopyFile).toHaveBeenCalledWith(expect.any(String), expect.any(String), "/a.pdf", "/b.pdf", false);
  });

  it("a malformed fromSpace fails closed with 403 before touching NC", async () => {
    const app = buildApp(prismaFull, CONTRIB_A);
    const res = await request(app)
      .post("/api/files/move")
      .send({ from: "/a.pdf", to: "/b.pdf", fromSpace: "dept:not-a-uuid" });
    expect(res.status).toBe(403);
    expect(ncMock.ncMoveFile).not.toHaveBeenCalled();
  });

  it("the canonical 'shared' alias resolves on BOTH move sides (no false 'malformed' 403)", async () => {
    // Regression for the CR: checkCrossSpaceSide used to call
    // resolveRawSpaceToDepartmentId on the RAW value, so "shared" (the id the
    // rest of the app actually produces for the Household space) fell through
    // to `malformed` and 403'd every legitimate Household move/copy.
    const householdApp = buildApp(
      makePrismaStub({
        household: { id: "44444444-4444-4444-8444-444444444444", name: "Household", parentId: null, kind: "HOUSEHOLD", state: "active" },
      }),
      { id: "u-owner", username: "dev", role: "owner" },
    );
    const moveRes = await request(householdApp)
      .post("/api/files/move")
      .send({ from: "/a.pdf", to: "/b.pdf", fromSpace: "shared", toSpace: "shared" });
    expect(moveRes.status).toBe(200);
    expect(ncMock.ncMoveFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "/Household/a.pdf",
      "/Household/b.pdf",
      false,
    );

    const copyRes = await request(householdApp)
      .post("/api/files/copy")
      .send({ from: "/a.pdf", to: "/b.pdf", fromSpace: "shared", toSpace: "shared" });
    expect(copyRes.status).toBe(200);
    expect(ncMock.ncCopyFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "/Household/a.pdf",
      "/Household/b.pdf",
      false,
    );
  });
});

describe("WARP-1262 (security) — '..' path traversal is rejected on every space-threaded write route", () => {
  // CONTRIB_A holds contributor on DEPT_A, so each request below PASSES the
  // space-authorization gate for its declared `space=dept:A` — proving the 400
  // comes from the traversal guard in rootForSpace (the previously-missing
  // check), not from the access gate. Before the fix, `../Beta/...` would
  // normalize under WebDAV into DEPT_B — a sibling dept CONTRIB_A has zero
  // rights in — and the destructive op would succeed.
  const app = buildApp(prismaFull, CONTRIB_A);
  const TRAVERSAL = "../Beta/secret.pdf";

  it("delete: `..` in ?path (the CR's exact scenario) → 400, NC never called", async () => {
    const res = await request(app)
      .delete("/api/files")
      .query({ path: TRAVERSAL, space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(400);
    expect(ncMock.ncDeleteFile).not.toHaveBeenCalled();
  });

  it("delete: personal `..` is rejected too (fail-closed for every space) → 400", async () => {
    const res = await request(app).delete("/api/files").query({ path: "../../etc/passwd" });
    expect(res.status).toBe(400);
    expect(ncMock.ncDeleteFile).not.toHaveBeenCalled();
  });

  it("rename: `..` in path → 400, NC never called", async () => {
    const res = await request(app)
      .post("/api/files/rename")
      .send({ path: TRAVERSAL, newName: "x.txt", space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(400);
    expect(ncMock.ncMoveFile).not.toHaveBeenCalled();
  });

  it("upload: `..` in ?path → 400, NC never called", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .query({ path: TRAVERSAL, space: `dept:${DEPT_A.id}` })
      .attach("files", Buffer.from("x"), "report.txt");
    expect(res.status).toBe(400);
    expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });

  it("favorite: `..` in path → 400, NC never called", async () => {
    const res = await request(app)
      .post("/api/files/favorite")
      .send({ path: TRAVERSAL, favorite: true, space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(400);
    expect(ncMock.ncSetFavorite).not.toHaveBeenCalled();
  });

  it("version restore: `..` in path → 400 before ncGetFileId", async () => {
    ncMock.ncGetFileId.mockResolvedValue(42);
    const res = await request(app)
      .post("/api/files/versions/restore")
      .send({ path: TRAVERSAL, versionId: "v1", space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(400);
    expect(ncMock.ncGetFileId).not.toHaveBeenCalled();
    expect(ncMock.ncRestoreVersion).not.toHaveBeenCalled();
  });

  it("move: `..` in from (cross-dept escape) → 400, NC never called", async () => {
    const res = await request(app)
      .post("/api/files/move")
      .send({ from: TRAVERSAL, to: "/ok.pdf", fromSpace: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(400);
    expect(ncMock.ncMoveFile).not.toHaveBeenCalled();
  });

  it("copy: `..` in from → 400, NC never called", async () => {
    const res = await request(app)
      .post("/api/files/copy")
      .send({ from: TRAVERSAL, to: "/ok.pdf", fromSpace: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(400);
    expect(ncMock.ncCopyFile).not.toHaveBeenCalled();
  });

  it("bulk-delete: a single `..` path fails the WHOLE batch closed → 400, NC never called", async () => {
    const res = await request(app)
      .post("/api/files/bulk-delete")
      .send({ paths: ["/Reports/ok.pdf", TRAVERSAL], space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(400);
    expect(ncMock.ncDeleteFile).not.toHaveBeenCalled();
  });

  // The listing route (GET /api/files) also threads through rootForSpace and
  // is the dashboard's most-exposed navigation surface (drive tiles + storage
  // cards deep-link `?path=`), but had no dedicated traversal regression test.
  it("list: `..` in ?path (dept space) → 400, NC never called", async () => {
    const res = await request(app)
      .get("/api/files")
      .query({ path: TRAVERSAL, space: `dept:${DEPT_A.id}` });
    expect(res.status).toBe(400);
    expect(ncMock.ncListFiles).not.toHaveBeenCalled();
  });

  it("list: personal `..` is rejected too (fail-closed for every space) → 400", async () => {
    const res = await request(app).get("/api/files").query({ path: "../../etc/passwd" });
    expect(res.status).toBe(400);
    expect(ncMock.ncListFiles).not.toHaveBeenCalled();
  });

  // Pass the query string pre-encoded and raw (not via `.query({...})`, which
  // would re-encode the literal `%` and defeat the point) so it decodes to a
  // `..` segment exactly once, the same way Express's query parser decodes an
  // incoming request — proving the guard catches it post-decode, not just in
  // its raw (undecoded) form.
  it.each([
    "/api/files?path=%2e%2e%2Fescape",
    "/api/files?path=..%2fescape",
  ])("list: encoded traversal (%s) is rejected too → 400", async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(400);
    expect(ncMock.ncListFiles).not.toHaveBeenCalled();
  });
});
